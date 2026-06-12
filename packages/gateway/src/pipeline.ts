/**
 * Core request processing pipeline for the Lore gateway.
 *
 * Orchestrates the full flow for every request:
 *   session identification → LTM injection → gradient transform →
 *   upstream forwarding → response accumulation → calibration →
 *   temporal storage → background work scheduling.
 *
 * Three request classes are handled:
 *  1. Compaction requests → intercepted, never forwarded upstream.
 *  2. Meta requests (title gen, summaries, etc.) → forwarded transparently, no Lore processing.
 *  3. Normal conversation turns → full pipeline.
 */
import type { LoreMessageWithParts, LLMClient } from "@loreai/core";
import {
  load,
  config as loreConfig,
  ensureProject,
  projectId,
  projectGitRemote,
  mergeProjectInternal,
  isUnattributedProjectPath,
  temporal,
  ltm,
  entities,
  distillation,
  curator,
  log,
  transform,
  setModelLimits,
  setLtmTokens,
  getLtmBudget,
  getPreferenceLtmBudget,
  setMaxLayer0Tokens,
  setForceMinLayer,
  computeLayer0Cap,
  setCachePricing,
  distillLimiter,
  curatorLimiter,
  recordCacheUsage,
  exportDedupDecisions,
  importDedupDecisions,
  calibrate,
  getLastTransformedCount,
  getLastTransformEstimate,
  onIdleResume,
  consumeCameOutOfIdle,
  needsUrgentDistillation,
  getConsecutiveBusts,
  effectiveMetaThreshold as computeMetaThreshold,
  formatKnowledge,
  shouldImportLoreFile,
  importLoreFile,
  loreFileExists,
  shouldImport,
  importFromFile,
  LORE_FILE,
  latReader,
  embedding,
  saveSessionTracking,
  loadSessionTracking,
  loadHeaderSessionIndex,
  isHostedMode,
  enableHostedMode,
  importLoreFileAs,
  resolveWorkspaces,
} from "@loreai/core";

import type {
  GatewayRequest,
  GatewayResponse,
  GatewayMessage,
  GatewayContentBlock,
  GatewayToolUseBlock,
  GatewayToolResultBlock,
  SessionState,
  UpstreamSnapshot,
} from "./translate/types";
import {
  applyUpstreamExtraHeaders,
  blocksToText,
  extractJSONFromSSE,
  forwardClientHeaders,
  ZERO_USAGE,
} from "./translate/types";
import type { GatewayConfig } from "./config";
import {
  getProjectPath,
  extractGitRemoteHeader,
  extractProjectHeader,
  resolveUpstreamRoute,
  extractUpstreamUrlHeader,
  extractProviderHeader,
  resolveProviderRoute,
  unattributedBucketPath,
  type ProjectPathResult,
} from "./config";
import {
  generateSessionID,
  fingerprintMessages,
  MESSAGE_COUNT_PROXIMITY_THRESHOLD,
  KNOWN_SESSION_HEADERS,
  extractKnownSessionHeader,
  learnHeaders,
  findRotationPredecessor,
} from "./session";
import {
  detectCompactionRequest,
  isStructuralCompaction,
  isMetaRequest,
  LORE_AGENT_HEADER,
  extractPreviousSummary,
  buildCompactionResponse,
  assembleOfflineCompaction,
  scaleUsageForClient,
} from "./compaction";
import {
  buildAnthropicRequest,
  buildAnthropicNonStreamResponse,
  parseAnthropicResponseJSON,
  type AnthropicCacheOptions,
} from "./translate/anthropic";
import {
  buildOpenAIUpstreamRequest,
  buildOpenAIResponse,
} from "./translate/openai";
import {
  buildOpenAIResponsesUpstreamRequest,
  buildOpenAIResponsesResponse,
  parseOpenAIResponsesRequest,
} from "./translate/openai-responses";
import {
  accumulateResponsesSSEStream,
  translateAnthropicStreamToResponses,
} from "./stream/openai-responses";
import { translateAnthropicStreamToOpenAI } from "./stream/openai";
import {
  createStreamAccumulator,
  createRecallAwareAccumulator,
  parseSSEStream,
  buildSSETextResponse,
  buildSSEToolUseResponse,
  buildKeepaliveCompactionStream,
  formatSSEEvent,
  type StreamAccumulator,
  type RecallAwareAccumulator,
} from "./stream/anthropic";
import {
  gatewayMessagesToLore,
  updateAssistantMessageTokens,
  resolveToolResults,
} from "./temporal-adapter";
import { createGatewayLLMClient } from "./llm-adapter";
import { createBatchLLMClient } from "./batch-queue";
import {
  runBackground,
  resetBackgroundLimiter,
  isBackgroundPaused,
} from "./background-limiter";
import {
  extractAuth,
  authFingerprint,
  setLastSeenAuth,
  setSessionAuth,
  resolveAuth,
  isAuthStale,
  type AuthCredential,
} from "./auth";
import type { UpstreamInterceptor } from "./recorder";
import { startIdleScheduler, buildIdleWorkHandler } from "./idle";
import {
  makeWorkerHealth,
  recordWorkerFailure,
  allowWorkerProbe,
  isWorkerCreditPaused,
} from "./worker-health";
import {
  getWorkerModel,
  resetWorkerModelState,
  fetchModelData,
  getModelEntrySync,
  lookupProviderRoute,
} from "./worker-model";
import * as Sentry from "@sentry/bun";
import {
  captureBillingPrefix,
  captureSessionHeaders,
  hasBillingHeader,
  resignBody,
} from "./cch";
import { isClaudeCodeClient, isRotationEligible } from "./session";
import { analyzeCacheTurn, categorizeBust } from "./cache-analytics";
import {
  recordGap,
  getSessionHistogram,
  recordGlobalGap,
  resolveProfile as resolveWarmingProfile,
  clearWarmupAuthDisabled,
} from "./cache-warmer";
import {
  setSentryRequestContext,
  setSentryCacheContext,
  setSentryLightContext,
  setGenAiUsageAttributes,
  setCacheAnalyticsAttributes,
  emitCostMetric,
  emitCacheBustMetric,
  emitWarmupHitMetric,
  emitCurationMetrics,
  type AnthropicUsage,
} from "./sentry";
import {
  recordConversationCost,
  updateShadowContext,
  recordWarmupHit,
  recordTTLSavings,
  getDailyThrottleDelay,
  estimateRequestCost,
  getDailySpend,
  getDailyBudget,
  getCostRate,
  getSessionCosts,
} from "./cost-tracker";
import {
  getQuotaForCredential,
  computeQuotaPressure,
  isQuotaPaused,
} from "./quota";
import {
  RECALL_GATEWAY_TOOL,
  RECALL_TOOL_NAME,
  MAX_RECALL_DEPTH,
  executeRecall,
  findRecallToolUse,
  hasRecallToolUse,
  hasOtherToolUse,
  clientHasRecallTool,
  runRecallFollowUpStreaming,
  runRecallFollowUpJSON,
  type RecallFollowUpCtx,
  buildRecallMarker,
  recallStoreKey,
  expandRecallMarkers,
  cleanupRecallStore,
  replaceRecallWithMarker,
  isRecallMarker,
} from "./recall";
import { upstreamFetch } from "./fetch";
import {
  findReadTool,
  findShellTool,
  buildSyntheticToolUseBlock,
  captureSyntheticToolResult,
  stripSyntheticRoundTrips,
  parseResolveProjectResult,
  type ResolveProjectResult,
} from "./synthetic-tools";

// ---------------------------------------------------------------------------
// Recall tool commit reminder
// ---------------------------------------------------------------------------

/**
 * Text appended to the recall tool's description to remind the agent that
 * `.lore.md` is shared project knowledge and must be committed alongside the
 * agent's work — never stashed, never skipped.
 *
 * Lives in the stable tools prefix (1h cache) on purpose: the rule is static
 * and benefits from Anthropic prompt caching. Gated at the call site on
 * `cfg.knowledge.enabled`.
 *
 * Exported for unit testing — see `packages/gateway/test/recall.test.ts`.
 */
export const LORE_COMMIT_REMINDER =
  "Before any git commit, always run `git add .lore.md`. " +
  "This includes changes you did NOT make — a background process updates " +
  "this file automatically. NEVER `git stash` `.lore.md` changes. " +
  "NEVER leave `.lore.md` modified or untracked after a commit. " +
  "`.lore.md` is shared project knowledge and must always be version-controlled.";

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** One-time initialization flag. */
let initialized = false;

// --- Context warning marker for unsustainable conversations ---
// Injected into the response (assistant message) so the user can see it.
// Stripped from incoming requests on subsequent turns to preserve cache prefix.
const CONTEXT_WARNING_MARKER = "[lore:context-warning]";
const CONTEXT_WARNING_TEXT =
  `${CONTEXT_WARNING_MARKER} This conversation is growing unsustainably \u2014 ` +
  `it has exceeded the context limit 5+ times in a row and compression cannot keep up. ` +
  `Consider running /compact or starting a new conversation.\n\n---\n\n`;

/** Insert the context warning text block into a response, after any leading thinking blocks. */
function injectContextWarning(resp: GatewayResponse): GatewayResponse {
  // Insert after thinking blocks to preserve the expected block ordering
  // (thinking first, then text). Clients may inspect the first block's type
  // to determine if extended thinking is active.
  let insertIdx = 0;
  while (
    insertIdx < resp.content.length &&
    resp.content[insertIdx].type === "thinking"
  ) {
    insertIdx++;
  }
  const content = [...resp.content];
  content.splice(insertIdx, 0, {
    type: "text" as const,
    text: CONTEXT_WARNING_TEXT,
  });
  return { ...resp, content };
}

/**
 * Strip context warning markers from assistant messages in an incoming request.
 * Restores the message content to what the API originally generated, preserving
 * the prompt cache prefix.
 *
 * Only checks the first non-thinking content block of each assistant message —
 * that's where injectContextWarning() inserts it. This avoids false positives
 * if the model happens to echo the marker in its own output.
 */
function stripContextWarnings(messages: GatewayMessage[]): void {
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    // Find the first non-thinking block (mirrors injectContextWarning insertion point)
    for (let i = 0; i < msg.content.length; i++) {
      const block = msg.content[i];
      if (block.type === "thinking") continue;
      if (
        block.type === "text" &&
        block.text.startsWith(CONTEXT_WARNING_MARKER)
      ) {
        msg.content.splice(i, 1);
      }
      break; // only check the first non-thinking block
    }
  }
}

/**
 * Detect whether a request contains a completed `git commit` tool invocation.
 * Checks tool_use inputs (command string) on assistant messages and tool_result
 * output on user messages for commit indicators. Used to trigger curation at
 * commit boundaries — natural checkpoints where decisions crystallize.
 */
const GIT_COMMIT_RE = /\bgit\s+commit\b/i;
function containsGitCommit(req: GatewayRequest): boolean {
  for (const msg of req.messages) {
    for (const block of msg.content) {
      // Check assistant tool_use inputs for the command string
      if (block.type === "tool_use") {
        const input = block.input;
        if (typeof input === "object" && input !== null) {
          const cmd =
            (input as Record<string, unknown>).command ??
            (input as Record<string, unknown>).content ??
            "";
          if (typeof cmd === "string" && GIT_COMMIT_RE.test(cmd)) return true;
        }
      }
      // Check user tool_result content for git commit output patterns
      if (block.type === "tool_result") {
        const text = blocksToText(block.content);
        // Match common git commit output (e.g., "[main abc1234] commit message")
        if (text && /^\[[\w/.-]+ [0-9a-f]+\]/.test(text.trim())) return true;
      }
    }
  }
  return false;
}

/** Active upstream interceptor — used for recording/replay. */
let activeInterceptor: UpstreamInterceptor | undefined;

/**
 * Set (or clear) the module-level upstream interceptor.
 *
 * When set, every call to `forwardToUpstream` passes through the interceptor
 * instead of calling `fetch` directly.  Used by the recording and replay
 * scripts to capture or replay upstream traffic without modifying individual
 * call sites.
 */
export function setUpstreamInterceptor(
  interceptor: UpstreamInterceptor | undefined,
): void {
  activeInterceptor = interceptor;
}

/**
 * Reset all module-level singleton state.
 *
 * Called during gateway shutdown (with `{ fast: true }` to skip the batch-queue
 * drain) and by test harnesses (default — drains gracefully so tests observe
 * all side-effects).
 */
export async function resetPipelineState(opts?: {
  fast?: boolean;
}): Promise<void> {
  initialized = false;
  sessions.clear();
  cwdWarned.clear();
  subagentParentPendingLogged.clear();
  headerSessionIndex.clear();
  ltmSessionCache.clear();
  ltmPinnedText.clear();
  lastSavedDedupDecisions.clear();
  stableLtmCache.clear();
  // Shut down the batch queue before clearing the client. On process exit
  // (`fast`), skip the synchronous LLM drain — replaying queued background
  // prompts through retries/backoff is what made Ctrl+C hang for minutes; they
  // resume next session. Config/test resets keep draining (default).
  if (llmClient && "shutdown" in llmClient) {
    await (
      llmClient as LLMClient & {
        shutdown: (o?: { drainQueue?: boolean }) => Promise<void>;
      }
    ).shutdown({ drainQueue: !opts?.fast });
  }
  llmClient = null;
  activeInterceptor = undefined;
  if (stopFileWatcher) {
    stopFileWatcher();
    stopFileWatcher = null;
  }
  if (stopIdleScheduler) {
    stopIdleScheduler();
    stopIdleScheduler = null;
  }
  _lastSeenSessionModel = null;
  resetWorkerModelState();
  resetBackgroundLimiter();
}

/** Per-session state tracked across requests. */
const sessions = new Map<string, SessionState>();

/** Sessions that have already logged the cwd-fallback warning (dedup). */
const cwdWarned = new Set<string>();

/** (sessionID + parentClientId) pairs that have already logged the unresolved
 *  subagent-parent warning. Without dedup, a child agent with an unresolvable
 *  parent (Tier 3 fingerprint) fires the same "pending" log on every turn —
 *  50+ identical lines per session. Cleared on session eviction. */
const subagentParentPendingLogged = new Set<string>();

/** Read-only access to live session states (for dashboard rendering). */
export function getActiveSessions(): ReadonlyMap<string, SessionState> {
  return sessions;
}

/**
 * Re-bind an active session's project path after a manual move/reassign.
 *
 * Updates the in-memory `SessionState` so the live dashboard immediately
 * reflects the new project without requiring a gateway restart. A no-op
 * when the session is not currently active (DB-only move is sufficient).
 */
export function rebindActiveSession(
  sessionId: string,
  newProjectPath: string,
): void {
  const sess = sessions.get(sessionId);
  if (!sess) return;
  sess.projectPath = newProjectPath;
  sess.projectPathProvisional = false;
}

/**
 * Reverse lookup: maps header-based session ID values to internal session IDs.
 * Key: `headerName:headerValue` (e.g. `x-claude-code-session-id:uuid-1234`).
 * Value: internal session ID (the key in `sessions`).
 *
 * Populated for both Tier 1 (known headers) and Tier 2 (learned headers).
 */
const headerSessionIndex = new Map<string, string>();

/**
 * Per-session LTM cache for byte-stability of **context-bound** entries
 * (gotchas, patterns, architecture — everything except preferences).
 *
 * Without caching, `ltm.forSession()` re-scores entries against evolving
 * session context every turn, producing different formatted text → system
 * prompt changes at byte 0 → total cache invalidation on every turn.
 */
const ltmSessionCache = new Map<
  string,
  { formatted: string; tokenCount: number }
>();

/**
 * Pinned context-bound LTM text per session — the text currently being
 * injected as system[2]. When ltmSessionCache is invalidated and recomputed,
 * we compare the *selected entry set* against the pin: if the set of entry IDs
 * is identical (any order) and no entry's content changed, the pinned text is
 * reused verbatim so the system[2] cache prefix stays warm. Re-pinning happens
 * only when the selected set changes or an entry's content changes.
 *
 * `entryKeys` is the sorted array of `"<id>:<hash(title+content)>"` keys for
 * the entries the pinned text was rendered from. `undefined` means the pin
 * predates entry-key tracking (legacy/restored rows) — treated as "unknown
 * set", which forces a one-time re-pin on the next turn.
 */
const ltmPinnedText = new Map<
  string,
  { formatted: string; tokenCount: number; entryKeys?: string[] }
>();

/**
 * Last-persisted serialized dedup-decision memo per session — a change guard so
 * we only write `dedup_decisions` to the DB on turns where it actually changed.
 */
const lastSavedDedupDecisions = new Map<string, string | undefined>();

/**
 * FNV-1a 32-bit hash of a string, returned as a short hex string. Used to
 * detect per-entry content changes cheaply without storing full text. A
 * collision would at worst suppress one legitimate re-pin (the curator's next
 * content edit re-rolls the hash), so a 32-bit hash is acceptable here.
 */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16);
}

/**
 * Compute the sorted entry-key array for a set of context-bound LTM entries.
 * Each key is `"<id>:<hash(title+content)>"`. Sorted so order is canonical:
 * the same set of entries always produces the same key array regardless of
 * ranking order, which is exactly the property the reorder-tolerant pin needs.
 *
 * When `renderedIds` is provided, only those entries (the ones that survived
 * budget packing in formatKnowledge and are actually in the rendered text) are
 * keyed — so the key set always matches the rendered string byte-for-byte.
 */
export function ltmEntryKeys(
  entries: Array<{ id: string; title: string; content: string }>,
  renderedIds?: Iterable<string>,
): string[] {
  let source = entries;
  if (renderedIds) {
    const allow = new Set(renderedIds);
    source = entries.filter((e) => allow.has(e.id));
  }
  return source
    .map((e) => `${e.id}:${fnv1a(`${e.title}\x1f${e.content}`)}`)
    .sort();
}

/** system[1] (stable LTM) cache breakpoint TTL in ms. Once an idle gap exceeds
 *  this, that prefix is cold and can be rebuilt with fresh preferences for free. */
export const STABLE_LTM_TTL_MS = 3_600_000; // 1h — matches the system[1] cache_control

/**
 * Decide whether in-flight (turn-based) curation should run this turn.
 * Off by default (`curator.inFlight === false`): mid-session curation rewrites
 * system[2] and busts the prompt cache. Pure/testable.
 */
export function shouldRunInFlightCuration(input: {
  knowledgeEnabled: boolean;
  inFlight: boolean;
  turnsSinceCuration: number;
  effectiveAfterTurns: number;
  curationScheduled: boolean;
  curatorBusy: boolean;
}): boolean {
  return (
    input.knowledgeEnabled &&
    input.inFlight &&
    input.turnsSinceCuration >= input.effectiveAfterTurns &&
    !input.curationScheduled &&
    !input.curatorBusy
  );
}

/**
 * Decide whether the stable LTM block (system[1]: preferences + entities) should
 * be refreshed on an idle resume. Only when the idle gap exceeds the system[1]
 * 1h cache TTL — that prefix is then cold, so rebuilding it with freshly-curated
 * preferences costs nothing. Shorter gaps keep it pinned. Pure/testable.
 */
export function shouldRefreshStableLtm(
  idleTriggered: boolean,
  idleMs: number,
): boolean {
  return idleTriggered && idleMs >= STABLE_LTM_TTL_MS;
}

/**
 * Extract the entry-ID portion ("<id>" before the ":") from a sorted entry-key
 * array. Used to feed the previous turn's selected set back into forSession()
 * as a stability hint (stickyIds) so the budget-boundary selection doesn't
 * churn turn-to-turn.
 */
export function entryKeyIds(keys: string[] | undefined): Set<string> {
  const ids = new Set<string>();
  if (!keys) return ids;
  for (const k of keys) {
    const idx = k.lastIndexOf(":");
    ids.add(idx === -1 ? k : k.slice(0, idx));
  }
  return ids;
}

