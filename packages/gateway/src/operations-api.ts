/**
 * Read-only warming and cost-intelligence snapshots plus the small set of
 * management mutations exposed by the UI-08 Operations screens.
 *
 * All metrics come from the gateway's existing cache-warmer and cost-tracker
 * state. These handlers never create sessions, perform model calls, or alter
 * request routing. The per-session control only changes the normal warmup
 * flags and marks that live session dirty for the existing persistence path.
 */
import {
  canonicalProjectId,
  data,
  isHostedMode,
  loadParentChildMap,
  projectId,
} from "@loreai/core";
import { createHash } from "node:crypto";

import { decodeRequestBody, HttpRequestBodyTooLargeError } from "./http-body";
import { errorResponse, jsonResponse } from "./management-access";
import {
  computeWarmingSnapshot,
  createHistogram,
  getCircuitBreakerSummary,
  getGlobalHistogramsSnapshot,
  getWarmingEnabledOverride,
  isWarmingEnabled,
  HISTOGRAM_BINS,
  resetCircuitBreaker,
  setWarmingEnabled,
  applyWarmingMode,
} from "./cache-warmer";
import {
  computeDailyCosts,
  computeHistoricalEstimates,
  costWithoutLore,
  getAllSessionCosts,
  getCostRate,
  getDailyBudget,
  getDailyBudgetEnvOverride,
  getDailySpend,
  setDailyBudget,
  totalActualCost,
  totalSavings,
  totalWorkerCost,
} from "./cost-tracker";
import { getActiveSessions } from "./pipeline";

const MAX_OPERATIONS_BODY_BYTES = 8 * 1024;

type WarmingMode = "keep" | "stop" | "auto";

function jsonObject(body: unknown): Record<string, unknown> | null {
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

async function readJsonBody(req: Request): Promise<unknown> {
  try {
    return JSON.parse(
      await decodeRequestBody(req, req.signal, {
        compressedBytes: MAX_OPERATIONS_BODY_BYTES,
        decompressedBytes: MAX_OPERATIONS_BODY_BYTES,
      }),
    );
  } catch (error) {
    if (error instanceof HttpRequestBodyTooLargeError) {
      return errorResponse(
        413,
        "invalid_request",
        `Request body exceeds ${MAX_OPERATIONS_BODY_BYTES} bytes`,
      );
    }
    return errorResponse(400, "invalid_request", "Invalid JSON body");
  }
}

function requestIsHosted(configuredHostedMode = false): boolean {
  return configuredHostedMode || isHostedMode();
}

function safeUpstreamRoute(value: string | undefined): string {
  if (!value) return "unknown";
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "unknown";
    const routeId = createHash("sha256")
      .update(url.pathname)
      .digest("hex")
      .slice(0, 8);
    return `${url.origin} · route ${routeId}`;
  } catch {
    return "unknown";
  }
}

function hostedWriteError(
  action: string,
  configuredHostedMode = false,
): Response | null {
  return requestIsHosted(configuredHostedMode)
    ? errorResponse(
        403,
        "forbidden",
        `${action} is not available in hosted mode.`,
      )
    : null;
}

type DashboardRow = {
  session_id: string;
  project_id: string | null;
  project_name: string | null;
  project_path: string | null;
  turns: number;
  parent_session_id: string | null;
  is_subagent: boolean;
  actual_cost: number;
  net_savings: number;
  cost_without_lore: number;
  cache_hit_pct: number | null;
  conversation_cost: number;
  worker_cost: number;
  workers: {
    distillation: { cost: number; calls: number };
    curation: { cost: number; calls: number };
    compaction: { cost: number; calls: number };
    recall: { cost: number; calls: number };
    warmup: { cost: number; calls: number };
  };
  warming: null | {
    enabled: boolean;
    should_warm: boolean;
    phase: "initial" | "continuation" | "none";
    reason: string | null;
    ttl: "5m" | "1h" | null;
    idle_ms: number;
    p_returns: number;
    total_warmups: number;
    warmup_hits: number;
    disabled: boolean;
    force_keep_warm: boolean;
    circuit_breaker: {
      tripped: boolean;
      failures: number;
      max_failures: number;
      tripped_at: number;
    };
  };
};

