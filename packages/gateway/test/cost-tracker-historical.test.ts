import { describe, test, expect, beforeEach } from "vitest";
import { db, ensureProject, saveSessionCosts } from "@loreai/core";
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

  // --- #983 + #1214: the batch estimate is per-model AND client-metered-window ---
  // The counterfactual host compacts once at the model's auto-compact trigger,
  // then every (trigger − 30K post-compaction) tokens thereafter. The batch path
  // has no per-session `context-1m` signal, so it meters against the conservative
  // client default (200K clamp) — the window Claude Code uses unless a session
  // opted into long context. A 600K-token session therefore yields:
  //   • 1M-window model, no long-context signal → clamped to 200K → trigger 167K
  //       → 1 + ⌊433K/137K⌋ ⇒ 4   (#1214: was 0 under the old real-1M assumption)
  //   • 200K-window model → trigger 178808 → 1 + ⌊421192/148808⌋  ⇒ 3
  //   • no usable metadata → trigger 167K (AUTOCOMPACT_THRESHOLD) ⇒ 4
  // The pre-#983 hardcoded 167K constant would report 4 for every one; the
  // pre-#1214 real-1M assumption would wrongly report 0 for the 1M model — the
  // MiniMax-M3-via-Claude-Code under-count this fix closes.

  test("batch estimate: a 1M model with no long-context signal is metered at 200K (#1214)", () => {
    const pid = ensureProject("/test/cost-historical/1m", "hist-1m");
    const sid = "sess-1m";
    const now = Date.now();
    // 600K tokens, model = Sonnet 4 (real 1M window). With no context-1m signal
    // the batch path clamps to the 200K client-metered window (trigger 167K), so
    // 600K ⇒ 1 + ⌊(600K−167K)/137K⌋ = 4.
    insertMsg(
      pid,
      sid,
      "assistant",
      600_000,
      now,
      JSON.stringify({
        modelID: "claude-sonnet-4-20250514",
        providerID: "anthropic",
      }),
    );

    const s = computeHistoricalEstimates().sessions.find(
      (x) => x.sessionId === sid,
    );
    expect(s).toBeDefined();
    // #1214: reverting the client-metered clamp in the batch path lets the real
    // 1M window (967K trigger) back in, dropping this to 0 — kills that mutation.
    expect(s?.avoidedCompactions).toBe(4);
  });

  test("batch estimate: a 200K-window model over its trigger avoids several", () => {
    const pid = ensureProject("/test/cost-historical/200k", "hist-200k");
    const sid = "sess-200k";
    const now = Date.now();
    // 600K tokens, model = 3.5 Sonnet (200K window ⇒ 178808 trigger).
    insertMsg(
      pid,
      sid,
      "assistant",
      600_000,
      now,
      JSON.stringify({
        modelID: "claude-3-5-sonnet-20241022",
        providerID: "anthropic",
      }),
    );

    const s = computeHistoricalEstimates().sessions.find(
      (x) => x.sessionId === sid,
    );
    expect(s).toBeDefined();
    expect(s?.avoidedCompactions).toBe(3);
  });

  test("accumulates persisted warmup COST alongside savings (net visibility)", () => {
    const pid = ensureProject("/test/cost-historical/warmupnet", "hist-wn");
    const sid = "sess-warmup-net";
    const now = Date.now();
    // A message so the session appears in the rollup iteration.
    insertMsg(pid, sid, "assistant", 100, now, null);
    // Persisted live-session snapshot: the warmup SAVED $0.20 but COST $0.50 —
    // net-negative. Both must flow into totals so the summary/UI can show net.
    saveSessionCosts(sid, {
      conversationCost: 1.0,
      workerCost: 0.5, // includes the warmup cost bucket
      conversationTurns: 4,
      cacheReadTokens: 1000,
      cacheWriteTokens: 500,
      warmupSavings: 0.2,
      warmupCost: 0.5,
      warmupHits: 2,
      ttlSavings: 0,
      ttlHits: 0,
      batchSavings: 0,
      avoidedCompactions: 0,
      avoidedCompactionCost: 0,
    });

    const totals = computeHistoricalEstimates().totals;
    expect(totals.warmupSavings).toBeCloseTo(0.2);
    expect(totals.warmupCost).toBeCloseTo(0.5);
    // The net the summary line / dashboard reports is savings − cost (negative
    // here — the whole point of surfacing the paired cost).
    expect(totals.warmupSavings - totals.warmupCost).toBeCloseTo(-0.3);
  });

  test("batch estimate: a session with no usable model metadata keeps the 167K trigger", () => {
    const pid = ensureProject("/test/cost-historical/nomodel", "hist-nomodel");
    const sid = "sess-nomodel";
    const now = Date.now();
    // 600K tokens, but no extractable model (null metadata). The threshold must
    // fall back to AUTOCOMPACT_THRESHOLD (167K) — NOT the pricing-default
    // DEFAULT_ESTIMATION_MODEL (a 1M-window model), which would drop the count
    // to 0 and shift historical dashboards ~7× for untracked sessions.
    insertMsg(pid, sid, "assistant", 600_000, now, null);

    const s = computeHistoricalEstimates().sessions.find(
      (x) => x.sessionId === sid,
    );
    expect(s).toBeDefined();
    expect(s?.avoidedCompactions).toBe(4);
  });
});
