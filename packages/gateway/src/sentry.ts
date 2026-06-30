/**
 * Sentry scope enrichment and metrics helpers for the Lore gateway.
 *
 * All functions are no-ops when Sentry is not initialized (dev mode).
 * No request/response content is ever captured — we're a proxy sitting
 * in front of other people's projects and conversations.
 */

import * as Sentry from "@sentry/bun";
import { getInstanceId, embedding } from "@loreai/core";
import { createHash } from "node:crypto";
import { freemem } from "node:os";
import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";

// ---------------------------------------------------------------------------
// Scope enrichment
// ---------------------------------------------------------------------------

/**
 * Configure Sentry scope for a gateway request.
 *
 * Sets user identity, tags, and conversation ID. Called once per
 * conversation turn before forwarding to upstream. All values are
 * non-sensitive (hashed or random identifiers only).
 */
export function setSentryRequestContext(opts: {
  authFingerprint: string | null;
  sessionID: string;
  model: string;
  upstreamUrl: string;
  port: number;
  projectPath: string;
}): void {
  if (!Sentry.isInitialized()) return;

  // Installation identity — integrates with Sentry's unique users feature
  Sentry.setUser({ id: getInstanceId() });

  // Request-scoped tags (filterable in Sentry UI)
  if (opts.authFingerprint) {
    Sentry.setTag("auth_fingerprint", opts.authFingerprint);
  }
  Sentry.setTag("model", opts.model);
  Sentry.setTag("upstream_url", opts.upstreamUrl);
  Sentry.setTag("port", String(opts.port));

  // Hash project path — sensitive info for secret projects
  const projectHash = createHash("sha256")
    .update(opts.projectPath)
    .digest("hex")
    .slice(0, 16);
  Sentry.setTag("project_hash", projectHash);

  // Link to Sentry AI monitoring conversation tracking
  Sentry.setConversationId(opts.sessionID);
}

/**
 * Lighter-weight scope enrichment for passthrough and compaction handlers.
 *
 * Sets just the installation identity and basic tags so errors in these
 * paths are attributable, without the full conversation turn context.
 */
export function setSentryLightContext(opts: {
  model?: string;
  projectPath?: string;
}): void {
  if (!Sentry.isInitialized()) return;

  Sentry.setUser({ id: getInstanceId() });

  if (opts.model) {
    Sentry.setTag("model", opts.model);
  }
  if (opts.projectPath) {
    const projectHash = createHash("sha256")
      .update(opts.projectPath)
      .digest("hex")
      .slice(0, 16);
    Sentry.setTag("project_hash", projectHash);
  }
}

// ---------------------------------------------------------------------------
// Cache context
// ---------------------------------------------------------------------------

/**
 * Record cache metrics on the current Sentry scope after upstream response.
 */
export function setSentryCacheContext(usage: {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}): void {
  if (!Sentry.isInitialized()) return;

  const cacheRead = usage.cacheReadInputTokens ?? 0;
  const cacheWrite = usage.cacheCreationInputTokens ?? 0;
  const totalInput = usage.inputTokens + cacheRead + cacheWrite;
  const hitRate = totalInput > 0 ? cacheRead / totalInput : 0;

  Sentry.setContext("cache", {
    read_tokens: cacheRead,
    write_tokens: cacheWrite,
    uncached_tokens: usage.inputTokens,
    hit_rate: Math.round(hitRate * 1000) / 1000,
    is_cold: cacheRead === 0 && cacheWrite > 0,
  });
}

// ---------------------------------------------------------------------------
// gen_ai.chat span helpers
// ---------------------------------------------------------------------------

/** Usage fields from an Anthropic API response. */
export type AnthropicUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

/**
 * Set gen_ai.* usage attributes on a span from Anthropic API usage data.
 *
 * Shared by conversation turn spans, worker direct spans, and batch result
 * spans. Does NOT set input/output message content — privacy boundary.
 */