function dashboardRows(
  histogramSnapshot = getGlobalHistogramsSnapshot(),
): DashboardRow[] {
  const projects = data.listProjects();
  const projectByPath = new Map(
    projects.map((project) => [project.path, project] as const),
  );
  const projectById = new Map(
    projects.map((project) => [project.id, project] as const),
  );
  const projectForPath = (path: string) => {
    const pathProject = projectByPath.get(path);
    const id = pathProject?.id ?? projectId(path);
    if (!id) return pathProject;
    const canonicalId = canonicalProjectId(id, { committed: true });
    return (
      (canonicalId ? projectById.get(canonicalId) : undefined) ??
      projectById.get(id) ??
      pathProject
    );
  };
  const liveSessions = getActiveSessions();
  const costs = getAllSessionCosts();
  const parentByChild = loadParentChildMap();
  const warmingEnabled = isWarmingEnabled();
  const now = Date.now();
  const snapshots = new Map<
    string,
    ReturnType<typeof computeWarmingSnapshot>
  >();
  for (const [id, state] of liveSessions) {
    const project = projectForPath(state.projectPath);
    const canonicalPid = project
      ? canonicalProjectId(project.id, { committed: true })
      : undefined;
    const globalHistogram = canonicalPid
      ? histogramSnapshot.get(canonicalPid)
      : undefined;
    snapshots.set(
      id,
      computeWarmingSnapshot(
        state,
        now,
        warmingEnabled,
        globalHistogram ?? createHistogram(),
      ),
    );
  }
  const ids = new Set([...costs.keys(), ...liveSessions.keys()]);

  return [...ids].map((sessionId) => {
    const state = liveSessions.get(sessionId);
    const cost = costs.get(sessionId);
    const snapshot = snapshots.get(sessionId);
    const project = state ? projectForPath(state.projectPath) : undefined;
    const c = cost?.conversation;
    const totalInput = c
      ? c.inputTokens + c.cacheReadTokens + c.cacheWriteTokens
      : 0;
    const warm = state?.warmup;
    return {
      session_id: sessionId,
      project_id: project?.id ?? null,
      project_name: project?.name || project?.path || null,
      project_path: state?.projectPath ?? project?.path ?? null,
      turns: c?.turns ?? (snapshot ? Math.floor(snapshot.messageCount / 2) : 0),
      parent_session_id:
        state?.parentSessionId ?? parentByChild.get(sessionId) ?? null,
      is_subagent: state?.isSubagent ?? parentByChild.has(sessionId),
      actual_cost: cost ? totalActualCost(cost) : 0,
      net_savings: cost ? totalSavings(cost) : 0,
      cost_without_lore: cost ? costWithoutLore(cost) : 0,
      cache_hit_pct:
        totalInput > 0 && c ? (c.cacheReadTokens / totalInput) * 100 : null,
      conversation_cost: c?.cost ?? 0,
      worker_cost: cost ? totalWorkerCost(cost) : 0,
      workers: {
        distillation: cost?.workers.distillation ?? { cost: 0, calls: 0 },
        curation: cost?.workers.curation ?? { cost: 0, calls: 0 },
        compaction: cost?.workers.compaction ?? { cost: 0, calls: 0 },
        recall: cost?.workers.recall ?? { cost: 0, calls: 0 },
        warmup: cost?.workers.warmup ?? { cost: 0, calls: 0 },
      },
      warming: snapshot
        ? {
            enabled: warmingEnabled,
            should_warm: snapshot.shouldWarmNow,
            phase: snapshot.warmingPhase,
            reason: snapshot.notWarmingReason,
            ttl: snapshot.ttl ?? null,
            idle_ms: snapshot.idleMs,
            p_returns: snapshot.pReturns,
            total_warmups: warm?.totalWarmups ?? 0,
            warmup_hits: warm?.warmupHits ?? 0,
            disabled: warm?.disabled === true || warm?.userStopped === true,
            force_keep_warm: warm?.forceKeepWarm ?? false,
            circuit_breaker: {
              tripped: snapshot.circuitBreaker.tripped,
              failures: snapshot.circuitBreaker.failures,
              max_failures: snapshot.circuitBreaker.maxFailures,
              tripped_at: snapshot.circuitBreaker.trippedAt,
            },
          }
        : null,
    };
  });
}

