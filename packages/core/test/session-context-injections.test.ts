import { describe, expect, test, vi } from "vitest";
import fc from "fast-check";
import { db, ensureProject } from "../src/db";
import * as ltm from "../src/ltm";
import { sessionContext } from "../src/session-context";
import { recordToolCalls } from "../src/temporal";
import { withTenant } from "../src/tenant";

let seq = 0;
function setup() {
  const project = `/test/session-receipts/${++seq}`;
  const session = `receipt-session-${seq}`;
  vi.spyOn(Date, "now").mockReturnValue(1000);
  const id = ltm.create({
    projectPath: project,
    scope: "project",
    category: "decision",
    title: "Original title",
    content: "Original content",
    confidence: 0.5,
  });
  const logical = ltm.logicalIdOf(id);
  const expose = () =>
    ltm.recordSessionInjections(session, project, [ltm.getByLogical(logical)!]);
  const read = () => sessionContext(project, session)!.knowledge.injections;
  expose();
  return { project, session, id, logical, expose, read };
}

function credit(s: ReturnType<typeof setup>) {
  recordToolCalls({
    projectPath: s.project,
    info: {
      id: "check-message",
      sessionID: s.session,
      role: "assistant",
      time: { created: 1100 },
      parentID: "parent",
      modelID: "model",
      providerID: "provider",
      mode: "build",
      path: { cwd: s.project, root: s.project },
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    },
    parts: [
      {
        id: "check-part",
        sessionID: s.session,
        messageID: "check-message",
        type: "tool",
        callID: "check",
        tool: "bash",
        state: {
          status: "completed",
          input: { command: "pnpm test" },
          output: "passed",
          title: "tests",
          time: { start: 1100, end: 1200 },
        },
      },
    ],
  });
  expect(ltm.creditSessionOutcome(s.session, s.project).credited).toBe(1);
}

describe("session injection version projection", () => {
  test.each([false, true])(
    "keeps captured fields after an edit (credited=%s)",
    (credited) => {
      const s = setup();
      if (credited) credit(s);
      vi.spyOn(Date, "now").mockReturnValue(2000);
      ltm.update(s.id, {
        title: "Replacement title",
        category: "gotcha",
        content: "Replacement content",
        confidence: 0.7,
      });
      expect(s.read()).toEqual([
        {
          logical_id: s.logical,
          version_id: s.id,
          version_status: "superseded",
          title: "Original title",
          category: "decision",
          confidence: 0.7,
          created_at: 1000,
          credited,
          verdict: credited ? "pass" : null,
        },
      ]);

      // An actual new exposure refreshes only a still-uncredited receipt.
      s.expose();
      expect(s.read()[0]).toMatchObject(
        credited
          ? {
              version_id: s.id,
              version_status: "superseded",
              title: "Original title",
              created_at: 1000,
            }
          : {
              version_id: ltm.getByLogical(s.logical)!.id,
              version_status: "current",
              title: "Replacement title",
              category: "gotcha",
              created_at: 2000,
            },
      );
    },
  );

  test("legacy unknown provenance never borrows the latest title/category", () => {
    const s = setup();
    // Simulate an actual pre-v104 receipt with no recoverable version ID.
    db()
      .query(
        "UPDATE knowledge_session_injections SET version_id = NULL WHERE session_id = ?",
      )
      .run(s.session);
    ltm.update(s.id, { title: "New title", category: "pattern" });
    expect(s.read()[0]).toMatchObject({
      version_id: null,
      version_status: "unknown",
      title: null,
      category: null,
      confidence: 0.5,
    });
  });

  test("compacted versions are unavailable without losing their receipt identity", () => {
    const s = setup();
    // Drive the real retention limit: only two superseded versions survive.
    for (let n = 1; n <= 3; n++) ltm.update(s.id, { content: `Revision ${n}` });
    expect(
      db().query("SELECT id FROM knowledge WHERE id = ?").get(s.id),
    ).toBeTruthy();
    expect(ltm.compactKnowledgeVersions()).toBeGreaterThan(0);
    expect(
      db().query("SELECT id FROM knowledge WHERE id = ?").get(s.id),
    ).toBeNull();
    expect(s.read()[0]).toMatchObject({
      version_id: s.id,
      version_status: "unavailable",
      title: null,
      category: null,
      confidence: 0.5,
    });
  });

  test.each(["project", "tenant", "logical"])(
    "never resolves a mismatched %s version",
    (kind) => {
      const s = setup();
      const createForeign = () =>
        ltm.create({
          projectPath: kind === "project" ? `${s.project}/other` : s.project,
          scope: "project",
          category: "gotcha",
          title: "Foreign secret",
          content: "Private",
          confidence: 0.9,
        });
      const foreign =
        kind === "tenant"
          ? withTenant("foreign-tenant", createForeign)
          : createForeign();
      const foreignLogical =
        kind === "logical" ? s.logical : ltm.logicalIdOf(foreign);
      // Corrupt/stale receipt references must not turn into cross-owner reads.
      db()
        .query(
          "UPDATE knowledge_session_injections SET logical_id = ?, version_id = ? WHERE session_id = ?",
        )
        .run(foreignLogical, foreign, s.session);
      const row = s.read()[0];
      expect(row).toMatchObject({
        version_status: "unavailable",
        title: null,
        category: null,
      });
      expect(row.confidence).toBe(kind === "logical" ? 0.5 : null);
      expect(JSON.stringify(s.read())).not.toContain("Foreign secret");
    },
  );

  test("same client path and session ID remain isolated between tenants", () => {
    const s = withTenant("receipt-owner", setup);
    withTenant("receipt-other", () => {
      expect(ensureProject(s.project)).not.toBe(
        withTenant("receipt-owner", () => ensureProject(s.project)),
      );
      expect(sessionContext(s.project, s.session)).toBeNull();
    });
    expect(withTenant("receipt-owner", s.read)[0]).toMatchObject({
      version_id: s.id,
      version_status: "current",
      title: "Original title",
    });
  });

  test("reading receipts cannot change confidence, credit, or outcome evidence", () => {
    const s = setup();
    credit(s);
    ltm.update(s.id, { content: "Replacement" });
    const before = db()
      .query("SELECT * FROM knowledge_session_injections WHERE session_id = ?")
      .all(s.session);
    const confidence = ltm.getByLogical(s.logical)!.confidence;
    const impact = ltm.outcomeImpact(s.logical);
    s.read();
    s.read();
    expect(
      db()
        .query(
          "SELECT * FROM knowledge_session_injections WHERE session_id = ?",
        )
        .all(s.session),
    ).toEqual(before);
    expect(ltm.getByLogical(s.logical)!.confidence).toBe(confidence);
    expect(ltm.outcomeImpact(s.logical)).toEqual(impact);
  });

  test("edit/exposure sequences always display the last eligible captured revision", () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.array(fc.boolean(), { minLength: 1, maxLength: 8 }),
        (credited, exposures) => {
          const s = setup();
          if (credited) credit(s);
          let expectedID = s.id;
          let expectedTitle = "Original title";
          for (const [i, expose] of exposures.entries()) {
            ltm.update(s.id, {
              title: `Revision ${i}`,
              content: `Content ${i}`,
            });
            const current = ltm.getByLogical(s.logical)!;
            if (expose) {
              s.expose();
              if (!credited) {
                expectedID = current.id;
                expectedTitle = current.title;
              }
            }
            expect(s.read()[0]).toMatchObject({
              version_id: expectedID,
              title: expectedTitle,
              version_status:
                expectedID === current.id ? "current" : "superseded",
              credited,
            });
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