export function setGenAiUsageAttributes(
  span: Sentry.Span,
  usage: AnthropicUsage,
  responseModel?: string,
): void {
  if (responseModel) {
    span.setAttribute("gen_ai.response.model", responseModel);
  }
  span.setAttribute("gen_ai.usage.input_tokens", usage.input_tokens ?? 0);
  span.setAttribute("gen_ai.usage.output_tokens", usage.output_tokens ?? 0);
  if (usage.cache_read_input_tokens != null) {
    span.setAttribute(
      "gen_ai.usage.input_tokens.cached",
      usage.cache_read_input_tokens,
    );
  }
  if (usage.cache_creation_input_tokens != null) {
    span.setAttribute(
      "gen_ai.usage.input_tokens.cache_write",
      usage.cache_creation_input_tokens,
    );
  }
}

// ---------------------------------------------------------------------------
// Cache analytics span enrichment
// ---------------------------------------------------------------------------

import type { CacheTurnAnalysis } from "./translate/types.ts";

/**
 * Set cache analytics attributes on a gen_ai.chat span.
 *
 * Called after `analyzeCacheTurn()` returns — adds divergence diagnostics
 * and prefix match data so cache busting issues are visible in Sentry traces
 * without needing to grep server logs.
 *
 * For early divergences (< 5% prefix match), also includes short byte
 * snippets around the divergence point for forensic debugging.
 */
export function setCacheAnalyticsAttributes(
  span: Sentry.Span,
  analysis: CacheTurnAnalysis,
  bustCause: string,
  prevSnippet?: string,
  currSnippet?: string,
): void {
  span.setAttribute("lore.cache.turn", analysis.turn);
  span.setAttribute(
    "lore.cache.hit_rate",
    Math.round(analysis.cacheHitRate * 1000) / 1000,
  );
  span.setAttribute(
    "lore.cache.prefix_match",
    Math.round(analysis.prefixMatchPercent * 1000) / 1000,
  );
  span.setAttribute("lore.cache.divergence_point", analysis.divergencePoint);
  span.setAttribute("lore.cache.divergence_reason", analysis.divergenceReason);
  span.setAttribute("lore.cache.bust_cause", bustCause);
  // system[0] cache-alignment measurement (issue #791): is this a host-prompt
  // (system[0]) divergence, and does the changed span look relocatable?
  span.setAttribute("lore.cache.system0_bust", analysis.system0Bust);
  span.setAttribute("lore.cache.relocatable", analysis.relocatable);

  // Include diverging byte snippets for early divergences — these are from the
  // system prompt prefix (client env info), not user conversation content.
  if (prevSnippet) {
    span.setAttribute("lore.cache.divergence_prev_snippet", prevSnippet);
  }
  if (currSnippet) {
    span.setAttribute("lore.cache.divergence_curr_snippet", currSnippet);
  }
}

// ---------------------------------------------------------------------------
// Cache bust telemetry
// ---------------------------------------------------------------------------

/**
 * Emit cache-bust cause metrics for observability and cost analysis.
 *
 * Emits a counter per cause category and a distribution of cache-write
 * token counts, both tagged by cause and model. Enables identifying which
 * bust causes dominate and tracking improvements over time.
 */
export function emitCacheBustMetric(
  cause: string,
  writeTokens: number,
  model: string,
  /** issue #791: whether a system[0] divergence looked relocatable. */
  relocatable = false,
): void {
  if (!Sentry.isInitialized()) return;

  Sentry.metrics.count("lore.cache_bust", 1, {
    attributes: { cause, model, relocatable },
  });

  if (writeTokens > 0) {
    Sentry.metrics.distribution("lore.cache_bust_tokens", writeTokens, {
      attributes: { cause, model, relocatable },
      unit: "token",
    });
  }
}

// ---------------------------------------------------------------------------
// Cost estimation metrics
// ---------------------------------------------------------------------------

import { getModelEntry } from "./worker-model";

type ModelPricing = {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
};

const DEFAULT_PRICING: ModelPricing = {
  input: 3,
  output: 15,
  cache_read: 0.3,
  cache_write: 3.75,
};

/**
 * Look up pricing for a model from models.dev (cached, fetched at startup).
 * Falls back to sensible defaults if the fetch hasn't completed yet.
 */
async function getPricing(model: string): Promise<ModelPricing> {
  const entry = await getModelEntry(model);
  const input = entry.cost?.input ?? DEFAULT_PRICING.input;
  return {
    input,
    output: entry.cost?.output ?? DEFAULT_PRICING.output,
    cache_read: entry.cost?.cache_read ?? input * 0.1,
    cache_write: entry.cost?.cache_write ?? input * 1.25,
  };
}

