import { afterEach, describe, expect, it } from "vitest";
import { db, ensureProject } from "../src/db";
import * as temporal from "../src/temporal";
import * as log from "../src/log";
import { withTenant } from "../src/tenant";

const projectPath = "/test/batch-identities";
const sessionID = "batch-session";
const sink = { info() {}, warn() {}, error() {}, captureException() {} };
afterEach(() => {
  log.registerSink(sink);
  db().exec("PRAGMA reverse_unordered_selects = OFF");
});

describe("batched temporal identity resolution", () => {
  it("uses primary-key probes for restored rows instead of scanning all NULL sources per chunk", () => {
    const messages = Array.from({ length: 305 }, (_, i) => ({
      sourceID: `restored-bulk-${i}`,
    }));
    const expected = temporal.storedMessageIds({
      projectPath,
      sessionID,
      messages,
    });
    const pid = ensureProject(projectPath);
    const insert = db().query(`INSERT INTO temporal_messages
      (id, source_id, project_id, session_id, role, content, tokens, distilled, created_at, metadata)
      VALUES (?, NULL, ?, ?, 'user', 'fixture', 1, 0, 1, '{}')`);
    for (const id of expected.values()) insert.run(id, pid, sessionID);
    const plans: string[] = [];
    log.registerSink({
      ...sink,
      withDbSpan(sql, fn) {
        if (sql.startsWith("WITH restored")) {
          const plan = db()
            .query(`EXPLAIN QUERY PLAN ${sql}`)
            .all(
              ...Array.from(
                { length: sql.split("?").length - 1 },
                () => "test",
              ),
            ) as Array<{ detail: string }>;
          plans.push(
            ...plan
              .filter((row) =>
                row.detail.startsWith("SEARCH temporal_messages"),
              )
              .map((row) => row.detail),
          );
        }
        return fn();
      },
    });
    expect(
      temporal.storedMessageIds({ projectPath, sessionID, messages }),
    ).toEqual(expected);
    expect(plans).toHaveLength(4);
    expect(plans.every((detail) => detail.includes("(id=?)"))).toBe(true);
  });

  it("falls back to derivation if concurrent cleanup removes ambiguous candidates", () => {
    const message = {
      sourceID: "cleanup-current",
      legacySourceID: "cleanup-legacy",
    };
    const derived = temporal.storedMessageId({
      projectPath,
      sessionID,
      ...message,
    });
    const pid = ensureProject(projectPath);
    const insert = db().query(`INSERT INTO temporal_messages
      (id, source_id, project_id, session_id, role, content, tokens, distilled, created_at, metadata)
      VALUES (?, ?, ?, ?, 'user', 'fixture', 1, 0, 1, '{}')`);
    insert.run(message.sourceID, message.sourceID, pid, sessionID);
    insert.run(message.legacySourceID, message.legacySourceID, pid, sessionID);
    let cleaned = false;
    log.registerSink({
      ...sink,
      withDbSpan(sql, fn) {
        if (!cleaned && sql.startsWith("SELECT ? AS source_id")) {
          cleaned = true;
          db()
            .query("DELETE FROM temporal_messages WHERE id IN (?, ?)")
            .run(message.sourceID, message.legacySourceID);
        }
        return fn();
      },
    });
    expect(
      temporal
        .storedMessageIds({ projectPath, sessionID, messages: [message] })
        .get(message.sourceID),
    ).toBe(derived);
    expect(cleaned).toBe(true);
  });

  it("matches scalar resolution for legacy, current, restored, missing and ambiguous rows", () => {
    const pid = ensureProject(projectPath);
    const messages = Array.from({ length: 305 }, (_, i) => ({
      sourceID: `source-${i}`,
      legacySourceID: `legacy-${i}`,
    }));
    const insert = db().query(`INSERT INTO temporal_messages
      (id, source_id, project_id, session_id, role, content, tokens, distilled, created_at, metadata)
      VALUES (?, ?, ?, ?, 'user', 'fixture', 1, 0, 1, '{}')`);
    for (const [i, message] of messages.entries()) {
      const derived = temporal.storedMessageId({
        projectPath,
        sessionID,
        ...message,
      });
      if (i % 5 === 0 || i % 5 === 4)
        insert.run(
          message.legacySourceID,
          message.legacySourceID,
          pid,
          sessionID,
        );
      if (i % 5 === 1 || i % 5 === 4)
        insert.run(derived, message.sourceID, pid, sessionID);
      if (i % 5 === 2) insert.run(derived, null, pid, sessionID);
    }
    for (const analyze of [false, true]) {
      if (analyze) db().exec("ANALYZE");
      for (const reverse of [false, true]) {
        db().exec(
          `PRAGMA reverse_unordered_selects = ${reverse ? "ON" : "OFF"}`,
        );
        const expected = new Map(
          messages.map((message) => [
            message.sourceID,
            temporal.storedMessageId({ projectPath, sessionID, ...message }),
          ]),
        );
        expect(
          temporal.storedMessageIds({ projectPath, sessionID, messages }),
        ).toEqual(expected);
      }
    }
  });

  it("bounds SQL work by chunks across 5,580 messages, including all-ambiguous inputs", () => {
    const pid = ensureProject(projectPath);
    const messages = Array.from({ length: 5580 }, (_, i) => ({
      sourceID: `large-${i}`,
      legacySourceID: `old-${i}`,
    }));
    const insert = db().query(`INSERT INTO temporal_messages
      (id, source_id, project_id, session_id, role, content, tokens, distilled, created_at, metadata)
      VALUES (?, ?, ?, ?, 'user', 'fixture', 1, 0, 1, '{}')`);
    db().exec("SAVEPOINT seed_batch");
    for (const message of messages) {
      insert.run(message.sourceID, message.sourceID, pid, sessionID);
      insert.run(
        message.legacySourceID,
        message.legacySourceID,
        pid,
        sessionID,
      );
    }
    db().exec("RELEASE seed_batch");
    let queries = 0;
    log.registerSink({
      ...sink,
      withDbSpan(sql, fn) {
        if (sql.includes("temporal_messages")) queries++;
        return fn();
      },
    });
    const result = temporal.storedMessageIds({
      projectPath,
      sessionID,
      messages,
    });
    expect(result.size).toBe(5580);
    expect(queries).toBeLessThanOrEqual(3 * Math.ceil(5580 / 100));
  });

  it("keeps oversized compatibility identity lists below SQLite bind limits", () => {
    const oversizedProject = `/test/batch-identities/oversized-${crypto.randomUUID()}`;
    const oversizedSession = `oversized-${crypto.randomUUID()}`;
    const sourceID = `oversized-source-${crypto.randomUUID()}`;
    // Modern SQLite builds allow 32,766 variables per statement. Keep this
    // above that ceiling so the regression fails against the old unbounded
    // scalar/ambiguous lookup rather than merely exercising a large input.
    const legacySourceIDs = Array.from(
      { length: 33_000 },
      (_, i) => `historical-${i}`,
    );
    const lateMatch = legacySourceIDs[legacySourceIDs.length - 1];
    if (lateMatch === undefined) throw new Error("expected a late match");
    const earlyMatch = legacySourceIDs[0];
    if (earlyMatch === undefined) throw new Error("expected an early match");
    const pid = ensureProject(oversizedProject);
    const insert = db().query(`INSERT INTO temporal_messages
        (id, source_id, project_id, session_id, role, content, tokens, distilled, created_at, metadata)
        VALUES (?, ?, ?, ?, 'user', 'fixture', 1, 0, 1, '{}')`);
    insert.run(earlyMatch, earlyMatch, pid, oversizedSession);
    insert.run(lateMatch, lateMatch, pid, oversizedSession);

    const message = { sourceID, legacySourceIDs };
    expect(
      temporal.storedMessageId({
        projectPath: oversizedProject,
        sessionID: oversizedSession,
        ...message,
      }),
    ).toBe(earlyMatch);
    expect(
      temporal
        .storedMessageIds({
          projectPath: oversizedProject,
          sessionID: oversizedSession,
          messages: [message],
        })
        .get(sourceID),
    ).toBe(earlyMatch);

    // The batch path must also keep its ambiguous-row scalar fallback bounded.
    // The current row makes the input ambiguous with the historical rows; the
    // fallback must still agree with the scalar lookup's normal precedence.
    const ambiguousSourceID = `ambiguous-source-${crypto.randomUUID()}`;
    db()
      .query(`INSERT INTO temporal_messages
        (id, source_id, project_id, session_id, role, content, tokens, distilled, created_at, metadata)
        VALUES (?, ?, ?, ?, 'user', 'fixture', 1, 0, 1, '{}')`)
      .run(ambiguousSourceID, ambiguousSourceID, pid, oversizedSession);
    const scalarAmbiguousID = temporal.storedMessageId({
      projectPath: oversizedProject,
      sessionID: oversizedSession,
      sourceID: ambiguousSourceID,
      legacySourceIDs,
    });
    expect(
      temporal
        .storedMessageIds({
          projectPath: oversizedProject,
          sessionID: oversizedSession,
          messages: [{ sourceID: ambiguousSourceID, legacySourceIDs }],
        })
        .get(ambiguousSourceID),
    ).toBe(scalarAmbiguousID);

    // A chunk can contain many ordinary ambiguous rows. Their combined UNION
    // fallback must be split by total binds, not only by message count.
    const combinedFallbackMessages = Array.from({ length: 100 }, (_, i) => ({
      sourceID: `combined-current-${i}`,
      legacySourceID: `combined-legacy-${i}`,
      legacySourceIDs: [
        `combined-extra-${i}-a`,
        `combined-extra-${i}-b`,
        `combined-extra-${i}-c`,
      ],
    }));
    for (const fallbackMessage of combinedFallbackMessages) {
      insert.run(
        fallbackMessage.sourceID,
        fallbackMessage.sourceID,
        pid,
        oversizedSession,
      );
      insert.run(
        fallbackMessage.legacySourceID,
        fallbackMessage.legacySourceID,
        pid,
        oversizedSession,
      );
    }
    let fallbackQueries = 0;
    log.registerSink({
      ...sink,
      withDbSpan(sql, fn) {
        if (sql.startsWith("SELECT ? AS source_id")) fallbackQueries++;
        return fn();
      },
    });
    const fallbackResult = temporal.storedMessageIds({
      projectPath: oversizedProject,
      sessionID: oversizedSession,
      messages: combinedFallbackMessages,
    });
    expect(fallbackResult.size).toBe(combinedFallbackMessages.length);
    expect(fallbackQueries).toBe(2);
  });

  it("isolates tenant/project/session owners and never claims a current row through its legacy source", () => {
    const pid = ensureProject(projectPath);
    db()
      .query(`INSERT INTO temporal_messages
      (id, source_id, project_id, session_id, role, content, tokens, distilled, created_at, metadata)
      VALUES ('foreign-row', 'legacy-looking', ?, ?, 'user', 'fixture', 1, 0, 1, '{}')`)
      .run(pid, sessionID);
    const messages = [
      { sourceID: "new-source", legacySourceID: "legacy-looking" },
      { sourceID: "legacy-looking" },
    ];
    for (const tenant of ["", "a".repeat(64)])
      for (const path of [projectPath, projectPath + "/other"])
        for (const session of [sessionID, "other"]) {
          withTenant(tenant, () => {
            const expected = new Map(
              messages.map((message) => [
                message.sourceID,
                temporal.storedMessageId({
                  projectPath: path,
                  sessionID: session,
                  ...message,
                }),
              ]),
            );
            expect(
              temporal.storedMessageIds({
                projectPath: path,
                sessionID: session,
                messages,
              }),
            ).toEqual(expected);
          });
        }
  });

  it("does no writes or project creation in read-only mode, including missing projects and empty inputs", () => {
    const path = "/test/batch-no-project";
    const before = db().query("SELECT total_changes() AS count").get();
    expect(
      temporal.storedMessageIds({
        projectPath: path,
        sessionID,
        messages: [{ sourceID: "missing" }],
        readOnly: true,
      }).size,
    ).toBe(0);
    expect(
      temporal.storedMessageIds({ projectPath: path, sessionID, messages: [] })
        .size,
    ).toBe(0);
    expect(db().query("SELECT total_changes() AS count").get()).toEqual(before);
  });
});
