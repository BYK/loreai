/**
 * D (#826) — Pro-tier backup (distillations + the distillation-referenced subset
 * of temporal_messages) push-side correctness: the distillation-fanout capture,
 * tier-gating, subset-aware seed, the append-only no-tombstone reconcile, and the
 * sync-invisible prune. The pull/restore side (residency exemption, encrypted
 * round-trip) is covered by the Tier-2 integration suite (D-4).
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  db,
  deleteTeamConfig,
  ensureProject,
  reinstallSyncCapture,
} from "../src/db";
import {
  assertSyncInvariants,
  enableSync,
  getSyncState,
  readOutbox,
  reconcile,
  seedOutbox,
  setSyncState,
} from "../src/sync-data";
import * as temporal from "../src/temporal";

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