/** True when two sorted entry-key arrays are element-wise identical. */
export function sameEntryKeys(
  a: string[] | undefined,
  b: string[] | undefined,
): boolean {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Stable LTM (preference entries) + known entities per session — injected as
 * system[1] with a 1h cache breakpoint. Computed once per session and pinned
 * for ≥1h even through curation changes, so the Anthropic prompt cache prefix
 * (system[0] host prompt + system[1] stable LTM) stays warm across turns
 * and sessions.
 *
 * Only rebuilt on new session start (cache miss). NOT invalidated by
 * curation, idle resume, or Layer 4 emergency — the stale preferences
 * are kept to preserve the 1h cache investment. On process restart the
 * cache is recomputed (cheap, preferences + the capped entity list are small).
 */
const stableLtmCache = new Map<
  string,
  { formatted: string; tokenCount: number }
>();

/** Cached LLM client for background workers. */
let llmClient: LLMClient | null = null;
/** Whether the batch queue wrapper is active (set once in getLLMClient). */
let batchQueueEnabled = false;

/** Cleanup function for the idle scheduler timer. */
let stopIdleScheduler: (() => void) | null = null;

/** Cleanup function for the .lore.md / agents-file watcher. */
let stopFileWatcher: (() => void) | null = null;

/** Last seen session model ID — used for worker model discovery context. */
let _lastSeenSessionModel: string | null = null;

// ---------------------------------------------------------------------------
// Model limits — fetched from models.dev, fallback for unknown
// ---------------------------------------------------------------------------

type ModelSpec = {
  context: number;
  output: number;
  /** Cache-read cost per token in USD. */
  cacheReadCost?: number;
  /** Cache-write cost per token in USD (Anthropic: 1.25× input). */
  cacheWriteCost?: number;
  /** Input cost per million tokens (for cost-tier decisions). */
  inputCostPerMillion?: number;
};

const DEFAULT_MODEL_SPEC: ModelSpec = { context: 200_000, output: 8_192 };

/**
 * Look up model limits and cost data from models.dev.
 *
 * Uses the sync cache populated by `fetchModelData()` during init.
 * Falls back to sensible defaults if the cache isn't warm yet.
 */
function getModelSpec(model: string): ModelSpec {
  const entry = getModelEntrySync(model);
  return {
    context: entry.limit?.context ?? DEFAULT_MODEL_SPEC.context,
    output: entry.limit?.output ?? DEFAULT_MODEL_SPEC.output,
    cacheReadCost:
      entry.cost?.cache_read != null
        ? entry.cost.cache_read / 1_000_000 // models.dev is per-million, we need per-token
        : undefined,
    cacheWriteCost:
      entry.cost?.cache_write != null
        ? entry.cost.cache_write / 1_000_000
        : entry.cost?.input != null
          ? (entry.cost.input * 1.25) / 1_000_000 // Anthropic: cache_write = 1.25× input
          : undefined,
    inputCostPerMillion: entry.cost?.input ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Dynamic max_tokens sizing for non-Claude-Code clients
// ---------------------------------------------------------------------------

const MAX_TOKENS_FLOOR = 8192;
const MAX_TOKENS_BUFFER = 1000;
const MAX_TOKENS_EMA_MULTIPLIER = 3;

/**
 * Compute a right-sized `max_tokens` value for a conversation turn using
 * a hybrid headroom + history approach.
 *
 * - Turn 1 (no history): returns `ceiling` (32K) — matches Claude Code.
 * - Turns 2+: 3× output EMA, clamped by context headroom and ceiling.
 * - After truncation (`stop_reason: "length"`): jumps back to ceiling.
 *
 * Exported for testing.
 */
export function computeMaxTokens(
  modelOutput: number,
  modelContext: number,
  outputEMA: number | undefined,
  lastStopReason: string | undefined,
  lastInputTokens: number | undefined,
): number {
  const ceiling = Math.min(modelOutput, 32_000);

  // Turn 1: no history — use ceiling (matches Claude Code default)
  if (outputEMA == null) return ceiling;

  // Headroom: how much output the context can afford given last known input
  const estimatedInput = lastInputTokens ?? 0;
  const headroom = Math.max(
    MAX_TOKENS_FLOOR,
    modelContext - estimatedInput - MAX_TOKENS_BUFFER,
  );

  // History: 3× recent output EMA — generous multiplier to absorb spikes
  let adaptive = Math.max(
    MAX_TOKENS_FLOOR,
    MAX_TOKENS_EMA_MULTIPLIER * outputEMA,
  );

  // Safety: if last turn was truncated, jump to ceiling
  if (lastStopReason === "length") {
    adaptive = ceiling;
  }

  // Clamp: history within headroom, within ceiling
  return Math.min(headroom, Math.max(adaptive, MAX_TOKENS_FLOOR), ceiling);
}

// ---------------------------------------------------------------------------
// Knowledge file import — shared by startup + file watcher + new-session check
// ---------------------------------------------------------------------------

/**
 * Attempt to import knowledge from `.lore.md` (preferred) or the agents file
 * (AGENTS.md/CLAUDE.md, backward compat).  Safe to call frequently — the
 * underlying `shouldImportLoreFile()` / `shouldImport()` do mtime + content-hash
 * checks and short-circuit when nothing changed.
 *
 * Returns true if entries were actually imported.
 */
function tryImportKnowledge(projectPath: string): boolean {
  if (isHostedMode()) return false;
  const cfg = loreConfig();
  if (!cfg.knowledge.enabled) return false;

  try {
    if (cfg.loreFile.enabled && loreFileExists(projectPath)) {
      if (shouldImportLoreFile(projectPath)) {
        importLoreFile(projectPath);
        log.info("imported knowledge from .lore.md");
        return true;
      }
    } else if (cfg.agentsFile.enabled) {
      const { join } = require("node:path") as typeof import("node:path");
      const filePath = join(projectPath, cfg.agentsFile.path);
      if (shouldImport({ projectPath, filePath })) {
        importFromFile({ projectPath, filePath });
        log.info("imported knowledge from", cfg.agentsFile.path);
        return true;
      }
    }
  } catch (e) {
    log.error("knowledge import error:", e);
  }

  return false;
}

// ---------------------------------------------------------------------------
// File watcher for .lore.md / agents file — picks up external edits live
// ---------------------------------------------------------------------------

/**
 * Start watching `.lore.md` (and the agents file as fallback) for changes.
 * Uses `fs.watch()` with a debounce to avoid rapid-fire triggers from
 * editors that do atomic write-rename sequences.
 *
 * Safe against import-after-export loops: `shouldImportLoreFile()` compares
 * the file content hash against what the DB would produce, so our own
 * exports are recognized as no-ops.
 */
function startKnowledgeFileWatcher(projectPath: string): () => void {
  // In hosted mode, never watch client-controlled paths.
  if (isHostedMode()) return () => {};

  const { join } = require("node:path") as typeof import("node:path");
  const { watch, existsSync } = require("node:fs") as typeof import("node:fs");

  const cfg = loreConfig();
  const watchers: import("node:fs").FSWatcher[] = [];
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const DEBOUNCE_MS = 500;

  const onFileChange = () => {
    // Debounce: editors often write-rename-delete in rapid succession.
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      tryImportKnowledge(projectPath);
    }, DEBOUNCE_MS);
  };

  // Watch .lore.md (gated on loreFile.enabled)
  if (cfg.loreFile.enabled) {
    const loreFilePath = join(projectPath, LORE_FILE);
    if (existsSync(loreFilePath)) {
      try {
        const w = watch(loreFilePath, onFileChange);
        w.on("error", () => {}); // suppress — file may be deleted
        watchers.push(w);
      } catch {
        // watch not supported (rare) — fall back to session-start checks only
      }
    }
  }

  // Watch agents file (AGENTS.md etc.) as fallback
  if (cfg.agentsFile.enabled) {
    const agentsFilePath = join(projectPath, cfg.agentsFile.path);
    if (existsSync(agentsFilePath)) {
      try {
        const w = watch(agentsFilePath, onFileChange);
        w.on("error", () => {});
        watchers.push(w);
      } catch {
        // watch not supported
      }
    }
  }

  // Watch .lore.md in configured workspace sub-projects.
  // Changes in sub-project files trigger a re-import into the root project.
  // Each sub-project gets its own debounce timer so concurrent edits across
  // sub-projects don't cancel each other's pending imports.
  const allTimers: Array<{ clear: () => void }> = [
    {
      clear: () => {
        if (debounceTimer) {
          clearTimeout(debounceTimer);
          debounceTimer = null;
        }
      },
    },
  ];
  if (cfg.loreFile.enabled && cfg.workspaces.length > 0) {
    const subDirs = resolveWorkspaces(projectPath, cfg.workspaces);
    for (const subDir of subDirs) {
      const subLoreFile = join(subDir, LORE_FILE);
      if (existsSync(subLoreFile)) {
        try {
          let subTimer: ReturnType<typeof setTimeout> | null = null;
          const w = watch(subLoreFile, () => {
            if (subTimer) clearTimeout(subTimer);
            subTimer = setTimeout(() => {
              subTimer = null;
              try {
                importLoreFileAs(subDir, projectPath);
              } catch (e) {
                log.error(
                  `workspace knowledge re-import error (${subDir}):`,
                  e,
                );
              }
            }, DEBOUNCE_MS);
          });
          w.on("error", () => {});
          watchers.push(w);
          allTimers.push({
            clear: () => {
              if (subTimer) {
                clearTimeout(subTimer);
                subTimer = null;
              }
            },
          });
        } catch {
          // watch not supported
        }
      }
    }
  }

  if (watchers.length > 0) {
    log.info(`watching ${watchers.length} knowledge file(s) for changes`);
  }

  return () => {
    for (const t of allTimers) t.clear();
    for (const w of watchers) {
      try {
        w.close();
      } catch {
        /* already closed */
      }
    }
    watchers.length = 0;
  };
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * One-time init: load Lore config, ensure project exists in DB, start idle scheduler.
 * Safe to call multiple times — only the first call does work.
 */
async function initIfNeeded(
  projectPath: string,
  config: GatewayConfig,
  gitRemote?: string,
): Promise<void> {
  if (initialized) return;

  // Enable hosted mode before any FS operations — once set, all core
  // functions that touch client-controlled paths become safe no-ops.
  if (config.hostedMode) {
    enableHostedMode();
  }

  await load(projectPath);
  ensureProject(projectPath, undefined, gitRemote);
  initialized = true;

  // Import knowledge from .lore.md at startup (picks up user/git edits
  // since last session). Falls back to agents file for backward compat.
  const cfg = loreConfig();
  if (cfg.knowledge.enabled) {
    tryImportKnowledge(projectPath);

    // Import .lore.md files from configured workspace sub-projects.
    // Entries are attributed to the root project so they're visible in
    // the current session's knowledge context.
    if (cfg.workspaces.length > 0) {
      const { basename } = require("node:path") as typeof import("node:path");
      const subDirs = resolveWorkspaces(projectPath, cfg.workspaces);
      for (const subDir of subDirs) {
        try {
          if (loreFileExists(subDir)) {
            importLoreFileAs(subDir, projectPath);
            log.info(`imported knowledge from workspace: ${basename(subDir)}`);
          }
        } catch (e) {
          log.error(`workspace knowledge import error (${subDir}):`, e);
        }
      }
    }

    // Prune corrupted/oversized knowledge entries (safety net for past bugs).
    const pruned = ltm.pruneOversized(1200);
    if (pruned > 0) {
      log.info(
        `pruned ${pruned} oversized knowledge entries (confidence set to 0)`,
      );
    }

    // Watch knowledge files for live changes (git pull, manual edits, etc.)
    if (!stopFileWatcher) {
      stopFileWatcher = startKnowledgeFileWatcher(projectPath);
    }
  }

  // Startup backfills — idempotent, run once per process.
  try {
    distillation.backfillMetrics();
  } catch (e) {
    log.info("metric backfill failed:", e);
  }
  embedding.runStartupBackfill().catch((e) => {
    log.error("embedding backfill failed:", e);
  });

  // Index lat.md/ directory sections (content-hash-based, skips unchanged files).
  try {
    latReader.refresh(projectPath);
  } catch (e) {
    log.error("lat-reader startup refresh error:", e);
  }

  // Pre-populate headerSessionIndex from DB so Tier 1 session identification
  // works immediately after process restart. Without this, the first request
  // with a known session header generates a new session ID and orphans the
  // old session's persisted state.
  try {
    const headerEntries = loadHeaderSessionIndex();
    for (const entry of headerEntries) {
      const indexKey = `${entry.headerName}:${entry.headerSessionId}`;
      headerSessionIndex.set(indexKey, entry.sessionId);
    }
    if (headerEntries.length > 0) {
      log.info(
        `restored ${headerEntries.length} header→session mappings from DB`,
      );
    }
  } catch (e) {
    log.warn("header session index restore failed:", e);
  }

  // Pre-warm models.dev pricing/limits cache so synchronous lookups in the
  // request hot path (getModelSpec, emitCostMetric) resolve from memory.
  fetchModelData().catch((e) => log.warn("models.dev pre-warm failed:", e));

  // Start the idle scheduler for background work (distillation, curation,
  // pruning, AGENTS.md export). Uses a 30s poll interval and fires for any
  // session whose lastRequestTime exceeds the idle timeout.
  if (config && !stopIdleScheduler) {
    const llm = getLLMClient(config);
    const idleHandler = buildIdleWorkHandler(llm);
    stopIdleScheduler = startIdleScheduler(
      config,
      sessions,
      idleHandler,
      (sessionID) => {
        // Clean up pipeline-level satellite Maps on session eviction.
        // The headerSessionIndex entries are keyed by header values pointing
        // TO this sessionID — remove them too.
        for (const [key, sid] of headerSessionIndex) {
          if (sid === sessionID) headerSessionIndex.delete(key);
        }
        ltmSessionCache.delete(sessionID);
        ltmPinnedText.delete(sessionID);
        lastSavedDedupDecisions.delete(sessionID);
        stableLtmCache.delete(sessionID);
        cwdWarned.delete(sessionID);
        // Clear subagent parent-pending dedup entries for this session —
        // keys are `${sessionID}:${parentClientId}`, so filter by prefix.
        for (const key of subagentParentPendingLogged) {
          if (key.startsWith(`${sessionID}:`)) {
            subagentParentPendingLogged.delete(key);
          }
        }
      },
    );
  }

  log.info(`gateway pipeline initialized: ${projectPath}`);
}

function getLLMClient(config: GatewayConfig): LLMClient {
  if (!llmClient) {
    const cfg = loreConfig();
    const defaultModel = cfg.model ?? {
      providerID: "anthropic",
      modelID: "claude-sonnet-4-6",
    };

    // Worker-specific auth: when LORE_WORKER_API_KEY is set, workers use a
    // dedicated credential instead of the session's client key. This enables
    // routing workers to a different provider (e.g. MiniMax) while sessions
    // continue using Anthropic. Falls back to session auth when not set.
    const workerApiKey = config.workerApiKey;
    const getWorkerAuth: (
      sessionID?: string,
      providerID?: string,
    ) => AuthCredential | null = workerApiKey
      ? () => ({ scheme: "api-key", value: workerApiKey })
      : resolveAuth;

    // Worker-specific upstream: when LORE_WORKER_UPSTREAM is set, all worker
    // calls route to this URL instead of the default upstream URLs.
    const workerUpstreams = config.workerUpstream
      ? { anthropic: config.workerUpstream, openai: config.workerUpstream }
      : { anthropic: config.upstreamAnthropic, openai: config.upstreamOpenAI };

    if (config.workerApiKey || config.workerUpstream) {
      log.info(
        `worker routing: ` +
          `auth=${config.workerApiKey ? "dedicated key" : "session"}, ` +
          `upstream=${config.workerUpstream ?? "default"}`,
      );
    }

    const rawClient = createGatewayLLMClient(
      workerUpstreams,
      getWorkerAuth,
      defaultModel,
      { dedicatedWorkerKey: !!workerApiKey },
    );

    // Workers always use the same provider as the session. Route worker
    // calls through the session's upstream URL and wire protocol so they
    // use the session's credentials, endpoint, and request format. The
    // protocol from the UpstreamSnapshot is the source of truth — it was
    // resolved at conversation-turn time and correctly handles aggregator
    // providers (e.g. OpenCode Zen) whose route has protocol=null.
    //
    // When a dedicated worker API key is set (LORE_WORKER_API_KEY), skip
    // injection — the worker uses its own credentials and default upstream.
    //
    // CROSS-PROVIDER GUARD: The model was resolved at idle-handler start
    // from state.lastUpstream, but the URL is resolved HERE (lazily) from
    // the CURRENT state.lastUpstream. If the user switched providers
    // between those two points, the model and URL come from different
    // providers → 404. Detect this and re-resolve the worker model from
    // the current upstream. See: LOREAI-GATEWAY-2A.
    const inner: LLMClient = {
      async prompt(system, user, opts) {
        if (opts?.sessionID && !opts.upstreamUrl && !workerApiKey) {
          const state = sessions.get(opts.sessionID);
          if (state?.lastUpstream?.url) {
            // Cross-provider guard: if the model's provider doesn't match
            // the current upstream provider, re-resolve to avoid sending
            // e.g. MiniMax-M3 to api.anthropic.com.
            //
            // When opts.model is undefined, the rawClient will use
            // defaultModel (hardcoded at construction time, typically
            // Anthropic). We must also guard against THAT mismatch —
            // otherwise an unknown-provider session (MiniMax, xAI, etc.)
            // gets the Anthropic defaultModel sent to its upstream URL.
            let effectiveOpts = opts;
            const modelProvider =
              opts?.model?.providerID ?? defaultModel.providerID;
            const upstreamProvider = state.lastUpstream.providerID;
            if (upstreamProvider && modelProvider !== upstreamProvider) {
              const reResolved = getWorkerModel(state.lastUpstream);
              if (reResolved) {
                effectiveOpts = { ...opts, model: reResolved };
              } else {
                // Can't resolve a valid worker model for the current
                // provider — skip this call rather than send cross-provider.
                log.warn(
                  `worker cross-provider guard: model=${modelProvider}/${opts?.model?.modelID ?? defaultModel.modelID} vs upstream=${upstreamProvider} — skipping (worker=${opts?.workerID ?? "unknown"}, session=${opts.sessionID})`,
                );
                recordWorkerFailure(
                  opts.sessionID,
                  opts?.workerID ?? "unknown",
                  "cross-provider",
                );
                return null;
              }
            }
            return rawClient.prompt(system, user, {
              ...effectiveOpts,
              upstreamUrl: state.lastUpstream.url,
              protocol: state.lastUpstream.protocol,
            });
          }
        }
        return rawClient.prompt(system, user, opts);
      },
    };

    // Wrap with batch queue for 50% cost savings on non-urgent worker calls.
    // Enabled by default — disable via LORE_BATCH_DISABLED=1.
    /**
     * Disables the batch-queue wrapper for non-urgent worker calls
     * (distillation, curation, embedding). With batching on, the
     * gateway groups these calls and submits them via the Anthropic
     * Message Batches API for ~50% cost savings. Set
     * `LORE_BATCH_DISABLED=1` to bypass batching and dispatch each
     * call immediately (useful for low-latency debugging or when the
     * upstream rejects batch submissions). Env: `LORE_BATCH_DISABLED=1`.
     */
    const batchDisabled = process.env.LORE_BATCH_DISABLED === "1";
    if (Sentry.isInitialized()) {
      Sentry.setTag("batch_enabled", String(!batchDisabled));
    }
    if (batchDisabled) {
      llmClient = inner;
      batchQueueEnabled = false;
    } else {
      llmClient = createBatchLLMClient(
        inner,
        workerUpstreams,
        getWorkerAuth,
        defaultModel,
      );
      batchQueueEnabled = true;
    }
  }
  return llmClient;
}

// ---------------------------------------------------------------------------
// Project path resolution with session cache
// ---------------------------------------------------------------------------

/**
 * Resolve the final project path for a session, applying sticky per-session
 * binding and (on remote gateways) synthetic "unattributed" bucketing.
 *
 * Context: some requests (Claude Code's haiku side-channel / prompt-cache
 * probes) carry stripped-down system prompts that lack any path reference, so
 * `getProjectPath()` returns `source: "cwd"`. On a central/remote gateway the
 * gateway's own cwd has NO relationship to the client's project — attributing
 * such requests to cwd merges unrelated sessions into one bogus project (the
 * "lore-config" bug).
 *
 * Rules:
 *  - A **confident** path (`header`/`inferred`) always binds the session and
 *    clears the provisional flag. If it overwrites a previously-provisional
 *    path under which rows were already stored, those rows are re-pointed
 *    (self-heal) to the real project.
 *  - A **cwd** result NEVER overwrites a confident binding. If the session has
 *    no confident binding yet, it stays/becomes provisional:
 *      - local gateway: keep the cwd path (legacy behavior — gateway shares the
 *        filesystem with the agent, so cwd is meaningful);
 *      - remote gateway: route to a per-session synthetic bucket
 *        (`/__lore_unattributed__/<sessionID>`) so unrelated sessions never
 *        merge.
 *
 * Returns the final resolved project path.
 */
export function resolveSessionProjectPath(
  result: ProjectPathResult,
  sessionState: SessionState,
  config: GatewayConfig,
): string {
  let { path: projectPath, source } = result;

  // Cache git remote on the session so subsequent turns benefit even if
  // the header is absent (e.g. prompt-cache probes or follow-up requests).
  if (result.gitRemote && !sessionState.gitRemote) {
    sessionState.gitRemote = result.gitRemote;
  }

  const hasConfident =
    !!sessionState.projectPath && !sessionState.projectPathProvisional;
  // Best git remote we know for this session — the current turn's, falling back
  // to a value cached on an earlier turn (the header is independent of path
  // resolution, so it can arrive on a turn that otherwise lacks a path).
  const effectiveRemote = result.gitRemote ?? sessionState.gitRemote;

  if (source === "inferred" || source === "header") {
    // Confident path — bind the session.
    const previous = sessionState.projectPath;
    const wasProvisional = sessionState.projectPathProvisional === true;

    // Self-heal: if the session was previously bound to a provisional path
    // (cwd fallback or synthetic bucket) under which rows may already be
    // stored, migrate those rows into the real project now that we know it.
    // Only clear the provisional flag once the migration succeeds — otherwise
    // a transient failure (e.g. SQLITE_BUSY from a separate process) would
    // permanently strand the bucket data with no retry. Keeping the flag set
    // lets the next confident turn re-attempt.
    let healed = true;
    if (wasProvisional && previous && previous !== projectPath) {
      healed = reattributeProvisionalProject(
        previous,
        projectPath,
        effectiveRemote,
      );
    }

    sessionState.projectPath = projectPath;
    sessionState.projectPathProvisional = !healed;

    // Backfill git_remote on the (now confident) project row — idempotent.
    if (effectiveRemote) {
      ensureProject(projectPath, undefined, effectiveRemote);
    }
    return projectPath;
  }

  // source === "cwd" (no header, inference failed).
  if (hasConfident) {
    // Never downgrade a confident binding to cwd. Keep the known-good path.
    return sessionState.projectPath;
  }

  // No confident binding yet → provisional attribution.
  if (config.remoteGateway) {
    // Remote/central gateway: the gateway's cwd is meaningless for the client.
    // Use a per-session synthetic bucket so unrelated sessions never merge.
    projectPath = unattributedBucketPath(sessionState.sessionID);
  }
  // (local gateway: keep the cwd path from `result` — cwd is meaningful there.)

  sessionState.projectPath = projectPath;
  sessionState.projectPathProvisional = true;

  // Record the git remote on the bucket/cwd project row when known. This is
  // what later lets self-heal and `lore data consolidate` match a provisional
  // bucket back to its real project by git remote — a common case is a client
  // that sends X-Lore-Git-Remote but no X-Lore-Project (and no inferable path).
  if (effectiveRemote) {
    ensureProject(projectPath, undefined, effectiveRemote);
  }

  // One-time warning per session when we couldn't confidently attribute.
  if (!cwdWarned.has(sessionState.sessionID)) {
    cwdWarned.add(sessionState.sessionID);
    const detail = config.remoteGateway
      ? `routed to provisional bucket ${projectPath}`
      : `falling back to process.cwd() (${projectPath})`;
    console.error(
      `[lore] warning: could not determine project for session ` +
        `${sessionState.sessionID.slice(0, 16)} — ${detail}. ` +
        `Data may be misattributed. Fix: launch your agent via \`lore run\`, ` +
        `or have your client send the "X-Lore-Project: /path/to/project" header ` +
        `(provider-agnostic; e.g. via ANTHROPIC_CUSTOM_HEADERS for Claude Code, ` +
        `the OpenCode/Pi plugins, or your client's custom-header mechanism).`,
    );
  }

  return projectPath;
}

/**
 * Migrate all rows stored under a provisional project path (a cwd fallback or
 * a synthetic `/__lore_unattributed__/...` bucket) into the real project once
 * a confident path is learned for the session.
 *
 * Returns `true` when the re-attribution is complete (either there was nothing
 * to migrate, the source already resolves to the target, or the merge
 * succeeded) and `false` when a transient failure left bucket data behind. The
 * caller keeps the session provisional on `false` so a later turn retries
 * rather than permanently stranding the data. Never throws — a failed self-heal
 * must not break the live request.
 */
function reattributeProvisionalProject(
  fromPath: string,
  toPath: string,
  gitRemote?: string,
): boolean {
  try {
    const fromId = projectId(fromPath);
    if (!fromId) return true; // nothing was stored under the provisional path
    // Ensure the destination project row exists before merging into it.
    const toId = ensureProject(toPath, undefined, gitRemote);
    if (fromId === toId) return true;

    // Merging permanently aliases `fromPath` → `toId` (db registers a
    // project_path_aliases row). That is only safe when we are confident the
    // two paths are the SAME logical project. Corroborate before merging:
    //   (a) `fromPath` is a synthetic per-session unattributed bucket — it is
    //       session-private, so folding it into the real project is always safe.
    //   (b) the two project rows share a git remote — strong evidence they are
    //       the same repo (worktree / re-clone / cwd-vs-header path skew).
    // Otherwise these are two DISTINCT real on-disk paths linked only by a
    // (possibly mis-)inferred path. Re-bind the session to the new path but do
    // NOT merge — a stray inferred path must never fold one real project's
    // knowledge into another's (which would then leak via on-disk .lore.md
    // export). The orphaned provisional rows can still be reconciled later by
    // `lore data consolidate` when a shared git remote is known.
    const fromRemote = projectGitRemote(fromId);
    const toRemote = gitRemote ?? projectGitRemote(toId);
    const remotesMatch = !!fromRemote && !!toRemote && fromRemote === toRemote;
    const corroborated = isUnattributedProjectPath(fromPath) || remotesMatch;
    if (!corroborated) {
      log.warn(
        `self-heal: NOT merging ${fromPath} → ${toPath} — distinct real ` +
          `projects with no shared git remote; re-binding session only to ` +
          `avoid cross-project contamination.`,
      );
      return true; // session re-binds to toPath; provisional rows stay put
    }

    mergeProjectInternal(fromId, toId);
    log.info(
      `self-heal: re-attributed provisional project ${fromPath} → ${toPath}`,
    );
    return true;
  } catch (e) {
    log.warn(
      `self-heal re-attribution failed (${fromPath} → ${toPath}); will retry on next confident turn:`,
      e,
    );
    return false;
  }
}

// ---------------------------------------------------------------------------
// Synthetic project-resolution helpers
// ---------------------------------------------------------------------------

/**
 * Apply the result of a synthetic project-resolution probe to the session.
 *
 * Mirrors Branch A of `resolveSessionProjectPath`: if we got a confident
 * signal (git remote or client-side root), bind the session, reattribute
 * any provisional data, and clear the provisional flag. Never throws.
 *
 * Returns the (possibly updated) projectPath for the caller to use.
 */
function applySyntheticResolution(
  sessionState: SessionState,
  resolved: ResolveProjectResult,
  currentProjectPath: string,
): string {
  try {
    const { root, gitRemote } = resolved;
    if (!root && !gitRemote) return currentProjectPath; // nothing useful — no-op

    const newPath = root ?? currentProjectPath;
    const previous = sessionState.projectPath;
    const wasProvisional = sessionState.projectPathProvisional === true;

    if (wasProvisional && previous && previous !== newPath) {
      reattributeProvisionalProject(previous, newPath, gitRemote);
    }

    sessionState.projectPath = newPath;
    // Only clear provisional when we have a real client-side root (from
    // shell probe) or a git remote (from either probe). A remote alone
    // is sufficient for consolidation-based reconciliation.
    if (root || gitRemote) {
      sessionState.projectPathProvisional = false;
    }

    if (gitRemote) {
      sessionState.gitRemote = gitRemote;
    }

    if (gitRemote || root) {
      ensureProject(newPath, undefined, gitRemote);
    }

    log.info(
      `synthetic-resolve: bound session ${sessionState.sessionID.slice(0, 16)} → ` +
        `path=${newPath}${gitRemote ? ` remote=${gitRemote}` : ""}`,
    );
    return newPath;
  } catch (e) {
    // applySyntheticResolution must NEVER throw into the live request.
    log.warn("synthetic-resolve: applySyntheticResolution failed:", e);
    return currentProjectPath;
  }
}

/**
 * Build an HTTP Response containing a single synthetic tool_use block.
 *
 * The client harness sees this as a normal assistant response with
 * `stop_reason: "tool_use"` and MUST execute the tool. The gateway controls
 * the entire response — no upstream call is made.
 *
 * Supports both streaming (Anthropic SSE → translated for OpenAI clients)
 * and non-streaming paths.
 */
function syntheticToolUseResponse(
  req: GatewayRequest,
  block: GatewayToolUseBlock,
): Response {
  const resp: GatewayResponse = {
    id: `msg_lore_syn_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
    model: req.model,
    content: [block],
    stopReason: "tool_use",
    usage: ZERO_USAGE,
  };

  if (req.stream) {
    // Build Anthropic SSE, then translate if the client speaks OpenAI.
    const sseBody = buildSSEToolUseResponse(resp.id, resp.model, {
      id: block.id,
      name: block.name,
      input: block.input,
    });
    const anthropicSSE = new Response(sseBody, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
    if (req.protocol === "openai") {
      return translateAnthropicStreamToOpenAI(anthropicSSE);
    }
    if (req.protocol === "openai-responses") {
      return translateAnthropicStreamToResponses(anthropicSSE);
    }
    return anthropicSSE;
  }

  // Non-streaming: use the existing format builders.
  return nonStreamHttpResponse(resp, req.protocol);
}

// ---------------------------------------------------------------------------
// Session management helpers
// ---------------------------------------------------------------------------

function getOrCreateSession(
  sessionID: string,
  projectPath: string,
  pathSource: ProjectPathResult["source"] = "cwd",
): SessionState {
  let state = sessions.get(sessionID);
  if (!state) {
    // Restore persisted tracking state from DB (survives process restarts)
    const persisted = loadSessionTracking(sessionID);
    // Project binding (v36): a persisted binding must survive restart so the
    // session's project_id never splits. A persisted CONFIDENT binding wins
    // over the current request's path — otherwise a path-less first
    // post-restart turn would downgrade it to a provisional cwd/bucket and
    // strand the pre-restart rows under a different project_id. A persisted
    // PROVISIONAL binding is resumed (same path) so self-heal keeps targeting
    // the exact bucket where earlier rows were stored.
    //
    // ORDERING DEPENDENCY: callers MUST invoke getOrCreateSession() →
    // resolveSessionProjectPath() → the per-turn saveSessionTracking() in that
    // order. The rehydrated confident binding below is what makes
    // resolveSessionProjectPath()'s `hasConfident` short-circuit keep the known
    // path on a path-less turn; reordering these breaks restart continuity.
    const persistedConfident =
      !!persisted?.projectPath && persisted.projectPathProvisional === false;
    const persistedProvisional =
      !!persisted?.projectPath && persisted.projectPathProvisional === true;
    state = {
      sessionID,
      // A freshly-seeded path from the cwd fallback is NOT a confident binding.
      // Mark it provisional so a later header/inferred turn can overwrite it
      // (and self-heal any rows stored under the provisional path). Only
      // header/inferred seeds are confident.
      projectPath:
        persistedConfident || persistedProvisional
          ? (persisted?.projectPath as string)
          : projectPath,
      projectPathProvisional: persistedConfident
        ? false
        : persistedProvisional
          ? true
          : pathSource === "cwd",
      fingerprint: persisted?.fingerprint || "",
      lastRequestTime: Date.now(),
      lastUserTurnTime: 0,
      messageCount: persisted?.messageCount ?? 0,
      turnsSinceCuration: persisted?.turnsSinceCuration ?? 0,
      consecutiveTextOnlyTurns: persisted?.consecutiveTextOnlyTurns ?? 0,
      recallStore: new Map(),
      upstreamByProvider: new Map(),
      cacheAnalytics: {
        lastRequestBody: null,
        lastRequestBodyLength: 0,
        lastCacheRead: 0,
        lastCacheCreation: 0,
        turnCount: 0,
        bustCount: 0,
      },
    };

    // Restore session identity (v24) — prevents Tier 3 fallback on restart
    if (persisted?.headerSessionId && persisted.headerName) {
      state.headerSessionId = persisted.headerSessionId;
      state.headerName = persisted.headerName;
      // Rebuild headerSessionIndex for this session
      const indexKey = `${persisted.headerName}:${persisted.headerSessionId}`;
      headerSessionIndex.set(indexKey, sessionID);
    }

    // Restore cache warming state (v24) — preserves earned TTL tier
    if (persisted?.resolvedConversationTTL) {
      const ttl = persisted.resolvedConversationTTL;
      state.resolvedConversationTTL = ttl === "5m" || ttl === "1h" ? ttl : "5m";
    }
    if (persisted?.warmupState) {
      try {
        state.warmup = JSON.parse(persisted.warmupState);
      } catch {
        log.warn(
          `corrupt warmup state for session ${sessionID.slice(0, 16)}, starting fresh`,
        );
      }
    }

    // Restore sub-agent parent–child relationship (v26)
    if (persisted?.isSubagent) {
      state.isSubagent = true;
      if (persisted.parentSessionId) {
        state.parentSessionId = persisted.parentSessionId;
      }
    }

    // Restore compaction anomaly pending flag (v37) — triggers urgent
    // distillation on next turn after a client-side compaction dropped
    // message count by 50%+. Survives gateway restarts.
    if (persisted?.compactionAnomalyPending) {
      state.compactionAnomalyPending = true;
    }

    // Restore LTM cache/pin from DB
    if (persisted?.ltmCacheText != null && persisted.ltmCacheTokens != null) {
      ltmSessionCache.set(sessionID, {
        formatted: persisted.ltmCacheText,
        tokenCount: persisted.ltmCacheTokens,
      });
    }
    if (persisted?.ltmPinText != null && persisted.ltmPinTokens != null) {
      let entryKeys: string[] | undefined;
      if (persisted.ltmPinKeys != null) {
        try {
          const parsed = JSON.parse(persisted.ltmPinKeys);
          if (
            Array.isArray(parsed) &&
            parsed.every((k) => typeof k === "string")
          ) {
            entryKeys = parsed;
          }
        } catch {
          // Corrupt pin keys — leave undefined so the next turn re-pins once.
        }
      }
      ltmPinnedText.set(sessionID, {
        formatted: persisted.ltmPinText,
        tokenCount: persisted.ltmPinTokens,
        ...(entryKeys ? { entryKeys } : {}),
      });
    }
    // Restore the cross-turn dedup decision memo so the first post-restart turn
    // doesn't flip an already-cached message's full/collapsed form (v41).
    if (persisted?.dedupDecisions) {
      importDedupDecisions(sessionID, persisted.dedupDecisions);
    }
    sessions.set(sessionID, state);
  }
  state.prevRequestTime = state.lastRequestTime;
  state.lastRequestTime = Date.now();

  // Ensure recallStore exists (upgrade from older session state)
  if (!state.recallStore) {
    state.recallStore = new Map();
  }
  // Ensure upstreamByProvider exists (upgrade from older session state)
  if (!state.upstreamByProvider) {
    state.upstreamByProvider = new Map();
  }

  return state;
}

/**
 * Identify or create a session from the incoming request.
 *
 * Uses a multi-tier strategy:
 *  1. **Known headers** — `x-lore-session-id` (stable, checked first),
 *     `x-claude-code-session-id`, `x-session-id`, `x-session-affinity`.
 *     Immediate match, survives compaction & model changes.
 *  1a. **Cross-header migration** — when the primary known header is new
 *     (e.g. plugin upgrade), checks lower-priority headers for an existing
 *     session and re-indexes under the new header.
 *  1b. **Header value rotation** — when a known header name is present but
 *     its value changed (client restart), finds the predecessor session and
 *     resumes it instead of creating a new one.
 *  2. **Learned headers** — `x-` headers discovered via fingerprint-bootstrapped
 *     learning. Promoted after 3 stable turns + cross-session uniqueness.
 *  2.5. **Context markers** — `[lore:session-id=<hex>]` markers injected into
 *     user message context by the lore-hermes plugin's pre_llm_call hook.
 *  3. **Fingerprint fallback** — SHA-256 of first user message + auth suffix
 *     (no model). Message-count proximity for fork disambiguation.
 *
 * Priority: Tier 1 > 1a > 1b > Tier 2 > 2.5 > Tier 3.
 */

/** Pattern for `[lore:session-id=<hex>]` context markers. */
const LORE_SESSION_MARKER_RE = /\[lore:session-id=([a-f0-9]{8,64})\]/;
/** Pattern for `[lore:project=<path>]` context markers. */
const LORE_PROJECT_MARKER_RE = /\[lore:project=([^\]]+)\]/;
/** Matches any `[lore:...]` context marker (for stripping before upstream). */
const LORE_CONTEXT_MARKER_RE = /\[lore:(?:session-id|project)=[^\]]*\]\n?/g;

/** Maximum allowed length for a project path extracted from a context marker. */
const MAX_MARKER_PROJECT_PATH_LENGTH = 1024;

/**
 * Concatenate all text blocks from a message's content array.
 */
function messageText(msg: GatewayMessage): string {
  let out = "";
  for (const block of msg.content) {
    if (block.type === "text") out += block.text;
  }
  return out;
}

/**
 * Extract a Lore session ID from `[lore:session-id=...]` context markers
 * injected by the lore-hermes plugin's `pre_llm_call` hook.
 *
 * Scans the last user message only (the marker is appended each turn).
 */
export function extractSessionMarker(
  messages: GatewayMessage[],
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "user") continue;
    const match = messageText(messages[i]).match(LORE_SESSION_MARKER_RE);
    return match?.[1];
  }
  return undefined;
}

/**
 * Extract a Lore project path from `[lore:project=...]` context markers.
 *
 * Applies the same sanitization as `extractProjectHeader()` in config.ts:
 * control character stripping, length validation, absolute path check,
 * trailing slash removal, and path traversal rejection.
 *
 * Returns `undefined` when no marker is found or the path is invalid.
 */
export function extractProjectMarker(
  messages: GatewayMessage[],
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "user") continue;
    const match = messageText(messages[i]).match(LORE_PROJECT_MARKER_RE);
    if (match?.[1]) {
      // Strip control characters (same as extractProjectHeader in config.ts)
      // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control-character sanitization
      const sanitized = match[1].replace(/[\x00-\x1f\x7f]/g, "").trim();
      if (!sanitized || sanitized.length > MAX_MARKER_PROJECT_PATH_LENGTH)
        return undefined;
      // Must be an absolute path
      if (!sanitized.startsWith("/")) return undefined;
      // Reject path traversal
      if (sanitized.includes("..")) return undefined;
      return sanitized.replace(/\/+$/, "") || undefined;
    }
    return undefined;
  }
  return undefined;
}

/**
 * Strip `[lore:session-id=...]` and `[lore:project=...]` context markers
 * from user messages so they are not forwarded to the upstream LLM.
 *
 * Called after marker extraction but before forwarding the request upstream.
 * Mutates the message array in place.
 */
export function stripContextMarkers(messages: GatewayMessage[]): void {
  for (const msg of messages) {
    if (msg.role !== "user") continue;
    for (const block of msg.content) {
      if (block.type === "text" && LORE_CONTEXT_MARKER_RE.test(block.text)) {
        // Reset lastIndex since the regex has the global flag
        LORE_CONTEXT_MARKER_RE.lastIndex = 0;
        block.text = block.text.replace(LORE_CONTEXT_MARKER_RE, "").trimEnd();
      }
    }
  }
}

async function identifySession(
  req: GatewayRequest,
  _projectPath: string,
): Promise<{ sessionID: string; isNew: boolean; tier: 1 | 2 | 2.5 | 3 }> {
  const headers = req.rawHeaders;

  // --- Tier 1: Known headers ---
  // Sub-agent requests (carrying x-parent-session-id) are NOT merged into the
  // parent session. They carry their own x-session-affinity nanoid and get
  // independent sessions, benefiting from the full Lore pipeline (LTM,
  // gradient, distillation) on their own state without corrupting the parent.

  const known = extractKnownSessionHeader(headers);
  if (known) {
    const indexKey = `${known.headerName}:${known.sessionId}`;
    const existingSid = headerSessionIndex.get(indexKey);
    if (existingSid) {
      // Session may only exist in DB (after gateway restart) — that's fine,
      // getOrCreateSession() will hydrate it from the session_state table.
      return { sessionID: existingSid, isNew: false, tier: 1 };
    }

    // --- Tier 1a: Cross-header migration ---
    // The primary known header is new (e.g. plugin upgrade started sending
    // x-lore-session-id), but the request also contains a lower-priority
    // known header that IS already indexed (e.g. x-session-affinity from
    // before the upgrade). Re-index under the new header and resume.
    for (const fallbackName of KNOWN_SESSION_HEADERS) {
      if (fallbackName === known.headerName) continue; // skip the primary
      const fallbackValue = headers[fallbackName];
      if (!fallbackValue) continue;
      const fallbackKey = `${fallbackName}:${fallbackValue}`;
      const fallbackSid = headerSessionIndex.get(fallbackKey);
      if (fallbackSid) {
        // Migrate: index under the new (higher-priority) header.
        headerSessionIndex.set(indexKey, fallbackSid);
        saveSessionTracking(fallbackSid, {
          headerSessionId: known.sessionId,
          headerName: known.headerName,
        });
        // Update in-memory state if present.
        const inMemory = sessions.get(fallbackSid);
        if (inMemory) {
          inMemory.headerSessionId = known.sessionId;
          inMemory.headerName = known.headerName;
        }
        log.info(
          `session ${fallbackSid.slice(0, 16)}: migrated from ${fallbackName} to ${known.headerName}`,
        );
        return { sessionID: fallbackSid, isNew: false, tier: 1 };
      }
    }

    // --- Tier 1b: Header value rotation detection ---
    // Only for headers whose values may change on a client restart while the
    // logical session continues (e.g. OpenCode's x-session-affinity nanoid).
    // Headers like x-claude-code-session-id mint a fresh value per
    // *conversation* — a new value is always a genuinely new session, and
    // merging would collapse distinct conversations (and their projects) into
    // one, causing cross-project contamination on remote/multi-client gateways.
    const predecessor = !isRotationEligible(known.headerName)
      ? null
      : findRotationPredecessor(
          known.headerName,
          known.sessionId,
          headerSessionIndex,
          (sid) => {
            // Session may be in memory or only in DB (after gateway restart).
            const inMemory = sessions.get(sid);
            if (inMemory) {
              return {
                sid,
                isSubagent: !!inMemory.isSubagent,
                lastActiveAt: inMemory.lastRequestTime,
              };
            }
            // Lightweight DB check for recency and subagent status.
            const persisted = loadSessionTracking(sid);
            if (!persisted) return null; // orphaned index entry
            return {
              sid,
              isSubagent: persisted.isSubagent,
              // lastTurnAt=0 means gradient never ran yet — session is new,
              // treat as recently active (not infinitely stale).
              lastActiveAt:
                persisted.lastTurnAt > 0 ? persisted.lastTurnAt : Date.now(),
            };
          },
        );

    // Fix 2 (defense in depth): even for a rotation-eligible header, never
    // re-home a session onto a DIFFERENT confident project. If the incoming
    // request carries an explicit X-Lore-Project that disagrees with the
    // predecessor's bound project, this is not a benign restart — treat it as
    // a genuinely new session to avoid cross-project contamination.
    if (predecessor) {
      const incomingProject = extractProjectHeader(headers);
      if (incomingProject) {
        const predTracking = loadSessionTracking(predecessor.sid);
        const predProject = predTracking?.projectPath;
        const predConfident =
          !!predProject && predTracking?.projectPathProvisional === false;
        if (predConfident && predProject !== incomingProject) {
          log.warn(
            `session rotation refused (${known.headerName}): incoming project ` +
              `${incomingProject} differs from predecessor ${predecessor.sid.slice(0, 16)} ` +
              `project ${predProject} — creating a new session instead of merging.`,
          );
          const sessionID = generateSessionID();
          headerSessionIndex.set(indexKey, sessionID);
          // The old predecessor's index entry is intentionally preserved — the
          // old session is still valid and may receive requests with its nanoid.
          // It will age out via ROTATION_MAX_AGE_MS naturally. If another new
          // nanoid arrives later, the old entry creates an ambiguity (multiple
          // predecessors) → findRotationPredecessor returns null → new session.
          return { sessionID, isNew: true, tier: 1 };
        }
      }
    }

    if (predecessor) {
      // Resume the old session with the new header value.
      const oldKey = `${known.headerName}:${predecessor.oldHeaderValue}`;
      headerSessionIndex.delete(oldKey);
      headerSessionIndex.set(indexKey, predecessor.sid);

      // Update in-memory state if present.
      const inMemory = sessions.get(predecessor.sid);
      if (inMemory) {
        inMemory.headerSessionId = known.sessionId;
        inMemory.headerName = known.headerName;
      }

      // Persist the new header mapping immediately.
      saveSessionTracking(predecessor.sid, {
        headerSessionId: known.sessionId,
        headerName: known.headerName,
      });

      log.info(
        `session ${predecessor.sid.slice(0, 16)}: resumed via ${known.headerName} value rotation`,
      );
      return { sessionID: predecessor.sid, isNew: false, tier: 1 };
    }

    // Genuinely new session — no predecessor or ambiguous concurrent sessions.
    const sessionID = generateSessionID();
    headerSessionIndex.set(indexKey, sessionID);
    return { sessionID, isNew: true, tier: 1 };
  }

  // --- Tier 2: Learned headers ---
  // Check if any existing session has a promoted header that matches
  // a header value in the current request.
  for (const [sid, state] of sessions) {
    if (!state.headerSessionId || !state.headerName) continue;
    const currentValue = headers[state.headerName];
    if (currentValue && currentValue === state.headerSessionId) {
      return { sessionID: sid, isNew: false, tier: 2 };
    }
  }

  // --- Tier 2.5: Context markers (injected by Hermes plugin pre_llm_call) ---
  // The lore-hermes plugin injects [lore:session-id=<hex>] into the user
  // message context.  This is more reliable than fingerprint fallback (Tier 3)
  // but less authoritative than explicit headers (Tier 1).
  const markerSid = extractSessionMarker(req.messages);
  if (markerSid) {
    const markerKey = `context-marker:${markerSid}`;
    const existingSid = headerSessionIndex.get(markerKey);
    if (existingSid) {
      return { sessionID: existingSid, isNew: false, tier: 2.5 as const };
    }
    // New session identified via context marker.
    const sessionID = generateSessionID();
    headerSessionIndex.set(markerKey, sessionID);
    return { sessionID, isNew: true, tier: 2.5 as const };
  }

  // --- Tier 3: Fingerprint fallback ---
  const rawMessages = req.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));
  const cred = extractAuth(req.rawHeaders);
  const fingerprint = await fingerprintMessages(rawMessages, {
    authSuffix: cred ? authFingerprint(cred) : "",
  });
  const msgCount = req.messages.length;

  // Find the best matching session: same fingerprint + closest message count
  let bestMatch: { sid: string; countDiff: number } | null = null;

  for (const [sid, state] of sessions) {
    if (state.fingerprint !== fingerprint) continue;

    const diff = msgCount - state.messageCount;

    // Normal session: count grows by 2–6 per turn.
    // Fork: count drops significantly (parent at 600, fork at 300).
    // Reject if the count dropped too far (likely a fork).
    if (diff < -MESSAGE_COUNT_PROXIMITY_THRESHOLD) continue;

    const absDiff = Math.abs(diff);
    if (!bestMatch || absDiff < bestMatch.countDiff) {
      bestMatch = { sid, countDiff: absDiff };
    }
  }

  if (bestMatch) {
    // Run header learning on the matched session (Tier 2 bootstrap).
    const state = sessions.get(bestMatch.sid);
    if (state && !state.headerSessionId) {
      const result = learnHeaders(state.candidateHeaders, headers);
      state.candidateHeaders = result.updatedCandidates;
      if (result.promoted) {
        state.headerSessionId = result.promoted.value;
        state.headerName = result.promoted.name;
        // Index the promoted header for future Tier 2 lookups.
        const indexKey = `${result.promoted.name}:${result.promoted.value}`;
        headerSessionIndex.set(indexKey, bestMatch.sid);
        // Persist immediately — rare event, critical for post-restart correlation
        saveSessionTracking(bestMatch.sid, {
          headerSessionId: result.promoted.value,
          headerName: result.promoted.name,
        });
        log.info(
          `session ${bestMatch.sid.slice(0, 16)}: promoted header ${result.promoted.name} for Tier 2 identification`,
        );
      }
    }
    return { sessionID: bestMatch.sid, isNew: false, tier: 3 };
  }

  // No matching session → create new.
  const sessionID = generateSessionID();
  return { sessionID, isNew: true, tier: 3 };
}

// ---------------------------------------------------------------------------
// Upstream forwarding
// ---------------------------------------------------------------------------

/** Result from forwardToUpstream — includes the serialized body for cache analytics. */
type UpstreamResult = {
  response: Response;
  /** The serialized JSON body sent to the upstream provider. */
  serializedBody: string;
  /** The wire protocol used for the upstream request (may differ from ingress). */
  effectiveProtocol: "anthropic" | "openai" | "openai-responses";
};

/**
 * Forward a request to the upstream provider (Anthropic or OpenAI).
 *
 * When an interceptor is provided (or a module-level one is active), the
 * interceptor is called instead of `fetch` directly.  This enables recording
 * and replay without modifying individual call sites.
 *
 * Returns the raw fetch Response alongside the serialized request body
 * (for cache analytics prefix comparison).
 */
async function forwardToUpstream(
  req: GatewayRequest,
  config: GatewayConfig,
  interceptor?: UpstreamInterceptor,
  cache?: AnthropicCacheOptions,
): Promise<UpstreamResult> {
  let url: string;
  let headers: Record<string, string>;
  let body: unknown;

  // Resolve upstream URL and protocol via a four-tier priority chain:
  //   1. X-Lore-Upstream-URL header  (explicit user override)
  //   2. X-Lore-Provider header      (plugin identifies the provider)
  //      a. Static PROVIDER_ROUTES table (fast, no network)
  //      b. Dynamic models.dev lookup  (async, cached 1h, covers new providers)
  //   3. Model prefix route           (fallback for bare agents like Claude Code)
  //   4. Config defaults              (upstreamAnthropic / upstreamOpenAI)
  // Preserve "openai-responses" from ingress — model prefix routing returns
  // "openai" for OpenAI models, but we must not downgrade the wire protocol.
  const headerUpstream = extractUpstreamUrlHeader(req.rawHeaders);
  const providerID = extractProviderHeader(req.rawHeaders);
  let providerRoute = providerID ? resolveProviderRoute(providerID) : null;
  // Dynamic fallback: look up unknown providers from models.dev cache.
  // Non-blocking — returns cached data or null (triggers background refresh).
  if (!providerRoute && providerID) {
    providerRoute = lookupProviderRoute(providerID);
  }
  const modelRoute = resolveUpstreamRoute(req.model);

  // Only use provider route protocol when we also have a usable URL from it
  // (either providerRoute.url or headerUpstream). When url is null (local/
  // custom providers like vllm, github-copilot), the protocol should come
  // from whichever tier actually provides the URL to avoid mismatches.
  const providerRouteUsable =
    providerRoute && (providerRoute.url != null || headerUpstream)
      ? providerRoute
      : null;

  // Protocol resolution: provider routes with `protocol: null` are proxy/
  // aggregator providers (OpenCode Zen, Vercel AI Gateway) that accept
  // whichever protocol the client sent — preserve the ingress protocol.
  // Direct providers (DeepSeek, Groq, etc.) specify their protocol explicitly
  // so the gateway can translate (e.g., Claude Code → OpenAI-only backend).
  const effectiveProtocol =
    req.protocol === "openai-responses"
      ? "openai-responses"
      : (providerRouteUsable?.protocol ?? modelRoute?.protocol ?? req.protocol);

  const effectiveUpstreamBase =
    headerUpstream ??
    providerRoute?.url ??
    modelRoute?.url ??
    (effectiveProtocol === "anthropic"
      ? config.upstreamAnthropic
      : config.upstreamOpenAI);

  // Warn when a provider route exists but has no URL and no header override —
  // the request will fall through to config defaults which likely have wrong
  // credentials. The user should set LORE_UPSTREAM_<PROVIDER>=<url>.
  if (
    providerRoute?.url == null &&
    providerID &&
    !headerUpstream &&
    !modelRoute
  ) {
    log.warn(
      `provider "${providerID}" has no upstream URL configured — falling back to default. ` +
        `Set LORE_UPSTREAM_${providerID.toUpperCase().replace(/-/g, "_")}=<url> ` +
        `to route requests correctly.`,
    );
  }

  // Log which routing tier resolved the upstream — useful for diagnosing
  // provider routing issues without guessing.
  const routingAuth = extractAuth(req.rawHeaders);
  log.info(
    `upstream: ${effectiveUpstreamBase} ` +
      `(provider=${providerID ?? "none"}, ` +
      `providerURL=${providerRoute?.url ?? "none"}, ` +
      `modelRoute=${modelRoute?.url ?? "none"}, ` +
      `headerUpstream=${headerUpstream ? "yes" : "no"}, ` +
      `protocol=${effectiveProtocol}, ` +
      `auth=${routingAuth ? `${routingAuth.scheme}:${routingAuth.value.slice(0, 8)}…` : "none"})`,
  );

  // Defense-in-depth: warn when a bearer token prefix clearly mismatches
  // the resolved upstream. Catches misrouting before the upstream rejects it.
  if (
    routingAuth?.scheme === "bearer" &&
    routingAuth.value.startsWith("gho_") &&
    !effectiveUpstreamBase.includes("githubcopilot")
  ) {
    log.error(
      `auth/upstream mismatch: GitHub OAuth token (gho_) routed to ${effectiveUpstreamBase} — ` +
        `provider: ${providerID ?? "none"}`,
    );
  }

  if (effectiveProtocol === "openai-responses") {
    // Inject LTM into system prompt for non-Anthropic paths.
    // Anthropic handles LTM via separate system blocks in buildAnthropicRequest;
    // OpenAI paths receive a single system string, so we concatenate here.
    const ltmParts = [cache?.stableLtmSystem, cache?.ltmSystem].filter(Boolean);
    const reqWithLtm = ltmParts.length
      ? {
          ...req,
          system: [req.system, ...ltmParts].filter(Boolean).join("\n\n"),
        }
      : req;
    const result = buildOpenAIResponsesUpstreamRequest(
      reqWithLtm,
      effectiveUpstreamBase,
    );
    url = result.url;
    headers = result.headers;
    body = result.body;
  } else if (effectiveProtocol === "openai") {
    // Inject LTM into system prompt (see comment above for openai-responses).
    const ltmParts = [cache?.stableLtmSystem, cache?.ltmSystem].filter(Boolean);
    const reqWithLtm = ltmParts.length
      ? {
          ...req,
          system: [req.system, ...ltmParts].filter(Boolean).join("\n\n"),
        }
      : req;
    const result = buildOpenAIUpstreamRequest(
      reqWithLtm,
      effectiveUpstreamBase,
    );
    url = result.url;
    headers = result.headers;
    body = result.body;
  } else {
    // For non-native-Anthropic upstreams (MiniMax, Fireworks, etc.), downgrade
    // extended cache TTL ("1h") to standard 5-minute ephemeral — the "1h" TTL
    // is an Anthropic beta extension that third-party endpoints may reject.
    // Standard cache_control breakpoints with bare ephemeral are kept (widely
    // supported) so third-party providers still benefit from prompt caching.
    const isNativeAnthropic =
      effectiveUpstreamBase === "https://api.anthropic.com";
    const effectiveCache =
      cache && !isNativeAnthropic
        ? {
            ...cache,
            systemTTL: "5m" as const,
            conversationTTL: "5m" as const,
          }
        : cache;
    const result = buildAnthropicRequest(req, effectiveCache);
    url = `${effectiveUpstreamBase}${result.url}`;
    headers = result.headers;
    body = result.body;
  }

  // Apply user-supplied LORE_UPSTREAM_EXTRA_HEADERS as the final overlay so
  // corporate proxies, LiteLLM team-routing tokens, Cloudflare AI Gateway
  // auth, and service-account scenarios can override any header — including
  // the gateway-reconstructed `x-api-key` / `Authorization`.
  applyUpstreamExtraHeaders(headers, config.upstreamExtraHeaders);

  let serializedBody = JSON.stringify(body);

  // Re-sign the billing header cch after body reconstruction.
  // buildAnthropicRequest completely rebuilds the body (different JSON key
  // ordering, cache_control wrappers, toAnthropicBlock transforms) which
  // invalidates the client's original cch signature. resignBody detects
  // billing headers and re-signs with our known seed + version.
  if (effectiveProtocol === "anthropic") {
    const firstUserMsg = req.messages.find((m) => m.role === "user");
    const firstUserText = firstUserMsg?.content.find(
      (b) => b.type === "text" && "text" in b,
    );
    serializedBody = resignBody(
      serializedBody,
      (firstUserText as { text: string } | undefined)?.text ?? "",
    );
  }

  const effectiveInterceptor = interceptor ?? activeInterceptor;

  if (effectiveInterceptor) {
    const response = await effectiveInterceptor(
      body,
      req.model,
      req.stream,
      () =>
        upstreamFetch(url, {
          method: "POST",
          headers,
          body: serializedBody,
        }),
    );
    return { response, serializedBody, effectiveProtocol };
  }

  const response = await upstreamFetch(url, {
    method: "POST",
    headers,
    body: serializedBody,
  });
  return { response, serializedBody, effectiveProtocol };
}

// ---------------------------------------------------------------------------
// Response builders
// ---------------------------------------------------------------------------

/**
 * Create a streaming SSE response from upstream with parallel accumulation.
 *
 * When `recallContext` is provided, uses a recall-aware accumulator that
 * transparently intercepts recall tool_use blocks:
 *  - **Case 1 (recall-only)**: pauses client stream, executes recall, sends
 *    a follow-up request, and pipes the continuation into the same HTTP
 *    response stream.
 *  - **Case 2 (mixed tools)**: suppresses recall blocks, stores the pending
 *    result for injection into the next request.
 */
function buildStreamingResponse(
  upstreamResponse: Response,
  onComplete: (response: GatewayResponse) => void,
  recallContext?: {
    modifiedReq: GatewayRequest;
    config: GatewayConfig;
    sessionState: SessionState;
    cacheOptions: AnthropicCacheOptions;
  },
  /** When set, prepend a synthetic warning content block to the stream. */
  warningText?: string,
): Response {
  const recallAccum = recallContext
    ? createRecallAwareAccumulator(RECALL_TOOL_NAME, { scaleClientUsage: true })
    : null;
  const accumulator: StreamAccumulator =
    recallAccum ?? createStreamAccumulator({ scaleClientUsage: true });
  const encoder = new TextEncoder();

  // Client-disconnect detection: shared between start() and cancel()
  let cancelled = false;
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  // --- Keepalive ping timer ---
  // Emits SSE `ping` events on the client-facing stream when no upstream
  // events arrive for KEEPALIVE_INACTIVITY_MS. This prevents Bun's hardcoded
  // ~5-min fetch timeout (oven-sh/bun#16682) from killing the client↔gateway
  // connection during long thinking pauses, recall execution, or follow-up
  // requests. `ping` is a first-class no-op event in Anthropic's SSE protocol
  // and is explicitly skipped by the OpenAI/Responses stream translators.
  const KEEPALIVE_INACTIVITY_MS = 30_000; // 30s — well under Bun's ~5-min cap
  const pingEvent = encoder.encode(
    formatSSEEvent("ping", JSON.stringify({ type: "ping" })),
  );
  let keepaliveTimer: ReturnType<typeof setTimeout> | null = null;

  const stream = new ReadableStream({
    async start(controller) {
      // Guard helpers for client-disconnect safety
      const safeEnqueue = (data: Uint8Array): boolean => {
        if (cancelled) return false;
        try {
          controller.enqueue(data);
          return true;
        } catch {
          cancelled = true;
          return false;
        }
      };
      const safeClose = (): void => {
        if (cancelled) return;
        try {
          controller.close();
        } catch {
          // Already closed/cancelled
        }
      };

      /** Reset the keepalive inactivity timer. Call on every upstream event. */
      const resetKeepalive = (): void => {
        if (keepaliveTimer) clearTimeout(keepaliveTimer);
        keepaliveTimer = setTimeout(function tick() {
          if (cancelled) return;
          safeEnqueue(pingEvent);
          // Re-arm: keep pinging every KEEPALIVE_INACTIVITY_MS until an
          // upstream event arrives (which calls resetKeepalive) or the
          // stream closes (which calls clearKeepalive).
          keepaliveTimer = setTimeout(tick, KEEPALIVE_INACTIVITY_MS);
        }, KEEPALIVE_INACTIVITY_MS);
      };
      const clearKeepalive = (): void => {
        if (keepaliveTimer) clearTimeout(keepaliveTimer);
        keepaliveTimer = null;
      };

      try {
        // Parse and forward upstream SSE events
        if (!upstreamResponse.body) {
          throw new Error("Upstream response has no body");
        }
        const reader = upstreamResponse.body.getReader();
        activeReader = reader;

        // When a warning needs to be prepended to the response, we emit a
        // synthetic text content block after any leading thinking blocks,
        // then offset all subsequent real content block indices by 1.
        // The accumulator sees the original (un-offset) data so postResponse()
        // gets the clean response — only the client stream has the warning.
        // Thinking blocks are forwarded at their original indices to preserve
        // the expected ordering (clients may inspect the first block's type).
        let warningEmitted = false;
        let inThinking = false;
        let warningBlockIndex = 0; // incremented past thinking blocks
        const warningOffset = warningText ? 1 : 0;

        resetKeepalive();
        for await (const { event, data } of parseSSEStream(reader)) {
          resetKeepalive(); // upstream is alive — reset inactivity timer
          const forwarded = accumulator.processEvent(event, data);
          if (forwarded) {
            // --- Warning injection: skip thinking blocks, inject before first text/tool block ---
            if (warningText && !warningEmitted) {
              if (event === "message_start" || event === "ping") {
                // Forward as-is, no action needed
                if (!safeEnqueue(encoder.encode(forwarded))) break;
                continue;
              }

              // Track thinking blocks — forward at original indices, no offset
              if (event === "content_block_start") {
                try {
                  const parsed = JSON.parse(data);
                  if (parsed.content_block?.type === "thinking") {
                    inThinking = true;
                    warningBlockIndex++;
                    if (!safeEnqueue(encoder.encode(forwarded))) break;
                    continue;
                  }
                } catch {
                  /* fall through to inject */
                }
              }
              if (inThinking) {
                if (event === "content_block_stop") inThinking = false;
                if (!safeEnqueue(encoder.encode(forwarded))) break;
                continue;
              }

              // First non-thinking content block — inject warning before it
              const blockStart = JSON.stringify({
                type: "content_block_start",
                index: warningBlockIndex,
                content_block: { type: "text", text: "" },
              });
              const blockDelta = JSON.stringify({
                type: "content_block_delta",
                index: warningBlockIndex,
                delta: { type: "text_delta", text: warningText },
              });
              const blockStop = JSON.stringify({
                type: "content_block_stop",
                index: warningBlockIndex,
              });
              const warningSSE =
                `event: content_block_start\ndata: ${blockStart}\n\n` +
                `event: content_block_delta\ndata: ${blockDelta}\n\n` +
                `event: content_block_stop\ndata: ${blockStop}\n\n`;
              if (!safeEnqueue(encoder.encode(warningSSE))) break;
              warningEmitted = true;
              // Fall through to offset and forward this event
            }

            // Offset content block indices to account for the injected warning block
            let toSend = forwarded;
            if (warningOffset > 0 && warningEmitted) {
              toSend = forwarded.replace(
                /^(data: )(.+)$/m,
                (_, prefix, jsonStr) => {
                  try {
                    const obj = JSON.parse(jsonStr);
                    if (typeof obj.index === "number") {
                      obj.index += warningOffset;
                      return prefix + JSON.stringify(obj);
                    }
                  } catch {
                    /* not JSON — leave as-is */
                  }
                  return prefix + jsonStr;
                },
              );
            }
            if (!safeEnqueue(encoder.encode(toSend))) break;
          }
        }

        // --- Recall interception (streaming) ---
        // Loop allows the model to call recall multiple times (e.g. drill
        // down into t:<id> source citations). Uses RecallAwareAccumulator
        // for each continuation stream to detect further recall calls.
        if (recallAccum?.hasRecall() && recallContext) {
          let currentAccum: RecallAwareAccumulator = recallAccum;
          let currentResp = recallAccum.getResponse();
          let currentBlockOffset = warningOffset; // accumulates across iterations
          let currentModifiedReq = recallContext.modifiedReq;
          let recallDepth = 0;

          // eslint-disable-next-line no-constant-condition
          while (true) {
            const recallBlock = findRecallToolUse(currentResp);
            if (!recallBlock) break;

            recallDepth++;
            const { result, input } = await executeRecall(
              recallBlock,
              recallContext.sessionState.projectPath,
              recallContext.sessionState.sessionID,
              getLLMClient(recallContext.config),
            );

            const scope = input.scope ?? "all";

            // Store recall result for marker round-trip expansion
            const storeKey = recallStoreKey(input.query, scope, input.id);
            const position = currentResp.content.indexOf(recallBlock);
            recallContext.sessionState.recallStore.set(storeKey, {
              toolUseId: recallBlock.id,
              input,
              position,
              result,
            });

            // Emit marker text block in place of the suppressed recall block
            const markerText = buildRecallMarker(input.query, scope, input.id);
            const markerIdx =
              currentAccum.clientBlockCount() + currentBlockOffset;
            const syntheticMarker = [
              formatSSEEvent(
                "content_block_start",
                JSON.stringify({
                  type: "content_block_start",
                  index: markerIdx,
                  content_block: { type: "text", text: "" },
                }),
              ),
              formatSSEEvent(
                "content_block_delta",
                JSON.stringify({
                  type: "content_block_delta",
                  index: markerIdx,
                  delta: { type: "text_delta", text: markerText },
                }),
              ),
              formatSSEEvent(
                "content_block_stop",
                JSON.stringify({
                  type: "content_block_stop",
                  index: markerIdx,
                }),
              ),
            ].join("");
            if (!safeEnqueue(encoder.encode(syntheticMarker))) {
              clearKeepalive();
              return;
            }

            if (currentAccum.hasOtherTools()) {
              // Mixed tools — forward held-back events, close stream
              log.info(
                `recall (stream, mixed, depth=${recallDepth}): stored result for session ` +
                  `${recallContext.sessionState.sessionID.slice(0, 16)}`,
              );

              const heldBack = currentAccum.heldBackEvents();
              if (heldBack) {
                safeEnqueue(encoder.encode(heldBack));
              }

              const markerResp = replaceRecallWithMarker(currentResp);
              clearKeepalive();
              onComplete(markerResp);
              safeClose();
              return;
            }

            // Recall-only — send follow-up, pipe continuation
            log.info(
              `recall (stream, depth=${recallDepth}): executing follow-up for session ` +
                `${recallContext.sessionState.sessionID.slice(0, 16)}`,
            );

            // Build (stream:true) + forward + assert-SSE + get reader in one
            // coupled call so the follow-up's stream flag can never diverge
            // from how the continuation is consumed (parseSSEStream below).
            // Disable conversation caching on the follow-up: the appended
            // recall result makes the prefix diverge from the next real turn,
            // so the cache write would be wasted money.
            const streamingRecallCtx: RecallFollowUpCtx = {
              forward: (r) =>
                forwardToUpstream(r, recallContext.config, undefined, {
                  ...recallContext.cacheOptions,
                  cacheConversation: false,
                }),
              // JSON parsing is unused on the streaming path (assertSSEResponse
              // guarantees an SSE body); provide a guard that throws if reached.
              parseJSON: () => {
                throw new Error(
                  "parseJSON must not be called on the streaming recall path",
                );
              },
            };

            let streamingFollowUp: Awaited<
              ReturnType<typeof runRecallFollowUpStreaming>
            >;
            try {
              streamingFollowUp = await runRecallFollowUpStreaming(
                streamingRecallCtx,
                currentModifiedReq,
                currentResp,
                result,
                recallBlock,
              );
            } catch (fetchErr) {
              log.error(
                `recall follow-up fetch error (depth=${recallDepth}) for session ${recallContext.sessionState.sessionID.slice(0, 16)}:`,
                fetchErr,
              );
              const heldBack = currentAccum.heldBackEvents();
              if (heldBack) {
                safeEnqueue(encoder.encode(heldBack));
              }
              const markerResp = replaceRecallWithMarker(currentResp);
              clearKeepalive();
              onComplete(markerResp);
              safeClose();
              return;
            }

            if (!streamingFollowUp.ok) {
              log.error(
                `recall follow-up upstream error: ${streamingFollowUp.status ?? "?"} ${streamingFollowUp.detail}`,
                new Error(
                  `recall follow-up upstream ${streamingFollowUp.status ?? "?"}`,
                ),
              );
              const heldBack = currentAccum.heldBackEvents();
              if (heldBack) {
                safeEnqueue(encoder.encode(heldBack));
              }
              const markerResp = replaceRecallWithMarker(currentResp);
              clearKeepalive();
              onComplete(markerResp);
              safeClose();
              return;
            }

            const followUp = streamingFollowUp.followUp;
            log.info(
              `recall follow-up response (depth=${recallDepth}): session=${recallContext.sessionState.sessionID.slice(0, 16)}`,
            );

            // Pipe the continuation stream through a recall-aware accumulator.
            // +1 accounts for the synthetic marker block just emitted.
            const contBlockOffset =
              currentAccum.clientBlockCount() + currentBlockOffset + 1;
            const contAccum = createRecallAwareAccumulator(RECALL_TOOL_NAME, {
              blockOffset: contBlockOffset,
              suppressMessageStart: true,
            });
            const contReader = streamingFollowUp.reader;
            activeReader = contReader;

            for await (const {
              event: contEvent,
              data: contData,
            } of parseSSEStream(contReader)) {
              resetKeepalive(); // continuation stream alive — reset timer
              const forwarded = contAccum.processEvent(contEvent, contData);
              if (forwarded) {
                // Forward non-recall, non-held-back events to client.
                // message_delta usage scaling is handled by a separate pass
                // below only for the final continuation's terminal events.
                if (!safeEnqueue(encoder.encode(forwarded))) break;
              }
            }

            log.info(
              `recall follow-up stream complete (depth=${recallDepth}): ` +
                `session=${recallContext.sessionState.sessionID.slice(0, 16)}`,
            );

            // Check if continuation contained recall — if so, loop
            if (contAccum.hasRecall() && recallDepth < MAX_RECALL_DEPTH) {
              currentAccum = contAccum;
              currentResp = contAccum.getResponse();
              currentBlockOffset = contBlockOffset;
              currentModifiedReq = followUp;
              continue; // Loop: execute the new recall, emit marker, follow up
            }

            // No more recall (or depth exhausted) — forward terminal events, close
            if (contAccum.hasRecall()) {
              log.warn(
                `recall depth exhausted (${MAX_RECALL_DEPTH}) in streaming path`,
              );
            }

            const heldBack = contAccum.heldBackEvents();
            if (heldBack) {
              // Scale usage in held-back message_delta for anti-compaction
              safeEnqueue(encoder.encode(heldBack));
            }

            const markerResp = replaceRecallWithMarker(
              contAccum.hasRecall() ? contAccum.getResponse() : currentResp,
            );
            clearKeepalive();
            onComplete(markerResp);
            safeClose();
            return;
          }
        }

        // No recall — normal path
        clearKeepalive();
        const response = accumulator.getResponse();
        onComplete(response);
        safeClose();
      } catch (err) {
        clearKeepalive();
        // Client disconnect / abort is benign — downgrade from error to info
        // to avoid Sentry noise from normal connection lifecycle events.
        const isAbort =
          err instanceof DOMException && err.name === "AbortError";
        if (isAbort) {
          log.info("streaming pipeline aborted (client disconnect)");
        } else {
          log.error("streaming pipeline error:", err);
        }
        try {
          controller.error(err);
        } catch {
          // Controller already closed or cancelled — error already logged above
        }
      }
    },
    cancel() {
      if (keepaliveTimer) clearTimeout(keepaliveTimer);
      keepaliveTimer = null;
      cancelled = true;
      try {
        activeReader?.cancel();
      } catch {
        /* ignore */
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

/**
 * Accumulate a non-streaming upstream response into a GatewayResponse.
 *
 * Dispatches to the correct parser based on the upstream wire protocol:
 *  - "anthropic": Anthropic Messages API format
 *  - "openai": OpenAI Chat Completions API format
 *  - "openai-responses": OpenAI Responses API format
 */
async function accumulateNonStreamResponse(
  upstreamResponse: Response,
  protocol: "anthropic" | "openai" | "openai-responses" = "anthropic",
): Promise<GatewayResponse> {
  // Some providers (e.g. DeepSeek) return SSE-formatted responses even when
  // stream: false was sent. Detect this via content-type and extract the JSON
  // payload from the SSE data lines instead of calling response.json() which
  // would throw a SyntaxError on "data: {...}" prefixed text.
  const ct = upstreamResponse.headers.get("content-type") ?? "";
  let json: Record<string, unknown>;
  if (ct.includes("text/event-stream")) {
    json = await extractJSONFromSSE(upstreamResponse);
  } else {
    json = (await upstreamResponse.json()) as Record<string, unknown>;
  }

  switch (protocol) {
    case "openai":
      return accumulateOpenAINonStreamJSON(json);
    case "openai-responses":
      return accumulateResponsesNonStreamJSON(json);
    default:
      return accumulateAnthropicNonStreamJSON(json);
  }
}

// Anthropic non-stream JSON → GatewayResponse: use shared parseAnthropicResponseJSON
const accumulateAnthropicNonStreamJSON = parseAnthropicResponseJSON;

function accumulateOpenAINonStreamJSON(
  json: Record<string, unknown>,
): GatewayResponse {
  const content: GatewayContentBlock[] = [];
  const choices = json.choices as Array<Record<string, unknown>> | undefined;
  const firstChoice = choices?.[0];
  const message = firstChoice?.message as Record<string, unknown> | undefined;

  if (message) {
    const textContent = message.content as string | undefined;
    if (textContent) {
      content.push({ type: "text", text: textContent });
    }
    const toolCalls = message.tool_calls as
      | Array<Record<string, unknown>>
      | undefined;
    if (toolCalls) {
      for (const tc of toolCalls) {
        const fn = tc.function as Record<string, unknown> | undefined;
        let input: unknown = {};
        if (typeof fn?.arguments === "string") {
          try {
            input = JSON.parse(fn.arguments as string);
          } catch {
            input = fn.arguments;
          }
        }
        content.push({
          type: "tool_use",
          id: String(tc.id ?? ""),
          name: String(fn?.name ?? ""),
          input,
        });
      }
    }
  }

  // Map OpenAI finish_reason to gateway stop reason
  const finishReason = firstChoice?.finish_reason as string | undefined;
  let stopReason = "end_turn";
  if (finishReason === "stop") stopReason = "end_turn";
  else if (finishReason === "length") stopReason = "max_tokens";
  else if (finishReason === "tool_calls") stopReason = "tool_use";

  const usage = json.usage as Record<string, unknown> | undefined;
  const promptTokensDetails = usage?.prompt_tokens_details as
    | Record<string, number>
    | undefined;

  return {
    id: String(json.id ?? ""),
    model: String(json.model ?? ""),
    content,
    stopReason,
    usage: {
      inputTokens: (usage?.prompt_tokens as number) ?? 0,
      outputTokens: (usage?.completion_tokens as number) ?? 0,
      cacheReadInputTokens: promptTokensDetails?.cached_tokens,
    },
  };
}

export function accumulateResponsesNonStreamJSON(
  json: Record<string, unknown>,
): GatewayResponse {
  const content: GatewayContentBlock[] = [];
  const output = json.output as Array<Record<string, unknown>> | undefined;

  if (output) {
    for (const item of output) {
      if (item.type === "message") {
        const msgContent = item.content as
          | Array<Record<string, unknown>>
          | undefined;
        if (msgContent) {
          for (const part of msgContent) {
            if (part.type === "output_text") {
              content.push({ type: "text", text: String(part.text ?? "") });
            }
          }
        }
      } else if (item.type === "function_call") {
        let input: unknown = {};
        if (typeof item.arguments === "string") {
          try {
            input = JSON.parse(item.arguments as string);
          } catch {
            input = item.arguments;
          }
        }
        content.push({
          type: "tool_use",
          id: String(item.call_id ?? item.id ?? ""),
          name: String(item.name ?? ""),
          input,
        });
      }
    }
  }

  // Map Responses API status to gateway stop reason
  const status = json.status as string | undefined;
  let stopReason = "end_turn";
  if (status === "incomplete") stopReason = "max_tokens";
  if (content.some((b) => b.type === "tool_use") && stopReason === "end_turn") {
    stopReason = "tool_use";
  }

  const usage = json.usage as Record<string, unknown> | undefined;
  const promptTokensDetails = usage?.prompt_tokens_details as
    | Record<string, number>
    | undefined;

  return {
    id: String(json.id ?? ""),
    model: String(json.model ?? ""),
    content,
    stopReason,
    usage: {
      inputTokens: (usage?.input_tokens as number) ?? 0,
      outputTokens: (usage?.output_tokens as number) ?? 0,
      cacheReadInputTokens: promptTokensDetails?.cached_tokens,
    },
  };
}

/**
 * Accumulate a streaming upstream Anthropic SSE response into a GatewayResponse.
 *
 * Used for Anthropic requests where we need to convert the accumulated
 * response to another format before returning to the client.
 */
async function _accumulateStreamResponse(
  upstreamResponse: Response,
): Promise<GatewayResponse> {
  const accumulator = createStreamAccumulator();
  if (!upstreamResponse.body) {
    throw new Error("Upstream response has no body");
  }
  const reader = upstreamResponse.body.getReader();

  for await (const { event, data } of parseSSEStream(reader)) {
    accumulator.processEvent(event, data);
  }

  return accumulator.getResponse();
}

/**
 * Accumulate a streaming upstream OpenAI Chat Completions SSE response
 * into a GatewayResponse.
 *
 * OpenAI SSE chunks have a different format from Anthropic:
 *   data: {"id":"...","choices":[{"delta":{"content":"..."},"finish_reason":null}]}
 */
async function accumulateNonStreamOpenAIStream(
  upstreamResponse: Response,
): Promise<GatewayResponse> {
  let id = "";
  let model = "";
  let stopReason = "end_turn";
  let textContent = "";
  const toolCalls = new Map<
    number,
    { id: string; name: string; args: string }
  >();
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens: number | undefined;

  if (!upstreamResponse.body) {
    throw new Error("Upstream response has no body");
  }
  const reader = upstreamResponse.body.getReader();

  for await (const { data } of parseSSEStream(reader)) {
    if (data === "[DONE]") break;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (typeof parsed.id === "string") id = parsed.id;
    if (typeof parsed.model === "string") model = parsed.model;

    const choices = parsed.choices as
      | Array<Record<string, unknown>>
      | undefined;
    const firstChoice = choices?.[0];
    if (firstChoice) {
      const delta = firstChoice.delta as Record<string, unknown> | undefined;
      if (delta) {
        if (typeof delta.content === "string") {
          textContent += delta.content;
        }
        const tcs = delta.tool_calls as
          | Array<Record<string, unknown>>
          | undefined;
        if (tcs) {
          for (const tc of tcs) {
            const idx = tc.index as number;
            const fn = tc.function as Record<string, unknown> | undefined;
            const existing = toolCalls.get(idx);
            if (!existing) {
              toolCalls.set(idx, {
                id: String(tc.id ?? ""),
                name: String(fn?.name ?? ""),
                args: String(fn?.arguments ?? ""),
              });
            } else {
              if (fn?.arguments) existing.args += fn.arguments;
            }
          }
        }
      }
      if (typeof firstChoice.finish_reason === "string") {
        const fr = firstChoice.finish_reason;
        if (fr === "stop") stopReason = "end_turn";
        else if (fr === "length") stopReason = "max_tokens";
        else if (fr === "tool_calls") stopReason = "tool_use";
      }
    }

    // Usage is typically in the final chunk
    const usage = parsed.usage as Record<string, unknown> | undefined;
    if (usage) {
      if (typeof usage.prompt_tokens === "number")
        inputTokens = usage.prompt_tokens as number;
      if (typeof usage.completion_tokens === "number")
        outputTokens = usage.completion_tokens as number;
      const details = usage.prompt_tokens_details as
        | Record<string, number>
        | undefined;
      if (details?.cached_tokens !== undefined)
        cachedTokens = details.cached_tokens;
    }
  }

  const content: GatewayContentBlock[] = [];
  if (textContent) {
    content.push({ type: "text", text: textContent });
  }
  for (const [, tc] of Array.from(toolCalls.entries()).sort(
    ([a], [b]) => a - b,
  )) {
    let input: unknown = {};
    if (tc.args) {
      try {
        input = JSON.parse(tc.args);
      } catch {
        input = tc.args;
      }
    }
    content.push({ type: "tool_use", id: tc.id, name: tc.name, input });
  }

  return {
    id,
    model,
    content,
    stopReason,
    usage: {
      inputTokens,
      outputTokens,
      cacheReadInputTokens: cachedTokens,
    },
  };
}

/**
 * Convert a GatewayResponse to a non-streaming HTTP Response.
 * Scales usage fields to prevent client auto-compaction.
 */
function nonStreamHttpResponse(
  resp: GatewayResponse,
  clientProtocol?: GatewayRequest["protocol"],
  clientStream?: boolean,
  extraHeaders?: Record<string, string>,
): Response {
  // Guard: resp.usage can be undefined at runtime for vLLM / partial responses.
  const usage = resp.usage ?? ZERO_USAGE;

  // Scale usage so the client's token total stays below auto-compact threshold.
  // postResponse() has already consumed the real values for calibration/bustRate.
  const scaledUsage = scaleUsageForClient({
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cache_read_input_tokens: usage.cacheReadInputTokens,
    cache_creation_input_tokens: usage.cacheCreationInputTokens,
  });
  const scaledResp: GatewayResponse = {
    ...resp,
    usage: {
      inputTokens: scaledUsage.input_tokens,
      outputTokens: scaledUsage.output_tokens,
      cacheReadInputTokens: scaledUsage.cache_read_input_tokens,
      cacheCreationInputTokens: scaledUsage.cache_creation_input_tokens,
    },
  };

  // Return the response in the client's native wire format so server handlers
  // can pass through without re-translation. This prevents the class of bugs
  // where the stream flag is forgotten during server-side format conversion.
  let clientResp: Response;
  if (clientProtocol === "openai") {
    clientResp = buildOpenAIResponse(scaledResp, clientStream ?? false);
  } else if (clientProtocol === "openai-responses") {
    clientResp = buildOpenAIResponsesResponse(
      scaledResp,
      clientStream ?? false,
    );
  } else {
    // Anthropic or unspecified — default format
    const body = buildAnthropicNonStreamResponse(scaledResp);
    clientResp = new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      clientResp.headers.set(k, v);
    }
  }
  return clientResp;
}

/**
 * Convert a GatewayResponse to a streaming SSE HTTP Response.
 */
function streamHttpResponse(resp: GatewayResponse): Response {
  // Guard: resp.usage can be undefined at runtime for vLLM / partial responses.
  const usage = resp.usage ?? ZERO_USAGE;

  // Build the full SSE text for a text-only response
  const textBlocks = resp.content.filter(
    (b): b is { type: "text"; text: string } => b.type === "text",
  );
  const fullText = textBlocks.map((b) => b.text).join("");

  const sseBody = buildSSETextResponse(resp.id, resp.model, fullText, {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  });

  return new Response(sseBody, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

// ---------------------------------------------------------------------------
// Post-response processing
// ---------------------------------------------------------------------------

/**
 * Run after a successful response: calibrate, store temporal messages,
 * and schedule background work (distillation, curation).
 */
function postResponse(
  req: GatewayRequest,
  resp: GatewayResponse,
  sessionState: SessionState,
  config: GatewayConfig,
  /** Serialized JSON body sent upstream — for cache prefix comparison. */
  requestBody?: string,
  /** Active gen_ai.chat span to finalize with usage attributes. */
  genAiSpan?: Sentry.Span,
): void {
  const { sessionID, projectPath } = sessionState;

  // Guard: resp.usage can be undefined at runtime for vLLM / partial responses.
  const usage = resp.usage ?? ZERO_USAGE;

  try {
    // --- Calibrate overhead from real token counts ---
    const actualInput =
      (usage.inputTokens ?? 0) +
      (usage.cacheReadInputTokens ?? 0) +
      (usage.cacheCreationInputTokens ?? 0);
    calibrate(actualInput, sessionID, getLastTransformedCount(sessionID));

    // --- Sentry cache context + cost metric ---
    setSentryCacheContext(usage);
    const usageForSentry: AnthropicUsage = {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cache_read_input_tokens: usage.cacheReadInputTokens,
      cache_creation_input_tokens: usage.cacheCreationInputTokens,
    };
    emitCostMetric(
      resp.model,
      usageForSentry,
      "conversation",
      sessionState.resolvedConversationTTL,
    );
    recordConversationCost(
      sessionID,
      resp.model,
      usageForSentry,
      sessionState.resolvedConversationTTL,
    );
    if (genAiSpan) {
      setGenAiUsageAttributes(genAiSpan, usageForSentry, resp.model);
    }

    // --- Cache analytics + bust cause telemetry ---
    // Run BEFORE genAiSpan.end() so we can enrich the span with
    // divergence diagnostics (divergence point, prefix match, bust cause).
    if (requestBody) {
      const turnAnalysis = analyzeCacheTurn(
        sessionState.cacheAnalytics,
        requestBody,
        usage,
        sessionID,
        sessionState.messageCount,
      );
      const bustCause = categorizeBust(
        turnAnalysis,
        sessionState.lastTurnWasIdle ?? false,
      );
      if (genAiSpan) {
        setCacheAnalyticsAttributes(
          genAiSpan,
          turnAnalysis,
          bustCause,
          turnAnalysis.prevSnippet,
          turnAnalysis.currSnippet,
        );
      }
      emitCacheBustMetric(
        bustCause,
        usage.cacheCreationInputTokens ?? 0,
        resp.model,
      );
      sessionState.lastTurnWasIdle = false; // consumed

      // Track cold-cache turns for auto-TTL upgrade (rolling 20-turn window)
      const cacheRead = usage.cacheReadInputTokens ?? 0;
      const cacheCreation = usage.cacheCreationInputTokens ?? 0;
      const isColdTurn = cacheRead === 0 && cacheCreation > 0;
      if (!sessionState.coldCacheWindow) sessionState.coldCacheWindow = [];
      sessionState.coldCacheWindow.push(isColdTurn);
      if (sessionState.coldCacheWindow.length > 20) {
        sessionState.coldCacheWindow.shift();
      }
    }

    // --- Finalize gen_ai.chat span (after cache analytics enrichment) ---
    if (genAiSpan) {
      genAiSpan.end();
    }

    // --- Consecutive bust tracking for tier-based decisions ---
    recordCacheUsage(
      usage.cacheCreationInputTokens ?? 0,
      usage.cacheReadInputTokens ?? 0,
      usage.inputTokens ?? 0,
      sessionState.sessionID,
    );

    // Capture previous stop reason before it's overwritten below (line ~1667).
    // Used to detect tool-use continuation turns for gap recording filtering.
    const prevStopReason = sessionState.lastStopReason;

    // --- Temporal storage & session-state updates ---
    // Store all messages (user + assistant) from this turn.
    // Convert gateway messages to Lore format.
    const loreMessages = gatewayMessagesToLore(req.messages, sessionID);

    // Skip temporal storage in amnesia mode or when x-lore-no-store is set.
    // The session still gets full Lore processing (LTM, recall, gradient)
    // but doesn't write to memory. Amnesia is session-scoped (toggle via
    // /lore:amnesia:on|off); no-store is per-request (header-based).
    // Note: tool-call outcomes for a tool_use seeded during a no-store turn are
    // intentionally dropped — the seed row never exists, so the later
    // tool_result UPDATE is a harmless no-op (no phantom 'pending' rows leak).
    const noStore =
      sessionState.amnesia || req.rawHeaders["x-lore-no-store"] === "true";
    if (!noStore) {
      // Store the latest user message BEFORE resolveToolResults — we want the
      // original content (including tool_result text), not the placeholder
      // "[tool results provided]" that resolveToolResults creates after merging.
      for (let i = loreMessages.length - 1; i >= 0; i--) {
        if (loreMessages[i].info.role === "user") {
          temporal.store({
            projectPath,
            info: loreMessages[i].info,
            parts: loreMessages[i].parts,
          });
          // The latest user message carries tool_result blocks that resolve
          // the PRIOR assistant turn's tool calls — record their outcomes
          // (status/error/duration) keyed by call_id.
          temporal.recordToolCalls({
            projectPath,
            info: loreMessages[i].info,
            parts: loreMessages[i].parts,
          });
          break;
        }
      }
    }

    // Resolve tool results for gradient transform (merges tool_result into
    // assistant parts, strips from user messages — needed for reconstruct-
    // after-eviction pattern but not for temporal storage above).
    resolveToolResults(loreMessages);

    if (!noStore) {
      // Build and store the assistant response message.
      // Strip recall marker text blocks — they contain the raw query string
      // and pollute FTS results with self-referential noise.
      const assistantContent = resp.content.filter(
        (b) => !(b.type === "text" && isRecallMarker(b.text)),
      );
      const assistantMsg = gatewayMessagesToLore(
        [{ role: "assistant", content: assistantContent }],
        sessionID,
      )[0];
      updateAssistantMessageTokens(assistantMsg, usage, resp.model);
      if (assistantContent.length > 0) {
        temporal.store({
          projectPath,
          info: assistantMsg.info,
          parts: assistantMsg.parts,
        });
      }
      // Always record structured tool-call traces — even when the assistant
      // content is empty after recall-marker stripping, or when partsToText
      // would produce empty content (tool-only / all-failed turns). Tool parts
      // survive the text-only recall-marker filter above.
      temporal.recordToolCalls({
        projectPath,
        info: assistantMsg.info,
        parts: assistantMsg.parts,
      });
    }

    // Update session state (persisted in the batched save after messageCount update)
    sessionState.turnsSinceCuration =
      (sessionState.turnsSinceCuration ?? 0) + 1;

    // --- Track consecutive text-only end_turn responses (session-end heuristic) ---
    const hasToolUse = resp.content.some((b) => b.type === "tool_use");
    if (resp.stopReason === "end_turn" && !hasToolUse) {
      sessionState.consecutiveTextOnlyTurns =
        (sessionState.consecutiveTextOnlyTurns ?? 0) + 1;
    } else {
      sessionState.consecutiveTextOnlyTurns = 0;
    }

    // --- Output tracking for dynamic max_tokens sizing ---
    sessionState.lastStopReason = resp.stopReason;
    sessionState.lastInputTokens =
      (usage.inputTokens ?? 0) +
      (usage.cacheReadInputTokens ?? 0) +
      (usage.cacheCreationInputTokens ?? 0);
    const outputTokens = usage.outputTokens;
    if (outputTokens > 0) {
      const EMA_ALPHA = 0.3;
      sessionState.outputTokensEMA =
        sessionState.outputTokensEMA == null
          ? outputTokens
          : Math.round(
              sessionState.outputTokensEMA * (1 - EMA_ALPHA) +
                outputTokens * EMA_ALPHA,
            );
    }

    // --- Cache warming: record inter-turn gap + track warmup hits ---
    const now = Date.now();

    // (A) Record inter-turn gap — only for genuine user-initiated turns.
    // Tool-use auto-continuations (prior stop_reason was "tool_use") produce
    // sub-second gaps that represent automated round-trips, not human think
    // time. Recording these would skew the survival model toward very short
    // return times.
    const isToolUseContinuation = prevStopReason === "tool_use";
    if (!isToolUseContinuation) {
      if (sessionState.lastUserTurnTime > 0) {
        const gap = now - sessionState.lastUserTurnTime;
        recordGap(getSessionHistogram(sessionState), gap);
        recordGlobalGap(sessionState.projectPath, gap);
      }
      // Update baseline for next gap measurement — only after recording.
      sessionState.lastUserTurnTime = now;
    }

    // (B) Track warmup hits and TTL savings — valid for ALL turn types.
    // A user returning after a warmup is a hit regardless of whether it's
    // a tool-use continuation.
    // NOTE: warmup hits and TTL savings are mutually exclusive — if a turn
    // is attributed to a warmup hit, skip TTL savings to avoid double-counting
    // the same cacheReadTokens in both buckets.
    if (sessionState.lastRequestTime > 0) {
      let warmupHitThisTurn = false;

      // Track warmup hit: user returned after we warmed the cache.
      // A warmup can only benefit the FIRST turn after it fires — clear
      // lastWarmupAt unconditionally so subsequent turns are not attributed.
      if (sessionState.warmup?.lastWarmupAt) {
        const ttlMs =
          sessionState.resolvedConversationTTL === "1h" ? 3_600_000 : 300_000;
        const sinceWarmup = now - sessionState.warmup.lastWarmupAt;
        sessionState.warmup.lastWarmupAt = 0;
        if (sinceWarmup < ttlMs) {
          warmupHitThisTurn = true;
          sessionState.warmup.warmupHits++;
          emitWarmupHitMetric(
            sessionState.lastUpstream?.model ?? req.model,
            sessionState.resolvedConversationTTL ?? "5m",
          );
          // Record counterfactual savings: without warming, these cache
          // reads would have been full cache writes.
          const cacheRead = usage.cacheReadInputTokens ?? 0;
          if (cacheRead > 0) {
            recordWarmupHit(
              sessionID,
              req.model,
              cacheRead,
              sessionState.resolvedConversationTTL ?? "5m",
            );
          }
          log.info(
            `cache-warmer: HIT session=${sessionID.slice(0, 16)} ` +
              `user returned ${(sinceWarmup / 1000).toFixed(0)}s after warmup`,
          );
        }
      }

      // Track 1h TTL savings: if gap > 5m but we still got cache reads,
      // the 1h TTL saved a full cache write. Skip if already counted as
      // a warmup hit to avoid double-counting the same tokens.
      if (!warmupHitThisTurn) {
        const requestGap = now - sessionState.lastRequestTime;
        if (requestGap > 300_000) {
          const cacheRead = usage.cacheReadInputTokens ?? 0;
          if (cacheRead > 0) {
            recordTTLSavings(sessionID, req.model, cacheRead);
          }
        }
      }
    }
    // Capture the full routing snapshot from this request. Workers, cache
    // warmer, and idle handler all read from this single source of truth
    // instead of reconstructing from individual last* fields.
    const lpProvider = extractProviderHeader(req.rawHeaders);
    const lpRoute = lpProvider ? resolveProviderRoute(lpProvider) : null;
    const lpHeaderUpstream = extractUpstreamUrlHeader(req.rawHeaders);
    const lpRouteUsable =
      lpRoute && (lpRoute.url != null || lpHeaderUpstream) ? lpRoute : null;
    const snapshotProtocol: "anthropic" | "openai" | "openai-responses" =
      req.protocol === "openai-responses"
        ? "openai-responses"
        : (lpRouteUsable?.protocol ??
          resolveUpstreamRoute(req.model)?.protocol ??
          req.protocol);

    const upstreamSnapshot: UpstreamSnapshot = {
      url: lpHeaderUpstream ?? lpRoute?.url ?? "",
      protocol: snapshotProtocol,
      providerID: lpProvider || undefined,
      model: req.model,
      headers: forwardClientHeaders(req.rawHeaders),
    };
    // Apply LORE_UPSTREAM_EXTRA_HEADERS to the snapshot so cache-warming
    // and other session-level follow-up requests inherit the user-supplied
    // extra headers. (The per-request `forwardToUpstream` already overlays
    // extras on the actual upstream call — this keeps the snapshot in sync
    // for any consumer that reads it back.)
    applyUpstreamExtraHeaders(
      upstreamSnapshot.headers,
      config.upstreamExtraHeaders,
    );
    // Detect provider switch: if the model or provider changed, the cached
    // warmup body is stale (different model field at byte 10). Clear it to
    // avoid false cache-bust warnings ("early divergence at byte 10") and
    // wasted warmup requests that can never hit the cache prefix.
    const prevUpstream = sessionState.lastUpstream;
    if (
      prevUpstream &&
      (prevUpstream.model !== upstreamSnapshot.model ||
        prevUpstream.providerID !== upstreamSnapshot.providerID)
    ) {
      sessionState.cacheAnalytics.lastRequestBody = null;
    }

    sessionState.lastUpstream = upstreamSnapshot;
    // Store per-provider snapshot so workers/cache-warmer can look up the
    // correct URL and credentials when the session uses multiple providers.
    if (upstreamSnapshot.providerID) {
      sessionState.upstreamByProvider.set(
        upstreamSnapshot.providerID,
        upstreamSnapshot,
      );
    }

    // Reset warming state if session was marked dead or had active warming.
    // Dead flag is cleared so the next break gets a fresh ROI analysis.
    // warmupCount is reset so the break-even cap starts from 0 on the next break.
    if (sessionState.warmup) {
      if (sessionState.warmup.disabled) {
        sessionState.warmup.disabled = false;
        log.info(
          `cache-warmer: re-enabled session=${sessionID.slice(0, 16)} (user resumed)`,
        );
      }
      if (
        sessionState.warmup.warmupCount > 0 &&
        !sessionState.warmup.forceKeepWarm
      ) {
        sessionState.warmup.warmupCount = 0;
      }
    }

    // --- Shadow context tracking for counterfactual compaction estimation ---
    // Track how large the context *would* be without Lore's distillation
    // compressing it. When the shadow counter crosses the auto-compact
    // threshold, record a counterfactual compaction event.
    updateShadowContext(
      sessionID,
      actualInput,
      usage.outputTokens ?? 0,
      getWorkerModel(sessionState.lastUpstream)?.modelID ?? "unknown",
      req.model,
      sessionState.resolvedConversationTTL,
    );

    // Mark session dirty for periodic flush (gradient + warming + costs).
    // The 30s idle tick will persist state only for dirty sessions.
    sessionState._dirty = true;

    // --- Commit-triggered curation ---
    // Git commits are natural task boundaries where decisions crystallize.
    // When a commit is detected in tool outputs, force curation to trigger
    // on this turn by bumping turnsSinceCuration to the threshold.
    if (
      loreConfig().knowledge.enabled &&
      loreConfig().curator.onIdle &&
      containsGitCommit(req)
    ) {
      const modelInputCost =
        getModelEntrySync(
          getWorkerModel(sessionState.lastUpstream)?.modelID ?? "unknown",
        ).cost?.input ?? 3;
      const curationMultiplier =
        modelInputCost >= 5 ? 3 : modelInputCost >= 1 ? 2 : 1;
      const effectiveAfterTurns =
        loreConfig().curator.afterTurns * curationMultiplier;
      if (sessionState.turnsSinceCuration < effectiveAfterTurns) {
        log.info(
          `commit detected in session ${sessionID.slice(0, 16)} — triggering curation`,
        );
        sessionState.turnsSinceCuration = effectiveAfterTurns;
      }
    }

    // --- Schedule background work (fire-and-forget) ---
    if (!noStore) {
      scheduleBackgroundWork(sessionState, config);
    }
  } catch (e) {
    log.error("post-response processing failed:", e);
  }
}

/**
 * Schedule background distillation and curation (fire-and-forget).
 */
function scheduleBackgroundWork(
  sessionState: SessionState,
  config: GatewayConfig,
): void {
  const { sessionID, projectPath } = sessionState;

  // Skip background work when the session's auth credential is stale and no
  // fresh fallback is available — worker LLM calls would just 401.
  // Auth refreshes when the next client request arrives via setSessionAuth().
  if (isAuthStale(sessionID) && !resolveAuth(sessionID)) return;

  const llm = getLLMClient(config);
  const cfg = loreConfig();
  const model = getWorkerModel(sessionState.lastUpstream);
  // Provider the worker will call — used to scope the circuit-breaker check so
  // a 429 from a DIFFERENT provider doesn't pause this session's background
  // work. Undefined when the worker model can't be resolved (→ global breaker).
  const workerProviderID = model?.providerID;

  // When the OAuth account is near quota exhaustion, skip non-urgent
  // background work to preserve remaining entitlement for user-facing turns.
  // Urgent distillation is exempt (it unblocks the next user turn).
  const quotaPaused = isQuotaPaused(resolveAuth(sessionID));

  // Worker circuit breaker: when background workers have been failing for a
  // sustained period, stop hammering the upstream every turn — allow only a
  // periodic probe so a recovered upstream is detected without burning
  // thousands of futile calls (Sentry: runaway lore-distill failure counts).
  // Urgent distillation below is intentionally exempt — it unblocks the user.
  // Also throttle sessions soft-paused by an upstream credit/billing state
  // (HTTP 402) — retrying the failing provider every turn just wastes calls;
  // a probe is allowed periodically (see isWorkerCreditPaused) to detect a
  // credit top-up.
  const workerThrottled =
    !allowWorkerProbe(sessionID) || isWorkerCreditPaused(sessionID);

  // Check if urgent distillation is needed (gradient flagged it OR a
  // compaction anomaly was detected on the previous turn). Mark urgent: true
  // so these bypass the batch queue — the gradient is in overflow (or the
  // client just compacted) and needs the result before the next user turn.
  // Under bust pressure (3+ consecutive busts), lower the meta-distillation
  // threshold to consolidate gen-0 segments earlier — shrinks the distilled
  // prefix before the session becomes unsustainable.
  //
  // Note: urgent distillation is NOT gated by isBackgroundPaused() — a
  // degraded/overflowing context window for up to 10 minutes (max breaker
  // duration) is worse than one API call with its own tight retry budget
  // (MAX_RETRIES_URGENT = 2, 1-4s backoff).
  const urgentFromGradient = needsUrgentDistillation(sessionState.sessionID);
  const urgentFromCompaction = sessionState.compactionAnomalyPending === true;
  if (urgentFromCompaction) {
    // Consume the one-shot flag immediately so the next non-compaction
    // turn doesn't re-trigger urgent distillation. Persisted with the
    // session-tracking save below.
    sessionState.compactionAnomalyPending = false;
    saveSessionTracking(sessionID, { compactionAnomalyPending: false });
  }
  if (urgentFromGradient || urgentFromCompaction) {
    const busts = getConsecutiveBusts(sessionState.sessionID);
    const lowered = computeMetaThreshold(busts, cfg.distillation.metaThreshold);
    const metaThresholdOverride =
      lowered < cfg.distillation.metaThreshold ? lowered : undefined;
    distillation
      .run({
        llm,
        projectPath,
        sessionID,
        model,
        force: true,
        urgent: true,
        callType: "direct",
        metaThresholdOverride,
      })
      .catch((e) => log.error("background distillation failed:", e));
  } else if (
    !isBackgroundPaused(workerProviderID) &&
    !quotaPaused &&
    !workerThrottled
  ) {
    // Incremental distillation and curation are non-urgent — skip when the
    // circuit breaker is active to reduce API pressure. These are also gated
    // by runBackground() which checks isBackgroundPaused(), but the early
    // check here avoids unnecessary token counting and model lookups.
    // Idle-time work in idle.ts also uses runBackground(), so under sustained
    // rate pressure everything defers until the breaker naturally expires.
    //
    // Coalesce: if a distillation is already in-flight or queued for THIS
    // session (distillLimiter is per-session p-limit(1)), skip scheduling
    // another. The in-flight run will pick up the newly-arrived tokens on
    // its next segment pass, and queuing duplicates just starves the global
    // p-limit(2) background slot — distillations getting blocked behind
    // each other in the global queue.
    if (!distillLimiter.isBusy(sessionID)) {
      const pendingTokens = temporal.undistilledTokens(projectPath, sessionID);
      if (pendingTokens >= cfg.distillation.maxSegmentTokens) {
        log.info(
          `incremental distillation: ${pendingTokens} undistilled tokens in ${sessionID.slice(0, 16)}`,
        );
        runBackground(
          () =>
            distillation.run({
              llm,
              projectPath,
              sessionID,
              model,
              skipMeta: true,
              callType: batchQueueEnabled ? "batch" : "direct",
              workerHealth: makeWorkerHealth(sessionID, "lore-distill"),
            }),
          `incremental-distill session=${sessionID.slice(0, 16)}`,
          workerProviderID,
        ).catch((e) => log.error("background distillation failed:", e));
      }
    }
  }

  // Curation: run periodically when the knowledge system is enabled.
  // Cost-aware frequency: on expensive models, curate less often to reduce
  // the probability of LTM changes that bust the cache. Each LTM change
  // that exceeds the diff pinning threshold invalidates tools + messages.
  // Also gated by circuit breaker — curation is never urgent.
  // Quota-paused accounts skip curation too (non-urgent background work).
  // Worker-throttled sessions (sustained worker failure) skip it as well.
  if (isBackgroundPaused(workerProviderID) || quotaPaused || workerThrottled)
    return;

  const modelInputCost =
    getModelEntrySync(
      getWorkerModel(sessionState.lastUpstream)?.modelID ?? "unknown",
    ).cost?.input ?? 3;
  const curationMultiplier =
    modelInputCost >= 5 ? 3 : modelInputCost >= 1 ? 2 : 1;
  const effectiveAfterTurns = cfg.curator.afterTurns * curationMultiplier;

  // Coalesce: skip scheduling curation when one is already scheduled, queued,
  // or in-flight for THIS session. Without this, `turnsSinceCuration` stays
  // at/above the threshold (it is only reset in the `.then()` after a run
  // completes — see below), so every subsequent turn re-schedules curation,
  // flooding the background queue with duplicates that are shed at queue-full.
  //
  // Two signals are required:
  //  - `curationScheduled` (synchronous): set BEFORE runBackground() and
  //    cleared in .finally(). `curatorLimiter` is only entered when the task
  //    actually executes inside curator.run(), so under a saturated global
  //    queue `isBusy` stays false between scheduling and execution — this flag
  //    closes that window deterministically.
  //  - `curatorLimiter.isBusy` (durable across ticks): also covers the
  //    idle-path curation (idle.ts) which doesn't set curationScheduled.
  // Mirrors the incremental-distill guard above and the idle-path guard.
  // In-flight (turn-based) curation is OFF by default: changing the knowledge
  // base mid-conversation rewrites system[2] (context-bound LTM) and busts the
  // prompt cache for the rest of a large session. Curation still runs on idle
  // (idle.ts), where the cache is cold so the rewrite is free. `turnsSinceCuration`
  // keeps accumulating during the active conversation and fires on the next idle.
  if (
    shouldRunInFlightCuration({
      knowledgeEnabled: cfg.knowledge.enabled,
      inFlight: cfg.curator.inFlight,
      turnsSinceCuration: sessionState.turnsSinceCuration,
      effectiveAfterTurns,
      curationScheduled: !!sessionState.curationScheduled,
      curatorBusy: curatorLimiter.isBusy(sessionID),
    })
  ) {
    sessionState.curationScheduled = true;
    runBackground(
      () =>
        Sentry.startSpan(
          {
            name: "lore.curator",
            op: "lore.curation",
            attributes: { trigger: "in-flight" },
          },
          () =>
            curator.run({
              llm,
              projectPath,
              sessionID,
              model,
              workerHealth: makeWorkerHealth(sessionID, "lore-curator"),
            }),
        ),
      `in-flight-curation session=${sessionID.slice(0, 16)}`,
      workerProviderID,
    )
      .then((result) => {
        if (!result) return; // skipped by circuit breaker
        sessionState.turnsSinceCuration = 0;
        saveSessionTracking(sessionID, { turnsSinceCuration: 0 });
        if (result.created > 0 || result.updated > 0 || result.deleted > 0) {
          // Invalidate LTM cache only when curation actually changed entries
          ltmSessionCache.delete(sessionID);
          saveSessionTracking(sessionID, {
            ltmCacheText: null,
            ltmCacheTokens: null,
          });
          log.info(
            `curation: ${result.created} created, ${result.updated} updated, ${result.deleted} deleted`,
          );
          emitCurationMetrics({ ...result, trigger: "in-flight" });
        }
      })
      .catch((e) => log.error("background curation failed:", e))
      .finally(() => {
        sessionState.curationScheduled = false;
      });
  }
}

// ---------------------------------------------------------------------------
// Compaction summary generation — shared by HTTP interception and /v1/compact
// ---------------------------------------------------------------------------

/**
 * Interval between keep-alive `ping` events sent on the compaction SSE stream
 * while the summary is being generated. Anthropic itself sends periodic pings
 * on long-running streams; this keeps the client connection from timing out
 * while we (possibly) distill the remainder under a rate limit.
 */
const COMPACT_KEEPALIVE_PING_MS = 15_000;

/**
 * Generate a compaction summary for a session, assembled deterministically
 * from Lore's own memory (distillations + long-term knowledge + the prior
 * summary). The only LLM work is urgently distilling any undistilled
 * remainder first; there is no dedicated "compaction" LLM call. Returns null
 * only when there is genuinely nothing to compact.
 *
 * This is the core logic shared by both:
 *  - `handleCompaction` (HTTP-intercepted compaction from Claude Code / OpenCode)
 *  - `handleCompactEndpoint` (explicit POST /v1/compact from Pi plugin)
 */
export async function generateCompactionSummary(opts: {
  projectPath: string;
  sessionID: string;
  config: GatewayConfig;
  previousSummary?: string;
  sessionUpstream?: { providerID?: string; modelID?: string };
}): Promise<string | null> {
  const { projectPath, sessionID, config, previousSummary, sessionUpstream } =
    opts;

  // 1. Bring distillations current. Compaction does NOT make a dedicated
  //    "compaction" LLM call anymore — its only LLM work is distilling the
  //    undistilled remainder. When everything is already distilled this is
  //    skipped entirely (instant, zero-cost compaction). When not, we distill
  //    urgently; the caller's keep-alive stream holds the client connection
  //    open during any rate-limit wait. A distillation failure is non-fatal:
  //    step 3 assembles from whatever distillations exist plus the raw tail.
  if (temporal.undistilledCount(projectPath, sessionID) > 0) {
    const llm = getLLMClient(config);
    const model = getWorkerModel(sessionUpstream);
    await distillation.run({
      llm,
      projectPath,
      sessionID,
      model,
      force: true,
      urgent: true,
      callType: "direct",
      workerHealth: makeWorkerHealth(sessionID, "lore-distill"),
    });
  }

  // 2. Load distillation summaries + long-term knowledge.
  const distillations = distillation.loadForSession(projectPath, sessionID);
  const cfg = loreConfig();
  const entries = cfg.knowledge.enabled
    ? ltm.forProject(projectPath, cfg.crossProject)
    : [];
  const knowledge = entries.length
    ? formatKnowledge(
        entries.map((e) => ({
          category: e.category,
          title: e.title,
          content: e.content,
        })),
      )
    : "";

  // 3. Assemble the compaction summary deterministically from Lore's memory —
  //    no LLM. Include any still-undistilled messages verbatim so the recent
  //    tail is never lost if distillation could not bring everything current.
  //    Note: a concurrent client turn could store new temporal messages between
  //    step 1 (distillation) and this read — those messages appear in both the
  //    summary tail AND the next conversation turn. This is benign duplication,
  //    not data loss, and the window is narrow (active concurrent turns only).
  return assembleOfflineCompaction({
    previousSummary,
    distillations,
    knowledge,
    undistilled: temporal
      .undistilled(projectPath, sessionID)
      .map((m) => ({ role: m.role, content: m.content })),
  });
}

// ---------------------------------------------------------------------------
// Case 1: Compaction interception
// ---------------------------------------------------------------------------

async function handleCompaction(
  req: GatewayRequest,
  config: GatewayConfig,
): Promise<Response> {
  if (!req.rawHeaders["x-lore-project"]) {
    const markerProject = extractProjectMarker(req.messages);
    if (markerProject) req.rawHeaders["x-lore-project"] = markerProject;
  }
  const pathResult = getProjectPath(req.system, req.rawHeaders);

  const { sessionID } = await identifySession(req, pathResult.path);
  stripContextMarkers(req.messages);
  const sessionState = getOrCreateSession(
    sessionID,
    pathResult.path,
    pathResult.source,
  );
  const projectPath = resolveSessionProjectPath(
    pathResult,
    sessionState,
    config,
  );
  // NOTE: the project binding is NOT persisted here — compaction never changes
  // the binding, and the preceding normal turn already persisted it. A restart
  // between the last normal turn and a compaction-only turn rehydrates the
  // binding from the prior save, which is always present (compaction requires
  // accumulated context that implies at least one normal turn happened first).

  // Initialize the project AFTER path correction so we never create a row for
  // the gateway's cwd / an unattributed bucket from a path-less probe request.
  await initIfNeeded(projectPath, config, pathResult.gitRemote);

  setSentryLightContext({ model: req.model, projectPath });
  log.info(`compaction intercepted for session ${sessionID.slice(0, 16)}`);

  // Post-compaction the client sends an entirely different message set, so the
  // cached pre-compaction warmup body is stale regardless of how this resolves.
  sessionState.cacheAnalytics.lastRequestBody = null;

  // Kick off summary generation: at most one LLM call (urgent distillation
  // of the undistilled remainder, if any), then deterministic assembly from
  // Lore's memory. Returns null only when there is genuinely nothing to
  // compact (brand-new session, no history, no knowledge).
  const summaryPromise = generateCompactionSummary({
    projectPath,
    sessionID,
    config,
    previousSummary: extractPreviousSummary(req),
    sessionUpstream: sessionState.lastUpstream,
  });

  if (req.stream) {
    // Open the SSE stream immediately and emit keep-alive `ping`s while the
    // summary is computed (the remainder-distillation may ride out a 429), so
    // the client connection never hits a read-timeout. The Response must be
    // returned without awaiting so the pings flow to the client progressively.
    //
    // Null safety: assembleOfflineCompaction returns null only for a brand-new
    // session with zero history — in that case an empty assistant turn is
    // correct (there's nothing to compact, so "replacing context with nothing"
    // is accurate). We log a warning for observability.
    const loggedPromise = summaryPromise.then((s) => {
      if (s == null) {
        log.warn(
          `compaction summary empty (streaming) for session ${sessionID.slice(0, 16)}`,
        );
      }
      return s;
    });
    const id = `msg_lore_compact_${crypto.randomUUID().slice(0, 8)}`;
    const anthropicSSE = buildKeepaliveCompactionStream(
      id,
      req.model,
      loggedPromise,
      COMPACT_KEEPALIVE_PING_MS,
    );
    // Always Anthropic SSE — wrap for OpenAI-protocol clients (their
    // translators skip pings).
    if (req.protocol === "openai") {
      return translateAnthropicStreamToOpenAI(anthropicSSE);
    }
    if (req.protocol === "openai-responses") {
      return translateAnthropicStreamToResponses(anthropicSSE);
    }
    return anthropicSSE;
  }

  // Non-streaming clients: await the summary and return JSON. Fall back to
  // upstream passthrough only when there is genuinely nothing to compact.
  const summary = await summaryPromise;
  if (summary == null) {
    log.warn(
      `compaction summary empty for session ${sessionID.slice(0, 16)} — falling back to upstream`,
    );
    return await handlePassthrough(req, config);
  }
  const resp = buildCompactionResponse(sessionID, summary, req.model);
  return nonStreamHttpResponse(resp, req.protocol, req.stream);
}

// ---------------------------------------------------------------------------
// Case 1b: Explicit compaction endpoint (POST /v1/compact)
// ---------------------------------------------------------------------------

/**
 * Handle an explicit compaction summary request from a plugin (e.g. Pi).
 * Unlike `handleCompaction` which detects compaction from request patterns,
 * this endpoint accepts a direct JSON body with project path and optional
 * previous summary.
 *
 * The caller must include a session-identifying header (e.g. x-lore-session-id)
 * so the gateway can resolve the correct internal session.
 */
export async function handleCompactEndpoint(
  req: Request,
  config: GatewayConfig,
): Promise<Response> {
  let body: { project_path?: string; previous_summary?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return new Response(
      JSON.stringify({
        error: "invalid_request",
        message: "Invalid JSON body",
      }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  const projectPath = body.project_path;
  if (!projectPath || typeof projectPath !== "string") {
    return new Response(
      JSON.stringify({
        error: "invalid_request",
        message: "project_path is required",
      }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  // Extract git remote from header if available (Pi plugin injects this).
  const rawHeaders: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    rawHeaders[key] = value;
  });
  const gitRemote = extractGitRemoteHeader(rawHeaders);

  await initIfNeeded(projectPath, config, gitRemote);

  // Build a minimal GatewayRequest for session identification.
  // Only rawHeaders and messages are used by identifySession().

  const minimalReq: GatewayRequest = {
    protocol: "anthropic",
    system: "",
    messages: [],
    tools: [],
    model: "",
    maxTokens: 0,
    stream: false,
    metadata: {},
    rawHeaders,
  };

  const { sessionID, isNew } = await identifySession(minimalReq, projectPath);

  if (isNew) {
    // No prior session found — the caller's session header didn't match any
    // existing session. This typically means no conversation turns have gone
    // through the gateway yet, so there's nothing to compact.
    return new Response(
      JSON.stringify({
        error: "session_not_found",
        message:
          "No active session found for the given headers. " +
          "Ensure at least one conversation turn has been routed through the gateway.",
      }),
      { status: 404, headers: { "content-type": "application/json" } },
    );
  }

  log.info(
    `compact endpoint: generating summary for session ${sessionID.slice(0, 16)}`,
  );

  try {
    const state = sessions.get(sessionID);
    const summary = await generateCompactionSummary({
      projectPath,
      sessionID,
      config,
      previousSummary:
        typeof body.previous_summary === "string"
          ? body.previous_summary
          : undefined,
      sessionUpstream: state?.lastUpstream,
    });

    if (summary == null) {
      log.warn(
        `compact endpoint: summary generation failed for session ${sessionID.slice(0, 16)} — returning 502`,
      );
      return new Response(
        JSON.stringify({
          error: "compaction_failed",
          message: "Summary generation failed (worker model unavailable)",
        }),
        { status: 502, headers: { "content-type": "application/json" } },
      );
    }

    // Clear the cached warmup body — post-compaction the client will send
    // entirely different messages, so the pre-compaction body is stale.
    const sessionState = sessions.get(sessionID);
    if (sessionState) {
      sessionState.cacheAnalytics.lastRequestBody = null;
    }

    return new Response(JSON.stringify({ summary }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Compaction failed";
    log.error("compact endpoint error:", err);
    return new Response(
      JSON.stringify({ error: "compaction_failed", message: msg }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }
}

// ---------------------------------------------------------------------------
// Case 1c: Codex compaction endpoint (POST /v1/responses/compact)
// ---------------------------------------------------------------------------

/**
 * Handle a Codex-style compaction request at `/v1/responses/compact`.
 *
 * Codex sends compaction requests as a POST to `{base_url}/responses/compact`
 * with a body shaped like a Responses API request (`model`, `instructions`,
 * `input`, `tools`, etc.). The expected response is `{ output: ResponseItem[] }`.
 *
 * Strategy:
 *  1. Parse the request to identify the session (via headers).
 *  2. Try Lore's own compaction summary generation.
 *  3. On success: return a Responses-API-style compacted output.
 *  4. On failure: passthrough to the upstream OpenAI API.
 */
export async function handleResponsesCompactEndpoint(
  req: Request,
  config: GatewayConfig,
): Promise<Response> {
  // Read the body as text so we can both parse it and replay it for passthrough.
  const bodyText = await req.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    return new Response(
      JSON.stringify({
        error: "invalid_request",
        message: "Invalid JSON body",
      }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  const rawHeaders: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    rawHeaders[key] = value;
  });

  // Parse the body as a Responses API request to get messages for session
  // fingerprinting. The compact request body has the same shape as a normal
  // /v1/responses request (model, instructions, input, tools, etc.).
  let gatewayReq: GatewayRequest;
  try {
    gatewayReq = parseOpenAIResponsesRequest(body, rawHeaders);
  } catch {
    // If parsing fails, still attempt passthrough — the upstream may accept it.
    log.warn(
      "responses/compact: failed to parse request body — falling back to upstream",
    );
    return await passthroughResponsesCompact(bodyText, rawHeaders, config);
  }

  const pathResult = getProjectPath(gatewayReq.system, rawHeaders);
  const gitRemote = extractGitRemoteHeader(rawHeaders);

  await initIfNeeded(pathResult.path, config, gitRemote);

  const { sessionID, isNew } = await identifySession(
    gatewayReq,
    pathResult.path,
  );

  // If no prior session, skip Lore compaction and passthrough to upstream.
  if (!isNew) {
    log.info(
      `responses/compact: generating Lore summary for session ${sessionID.slice(0, 16)}`,
    );

    try {
      const summary = await generateCompactionSummary({
        projectPath: pathResult.path,
        sessionID,
        config,
      });

      if (summary != null) {
        // Clear cached warmup body — post-compaction messages will differ.
        const sessionState = sessions.get(sessionID);
        if (sessionState) {
          sessionState.cacheAnalytics.lastRequestBody = null;
        }

        // Return in Codex's expected format: { output: ResponseItem[] }
        // Must include id, status, and annotations to match the
        // CompactHistoryResponse { output: Vec<ResponseItem> } struct.
        return new Response(
          JSON.stringify({
            output: [
              {
                type: "message",
                id: `msg_lore_compact_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
                role: "assistant",
                status: "completed",
                content: [
                  { type: "output_text", text: summary, annotations: [] },
                ],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      log.warn(
        `responses/compact: Lore summary generation failed for session ${sessionID.slice(0, 16)} — falling back to upstream`,
      );
    } catch (err) {
      log.warn(
        "responses/compact: Lore compaction error, falling back to upstream:",
        err,
      );
    }
  } else {
    log.info(
      "responses/compact: no prior session found — falling back to upstream",
    );
  }

  // Fallback: passthrough to upstream OpenAI /v1/responses/compact
  return await passthroughResponsesCompact(bodyText, rawHeaders, config);
}

/**
 * Forward a compaction request to the upstream OpenAI API as-is.
 */
async function passthroughResponsesCompact(
  bodyText: string,
  rawHeaders: Record<string, string>,
  config: GatewayConfig,
): Promise<Response> {
  const upstreamUrl = `${config.upstreamOpenAI}/v1/responses/compact`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };

  // Forward auth headers (keys are lowercase — Fetch API normalizes them).
  const auth = rawHeaders.authorization;
  if (auth) headers.authorization = auth;
  const apiKey = rawHeaders["x-api-key"];
  if (apiKey) headers["x-api-key"] = apiKey;

  // Forward OpenAI-specific headers
  const openAiBeta = rawHeaders["openai-beta"];
  if (openAiBeta) headers["openai-beta"] = openAiBeta;

  // Apply user-supplied LORE_UPSTREAM_EXTRA_HEADERS as a final overlay so
  // corporate proxies / LiteLLM team-routing tokens / Cloudflare AI Gateway
  // / service-account scenarios work for compaction-passthrough calls too.
  applyUpstreamExtraHeaders(headers, config.upstreamExtraHeaders);

  try {
    const upstream = await upstreamFetch(upstreamUrl, {
      method: "POST",
      headers,
      body: bodyText,
    });
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: new Headers(upstream.headers),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Upstream unreachable";
    log.error("responses/compact upstream passthrough error:", err);
    return new Response(
      JSON.stringify({
        error: "compaction_failed",
        message: `Failed to reach upstream: ${msg}`,
      }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }
}

// ---------------------------------------------------------------------------
// Case 2: Meta request passthrough (title gen, summaries, categorization, etc.)
// ---------------------------------------------------------------------------

async function handlePassthrough(
  req: GatewayRequest,
  config: GatewayConfig,
): Promise<Response> {
  setSentryLightContext({ model: req.model });

  const { response: upstreamResponse, effectiveProtocol } =
    await forwardToUpstream(req, config);

  // When upstream and client use the same protocol, pass through unchanged.
  // Cross-protocol translation is only needed when provider routing maps
  // to a different protocol (e.g., OpenAI client → Anthropic upstream).
  if (effectiveProtocol === req.protocol) {
    if (req.stream && upstreamResponse.body) {
      return new Response(upstreamResponse.body, {
        status: upstreamResponse.status,
        headers: {
          "content-type":
            upstreamResponse.headers.get("content-type") ?? "text/event-stream",
        },
      });
    }
    const body = await upstreamResponse.text();
    return new Response(body, {
      status: upstreamResponse.status,
      headers: { "content-type": "application/json" },
    });
  }

  // Cross-protocol: accumulate the upstream response and re-emit in the
  // client's wire format (reuses the same translation infrastructure as
  // conversation turns).
  if (req.stream && upstreamResponse.body) {
    if (effectiveProtocol === "anthropic") {
      // Anthropic SSE upstream → translate to client's format
      const anthropicSSE = new Response(upstreamResponse.body, {
        status: upstreamResponse.status,
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
      if (req.protocol === "openai") {
        return translateAnthropicStreamToOpenAI(anthropicSSE);
      }
      if (req.protocol === "openai-responses") {
        return translateAnthropicStreamToResponses(anthropicSSE);
      }
    }
    // Other cross-protocol streaming combos: accumulate + re-emit
    const resp = await accumulateNonStreamResponse(
      upstreamResponse,
      effectiveProtocol,
    );
    return nonStreamHttpResponse(resp, req.protocol, req.stream);
  }

  // Non-streaming cross-protocol: accumulate + re-emit
  const resp = await accumulateNonStreamResponse(
    upstreamResponse,
    effectiveProtocol,
  );
  return nonStreamHttpResponse(resp, req.protocol, req.stream);
}

/**
 * Check whether the upstream prompt cache is likely still warm for this
 * session. Returns true when a warmup ping was successfully sent within
 * the current cache TTL window.
 *
 * When true, post-idle compaction should be skipped: the warmer replayed
 * the full (uncompacted) request body, so compacting now would produce
 * different bytes and bust the cache the warmer just paid to preserve.
 */
function isCacheWarm(state: SessionState): boolean {
  const warmup = state.warmup;
  // Require at least one successful warmup before claiming warm.
  // This also gates the forceKeepWarm early-return below.
  if (!warmup?.lastWarmupAt) return false;

  const profile = resolveWarmingProfile(
    state.lastUpstream?.model,
    state.lastUpstream?.protocol,
    state.resolvedConversationTTL,
  );
  if (!profile) return false;

  // /lore:warm:keep sessions: consider warm if the last warmup was within
  // 2 TTL windows. The warmer fires once per TTL window, so 2× provides a
  // safety margin while still expiring if the warmer has stopped
  // (e.g. circuit breaker tripped, process-level failure).
  if (warmup.forceKeepWarm) {
    return Date.now() - warmup.lastWarmupAt < profile.ttlMs * 2;
  }

  return Date.now() - warmup.lastWarmupAt < profile.ttlMs;
}

// ---------------------------------------------------------------------------
// Case 3: Normal conversation turn — full pipeline
// ---------------------------------------------------------------------------

async function handleConversationTurn(
  req: GatewayRequest,
  config: GatewayConfig,
): Promise<Response> {
  // --- 1. Project path & init ---
  // Enrich headers with context markers injected by lore-hermes plugin.
  // This lets getProjectPath() pick up [lore:project=...] via the existing
  // header resolution path without modifying config.ts.
  if (!req.rawHeaders["x-lore-project"]) {
    const markerProject = extractProjectMarker(req.messages);
    if (markerProject) req.rawHeaders["x-lore-project"] = markerProject;
  }
  const pathResult = getProjectPath(req.system, req.rawHeaders);

  // --- 2. Capture auth credentials for background workers ---
  const cred = extractAuth(req.rawHeaders);
  if (cred) {
    setLastSeenAuth(cred);
  }

  // --- 3. Session identification ---
  const { sessionID, isNew, tier } = await identifySession(
    req,
    pathResult.path,
  );

  // Strip [lore:session-id=...] and [lore:project=...] context markers from
  // user messages so they are not forwarded to the upstream LLM, stored in
  // temporal storage, or visible to the model.
  stripContextMarkers(req.messages);

  const sessionState = getOrCreateSession(
    sessionID,
    pathResult.path,
    pathResult.source,
  );
  let projectPath = resolveSessionProjectPath(pathResult, sessionState, config);

  // --- Synthetic project-resolution: capture a returning tool_result ---
  // If we previously injected a synthetic tool_use for project detection,
  // capture the client's tool_result, parse it, and bind the project before
  // initIfNeeded runs (so the project row targets the corrected path).
  if (
    (sessionState.syntheticResolveState === "readPending" ||
      sessionState.syntheticResolveState === "shellPending") &&
    sessionState.syntheticResolveToolUseId
  ) {
    const captured = captureSyntheticToolResult(
      req,
      sessionState.syntheticResolveToolUseId,
    );
    if (captured && sessionState.syntheticResolveKind) {
      const resolved = captured.isError
        ? {}
        : parseResolveProjectResult(
            sessionState.syntheticResolveKind,
            captured.text,
          );
      // Apply the resolution — bind the project by remote and/or root.
      projectPath = applySyntheticResolution(
        sessionState,
        resolved,
        projectPath,
      );
      // Strip the synthetic round-trip from the conversation so the LLM
      // never sees it and it's excluded from temporal storage.
      stripSyntheticRoundTrips(req);

      // Escalation: read probe yielded no remote → try shell next.
      const stillWeak = sessionState.projectPathProvisional === true;
      sessionState.syntheticResolveStage =
        sessionState.syntheticResolveKind === "read"
          ? "readTried"
          : "shellTried";
      if (stillWeak && sessionState.syntheticResolveKind === "read") {
        // Re-eligible for a shell probe on this same turn's injection phase.
        sessionState.syntheticResolveState = "none";
      } else {
        sessionState.syntheticResolveState = "done";
      }
    } else {
      // No tool_result arrived (non-agentic client or skipped) — give up.
      sessionState.syntheticResolveState = "done";
    }
    sessionState.syntheticResolveToolUseId = undefined;
    sessionState.syntheticResolveKind = undefined;
  }

  // Also strip any stale synthetic blocks that might echo back from the
  // conversation history (belt-and-suspenders — prevents leaking upstream).
  stripSyntheticRoundTrips(req);

  // Initialize the project AFTER path correction so a path-less probe request
  // never creates a project row for the gateway's cwd or an unattributed
  // bucket (provider-agnostic: applies to every protocol/client).
  await initIfNeeded(projectPath, config, pathResult.gitRemote);

  // Mark sub-agent sessions (x-parent-session-id present).
  // These get their own session but are flagged for cache warming exemption.
  // Resolve the client-side parent ID to a Lore internal session ID via the
  // headerSessionIndex (searches all indexed headers, including Tier 2 learned).
  // Tier 3 (fingerprint-only) parents have no index entry — resolution will fail
  // and a warning is logged.
  {
    const parentClientId = req.rawHeaders["x-parent-session-id"];
    if (
      parentClientId &&
      (!sessionState.isSubagent || !sessionState.parentSessionId)
    ) {
      if (!sessionState.isSubagent) {
        sessionState.isSubagent = true;
      }
      // Search the full headerSessionIndex — covers Tier 1 (known) and Tier 2 (learned) headers.
      let resolvedParent: string | undefined;
      for (const [key, loreId] of headerSessionIndex) {
        const colonIdx = key.indexOf(":");
        if (colonIdx >= 0 && key.slice(colonIdx + 1) === parentClientId) {
          resolvedParent = loreId;
          break;
        }
      }
      if (resolvedParent) {
        sessionState.parentSessionId = resolvedParent;
        saveSessionTracking(sessionID, {
          isSubagent: true,
          parentSessionId: resolvedParent,
        });
      } else if (!sessionState.parentSessionId) {
        // Parent may use Tier 3 (fingerprint) identification, or hasn't made
        // its first request yet. Persist isSubagent but leave parentSessionId
        // null — subsequent requests will re-attempt resolution.
        // Dedup the log: a child agent with an unresolvable parent fires this
        // branch on every turn. Without dedup, a single parent-less agent
        // produces 50+ identical log lines per session.
        const pendingKey = `${sessionID}:${parentClientId}`;
        if (!subagentParentPendingLogged.has(pendingKey)) {
          subagentParentPendingLogged.add(pendingKey);
          log.info(
            `session ${sessionID.slice(0, 16)}: subagent parent resolution pending for client ID ${parentClientId.slice(0, 16)}`,
          );
        }
        saveSessionTracking(sessionID, { isSubagent: true });
      }
    }
  }

  // Bind auth credential to this session for background workers.
  // Pass providerID so credentials are stored per-provider — prevents
  // cross-contamination when a session switches providers mid-conversation
  // (e.g. Anthropic → MiniMax → Anthropic).
  if (cred) {
    const reqProviderID = extractProviderHeader(req.rawHeaders);
    setSessionAuth(sessionID, cred, reqProviderID || undefined);
    clearWarmupAuthDisabled(sessionID); // Re-enable cache warming on fresh credential
  }

  // Capture billing header prefix for worker cch computation, scoped to
  // this session. Bearer tokens (Claude Code OAuth) embed an
  // x-anthropic-billing-header in the system prompt; we extract the prefix
  // so workers can rebuild it. Per-session storage prevents cross-session
  // contamination when multiple Claude Code versions share one process.
  captureBillingPrefix(sessionID, req.system);

  // Sniff Claude Code headers from conversation turns for replay on worker
  // calls. For OAuth sessions, workers need the same anthropic-beta and
  // user-agent headers as conversation turns to avoid 401 rejections.
  captureSessionHeaders(sessionID, req.rawHeaders);

  // Track fingerprint for future correlation
  if (isNew) {
    const fingerprint = await fingerprintMessages(
      req.messages.map((m) => ({ role: m.role, content: m.content })),
      {
        authSuffix: cred ? authFingerprint(cred) : "",
      },
    );
    sessionState.fingerprint = fingerprint;
    // Persist fingerprint immediately — rare event (new session only)
    saveSessionTracking(sessionID, { fingerprint });

    // Seed header learning for new sessions (Tier 2 bootstrap).
    // Even Tier 1 sessions don't need this, but it's harmless and
    // avoids branching. For Tier 3 (fingerprinted) new sessions,
    // this seeds the first round of candidate collection.
    if (!sessionState.headerSessionId) {
      const result = learnHeaders(
        sessionState.candidateHeaders,
        req.rawHeaders,
      );
      sessionState.candidateHeaders = result.updatedCandidates;
    }

    // Re-check knowledge files on new session start.  The file watcher
    // covers live edits, but this catches cases where:
    //  - The watcher wasn't set up (file didn't exist at startup)
    //  - The watcher missed an event (e.g. network-mounted fs)
    //  - The file was created after gateway startup (first export from another machine)
    tryImportKnowledge(projectPath);
  }

  // --- Compaction anomaly detection ---
  // If we reach here (normal turn) with a large message count drop, the client
  // performed compaction that slipped past both structural and pattern detection.
  // Skip for sub-agent sessions (small context by design) and tool-less
  // requests (title-gen, summarization agents that resume with fresh context).
  const prevMsgCount = sessionState.messageCount;
  const currMsgCount = req.messages.length;
  if (
    prevMsgCount > 10 &&
    currMsgCount < prevMsgCount * 0.5 &&
    !sessionState.isSubagent &&
    req.tools.length > 0
  ) {
    log.warn(
      `compaction anomaly: session=${sessionID.slice(0, 16)} ` +
        `messages dropped ${prevMsgCount}→${currMsgCount}. ` +
        `Client may have compacted outside gateway control.`,
    );
    // Flag the session for urgent distillation on the next turn. The messages
    // that just dropped out of the client's view are still in our temporal
    // store and need to be distilled before any further distillation run
    // picks up a stale snapshot — otherwise the dropped context is silently
    // lost from the Lore-side view.
    sessionState.compactionAnomalyPending = true;
  }

  // Update message count for proximity matching & structural compaction detection.
  sessionState.messageCount = currMsgCount;
  // Batched save: messageCount + turnsSinceCuration + consecutiveTextOnlyTurns
  // together to avoid multiple DB writes per turn.
  // Also persist the project binding (v36): this runs AFTER
  // resolveSessionProjectPath() above, so it captures the post-resolution
  // binding — including a provisional→confident transition from self-heal —
  // letting a gateway restart rehydrate the exact project_id and never split it.
  saveSessionTracking(sessionID, {
    messageCount: currMsgCount,
    turnsSinceCuration: sessionState.turnsSinceCuration,
    consecutiveTextOnlyTurns: sessionState.consecutiveTextOnlyTurns,
    projectPath: sessionState.projectPath || null,
    projectPathProvisional: sessionState.projectPathProvisional === true,
    // v37: persist the compaction anomaly flag so a gateway restart between
    // detection (this turn) and consumption (next turn's scheduleBackgroundWork)
    // doesn't lose the urgent-distillation signal.
    ...(sessionState.compactionAnomalyPending
      ? { compactionAnomalyPending: true }
      : {}),
  });

  // Track session model for worker model discovery
  _lastSeenSessionModel = req.model;

  // --- Sentry scope enrichment ---
  setSentryRequestContext({
    authFingerprint: cred ? authFingerprint(cred) : null,
    sessionID,
    model: req.model,
    upstreamUrl: (() => {
      const hdrUp = extractUpstreamUrlHeader(req.rawHeaders);
      if (hdrUp) return hdrUp;
      const pid = extractProviderHeader(req.rawHeaders);
      if (pid) {
        const pr = resolveProviderRoute(pid);
        if (pr?.url) return pr.url;
      }
      return (
        resolveUpstreamRoute(req.model)?.url ??
        (req.protocol === "anthropic"
          ? config.upstreamAnthropic
          : config.upstreamOpenAI)
      );
    })(),
    port: config.port,
    projectPath,
  });

  // --- Expand recall markers from previous turns ---
  // Scan all assistant messages for marker text blocks and restore them
  // to tool_use + tool_result pairs before forwarding upstream.
  if (sessionState.recallStore.size > 0) {
    const expanded = expandRecallMarkers(req, sessionState.recallStore);
    if (expanded) {
      log.info(`expanded recall markers for session ${sessionID.slice(0, 16)}`);
    }
    // Clean up orphaned store entries (markers evicted by gradient)
    cleanupRecallStore(req, sessionState.recallStore);
  }

  // --- Strip context warning markers from previous turns ---
  // The warning is injected into the response (assistant message) so the user
  // can see it. On the next turn, the client sends it back as part of the
  // assistant message. Strip it here so the API sees the original content,
  // preserving the prompt cache prefix.
  stripContextWarnings(req.messages);

  // Per-turn attribution diagnostics. Surfacing source/header/mode here makes
  // session-identity and project-binding bugs (e.g. the Tier 1b rotation merge,
  // or a hosted gateway falling back to its own cwd) immediately visible in
  // `LORE_DEBUG=1` logs instead of requiring a DB autopsy.
  log.info(
    `turn: session=${sessionID.slice(0, 16)} messages=${req.messages.length} ` +
      `model=${req.model} stream=${req.stream} new=${isNew} tier=${tier} ` +
      `source=${pathResult.source} ` +
      `hdrProject=${req.rawHeaders["x-lore-project"] ? "present" : "absent"} ` +
      `provisional=${sessionState.projectPathProvisional === true} ` +
      `remoteGateway=${config.remoteGateway} hosted=${isHostedMode()} ` +
      `project=${projectPath}`,
  );

  // --- 4. Set model limits ---
  const modelSpec = getModelSpec(req.model);
  setModelLimits({ context: modelSpec.context, output: modelSpec.output });

  // Cost-aware layer-0 cap: explicit config wins > cost formula > disabled.
  const cfg = loreConfig();
  if (cfg.budget.maxLayer0Tokens !== undefined) {
    setMaxLayer0Tokens(cfg.budget.maxLayer0Tokens);
  } else if (
    modelSpec.cacheReadCost &&
    cfg.budget.targetCacheReadCostPerTurn > 0
  ) {
    setMaxLayer0Tokens(
      computeLayer0Cap(
        cfg.budget.targetCacheReadCostPerTurn,
        modelSpec.cacheReadCost,
      ),
    );
  }

  // Set cache pricing for tier-based bust-vs-continue decisions in gradient.ts.
  // Anthropic charges 2× cache_write for 1h TTL — adjust so shouldCompress()
  // uses the actual write cost when deciding whether to bust the cache.
  if (modelSpec.cacheWriteCost && modelSpec.cacheReadCost) {
    const effectiveCacheWriteCost =
      sessionState.resolvedConversationTTL === "1h"
        ? modelSpec.cacheWriteCost * 2
        : modelSpec.cacheWriteCost;
    setCachePricing(effectiveCacheWriteCost, modelSpec.cacheReadCost);
  }

  // --- 4c. Dynamic max_tokens sizing for non-Claude-Code clients ---
  // Claude Code manages its own max_tokens (32K for modern models). Other
  // clients often send low/missing values (defaults to 4096 in ingress
  // parsing). Apply a hybrid headroom + history algorithm that tightens
  // from the 32K ceiling based on actual output patterns.
  const isCC =
    isClaudeCodeClient(req.rawHeaders) || hasBillingHeader(req.system);
  if (!isCC) {
    const computed = computeMaxTokens(
      modelSpec.output,
      modelSpec.context,
      sessionState.outputTokensEMA,
      sessionState.lastStopReason,
      sessionState.lastInputTokens,
    );
    if (req.maxTokens !== computed) {
      log.info(
        `max_tokens: ${req.maxTokens} → ${computed} ` +
          `(ema=${sessionState.outputTokensEMA ?? "none"}, ` +
          `lastStop=${sessionState.lastStopReason ?? "none"})`,
      );
      req.maxTokens = computed;
    }
  }

  // --- 5. Cold-cache idle-resume ---
  // Auto-sync idle threshold with conversation TTL: when 1h TTL is active
  // (explicit or auto-upgraded), use 60 min idle threshold instead of the
  // configured value (which defaults to 5 min for the default cache tier).
  const effectiveIdleMinutes =
    sessionState.resolvedConversationTTL === "1h" && cfg.idleResumeMinutes <= 5
      ? 60
      : cfg.idleResumeMinutes;
  const thresholdMs = effectiveIdleMinutes * 60_000;
  // If the cache warmer recently refreshed this session's prompt cache,
  // skip post-idle compaction — compacting would produce a different prompt
  // body that doesn't match the warmed prefix, causing a cache bust.
  const cacheWarm = isCacheWarm(sessionState);
  const idleResult = onIdleResume(
    sessionID,
    thresholdMs,
    Date.now(),
    cacheWarm,
  );
  sessionState.lastTurnWasIdle = idleResult.triggered;
  if (idleResult.triggered) {
    ltmSessionCache.delete(sessionID);
    saveSessionTracking(sessionID, {
      ltmCacheText: null,
      ltmCacheTokens: null,
    });
    // Refresh the stable LTM block (system[1]: preferences + entities) too, but
    // ONLY when the idle gap exceeds system[1]'s own 1h cache TTL — i.e. that
    // prefix is already cold, so rebuilding it with freshly-curated preferences
    // costs nothing. (Lore promotes long-running sessions; without this they
    // would keep using stale preferences indefinitely.) A shorter idle gap
    // leaves system[1] warm, so we keep it pinned to preserve the 1h cache.
    const refreshedStable = shouldRefreshStableLtm(true, idleResult.idleMs);
    if (refreshedStable) {
      stableLtmCache.delete(sessionID);
    }
    log.info(
      `session idle ${Math.round(idleResult.idleMs / 60_000)}min — refreshing caches` +
        (refreshedStable ? " (incl. stable LTM — 1h cold)" : "") +
        (cacheWarm ? " (cache warm — skipping compact)" : ""),
    );
  }

  // --- 6. LTM injection (3-block system prompt for cache efficiency) ---
  // system[0]: Host prompt              [no cache_control]
  // system[1]: Stable LTM (preferences) [cache_control: 1h] — pinned ≥1h
  // system[2]: Context-bound LTM        [no cache_control]  — diff-pinned
  //
  // system[0]+[1] form a stable prefix cached at 1h TTL (written at 2×
  // cost, read at 0.1×). system[2] rides the conversation cache (5m TTL,
  // 1.25×). When context-bound LTM changes (turn 1→2, curation), only
  // system[2] and messages are re-processed; system[0]+[1] are cache reads.
  let stableLtmText: string | undefined; // block 2: preferences
  let ltmText: string | undefined; // block 3: context-bound entries
  if (cfg.knowledge.enabled) {
    // Track whether LTM state changed for batched DB persistence
    let ltmDirty = false;
    let pinDirty = false;

    try {
      const ltmFraction = cfg.budget.ltm;
      const ltmBudget = getLtmBudget(ltmFraction);
      const prefBudget = getPreferenceLtmBudget(cfg.budget.preferenceLtm);
      const isFirstTurn =
        sessionID != null && !temporal.hasMessages(projectPath, sessionID);
      const contextHint = lastUserTextTrimmed(req);

      // --- system[1]: Stable LTM (preferences) + known entities ---
      // Computed once per session and pinned for ≥1h. NOT invalidated by
      // curation — even if a preference changes, we keep the cached version
      // so the Anthropic 1h prompt cache prefix stays warm.
      // Uses a dedicated budget independent of context-bound LTM. The known-
      // entities block is folded in here (not system[2]) so it is available on
      // turn 1.
      let stable = stableLtmCache.get(sessionID);
      if (!stable) {
        const prefEntries = await ltm.forSession(
          projectPath,
          sessionID,
          prefBudget,
          {
            categories: ["preference"],
            ...(contextHint ? { contextHint } : {}),
          },
        );
        const prefText = prefEntries.length
          ? formatKnowledge(
              prefEntries.map((e) => ({
                category: e.category,
                title: e.title,
                content: e.content,
              })),
              prefBudget,
            )
          : "";

        // Known-entities block — folded into the stable system[1] block so it
        // is present from turn 1 (system[2] is deferred to turn 2+, but the
        // user may reference an entity on their very first message). Visibility
        // is intentionally conservative: entitiesForSession() returns only the
        // current project's + genuinely-global (cross_project) entities. Other
        // projects' repos are NOT injected here — that would re-introduce the
        // cross-project context leak repaired by DB migration 38. Those are
        // discoverable on demand via the recall tool instead, which is why the
        // caveat line below points the agent at recall for names not shown.
        let entitiesText = "";
        if (cfg.knowledge.maxEntityInject > 0) {
          try {
            const sessionEntities = entities.entitiesForSession(
              projectPath,
              cfg.knowledge.maxEntityInject,
            );
            if (sessionEntities.length) {
              const formattedEntities =
                entities.formatForPrompt(sessionEntities);
              if (formattedEntities) {
                entitiesText = `${formattedEntities}\n\n(Partial list — use the recall tool to resolve any name not shown here, including repositories, people, or services from your other projects.)`;
              }
            }
          } catch (err) {
            log.warn("entity injection failed (non-fatal):", err);
          }
        }

        const formatted = [prefText, entitiesText].filter(Boolean).join("\n\n");
        if (formatted) {
          const tokenCount = Math.ceil(formatted.length / 3);
          stable = { formatted, tokenCount };
          stableLtmCache.set(sessionID, stable);
        }
      }
      stableLtmText = stable?.formatted;

      // --- system[2]: Context-bound LTM (non-preference entries) ---
      // Deferred to turn 2+ when real session context exists for relevance
      // scoring. On turn 1, only stable LTM (preferences) is injected.
      if (!isFirstTurn) {
        let cached = ltmSessionCache.get(sessionID);
        // Entry-set keys for the *freshly computed* selection. Only populated
        // on the recompute path (when ltmSessionCache was cold/invalidated) —
        // that's the only path where re-ranking can churn the text. On the
        // warm-cache path the text is unchanged, so byte equality with the pin
        // suffices and keys aren't needed.
        let cachedKeys: string[] | undefined;

        if (!cached) {
          // Full context-bound budget — preferences have their own dedicated budget.
          const contextBudget = ltmBudget;
          // Feed the previously-pinned entry set back in as a stability hint so
          // per-turn relevance re-scoring doesn't churn the budget-boundary
          // selection (which would bust the system[2] cache). New/removed/
          // genuinely-more-relevant entries still change the set.
          const stickyIds = entryKeyIds(
            ltmPinnedText.get(sessionID)?.entryKeys,
          );
          // Exclude preferences — they're already in system[1]
          const contextEntries = await ltm.forSession(
            projectPath,
            sessionID,
            contextBudget,
            {
              excludeCategories: ["preference"],
              ...(contextHint ? { contextHint } : {}),
              ...(stickyIds.size ? { stickyIds } : {}),
            },
          );
          if (contextEntries.length) {
            const renderedIds: string[] = [];
            const formatted = formatKnowledge(
              contextEntries.map((e) => ({
                category: e.category,
                title: e.title,
                content: e.content,
                id: e.id,
              })),
              contextBudget,
              renderedIds,
            );
            if (formatted) {
              const tokenCount = Math.ceil(formatted.length / 3);
              cached = { formatted, tokenCount };
              cachedKeys = ltmEntryKeys(contextEntries, renderedIds);
              ltmSessionCache.set(sessionID, cached);
              ltmDirty = true;
            }
          }
        }

        if (cached) {
          // Reorder-tolerant diff-pinning: reuse the pinned system[2] text
          // whenever the *selected entry set* is unchanged (same entry IDs,
          // any order; same per-entry content). Pure re-ranking by
          // forSession() must never bust the cache. Re-pin only when the
          // selected set changes, an entry's content changed (curator update),
          // or there is no pin yet. See ltmPinnedText docs.
          const pinned = ltmPinnedText.get(sessionID);
          const setUnchanged = cachedKeys
            ? // Recompute path: compare entry-key sets.
              sameEntryKeys(pinned?.entryKeys, cachedKeys)
            : // Warm-cache path (no fresh entries): the text didn't change, so
              // byte equality against the pin is sufficient.
              pinned != null && pinned.formatted === cached.formatted;

          if (pinned && setUnchanged) {
            // Same entry set (or identical text) — keep the pinned text to
            // preserve the cache prefix. Zero bust on pure re-ranking.
            ltmText = pinned.formatted;
            // Keep the session cache in lock-step with the pin so the persisted
            // ltmCacheText never diverges from ltmPinText. Otherwise a restart
            // would reload cache=freshText / pin=oldText, and the warm-cache
            // byte-equality check would spuriously re-pin (one needless bust)
            // and drop entryKeys. (Addresses review finding S1.)
            if (cachedKeys && cached.formatted !== pinned.formatted) {
              ltmSessionCache.set(sessionID, {
                formatted: pinned.formatted,
                tokenCount: pinned.tokenCount,
              });
              ltmDirty = true;
            }
          } else {
            // Set changed, content changed, or first injection — pin the new
            // text along with its entry-key identity.
            const newPin = { ...cached, entryKeys: cachedKeys };
            ltmPinnedText.set(sessionID, newPin);
            pinDirty = true;
            ltmText = newPin.formatted;
          }
        }
      }

      // Use stored tokenCount from cache/pin rather than re-estimating
      // from string length — avoids inconsistent estimates.
      const contextTokens = ltmText
        ? (ltmPinnedText.get(sessionID)?.tokenCount ??
          ltmSessionCache.get(sessionID)?.tokenCount ??
          0)
        : 0;
      setLtmTokens((stable?.tokenCount ?? 0) + contextTokens, sessionID);
    } catch (e) {
      log.error("LTM injection failed:", e);
      setLtmTokens(0, sessionID);
    } finally {
      consumeCameOutOfIdle(sessionID);
    }

    // Batched LTM state persistence — single DB write for cache + pin changes
    if (ltmDirty || pinDirty) {
      const cached = ltmSessionCache.get(sessionID);
      const pinned = ltmPinnedText.get(sessionID);
      saveSessionTracking(sessionID, {
        ...(ltmDirty && cached
          ? {
              ltmCacheText: cached.formatted,
              ltmCacheTokens: cached.tokenCount,
            }
          : {}),
        ...(pinDirty && pinned
          ? {
              ltmPinText: pinned.formatted,
              ltmPinTokens: pinned.tokenCount,
              ltmPinKeys: pinned.entryKeys
                ? JSON.stringify(pinned.entryKeys)
                : null,
            }
          : {}),
      });
    }
  } else {
    setLtmTokens(0, sessionID);
    consumeCameOutOfIdle(sessionID);
  }

  // --- 7. Gradient transform on messages ---
  const loreMessages = gatewayMessagesToLore(req.messages, sessionID);
  resolveToolResults(loreMessages);

  const result = transform({
    messages: loreMessages,
    projectPath,
    sessionID,
  });

  // Drop trailing pure-text assistant messages to prevent prefill errors
  for (;;) {
    const last = result.messages.at(-1);
    if (!last || last.info.role === "user") break;
    const hasToolParts = last.parts.some((p) => p.type === "tool");
    if (hasToolParts) break;
    result.messages.pop();
  }

  // Persist the cross-turn dedup decision memo when it changed, so the stable
  // full/collapsed form of each tool output survives a gateway restart (v41).
  // Cheap change-guard avoids a DB write on turns where dedup didn't run.
  {
    const serialized = exportDedupDecisions(sessionID);
    if (serialized !== lastSavedDedupDecisions.get(sessionID)) {
      lastSavedDedupDecisions.set(sessionID, serialized ?? undefined);
      saveSessionTracking(sessionID, { dedupDecisions: serialized });
    }
  }

  // --- 7b. LTM refresh on emergency layer ---
  // Layer 4 (emergency/transient reset) signals that the context was fully
  // reset. Re-run forSession() to re-rank context-bound entries by relevance
  // to the current conversation state — entries that became relevant mid-
  // session (e.g. a gotcha discovered during debugging) are surfaced on the
  // reset turn rather than waiting for the next session. Stable LTM
  // (system[1]) is kept pinned — Layer 4 busts the prompt cache anyway, so
  // system[1] will be re-written, but keeping the same content means the
  // NEXT turn's prefix matches and gets a cache read.
  if (result.refreshLtm && cfg.knowledge.enabled) {
    try {
      const ltmFraction = cfg.budget.ltm;
      const ltmBudget = getLtmBudget(ltmFraction);
      // Full context-bound budget — preferences have their own dedicated budget.
      const contextBudget = ltmBudget;
      const stableTokens = stableLtmCache.get(sessionID)?.tokenCount ?? 0;
      const contextHint = lastUserTextTrimmed(req);
      // Stability hint: keep the previously-pinned set sticky so consecutive
      // Layer-4 turns don't churn the selection (see step-6).
      const stickyIds = entryKeyIds(ltmPinnedText.get(sessionID)?.entryKeys);
      const contextEntries = await ltm.forSession(
        projectPath,
        sessionID,
        contextBudget,
        {
          excludeCategories: ["preference"],
          ...(contextHint ? { contextHint } : {}),
          ...(stickyIds.size ? { stickyIds } : {}),
        },
      );
      let refreshed = false;

      if (contextEntries.length) {
        const renderedIds: string[] = [];
        const formatted = formatKnowledge(
          contextEntries.map((e) => ({
            category: e.category,
            title: e.title,
            content: e.content,
            id: e.id,
          })),
          contextBudget,
          renderedIds,
        );

        if (formatted) {
          const tokenCount = Math.ceil(formatted.length / 3);
          const entryKeys = ltmEntryKeys(contextEntries, renderedIds);
          // Always update the cache with freshly ranked entries.
          ltmSessionCache.delete(sessionID);
          ltmSessionCache.set(sessionID, { formatted, tokenCount });

          // Reorder-tolerant diff-pinning: on consecutive Layer 4 turns,
          // system[2] stability matters because system[0]+[1] ARE still cache
          // reads at 1h TTL. Reuse the pin whenever the selected entry set is
          // unchanged (same IDs + content, any order) — same policy as step 6.
          const pinned = ltmPinnedText.get(sessionID);

          if (pinned && sameEntryKeys(pinned.entryKeys, entryKeys)) {
            // Same entry set — keep the pinned text to preserve cache prefix
            ltmText = pinned.formatted;
            setLtmTokens(stableTokens + pinned.tokenCount, sessionID);
            saveSessionTracking(sessionID, {
              ltmCacheText: formatted,
              ltmCacheTokens: tokenCount,
              // pin unchanged — don't write ltmPinText/ltmPinTokens/ltmPinKeys
            });
          } else {
            // Set changed or first Layer 4 turn — pin the new text + identity
            ltmPinnedText.set(sessionID, { formatted, tokenCount, entryKeys });
            ltmText = formatted;
            setLtmTokens(stableTokens + tokenCount, sessionID);
            saveSessionTracking(sessionID, {
              ltmCacheText: formatted,
              ltmCacheTokens: tokenCount,
              ltmPinText: formatted,
              ltmPinTokens: tokenCount,
              ltmPinKeys: JSON.stringify(entryKeys),
            });
          }
          refreshed = true;
          log.info(
            "Context-bound LTM refreshed on emergency layer (Layer 4) for session",
            sessionID,
          );
        }
      }

      if (!refreshed) {
        // forSession() returned no context-bound entries — clear context LTM
        // state. Stable LTM (system[1]) is preserved.
        ltmSessionCache.delete(sessionID);
        ltmPinnedText.delete(sessionID);
        ltmText = undefined;
        setLtmTokens(stableTokens, sessionID);
        saveSessionTracking(sessionID, {
          ltmCacheText: null,
          ltmCacheTokens: null,
          ltmPinText: null,
          ltmPinTokens: null,
          ltmPinKeys: null,
        });
        log.info(
          "Context-bound LTM cleared on emergency layer (Layer 4) — stable LTM preserved for session",
          sessionID,
        );
      }
    } catch (e) {
      // On error, leave the step-6 LTM state intact (cache, pin, text)
      // so the turn proceeds with the pre-refresh knowledge rather than
      // an inconsistent state. The next turn will retry via step 6.
      log.error("LTM refresh on emergency layer failed:", e);
    }
  }

  // --- 7c. Context health note ---
  // When the gradient compresses context (layer 1+), append a brief note to
  // the context-bound LTM block (system[2]) so the AI knows its context is
  // managed and can use the recall tool for details no longer visible.
  // This rides system[2] which already changes per-turn — no cache impact on
  // the stable prefix (system[0]+[1]).
  if (result.layer >= 1 && ltmText) {
    const layerDesc =
      result.layer === 1
        ? "compressed"
        : result.layer === 2
          ? "aggressively compressed"
          : result.layer >= 3
            ? "emergency compressed"
            : "compressed";
    ltmText +=
      `\n\n[Context health: conversation history is ${layerDesc}. ` +
      `Distilled observations above are lossy summaries — specific details ` +
      `(exact error messages, rejected alternatives, file paths, numerical values) ` +
      `are likely omitted. Use recall to verify any specific claim before answering ` +
      `questions about what happened, what was considered, or what the exact values were.]`;
  } else if (result.layer >= 1 && !ltmText) {
    ltmText =
      `[Context health: conversation history is compressed. ` +
      `Distilled observations above are lossy summaries — specific details ` +
      `(exact error messages, rejected alternatives, file paths, numerical values) ` +
      `are likely omitted. Use recall to verify any specific claim before answering ` +
      `questions about what happened, what was considered, or what the exact values were.]`;
  }

  // --- 7d. Unsustainable conversation warning ---
  // When 5+ consecutive cache busts are detected, flag for response-side injection.
  // The warning is injected into the assistant response (not the user message) so:
  //  1. The user can actually see it (not hidden in <system-reminder> tags)
  //  2. No modification to user messages → no cache prefix divergence
  //  3. Stripped on the next turn to restore API-original content for cache
  const unsustainable = result.unsustainable;
  if (unsustainable) {
    log.warn(
      `session ${sessionID}: unsustainable conversation detected (5+ consecutive cache busts). ` +
        `Warning will be prepended to response.`,
    );
  }

  // --- 8. Build the modified request ---
  // Reconstruct GatewayMessages from the transformed Lore messages.
  // loreMessagesToGateway reconstructs tool_result blocks from assistant's
  // completed/error tool parts; removeOrphanedToolResults is a safety net
  // that catches any remaining orphaned tool_result references.
  const transformedMessages = loreMessagesToGateway(result.messages);
  removeOrphanedToolResults(transformedMessages);

  const modifiedReq: GatewayRequest = {
    ...req,
    // Host system prompt is passed through unmodified — LTM is injected
    // as a separate system block via cache options for prefix stability.
    messages: transformedMessages,
  };

  // --- 8b. Inject recall tool (with git reminder appended to description) ---
  // Only inject if the client doesn't already have a recall tool (e.g. from
  // a host plugin like OpenCode) and the request has other tools (so it's a
  // coding agent, not a bare chat).
  if (modifiedReq.tools.length > 0 && !clientHasRecallTool(modifiedReq.tools)) {
    // Build the recall tool with git reminder baked into its description.
    // This keeps the reminder in the stable tools prefix (1h cache) rather
    // than the volatile system prompt.
    const recallTool =
      cfg.knowledge.enabled && cfg.loreFile.enabled
        ? {
            ...RECALL_GATEWAY_TOOL,
            description: `${RECALL_GATEWAY_TOOL.description}\n\n${LORE_COMMIT_REMINDER}`,
          }
        : RECALL_GATEWAY_TOOL;
    modifiedReq.tools = [...modifiedReq.tools, recallTool];
  }

  // --- 8c. Synthetic project-resolution: inject probe if eligible ---
  // When the session has a weak/provisional binding AND we haven't exhausted
  // our probe attempts, short-circuit the turn with a synthetic tool_use
  // targeting the client's own read or shell tool.
  //
  // Only fires on REMOTE gateways — for local gateways, process.cwd() is
  // the real project directory (cwd is "weak but correct"), so injecting
  // a probe would add latency for no benefit.
  {
    const weakBinding = sessionState.projectPathProvisional === true;
    const resolveState = sessionState.syntheticResolveState ?? "none";
    const eligible =
      weakBinding &&
      config.remoteGateway &&
      resolveState === "none" &&
      modifiedReq.tools.length > 0;

    if (eligible) {
      const stage = sessionState.syntheticResolveStage;
      // Stage 1: prefer read (safer). Stage 2 (after readTried): shell only.
      const readTarget = stage ? null : findReadTool(modifiedReq.tools);
      const target = readTarget ?? findShellTool(modifiedReq.tools);
      if (target) {
        const block = buildSyntheticToolUseBlock(target);
        sessionState.syntheticResolveState =
          target.kind === "read" ? "readPending" : "shellPending";
        sessionState.syntheticResolveToolUseId = block.id;
        sessionState.syntheticResolveKind = target.kind;
        log.info(
          `synthetic-resolve: injecting ${target.kind} probe ` +
            `(tool=${target.toolName}) for session ${sessionID.slice(0, 16)}`,
        );
        // SHORT-CIRCUIT: do NOT forward upstream. Return our own tool_use
        // response so the client harness executes the probe locally.
        return syntheticToolUseResponse(req, block);
      }
      // No usable tool — give up permanently for this session.
      sessionState.syntheticResolveState = "done";
    }
  }

  // --- 9. Forward to upstream ---
  // Enable prompt caching for conversation turns with layered breakpoints:
  //  - System prompt: 1h TTL (host prompt is very stable within a session)
  //  - LTM: separate system block (no breakpoint, benefits from prefix)
  //  - Tools: 1h TTL on last tool (recall + git reminder are static)
  //  - Conversation: configurable TTL on last message block (5m default, 1h opt-in/auto)
  // Meta request passthrough (handlePassthrough) never reaches here — it
  // forwards the raw request without buildAnthropicRequest, so no caching.

  // Resolve conversation cache TTL: explicit "5m"/"1h" pass through,
  // "auto" upgrades to 1h when cold-cache turns exceed 40% of recent window.
  let resolvedConversationTTL: "5m" | "1h" =
    sessionState.resolvedConversationTTL ?? "5m";
  const configTTL = cfg.cache.conversationTTL;
  if (configTTL === "5m" || configTTL === "1h") {
    resolvedConversationTTL = configTTL;
  } else if (configTTL === "auto") {
    const window = sessionState.coldCacheWindow;
    if (window && window.length >= 5) {
      const coldFraction = window.filter(Boolean).length / window.length;
      if (coldFraction > 0.4 && resolvedConversationTTL === "5m") {
        // Upgrade immediately — switching to 1h is always beneficial
        resolvedConversationTTL = "1h";
        sessionState.ttlDowngradeStreak = 0;
        log.info(
          `auto-upgrade conversation TTL to 1h: session=${sessionID.slice(0, 16)}` +
            ` coldFraction=${(coldFraction * 100).toFixed(0)}%`,
        );
      } else if (coldFraction < 0.2 && resolvedConversationTTL === "1h") {
        // Hysteresis: require 3 consecutive qualifying turns before downgrading.
        // A single fluctuation below 20% shouldn't trigger a downgrade because
        // the TTL change modifies the cached bytes AND drops the idle threshold
        // from 60min to 5min, causing a compounding cache bust.
        const streak = (sessionState.ttlDowngradeStreak ?? 0) + 1;
        sessionState.ttlDowngradeStreak = streak;
        if (streak >= 3) {
          resolvedConversationTTL = "5m";
          sessionState.ttlDowngradeStreak = 0;
          log.info(
            `auto-downgrade conversation TTL to 5m: session=${sessionID.slice(0, 16)}` +
              ` coldFraction=${(coldFraction * 100).toFixed(0)}% streak=${streak}`,
          );
        } else {
          log.info(
            `TTL downgrade deferred (streak ${streak}/3): session=${sessionID.slice(0, 16)}` +
              ` coldFraction=${(coldFraction * 100).toFixed(0)}%`,
          );
        }
      } else {
        // Cold fraction not qualifying for downgrade — reset streak
        if (resolvedConversationTTL === "1h") {
          sessionState.ttlDowngradeStreak = 0;
        }
      }
    }
  }
  sessionState.resolvedConversationTTL = resolvedConversationTTL;

  const cacheOptions: AnthropicCacheOptions = {
    systemTTL: "1h",
    stableLtmSystem: stableLtmText,
    ltmSystem: ltmText,
    cacheTools: true,
    cacheConversation: true,
    conversationTTL: resolvedConversationTTL,
  };

  // --- Daily budget + OAuth quota throttle ---
  // Apply an invisible proxy-level sleep to slow the agent when approaching
  // the daily budget OR the Anthropic OAuth quota. The sleep is capped to
  // avoid causing cache busts (which would be self-defeating — costing more
  // than the throttle saved).
  const dailyBudget = getDailyBudget();
  // Quota pressure is an independent signal — applies even with no USD budget.
  // Gated to Anthropic-OAuth accounts; 0 for everything else.
  const quotaSnapshot = getQuotaForCredential(resolveAuth(sessionID));
  const quotaPressure = computeQuotaPressure(quotaSnapshot);
  if (dailyBudget > 0 || quotaPressure > 0) {
    const inputTokens =
      getLastTransformEstimate(sessionID) ||
      Math.ceil(JSON.stringify(modifiedReq.messages).length / 3);
    const estimatedCost = estimateRequestCost(req.model, inputTokens);
    const delay = getDailyThrottleDelay(
      dailyBudget,
      estimatedCost,
      quotaPressure,
    );

    if (delay > 0) {
      // Cap delay to avoid pushing the next request past the cache TTL boundary.
      // Use prevRequestTime (the request before this one) to compute how much
      // of the cache TTL window has already been consumed.
      const ttlMs = resolvedConversationTTL === "1h" ? 3_600_000 : 300_000;
      const elapsed = sessionState.prevRequestTime
        ? Date.now() - sessionState.prevRequestTime
        : 0; // first request — no prior timing, full TTL available
      const maxSafe = Math.max(0, (ttlMs - elapsed) * 0.5) / 1000;
      const actualDelay = Math.min(delay, maxSafe);

      if (actualDelay > 0.5) {
        // don't bother sleeping < 500ms
        log.info(
          `budget-throttle: sleeping ${actualDelay.toFixed(1)}s ` +
            `session=${sessionID.slice(0, 16)} ` +
            `spend=$${getDailySpend().spend.toFixed(2)} ` +
            `rate=$${getCostRate().toFixed(2)}/hr`,
        );
        await new Promise((resolve) => setTimeout(resolve, actualDelay * 1000));

        // Track throttle event on session costs
        const costs = getSessionCosts(sessionID);
        if (costs) {
          costs.throttle.events++;
          costs.throttle.totalDelayMs += actualDelay * 1000;
        }
      }
    }
  }

  // Start gen_ai.chat span before the upstream call so it captures real
  // wall-clock duration (including network latency and streaming time).
  // The span is ended in postResponse() after usage attributes are set.
  const genAiSpan = Sentry.startInactiveSpan({
    op: "gen_ai.chat",
    name: `chat ${req.model}`,
    attributes: {
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": req.model,
      "gen_ai.provider.name": (() => {
        if (req.protocol === "openai-responses") return "openai-responses";
        // Apply the same providerRouteUsable guard as forwardToUpstream:
        // only trust provider route protocol when it has a usable URL.
        const pid = extractProviderHeader(req.rawHeaders);
        const pr = pid ? resolveProviderRoute(pid) : null;
        const hdrUp = extractUpstreamUrlHeader(req.rawHeaders);
        const prUsable = pr && (pr.url != null || hdrUp) ? pr : null;
        return (
          prUsable?.protocol ??
          resolveUpstreamRoute(req.model)?.protocol ??
          "anthropic"
        );
      })(),
      "gen_ai.response.streaming": req.stream,
      // NO gen_ai.input.messages — privacy (proxy for other people's projects)
    },
  });

  const {
    response: upstreamResponse,
    serializedBody: requestBody,
    effectiveProtocol,
  } = await forwardToUpstream(modifiedReq, config, undefined, cacheOptions);

  if (!upstreamResponse.ok) {
    const errorBody = await upstreamResponse.text();
    log.error(
      `upstream error: ${upstreamResponse.status} ${errorBody.slice(0, 500)}`,
    );

    // When the API rejects with a context-length error, escalate the compression
    // layer for the next turn so the session doesn't get stuck in a loop.
    // Anthropic format: "prompt is too long: 206029 tokens > 200000 maximum"
    // OpenAI format:    "maximum context length is 128000 tokens. However, your messages resulted in 135421 tokens"
    if (
      upstreamResponse.status === 400 &&
      (errorBody.includes("prompt is too long") ||
        errorBody.includes("context_length_exceeded") ||
        errorBody.includes("maximum context length"))
    ) {
      const anthropicMatch = errorBody.match(
        /prompt is too long: (\d+) tokens > (\d+) maximum/,
      );
      const openaiMatch =
        !anthropicMatch &&
        errorBody.match(/resulted in (\d+) tokens.*?(\d+) tokens/);
      const match = anthropicMatch || openaiMatch;
      // Default to 1.3 (maps to layer 3) when the format can't be parsed,
      // since an unparseable error suggests an unexpected situation where
      // aggressive compression is safer.
      const overshootRatio = match ? Number(match[1]) / Number(match[2]) : 1.3;
      const escalateLayer = overshootRatio >= 1.2 ? 3 : 2;
      setForceMinLayer(escalateLayer, sessionID);
      log.warn(
        `prompt overflow: escalating to layer ${escalateLayer} for session ${sessionID.slice(0, 16)}` +
          ` (ratio=${overshootRatio.toFixed(2)})`,
      );
    }

    genAiSpan.setStatus({
      code: 2,
      message: `HTTP ${upstreamResponse.status}`,
    });
    genAiSpan.end();
    return new Response(errorBody, {
      status: upstreamResponse.status,
      headers: { "content-type": "application/json" },
    });
  }

  // Run the recall-interception loop over an already-accumulated
  // (internal Anthropic-format) GatewayResponse and return the client HTTP
  // response. Shared by the non-streaming path AND the OpenAI/openai-responses
  // streaming paths — those accumulate the upstream SSE into the same internal
  // Anthropic-format response, so the recall loop is protocol-agnostic here.
  // Without this, a `recall` tool_use injected by the gateway would leak to the
  // client (e.g. "Model tried to call unavailable tool 'recall'").
  const finalizeWithRecall = async (
    resp: GatewayResponse,
  ): Promise<Response> => {
    // --- Recall interception (non-streaming) ---
    // Loop allows the model to call recall multiple times (e.g. drill down
    // into t:<id> source citations). MAX_RECALL_DEPTH is a safety net only.
    let currentResp = resp;
    let recallDepth = 0;
    let currentModifiedReq = modifiedReq;
    const cumulativeUsage = { ...(resp.usage ?? ZERO_USAGE) };

    while (hasRecallToolUse(currentResp) && recallDepth < MAX_RECALL_DEPTH) {
      recallDepth++;
      const recallBlock = findRecallToolUse(currentResp);
      if (!recallBlock) break;
      const { result, input } = await executeRecall(
        recallBlock,
        sessionState.projectPath,
        sessionState.sessionID,
        getLLMClient(config),
      );

      // Store recall result for marker round-trip expansion
      const storeKey = recallStoreKey(
        input.query,
        input.scope ?? "all",
        input.id,
      );
      const position = currentResp.content.indexOf(recallBlock);
      sessionState.recallStore.set(storeKey, {
        toolUseId: recallBlock.id,
        input,
        position,
        result,
      });

      const markerResp = replaceRecallWithMarker(currentResp);

      if (hasOtherToolUse(currentResp)) {
        // Mixed tools — return response with marker, client handles the rest
        log.info(
          `recall (non-stream, mixed, depth=${recallDepth}): stored result for session ${sessionState.sessionID.slice(0, 16)}`,
        );
        markerResp.usage = cumulativeUsage;
        postResponse(
          req,
          markerResp,
          sessionState,
          config,
          requestBody,
          genAiSpan,
        );
        return nonStreamHttpResponse(
          unsustainable ? injectContextWarning(markerResp) : markerResp,
          req.protocol,
          req.stream,
          { "x-lore-recall-invoked": "true" },
        );
      }

      // Recall-only — send follow-up request for seamless UX.
      // Build (stream:false) + forward + assert-JSON + parse in one coupled
      // call so the follow-up's stream flag can never diverge from how the
      // continuation is consumed (accumulateNonStreamResponse).
      log.info(
        `recall (non-stream, depth=${recallDepth}): executing follow-up for session ${sessionState.sessionID.slice(0, 16)}`,
      );
      const jsonRecallCtx: RecallFollowUpCtx = {
        forward: (r) =>
          forwardToUpstream(r, config, undefined, {
            ...cacheOptions,
            cacheConversation: false,
          }),
        parseJSON: accumulateNonStreamResponse,
      };
      let jsonFollowUp: Awaited<ReturnType<typeof runRecallFollowUpJSON>>;
      try {
        jsonFollowUp = await runRecallFollowUpJSON(
          jsonRecallCtx,
          currentModifiedReq,
          currentResp,
          result,
          recallBlock,
        );
      } catch (fetchErr) {
        log.error(
          `recall follow-up fetch error (non-stream, depth=${recallDepth}) for session ${sessionState.sessionID.slice(0, 16)}:`,
          fetchErr,
        );
        // Fall back to response with marker (no continuation)
        markerResp.usage = cumulativeUsage;
        postResponse(
          req,
          markerResp,
          sessionState,
          config,
          requestBody,
          genAiSpan,
        );
        return nonStreamHttpResponse(
          unsustainable ? injectContextWarning(markerResp) : markerResp,
          req.protocol,
          req.stream,
          { "x-lore-recall-invoked": "true" },
        );
      }

      if (!jsonFollowUp.ok) {
        log.error(
          `recall follow-up upstream error: ${jsonFollowUp.status ?? "?"} ${jsonFollowUp.detail}`,
          new Error(`recall follow-up upstream ${jsonFollowUp.status ?? "?"}`),
        );
        // Fall back to response with marker (no continuation)
        markerResp.usage = cumulativeUsage;
        postResponse(
          req,
          markerResp,
          sessionState,
          config,
          requestBody,
          genAiSpan,
        );
        return nonStreamHttpResponse(
          unsustainable ? injectContextWarning(markerResp) : markerResp,
          req.protocol,
          req.stream,
          { "x-lore-recall-invoked": "true" },
        );
      }

      const { continuation: continuationResp, followUp } = jsonFollowUp;

      // Accumulate usage from this iteration
      const contUsage = continuationResp.usage ?? ZERO_USAGE;
      cumulativeUsage.inputTokens += contUsage.inputTokens;
      cumulativeUsage.outputTokens += contUsage.outputTokens;
      if (contUsage.cacheReadInputTokens) {
        cumulativeUsage.cacheReadInputTokens =
          (cumulativeUsage.cacheReadInputTokens ?? 0) +
          contUsage.cacheReadInputTokens;
      }
      if (contUsage.cacheCreationInputTokens) {
        cumulativeUsage.cacheCreationInputTokens =
          (cumulativeUsage.cacheCreationInputTokens ?? 0) +
          contUsage.cacheCreationInputTokens;
      }

      // Update for next iteration
      currentModifiedReq = followUp;
      currentResp = continuationResp;
      // Loop continues — hasRecallToolUse checked at top
    }

    // Depth exhausted or no more recall — finalize
    if (hasRecallToolUse(currentResp)) {
      log.warn(
        `recall depth exhausted (${MAX_RECALL_DEPTH}) — stripping remaining recall`,
      );
      currentResp = replaceRecallWithMarker(currentResp);
    }
    currentResp.usage = cumulativeUsage;
    postResponse(
      req,
      currentResp,
      sessionState,
      config,
      requestBody,
      genAiSpan,
    );
    const recallHeaders =
      recallDepth > 0 ? { "x-lore-recall-invoked": "true" } : undefined;
    return nonStreamHttpResponse(
      unsustainable ? injectContextWarning(currentResp) : currentResp,
      req.protocol,
      req.stream,
      recallHeaders,
    );
  };

  if (req.stream && upstreamResponse.body) {
    // Non-Anthropic upstream streaming responses need their own accumulator
    // since the Anthropic SSE accumulator can't parse OpenAI SSE formats.
    // Both OpenAI variants accumulate into internal Anthropic-format and then
    // run the SAME recall interception loop as the non-streaming path —
    // otherwise an injected `recall` tool_use would leak straight to the client.
    if (effectiveProtocol === "openai-responses") {
      const resp = await accumulateResponsesSSEStream(upstreamResponse);
      return finalizeWithRecall(resp);
    }

    if (effectiveProtocol === "openai") {
      // OpenAI Chat Completions streaming — accumulate and return as
      // non-streaming Anthropic format (same pattern as non-stream path).
      const resp = await accumulateNonStreamOpenAIStream(upstreamResponse);
      return finalizeWithRecall(resp);
    }

    // Anthropic streaming: forward events and accumulate in parallel.
    // Pass recall context so the accumulator can intercept recall tool_use.
    const hasRecallTool = modifiedReq.tools.some(
      (t) => t.name === RECALL_TOOL_NAME,
    );
    const anthropicSSE = buildStreamingResponse(
      upstreamResponse,
      (resp) =>
        postResponse(req, resp, sessionState, config, requestBody, genAiSpan),
      hasRecallTool
        ? { modifiedReq, config, sessionState, cacheOptions }
        : undefined,
      unsustainable ? CONTEXT_WARNING_TEXT : undefined,
    );
    // Translate to client's wire format if needed. When the upstream is
    // Anthropic but the client speaks OpenAI, wrap the Anthropic SSE stream.
    if (req.protocol === "openai") {
      return translateAnthropicStreamToOpenAI(anthropicSSE);
    }
    if (req.protocol === "openai-responses") {
      return translateAnthropicStreamToResponses(anthropicSSE);
    }
    return anthropicSSE;
  }

  // Non-streaming: dispatch to correct accumulator based on upstream protocol.
  const resp = await accumulateNonStreamResponse(
    upstreamResponse,
    effectiveProtocol,
  );
  return finalizeWithRecall(resp);
}

// ---------------------------------------------------------------------------
// Lore message → Gateway message conversion
// ---------------------------------------------------------------------------

/**
 * Convert transformed Lore messages back to gateway message format.
 *
 * This reverses `gatewayMessagesToLore` after gradient transform has
 * potentially trimmed/reordered messages.
 *
 * Completed/error tool parts on assistant messages produce BOTH a `tool_use`
 * block on the assistant AND a corresponding `tool_result` block injected at
 * the start of the following user message. This makes the conversion
 * self-contained: tool pairing is reconstructed from whatever messages
 * survived gradient eviction, without depending on cross-message `tool_result`
 * parts that can become orphaned when the assistant message is evicted.
 *
 * `resolveToolResults()` strips `tool: "result"` parts from user messages
 * after pairing, so under normal operation those parts are gone. The fallback
 * handling for residual `tool: "result"` parts is kept for robustness.
 */
/**
 * Reconstruct tool_result content as a `GatewayContentBlock[]` from a Lore
 * tool state. If structured `blocks` were preserved (non-text sub-blocks like
 * images), re-emit them losslessly; otherwise wrap the text string.
 */
function toolResultContent(state: {
  status: string;
  output?: string;
  error?: string;
  blocks?: unknown[];
}): GatewayContentBlock[] {
  if (state.blocks && state.blocks.length > 0) {
    // Re-emit the structured blocks that were preserved from ingress.
    return state.blocks as GatewayContentBlock[];
  }
  const text =
    state.status === "error"
      ? (state.error ?? "[error]")
      : (state.output ?? "");
  return text ? [{ type: "text", text }] : [];
}

/** @internal Exported for tests. */
export function loreMessagesToGateway(
  messages: LoreMessageWithParts[],
): Array<{ role: "user" | "assistant"; content: GatewayContentBlock[] }> {
  const out: Array<{
    role: "user" | "assistant";
    content: GatewayContentBlock[];
  }> = [];

  // tool_result blocks reconstructed from the preceding assistant message's
  // completed/error tool parts. Injected at the start of the next user message.
  let pendingToolResults: GatewayContentBlock[] = [];

  for (const msg of messages) {
    const content: GatewayContentBlock[] = [];

    if (msg.info.role === "user") {
      // Inject reconstructed tool_result blocks from preceding assistant
      content.push(...pendingToolResults);
      pendingToolResults = [];
    } else {
      // New assistant message — reset pending results (shouldn't have any
      // in well-formed conversations, but handles back-to-back assistants)
      pendingToolResults = [];
    }

    for (const part of msg.parts) {
      switch (part.type) {
        case "text":
          content.push({
            type: "text",
            text: (part as { text: string }).text,
          });
          break;
        case "reasoning":
          content.push({
            type: "thinking",
            thinking: (part as { text: string }).text ?? "",
            ...((part as { signature?: string }).signature != null
              ? { signature: (part as { signature?: string }).signature }
              : undefined),
          });
          break;
        case "tool": {
          const toolPart = part as {
            type: "tool";
            tool: string;
            callID: string;
            state: {
              status: string;
              input?: unknown;
              output?: string;
              error?: string;
            };
          };
          if (toolPart.tool === "result") {
            // Residual tool_result part (should have been stripped by
            // resolveToolResults, but handle gracefully for robustness)
            content.push({
              type: "tool_result",
              toolUseId: toolPart.callID,
              content: toolResultContent(toolPart.state),
            });
          } else {
            // Emit tool_use on this assistant message
            content.push({
              type: "tool_use",
              id: toolPart.callID,
              name: toolPart.tool,
              input: toolPart.state.input ?? {},
            });
            // Completed/error tool parts: queue a tool_result for the next
            // user message. This reconstructs the Anthropic API's split-
            // message format from Lore's single-message representation.
            if (toolPart.state.status === "completed") {
              pendingToolResults.push({
                type: "tool_result",
                toolUseId: toolPart.callID,
                content: toolResultContent(toolPart.state),
              });
            } else if (toolPart.state.status === "error") {
              pendingToolResults.push({
                type: "tool_result",
                toolUseId: toolPart.callID,
                content: toolResultContent(toolPart.state),
                isError: true,
              });
            }
            // Pending tool parts (not yet resolved) only emit tool_use —
            // the model will see an unresolved tool call. sanitizeToolParts
            // in gradient.ts converts these to error state before this point.
          }
          break;
        }
        // Opaque parts (image, audio, document, …) — reconstruct the
        // gateway opaque block from the generic part's raw payload.
        default:
          if (
            "raw" in part &&
            typeof part.raw === "object" &&
            part.raw !== null
          ) {
            content.push({
              type: "opaque",
              raw: part.raw as Record<string, unknown>,
            });
          } else if ("text" in part && typeof part.text === "string") {
            content.push({ type: "text", text: part.text });
          }
          break;
      }
    }

    out.push({ role: msg.info.role as "user" | "assistant", content });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Post-conversion validation: remove orphaned tool_result blocks
// ---------------------------------------------------------------------------

/**
 * Belt-and-suspenders safety net: ensures every `tool_result` block on a user
 * message references a `tool_use` block on the immediately preceding assistant
 * message. Removes orphans and logs a warning.
 *
 * This should never fire under normal operation (resolveToolResults strips
 * redundant tool_result parts, and loreMessagesToGateway reconstructs them
 * from the assistant's completed tool parts). But if a future code path
 * introduces orphaned references, this catches them before they reach the API.
 */
/** @internal Exported for tests. */
export function removeOrphanedToolResults(
  messages: Array<{
    role: "user" | "assistant";
    content: GatewayContentBlock[];
  }>,
): void {
  // --- Pass 1: Remove orphaned tool_result blocks (tool_result → tool_use) ---
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg?.role !== "user") continue;
    if (!msg.content.some((b) => b.type === "tool_result")) continue;

    // Collect tool_use IDs from the preceding assistant message
    const prevMsg = i > 0 ? messages[i - 1] : undefined;
    const prev = prevMsg?.role === "assistant" ? prevMsg : null;
    const toolUseIds = new Set(
      (prev?.content ?? [])
        .filter((b): b is GatewayToolUseBlock => b.type === "tool_use")
        .map((b) => b.id),
    );

    // Remove tool_result blocks that reference missing tool_use IDs
    const before = msg.content.length;
    msg.content = msg.content.filter(
      (b) =>
        b.type !== "tool_result" ||
        toolUseIds.has((b as GatewayToolResultBlock).toolUseId),
    );
    if (msg.content.length < before) {
      log.warn(
        `removed ${before - msg.content.length} orphaned tool_result block(s) from message ${i}`,
      );
    }
    // If the user message is now empty, add placeholder text so the API
    // doesn't reject an empty content array.
    if (msg.content.length === 0) {
      msg.content = [{ type: "text", text: "[tool results provided]" }];
    }
  }

  // --- Pass 2: Remove orphaned tool_use blocks (tool_use → tool_result) ---
  // Every tool_use on an assistant must have a matching tool_result on the
  // immediately following user message. Without this, the Anthropic API
  // rejects with "tool_use ids found without tool_result blocks immediately
  // after". This catches edge cases where gradient eviction or back-to-back
  // assistants leave tool_use blocks without matching results (#424).
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    if (!msg.content.some((b) => b.type === "tool_use")) continue;

    // Collect tool_result IDs from the following user message
    const nextMsg = i + 1 < messages.length ? messages[i + 1] : undefined;
    const next = nextMsg?.role === "user" ? nextMsg : null;
    const toolResultIds = new Set(
      (next?.content ?? [])
        .filter((b): b is GatewayToolResultBlock => b.type === "tool_result")
        .map((b) => b.toolUseId),
    );

    // Remove tool_use blocks that have no matching tool_result
    const before = msg.content.length;
    msg.content = msg.content.filter(
      (b) =>
        b.type !== "tool_use" ||
        toolResultIds.has((b as GatewayToolUseBlock).id),
    );
    if (msg.content.length < before) {
      log.warn(
        `removed ${before - msg.content.length} orphaned tool_use block(s) from assistant message ${i}`,
      );
    }
    // If the assistant message is now empty, add placeholder text.
    if (msg.content.length === 0) {
      msg.content = [{ type: "text", text: "[assistant response]" }];
    }
  }
}

// ---------------------------------------------------------------------------
// Slash command interception (/lore:warm:*)
// ---------------------------------------------------------------------------

/**
 * Extract the text of the last user message, trimmed.
 * Returns empty string if no user message found.
 */
function lastUserTextTrimmed(req: GatewayRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const msg = req.messages[i];
    if (msg.role !== "user") continue;
    const text = msg.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("\n")
      .trim();
    return text;
  }
  return "";
}

// ---------------------------------------------------------------------------
// Generic /lore:* slash command dispatcher
// ---------------------------------------------------------------------------

/**
 * Intercepts all `/lore:*` slash commands. Routes to specific handlers
 * and returns a synthetic response. Unknown `/lore:*` commands get a
 * helpful error response instead of being forwarded upstream.
 */
async function handleLoreSlashCommand(
  req: GatewayRequest,
  allSessions: Map<string, SessionState>,
  config: GatewayConfig,
): Promise<Response | null> {
  const text = lastUserTextTrimmed(req);
  if (!text.toLowerCase().startsWith("/lore:")) return null;

  // Route to specific handlers
  const warmupResult = handleWarmupSlashCommand(req, allSessions);
  if (warmupResult) return warmupResult;

  const curateResult = await handleCurateSlashCommand(req, allSessions, config);
  if (curateResult) return curateResult;

  const amnesiaResult = handleAmnesiaSlashCommand(req, allSessions);
  if (amnesiaResult) return amnesiaResult;

  // Unknown /lore:* command — return error instead of forwarding upstream
  log.warn(`unknown slash command: ${text}`);
  return slashResponse(
    req,
    `Unknown command: ${text}. Available: /lore:curate, /lore:warm:stop|keep|auto, /lore:amnesia:on|off`,
    `msg_lore_${Date.now()}`,
  );
}

// ---------------------------------------------------------------------------
// /lore:amnesia — toggle temporal storage and background work
// ---------------------------------------------------------------------------

/**
 * `/lore:amnesia:on` — suppresses temporal storage and background work.
 * `/lore:amnesia:off` — resumes normal storage.
 *
 * The session still gets full Lore processing (LTM injection, recall tool,
 * gradient transform) but doesn't write new memories. Useful for eval QA
 * questions, read-only introspection, and sensitive conversations.
 */
function handleAmnesiaSlashCommand(
  req: GatewayRequest,
  allSessions: Map<string, SessionState>,
): Response | null {
  const text = lastUserTextTrimmed(req);
  const lower = text.toLowerCase();

  const isOn = lower === "/lore:amnesia:on";
  const isOff = lower === "/lore:amnesia:off";
  if (!isOn && !isOff) return null;

  // Find the session
  const known = extractKnownSessionHeader(req.rawHeaders);
  let state: SessionState | undefined;
  if (known) {
    const indexKey = `${known.headerName}:${known.sessionId}`;
    const sid = headerSessionIndex.get(indexKey);
    if (sid) state = allSessions.get(sid);
  }

  if (state) {
    state.amnesia = isOn;
    log.info(
      `amnesia: ${lower} for session=${state.sessionID.slice(0, 16)} — ` +
        `storage ${isOn ? "suppressed" : "resumed"}`,
    );
  }

  const responseText = isOn
    ? "Amnesia mode on — memory storage suppressed. Recall still works."
    : "Amnesia mode off — memory storage resumed.";
  return slashResponse(req, responseText, `msg_lore_${Date.now()}`);
}

// ---------------------------------------------------------------------------
// /lore:warm — cache warming control
// ---------------------------------------------------------------------------

/**
 * Check if the last user message is a warmup slash command.
 *
 * `/lore:warm:stop` — disables cache warming for this session.
 * `/lore:warm:keep` — forces cache warming regardless of survival analysis.
 * `/lore:warm:auto` — returns to normal survival-analysis-driven mode.
 *
 * Returns a synthetic Anthropic-format response if a command was matched,
 * or null to continue normal processing.
 */
function handleWarmupSlashCommand(
  req: GatewayRequest,
  allSessions: Map<string, SessionState>,
): Response | null {
  const text = lastUserTextTrimmed(req);
  const lower = text.toLowerCase();

  const isStop = lower === "/lore:warm:stop";
  const isKeep = lower === "/lore:warm:keep";
  const isAuto = lower === "/lore:warm:auto";
  if (!isStop && !isKeep && !isAuto) return null;

  // Find the session for this request (use the same header-based lookup)
  const known = extractKnownSessionHeader(req.rawHeaders);
  let state: SessionState | undefined;
  if (known) {
    const indexKey = `${known.headerName}:${known.sessionId}`;
    const sid = headerSessionIndex.get(indexKey);
    if (sid) state = allSessions.get(sid);
  }

  // Update session warmup state
  if (state) {
    if (!state.warmup) {
      state.warmup = {
        lastWarmupAt: 0,
        warmupCount: 0,
        totalWarmups: 0,
        warmupHits: 0,
        disabled: false,
      };
    }
    if (isStop) {
      state.warmup.disabled = true;
      state.warmup.forceKeepWarm = false;
    } else if (isKeep) {
      state.warmup.forceKeepWarm = true;
      state.warmup.disabled = false;
    } else {
      // isAuto — return to normal survival-analysis mode
      state.warmup.disabled = false;
      state.warmup.forceKeepWarm = false;
    }
    const modeLabel = isStop ? "stopped" : isKeep ? "forced" : "auto";
    log.info(
      `cache-warmer: ${lower} received for session=${state.sessionID.slice(0, 16)} — ` +
        `warming mode: ${modeLabel}`,
    );
  }

  const responseText = isStop
    ? "Cache warming stopped."
    : isKeep
      ? "Keeping cache warm."
      : "Cache warming set to auto.";
  return slashResponse(req, responseText, `msg_lore_${Date.now()}`);
}

// ---------------------------------------------------------------------------
// Slash command: /lore:curate — synchronous distillation + curation
// ---------------------------------------------------------------------------

/**
 * `/lore:curate` — runs distillation + curation synchronously for the
 * current session and returns the results. Useful for:
 * - Eval harnesses that need curation to complete between session replays
 * - Users who want to force knowledge extraction after a conversation
 *
 * Returns a synthetic response with the curation results.
 */
async function handleCurateSlashCommand(
  req: GatewayRequest,
  allSessions: Map<string, SessionState>,
  config: GatewayConfig,
): Promise<Response | null> {
  const text = lastUserTextTrimmed(req);
  if (text.toLowerCase() !== "/lore:curate") return null;

  // Find the session
  const known = extractKnownSessionHeader(req.rawHeaders);
  let state: SessionState | undefined;
  let sessionID: string | undefined;
  if (known) {
    const indexKey = `${known.headerName}:${known.sessionId}`;
    const sid = headerSessionIndex.get(indexKey);
    if (sid) {
      state = allSessions.get(sid);
      sessionID = sid;
    }
  }

  // Fall back to finding any recent session for this project
  if (!sessionID) {
    // Use the most recently active session
    let latest: SessionState | undefined;
    for (const s of allSessions.values()) {
      if (!latest || s.lastRequestTime > latest.lastRequestTime) {
        latest = s;
      }
    }
    if (latest) {
      state = latest;
      sessionID = latest.sessionID;
    }
  }

  if (!sessionID || !state) {
    return slashResponse(
      req,
      "No active session found for curation.",
      "msg_lore_curate_none",
    );
  }

  const projectPath = state.projectPath;
  const { distillation, curator } = await import("@loreai/core");
  const llm = getLLMClient(config);
  const model = getWorkerModel(state.lastUpstream);

  log.info(`/lore:curate: running for session=${sessionID.slice(0, 16)}`);

  // Force-distill all pending messages (urgent bypasses batch queue)
  let distilled = 0;
  try {
    const dResult = await distillation.run({
      llm,
      projectPath,
      sessionID,
      model,
      force: true,
      skipMeta: true,
      urgent: true,
      callType: "direct",
      workerHealth: makeWorkerHealth(sessionID, "lore-distill"),
    });
    distilled = dResult.distilled;
  } catch (e) {
    log.error("/lore:curate distillation error:", e);
  }

  // Run curation (uses urgent/direct call via the LLM client)
  let created = 0;
  let updated = 0;
  let deleted = 0;
  try {
    const cResult = await curator.run({
      llm,
      projectPath,
      sessionID,
      model,
      workerHealth: makeWorkerHealth(sessionID, "lore-curator"),
    });
    created = cResult.created;
    updated = cResult.updated;
    deleted = cResult.deleted;
  } catch (e) {
    log.error("/lore:curate curation error:", e);
  }

  const responseText =
    `Curation complete: ${distilled} segments distilled, ` +
    `${created} entries created, ${updated} updated, ${deleted} deleted.`;

  log.info(`/lore:curate: ${responseText}`);

  return slashResponse(req, responseText, `msg_lore_curate_${Date.now()}`);
}

/** Build a synthetic slash-command response in the client's wire format. */
function slashResponse(
  req: GatewayRequest,
  text: string,
  msgId: string,
): Response {
  // Build a GatewayResponse and use the protocol-aware response builders
  // so slash commands work correctly for all client protocols.
  const resp: GatewayResponse = {
    id: msgId,
    model: req.model,
    content: [{ type: "text", text }],
    stopReason: "end_turn",
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
  };

  if (req.stream) {
    // Build Anthropic SSE, then translate to client's format if needed
    const anthropicSSE = streamHttpResponse(resp);
    if (req.protocol === "openai") {
      return translateAnthropicStreamToOpenAI(anthropicSSE);
    }
    if (req.protocol === "openai-responses") {
      return translateAnthropicStreamToResponses(anthropicSSE);
    }
    return anthropicSSE;
  }

  return nonStreamHttpResponse(resp, req.protocol, req.stream);
}

// ---------------------------------------------------------------------------
// Error response builder
// ---------------------------------------------------------------------------

function errorResponse(status: number, message: string): Response {
  return new Response(
    JSON.stringify({
      type: "error",
      error: {
        type: "server_error",
        message,
      },
    }),
    {
      status,
      headers: { "content-type": "application/json" },
    },
  );
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Process an incoming gateway request through the full Lore pipeline.
 *
 * Returns a standard `Response` object — either a streaming SSE response
 * or a JSON response, depending on the client's `stream` setting.
 */
export async function handleRequest(
  req: GatewayRequest,
  config: GatewayConfig,
): Promise<Response> {
  try {
    // Guard against malformed invocations (e.g. fuzzers / direct module calls
    // that pass an undefined or header-less request). The real server path
    // always supplies a fully-formed GatewayRequest; bailing out cleanly here
    // avoids a TypeError on `req.rawHeaders` deeper in the pipeline.
    if (!req?.rawHeaders) {
      return errorResponse(400, "Malformed request: missing headers");
    }

    // Capture auth credentials early for background workers
    const earlyAuth = extractAuth(req.rawHeaders);
    if (earlyAuth) {
      setLastSeenAuth(earlyAuth);
    }

    // --- Quick Tier-1 session lookup for structural compaction detection ---
    // O(1) header + map lookup — lets us compare message counts before routing.
    let priorState: SessionState | undefined;
    const known = extractKnownSessionHeader(req.rawHeaders);
    if (known) {
      const indexKey = `${known.headerName}:${known.sessionId}`;
      const sid = headerSessionIndex.get(indexKey);
      if (sid) priorState = sessions.get(sid);
    }

    // --- Case 0: Slash command interception (/lore:*) ---
    // All /lore:* commands are intercepted here and never forwarded upstream.
    const slashResult = await handleLoreSlashCommand(req, sessions, config);
    if (slashResult) return slashResult;

    // --- Case 1: Compaction request → intercept ---
    // Structural detection (session-aware) first, pattern matching as fallback.
    // Sub-agents now get their own sessions (separate x-session-affinity), so
    // priorState is the sub-agent's own state — structural detection is safe.
    const structuralCompaction = isStructuralCompaction(req, priorState);
    const patternDetection = structuralCompaction
      ? undefined
      : detectCompactionRequest(req);
    if (structuralCompaction || patternDetection?.detected) {
      const reason = structuralCompaction
        ? `structural (prior=${priorState?.messageCount ?? "?"} curr=${req.messages.length})`
        : patternDetection?.detected
          ? patternDetection.reason === "system-prompt"
            ? `pattern: system-prompt match "${patternDetection.pattern}"`
            : patternDetection.reason === "user-keywords"
              ? `pattern: user-keyword match "${patternDetection.pattern}"`
              : `pattern: template-sections (${patternDetection.matchCount} matches)`
          : "unknown";
      log.info(
        `compaction detected: ${reason} messages=${req.messages.length} tools=${req.tools.length}`,
      );
      return await handleCompaction(req, config);
    }

    // --- Case 2: Meta request (title gen, summary, categorization, etc.) → passthrough ---
    if (isMetaRequest(req)) {
      log.info(
        `meta request detected: messages=${req.messages.length} tools=${req.tools.length}` +
          ` maxTokens=${req.maxTokens} agent=${req.rawHeaders[LORE_AGENT_HEADER] ?? "none"}`,
      );
      return await handlePassthrough(req, config);
    }

    // --- Case 3: Normal conversation turn → full pipeline ---
    return await handleConversationTurn(req, config);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Unknown gateway error";
    // Client disconnect / abort is benign — downgrade from error to info.
    const isAbort = err instanceof DOMException && err.name === "AbortError";
    if (isAbort) {
      log.info("pipeline aborted (client disconnect)");
    } else {
      log.error("pipeline error:", err);
    }
    return errorResponse(502, message);
  }
}