/**
 * Emit a cost-estimate metric for an LLM call.
 *
 * Uses live pricing from models.dev (fetched at gateway startup, cached 1h).
 * Properly accounts for cache-read and cache-write pricing tiers, and
 * applies the 50% batch discount only to base input/output (not cache ops,
 * which are not discounted by the batch API).
 *
 * Token categories from Anthropic:
 *  - input_tokens: uncached input (base input price)
 *  - cache_read_input_tokens: served from prompt cache (0.1× input price)
 *  - cache_creation_input_tokens: written to prompt cache (1.25× input price)
 *  - output_tokens: generated output (output price)
 */
// ---------------------------------------------------------------------------
// Cache warming telemetry
// ---------------------------------------------------------------------------

import type { SessionState, WarmupResult } from "./translate/types";

/**
 * Emit metrics for a cache warmup attempt.
 *
 * Tracks warmup sent/hit/miss counts and estimated cost/savings for
 * ROI analysis. All metrics are tagged by model and TTL.
 */
export function emitWarmupMetric(
  state: SessionState,
  result: WarmupResult,
): void {
  if (!Sentry.isInitialized()) return;

  const model = state.lastUpstream?.model ?? "unknown";
  const ttl = state.resolvedConversationTTL ?? "5m";
  const attrs = { model, ttl };

  // Count every warmup sent
  Sentry.metrics.count("lore.cache_warmup.sent", 1, { attributes: attrs });

  if (
    result.ok &&
    result.cacheReadTokens > 0 &&
    result.cacheCreationTokens === 0
  ) {
    // Pure cache refresh — ideal outcome
    Sentry.metrics.count("lore.cache_warmup.refresh", 1, { attributes: attrs });
  } else if (
    result.ok &&
    result.cacheCreationTokens > 0 &&
    result.cacheReadTokens === 0
  ) {
    // Uncached warmup — circuit breaker material
    Sentry.metrics.count("lore.cache_warmup.uncached", 1, {
      attributes: attrs,
    });
  }

  // Emit warmup cost as a distribution (fire-and-forget)
  if (result.ok) {
    getPricing(model)
      .then((pricing) => {
        const readCost =
          (result.cacheReadTokens / 1_000_000) * pricing.cache_read;
        const writeCost =
          (result.cacheCreationTokens / 1_000_000) * pricing.cache_write;
        Sentry.metrics.distribution(
          "lore.cache_warmup.cost_usd",
          readCost + writeCost,
          {
            attributes: attrs,
            unit: "dollar",
          },
        );
      })
      .catch(() => {});
  }
}

/**
 * Emit a metric when a user returns after a warmup (confirmed save).
 */
export function emitWarmupHitMetric(model: string, ttl: string): void {
  if (!Sentry.isInitialized()) return;
  Sentry.metrics.count("lore.cache_warmup.hit", 1, {
    attributes: { model, ttl },
  });
}

/**
 * Emit a metric when the circuit breaker trips.
 */
export function emitWarmupCircuitBreakerMetric(): void {
  if (!Sentry.isInitialized()) return;
  Sentry.metrics.count("lore.cache_warmup.circuit_breaker_tripped", 1, {});
}

// ---------------------------------------------------------------------------
// LLM cost estimation
// ---------------------------------------------------------------------------

