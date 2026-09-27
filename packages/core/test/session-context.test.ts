/**
 * Tests for `sessionContext()` (#1924): the read-only session "real context
 * window" assembly behind `GET /api/v1/sessions/:id/context`.
 */
import { describe, expect, test } from "vitest";
import { uuidv7 } from "uuidv7";
import {
  appendSessionPromptDelta,
  db,
  ensureProject,
  saveSessionTracking,
} from "../src/db";
import * as ltm from "../src/ltm";
import * as temporal from "../src/temporal";
import { knowledgeTitlesFor, sessionContext } from "../src/session-context";
import type { LoreAssistantMessage, LoreMessage, LorePart } from "../src/types";

let seq = 0;
function freshProject(tag: string): string {
  return `/test/session-context/${tag}/${++seq}`;
}

function userMsg(sessionID: string, id: string, created: number): LoreMessage {
  return {
    id,
    sessionID,
    role: "user",
    time: { created },
    agent: "build",
    model: { providerID: "anthropic", modelID: "m" },
  };
}

function assistantMsg(
  sessionID: string,
  id: string,
  created: number,
  gradient?: LoreAssistantMessage["gradient"],
): LoreMessage {
  return {
    id,
    sessionID,
    role: "assistant",
    time: { created },
    parentID: `parent-${id}`,
    modelID: "m",
    providerID: "anthropic",
    mode: "build",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: {
      input: 11,
      output: 7,
      reasoning: 0,
      cache: { read: 3, write: 2 },
    },
    ...(gradient ? { gradient } : {}),
  };
}

function parts(sessionID: string, messageID: string): LorePart[] {
  return [
    {
      id: `part-${messageID}`,
      sessionID,
      messageID,
      type: "text",
      text: `text ${messageID}`,
      time: { start: 0, end: 0 },
    },
  ];
}

function storeMessage(projectPath: string, info: LoreMessage, created: number) {
  temporal.store({
    projectPath,
    info,
    parts: parts(info.sessionID, info.id),
  });
  // temporal.store rewrites created_at in some paths; pin it for ordering.
  db()
    .query(
      "UPDATE temporal_messages SET created_at = ? WHERE session_id = ? AND source_id = ?",
    )
    .run(created, info.sessionID, info.id);
}

function insertDistillation(
  projectID: string,
  sessionID: string,
  id: string,
  generation: number,
  tokenCount: number,
  createdAt: number,
  archived = 0,
) {
  db()
    .query(
      `INSERT INTO distillations
         (id, project_id, session_id, narrative, facts, observations,
          source_ids, generation, token_count, archived, created_at)
       VALUES (?, ?, ?, '', '', ?, '', ?, ?, ?, ?)`,
    )
    .run(
      id,
      projectID,
      sessionID,
      `obs-${id}`,
      generation,
      tokenCount,
      archived,
      createdAt,
    );
}

