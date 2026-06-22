import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { buildActionTagContext, consolidate } from "../src/curator";
import { db, ensureProject } from "../src/db";
import * as ltm from "../src/ltm";
import { uuidv7 } from "uuidv7";
import type { LLMClient } from "../src/types";

/**
 * The curator appends a "behavioral patterns detected" signal built over ALL
 * project history every run. Without an already-captured filter it re-prompts
 * the curator to re-create preferences it already minted (re-observation loop →
 * near-duplicate mints). These tests pin the exclusion.
 */
describe("curator re-observation suppression — buildActionTagContext", () => {
  const PROJ = "/test/curator/reobs-tags";

  function seedDistillation(sessionID: string, observations: string) {
    const pid = ensureProject(PROJ);
    db()
      .query(
        `INSERT INTO distillations
           (id, project_id, session_id, narrative, facts, observations,
            source_ids, generation, token_count, created_at)
         VALUES (?, ?, ?, '', '', ?, '[]', 0, 10, ?)`,
      )
      .run(uuidv7(), pid, sessionID, observations, Date.now());
  }

  beforeEach(() => {
    const pid = ensureProject(PROJ);
    db().query("DELETE FROM knowledge WHERE project_id = ?").run(pid);
    db().query("DELETE FROM distillations WHERE project_id = ?").run(pid);
    // The [requested-tests] tag appears in two prior sessions → "significant".
    seedDistillation(
      "sess-A",
      "The user [requested-tests] for the new module.",
    );
    seedDistillation("sess-B", "Again the user [requested-tests] here.");
  });

  test("surfaces a significant tag when it is NOT yet captured as a preference", () => {
    const out = buildActionTagContext(PROJ, "sess-current");
    expect(out).toContain("[requested-tests]");
    expect(out).toContain("behavioral patterns detected");
  });

  test("suppresses a tag already captured as a preference (no re-prompt)", () => {
    // tagToTitle("requested-tests") = "Always write tests alongside implementation"
    ltm.create({
      projectPath: PROJ,
      category: "preference",
      title: "Always write tests alongside implementation",
      content: "Write tests with each change.",
      scope: "project",
    });
    const out = buildActionTagContext(PROJ, "sess-current");
    // The tag is already captured → excluded → no signal emitted at all.
    expect(out).toBe("");
  });
});

/**
 * The per-category consolidation path must actually MERGE duplicates. Pre-fix it
 * passed targetMax=length to the trim prompt ("remove at least 0") and merged
 * nothing. This pins that focusCategory uses the merge prompt and applies the
 * LLM's merge/delete ops.
 */
describe("curator consolidate — focusCategory merge", () => {
  const PROJ = "/test/curator/reobs-consolidate";
  let aId = "";
  let bId = "";

  beforeEach(() => {
    const pid = ensureProject(PROJ);
    db().query("DELETE FROM knowledge WHERE project_id = ?").run(pid);
    aId = ltm.create({
      projectPath: PROJ,
      category: "preference",
      title: "Always document invariants in code",
      content: "Document invariants inline.",
      scope: "project",
    });
    bId = ltm.create({
      projectPath: PROJ,
      category: "preference",
      title: "Always write invariants as code comments",
      content: "Put invariants in comments.",
      scope: "project",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("uses the merge prompt and applies the LLM's merge (delete) op", async () => {
    let receivedSystem = "";
    const llm: LLMClient = {
      prompt: async (system: string) => {
        receivedSystem = system;
        // Simulate the model merging B into A.
        return JSON.stringify([
          {
            op: "update",
            id: aId,
            content: "Document invariants inline (merged).",
          },
          { op: "delete", id: bId, reason: `duplicate of ${aId}` },
        ]);
      },
    };

    const result = await consolidate({
      llm,
      projectPath: PROJ,
      sessionID: "sess-consolidate",
      focusCategory: "preference",
    });

    // Merge prompt used (not the trim/eviction prompt).
    expect(receivedSystem).toContain("merge genuine duplicates");
    expect(receivedSystem).not.toContain("target maximum");
    // The delete was applied — B is gone, A survives (as a new appended version).
    expect(result.deleted).toBeGreaterThanOrEqual(1);
    expect(ltm.getByLogical(bId)).toBeNull(); // B has no current, live version
    expect(ltm.getByLogical(aId)).not.toBeNull();
  });

  test("consolidation prompt shows verifier counts keyed by logical_id (incl. a v2 entry)", async () => {
    const pid = ensureProject(PROJ);
    const logicalOf = (id: string) =>
      (
        db().query("SELECT logical_id FROM knowledge WHERE id = ?").get(id) as {
          logical_id: string;
        }
      ).logical_id;
    const aLogical = logicalOf(aId);
    const bLogical = logicalOf(bId);
    // Make B a second version so its CURRENT id != logical_id — this is what
    // catches a wrong `e.id` (vs `e.logical_id`) wiring: injections are keyed by
    // the stable logical_id, so only logical_id resolves B's counts.
    ltm.update(bId, { content: "Put invariants in comments (v2)." });
    expect(ltm.getByLogical(bLogical)?.id).not.toBe(bId); // current id changed

    const recordVerdict = (
      logicalId: string,
      session: string,
      verdict: "pass" | "fail",
    ) =>
      db()
        .query(
          `INSERT INTO knowledge_session_injections (session_id, logical_id, project_id, created_at, credited, verdict)
           VALUES (?, ?, ?, ?, 1, ?)`,
        )
        .run(session, logicalId, pid, Date.now(), verdict);
    recordVerdict(aLogical, "s1", "pass");
    recordVerdict(aLogical, "s2", "pass");
    recordVerdict(bLogical, "s3", "fail");

    let userContent = "";
    const llm: LLMClient = {
      prompt: async (_system: string, user: string) => {
        userContent = user;
        return "[]";
      },
    };
    await consolidate({
      llm,
      projectPath: PROJ,
      sessionID: "sess-consolidate",
      focusCategory: "preference",
    });

    // A (simple entry) and B (v2, id != logical_id) both show their real counts.
    expect(userContent).toContain("verifier pass 2, fail 0");
    expect(userContent).toContain("verifier pass 0, fail 1");
  });

  test("does nothing when fewer than 2 entries in the category", async () => {
    db().query("DELETE FROM knowledge WHERE id = ?").run(bId);
    const llm: LLMClient = { prompt: vi.fn(async () => "[]") };
    const result = await consolidate({
      llm,
      projectPath: PROJ,
      sessionID: "sess-consolidate",
      focusCategory: "preference",
    });
    expect(result).toEqual({ updated: 0, deleted: 0 });
    expect(llm.prompt).not.toHaveBeenCalled();
  });
});