/** `GET /api/v1/warming` — global state, live session decisions and histograms. */
export function handleGetWarming(configuredHostedMode = false): Response {
  const histogramSnapshot = getGlobalHistogramsSnapshot();
  const rows = dashboardRows(histogramSnapshot);
  const activeRows = rows.filter((row) => row.warming !== null);
  const totalWarmups = activeRows.reduce(
    (sum, row) => sum + (row.warming?.total_warmups ?? 0),
    0,
  );
  const totalHits = activeRows.reduce(
    (sum, row) => sum + (row.warming?.warmup_hits ?? 0),
    0,
  );
  const breaker = getCircuitBreakerSummary();
  const projects = new Map(data.listProjects().map((p) => [p.id, p]));
  const circuitEntries = breaker.entries.map((entry) => {
    const [sessionId, model, upstream] = entry.bucket.split("\x1f");
    return {
      session_id: sessionId ?? "",
      model: model ?? "unknown",
      upstream: safeUpstreamRoute(upstream),
      tripped_at: entry.trippedAt,
    };
  });
  const histograms = [...histogramSnapshot].map(([projectId, histogram]) => ({
    project_id: projectId,
    project_name:
      projects.get(projectId)?.name || projects.get(projectId)?.path || null,
    total: histogram.total,
    counts: histogram.counts,
    bins_ms: [...HISTOGRAM_BINS],
  }));
  const envForced = !!process.env.LORE_WARMING_ENABLED?.trim();
  return jsonResponse({
    enabled: isWarmingEnabled(),
    override: getWarmingEnabledOverride(),
    env_forced: envForced,
    can_edit: !requestIsHosted(configuredHostedMode),
    can_toggle: !requestIsHosted(configuredHostedMode) && !envForced,
    summary: {
      live_sessions: activeRows.length,
      warming_now: activeRows.filter((row) => row.warming?.should_warm).length,
      disabled_sessions: activeRows.filter((row) => row.warming?.disabled)
        .length,
      total_warmups: totalWarmups,
      total_hits: totalHits,
      hit_rate: totalWarmups > 0 ? totalHits / totalWarmups : null,
      tripped_buckets: breaker.trippedCount,
    },
    circuit_breaker: {
      tripped_count: breaker.trippedCount,
      entries: circuitEntries,
    },
    sessions: rows,
    histograms,
  });
}

/** `PATCH /api/v1/warming/settings` — persist the global runtime override. */
export async function handleSetWarmingEnabled(
  req: Request,
  configuredHostedMode = false,
): Promise<Response> {
  const blocked = hostedWriteError(
    "Cache warming controls",
    configuredHostedMode,
  );
  if (blocked) return blocked;
  if (process.env.LORE_WARMING_ENABLED?.trim()) {
    return errorResponse(
      409,
      "conflict",
      "Cache warming is controlled by LORE_WARMING_ENABLED.",
    );
  }
  const parsed = await readJsonBody(req);
  if (parsed instanceof Response) return parsed;
  const body = jsonObject(parsed);
  if (
    !body ||
    Object.keys(body).length !== 1 ||
    typeof body.enabled !== "boolean"
  ) {
    return errorResponse(
      400,
      "invalid_request",
      "Body must be { enabled: boolean }.",
    );
  }
  setWarmingEnabled(body.enabled);
  return jsonResponse({
    enabled: isWarmingEnabled(),
    override: getWarmingEnabledOverride(),
  });
}

