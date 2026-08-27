/**
 * D (#826) — Pro-tier backup (distillations + the distillation-referenced subset
 * of temporal_messages) push-side correctness: the distillation-fanout capture,
 * tier-gating, subset-aware seed, the append-only no-tombstone reconcile, and the
 * sync-invisible prune. The pull/restore side (residency exemption, encrypted
 * round-trip) is covered by the Tier-2 integration suite (D-4).
 */
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  db,
  deleteTeamConfig,
  ensureProject,
  reinstallSyncCapture,
} from "../src/db";
import {
  applyRemoteTemporal,
  assertSyncInvariants,
  enableSync,
  getSyncState,
  readOutbox,
  reconcile,
  seedOutbox,
  setSyncState,
} from "../src/sync-data";
import * as temporal from "../src/temporal";

const DAY_MS = 24 * 60 * 60 * 1000;

const PROJECT = "/test/sync/pro";
const now = () => Date.now();

function setProTier() {
  db()
    .query(
      "INSERT OR REPLACE INTO profiles (id, tier, created_at, updated_at) VALUES ('pro-u','pro',?,?)",
    )
    .run(now(), now());
  reinstallSyncCapture(); // installs the tier-gated distillation-fanout trigger
}

function insertTemporal(id: string, distilled: 0 | 1 = 0, createdAt = now()) {
  const pid = ensureProject(PROJECT);
  db()
    .query(
      `INSERT OR REPLACE INTO temporal_messages
         (id, project_id, session_id, role, content, tokens, distilled, created_at, metadata)
       VALUES (?, ?, 's', 'user', 'hello', 1, ?, ?, '{}')`,
    )
    .run(id, pid, distilled, createdAt);
}

function insertDistillation(
  id: string,
  sourceIds: string[],
  {
    archived = 0,
    createdAt = now(),
  }: { archived?: 0 | 1; createdAt?: number } = {},
) {
  const pid = ensureProject(PROJECT);
  db()
    .query(
      `INSERT OR REPLACE INTO distillations
         (id, project_id, session_id, narrative, facts, observations, source_ids, generation, token_count, created_at, archived)
       VALUES (?, ?, 's', 'n', 'f', 'o', ?, 0, 0, ?, ?)`,
    )
    .run(id, pid, JSON.stringify(sourceIds), createdAt, archived);
}

const clearOutbox = () => db().exec("DELETE FROM sync_outbox");
const outbox = (table?: string, op?: string) =>
  readOutbox(0).filter(
    (e) => (!table || e.table_name === table) && (!op || e.op === op),
  );
const rowIds = (table: string, op?: string) =>
  outbox(table, op)
    .map((e) => e.row_id)
    .sort();

beforeEach(() => {
  const pid = ensureProject(PROJECT);
  deleteTeamConfig("sync.enabled");
  // P2c (#1246): remote-backed → Pro content passes the git_remote gate. Set while sync is
  // OFF (line above) so it fires no capture; every Pro test uses this same PROJECT.
  db()
    .query(
      "UPDATE projects SET git_remote = 'test:remote' WHERE id = ? AND git_remote IS NULL",
    )
    .run(pid);
  db().exec("DELETE FROM temp._sync_applying");
  db().exec("DELETE FROM sync_outbox");
  db().exec("DELETE FROM sync_state");
  db().exec("DELETE FROM profiles");
  db().query("DELETE FROM temporal_messages WHERE project_id = ?").run(pid);
  db().query("DELETE FROM distillations WHERE project_id = ?").run(pid);
  reinstallSyncCapture(); // free-tier baseline (drops any Pro fanout trigger)
});
afterEach(() => {
  db().exec("DELETE FROM profiles");
  reinstallSyncCapture();
});