function insertInjection(
  sessionID: string,
  logicalID: string,
  projectID: string,
  createdAt: number,
  credited = 0,
  verdict: string | null = null,
) {
  db()
    .query(
      `INSERT INTO knowledge_session_injections
         (session_id, logical_id, project_id, created_at, credited, verdict)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(sessionID, logicalID, projectID, createdAt, credited, verdict);
}

function forceMetadata(sessionID: string, sourceID: string, metadata: string) {
  db()
    .query(
      "UPDATE temporal_messages SET metadata = ? WHERE session_id = ? AND source_id = ?",
    )
    .run(metadata, sessionID, sourceID);
}

function tokenSum(projectPath: string, sessionID: string): number {
  const pid = ensureProject(projectPath);
  return (
    db()
      .query(
        "SELECT COALESCE(SUM(tokens),0) AS t FROM temporal_messages WHERE project_id = ? AND session_id = ?",
      )
      .get(pid, sessionID) as { t: number }
  ).t;
}

describe("sessionContext", () => {
  test("returns the full shape for a seeded session, ordered and scoped", () => {
    const project = freshProject("full");
    const pid = ensureProject(project);
    const sid = "s-ctx";

    // Messages: user, assistant with gradient, assistant without, assistant
    // with malformed metadata — plus a same-id session in ANOTHER project and
    // another session in THIS project that must never leak in.
    storeMessage(project, userMsg(sid, "m1", 1000), 1000);
    storeMessage(
      project,
      assistantMsg(sid, "a1", 2000, {
        layer: 1,
        rawTokens: 100,
        totalTokens: 150,
        distilledTokens: 50,
      }),
      2000,
    );
    storeMessage(project, assistantMsg(sid, "a2", 3000), 3000);
    storeMessage(project, assistantMsg(sid, "a3", 4000), 4000);
    forceMetadata(sid, "a3", "{not json");
    storeMessage(project, userMsg("s-other", "o1", 1500), 1500);

    const other = freshProject("full-other");
    const otherPid = ensureProject(other);
    storeMessage(other, userMsg(sid, "x1", 1200), 1200);
    insertDistillation(otherPid, sid, "d-foreign", 0, 999, 100);
    insertInjection(sid, "foreign-logical", otherPid, 100);
    appendSessionPromptDelta({
      sessionID: sid,
      projectID: otherPid,
      selector: JSON.stringify({ target: "messages", insertAt: 0 }),
      content: "[]",
    });

    insertDistillation(pid, sid, "d1", 0, 40, 500);
    insertDistillation(pid, sid, "d2", 1, 25, 600);
    insertDistillation(pid, sid, "d-arch", 0, 777, 700, 1);

    const kept = ltm.create({
      id: uuidv7(),
      projectPath: project,
      scope: "project",
      category: "decision",
      title: "Kept entry",
      content: "content",
    });
    const keptLogical = ltm.logicalIdOf(kept);
    insertInjection(sid, keptLogical, pid, 111, 1, "pass");
    insertInjection(sid, "deleted-logical", pid, 222);

    appendSessionPromptDelta({
      sessionID: sid,
      projectID: pid,
      selector: JSON.stringify({ target: "messages", insertAt: 3 }),
      content: "[]",
    });

    saveSessionTracking(sid, {
      ltmCacheText: "cached ltm text",
      ltmCacheTokens: 123,
      ltmPinTokens: 45,
      stableLtmTokens: 67,
      lastAcceptedProvenanceLayer: 2,
    });

    const ctx = sessionContext(project, sid);
    expect(ctx).not.toBeNull();
    expect(ctx!.session_id).toBe(sid);
    expect(ctx!.layer).toBe(2);
    expect(ctx!.history.message_count).toBe(4);
    expect(ctx!.history.token_estimate).toBe(tokenSum(project, sid));

    expect(ctx!.distilled_prefix.token_count).toBe(65);
    expect(ctx!.distilled_prefix.distillations.map((d) => d.id)).toEqual([
      "d1",
      "d2",
    ]);
    expect(ctx!.distilled_prefix.distillations[0]).toEqual({
      id: "d1",
      generation: 0,
      token_count: 40,
      created_at: 500,
      observations: "obs-d1",
    });

    expect(ctx!.knowledge.cache_text).toBe("cached ltm text");
    expect(ctx!.knowledge.cache_tokens).toBe(123);
    expect(ctx!.knowledge.pin_tokens).toBe(45);
    expect(ctx!.knowledge.stable_tokens).toBe(67);
    expect(ctx!.knowledge.injections).toEqual([
      {
        logical_id: keptLogical,
        title: "Kept entry",
        category: "decision",
        confidence: 1,
        created_at: 111,
        credited: true,
        verdict: "pass",
      },
      {
        logical_id: "deleted-logical",
        title: null,
        category: null,
        confidence: null,
        created_at: 222,
        credited: false,
        verdict: null,
      },
    ]);

    // Only this project's delta row leaks through (seq restarts per session —
    // the foreign row was appended first so it owns seq 0, ours is seq 1).
    expect(ctx!.prompt_deltas).toHaveLength(1);
    expect(ctx!.prompt_deltas[0].selector).toContain("insertAt");

    expect(ctx!.turns).toHaveLength(1);
    const turn = ctx!.turns[0];
    expect(turn.layer).toBe(1);
    expect(turn.raw_tokens).toBe(100);
    expect(turn.total_tokens).toBe(150);
    expect(turn.distilled_tokens).toBe(50);
    expect(turn.usage).toEqual({
      input: 11,
      output: 7,
      cache_read: 3,
      cache_write: 2,
    });
    // message_id is the stored id surfaced by the legacy reader.
    const storedIds = new Set(
      temporal.bySession(project, sid).map((m) => m.id),
    );
    expect(storedIds.has(turn.message_id)).toBe(true);
  });

  test("turns keep created_at order across multiple gradient rows", () => {
    const project = freshProject("turns");
    const sid = "s-turns";
    // Insert out of order; ORDER BY created_at must restore it.
    storeMessage(
      project,
      assistantMsg(sid, "b", 3000, {
        layer: 0,
        rawTokens: 3,
        totalTokens: 3,
        distilledTokens: 0,
      }),
      3000,
    );
    storeMessage(
      project,
      assistantMsg(sid, "a", 1000, {
        layer: 1,
        rawTokens: 1,
        totalTokens: 2,
        distilledTokens: 1,
      }),
      1000,
    );
    const ctx = sessionContext(project, sid)!;
    expect(ctx.turns.map((t) => t.created_at)).toEqual([1000, 3000]);
    expect(ctx.turns.map((t) => t.layer)).toEqual([1, 0]);
  });

  test("gradient metadata with non-numeric fields is skipped", () => {
    const project = freshProject("bad-grad");
    const sid = "s-bad";
    storeMessage(project, assistantMsg(sid, "a1", 1000), 1000);
    forceMetadata(
      sid,
      "a1",
      JSON.stringify({
        gradient: { layer: "x", raw_tokens: 1, total_tokens: 2 },
      }),
    );
    const ctx = sessionContext(project, sid)!;
    expect(ctx.turns).toEqual([]);
  });

  test("layer is null when last_accepted_provenance_layer is -1 or no row exists", () => {
    const project = freshProject("layer-null");
    saveSessionTracking("s-neg", { lastAcceptedProvenanceLayer: -1 });
    expect(sessionContext(project, "s-neg")!.layer).toBeNull();

    storeMessage(project, userMsg("s-norow", "m1", 1000), 1000);
    const ctx = sessionContext(project, "s-norow")!;
    expect(ctx.layer).toBeNull();
    expect(ctx.knowledge.cache_text).toBeNull();
    expect(ctx.knowledge.injections).toEqual([]);
    expect(ctx.prompt_deltas).toEqual([]);
  });

  test("returns null for a session entirely unknown to the project", () => {
    const project = freshProject("unknown");
    ensureProject(project);
    expect(sessionContext(project, "never-seen")).toBeNull();
    // Even when another project knows the session.
    const other = freshProject("unknown-other");
    storeMessage(other, userMsg("known-elsewhere", "m1", 1), 1);
    expect(sessionContext(project, "known-elsewhere")).toBeNull();
    expect(sessionContext(other, "known-elsewhere")).not.toBeNull();
  });

  test("a session with only a session_state row is non-null", () => {
    const project = freshProject("state-only");
    saveSessionTracking("s-state-only", { messageCount: 9 });
    const ctx = sessionContext(project, "s-state-only");
    expect(ctx).not.toBeNull();
    expect(ctx!.history).toEqual({ message_count: 0, token_estimate: 0 });
    expect(ctx!.distilled_prefix).toEqual({
      token_count: 0,
      distillations: [],
    });
    expect(ctx!.turns).toEqual([]);
  });

  test("a session known only by prompt deltas or injections is non-null", () => {
    const project = freshProject("deltas-only");
    const pid = ensureProject(project);
    appendSessionPromptDelta({
      sessionID: "s-delta-only",
      projectID: pid,
      selector: "{}",
      content: "[]",
    });
    insertInjection("s-inj-only", "some-logical", pid, 1);
    expect(sessionContext(project, "s-delta-only")).not.toBeNull();
    expect(sessionContext(project, "s-inj-only")).not.toBeNull();
  });

  test("knowledgeTitlesFor resolves by logical_id and version id", () => {
    const project = freshProject("titles");
    const id = ltm.create({
      id: uuidv7(),
      projectPath: project,
      scope: "project",
      category: "gotcha",
      title: "Titled",
      content: "c",
    });
    const logical = ltm.logicalIdOf(id);
    const titles = knowledgeTitlesFor([logical, id, "missing"]);
    expect(titles.get(logical)).toBe("Titled");
    expect(titles.get(id)).toBe("Titled");
    expect(titles.has("missing")).toBe(false);
    expect(knowledgeTitlesFor([]).size).toBe(0);
  });
});
