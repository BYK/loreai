/** Contracts for UI-08 cache-warming controls and cost intelligence. */
import "./config";
import { type } from "arktype";

import { nonEmptyString, nonNegInt } from "./primitives";

const taskCost = type({ cost: "number", calls: nonNegInt });

export const operationsWorkers = type({
  distillation: taskCost,
  curation: taskCost,
  compaction: taskCost,
  recall: taskCost,
  warmup: taskCost,
});

const sessionCircuitBreaker = type({
  tripped: "boolean",
  failures: nonNegInt,
  max_failures: nonNegInt,
  tripped_at: "number",
});

const sessionWarming = type({
  enabled: "boolean",
  should_warm: "boolean",
  phase: "'initial' | 'continuation' | 'none'",
  reason: "string | null",
  ttl: "'5m' | '1h' | null",
  idle_ms: "number",
  p_returns: "number",
  total_warmups: nonNegInt,
  warmup_hits: nonNegInt,
  disabled: "boolean",
  "user_stopped?": "boolean",
  force_keep_warm: "boolean",
  circuit_breaker: sessionCircuitBreaker,
});

export const operationsSession = type({
  session_id: nonEmptyString,
  project_id: "string | null",
  project_name: "string | null",
  project_path: "string | null",
  turns: nonNegInt,
  parent_session_id: "string | null",
  is_subagent: "boolean",
  actual_cost: "number",
  net_savings: "number",
  cost_without_lore: "number",
  cache_hit_pct: "number | null",
  conversation_cost: "number",
  worker_cost: "number",
  workers: operationsWorkers,
  warming: sessionWarming.or("null"),
});

export type OperationsSession = typeof operationsSession.infer;

export const warmingSnapshot = type({
  enabled: "boolean",
  override: "boolean | null",
  env_forced: "boolean",
  can_edit: "boolean",
  can_toggle: "boolean",
  summary: {
    live_sessions: nonNegInt,
    warming_now: nonNegInt,
    disabled_sessions: nonNegInt,
    total_warmups: nonNegInt,
    total_hits: nonNegInt,
    hit_rate: "number | null",
    tripped_buckets: nonNegInt,
  },
  circuit_breaker: {
    tripped_count: nonNegInt,
    entries: type({
      session_id: "string",
      model: "string",
      upstream: "string",
      tripped_at: "number",
    }).array(),
  },
  sessions: operationsSession.array(),
  histograms: type({
    project_id: nonEmptyString,
    project_name: "string | null",
    total: nonNegInt,
    counts: nonNegInt.array(),
    bins_ms: nonNegInt.array(),
  }).array(),
});

export type WarmingSnapshot = typeof warmingSnapshot.infer;

export const warmingSettingsResult = type({
  enabled: "boolean",
  override: "boolean | null",
});

export const circuitBreakerResetResult = type({
  reset: "boolean",
  tripped_count: nonNegInt,
});

export const sessionWarmingModeResult = type({
  session_id: nonEmptyString,
  mode: "'keep' | 'stop' | 'auto'",
  disabled: "boolean",
  force_keep_warm: "boolean",
});

export const liveCosts = type({
  session_count: nonNegInt,
  spend: "number",
  conversation_spend: "number",
  worker_cost: "number",
  net_savings: "number",
  cost_without_lore: "number",
  avoided_compactions: nonNegInt,
  avoided_compaction_cost: "number",
  warmup_savings: "number",
  ttl_savings: "number",
  batch_savings: "number",
  cache_read_tokens: nonNegInt,
  input_tokens: nonNegInt,
  turns: nonNegInt,
  workers: operationsWorkers,
  throttle: { events: nonNegInt, total_delay_ms: "number" },
});

export type LiveCosts = typeof liveCosts.infer;

const workerBreakdown = type({
  distillation: taskCost,
  curation: taskCost,
  compaction: taskCost,
  recall: taskCost,
});

export const historicalCosts = type({
  distillation_cost: "number",
  distillation_calls: nonNegInt,
  distillation_batch_calls: nonNegInt,
  distillation_direct_calls: nonNegInt,
  avoided_compactions: nonNegInt,
  avoided_compaction_cost: "number",
  warmup_savings: "number",
  warmup_cost: "number",
  warmup_hits: nonNegInt,
  ttl_savings: "number",
  ttl_hits: nonNegInt,
  batch_savings: "number",
  session_count: nonNegInt,
  message_count: nonNegInt,
  total_worker_cost: "number",
  persisted_conversation_cost: "number",
  worker_breakdown: workerBreakdown,
});

export const costsSnapshot = type({
  live: liveCosts,
  totals: {
    combined_session_count: nonNegInt,
    spend: "number",
    worker_cost: "number",
    net_savings: "number",
    cost_without_lore: "number",
    historical_conversation_spend: "number",
    avoided_compactions: nonNegInt,
  },
  historical: historicalCosts,
  daily: {
    entries: type({ date: "string", cost: "number" }).array(),
    budget: {
      amount: "number",
      spend: "number",
      date: "string",
      rate: "number",
      env_override: "string | null",
      can_edit: "boolean",
    },
  },
  sessions: operationsSession.array(),
});

export type CostsSnapshot = typeof costsSnapshot.infer;

export const dailyBudgetResult = type({
  amount: "number",
  disabled: "boolean",
});