/** `POST /api/v1/warming/circuit-breaker/reset` — clear every tripped bucket. */
export function handleResetCircuitBreaker(
  configuredHostedMode = false,
): Response {
  const blocked = hostedWriteError(
    "Circuit-breaker controls",
    configuredHostedMode,
  );
  if (blocked) return blocked;
  resetCircuitBreaker();
  return jsonResponse({
    reset: true,
    tripped_count: getCircuitBreakerSummary().trippedCount,
  });
}

/** `PATCH /api/v1/warming/sessions/:sessionId/mode`. */
export async function handleSetSessionWarmingMode(
  req: Request,
  sessionId: string,
  configuredHostedMode = false,
): Promise<Response> {
  const blocked = hostedWriteError(
    "Per-session warming controls",
    configuredHostedMode,
  );
  if (blocked) return blocked;
  const parsed = await readJsonBody(req);
  if (parsed instanceof Response) return parsed;
  const body = jsonObject(parsed);
  if (
    !body ||
    Object.keys(body).length !== 1 ||
    (body.mode !== "keep" && body.mode !== "stop" && body.mode !== "auto")
  ) {
    return errorResponse(
      400,
      "invalid_request",
      "Body must be { mode: 'keep' | 'stop' | 'auto' }.",
    );
  }
  const mode: WarmingMode = body.mode;
  const state = [...getActiveSessions().values()].find(
    (session) => session.sessionID === sessionId,
  );
  if (!state)
    return errorResponse(404, "not_found", "Active session not found.");
  applyWarmingMode(state, mode);
  return jsonResponse({
    session_id: sessionId,
    mode,
    disabled: state.warmup?.disabled ?? false,
    force_keep_warm: state.warmup?.forceKeepWarm ?? false,
  });
}