export function emitCostMetric(
  model: string,
  usage: AnthropicUsage,
  callType: "conversation" | "direct" | "batch",
  ttl?: "5m" | "1h",
): void {
  if (!Sentry.isInitialized()) return;

  // Fire-and-forget: pricing lookup is async but we don't want to block callers.
  // The models.dev data is cached after first fetch, so subsequent calls resolve
  // from memory without network I/O.
  getPricing(model)
    .then((pricing) => {
      // Batch discount (0.5×) applies to ALL token categories — input, output,
      // cache read, and cache write. These multipliers stack with TTL modifiers.
      const batchMultiplier = callType === "batch" ? 0.5 : 1.0;
      // Anthropic charges 2× cache_write for 1h TTL (stacks with batch discount)
      const cacheWriteRate =
        ttl === "1h" ? pricing.cache_write * 2 : pricing.cache_write;

      const uncachedInputCost =
        ((usage.input_tokens ?? 0) / 1_000_000) *
        pricing.input *
        batchMultiplier;
      const cacheReadCost =
        ((usage.cache_read_input_tokens ?? 0) / 1_000_000) *
        pricing.cache_read *
        batchMultiplier;
      const cacheWriteCost =
        ((usage.cache_creation_input_tokens ?? 0) / 1_000_000) *
        cacheWriteRate *
        batchMultiplier;
      const outputCost =
        ((usage.output_tokens ?? 0) / 1_000_000) *
        pricing.output *
        batchMultiplier;

      const totalCost =
        uncachedInputCost + cacheReadCost + cacheWriteCost + outputCost;

      Sentry.metrics.distribution("lore.llm_cost_usd", totalCost, {
        attributes: { model, call_type: callType },
        unit: "dollar",
      });
    })
    .catch(() => {
      // Silently ignore — cost metrics are best-effort, not critical path.
    });
}

// ---------------------------------------------------------------------------
// Session-level cost/savings aggregates
// ---------------------------------------------------------------------------

import {
  getSessionCosts,
  totalActualCost,
  totalWorkerCost,
  totalSavings,
} from "./cost-tracker";

/**
 * Emit session-level cost and savings metrics to Sentry.
 *
 * Called when a session goes idle (natural "session over" signal) and
 * captures the accumulated cost intelligence for alerting and dashboards.
 */
export function emitSessionCostMetrics(sessionID: string): void {
  if (!Sentry.isInitialized()) return;

  const costs = getSessionCosts(sessionID);
  if (!costs || costs.conversation.turns === 0) return;

  const actual = totalActualCost(costs);
  const worker = totalWorkerCost(costs);
  const saved = totalSavings(costs);
  const savingsPct = actual + saved > 0 ? (saved / (actual + saved)) * 100 : 0;

  Sentry.metrics.distribution("lore.session_cost_usd", actual, {
    unit: "dollar",
  });

  Sentry.metrics.distribution("lore.session_worker_cost_usd", worker, {
    unit: "dollar",
  });

  Sentry.metrics.distribution("lore.session_savings_usd", saved, {
    unit: "dollar",
  });

  Sentry.metrics.gauge("lore.session_savings_pct", savingsPct, {
    unit: "percent",
  });

  // Emit counterfactual breakdown
  if (costs.counterfactual.avoidedCompactions > 0) {
    Sentry.metrics.distribution(
      "lore.session_avoided_compactions",
      costs.counterfactual.avoidedCompactions,
    );
  }

  if (costs.batchSavings > 0) {
    Sentry.metrics.distribution(
      "lore.session_batch_savings_usd",
      costs.batchSavings,
      {
        unit: "dollar",
      },
    );
  }
}

// ---------------------------------------------------------------------------
// Curation metrics
// ---------------------------------------------------------------------------

/**
 * Emit curation result metrics to Sentry.
 *
 * Called after `curator.run()` or `curator.consolidate()` completes with
 * at least one operation. Tracks create/update/delete counts by trigger
 * source (in-flight background work vs. idle scheduler).
 */
export function emitCurationMetrics(result: {
  created: number;
  updated: number;
  deleted: number;
  trigger: "in-flight" | "idle" | "consolidation";
}): void {
  if (!Sentry.isInitialized()) return;
  const total = result.created + result.updated + result.deleted;
  if (total === 0) return;

  Sentry.metrics.distribution("lore.curator_ops", total, {
    attributes: { trigger: result.trigger },
  });
  if (result.created > 0) {
    Sentry.metrics.distribution("lore.curator_created", result.created, {
      attributes: { trigger: result.trigger },
    });
  }
  if (result.updated > 0) {
    Sentry.metrics.distribution("lore.curator_updated", result.updated, {
      attributes: { trigger: result.trigger },
    });
  }
  if (result.deleted > 0) {
    Sentry.metrics.distribution("lore.curator_deleted", result.deleted, {
      attributes: { trigger: result.trigger },
    });
  }
}

// ---------------------------------------------------------------------------
// Embedding worker OOM capture
// ---------------------------------------------------------------------------