describe("distillation-fanout capture (#826/D)", () => {
  test("a distillation INSERT enqueues the distillation + ONLY its referenced temporal subset", () => {
    setProTier();
    enableSync();
    insertTemporal("t1");
    insertTemporal("t2");
    insertTemporal("t3"); // undistilled — must NEVER be enqueued
    clearOutbox(); // temporal has no own trigger, so this is already empty
    insertDistillation("d1", ["t1", "t2"]);

    expect(rowIds("distillations")).toEqual(["d1"]);
    expect(rowIds("temporal_messages")).toEqual(["t1", "t2"]); // t3 excluded
  });

  test("the fanout is TIER-GATED: a free-tier distillation INSERT enqueues nothing", () => {
    // No profile row → free tier → reinstall drops the fanout trigger.
    reinstallSyncCapture();
    enableSync();
    clearOutbox();
    insertDistillation("d1", ["t1", "t2"]);
    expect(outbox("distillations")).toHaveLength(0);
    expect(outbox("temporal_messages")).toHaveLength(0);
  });

  test("the archived flip re-enqueues the distillation ONLY (not its temporal)", () => {
    setProTier();
    enableSync();
    insertDistillation("d1", ["t1"]);
    clearOutbox();
    db().query("UPDATE distillations SET archived = 1 WHERE id = 'd1'").run();
    expect(rowIds("distillations")).toEqual(["d1"]);
    expect(outbox("temporal_messages")).toHaveLength(0);
  });
});

describe("subset-aware seedOutbox (#826/D)", () => {
  test("seeds distillations + ONLY the referenced temporal subset (never an undistilled message)", () => {
    // Sync disabled → no capture; seed directly at the pro tier.
    insertTemporal("t1");
    insertTemporal("t2");
    insertTemporal("t3"); // referenced by nothing
    insertDistillation("d1", ["t1", "t2"]);
    clearOutbox();

    seedOutbox("pro");

    expect(rowIds("distillations")).toEqual(["d1"]);
    expect(rowIds("temporal_messages")).toEqual(["t1", "t2"]); // t3 never seeded
  });
});

describe("reconcile never tombstones the append-only Pro backup (#826/D)", () => {
  test("a locally-deleted synced distillation/temporal does NOT enqueue a delete", () => {
    setProTier();
    enableSync();
    insertTemporal("t1");
    insertDistillation("d1", ["t1"]);
    // Pretend both were pushed (sync_state present), then vanish locally (prune /
    // project cleanup). A basic table would tombstone here; a Pro table must not.
    setSyncState("distillations", "d1", {
      content_hash: "h",
      revision: 0,
      remote_updated_at: null,
    });
    setSyncState("temporal_messages", "t1", {
      content_hash: "h",
      revision: 0,
      remote_updated_at: null,
    });
    db().exec("DELETE FROM distillations WHERE id = 'd1'");
    db().exec("DELETE FROM temporal_messages WHERE id = 't1'");
    clearOutbox();

    reconcile("pro");

    expect(outbox("distillations", "delete")).toHaveLength(0);
    expect(outbox("temporal_messages", "delete")).toHaveLength(0);
  });
});

describe("assertSyncInvariants spans all tiers (#826/D)", () => {
  test("a Pro-table sync_state row at basic tier is NOT flagged as registry drift", () => {
    // No profile row → basic tier. A distillations sync_state row lingers from when
    // the user was pro (or before the tier mirror loaded). Invariant #3's known-set
    // must span ALL tiers, else this false-throws "references unregistered table".
    setSyncState("distillations", "d-old", {
      content_hash: "h",
      revision: 0,
      remote_updated_at: null,
    });
    expect(() => assertSyncInvariants()).not.toThrow();
  });
});

