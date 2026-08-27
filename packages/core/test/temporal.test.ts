import { createHash } from "node:crypto";
import { describe, test, expect, beforeAll, beforeEach } from "vitest";
import { db, ensureProject, withSavepoint } from "../src/db";
import {
  ensureVec0Store,
  readStorageMode,
  setStorageMode,
  storeTemporalChunks,
} from "../src/db/vec-store";
import { config } from "../src/config";
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
    const project = "/test/temporal/store-retrieve";
    const info = makeMessage("msg-1", "user");
    const parts = makeParts("msg-1", "How do I set up authentication?");
    temporal.store({ projectPath: project, info, parts });

    const all = temporal.bySession(project, "sess-1");
    expect(all.length).toBe(1);
    expect(all[0].content).toContain("authentication");
  });

  test("stores multiple messages", () => {
    const project = "/test/temporal/store-multiple";
    temporal.store({
      projectPath: project,
      info: makeMessage("msg-1", "user"),
      parts: makeParts("msg-1", "How do I set up authentication?"),
    });
    temporal.store({
      projectPath: project,
      info: makeMessage("msg-2", "assistant"),
      parts: makeParts(
        "msg-2",
        "Authentication uses OAuth2 with PKCE flow in src/auth/config.ts",
      ),
    });
    temporal.store({
      projectPath: project,
      info: makeMessage("msg-3", "user"),
      parts: makeParts("msg-3", "What about the redirect middleware?"),
    });

    const all = temporal.bySession(project, "sess-1");
    expect(all.length).toBe(3);
  });

  test("updates existing message on re-store", () => {
    const project = "/test/temporal/store-update";
    temporal.store({
      projectPath: project,
      info: makeMessage("msg-1", "user"),
      parts: makeParts("msg-1", "How do I set up authentication?"),
    });
    temporal.store({
      projectPath: project,
      info: makeMessage("msg-1", "user"),
      parts: makeParts(
        "msg-1",
        "Updated: How do I set up OAuth authentication?",
      ),
    });

    const all = temporal.bySession(project, "sess-1");
    expect(all.length).toBe(1);
    expect(all[0].content).toContain("OAuth");
  });

  test("durably enqueues one content-safe embedding job per message", () => {
    const project = "/test/temporal/embedding-queue";
    const content = "queue this temporal message without copying its content";
    const storedId = temporal.store({
      projectPath: project,
      info: makeMessage("msg-queue", "user", "sess-queue"),
      parts: makeParts("msg-queue", content),
    });
    if (!storedId) throw new Error("expected stored message id");

    const columns = db()
      .query("PRAGMA table_info(temporal_embedding_queue)")
      .all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual([
      "message_id",
      "content_hash",
      "fingerprint",
      "enqueued_at",
    ]);

    const rows = db()
      .query("SELECT * FROM temporal_embedding_queue WHERE message_id = ?")
      .all(storedId) as Array<{
      message_id: string;
      content_hash: string;
      fingerprint: string;
      enqueued_at: number;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].content_hash).toBe(
      createHash("sha256").update(content).digest("hex"),
    );
    expect(rows[0].fingerprint).toMatch(/temporal-embedding-policy-v\d+$/);
    expect(rows[0].enqueued_at).toBeGreaterThan(0);
    expect(JSON.stringify(rows[0])).not.toContain(content);
  });

  test("re-store coalesces the durable embedding job to the newest content", () => {
    const project = "/test/temporal/embedding-coalesce";
    const info = makeMessage("msg-coalesce", "user", "sess-coalesce");
    const firstId = temporal.store({
      projectPath: project,
      info,
      parts: makeParts("msg-coalesce", "first content to become stale"),
    });
    if (!firstId) throw new Error("expected stored message id");
    db()
      .query(
        "UPDATE temporal_embedding_queue SET enqueued_at = 1 WHERE message_id = ?",
      )
      .run(firstId);

    const latest = "newest content must supersede the old embedding job";
    const secondId = temporal.store({
      projectPath: project,
      info,
      parts: makeParts("msg-coalesce", latest),
    });
    expect(secondId).toBe(firstId);

    const rows = db()
      .query(
        "SELECT content_hash, enqueued_at FROM temporal_embedding_queue WHERE message_id = ?",
      )
      .all(firstId) as Array<{ content_hash: string; enqueued_at: number }>;
    expect(rows).toEqual([
      {
        content_hash: createHash("sha256").update(latest).digest("hex"),
        enqueued_at: expect.any(Number),
      },
    ]);
    expect(rows[0].enqueued_at).toBeGreaterThan(1);
  });

  test("idempotent re-store preserves queue age and an existing blob vector", () => {
    const project = "/test/temporal/embedding-idempotent";
    const info = makeMessage("msg-idempotent", "user", "sess-idempotent");
    const content = "identical content must preserve a valid temporal vector";
    const storedId = temporal.store({
      projectPath: project,
      info,
      parts: makeParts("msg-idempotent", content),
    });
    if (!storedId) throw new Error("expected stored message id");
    db()
      .query(
        "UPDATE temporal_embedding_queue SET enqueued_at = 1 WHERE message_id = ?",
      )
      .run(storedId);
    const vector = new Uint8Array([1, 2, 3, 4]);
    db()
      .query("UPDATE temporal_messages SET embedding = ? WHERE id = ?")
      .run(vector, storedId);

    expect(
      temporal.store({
        projectPath: project,
        info,
        parts: makeParts("msg-idempotent", content),
      }),
    ).toBe(storedId);

    expect(
      db()
        .query(
          "SELECT enqueued_at FROM temporal_embedding_queue WHERE message_id = ?",
        )
        .get(storedId),
    ).toEqual({ enqueued_at: 1 });
    const row = db()
      .query("SELECT embedding FROM temporal_messages WHERE id = ?")
      .get(storedId) as { embedding: Uint8Array | null };
    expect(row.embedding).toEqual(vector);
  });

  test("idempotent re-store recreates durable work when its vector is missing", () => {
    const project = "/test/temporal/embedding-idempotent-missing";
    const info = makeMessage(
      "msg-idempotent-missing",
      "user",
      "sess-idempotent-missing",
    );
    const content = "identical replay must recover a missing temporal vector";
    const storedId = temporal.store({
      projectPath: project,
      info,
      parts: makeParts("msg-idempotent-missing", content),
    });
    if (!storedId) throw new Error("expected stored message id");
    db()
      .query("DELETE FROM temporal_embedding_queue WHERE message_id = ?")
      .run(storedId);

    temporal.store({
      projectPath: project,
      info,
      parts: makeParts("msg-idempotent-missing", content),
    });

    expect(
      db()
        .query(
          "SELECT content_hash FROM temporal_embedding_queue WHERE message_id = ?",
        )
        .get(storedId),
    ).toEqual({
      content_hash: createHash("sha256").update(content).digest("hex"),
    });
  });

  test("changed re-store invalidates a vec0 set and rollback restores vector, queue, and content", () => {
    const originalMode = readStorageMode(db());
    ensureVec0Store(db(), config().search.embeddings.dimensions);
    setStorageMode(db(), "vec0");
    const project = "/test/temporal/embedding-invalidation-atomic";
    const info = makeMessage("msg-invalidation", "user", "sess-invalidation");
    const original = "original content owns the currently stored vec0 chunks";
    const storedId = temporal.store({
      projectPath: project,
      info,
      parts: makeParts("msg-invalidation", original),
    });
    if (!storedId) throw new Error("expected stored message id");
    const vector = new Float32Array(config().search.embeddings.dimensions);
    vector[0] = 1;
    storeTemporalChunks(db(), storedId, [vector]);
    const originalQueue = db()
      .query(
        "SELECT content_hash, fingerprint, enqueued_at FROM temporal_embedding_queue WHERE message_id = ?",
      )
      .get(storedId);

    expect(() =>
      withSavepoint("rollback_changed_temporal", () => {
        temporal.store({
          projectPath: project,
          info,
          parts: makeParts(
            "msg-invalidation",
            "changed content must invalidate old vectors atomically",
          ),
        });
        expect(
          db()
            .query("SELECT chunk_id FROM temporal_vec WHERE message_id = ?")
            .get(storedId),
        ).toBeNull();
        throw new Error("rollback changed temporal store");
      }),
    ).toThrow("rollback changed temporal store");

    expect(
      db()
        .query("SELECT content FROM temporal_messages WHERE id = ?")
        .get(storedId),
    ).toEqual({ content: original });
    expect(
      db()
        .query("SELECT chunk_id FROM temporal_vec WHERE message_id = ?")
        .get(storedId),
    ).toEqual({ chunk_id: `${storedId}#0` });
    expect(
      db()
        .query(
          "SELECT content_hash, fingerprint, enqueued_at FROM temporal_embedding_queue WHERE message_id = ?",
        )
        .get(storedId),
    ).toEqual(originalQueue);
    setStorageMode(db(), originalMode);
  });

  test("base deletion cascades pending temporal embedding work", () => {
    const storedId = temporal.store({
      projectPath: "/test/temporal/embedding-cascade",
      info: makeMessage("msg-cascade", "user", "sess-cascade"),
      parts: makeParts("msg-cascade", "pending work removed with its base row"),
    });
    if (!storedId) throw new Error("expected stored message id");

    db().query("DELETE FROM temporal_messages WHERE id = ?").run(storedId);
    expect(
      db()
        .query(
          "SELECT message_id FROM temporal_embedding_queue WHERE message_id = ?",
        )
        .get(storedId),
    ).toBeNull();
  });

  test("outer savepoint rolls back the message and its embedding job", () => {
    const project = "/test/temporal/embedding-atomic";
    let storedId: string | undefined;
    expect(() =>
      withSavepoint("test_temporal_embedding_atomic", () => {
        storedId = temporal.store({
          projectPath: project,
          info: makeMessage("msg-atomic", "user", "sess-atomic"),
          parts: makeParts(
            "msg-atomic",
            "message and queue must commit together",
          ),
        });
        throw new Error("rollback temporal store");
      }),
    ).toThrow("rollback temporal store");
    if (!storedId) throw new Error("expected derived storage id");

    expect(
      db().query("SELECT id FROM temporal_messages WHERE id = ?").get(storedId),
    ).toBeNull();
    expect(
      db()
        .query(
          "SELECT message_id FROM temporal_embedding_queue WHERE message_id = ?",
        )
        .get(storedId),
    ).toBeNull();
  });

  test("full-text search works", () => {
    const project = "/test/temporal/full-text-search";
    temporal.store({
      projectPath: project,
      info: makeMessage("msg-search", "assistant"),
      parts: makeParts("msg-search", "Authentication uses OAuth2 with PKCE"),
    });

    const results = temporal.search({ projectPath: project, query: "OAuth" });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain("OAuth");
  });

  test("searchScored returns lean columns (no embedding BLOB) — offload-safe", async () => {
    // Use a DEDICATED project so this seeded row never perturbs the cumulative
    // count/order-sensitive tests that share PROJECT.
    const LEAN_PROJECT = "/test/temporal/lean-cols";
    const storedId = temporal.store({
      projectPath: LEAN_PROJECT,
      info: makeMessage("msg-lean", "user", "sess-lean"),
      parts: makeParts("msg-lean", "lean offload columns probe"),
    });
    if (!storedId) throw new Error("expected stored message id");
    // Give the row a non-null embedding BLOB. `SELECT m.*` would marshal this
    // BLOB across the read-worker boundary (forbidden by the read-job contract)
    // and waste bytes even in-process; the lean column list must drop it.
    db()
      .query("UPDATE temporal_messages SET embedding = ? WHERE id = ?")
      .run(new Uint8Array([1, 2, 3, 4]), storedId);

    const results = await temporal.searchScored({
      projectPath: LEAN_PROJECT,
      query: "offload columns probe",
    });
    const hit = results.find((r) => r.source_id === "msg-lean");
    expect(hit).toBeDefined();
    if (!hit) throw new Error("expected lean temporal search hit");
    // The fix: the SELECT enumerates lean columns and omits `embedding`.
    // Reverting to `SELECT m.*` re-introduces the key and fails this.
    expect("embedding" in hit).toBe(false);
    // The columns recall actually consumes survive.
    expect(hit.content).toContain("offload");
    expect(typeof hit.rank).toBe("number");
  });

  test("search respects session scope", () => {
    const project = "/test/temporal/search-session-scope";
    temporal.store({
      projectPath: project,
      info: makeMessage("msg-other", "user", "sess-2"),
      parts: makeParts(
        "msg-other",
        "Totally different session about databases",
      ),
    });

    const scoped = temporal.search({
      projectPath: project,
      query: "databases",
      sessionID: "sess-1",
    });
    expect(scoped.length).toBe(0);

    const global = temporal.search({
      projectPath: project,
      query: "databases",
    });
    expect(global.length).toBeGreaterThan(0);
  });

  test("undistilled returns only non-distilled messages", () => {
    const project = "/test/temporal/undistilled";
    for (const id of ["msg-1", "msg-2", "msg-3"]) {
      temporal.store({
        projectPath: project,
        info: makeMessage(id, "user"),
        parts: makeParts(id, `undistilled content for ${id}`),
      });
    }
    const pending = temporal.undistilled(project, "sess-1");
    expect(pending.length).toBe(3);

    temporal.markDistilled(
      pending
        .filter((message) =>
          ["msg-1", "msg-2"].includes(message.source_id ?? ""),
        )
        .map((message) => message.id),
    );

    const after = temporal.undistilled(project, "sess-1");
    expect(after.length).toBe(1);
    expect(after[0].source_id).toBe("msg-3");
  });

  test("search finds distilled messages", () => {
    const project = "/test/temporal/search-distilled";
    const id = temporal.store({
      projectPath: project,
      info: makeMessage("msg-distilled", "assistant"),
      parts: makeParts(
        "msg-distilled",
        "OAuth2 remains searchable after distillation",
      ),
    });
    if (!id) throw new Error("expected stored message id");
    temporal.markDistilled([id]);

    const results = temporal.search({
      projectPath: project,
      query: "OAuth",
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.source_id === "msg-distilled")).toBe(true);
  });

  test("count and undistilledCount", () => {
    const project = "/test/temporal/count";
    const first = temporal.store({
      projectPath: project,
      info: makeMessage("msg-count-1", "user"),
      parts: makeParts("msg-count-1", "first count message"),
    });
    temporal.store({
      projectPath: project,
      info: makeMessage("msg-count-2", "assistant"),
      parts: makeParts("msg-count-2", "second count message"),
    });
    if (!first) throw new Error("expected stored message id");
    temporal.markDistilled([first]);

    expect(temporal.count(project, "sess-1")).toBe(2);
    expect(temporal.undistilledCount(project, "sess-1")).toBe(1);
  });

  test("skips empty content messages", () => {
    const project = "/test/temporal/empty-content";
    temporal.store({
      projectPath: project,
      info: makeMessage("msg-empty", "user"),
      parts: [],
    });
    expect(temporal.count(project, "sess-1")).toBe(0);
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
          "SELECT call_id, message_id, tool, status, error_type, error_message, duration_ms, verifier FROM tool_calls WHERE project_id = ? ORDER BY call_id",
        )
        .all(pid) as Array<{
        call_id: string;
        message_id: string;
        tool: string;
        status: string;
        error_type: string | null;
        error_message: string | null;
        duration_ms: number | null;
        verifier: number;
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

    test("is idempotent on re-store (UPSERT on owned call_id)", () => {
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

    // --- Batching (LOREAI-GATEWAY-3G, #1178) -------------------------------
    // The seed phase is now ONE multi-row INSERT for all tool_use parts. These
    // tests pin the behavior that must survive the batch: many seeds in one
    // call, mixed use+result parts in one call, the pending-guard on conflict,
    // and duplicate call_ids within a single batch.

    test("batches many tool_use seeds from one call into distinct rows", () => {
      const pid = ensureProject(TOOL_PROJECT);
      const info = makeMessage("tm-batch", "assistant", "sess-tool");
      const parts: LorePart[] = [
        toolPart("tm-batch", "b0", "read", { status: "pending", input: {} }),
        toolPart("tm-batch", "b1", "bash", { status: "pending", input: {} }),
        toolPart("tm-batch", "b2", "edit", { status: "pending", input: {} }),
        toolPart("tm-batch", "b3", "grep", { status: "pending", input: {} }),
        toolPart("tm-batch", "b4", "glob", { status: "pending", input: {} }),
      ];
      temporal.recordToolCalls({ projectPath: TOOL_PROJECT, info, parts });

      const r = rows(pid);
      expect(r.length).toBe(5);
      expect(r.map((x) => x.tool)).toEqual([
        "read",
        "bash",
        "edit",
        "grep",
        "glob",
      ]);
      expect(r.every((x) => x.status === "pending")).toBe(true);
    });

    test("handles mixed tool_use + result parts in a single call", () => {
      const pid = ensureProject(TOOL_PROJECT);
      // Seed one call first (prior turn).
      temporal.recordToolCalls({
        projectPath: TOOL_PROJECT,
        info: makeMessage("tm-mix-a", "assistant", "sess-tool"),
        parts: [
          toolPart("tm-mix-a", "m0", "read", { status: "pending", input: {} }),
        ],
      });
      // Now a single call that BOTH resolves m0 (result) AND seeds a new use m1.
      temporal.recordToolCalls({
        projectPath: TOOL_PROJECT,
        info: makeMessage("tm-mix-b", "assistant", "sess-tool"),
        parts: [
          toolPart("tm-mix-b", "m0", "result", {
            status: "completed",
            input: null,
            output: "ok",
            time: { start: 10, end: 40 },
          }),
          toolPart("tm-mix-b", "m1", "bash", { status: "pending", input: {} }),
        ],
      });

      const r = rows(pid);
      expect(r.length).toBe(2);
      const m0 = r.find((x) => x.call_id === "m0");
      expect(m0?.tool).toBe("read"); // seeded name preserved through result
      expect(m0?.status).toBe("completed");
      expect(m0?.duration_ms).toBe(30);
      const m1 = r.find((x) => x.call_id === "m1");
      expect(m1?.tool).toBe("bash");
      expect(m1?.status).toBe("pending");
    });

    test("re-seed does NOT revert a resolved row to pending (pending-guard)", () => {
      const pid = ensureProject(TOOL_PROJECT);
      // Seed + resolve.
      temporal.recordToolCalls({
        projectPath: TOOL_PROJECT,
        info: makeMessage("tm-g-a", "assistant", "sess-tool"),
        parts: [
          toolPart("tm-g-a", "g0", "read", { status: "pending", input: {} }),
        ],
      });
      temporal.recordToolCalls({
        projectPath: TOOL_PROJECT,
        info: makeMessage("tm-g-b", "user", "sess-tool"),
        parts: [
          toolPart("tm-g-b", "g0", "result", {
            status: "completed",
            input: null,
            output: "done",
            time: { start: 1, end: 5 },
          }),
        ],
      });
      // A duplicate tool_use re-seed (retry / stream re-delivery) alongside a new
      // seed — the batched INSERT must keep g0 completed, not revert to pending.
      temporal.recordToolCalls({
        projectPath: TOOL_PROJECT,
        info: makeMessage("tm-g-c", "assistant", "sess-tool"),
        parts: [
          toolPart("tm-g-c", "g0", "read", { status: "pending", input: {} }),
          toolPart("tm-g-c", "g1", "bash", { status: "pending", input: {} }),
        ],
      });

      const r = rows(pid);
      expect(r.find((x) => x.call_id === "g0")?.status).toBe("completed");
      expect(r.find((x) => x.call_id === "g1")?.status).toBe("pending");
    });

    test("batches the verifier flag and message_id per row", () => {
      const pid = ensureProject(TOOL_PROJECT);
      // One batch with a verifier call (leading `npm test`) and a non-verifier
      // call — the per-row verifier classification must survive batching.
      temporal.recordToolCalls({
        projectPath: TOOL_PROJECT,
        info: makeMessage("tm-vf", "assistant", "sess-tool"),
        parts: [
          toolPart("tm-vf", "v0", "bash", {
            status: "pending",
            input: { command: "npm test" },
          }),
          toolPart("tm-vf", "v1", "bash", {
            status: "pending",
            input: { command: "ls -la" },
          }),
        ],
      });
      const r = rows(pid);
      expect(r.find((x) => x.call_id === "v0")?.verifier).toBe(1);
      expect(r.find((x) => x.call_id === "v1")?.verifier).toBe(0);
      // message_id seeded from the assistant message on every batched row.
      expect(r.every((x) => x.message_id.startsWith("lore_tm_v1_"))).toBe(true);
    });

    test("result update preserves the batched seed's message_id", () => {
      const pid = ensureProject(TOOL_PROJECT);
      temporal.recordToolCalls({
        projectPath: TOOL_PROJECT,
        info: makeMessage("tm-mid-asst", "assistant", "sess-tool"),
        parts: [
          toolPart("tm-mid-asst", "p0", "read", {
            status: "pending",
            input: {},
          }),
        ],
      });
      // Result comes on a DIFFERENT (user) message; the seeded message_id must
      // be preserved (the UPDATE does not touch message_id).
      temporal.recordToolCalls({
        projectPath: TOOL_PROJECT,
        info: makeMessage("tm-mid-user", "user", "sess-tool"),
        parts: [
          toolPart("tm-mid-user", "p0", "result", {
            status: "completed",
            input: null,
            output: "ok",
            time: { start: 1, end: 3 },
          }),
        ],
      });
      const r = rows(pid);
      expect(r.length).toBe(1);
      expect(r[0].message_id).toBe(
        temporal.storedMessageId({
          projectPath: TOOL_PROJECT,
          sessionID: "sess-tool",
          sourceID: "tm-mid-asst",
        }),
      ); // seed's storage id, not the result's
      expect(r[0].status).toBe("completed");
    });

    test("inserts every row when the seed batch spans multiple chunks", () => {
      // The seed INSERT is chunked (CHUNK=81) so a pathological batch can never
      // exceed SQLite's conservative ~999 bound-variable ceiling (the #796
      // convention). This asserts the chunk LOOP is correct: a batch larger than
      // one chunk still inserts every distinct row across the boundary.
      const pid = ensureProject(TOOL_PROJECT);
      const info = makeMessage("tm-chunk", "assistant", "sess-tool");
      const N = 200; // > 2 chunks
      const parts: LorePart[] = Array.from({ length: N }, (_, i) =>
        toolPart("tm-chunk", `c${i}`, "read", {
          status: "pending",
          input: {},
        }),
      );
      temporal.recordToolCalls({ projectPath: TOOL_PROJECT, info, parts });

      const r = rows(pid);
      expect(r.length).toBe(N);
      // Every call_id present exactly once, all seeded pending.
      const ids = new Set(r.map((x) => x.call_id));
      expect(ids.size).toBe(N);
      expect(r.every((x) => x.status === "pending" && x.tool === "read")).toBe(
        true,
      );
    });

    test("duplicate call_id within one batch resolves like the sequential loop", () => {
      const pid = ensureProject(TOOL_PROJECT);
      // Same call_id twice in a single seed batch: first inserts pending, second
      // hits ON CONFLICT — since the row is pending, the (identical) values apply
      // and the net result is a single pending row (last-writer within batch).
      const info = makeMessage("tm-dup", "assistant", "sess-tool");
      temporal.recordToolCalls({
        projectPath: TOOL_PROJECT,
        info,
        parts: [
          toolPart("tm-dup", "d0", "read", { status: "pending", input: {} }),
          toolPart("tm-dup", "d0", "read", { status: "pending", input: {} }),
        ],
      });
      const r = rows(pid);
      expect(r.length).toBe(1);
      expect(r[0].call_id).toBe("d0");
      expect(r[0].tool).toBe("read");
      expect(r[0].status).toBe("pending");
    });
  });
});
