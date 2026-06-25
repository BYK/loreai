import { describe, test, expect } from "vitest";
import {
  db,
  ensureProject,
  rebuildDirtySessionRollups,
  rebuildAllSessionRollups,
} from "../src/db";
import * as data from "../src/data";

// session_rollup (#981) is a materialized per-(project_id, session_id) cache of
// the /ui/costs aggregates, maintained incrementally by triggers on
// temporal_messages and distillations. The central correctness property: the
// incrementally-maintained rollup MUST equal a full GROUP BY recompute from
// source across ANY sequence of inserts / re-store edits / deletes — including
// deletes of an extreme row (first/last message, earliest assistant), which the
// triggers defer to a lazy dirty-rebuild.

// ---- low-level source mutators (fire the triggers directly) -----------------

let msgSeq = 0;
let distSeq = 0;

function insertMsg(
  pid: string,
  sid: string,
  role: "user" | "assistant",
  tokens: number,
  createdAt: number,
  metadata: string | null,
): string {
  const id = `srm-${++msgSeq}`;
  db()
    .query(
      `INSERT INTO temporal_messages
         (id, project_id, session_id, role, content, tokens, distilled, created_at, metadata)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    )
    .run(id, pid, sid, role, `content-${id}`, tokens, createdAt, metadata);
  return id;
}

function editMsg(id: string, tokens: number, metadata: string | null): void {
  // Mirrors temporal.store()'s re-store UPDATE (SET content, tokens, metadata).
  db()
    .query(
      "UPDATE temporal_messages SET content = ?, tokens = ?, metadata = ? WHERE id = ?",
    )
    .run(`edited-${id}`, tokens, metadata, id);
}

function deleteMsg(id: string): void {
  db().query("DELETE FROM temporal_messages WHERE id = ?").run(id);
}

function insertDistill(
  pid: string,
  sid: string,
  tokenCount: number,
  callType: "batch" | "direct",
  createdAt: number,
): string {
  const id = `srd-${++distSeq}`;
  db()
    .query(
      `INSERT INTO distillations
         (id, project_id, session_id, narrative, facts, observations, source_ids,
          generation, token_count, call_type, created_at, archived)
       VALUES (?, ?, ?, '', '', 'obs', '[]', 0, ?, ?, ?, 0)`,
    )
    .run(id, pid, sid, tokenCount, callType, createdAt);
  return id;
}

function deleteDistill(id: string): void {
  db().query("DELETE FROM distillations WHERE id = ?").run(id);
}

// ---- canonical per-session row (the thing both sides must agree on) ---------

type RollupRow = {
  message_count: number;
  token_sum: number;
  first_message_at: number | null;
  last_message_at: number | null;
  first_assistant_metadata: string | null;
  distill_calls: number;
  distill_batch_calls: number;
  distill_token_sum: number;
  distill_batch_token_sum: number;
};

/** Full GROUP BY recompute from source for one project — the reference oracle. */
function referenceRollups(pid: string): Map<string, RollupRow> {
  const out = new Map<string, RollupRow>();
  const get = (sid: string): RollupRow => {
    let r = out.get(sid);
    if (!r) {
      r = {
        message_count: 0,
        token_sum: 0,
        first_message_at: null,
        last_message_at: null,
        first_assistant_metadata: null,
        distill_calls: 0,
        distill_batch_calls: 0,
        distill_token_sum: 0,
        distill_batch_token_sum: 0,
      };
      out.set(sid, r);
    }
    return r;
  };

  for (const m of db()
    .query(
      `SELECT session_id, COUNT(*) AS c, COALESCE(SUM(tokens),0) AS toks,
              MIN(created_at) AS first_at, MAX(created_at) AS last_at
         FROM temporal_messages WHERE project_id = ? GROUP BY session_id`,
    )
    .all(pid) as Array<{
    session_id: string;
    c: number;
    toks: number;
    first_at: number;
    last_at: number;
  }>) {
    const r = get(m.session_id);
    r.message_count = m.c;
    r.token_sum = m.toks;
    r.first_message_at = m.first_at;
    r.last_message_at = m.last_at;
  }

  // Earliest assistant: tie-break (created_at ASC, rowid ASC) — must match the
  // trigger / recompute / full-rebuild tie-break exactly.
  for (const fa of db()
    .query(
      `SELECT session_id, metadata FROM (
         SELECT session_id, metadata,
                ROW_NUMBER() OVER (
                  PARTITION BY session_id ORDER BY created_at ASC, rowid ASC
                ) AS rn
           FROM temporal_messages WHERE project_id = ? AND role = 'assistant'
       ) WHERE rn = 1`,
    )
    .all(pid) as Array<{ session_id: string; metadata: string | null }>) {
    get(fa.session_id).first_assistant_metadata = fa.metadata;
  }

  for (const d of db()
    .query(
      `SELECT session_id, COUNT(*) AS calls,
              COALESCE(SUM(CASE WHEN call_type='batch' THEN 1 ELSE 0 END),0) AS bc,
              COALESCE(SUM(token_count),0) AS tt,
              COALESCE(SUM(CASE WHEN call_type='batch' THEN token_count ELSE 0 END),0) AS bt
         FROM distillations WHERE project_id = ? GROUP BY session_id`,
    )
    .all(pid) as Array<{
    session_id: string;
    calls: number;
    bc: number;
    tt: number;
    bt: number;
  }>) {
    const r = get(d.session_id);
    r.distill_calls = d.calls;
    r.distill_batch_calls = d.bc;
    r.distill_token_sum = d.tt;
    r.distill_batch_token_sum = d.bt;
  }

  return out;
}

/** Read the materialized rollup rows for one project. */
function materializedRollups(pid: string): Map<string, RollupRow> {
  const out = new Map<string, RollupRow>();
  for (const r of db()
    .query(
      `SELECT session_id, message_count, token_sum, first_message_at, last_message_at,
              first_assistant_metadata, distill_calls, distill_batch_calls,
              distill_token_sum, distill_batch_token_sum
         FROM session_rollup WHERE project_id = ?`,
    )
    .all(pid) as Array<RollupRow & { session_id: string }>) {
    const { session_id, ...rest } = r;
    out.set(session_id, rest);
  }
  return out;
}

/** Assert the materialized table equals the recompute, after resolving dirty. */
function assertConsistent(pid: string): void {
  rebuildDirtySessionRollups(db());
  const ref = referenceRollups(pid);
  const got = materializedRollups(pid);
  const keys = new Set([...ref.keys(), ...got.keys()]);
  for (const sid of keys) {
    expect(got.get(sid), `rollup row for ${sid}`).toEqual(ref.get(sid));
  }
}

// ---- deterministic RNG ------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("session_rollup", () => {
  describe("property: incremental == full recompute", () => {
    for (const seed of [1, 7, 42, 1337, 90210]) {
      test(`random op sequence (seed ${seed})`, () => {
        const pid = ensureProject(`/test/session-rollup/prop-${seed}`);
        const rand = mulberry32(seed);
        const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];
        const sids = ["s-a", "s-b", "s-c"];
        // A small created_at range FORCES ties so the tie-break is exercised.
        const baseTime = 1_700_000_000_000;
        const liveMsgs: string[] = [];
        const liveDistills: string[] = [];

        for (let step = 0; step < 120; step++) {
          const op = rand();
          if (op < 0.42) {
            const role = rand() < 0.5 ? "assistant" : "user";
            liveMsgs.push(
              insertMsg(
                pid,
                pick(sids),
                role,
                Math.floor(rand() * 500),
                baseTime + Math.floor(rand() * 6) * 1000,
                `meta-${msgSeq + 1}-${role}`,
              ),
            );
          } else if (op < 0.6 && liveMsgs.length) {
            editMsg(
              pick(liveMsgs),
              Math.floor(rand() * 500),
              `edited-meta-${Math.floor(rand() * 1000)}`,
            );
          } else if (op < 0.78 && liveMsgs.length) {
            const idx = Math.floor(rand() * liveMsgs.length);
            deleteMsg(liveMsgs[idx]);
            liveMsgs.splice(idx, 1);
          } else if (op < 0.92) {
            liveDistills.push(
              insertDistill(
                pid,
                pick(sids),
                Math.floor(rand() * 2000),
                rand() < 0.5 ? "batch" : "direct",
                baseTime + Math.floor(rand() * 6) * 1000,
              ),
            );
          } else if (liveDistills.length) {
            const idx = Math.floor(rand() * liveDistills.length);
            deleteDistill(liveDistills[idx]);
            liveDistills.splice(idx, 1);
          }

          // Check consistency periodically (and at the end).
          if (step % 17 === 0) assertConsistent(pid);
        }
        assertConsistent(pid);
      });
    }
  });

  describe("targeted edge cases", () => {
    test("delete earliest assistant marks dirty and rebuild restores metadata", () => {
      const pid = ensureProject("/test/session-rollup/earliest-assistant");
      const sid = "s1";
      insertMsg(pid, sid, "user", 10, 1000, "u0");
      const a1 = insertMsg(pid, sid, "assistant", 20, 1100, "first-assistant");
      insertMsg(pid, sid, "assistant", 30, 1200, "second-assistant");

      let row = db()
        .query(
          "SELECT first_assistant_metadata, dirty FROM session_rollup WHERE project_id=? AND session_id=?",
        )
        .get(pid, sid) as { first_assistant_metadata: string; dirty: number };
      expect(row.first_assistant_metadata).toBe("first-assistant");
      expect(row.dirty).toBe(0);

      deleteMsg(a1);
      row = db()
        .query(
          "SELECT first_assistant_metadata, dirty FROM session_rollup WHERE project_id=? AND session_id=?",
        )
        .get(pid, sid) as { first_assistant_metadata: string; dirty: number };
      expect(row.dirty).toBe(1); // deferred recompute

      rebuildDirtySessionRollups(db());
      row = db()
        .query(
          "SELECT first_assistant_metadata, dirty FROM session_rollup WHERE project_id=? AND session_id=?",
        )
        .get(pid, sid) as { first_assistant_metadata: string; dirty: number };
      expect(row.first_assistant_metadata).toBe("second-assistant");
      expect(row.dirty).toBe(0);
      assertConsistent(pid);
    });

    test("delete MIN/MAX message recomputes first/last_message_at", () => {
      const pid = ensureProject("/test/session-rollup/minmax");
      const sid = "s1";
      const lo = insertMsg(pid, sid, "user", 5, 100, null);
      insertMsg(pid, sid, "user", 5, 200, null);
      const hi = insertMsg(pid, sid, "user", 5, 300, null);

      deleteMsg(lo);
      deleteMsg(hi);
      rebuildDirtySessionRollups(db());
      const row = db()
        .query(
          "SELECT first_message_at, last_message_at FROM session_rollup WHERE project_id=? AND session_id=?",
        )
        .get(pid, sid) as { first_message_at: number; last_message_at: number };
      expect(row.first_message_at).toBe(200);
      expect(row.last_message_at).toBe(200);
      assertConsistent(pid);
    });

    test("a single rebuild resolves many sessions dirtied at once", () => {
      // Mirrors a bulk prune/clear: many sessions get an extreme deleted in one
      // burst, so all are flagged dirty before any rebuild runs. The batched
      // rebuild (one transaction) must resolve every one of them.
      const pid = ensureProject("/test/session-rollup/batch-dirty");
      const N = 12;
      for (let i = 0; i < N; i++) {
        const sid = `s${i}`;
        // earliest assistant + a later message, then delete the earliest
        // assistant → defers a recompute (dirty=1) without touching the others.
        const a = insertMsg(pid, sid, "assistant", 10, 100 + i, `a-${i}`);
        insertMsg(pid, sid, "assistant", 20, 1000 + i, `keep-${i}`);
        deleteMsg(a);
      }
      const dirtyCount = (
        db()
          .query(
            "SELECT COUNT(*) AS c FROM session_rollup WHERE project_id=? AND dirty=1",
          )
          .get(pid) as { c: number }
      ).c;
      expect(dirtyCount).toBe(N); // all dirty, none rebuilt yet

      rebuildDirtySessionRollups(db());

      // No dirty rows remain and every session matches a full recompute.
      expect(
        (
          db()
            .query(
              "SELECT COUNT(*) AS c FROM session_rollup WHERE project_id=? AND dirty=1",
            )
            .get(pid) as { c: number }
        ).c,
      ).toBe(0);
      const got = materializedRollups(pid);
      const ref = referenceRollups(pid);
      expect(got.size).toBe(N);
      for (const [sid, row] of ref)
        expect(got.get(sid), `rollup row for ${sid}`).toEqual(row);
    });

    test("dirty rebuild is safe inside an existing transaction", () => {
      // The rebuild uses a SAVEPOINT (not BEGIN), so a future caller that
      // invokes it from within an open transaction must not crash with
      // "cannot start a transaction within a transaction".
      const pid = ensureProject("/test/session-rollup/nested-dirty");
      const sid = "s1";
      const a = insertMsg(pid, sid, "assistant", 10, 100, "first");
      insertMsg(pid, sid, "assistant", 20, 200, "second");
      deleteMsg(a); // earliest assistant deleted → session is dirty

      db().exec("BEGIN");
      expect(() => rebuildDirtySessionRollups(db())).not.toThrow();
      db().exec("COMMIT");

      const row = db()
        .query(
          "SELECT first_assistant_metadata, dirty FROM session_rollup WHERE project_id=? AND session_id=?",
        )
        .get(pid, sid) as { first_assistant_metadata: string; dirty: number };
      expect(row.first_assistant_metadata).toBe("second");
      expect(row.dirty).toBe(0);
    });

    test("full rebuild is safe (and atomic) inside an existing transaction", () => {
      const pid = ensureProject("/test/session-rollup/nested-all");
      const sid = "s1";
      insertMsg(pid, sid, "assistant", 10, 100, "a");
      insertDistill(pid, sid, 100, "batch", 150);

      db().exec("BEGIN");
      expect(() => rebuildAllSessionRollups(db())).not.toThrow();
      db().exec("COMMIT");

      assertConsistent(pid);
    });

    test("re-store changes token_sum by the delta only", () => {
      const pid = ensureProject("/test/session-rollup/restore");
      const sid = "s1";
      const m = insertMsg(pid, sid, "user", 100, 100, "m0");
      insertMsg(pid, sid, "user", 50, 200, "m1");
      const before = db()
        .query(
          "SELECT token_sum FROM session_rollup WHERE project_id=? AND session_id=?",
        )
        .get(pid, sid) as { token_sum: number };
      expect(before.token_sum).toBe(150);
      editMsg(m, 400, "m0-edited");
      const after = db()
        .query(
          "SELECT token_sum FROM session_rollup WHERE project_id=? AND session_id=?",
        )
        .get(pid, sid) as { token_sum: number };
      expect(after.token_sum).toBe(450); // 150 - 100 + 400
      assertConsistent(pid);
    });

    test("re-store of the earliest-assistant row refreshes its metadata", () => {
      const pid = ensureProject("/test/session-rollup/restore-assistant");
      const sid = "s1";
      const a = insertMsg(pid, sid, "assistant", 10, 100, "orig");
      insertMsg(pid, sid, "assistant", 10, 200, "later");
      editMsg(a, 10, "updated");
      const row = db()
        .query(
          "SELECT first_assistant_metadata FROM session_rollup WHERE project_id=? AND session_id=?",
        )
        .get(pid, sid) as { first_assistant_metadata: string };
      expect(row.first_assistant_metadata).toBe("updated");
      assertConsistent(pid);
    });

    test("tie at equal created_at picks the smaller rowid (insertion order)", () => {
      const pid = ensureProject("/test/session-rollup/tie");
      const sid = "s1";
      insertMsg(pid, sid, "assistant", 10, 500, "earlier-rowid");
      insertMsg(pid, sid, "assistant", 10, 500, "later-rowid");
      const row = db()
        .query(
          "SELECT first_assistant_metadata FROM session_rollup WHERE project_id=? AND session_id=?",
        )
        .get(pid, sid) as { first_assistant_metadata: string };
      expect(row.first_assistant_metadata).toBe("earlier-rowid");
      assertConsistent(pid);
    });

    test("removing all rows deletes the rollup row", () => {
      const pid = ensureProject("/test/session-rollup/empty");
      const sid = "s1";
      const m1 = insertMsg(pid, sid, "user", 10, 100, null);
      const m2 = insertMsg(pid, sid, "assistant", 10, 200, "a");
      const d1 = insertDistill(pid, sid, 100, "batch", 150);
      deleteMsg(m1);
      deleteMsg(m2);
      // Distillation still present → row kept.
      expect(
        db()
          .query(
            "SELECT 1 FROM session_rollup WHERE project_id=? AND session_id=?",
          )
          .get(pid, sid),
      ).toBeTruthy();
      deleteDistill(d1);
      // Now nothing left → row removed.
      expect(
        db()
          .query(
            "SELECT 1 FROM session_rollup WHERE project_id=? AND session_id=?",
          )
          .get(pid, sid),
      ).toBeFalsy();
      assertConsistent(pid);
    });

    test("distill-only session is excluded from listSessionRollups", () => {
      const pid = ensureProject("/test/session-rollup/distill-only");
      ensureProject("/test/session-rollup/distill-only"); // idempotent
      const withMsg = "s-msg";
      const distillOnly = "s-distill-only";
      insertMsg(pid, withMsg, "assistant", 10, 1_700_000_500_000, "m");
      insertDistill(pid, distillOnly, 100, "batch", 1_700_000_500_000);

      // The distill-only row exists in the table…
      expect(
        db()
          .query(
            "SELECT 1 FROM session_rollup WHERE project_id=? AND session_id=?",
          )
          .get(pid, distillOnly),
      ).toBeTruthy();
      // …but listSessionRollups (message_count>0 filter) skips it.
      const listed = data
        .listSessionRollups({ sinceMs: 0 })
        .filter((r) => r.project_id === pid)
        .map((r) => r.session_id);
      expect(listed).toContain(withMsg);
      expect(listed).not.toContain(distillOnly);
      assertConsistent(pid);
    });
  });

  describe("UPDATE trigger is scoped to content/tokens/metadata", () => {
    test("a `distilled` flag flip does not change token_sum", () => {
      const pid = ensureProject("/test/session-rollup/update-scope");
      const sid = "s1";
      const m = insertMsg(pid, sid, "user", 100, 100, null);
      db()
        .query("UPDATE temporal_messages SET distilled = 1 WHERE id = ?")
        .run(m);
      const row = db()
        .query(
          "SELECT token_sum, message_count FROM session_rollup WHERE project_id=? AND session_id=?",
        )
        .get(pid, sid) as { token_sum: number; message_count: number };
      expect(row.token_sum).toBe(100);
      expect(row.message_count).toBe(1);
      assertConsistent(pid);
    });
  });

  describe("rebuild path reconstructs from source", () => {
    test("rebuildAllSessionRollups repairs a corrupted table", () => {
      const pid = ensureProject("/test/session-rollup/rebuild");
      insertMsg(pid, "s1", "assistant", 10, 100, "a1");
      insertMsg(pid, "s1", "user", 20, 200, null);
      insertMsg(pid, "s2", "assistant", 30, 300, "a2");
      insertDistill(pid, "s1", 500, "batch", 150);

      // Corrupt every numeric aggregate.
      db()
        .query(
          "UPDATE session_rollup SET token_sum = 999999, message_count = 0, distill_calls = 77 WHERE project_id = ?",
        )
        .run(pid);

      rebuildAllSessionRollups(db());
      assertConsistent(pid);
    });
  });

  describe("project moves re-point rollup rows", () => {
    test("moveSessions carries the rollup to the target project", () => {
      const from = ensureProject("/test/session-rollup/move-from");
      const toPath = "/test/session-rollup/move-to";
      const to = ensureProject(toPath);
      const sid = "move-s1";
      insertMsg(from, sid, "assistant", 40, 100, "model-meta");
      insertMsg(from, sid, "user", 60, 200, null);
      insertDistill(from, sid, 300, "direct", 150);

      data.moveSessions([sid], from, toPath, { includeChildren: false });

      // Source no longer holds the rollup row; target does, with totals intact.
      expect(
        db()
          .query(
            "SELECT 1 FROM session_rollup WHERE project_id=? AND session_id=?",
          )
          .get(from, sid),
      ).toBeFalsy();
      const moved = db()
        .query(
          "SELECT message_count, token_sum, distill_calls FROM session_rollup WHERE project_id=? AND session_id=?",
        )
        .get(to, sid) as {
        message_count: number;
        token_sum: number;
        distill_calls: number;
      };
      expect(moved).toEqual({
        message_count: 2,
        token_sum: 100,
        distill_calls: 1,
      });
      assertConsistent(from);
      assertConsistent(to);
    });
  });

  describe("read cost is independent of temporal_messages size", () => {
    test("listSessionRollups query plan does not scan temporal_messages", () => {
      const plan = (
        db()
          .query(
            `EXPLAIN QUERY PLAN
             SELECT sr.project_id, p.path, sr.session_id, sr.message_count,
                    sr.first_message_at, sr.last_message_at, sr.token_sum
               FROM session_rollup sr
               JOIN projects p ON p.id = sr.project_id
              WHERE sr.message_count > 0 AND sr.last_message_at >= ?
              ORDER BY sr.last_message_at DESC
              LIMIT ?`,
          )
          .all(0, 100) as Array<{ detail: string }>
      )
        .map((r) => r.detail)
        .join(" | ");
      expect(plan).toContain("session_rollup");
      expect(plan).not.toMatch(/temporal_messages/);
    });
  });
});