describe("restore residency: pulled temporal survives prune (#826/D, D-4)", () => {
  const readTemporal = (id: string) =>
    db()
      .query(
        "SELECT distilled, created_at, restored_at FROM temporal_messages WHERE id = ?",
      )
      .get(id) as
      | { distilled: number; created_at: number; restored_at: number | null }
      | undefined;

  test("a restored (recent restored_at) message SURVIVES TTL prune despite an old created_at; a native one does not", () => {
    const pid = ensureProject(PROJECT);
    const old = now() - 200 * DAY_MS; // 200 days old — past a 120-day retention
    // Native distilled row: restored_at NULL → keyed by created_at → pruned.
    db()
      .query(
        "INSERT INTO temporal_messages (id, project_id, session_id, role, content, tokens, distilled, created_at, metadata, restored_at) VALUES ('native', ?, 's', 'user', 'x', 1, 1, ?, '{}', NULL)",
      )
      .run(pid, old);
    // Restored row: same old created_at, but restored_at = now → keyed by residency → kept.
    db()
      .query(
        "INSERT INTO temporal_messages (id, project_id, session_id, role, content, tokens, distilled, created_at, metadata, restored_at) VALUES ('restored', ?, 's', 'user', 'x', 1, 1, ?, '{}', ?)",
      )
      .run(pid, old, now());

    temporal.prune({
      projectPath: PROJECT,
      retentionDays: 120,
      maxStorageMB: 1024,
    });

    expect(readTemporal("native")).toBeNull(); // pruned (.get() returns null, not undefined)
    expect(readTemporal("restored")).toBeTruthy(); // survived
  });

  test("applyRemoteTemporal INSERT marks distilled=1 + stamps restored_at", () => {
    const pid = ensureProject(PROJECT);
    const origin = now() - 300 * DAY_MS;
    applyRemoteTemporal({
      id: "r1",
      project_id: pid,
      session_id: "s",
      role: "user",
      content: "hello",
      tokens: 1,
      metadata: "{}",
      created_at: origin,
    });
    const row = readTemporal("r1");
    expect(row?.distilled).toBe(1); // archival — never re-distilled
    expect(row?.created_at).toBe(origin); // origin preserved for ordering/recall
    expect(row?.restored_at).toBeGreaterThan(origin); // residency clock stamped ~now
    const queued = db()
      .query(
        "SELECT content_hash, fingerprint FROM temporal_embedding_queue WHERE message_id = ?",
      )
      .get("r1") as { content_hash: string; fingerprint: string } | null;
    expect(queued).toEqual({
      content_hash: createHash("sha256").update("hello").digest("hex"),
      fingerprint: expect.stringMatching(/temporal-embedding-policy-v\d+$/),
    });
    expect(JSON.stringify(queued)).not.toContain("hello");
  });

  test("applyRemoteTemporal PRESERVES a self-pull-back row's native flags (no clock reset)", () => {
    const pid = ensureProject(PROJECT);
    const origin = now() - 300 * DAY_MS;
    // A device's OWN pushed row already lives locally with native flags (restored_at NULL).
    db()
      .query(
        "INSERT INTO temporal_messages (id, project_id, session_id, role, content, tokens, distilled, created_at, metadata, restored_at) VALUES ('own', ?, 's', 'user', 'orig', 1, 1, ?, '{}', NULL)",
      )
      .run(pid, origin);
    // Pulling it back (same content) must NOT stamp restored_at / flip its clock.
    applyRemoteTemporal({
      id: "own",
      project_id: pid,
      session_id: "s",
      role: "user",
      content: "orig",
      tokens: 1,
      metadata: "{}",
      created_at: origin,
    });
    const row = readTemporal("own");
    expect(row?.restored_at).toBeNull(); // native clock preserved
    expect(row?.distilled).toBe(1);
  });

  test("applyRemoteTemporal conflict-update PRESERVES an existing distilled=0 flag (never flips active→archival)", () => {
    const pid = ensureProject(PROJECT);
    const origin = now() - 300 * DAY_MS;
    // A local still-ACTIVE (distilled=0) row with the same id: the conflict-update
    // must touch neither distilled nor restored_at (both excluded from DO UPDATE SET).
    db()
      .query(
        "INSERT INTO temporal_messages (id, project_id, session_id, role, content, tokens, distilled, created_at, metadata, restored_at) VALUES ('act', ?, 's', 'user', 'orig', 1, 0, ?, '{}', NULL)",
      )
      .run(pid, origin);
    applyRemoteTemporal({
      id: "act",
      project_id: pid,
      session_id: "s",
      role: "user",
      content: "new remote content",
      tokens: 1,
      metadata: "{}",
      created_at: origin,
    });
    const row = readTemporal("act");
    expect(row?.distilled).toBe(0); // NOT flipped active → archival
    expect(row?.restored_at).toBeNull(); // NOT stamped
    expect(
      db()
        .query("SELECT content FROM temporal_messages WHERE id = ?")
        .get("act"),
    ).toEqual({ content: "new remote content" });
    const queued = db()
      .query(
        "SELECT content_hash FROM temporal_embedding_queue WHERE message_id = ?",
      )
      .get("act") as { content_hash: string } | null;
    expect(queued?.content_hash).toBe(
      createHash("sha256").update("new remote content").digest("hex"),
    );
  });

  test("applyRemoteTemporal rejects an ID owned by another project or session atomically", () => {
    const projectA = ensureProject(`${PROJECT}/ownership-a`);
    const projectB = ensureProject(`${PROJECT}/ownership-b`);
    const messageId = "remote-ownership-collision";
    const vector = new Uint8Array([1, 2, 3, 4]);
    db()
      .query(
        `INSERT INTO temporal_messages
         (id, project_id, session_id, role, content, tokens, distilled, created_at, metadata, embedding)
         VALUES (?, ?, 'session-a', 'user', 'original content', 1, 0, ?, '{}', ?)`,
      )
      .run(messageId, projectA, now(), vector);
    db()
      .query(
        `INSERT INTO temporal_embedding_queue
         (message_id, content_hash, fingerprint, enqueued_at)
         VALUES (?, 'original-hash', 'original-fingerprint', 123)`,
      )
      .run(messageId);
    setSyncState("temporal_messages", messageId, {
      content_hash: "synced-hash",
      revision: 7,
      remote_updated_at: "2026-08-27T08:00:00.000Z",
    });
    const originalQueue = db()
      .query(
        "SELECT content_hash, fingerprint, enqueued_at FROM temporal_embedding_queue WHERE message_id = ?",
      )
      .get(messageId);
    const originalSyncState = getSyncState("temporal_messages", messageId);

    let error: unknown;
    try {
      applyRemoteTemporal({
        id: messageId,
        project_id: projectB,
        session_id: "session-b",
        role: "assistant",
        content: "attacker-controlled replacement",
        tokens: 99,
        metadata: '{"remote":true}',
        created_at: 789,
      });
    } catch (cause) {
      error = cause;
    }

    const current = db()
      .query(
        `SELECT project_id, session_id, role, content, tokens, created_at,
                metadata, embedding
         FROM temporal_messages WHERE id = ?`,
      )
      .get(messageId) as {
      project_id: string;
      session_id: string;
      role: string;
      content: string;
      tokens: number;
      created_at: number;
      metadata: string;
      embedding: Uint8Array | null;
    };
    expect.soft(error).toEqual(expect.any(Error));
    expect.soft(current).toMatchObject({
      project_id: projectA,
      session_id: "session-a",
      role: "user",
      content: "original content",
      tokens: 1,
      metadata: "{}",
    });
    const currentEmbedding = current.embedding;
    expect
      .soft(
        Array.from(
          currentEmbedding instanceof Uint8Array
            ? currentEmbedding
            : new Uint8Array(currentEmbedding ?? 0),
        ),
      )
      .toEqual(Array.from(vector));
    expect
      .soft(
        db()
          .query(
            "SELECT content_hash, fingerprint, enqueued_at FROM temporal_embedding_queue WHERE message_id = ?",
          )
          .get(messageId),
      )
      .toEqual(originalQueue);
    expect
      .soft(getSyncState("temporal_messages", messageId))
      .toEqual(originalSyncState);
  });
});