/**
 * Wire core's embedding-failure hook to Sentry. Called once at startup. The
 * embedding worker's OOM backoff/latch events otherwise only hit stderr; this
 * surfaces them — fingerprinted, with memory context (free memory, RSS, the
 * cap before/after) — so a WASM-OOM thrash on a memory-constrained host is
 * visible instead of only inferable from a coincidental crash.
 */
export function setupEmbeddingFailureCapture(): void {
  embedding.setEmbeddingFailureHook((info: embedding.EmbeddingFailureInfo) => {
    if (!Sentry.isInitialized()) return;
    const isLatch = info.kind === "floor-latch";
    Sentry.captureMessage(
      isLatch
        ? "Embedding worker OOM: degraded to FTS-only at the token floor"
        : "Embedding worker OOM: backed off the token cap and respawned",
      {
        level: isLatch ? "error" : "warning",
        // One grouped issue per kind — not one per session/event.
        fingerprint: ["embedding-oom", info.kind],
        contexts: {
          embedding_oom: {
            kind: info.kind,
            cap_before: info.capBefore,
            cap_after: info.capAfter,
            batch_size: info.batchSize,
            longest_chars: info.longestChars,
            free_memory_bytes: info.freeMemBytes,
            rss_bytes: info.rssBytes,
          },
        },
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Read-path timing (#966 B — measure-before-offload)
// ---------------------------------------------------------------------------

import { setReadPathTimingHook, type ReadPathTiming } from "@loreai/core";

/**
 * Wire core's read-path timing hook to Sentry. Called once at startup. Emits a
 * distribution per `forSession` (per turn) / `recall` (per tool call) so we can
 * see — across all installs, incl. nightly — how much SYNCHRONOUS main-thread
 * time these hot read paths still cost now that the O(n) vector scan runs
 * off-thread (#966/#989). This is the data that decides whether further
 * offloading (FTS / hydration / scoring) is worth it. Never throws.
 */
export function setupReadPathTimingCapture(): void {
  setReadPathTimingHook((t: ReadPathTiming) => {
    if (!Sentry.isInitialized()) return;
    try {
      const attributes: Record<string, string> = { op: t.op };
      if (t.scope) attributes.scope = t.scope;
      Sentry.metrics.distribution("lore.readpath.total_ms", t.totalMs, {
        unit: "millisecond",
        attributes,
      });
      Sentry.metrics.distribution(
        "lore.readpath.sync_blocking_ms",
        t.syncBlockingMs,
        { unit: "millisecond", attributes },
      );
      Sentry.metrics.distribution("lore.readpath.awaited_ms", t.awaitedMs, {
        unit: "millisecond",
        attributes,
      });
      // #999: split the awaited bucket into embed vs vector-search so the next
      // telemetry pass can attribute the pathological awaited latency.
      Sentry.metrics.distribution("lore.readpath.embed_ms", t.embedMs, {
        unit: "millisecond",
        attributes,
      });
      Sentry.metrics.distribution(
        "lore.readpath.vector_search_ms",
        t.vectorSearchMs,
        { unit: "millisecond", attributes },
      );
      Sentry.metrics.distribution(
        "lore.readpath.candidates",
        t.candidateCount,
        { attributes },
      );
    } catch {
      // Telemetry must never break the read path.
    }
  });
}

// ---------------------------------------------------------------------------
// Bust-spiral alerting (#797)
// ---------------------------------------------------------------------------

import { setBustSpiralHook, type BustSpiralInfo } from "@loreai/core";

/**
 * Wire core's bust-spiral detection hook to Sentry. Called once at startup.
 *
 * The hook is triggered by core's `transform()` whenever a session accumulates
 * a sustained run of cache busts (`consecutiveBusts >= 2`). Cold-start
 * episodes (the first few turns of a freshly-tracked session) emit an
 * info-level breadcrumb; past the grace window, sustained busts fire a
 * high-severity Sentry alert (#797 — almost always a real caching bug we want
 * to investigate). Recovery (busts → 0) emits another info breadcrumb.
 *
 * One alert per (session, episode) — debounced via the per-session
 * `bustSpiralAlerted` flag in core, cleared on recovery.
 */
export function setupBustSpiralCapture(): void {
  setBustSpiralHook({
    onColdStart: (info: BustSpiralInfo) => {
      if (!Sentry.isInitialized()) return;
      Sentry.addBreadcrumb({
        category: "lore.cache.bust_spiral",
        level: "info",
        message:
          "Cold-start bust spiral observed (within grace window) — expected per #796/#804",
        data: info as unknown as Record<string, unknown>,
      });
    },
    onSpiral: (info: BustSpiralInfo) => {
      if (!Sentry.isInitialized()) return;
      Sentry.captureMessage(
        "Cache bust spiral past cold-start grace — investigate caching bug",
        {
          // High severity: a sustained cache-bust spiral in steady state is
          // almost always an upstream bug (#797). Aggregates as a Sentry
          // issue; not paging.
          level: "error",
          // One grouped issue per fingerprint, not per session/event.
          fingerprint: ["bust-spiral-past-grace"],
          contexts: {
            bust_spiral: info as unknown as Record<string, unknown>,
          },
        },
      );
    },
    onRecovered: (info: BustSpiralInfo) => {
      if (!Sentry.isInitialized()) return;
      Sentry.addBreadcrumb({
        category: "lore.cache.bust_spiral",
        level: "info",
        message: "Bust spiral recovered",
        data: info as unknown as Record<string, unknown>,
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Process resource gauge + event-loop lag (periodic, from the idle tick)
// ---------------------------------------------------------------------------

let eventLoopDelayHist: IntervalHistogram | null = null;

/**
 * Begin sampling event-loop delay. Cheap libuv-backed histogram; idempotent and
 * a no-op when Sentry is off. Called once when the idle scheduler starts.
 */
export function startResourceMonitor(): void {
  if (!Sentry.isInitialized() || eventLoopDelayHist) return;
  try {
    eventLoopDelayHist = monitorEventLoopDelay({ resolution: 20 });
    eventLoopDelayHist.enable();
  } catch {
    // perf_hooks/monitorEventLoopDelay unavailable on this runtime — skip the
    // loop-lag metric rather than break idle-scheduler startup.
    eventLoopDelayHist = null;
  }
}

/**
 * Emit a periodic process-resource gauge — RSS / heap / external / arrayBuffers
 * (bytes) and the event-loop-delay p99 (ms) since the previous emit. Called from
 * the idle scheduler tick (~30s). Never throws (telemetry must not break idle).
 */
export function emitResourceGauge(): void {
  if (!Sentry.isInitialized()) return;
  try {
    const mem = process.memoryUsage();
    Sentry.metrics.distribution("lore.process.rss_bytes", mem.rss, {
      unit: "byte",
    });
    Sentry.metrics.distribution("lore.process.heap_used_bytes", mem.heapUsed, {
      unit: "byte",
    });
    Sentry.metrics.distribution("lore.process.external_bytes", mem.external, {
      unit: "byte",
    });
    Sentry.metrics.distribution(
      "lore.process.array_buffers_bytes",
      mem.arrayBuffers,
      { unit: "byte" },
    );
    if (eventLoopDelayHist) {
      // percentile() returns nanoseconds; report milliseconds, then reset so
      // the next emit reflects only the elapsed interval.
      Sentry.metrics.distribution(
        "lore.event_loop.lag_p99_ms",
        eventLoopDelayHist.percentile(99) / 1e6,
        { unit: "millisecond" },
      );
      eventLoopDelayHist.reset();
    }
  } catch {
    // Telemetry must never break the idle loop.
  }
}

// ---------------------------------------------------------------------------
// Startup embedding-backfill span
// ---------------------------------------------------------------------------

/**
 * Wrap the one-shot startup embedding backfill in a Sentry span, recording how
 * much was embedded and the RSS delta across the pass (the backfill is the
 * prime suspect for startup memory growth). Falls back to running `run` plainly
 * when Sentry is off. Errors propagate to the caller's existing `.catch()`.
 */
export async function spanStartupBackfill(
  run: () => Promise<embedding.BackfillStats>,
): Promise<void> {
  if (!Sentry.isInitialized()) {
    await run();
    return;
  }
  const rssBefore = process.memoryUsage().rss;
  await Sentry.startSpan(
    { name: "lore.embedding.startup_backfill", op: "embedding.backfill" },
    async (span) => {
      const stats = await run();
      const rssAfter = process.memoryUsage().rss;
      span.setAttribute("knowledge_embedded", stats.knowledgeEmbedded);
      span.setAttribute("distillation_embedded", stats.distillationEmbedded);
      span.setAttribute("entity_embedded", stats.entityEmbedded);
      span.setAttribute("pending_knowledge", stats.pendingKnowledge);
      span.setAttribute("pending_distillations", stats.pendingDistillations);
      span.setAttribute(
        "knowledge_coverage",
        `${stats.knowledgeWithEmbedding}/${stats.knowledgeTotal}`,
      );
      span.setAttribute(
        "distillation_coverage",
        `${stats.distillationWithEmbedding}/${stats.distillationTotal}`,
      );
      span.setAttribute("rss_before_bytes", rssBefore);
      span.setAttribute("rss_after_bytes", rssAfter);
      span.setAttribute("rss_delta_bytes", rssAfter - rssBefore);
    },
  );
}

// ---------------------------------------------------------------------------
// Client-abort-under-pressure capture
// ---------------------------------------------------------------------------

/** Current event-loop-delay p99 in ms — a *peek* that does NOT reset the
 *  window (unlike emitResourceGauge). 0 when the monitor isn't running. */
export function getEventLoopLagP99Ms(): number {
  if (!eventLoopDelayHist) return 0;
  try {
    return eventLoopDelayHist.percentile(99) / 1e6;
  } catch {
    return 0;
  }
}

/** A client abort is only worth a Sentry event when it coincides with host
 *  pressure: a long in-flight time or a stalled event loop. Below these,
 *  disconnects are normal connection lifecycle and must not be captured. */
/** Event-loop p99 at/above this (ms) means the loop is stalled — swap/CPU
 *  pressure, the ConnectTimeout symptom. */
const ABORT_PRESSURE_LAG_MS = 1_000;
/** Free memory at/below this is critically low — the host is near swap/OOM
 *  (the embedding worker baseline alone is ~400 MB). Coarse floor; gates a
 *  telemetry event only, not behavior. */
const ABORT_PRESSURE_FREEMEM_BYTES = 512 * 1024 * 1024;

/**
 * True when the HOST is under pressure: the event loop is stalled OR free
 * memory is critically low. Deliberately based on host state, not request
 * duration — a long-lived stream cancelled on a healthy host is a normal abort,
 * not pressure (in-flight time is recorded as context, never as the gate). Pure
 * for unit testing.
 */
export function isAbortUnderPressure(
  lagP99Ms: number,
  freeMemBytes: number,
): boolean {
  return (
    lagP99Ms >= ABORT_PRESSURE_LAG_MS ||
    freeMemBytes <= ABORT_PRESSURE_FREEMEM_BYTES
  );
}

/**
 * Capture a client-abort event ONLY when it coincides with host pressure
 * (in-flight ≥ 10s OR event-loop p99 ≥ 1s), with memory + loop-lag context, so
 * client disconnects can be correlated with the embedding-OOM / swap stalls
 * that manifest upstream as ConnectTimeout. Normal aborts are dropped to avoid
 * Sentry noise. Gated on Sentry; never throws (called from request-path catch
 * blocks).
 */
export function captureClientAbortUnderPressure(ctx: {
  startMs: number;
  route: string;
  sessionID?: string;
}): void {
  // Whole body in try — even Sentry.isInitialized() must not throw out of a
  // request-path catch and turn a clean error response into a rejected promise.
  try {
    if (!Sentry.isInitialized()) return;
    const lagP99Ms = getEventLoopLagP99Ms();
    const freeMemBytes = freemem();
    if (!isAbortUnderPressure(lagP99Ms, freeMemBytes)) {
      return; // healthy host — a normal abort, not worth an event
    }
    const mem = process.memoryUsage();
    Sentry.captureMessage("Client abort under host pressure", {
      level: "warning",
      // One grouped issue per route, not one per disconnect.
      fingerprint: ["client-abort-under-pressure", ctx.route],
      contexts: {
        abort_pressure: {
          route: ctx.route,
          session_id: ctx.sessionID ?? "unknown",
          time_in_flight_ms: Date.now() - ctx.startMs,
          event_loop_lag_p99_ms: Math.round(lagP99Ms),
          rss_bytes: mem.rss,
          free_memory_bytes: freeMemBytes,
        },
      },
    });
  } catch {
    // Telemetry must never break the request path.
  }
}
