import { describe, test, expect, beforeEach } from "vitest";
import { db, ensureProject } from "@loreai/core";
import {
  computeHistoricalEstimates,
  invalidateHistoricalCache,
} from "../src/cost-tracker";

// computeHistoricalEstimates() is the single production consumer of the
// materialized session_rollup table (#981). It reads one row per
// (project_id, session_id) and derives the /ui/costs "intelligence" estimate:
// session/message counts, the model (from the earliest assistant message's
// metadata), and distillation overhead split by call_type. These tests pin the
// field mapping from a SessionRollupSummary row onto the HistoricalEstimates
// output — the rollup rewiring is otherwise only validated by typecheck.

let seq = 0;

function insertMsg(
  pid: string,
  sid: string,
  role: "user" | "assistant",
  tokens: number,
  createdAt: number,
  metadata: string | null,
): void {
  db()
    .query(
      `INSERT INTO temporal_messages
         (id, project_id, session_id, role, content, tokens, distilled, created_at, metadata)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    )
    .run(
      `hm-${++seq}`,
      pid,
      sid,
      role,
      `c-${seq}`,
      tokens,
      createdAt,
      metadata,
    );
}

function insertDistill(
  pid: string,
  sid: string,
  tokenCount: number,
  callType: "batch" | "direct",
  createdAt: number,
): void {
  db()
    .query(
      `INSERT INTO distillations
         (id, project_id, session_id, narrative, facts, observations, source_ids,
          generation, token_count, call_type, created_at, archived)
       VALUES (?, ?, ?, '', '', 'obs', '[]', 0, ?, ?, ?, 0)`,
    )
    .run(`hd-${++seq}`, pid, sid, tokenCount, callType, createdAt);
}

describe("computeHistoricalEstimates (session_rollup read path #981)", () => {
  beforeEach(() => {
    // The core test harness creates ONE DB per file (not per test), so rows
    // accumulate across tests; computeHistoricalEstimates aggregates EVERY
    // session in the DB. Wipe the source + rollup tables so each test's totals
    // are deterministic. Deleting the source rows fires the rollup DELETE
    // triggers; the explicit session_rollup wipe is belt-and-suspenders.
    db().exec(
      "DELETE FROM temporal_messages; DELETE FROM distillations; DELETE FROM session_rollup;",
    );
    // The estimate is memoized for 5 min in module state — clear it or a later
    // test would read the previous test's result.
    invalidateHistoricalCache();
  });

  test("aggregates one session from the rollup: counts, model, distill split", () => {
    const pid = ensureProject("/test/cost-historical/a", "hist-a");
    const sid = "hist-sess-a";
    const now = Date.now();
    const model = "claude-opus-4-20250514";

    // 3 messages; the earliest assistant carries the model metadata.
    insertMsg(pid, sid, "user", 100, now, null);
    insertMsg(
      pid,
      sid,
      "assistant",
      200,
      now + 1,
      JSON.stringify({ modelID: model, providerID: "anthropic" }),
    );
    insertMsg(pid, sid, "user", 150, now + 2, null);

    // 1 batch + 1 direct distillation.
    insertDistill(pid, sid, 5000, "batch", now + 3);
    insertDistill(pid, sid, 3000, "direct", now + 4);

    const est = computeHistoricalEstimates();

    expect(est.totals.sessionCount).toBe(1);
    expect(est.totals.messageCount).toBe(3);
    expect(est.totals.distillationCalls).toBe(2);
    expect(est.totals.distillationBatchCalls).toBe(1);
    expect(est.totals.distillationDirectCalls).toBe(1);
    expect(est.totals.distillationCost).toBeGreaterThan(0);

    expect(est.sessions).toHaveLength(1);
    const s = est.sessions[0];
    expect(s.sessionId).toBe(sid);
    expect(s.projectId).toBe(pid);
    expect(s.messageCount).toBe(3);
    expect(s.model).toBe(model);
    expect(s.distillationBatchCalls).toBe(1);
    expect(s.distillationDirectCalls).toBe(1);
  });

  test("distill cost honors the batch discount (more batch tokens ⇒ cheaper)", () => {
    const pid = ensureProject("/test/cost-historical/b", "hist-b");
    const now = Date.now();

    // Same total distill tokens (8000) in two sessions, but one is all-batch
    // (50% priced) and the other all-direct. Each session needs ≥1 message to
    // appear in the rollup read (message_count > 0 filter).
    insertMsg(pid, "sess-batch", "assistant", 10, now, null);
    insertDistill(pid, "sess-batch", 8000, "batch", now + 1);

    insertMsg(pid, "sess-direct", "assistant", 10, now, null);
    insertDistill(pid, "sess-direct", 8000, "direct", now + 1);

    const est = computeHistoricalEstimates();
    expect(est.totals.sessionCount).toBe(2);

    const batch = est.sessions.find((s) => s.sessionId === "sess-batch");
    const direct = est.sessions.find((s) => s.sessionId === "sess-direct");
    expect(batch).toBeDefined();
    expect(direct).toBeDefined();
    if (!batch || !direct) throw new Error("seeded sessions missing");
    // Batch tokens are priced at 0.5×, so the all-batch session is strictly
    // cheaper than the all-direct one with identical token volume.
    expect(batch.distillationCost).toBeGreaterThan(0);
    expect(batch.distillationCost).toBeCloseTo(direct.distillationCost * 0.5);
  });

  test("excludes distill-only sessions and respects the 90-day scan window", () => {
    const pid = ensureProject("/test/cost-historical/c", "hist-c");
    const now = Date.now();

    // (1) Distill-only session: no messages ⇒ message_count = 0 ⇒ excluded.
    insertDistill(pid, "sess-distill-only", 1000, "direct", now);

    // (2) Stale session older than HISTORICAL_SCAN_DAYS (90d) ⇒ excluded.
    const old = now - 91 * 86_400_000;
    insertMsg(pid, "sess-old", "assistant", 50, old, null);

    // (3) In-window session with messages ⇒ included.
    insertMsg(pid, "sess-live", "assistant", 50, now, null);

    const est = computeHistoricalEstimates();
    expect(est.totals.sessionCount).toBe(1);
    expect(est.sessions[0].sessionId).toBe("sess-live");
  });
});