describe("prune is sync-invisible for Pro rows (#826/D)", () => {
  test("clears the pruned rows' sync_state and enqueues NO tombstone", () => {
    setProTier();
    enableSync();
    const old = now() - 200 * 24 * 60 * 60 * 1000; // 200 days old
    insertTemporal("t1", 1, old); // distilled + old → TTL-pruned
    insertDistillation("d1", ["t1"], { archived: 1, createdAt: old }); // archived + old → pruned
    setSyncState("temporal_messages", "t1", {
      content_hash: "h",
      revision: 0,
      remote_updated_at: null,
    });
    setSyncState("distillations", "d1", {
      content_hash: "h",
      revision: 0,
      remote_updated_at: null,
    });
    clearOutbox();

    temporal.prune({
      projectPath: PROJECT,
      retentionDays: 120,
      maxStorageMB: 1024,
    });

    // Rows are gone locally...
    expect(
      (
        db()
          .query("SELECT COUNT(*) AS n FROM temporal_messages WHERE id = 't1'")
          .get() as { n: number }
      ).n,
    ).toBe(0);
    // ...their dead sync_state is cleared...
    expect(getSyncState("temporal_messages", "t1")).toBeNull();
    expect(getSyncState("distillations", "d1")).toBeNull();
    // ...and NO tombstone was enqueued (sync-invisible prune).
    expect(outbox("temporal_messages", "delete")).toHaveLength(0);
    expect(outbox("distillations", "delete")).toHaveLength(0);
  });
});