/** `GET /api/v1/costs` — live totals, historical estimates and daily spend. */
export function handleGetCosts(configuredHostedMode = false): Response {
  const costs = getAllSessionCosts();
  const liveRows = dashboardRows();
  const live = {
    session_count: costs.size,
    spend: 0,
    conversation_spend: 0,
    worker_cost: 0,
    net_savings: 0,
    cost_without_lore: 0,
    avoided_compactions: 0,
    avoided_compaction_cost: 0,
    warmup_savings: 0,
    ttl_savings: 0,
    batch_savings: 0,
    cache_read_tokens: 0,
    input_tokens: 0,
    turns: 0,
    workers: {
      distillation: { cost: 0, calls: 0 },
      curation: { cost: 0, calls: 0 },
      compaction: { cost: 0, calls: 0 },
      recall: { cost: 0, calls: 0 },
      warmup: { cost: 0, calls: 0 },
    },
    throttle: { events: 0, total_delay_ms: 0 },
  };
  for (const session of costs.values()) {
    live.spend += totalActualCost(session);
    live.conversation_spend += session.conversation.cost;
    live.worker_cost += totalWorkerCost(session);
    live.net_savings += totalSavings(session);
    live.cost_without_lore += costWithoutLore(session);
    live.avoided_compactions += session.counterfactual.avoidedCompactions;
    live.avoided_compaction_cost +=
      session.counterfactual.avoidedCompactionCost;
    live.warmup_savings += session.counterfactual.warmupSavings;
    live.ttl_savings += session.counterfactual.ttlSavings;
    live.batch_savings += session.batchSavings;
    live.cache_read_tokens += session.conversation.cacheReadTokens;
    live.input_tokens +=
      session.conversation.inputTokens +
      session.conversation.cacheReadTokens +
      session.conversation.cacheWriteTokens;
    live.turns += session.conversation.turns;
    for (const task of [
      "distillation",
      "curation",
      "compaction",
      "recall",
      "warmup",
    ] as const) {
      live.workers[task].cost += session.workers[task].cost;
      live.workers[task].calls += session.workers[task].calls;
    }
    live.throttle.events += session.throttle.events;
    live.throttle.total_delay_ms += session.throttle.totalDelayMs;
  }

  const historicalRaw = computeHistoricalEstimates(data.listProjects()).totals;
  const workerCost = live.worker_cost + historicalRaw.totalWorkerCost;
  const grossSavings =
    live.warmup_savings +
    historicalRaw.warmupSavings +
    live.ttl_savings +
    historicalRaw.ttlSavings +
    live.batch_savings +
    historicalRaw.batchSavings +
    live.avoided_compaction_cost +
    historicalRaw.avoidedCompactionCost;
  const combinedNetSavings = grossSavings - workerCost;
  const combinedSpend =
    live.spend +
    historicalRaw.persistedConversationCost +
    historicalRaw.totalWorkerCost;
  const { date, spend } = getDailySpend();
  const budgetOverride = getDailyBudgetEnvOverride();
  const historical = {
    distillation_cost: historicalRaw.distillationCost,
    distillation_calls: historicalRaw.distillationCalls,
    distillation_batch_calls: historicalRaw.distillationBatchCalls,
    distillation_direct_calls: historicalRaw.distillationDirectCalls,
    avoided_compactions: historicalRaw.avoidedCompactions,
    avoided_compaction_cost: historicalRaw.avoidedCompactionCost,
    warmup_savings: historicalRaw.warmupSavings,
    warmup_cost: historicalRaw.warmupCost,
    warmup_hits: historicalRaw.warmupHits,
    ttl_savings: historicalRaw.ttlSavings,
    ttl_hits: historicalRaw.ttlHits,
    batch_savings: historicalRaw.batchSavings,
    session_count: historicalRaw.sessionCount,
    message_count: historicalRaw.messageCount,
    total_worker_cost: historicalRaw.totalWorkerCost,
    persisted_conversation_cost: historicalRaw.persistedConversationCost,
    worker_breakdown: historicalRaw.workerBreakdown,
  };

  return jsonResponse({
    live,
    totals: {
      combined_session_count: costs.size + historicalRaw.sessionCount,
      spend: combinedSpend,
      worker_cost: workerCost,
      net_savings: combinedNetSavings,
      cost_without_lore: combinedSpend + combinedNetSavings,
      historical_conversation_spend: historicalRaw.persistedConversationCost,
      avoided_compactions:
        live.avoided_compactions + historicalRaw.avoidedCompactions,
    },
    historical,
    daily: {
      entries: computeDailyCosts(14),
      budget: {
        amount: getDailyBudget(),
        spend,
        date,
        rate: getCostRate(),
        env_override: budgetOverride,
        can_edit: !budgetOverride && !requestIsHosted(configuredHostedMode),
      },
    },
    sessions: liveRows,
  });
}

/** `PATCH /api/v1/costs/budget` — set an amount, or pass 0 to disable. */
export async function handleSetDailyBudget(
  req: Request,
  configuredHostedMode = false,
): Promise<Response> {
  const blocked = hostedWriteError(
    "Daily budget controls",
    configuredHostedMode,
  );
  if (blocked) return blocked;
  if (getDailyBudgetEnvOverride() !== null) {
    return errorResponse(
      409,
      "conflict",
      "The daily budget is controlled by LORE_DAILY_BUDGET.",
    );
  }
  const parsed = await readJsonBody(req);
  if (parsed instanceof Response) return parsed;
  const body = jsonObject(parsed);
  if (
    !body ||
    Object.keys(body).length !== 1 ||
    typeof body.amount !== "number" ||
    !Number.isFinite(body.amount) ||
    body.amount < 0 ||
    body.amount > 1_000_000
  ) {
    return errorResponse(
      400,
      "invalid_request",
      "Body must be { amount: a finite number between 0 and 1000000 }.",
    );
  }
  setDailyBudget(body.amount);
  return jsonResponse({
    amount: getDailyBudget(),
    disabled: body.amount === 0,
  });
}
