/**
 * End-to-end regression tests for restart-proof session adoption (issue #796).
 *
 * Scenario: a long conversation is distilled, then lore+opencode RESTART, and
 * the client resumes the conversation under a FRESH `x-lore-session-id`. Before
 * the fix, the in-memory session index is empty after a restart and the
 * persisted fingerprint is not value-searchable, so the resumed conversation
 * was treated as brand-new — orphaning the prior session's distillations,
 * gradient calibration, and LTM pin.
 *
 * Tier 3b recovers the prior session from its persisted fingerprint, CONFIRMS
 * it by content-hash overlap of the leading user messages (scoped to the
 * project), and ADOPTS its id — so the resumed conversation inherits the prior
 * state instead of cold-starting.
 *
 * These tests drive the full pipeline (handleRequest -> identifySession) through
 * the real HTTP server, simulate a restart via `harness.restartPipeline()`
 * (clears in-memory maps, keeps the DB), and assert on session_state rows.
 */
import { describe, it, expect, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { Harness } from "./helpers/harness";
import { createHarness } from "./helpers/harness";
import { fingerprintMessages } from "../src/session";
import { deterministicID } from "../src/temporal-adapter";
import {
  makeFixtureEntry,
  STANDARD_TOOLS,
  DEFAULT_MODEL,
  DEFAULT_SYSTEM,
} from "./helpers/fixtures";
import { setUpstreamInterceptor } from "../src/pipeline";
import { getLastSeenAuth, resolveAuth } from "../src/auth";
import { enableHostedMode, _resetHostedModeForTest } from "@loreai/core";

const U0 = "alpha first task: please implement the parser module";
const U1 = "second follow-up: now add tests for the parser";
const U2 = "third instruction after the restart: refactor the helper";

function body(messages: Array<{ role: string; content: string }>) {
  return {
    model: DEFAULT_MODEL,
    max_tokens: 1024,
    stream: false,
    system: DEFAULT_SYSTEM,
    messages,
    tools: STANDARD_TOOLS,
  };
}

// Replay is order-based and ignores request content, so plain text fixtures
// suffice; assistant text does not affect user-message content-hash IDs.
function fixtures() {
  return [
    makeFixtureEntry({ seq: 0, requestMessages: [], responseText: "A0 done." }),
    makeFixtureEntry({ seq: 1, requestMessages: [], responseText: "A1 done." }),
    makeFixtureEntry({ seq: 2, requestMessages: [], responseText: "A2 done." }),
  ];
}

type Row = {
  session_id: string;
  header_session_id: string | null;
  message_count: number;
  project_path: string | null;
};

function loreSessionRows(h: Harness): Row[] {
  return h.queryDB<Row>(
    "SELECT session_id, header_session_id, message_count, project_path FROM session_state WHERE header_name = 'x-lore-session-id'",
  );
}

async function makeSessionLegacy(
  h: Harness,
  sessionId: string,
  firstUserContent = U0,
): Promise<void> {
  const fingerprint = await fingerprintMessages([
    { role: "user", content: firstUserContent },
  ]);
  const db = new DatabaseSync(h.dbPath);
  try {
    db.prepare(
      `UPDATE session_state
          SET fingerprint = ?, credential_fingerprint = ''
        WHERE session_id = ?`,
    ).run(fingerprint, sessionId);
  } finally {
    db.close();
  }
}

describe("issue #796: restart-proof session adoption (Tier 3b)", () => {
  let harness: Harness;

  afterEach(async () => {
    if (harness) await harness.teardown();
    _resetHostedModeForTest();
  });

  it("adopts the prior session when a resumed conversation arrives under a new x-lore-session-id after restart", async () => {
    harness = await createHarness({ fixtures: fixtures() });

    // Turn 1 (new session under V1) — persists fingerprint + stores u0.
    let r = await harness.chat(body([{ role: "user", content: U0 }]), "key-A", {
      "x-lore-session-id": "V1",
    });
    expect(r.status).toBe(200);
    await r.text();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    // Turn 2 (same session V1 continues) — stores u1, updates message_count.
    r = await harness.chat(
      body([
        { role: "user", content: U0 },
        { role: "assistant", content: "A0 done." },
        { role: "user", content: U1 },
      ]),
      "key-A",
      { "x-lore-session-id": "V1" },
    );
    expect(r.status).toBe(200);
    await r.text();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    // Exactly one conversation session so far, bound to V1.
    let rows = loreSessionRows(harness);
    expect(rows.length).toBe(1);
    expect(rows[0].header_session_id).toBe("V1");
    const s1 = rows[0].session_id;

    // --- Simulate restart: in-memory maps cleared, DB preserved. ---
    await harness.restartPipeline();

    // Resume the SAME conversation under a NEW x-lore-session-id (V2).
    r = await harness.chat(
      body([
        { role: "user", content: U0 },
        { role: "assistant", content: "A0 done." },
        { role: "user", content: U1 },
        { role: "assistant", content: "A1 done." },
        { role: "user", content: U2 },
      ]),
      "key-A",
      { "x-lore-session-id": "V2" },
    );
    expect(r.status).toBe(200);
    await r.text();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    // Adopted: still ONE conversation session (no new row), same internal id,
    // now rebound to the new header value for the Tier-1 fast path.
    rows = loreSessionRows(harness);
    expect(rows.length).toBe(1);
    expect(rows[0].session_id).toBe(s1);
    expect(rows[0].header_session_id).toBe("V2");
  });

  it("does not persist fingerprint adoption after a failed resumed turn", async () => {
    harness = await createHarness({ fixtures: fixtures() });
    let r = await harness.chat(body([{ role: "user", content: U0 }]), "key-A", {
      "x-lore-session-id": "V1",
    });
    await r.text();
    r = await harness.chat(
      body([
        { role: "user", content: U0 },
        { role: "assistant", content: "A0 done." },
        { role: "user", content: U1 },
      ]),
      "key-A",
      { "x-lore-session-id": "V1" },
    );
    await r.text();
    const original = loreSessionRows(harness)[0];
    await harness.restartPipeline();
    const globalAuthBefore = getLastSeenAuth("anthropic")?.value;

    setUpstreamInterceptor(async () =>
      Promise.resolve(
        new Response("provider failed", {
          status: 500,
          headers: { "content-type": "text/plain" },
        }),
      ),
    );
    r = await harness.chat(
      body([
        { role: "user", content: U0 },
        { role: "assistant", content: "A0 done." },
        { role: "user", content: U1 },
        { role: "assistant", content: "A1 done." },
        { role: "user", content: U2 },
      ]),
      "key-A",
      { "x-lore-session-id": "V2" },
    );
    expect(r.status).toBe(500);
    await r.text();

    const rows = loreSessionRows(harness);
    expect(rows).toEqual([original]);
    expect(resolveAuth(original.session_id)?.value).toBe("key-A");
    expect(getLastSeenAuth("anthropic")?.value).toBe(globalAuthBefore);
  });

  it("persists the resumed turn when fingerprint adoption has no session header", async () => {
    harness = await createHarness({ fixtures: fixtures() });
    let r = await harness.chat(body([{ role: "user", content: U0 }]), "key-A", {
      "x-lore-session-id": "V1",
    });
    await r.text();
    r = await harness.chat(
      body([
        { role: "user", content: U0 },
        { role: "assistant", content: "A0 done." },
        { role: "user", content: U1 },
      ]),
      "key-A",
      { "x-lore-session-id": "V1" },
    );
    await r.text();
    const original = loreSessionRows(harness)[0];
    await harness.restartPipeline();

    r = await harness.chat(
      body([
        { role: "user", content: U0 },
        { role: "assistant", content: "A0 done." },
        { role: "user", content: U1 },
        { role: "assistant", content: "A1 done." },
        { role: "user", content: U2 },
      ]),
      "key-A",
      {},
    );
    expect(r.status).toBe(200);
    await r.text();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const rows = loreSessionRows(harness);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      session_id: original.session_id,
      header_session_id: "V1",
      message_count: 5,
    });
    expect(
      harness.queryDB<{ count: number }>(
        "SELECT COUNT(*) AS count FROM temporal_messages WHERE session_id = ? AND content LIKE ?",
        [original.session_id, `%${U2}%`],
      )[0]?.count,
    ).toBeGreaterThan(0);
  });

  it("adopts a resumed conversation from a new clone path matched by git remote", async () => {
    enableHostedMode();
    const originalPath = "/client/checkouts/adoption-original";
    const clonePath = "/client/checkouts/adoption-clone";
    const remote = `github.com/test/adoption-${crypto.randomUUID()}`;
    harness = await createHarness({ fixtures: fixtures() });

    let r = await harness.chat(body([{ role: "user", content: U0 }]), "key-A", {
      "x-lore-session-id": "clone-V1",
      "x-lore-project": originalPath,
      "x-lore-git-remote": remote,
    });
    expect(r.status).toBe(200);
    await r.text();
    r = await harness.chat(
      body([
        { role: "user", content: U0 },
        { role: "assistant", content: "A0 done." },
        { role: "user", content: U1 },
      ]),
      "key-A",
      {
        "x-lore-session-id": "clone-V1",
        "x-lore-project": originalPath,
        "x-lore-git-remote": remote,
      },
    );
    expect(r.status).toBe(200);
    await r.text();
    const original = loreSessionRows(harness)[0];
    await harness.restartPipeline();

    // This path has never been registered as an alias. The persisted project's
    // normalized remote is the only signal that scopes overlap to the original
    // project rather than minting a second session for the clone.
    r = await harness.chat(
      body([
        { role: "user", content: U0 },
        { role: "assistant", content: "A0 done." },
        { role: "user", content: U1 },
        { role: "assistant", content: "A1 done." },
        { role: "user", content: U2 },
      ]),
      "key-A",
      {
        "x-lore-session-id": "clone-V2",
        "x-lore-project": clonePath,
        "x-lore-git-remote": remote,
      },
    );
    expect(r.status).toBe(200);
    await r.text();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const rows = loreSessionRows(harness);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      session_id: original.session_id,
      header_session_id: "clone-V2",
      project_path: clonePath,
    });
  });

  it("does not trust a spoofed clone remote on a local gateway", async () => {
    const originalPath = "/tmp/adoption-local-original";
    const unrelatedPath = "/tmp/adoption-local-unrelated";
    const spoofedRemote = `github.com/test/adoption-spoof-${crypto.randomUUID()}`;
    harness = await createHarness({ fixtures: fixtures() });

    let r = await harness.chat(body([{ role: "user", content: U0 }]), "key-A", {
      "x-lore-session-id": "spoof-V1",
      "x-lore-project": originalPath,
    });
    await r.text();
    r = await harness.chat(
      body([
        { role: "user", content: U0 },
        { role: "assistant", content: "A0 done." },
        { role: "user", content: U1 },
      ]),
      "key-A",
      {
        "x-lore-session-id": "spoof-V1",
        "x-lore-project": originalPath,
      },
    );
    await r.text();
    const original = loreSessionRows(harness)[0];
    const database = new DatabaseSync(harness.dbPath);
    try {
      database
        .prepare("UPDATE projects SET git_remote = ? WHERE path = ?")
        .run(spoofedRemote, originalPath);
    } finally {
      database.close();
    }
    await harness.restartPipeline();

    // unrelatedPath is not a git repository on this local gateway. A forged
    // header must not select originalPath's project and authorize adoption.
    r = await harness.chat(
      body([
        { role: "user", content: U0 },
        { role: "assistant", content: "A0 done." },
        { role: "user", content: U1 },
        { role: "assistant", content: "A1 done." },
        { role: "user", content: U2 },
      ]),
      "key-A",
      {
        "x-lore-session-id": "spoof-V2",
        "x-lore-project": unrelatedPath,
        "x-lore-git-remote": spoofedRemote,
      },
    );
    expect(r.status).toBe(200);
    await r.text();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const rows = loreSessionRows(harness);
    expect(rows).toHaveLength(2);
    expect(
      rows.find((row) => row.session_id === original.session_id),
    ).toMatchObject({
      header_session_id: "spoof-V1",
      project_path: originalPath,
    });
    expect(
      rows.find((row) => row.header_session_id === "spoof-V2"),
    ).toMatchObject({
      project_path: unrelatedPath,
    });
  });

  it("does NOT adopt when the resumed conversation has a different fingerprint (different first message)", async () => {
    harness = await createHarness({ fixtures: fixtures() });

    let r = await harness.chat(body([{ role: "user", content: U0 }]), "key-A", {
      "x-lore-session-id": "V1",
    });
    expect(r.status).toBe(200);
    await r.text();
    r = await harness.chat(
      body([
        { role: "user", content: U0 },
        { role: "assistant", content: "A0 done." },
        { role: "user", content: U1 },
      ]),
      "key-A",
      { "x-lore-session-id": "V1" },
    );
    expect(r.status).toBe(200);
    await r.text();

    await harness.restartPipeline();

    // A genuinely different conversation (different first user message) under a
    // new header → fingerprint miss → must create a NEW session, not adopt.
    r = await harness.chat(
      body([{ role: "user", content: "completely unrelated opening task" }]),
      "key-A",
      { "x-lore-session-id": "V2" },
    );
    expect(r.status).toBe(200);
    await r.text();

    const rows = loreSessionRows(harness);
    expect(rows.length).toBe(2);
  });

  it("does NOT adopt across projects (overlap is project-scoped)", async () => {
    harness = await createHarness({ fixtures: fixtures() });

    let r = await harness.chat(body([{ role: "user", content: U0 }]), "key-A", {
      "x-lore-session-id": "V1",
    });
    expect(r.status).toBe(200);
    await r.text();
    r = await harness.chat(
      body([
        { role: "user", content: U0 },
        { role: "assistant", content: "A0 done." },
        { role: "user", content: U1 },
      ]),
      "key-A",
      { "x-lore-session-id": "V1" },
    );
    expect(r.status).toBe(200);
    await r.text();

    await harness.restartPipeline();

    // Same fingerprint (same first message + key) but a DIFFERENT project: the
    // content-overlap query is project-scoped, so it finds zero overlap and must
    // not adopt.
    r = await harness.chat(
      body([
        { role: "user", content: U0 },
        { role: "assistant", content: "A0 done." },
        { role: "user", content: U1 },
        { role: "assistant", content: "A1 done." },
        { role: "user", content: U2 },
      ]),
      "key-A",
      {
        "x-lore-session-id": "V2",
        "x-lore-project": "/tmp/lore-other-project",
      },
    );
    expect(r.status).toBe(200);
    await r.text();

    const rows = loreSessionRows(harness);
    expect(rows.length).toBe(2);
  });

  it("adopts a pre-credential session only after same-project transcript overlap", async () => {
    harness = await createHarness({ fixtures: fixtures() });
    const legacyHeader = "legacy-exact-header";

    let r = await harness.chat(body([{ role: "user", content: U0 }]), "key-A", {
      "x-lore-session-id": legacyHeader,
    });
    expect(r.status).toBe(200);
    await r.text();
    r = await harness.chat(
      body([
        { role: "user", content: U0 },
        { role: "assistant", content: "A0 done." },
        { role: "user", content: U1 },
      ]),
      "key-A",
      { "x-lore-session-id": legacyHeader },
    );
    expect(r.status).toBe(200);
    await r.text();

    const before = loreSessionRows(harness);
    expect(before).toHaveLength(1);
    await makeSessionLegacy(harness, before[0].session_id);
    await harness.restartPipeline();

    const migratedHeader = "legacy-after-credential-scope";
    r = await harness.chat(
      body([
        { role: "user", content: U0 },
        { role: "assistant", content: "A0 done." },
        { role: "user", content: U1 },
        { role: "assistant", content: "A1 done." },
        { role: "user", content: U2 },
      ]),
      "key-A",
      { "x-lore-session-id": migratedHeader },
    );
    expect(r.status).toBe(200);
    await r.text();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const after = harness.queryDB<Row & { credential_fingerprint: string }>(
      `SELECT session_id, header_session_id, credential_fingerprint
         FROM session_state
        WHERE header_name = 'x-lore-session-id'`,
    );
    expect(after).toHaveLength(1);
    expect(after[0].session_id).toBe(before[0].session_id);
    expect(after[0].header_session_id).toBe(migratedHeader);
    expect(after[0].credential_fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it("does NOT let another transcript claim an exact legacy header", async () => {
    harness = await createHarness({ fixtures: fixtures() });
    const legacyHeader = "legacy-copied-header";

    let r = await harness.chat(body([{ role: "user", content: U0 }]), "key-A", {
      "x-lore-session-id": legacyHeader,
    });
    expect(r.status).toBe(200);
    await r.text();
    r = await harness.chat(
      body([
        { role: "user", content: U0 },
        { role: "assistant", content: "A0 done." },
        { role: "user", content: U1 },
      ]),
      "key-A",
      { "x-lore-session-id": legacyHeader },
    );
    expect(r.status).toBe(200);
    await r.text();
    const before = loreSessionRows(harness);
    await makeSessionLegacy(harness, before[0].session_id);
    await harness.restartPipeline();

    r = await harness.chat(
      body([
        { role: "user", content: "attacker opening" },
        { role: "assistant", content: "unrelated" },
        { role: "user", content: "attacker follow-up" },
      ]),
      "key-B",
      { "x-lore-session-id": legacyHeader },
    );
    expect(r.status).toBe(200);
    await r.text();

    const after = loreSessionRows(harness);
    expect(after).toHaveLength(2);
    expect(new Set(after.map((row) => row.session_id)).size).toBe(2);
  });

  it("does NOT adopt a pre-credential session when only its fingerprint-implied first message overlaps", async () => {
    harness = await createHarness({ fixtures: fixtures() });
    const legacyHeader = "legacy-one-message";

    let r = await harness.chat(body([{ role: "user", content: U0 }]), "key-A", {
      "x-lore-session-id": legacyHeader,
    });
    expect(r.status).toBe(200);
    await r.text();
    r = await harness.chat(
      body([
        { role: "user", content: U0 },
        { role: "assistant", content: "A0 done." },
        { role: "user", content: U1 },
      ]),
      "key-A",
      { "x-lore-session-id": legacyHeader },
    );
    expect(r.status).toBe(200);
    await r.text();
    const before = loreSessionRows(harness);
    await makeSessionLegacy(harness, before[0].session_id);
    await harness.restartPipeline();

    r = await harness.chat(
      body([
        { role: "user", content: U0 },
        { role: "assistant", content: "unrelated response" },
        { role: "user", content: "different second user message" },
      ]),
      "key-B",
      { "x-lore-session-id": legacyHeader },
    );
    expect(r.status).toBe(200);
    await r.text();

    const after = loreSessionRows(harness);
    expect(after).toHaveLength(2);
    expect(new Set(after.map((row) => row.session_id)).size).toBe(2);
  });

  it("does NOT adopt either of two equally supported legacy candidates", async () => {
    const users = [U0, U1, U2, "fourth instruction for ambiguity proof"];
    harness = await createHarness({
      fixtures: Array.from({ length: 5 }, (_, seq) =>
        makeFixtureEntry({
          seq,
          requestMessages: [],
          responseText: `A${seq} done.`,
        }),
      ),
    });

    const messages: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < users.length; i++) {
      messages.push({ role: "user", content: users[i] });
      if (i < users.length - 1) {
        messages.push({ role: "assistant", content: `A${i} done.` });
      }
      const r = await harness.chat(body(messages), "key-A", {
        "x-lore-session-id": "legacy-ambiguous-a",
      });
      expect(r.status).toBe(200);
      await r.text();
    }

    const [first] = loreSessionRows(harness);
    expect(first).toBeDefined();
    await makeSessionLegacy(harness, first.session_id);
    const secondSession = `legacy-ambiguous-${crypto.randomUUID()}`;
    const fingerprint = await fingerprintMessages([
      { role: "user", content: U0 },
    ]);
    const db = new DatabaseSync(harness.dbPath);
    try {
      const state = db
        .prepare(
          `SELECT message_count, project_path, project_path_provisional, is_subagent
             FROM session_state
            WHERE session_id = ?`,
        )
        .get(first.session_id) as {
        message_count: number;
        project_path: string;
        project_path_provisional: number;
        is_subagent: number;
      };
      db.prepare(
        `INSERT INTO session_state
           (session_id, force_min_layer, updated_at, message_count, fingerprint,
            credential_fingerprint, project_path, project_path_provisional, is_subagent)
         VALUES (?, 0, ?, ?, ?, '', ?, ?, ?)`,
      ).run(
        secondSession,
        Date.now(),
        state.message_count,
        fingerprint,
        state.project_path,
        state.project_path_provisional,
        state.is_subagent,
      );
      for (const index of [2, 6]) {
        const id = deterministicID("user", index, [
          { type: "text", text: users[index / 2] },
        ]);
        db.prepare(
          "UPDATE temporal_messages SET session_id = ? WHERE id = ?",
        ).run(secondSession, id);
      }
    } finally {
      db.close();
    }
    await harness.restartPipeline();

    const resumed: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < users.length; i++) {
      resumed.push({ role: "user", content: users[i] });
      if (i < users.length - 1) {
        resumed.push({ role: "assistant", content: `A${i} done.` });
      }
    }
    const r = await harness.chat(body(resumed), "key-B", {
      "x-lore-session-id": "legacy-ambiguous-new",
    });
    expect(r.status).toBe(200);
    await r.text();

    const rows = harness.queryDB<{
      session_id: string;
      header_session_id: string | null;
    }>(
      `SELECT session_id, header_session_id
         FROM session_state
        WHERE session_id IN (?, ?)
           OR header_session_id = 'legacy-ambiguous-new'`,
      [first.session_id, secondSession],
    );
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.session_id)).toContain(first.session_id);
    expect(rows.map((row) => row.session_id)).toContain(secondSession);
    expect(rows.map((row) => row.header_session_id)).toContain(
      "legacy-ambiguous-new",
    );
  });

  it("does NOT adopt a pre-credential session across projects", async () => {
    harness = await createHarness({
      fixtures: fixtures(),
      projectPath: "/tmp/lore-legacy-project-a",
    });

    let r = await harness.chat(body([{ role: "user", content: U0 }]), "key-A", {
      "x-lore-session-id": "legacy-project-a",
    });
    expect(r.status).toBe(200);
    await r.text();
    r = await harness.chat(
      body([
        { role: "user", content: U0 },
        { role: "assistant", content: "A0 done." },
        { role: "user", content: U1 },
      ]),
      "key-A",
      { "x-lore-session-id": "legacy-project-a" },
    );
    expect(r.status).toBe(200);
    await r.text();
    const before = loreSessionRows(harness);
    await makeSessionLegacy(harness, before[0].session_id);
    await harness.restartPipeline();

    r = await harness.chat(
      body([
        { role: "user", content: U0 },
        { role: "assistant", content: "A0 done." },
        { role: "user", content: U1 },
        { role: "assistant", content: "A1 done." },
        { role: "user", content: U2 },
      ]),
      "key-B",
      {
        "x-lore-session-id": "legacy-project-a",
        "x-lore-project": "/tmp/lore-legacy-project-b",
      },
    );
    expect(r.status).toBe(200);
    await r.text();

    const after = loreSessionRows(harness);
    expect(after).toHaveLength(2);
    expect(new Set(after.map((row) => row.session_id)).size).toBe(2);
  });
});
