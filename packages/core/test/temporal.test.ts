import { describe, test, expect, beforeAll, beforeEach } from "vitest";
import { db, ensureProject } from "../src/db";
import * as temporal from "../src/temporal";
import { ftsQuery } from "../src/search";
import type { LoreMessage, LorePart } from "../src/types";

const PROJECT = "/test/temporal/project";

function makeMessage(
  id: string,
  role: "user" | "assistant",
  sessionID = "sess-1",
): LoreMessage {
  if (role === "user") {
    return {
      id,
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" },
    };
  }
  return {
    id,
    sessionID,
    role: "assistant",
    time: { created: Date.now() },
    parentID: "parent-1",
    modelID: "claude-sonnet-4-20250514",
    providerID: "anthropic",
    mode: "build",
    path: { cwd: "/test", root: "/test" },
    cost: 0,
    tokens: {
      input: 100,
      output: 50,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  };
}

function makeParts(messageID: string, text: string): LorePart[] {
  return [
    {
      id: `part-${messageID}`,
      sessionID: "sess-1",
      messageID,
      type: "text",
      text,
      time: { start: Date.now(), end: Date.now() },
    },
  ];
}

function toolPart(
  messageID: string,
  callID: string,
  tool: string,
  state: Record<string, unknown>,
): LorePart {
  return {
    id: `tp-${callID}`,
    sessionID: "sess-tool",
    messageID,
    type: "tool",
    tool,
    callID,
    state,
  };
}

describe("temporal", () => {
  beforeAll(() => {
    // Clean stale data from prior test runs — tests are cumulative within a run
    const pid = ensureProject(PROJECT);
    db().query("DELETE FROM temporal_messages WHERE project_id = ?").run(pid);
  });

  test("store and retrieve messages", () => {
    const info = makeMessage("msg-1", "user");
    const parts = makeParts("msg-1", "How do I set up authentication?");
    temporal.store({ projectPath: PROJECT, info, parts });

    const all = temporal.bySession(PROJECT, "sess-1");
    expect(all.length).toBe(1);
    expect(all[0].content).toContain("authentication");
  });

  test("stores multiple messages", () => {
    temporal.store({
      projectPath: PROJECT,
      info: makeMessage("msg-2", "assistant"),
      parts: makeParts(
        "msg-2",
        "Authentication uses OAuth2 with PKCE flow in src/auth/config.ts",
      ),
    });
    temporal.store({
      projectPath: PROJECT,
      info: makeMessage("msg-3", "user"),
      parts: makeParts("msg-3", "What about the redirect middleware?"),
    });

    const all = temporal.bySession(PROJECT, "sess-1");
    expect(all.length).toBe(3);
  });

  test("updates existing message on re-store", () => {
    temporal.store({
      projectPath: PROJECT,
      info: makeMessage("msg-1", "user"),
      parts: makeParts(
        "msg-1",
        "Updated: How do I set up OAuth authentication?",
      ),
    });

    const all = temporal.bySession(PROJECT, "sess-1");
    expect(all.length).toBe(3); // still 3, not 4
    expect(all[0].content).toContain("OAuth");
  });

  test("full-text search works", () => {
    const results = temporal.search({ projectPath: PROJECT, query: "OAuth" });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain("OAuth");
  });

  test("searchScored returns lean columns (no embedding BLOB) — offload-safe", async () => {
    // Use a DEDICATED project so this seeded row never perturbs the cumulative
    // count/order-sensitive tests that share PROJECT.
    const LEAN_PROJECT = "/test/temporal/lean-cols";
    temporal.store({
      projectPath: LEAN_PROJECT,
      info: makeMessage("msg-lean", "user", "sess-lean"),
      parts: makeParts("msg-lean", "lean offload columns probe"),
    });
    // Give the row a non-null embedding BLOB. `SELECT m.*` would marshal this
    // BLOB across the read-worker boundary (forbidden by the read-job contract)
    // and waste bytes even in-process; the lean column list must drop it.
    db()
      .query("UPDATE temporal_messages SET embedding = ? WHERE id = ?")
      .run(new Uint8Array([1, 2, 3, 4]), "msg-lean");

    const results = await temporal.searchScored({
      projectPath: LEAN_PROJECT,
      query: "offload columns probe",
    });
    const hit = results.find((r) => r.id === "msg-lean");
    expect(hit).toBeDefined();
    // The fix: the SELECT enumerates lean columns and omits `embedding`.
    // Reverting to `SELECT m.*` re-introduces the key and fails this.
    expect("embedding" in hit!).toBe(false);
    // The columns recall actually consumes survive.
    expect(hit!.content).toContain("offload");
    expect(typeof hit!.rank).toBe("number");
  });

  test("search respects session scope", () => {
    temporal.store({
      projectPath: PROJECT,
      info: makeMessage("msg-other", "user", "sess-2"),
      parts: makeParts(
        "msg-other",
        "Totally different session about databases",
      ),
    });

    const scoped = temporal.search({
      projectPath: PROJECT,
      query: "databases",
      sessionID: "sess-1",
    });
    expect(scoped.length).toBe(0);

    const global = temporal.search({
      projectPath: PROJECT,
      query: "databases",
    });
    expect(global.length).toBeGreaterThan(0);
  });

  test("undistilled returns only non-distilled messages", () => {
    const pending = temporal.undistilled(PROJECT, "sess-1");
    expect(pending.length).toBe(3);

    temporal.markDistilled(["msg-1", "msg-2"]);

    const after = temporal.undistilled(PROJECT, "sess-1");
    expect(after.length).toBe(1);
    expect(after[0].id).toBe("msg-3");
  });

  test("search finds distilled messages", () => {
    // msg-1 and msg-2 were marked distilled in the previous test
    const results = temporal.search({
      projectPath: PROJECT,
      query: "OAuth",
    });
    expect(results.length).toBeGreaterThan(0);
    // msg-2 contains "OAuth2" and is distilled — must still appear
    expect(results.some((r) => r.id === "msg-2")).toBe(true);
  });

  test("count and undistilledCount", () => {
    expect(temporal.count(PROJECT, "sess-1")).toBe(3);
    expect(temporal.undistilledCount(PROJECT, "sess-1")).toBe(1);
  });

  test("skips empty content messages", () => {
    temporal.store({
      projectPath: PROJECT,
      info: makeMessage("msg-empty", "user"),
      parts: [],
    });
    // Should not increase count since content is empty
    expect(temporal.count(PROJECT, "sess-1")).toBe(3);
  });

  describe("prune", () => {
    const PRUNE_PROJECT = "/test/temporal/prune";
    const DAY_MS = 24 * 60 * 60 * 1000;

    function insertMessage(
      id: string,
      sessionID: string,
      distilled: 0 | 1,
      createdAt: number,
      contentSize = 100,
    ) {
      const pid = ensureProject(PRUNE_PROJECT);
      const content = "x".repeat(contentSize);
      db()
        .query(
          `INSERT OR REPLACE INTO temporal_messages
           (id, project_id, session_id, role, content, tokens, distilled, created_at, metadata)
           VALUES (?, ?, ?, 'user', ?, ?, ?, ?, '{}')`,
        )
        .run(
          id,
          pid,
          sessionID,
          content,
          Math.ceil(contentSize / 4),
          distilled,
          createdAt,
        );
    }

    // Clean the prune project before every test so data from
    // earlier tests in this file don't interfere with counts.
    beforeEach(() => {
      const pid = ensureProject(PRUNE_PROJECT);
      db().query("DELETE FROM temporal_messages WHERE project_id = ?").run(pid);
    });

    test("TTL pass deletes distilled messages older than retention window", () => {
      const now = Date.now();
      insertMessage("old-distilled", "sess-p1", 1, now - 130 * DAY_MS); // 130 days old — should be pruned
      insertMessage("new-distilled", "sess-p1", 1, now - 10 * DAY_MS); // 10 days old — kept
      insertMessage("old-undistilled", "sess-p1", 0, now - 130 * DAY_MS); // old but undistilled — never deleted

      const result = temporal.prune({
        projectPath: PRUNE_PROJECT,
        retentionDays: 120,
        maxStorageMB: 1024,
      });

      expect(result.ttlDeleted).toBe(1);
      expect(result.capDeleted).toBe(0);

      const remaining = db()
        .query("SELECT id FROM temporal_messages WHERE project_id = ?")
        .all(ensureProject(PRUNE_PROJECT)) as { id: string }[];
      const ids = remaining.map((r) => r.id);
      expect(ids).not.toContain("old-distilled");
      expect(ids).toContain("new-distilled");
      expect(ids).toContain("old-undistilled");
    });

    test("size cap pass deletes oldest distilled messages when over limit", () => {
      const now = Date.now();
      // 3 distilled messages each ~400 KB — total ~1.2 MB, cap at 1 MB
      const size = 400 * 1024;
      insertMessage("cap-old", "sess-p2", 1, now - 5 * DAY_MS, size);
      insertMessage("cap-mid", "sess-p2", 1, now - 3 * DAY_MS, size);
      insertMessage("cap-new", "sess-p2", 1, now - 1 * DAY_MS, size);
      // Undistilled — must never be evicted even when over cap
      insertMessage("cap-undistilled", "sess-p2", 0, now - 5 * DAY_MS, size);

      const result = temporal.prune({
        projectPath: PRUNE_PROJECT,
        retentionDays: 120,
        maxStorageMB: 1,
      });

      expect(result.ttlDeleted).toBe(0); // all within 120 days
      expect(result.capDeleted).toBeGreaterThan(0);

      // The undistilled message must survive no matter what
      const remaining = db()
        .query("SELECT id FROM temporal_messages WHERE project_id = ?")
        .all(ensureProject(PRUNE_PROJECT)) as { id: string }[];
      const ids = remaining.map((r) => r.id);
      expect(ids).toContain("cap-undistilled");

      // The oldest distilled should be the first evicted
      expect(ids).not.toContain("cap-old");
    });

    test("undistilled messages are never deleted by either pass", () => {
      const now = Date.now();
      // Very old undistilled — TTL pass must not touch it
      insertMessage("undist-ancient", "sess-p3", 0, now - 365 * DAY_MS);
      // Over-cap scenario — size cap pass must not touch undistilled
      insertMessage(
        "undist-large",
        "sess-p3",
        0,
        now - 1 * DAY_MS,
        2 * 1024 * 1024,
      );

      const result = temporal.prune({
        projectPath: PRUNE_PROJECT,
        retentionDays: 1,
        maxStorageMB: 1,
      });

      expect(result.ttlDeleted).toBe(0);
      expect(result.capDeleted).toBe(0);

      const remaining = db()
        .query("SELECT id FROM temporal_messages WHERE project_id = ?")
        .all(ensureProject(PRUNE_PROJECT)) as { id: string }[];
      expect(remaining.map((r) => r.id)).toContain("undist-ancient");
      expect(remaining.map((r) => r.id)).toContain("undist-large");
    });

    test("no-op when under both thresholds", () => {
      const now = Date.now();
      insertMessage("recent-dist", "sess-p4", 1, now - 1 * DAY_MS);
      insertMessage("recent-undist", "sess-p4", 0, now - 1 * DAY_MS);

      const result = temporal.prune({
        projectPath: PRUNE_PROJECT,
        retentionDays: 120,
        maxStorageMB: 1024,
      });

      expect(result.ttlDeleted).toBe(0);
      expect(result.capDeleted).toBe(0);
    });

    test("both passes can fire in same run", () => {
      const now = Date.now();
      // Old message caught by TTL
      insertMessage("both-old", "sess-p5", 1, now - 130 * DAY_MS, 100);
      // Recent but large messages that push over the cap (after TTL runs)
      const size = 600 * 1024;
      insertMessage("both-mid", "sess-p5", 1, now - 5 * DAY_MS, size);
      insertMessage("both-new", "sess-p5", 1, now - 1 * DAY_MS, size);

      const result = temporal.prune({
        projectPath: PRUNE_PROJECT,
        retentionDays: 120,
        maxStorageMB: 1,
      });

      expect(result.ttlDeleted).toBe(1); // both-old caught by TTL
      expect(result.capDeleted).toBeGreaterThan(0); // at least one of the large ones evicted
    });
  });

  describe("ftsQuery sanitization", () => {
    test("plain words get prefix wildcard", () => {
      expect(ftsQuery("OAuth PKCE flow")).toBe('"OAuth"* "PKCE"* "flow"*');
    });

    test("hyphenated terms: dash stripped, not treated as NOT operator", () => {
      // "opencode-test" would crash FTS5 as "opencode NOT test"
      expect(ftsQuery("opencode-test")).toBe('"opencode"* "test"*');
      expect(ftsQuery("three-tier")).toBe('"three"* "tier"*');
    });

    test("dot in domain name: dot stripped, not treated as column filter", () => {
      // "sanity.io" would crash FTS5 as column-filter syntax
      expect(ftsQuery("sanity.io")).toBe('"sanity"* "io"*');
    });

    test("other punctuation stripped, stopwords and single chars removed", () => {
      // "what" is stopword, "s" is single char, "the" is stopword — only "fix" survives
      expect(ftsQuery("what's the fix?")).toBe('"fix"*');
    });

    test("empty string returns sentinel", () => {
      expect(ftsQuery("")).toBe('""');
    });

    test("search does not throw on hyphenated query", () => {
      // These previously crashed with SQLiteError
      expect(() =>
        temporal.search({ projectPath: PROJECT, query: "opencode-test" }),
      ).not.toThrow();
      expect(() =>
        temporal.search({ projectPath: PROJECT, query: "three-tier" }),
      ).not.toThrow();
    });

    test("search does not throw on domain name query", () => {
      expect(() =>
        temporal.search({ projectPath: PROJECT, query: "sanity.io article" }),
      ).not.toThrow();
    });
  });

  describe("recordToolCalls", () => {
    const TOOL_PROJECT = "/test/temporal/tool-calls";

    beforeEach(() => {
      const pid = ensureProject(TOOL_PROJECT);
      db().query("DELETE FROM tool_calls WHERE project_id = ?").run(pid);
    });

    function rows(pid: string) {
      return db()
        .query(
          "SELECT call_id, tool, status, error_type, error_message, duration_ms FROM tool_calls WHERE project_id = ? ORDER BY call_id",
        )
        .all(pid) as Array<{
        call_id: string;
        tool: string;
        status: string;
        error_type: string | null;
        error_message: string | null;
        duration_ms: number | null;
      }>;
    }

    test("seeds tool name + pending from assistant tool_use parts", () => {
      const pid = ensureProject(TOOL_PROJECT);
      const info = makeMessage("tm-1", "assistant", "sess-tool");
      const parts: LorePart[] = [
        toolPart("tm-1", "ca", "read", { status: "pending", input: {} }),
        toolPart("tm-1", "cb", "bash", { status: "pending", input: {} }),
      ];
      temporal.recordToolCalls({ projectPath: TOOL_PROJECT, info, parts });

      const r = rows(pid);
      expect(r.length).toBe(2);
      expect(r.find((x) => x.call_id === "ca")?.tool).toBe("read");
      expect(r.find((x) => x.call_id === "ca")?.status).toBe("pending");
      expect(r.find((x) => x.call_id === "cb")?.tool).toBe("bash");
    });

    test("result parts update outcome by call_id, preserving seeded name", () => {
      const pid = ensureProject(TOOL_PROJECT);
      // Phase A: assistant seeds names (prior turn).
      temporal.recordToolCalls({
        projectPath: TOOL_PROJECT,
        info: makeMessage("tm-asst", "assistant", "sess-tool"),
        parts: [
          toolPart("tm-asst", "ca", "read", { status: "pending", input: {} }),
          toolPart("tm-asst", "cb", "bash", { status: "pending", input: {} }),
        ],
      });
      // Phase B: user message carries the tool_result outcomes (next turn).
      temporal.recordToolCalls({
        projectPath: TOOL_PROJECT,
        info: makeMessage("tm-user", "user", "sess-tool"),
        parts: [
          toolPart("tm-user", "ca", "result", {
            status: "completed",
            input: null,
            output: "file contents",
            time: { start: 100, end: 150 },
          }),
          toolPart("tm-user", "cb", "result", {
            status: "error",
            input: null,
            error: "ENOENT: no such file or directory",
            time: { start: 200, end: 260 },
          }),
        ],
      });

      const r = rows(pid);
      expect(r.length).toBe(2);
      const completed = r.find((x) => x.call_id === "ca");
      if (!completed) throw new Error("expected completed row");
      expect(completed.tool).toBe("read"); // name preserved, not "result"
      expect(completed.status).toBe("completed");
      expect(completed.error_type).toBeNull();
      expect(completed.duration_ms).toBe(50);
      const errored = r.find((x) => x.call_id === "cb");
      if (!errored) throw new Error("expected errored row");
      expect(errored.tool).toBe("bash"); // name preserved
      expect(errored.status).toBe("error");
      expect(errored.error_type).toBe("not_found");
      expect(errored.error_message).toBe("ENOENT: no such file or directory");
      expect(errored.duration_ms).toBe(60);
    });

    test("is idempotent on re-store (UPSERT on call_id)", () => {
      const pid = ensureProject(TOOL_PROJECT);
      const info = makeMessage("tm-2", "assistant", "sess-tool");
      const parts: LorePart[] = [
        toolPart("tm-2", "cx", "edit", { status: "pending", input: {} }),
      ];
      temporal.recordToolCalls({ projectPath: TOOL_PROJECT, info, parts });
      temporal.recordToolCalls({ projectPath: TOOL_PROJECT, info, parts });

      const r = rows(pid);
      expect(r.length).toBe(1);
      expect(r[0].tool).toBe("edit");
    });

    test("orphan result (no seeded row) is a silent no-op", () => {
      const pid = ensureProject(TOOL_PROJECT);
      temporal.recordToolCalls({
        projectPath: TOOL_PROJECT,
        info: makeMessage("tm-orphan", "user", "sess-tool"),
        parts: [
          toolPart("tm-orphan", "missing", "result", {
            status: "completed",
            input: null,
            output: "x",
            time: { start: 1, end: 2 },
          }),
        ],
      });
      expect(rows(pid).length).toBe(0);
    });

    test("no-op when there are no tool parts", () => {
      const pid = ensureProject(TOOL_PROJECT);
      const info = makeMessage("tm-3", "assistant", "sess-tool");
      temporal.recordToolCalls({
        projectPath: TOOL_PROJECT,
        info,
        parts: makeParts("tm-3", "just text"),
      });
      expect(rows(pid).length).toBe(0);
    });

    test("empty error string yields error_type bucket 'unknown'", () => {
      const pid = ensureProject(TOOL_PROJECT);
      temporal.recordToolCalls({
        projectPath: TOOL_PROJECT,
        info: makeMessage("tm-4a", "assistant", "sess-tool"),
        parts: [
          toolPart("tm-4a", "ce", "bash", { status: "pending", input: {} }),
        ],
      });
      temporal.recordToolCalls({
        projectPath: TOOL_PROJECT,
        info: makeMessage("tm-4b", "user", "sess-tool"),
        parts: [
          toolPart("tm-4b", "ce", "result", {
            status: "error",
            input: null,
            error: "",
            time: { start: 1, end: 2 },
          }),
        ],
      });
      const r = rows(pid);
      expect(r[0].error_type).toBe("unknown");
      expect(r[0].error_message).toBeNull();
    });
  });
});
