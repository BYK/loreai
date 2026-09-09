Warning: truncated output (original token count: 190030)
Total output lines: 19651

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
import { copyUsageLimitHeaders } from "./usage-limit-headers";
import { storeTurnTemporal, type TurnTemporalInput } from "./turn-temporal";
import {
  PreparationTiming,
  prepareSemanticMessages,
} from "./semantic-preparation";
export { storeTurnTemporal } from "./turn-temporal";
export { responsesProvenanceByMessageId } from "./semantic-preparation";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { LoreMessageWithParts, LLMClient } from "@loreai/core";
import {
  FullSourceRequired,
  asString,
  estimateTokens as coreEstimateTokens,
} from "@loreai/core";
import {
  load,
  config as loreConfig,
  ensureProject,
  recordCacheBustObservation,
  findSessionStatesByFingerprint,
  countMatchingTemporalIds,
  getGitRemote,
  projectId,
  resolveProjectByRemoteOrPath,
  projectGitRemote,
  mergeProjectInternal,
  isUnattributedProjectPath,
  temporal,
  ltm,
  SyntheticProbeResolver,
  NoopResolver,
  buildRefcheckProbeScript,
  entities,
  distillation,
  curator,
  log,
  transform,
  prewarmDistillationSnapshot,
  isLargeColdStart,
  setModelLimits,
  setLtmTokens,
  getLtmBudget,
  getPreferenceLtmBudget,
  setMaxLayer0Tokens,
  setForceMinLayer,
  computeLayer0Cap,
  setCachePricing,
  setQualityKnee,
  resolveQualityKnee,
  DEFAULT_QUALITY_KNEE_FRACTION,
  distillLimiter,
  curatorLimiter,
  recordCacheUsage,
  exportDedupDecisions,
  importDedupDecisions,
  calibrate,
  getLastTransformedCount,
  getLastTransformEstimate,
  onIdleResume,
  getCacheStrategy,
  strategyWantsWarming,
  type CacheStrategy,
  consumeCameOutOfIdle,
  needsUrgentDistillation,
  formatKnowledge,
  shouldImportLoreFile,
  importLoreFile,
  loreFileExists,
  shouldImport,
  importFromFile,
  LORE_FILE,
  AGENTS_FILE_CANDIDATES,
  resolveAgentsFileName,
  latReader,
  embedding,
  temporalEmbeddingQueue,
  saveSessionTracking,
  loadSessionTracking,
  appendSessionPromptDelta,
  deleteSessionPromptDelta,
  listSessionPromptDeltas,
  updateSessionPromptDeltaSelector,
  updateSessionPromptDeltaContent,
  withSavepoint,
  loadHeaderSessionIndex,
  isHostedMode,
  enableHostedMode,
  importLoreFileAs,
  resolveWorkspaces,
  currentTenantId,
  withTenant,
} from "@loreai/core";

import type {
  GatewayRequest,
  GatewayResponse,
  GatewayMessage,
  GatewayContentBlock,
  GatewayToolUseBlock,
  GatewayToolResultBlock,
  GatewayUsage,
  StoredRecall,
  SessionState,
  UpstreamSnapshot,
  WarmupState,
} from "./translate/types";
import {
  applyUpstreamExtraHeaders,
  buildUpstreamSnapshotHeaders,
  blocksToText,
  isEmptyCompletion,
  looksLikeSSE,
  providerRoutingValue,
  requestTargetsOpenRouter,
  ZERO_USAGE,
} from "./translate/types";
import type { GatewayConfig } from "./config";
import {
  getProjectPath,
  extractGitRemoteHeader,
  resolveUpstreamRoute,
  extractUpstreamUrlHeader,
  extractUpstreamPathHeader,
  verbatimUpstreamUrl,
  extractProviderHeader,
  hasCopilotIntegrationHeader,
  resolveProviderRoute,
  extraHeadersForUpstream,
  upstreamUrlForLog,
  isUpstreamWithinBase,
  isCallerUpstreamAllowed,
  normalizeUpstreamBase,
  unattributedBucketPath,
  type ProjectPathResult,
} from "./config";
import {
  generateSessionID,
  fingerprintMessages,
  MESSAGE_COUNT_PROXIMITY_THRESHOLD,
  KNOWN_SESSION_HEADERS,
  extractKnownSessionHeader,
  isClaudeCodeSubagent,
  learnHeaders,
  observeHeaderValues,
  isCredentialHeaderName,
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
  maxReportedUsageForModel,
  clientMeteredContextWindow,
  requestEnablesLongContext,
  MAX_OUTPUT_RESERVE,
  DEFAULT_MAX_REPORTED_USAGE,
} from "./compaction";
import {
  buildAnthropicRequest,
  buildAnthropicNonStreamResponse,
  parseAnthropicResponseJSON,
  type AnthropicCacheOptions,
} from "./translate/anthropic";
import {
  bedrockMantleUrl,
  isBedrockMantleDispatch,
  toMantleModelId,
} from "./translate/bedrock";
import { buildVertexUpstream, vertexHost } from "./translate/vertex";
import { getVertexAccessToken, resolveVertexProject } from "./vertex-auth";
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
  streamResponsesPassthrough,
  translateAnthropicStreamToResponses,
  applyResponsesEvent,
  finalizeResponsesAcc,
  formatResponsesEvent,
  makeResponsesAccState,
  mapStatusFromStopReason,
  isSupportedResponsesOutputItemType,
  isValidResponsesOutputItemStatus,
  isValidResponsesReasoningEncryptedContent,
  responsesDoneItemMatchesAdded,
  responsesTerminalItemMatches,
  normalizeCodexResponsesEvent,
  ResponsesTerminalError,
  type ResponsesAccState,
} from "./stream/openai-responses";
import {
  accumulateOpenAISSEStream,
  translateAnthropicStreamToOpenAI,
} from "./stream/openai";
import {
  buildGeminiUpstreamRequest,
  buildGeminiResponse,
  parseGeminiResponseJSON,
} from "./translate/gemini";
import {
  accumulateGeminiSSEStream,
  translateAnthropicStreamToGemini,
} from "./stream/gemini";
import {
  safeTokenSum,
  validateOpenAIUsage,
  validateResponsesUsage,
} from "./usage-validation";
import {
  accumulateSSEResponse,
  createStreamAccumulator,
  createRecallAwareAccumulator,
  parseSSEStream,
  buildSSEResponse,
  buildSSEToolUseResponse,
  buildKeepaliveCompactionStream,
  buildSSEMarkerMessage,
  formatSSEEvent,
  AnthropicSSEValidator,
  cancelAndReleaseReader,
  readStreamChunk,
  SSEStreamLimitError,
  SSEStreamTransportError,
  DEFAULT_MAX_SSE_FRAMES,
  type StreamAccumulator,
  type RecallAwareAccumulator,
} from "./stream/anthropic";
import {
  gatewayMessagesToLore,
  deterministicID,
  legacyDeterministicID,
} from "./temporal-adapter";
import {
  canonicalWorkerProviderID,
  createGatewayLLMClient,
  disjointOpenAIInputTokens,
  workerProviderSupportsProtocol,
  type GatewayPromptOptions,
} from "./llm-adapter";
import { createBatchLLMClient } from "./batch-queue";
import {
  runBackground,
  resetBackgroundLimiter,
  isBackgroundPaused,
  drainBackground,
  boundedSettle,
} from "./background-limiter";
import {
  copyProviderAuthHeaders,
  extractAuth,
  authFingerprint,
  credentialTenantFingerprint,
  setLastSeenAuth,
  setSessionAuth,
  resolveAuth,
  isAuthStale,
  hasConflictingAuthHeaders,
  workerKeyScheme,
  type AuthCredential,
} from "./auth";
import type { UpstreamInterceptor } from "./recorder";
import {
  startIdleScheduler,
  buildIdleWorkHandler,
  evictIdleSessions,
} from "./idle";
import { flushPendingImport } from "./pending-import";
import { makeTemporalBackfillGate } from "./backfill-gate";
import { buildSessionMetadata } from "./session-metadata";
import { hasWorkerSessionAuth } from "./worker-auth";
import {
  makeWorkerHealth,
  allowWorkerProbe,
  isWorkerCreditPaused,
  getDegradationWarning,
} from "./worker-health";
import {
  getWorkerModel,
  resetWorkerModelState,
  fetchModelData,
  ensureModelDataReady,
  getModelEntrySync,
  getModelEntrySyncForProvider,
  isModelDataLoaded,
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
import { isClaudeCodeSideChannel } from "./side-channel";
import {
  analyzeCacheTurn,
  categorizeBust,
  type CacheBustCause,
} from "./cache-analytics";
import {
  recordGap,
  getSessionHistogram,
  recordGlobalGap,
  resolveProfile as resolveWarmingProfile,
  clearWarmupAuthDisabled,
  creditWarmupHit,
  resetCircuitBreaker,
  setWarmingEnabled,
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
  spanStartupBackfill,
  captureClientAbortUnderPressure,
  captureEmptyCompletion,
  type AnthropicUsage,
} from "./sentry";
import { createRecallDiagnostics } from "./recall-diagnostics";
import {
  MAX_RECALL_EXECUTIONS,
  RecallChainBudget,
  type RecallStopReason,
} from "./recall-budget";
import {
  RecallContinuationFailure,
  reportRecallContinuationFailure,
  type RecallContinuationFailureCategory,
} from "./recall-continuation-failure";
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
  executeRecall,
  findRecallToolUse,
  hasRecallToolUse,
  isUsableRecallContinuation,
  hasOtherToolUse,
  clientHasRecallTool,
  runRecallFollowUpStreaming,
  runRecallFollowUpJSON,
  runRecallFollowUpStreamAccumulated,
  type RecallFollowUpCtx,
  buildRecallAnchor,
  parseRecallAnchor,
  buildAnchoredRecallMarker,
  expandRecallMarkers,
  cleanupRecallStore,
  replaceRecallWithMarker,
  serializeRecallStore,
  addRecallStoreEntry,
  deserializeRecallStore,
  recallAnchorContext,
} from "./recall";
import { upstreamFetch } from "./fetch";
import { promiseAgainstAbort, responseAgainstAbort } from "./abort-race";
import {
  buildUpstreamRouteContext,
  decodeRequestBody,
  encodeUpstreamBodyForRoute,
} from "./http-body";
import {
  findReadTool,
  findShellTool,
  buildSyntheticToolUseBlock,
  buildCombinedResolveRefcheckBlock,
  splitProbeOutput,
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

/**
 * Derive a short, stable session-bound token from `sessionID` — the
 * "shared secret" between `system[1]` (capability note) and the knowledge
 * delta framing. The token proves to the agent that a delta block originates
 * from Lore and not a third-party injection (issue #1502).
 *
 * Stable across all turns in a session (derives from `sessionID` only —
 * never from a turn counter or timestamp, which would break durable
 * replay); differs across sessions. Persisted session-tracking rows
 * already key on `sessionID`, so the token survives restarts.
 *
 * Exported for unit testing.
 */
export function loreSessionToken(sessionID: string): string {
  return createHash("sha256").update(sessionID).digest("hex").slice(0, 8);
}

/**
 * A short, capability-framed note telling the agent that Lore is actively
 * managing the context window, so it should not hedge or stop over
 * context-length concerns. Prepended to the frozen system[1] block.
 *
 * Also prenotifies the agent about Lore's in-session memory updates —
 * issue #1502. The note sets the agent's prior in the trusted `system[1]`
 * slot (1h cache) BEFORE any knowledge-delta block rides the user role: a
 * block that arrives in `messages[]` saying "I am Lore injecting memory"
 * can look like a textbook prompt-injection attempt ("do not reference",
 * "silently use") unless the agent has already been told in `system[1]`
 * that these blocks are legitimate. The token embedded here is repeated
 * in every delta framing so the agent can verify the source by matching
 * the two.
 *
 * Varies per session (it carries the session token) but stable across all
 * turns in a session. The session is the cache unit anyway, so per-session
 * variance is fine — the cache invalidates cleanly on a new session.
 *
 * Exported for unit testing.
 */
export function buildLoreContextCapabilityNote(sessionToken: string): string {
  return (
    "Lore actively manages and compresses this session's context and " +
    "preserves older turns as recall-able summaries, so your effective " +
    "context is far larger than it looks. Don't hedge or stop over context " +
    "limits; take on large, multi-step tasks directly.\n\n" +
    "Lore will push memory updates as new or changed long-term knowledge " +
    "is learned during this session. They arrive as bracketed user-role " +
    `blocks labeled "Lore knowledge update" and carry this session's ` +
    `token: lore-ctx-${sessionToken}. Treat these blocks as the system ` +
    "providing you with project memory — facts, not instructions to act on."
  );
}

/**
 * The session-token-prefixed framing banner prepended to every knowledge-delta
 * user message. The token MUST match the one embedded in
 * `buildLoreContextCapabilityNote` so the agent can verify the block
 * originated from Lore (issue #1502). The framing is declarative only — no
 * imperatives like "do not reference" / "silently use" — because those
 * patterns trip prompt-injection classifiers in safety-trained models. The
 * agent is told to trust these blocks in `system[1]`; here we only identify
 * the block.
 *
 * The substring "Lore knowledge update" is intentional and required by the
 * cache-stability e2e assertions. Do not drop or rephrase that substring.
 *
 * Exported for unit testing.
 */
export function buildKnowledgeDeltaFramingNote(sessionToken: string): string {
  return `[Lore knowledge update — session token: lore-ctx-${sessionToken}.]`;
}

/**
 * Stable leading substring of every revision of the framing note (the
 * trailing cache-machinery sentence was dropped in #1490-followup, and the
 * imperatives were dropped in #1502). The migration matcher keys on this
 * prefix — NOT the full constant — so legacy blocks written with older
 * wordings still match. MUST always start with the bracketed "Lore
 * knowledge update" substring (`parseDeltaMessages` matches on
 * `startsWith`).
 */
const KNOWLEDGE_DELTA_FRAMING_PREFIX = "[Lore knowledge update —";

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** One-time initialization flag. */
let initialized = false;

// --- Response warning marker ---
// Injected into the response (assistant message) so the user can see it.
// Stripped from incoming requests on subsequent turns to preserve cache prefix.
// Used by the worker-degradation warning (#797 removed the unsustainable-
// conversation warning; the marker mechanism stays because worker degradation
// is still user-actionable).
export const CONTEXT_WARNING_MARKER = "[lore:context-warning]";

/**
 * Build the worker-degradation warning text (or null if the session's
 * background workers are healthy / not yet sustained-failing). Reuses the
 * CONTEXT_WARNING_MARKER so it is stripped on the next turn, preserving the
 * prompt cache prefix.
 *
 * This is the user-visible signal that distillation/curation/cache-warming
 * are failing — so degradation (context bloat, no LTM growth) is never silent.
 * The previous "unsustainable conversation" warning (cache bust spirals) was
 * removed because it was almost always an upstream bug the user couldn't
 * action on; that signal now goes to Sentry via setupBustSpiralCapture.
 */
function buildWorkerDegradationWarning(sessionID: string): string | null {
  const warning = getDegradationWarning(sessionID);
  if (!warning) return null;
  return `${CONTEXT_WARNING_MARKER} ${warning}\n\n---\n\n`;
}

/**
 * Insert a warning text block into a response, after any leading thinking
 * blocks. Caller provides the marker'd warning text (currently always the
 * worker-degradation block from buildWorkerDegradationWarning).
 */
function injectContextWarning(
  resp: GatewayResponse,
  text: string,
): GatewayResponse {
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
    text,
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
 *
 * @internal Exported for tests.
 */
export function stripContextWarnings(messages: GatewayMessage[]): void {
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
/** Default upstream origin for native Gemini (Generative Language API). */
const GEMINI_DEFAULT_UPSTREAM = "https://generativelanguage.googleapis.com";

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
/** Monotonic request-start order for concurrency-safe upstream snapshots. */
let upstreamRequestOrder = 0;
/** Test-only seam for forcing adversarial request ordering before capture. */
let beforeUpstreamCaptureForTest:
  | ((req: GatewayRequest, state: SessionState) => Promise<void>)
  | undefined;
/** Foreground request lifetimes cancelled when the pipeline is reset. */
const activeForegroundAbortControllers = new Set<AbortController>();

export function setBeforeUpstreamCaptureForTest(
  hook:
    | ((req: GatewayRequest, state: SessionState) => Promise<void>)
    | undefined,
): void {
  beforeUpstreamCaptureForTest = hook;
}

/** Test-only observer for pinning post-response lifecycle ordering. */
let postResponseStartObserver: (() => void) | undefined;
let recallPersistenceCommitObserver: (() => void) | undefined;
let pipelineResetPauseForTest: Promise<void> | undefined;
let pipelinePreUpstreamPauseForTest:
  | { pause: Promise<void>; onWait: () => void }
  | undefined;
let provisionalFinalizerPauseForTest:
  | { pause: Promise<void>; onWait: () => void }
  | undefined;
let pipelineResetSettleTimeoutMs = 5000;
let pipelineResetInProgress = false;
let pipelineResetPromise: Promise<void> | undefined;

interface ActivePipelineRequest {
  admissionKey: string;
  abort: (reason: unknown) => void;
  settled: Promise<void>;
  sessionIDs: Set<string>;
}

const activePipelineRequests = new Set<ActivePipelineRequest>();
const detachedPipelineRequests = new Set<ActivePipelineRequest>();
const DEFAULT_MAX_ACTIVE_PIPELINE_REQUESTS = 64;
const MAX_ACTIVE_PIPELINE_REQUESTS_PER_ADMISSION_KEY = 16;
const MAX_ACTIVE_PIPELINE_REQUESTS_PER_SESSION = 1;
const MAX_PENDING_SESSION_CLAIMS = 64;
const MAX_DETACHED_PIPELINE_REQUESTS = 64;
let maxActivePipelineRequests = DEFAULT_MAX_ACTIVE_PIPELINE_REQUESTS;
let maxDetachedPipelineRequests = MAX_DETACHED_PIPELINE_REQUESTS;

interface PendingSessionClaim {
  active: ActivePipelineRequest;
  sessionID: string;
  signal: AbortSignal;
  resolve: () => void;
  reject: (reason: unknown) => void;
  onAbort: () => void;
}

const pendingSessionClaims = new Map<string, PendingSessionClaim>();

class PipelineCapacityError extends Error {}

function activePipelineRequestsForSession(sessionID: string): number {
  let count = 0;
  for (const request of activePipelineRequests) {
    if (request.sessionIDs.has(sessionID)) count++;
  }
  return count;
}

function activePipelineRequestsForAdmissionKey(admissionKey: string): number {
  let count = 0;
  for (const request of activePipelineRequests) {
    if (request.admissionKey === admissionKey) count++;
  }
  return count;
}

function pendingSessionClaimsForAdmissionKey(admissionKey: string): number {
  let count = 0;
  for (const claim of pendingSessionClaims.values()) {
    if (claim.active.admissionKey === admissionKey) count++;
  }
  return count;
}

function pipelineSessionHasCapacity(sessionID: string): boolean {
  return (
    activePipelineRequestsForSession(sessionID) +
      (streamingPostResponseFinalizers.get(sessionID)?.pending ?? 0) <
    MAX_ACTIVE_PIPELINE_REQUESTS_PER_SESSION
  );
}

function pumpPendingSessionClaims(): void {
  for (const [sessionID, claim] of pendingSessionClaims) {
    if (
      activePipelineRequests.size + streamingPostResponsePending >=
      maxActivePipelineRequests
    ) {
      return;
    }
    if (
      activePipelineRequestsForAdmissionKey(claim.active.admissionKey) +
        (streamingPostResponsePendingByAdmissionKey.get(
          claim.active.admissionKey,
        ) ?? 0) >=
      MAX_ACTIVE_PIPELINE_REQUESTS_PER_ADMISSION_KEY
    ) {
      continue;
    }
    if (!pipelineSessionHasCapacity(sessionID)) continue;
    pendingSessionClaims.delete(sessionID);
    claim.signal.removeEventListener("abort", claim.onAbort);
    if (claim.signal.aborted) {
      claim.reject(claim.signal.reason);
      continue;
    }
    claim.active.sessionIDs.add(sessionID);
    activePipelineRequests.add(claim.active);
    claim.resolve();
  }
}

function isPipelineSessionActive(sessionID: string): boolean {
  return (
    activePipelineRequestsForSession(sessionID) > 0 ||
    pendingSessionClaims.has(sessionID) ||
    streamingPostResponseFinalizers.has(sessionID)
  );
}

export function activePipelineRequestCountForTest(): number {
  return activePipelineRequests.size;
}

export function detachedPipelineRequestCountForTest(): number {
  return detachedPipelineRequests.size;
}

export function pendingPipelineSessionClaimCountForTest(): number {
  return pendingSessionClaims.size;
}

export function setMaxActivePipelineRequestsForTest(
  limit = DEFAULT_MAX_ACTIVE_PIPELINE_REQUESTS,
): void {
  maxActivePipelineRequests = limit;
}

export function setMaxDetachedPipelineRequestsForTest(
  limit = MAX_DETACHED_PIPELINE_REQUESTS,
): void {
  maxDetachedPipelineRequests = limit;
}

export function isPipelineSessionActiveForTest(sessionID: string): boolean {
  return isPipelineSessionActive(sessionID);
}

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

export function setPostResponseStartObserverForTest(
  observer: (() => void) | undefined,
): void {
  postResponseStartObserver = observer;
}

export function setRecallPersistenceCommitObserverForTest(
  observer: (() => void) | undefined,
): void {
  recallPersistenceCommitObserver = observer;
}

export function setPipelineResetPauseForTest(
  pause: Promise<void> | undefined,
): void {
  pipelineResetPauseForTest = pause;
}

export function setPipelinePreUpstreamPauseForTest(
  pause: Promise<void> | undefined,
  onWait: () => void = () => {},
): void {
  pipelinePreUpstreamPauseForTest = pause ? { pause, onWait } : undefined;
}

export function setProvisionalFinalizerPauseForTest(
  pause: Promise<void> | undefined,
  onWait: () => void = () => {},
): void {
  provisionalFinalizerPauseForTest = pause ? { pause, onWait } : undefined;
}

export function setPipelineResetSettleTimeoutForTest(timeoutMs = 5000): void {
  pipelineResetSettleTimeoutMs = timeoutMs;
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
  if (pipelineResetPromise) return pipelineResetPromise;
  pipelineResetInProgress = true;
  const reset = (async () => {
    try {
      await resetPipelineStateInner(opts);
    } finally {
      pipelineResetInProgress = false;
      pipelineResetPromise = undefined;
    }
  })();
  pipelineResetPromise = reset;
  return reset;
}

async function resetPipelineStateInner(opts?: {
  fast?: boolean;
}): Promise<void> {
  streamingPostResponsesAccepting = false;
  await pipelineResetPauseForTest;
  const resetReason = new DOMException("gateway pipeline reset", "AbortError");
  pipelineGenerationAbort.abort(resetReason);
  const foregroundControllers = [...activeForegroundAbortControllers];
  activeForegroundAbortControllers.clear();
  for (const controller of foregroundControllers) {
    if (!controller.signal.aborted) controller.abort(resetReason);
  }
  const activeRequests = [
    ...new Set([
      ...activePipelineRequests,
      ...[...pendingSessionClaims.values()].map((claim) => claim.active),
    ]),
  ];
  for (const request of activeRequests) request.abort(resetReason);
  await boundedSettle(
    activeRequests.map((request) => request.settled),
    pipelineResetSettleTimeoutMs,
  );
  for (const request of activeRequests) {
    if (!activePipelineRequests.has(request)) continue;
    activePipelineRequests.delete(request);
    request.sessionIDs.clear();
    if (detachedPipelineRequests.size < maxDetachedPipelineRequests) {
      detachedPipelineRequests.add(request);
    } else {
      log.error(
        "pipeline quarantine full; dropping stale lifecycle reservation",
      );
    }
  }
  // Streaming responses register post-response finalizers before closing their
  // bodies. Drain them before sessions or the DB-facing pipeline state are
  // cleared; a finalizer may also schedule ordinary background work, which the
  // non-fast drain below will then observe.
  await boundedSettle(
    [...streamingPostResponseFinalizers.values()].map((state) => state.tail),
    pipelineResetSettleTimeoutMs,
  );
  streamingPostResponseGeneration++;
  pipelineGenerationAbort = new AbortController();
  streamingPostResponseFinalizers.clear();
  streamingPostResponsePendingByAdmissionKey.clear();
  streamingPostResponsePending = 0;
  maxStreamingPostResponses = DEFAULT_MAX_STREAMING_POST_RESPONSES;
  maxStreamingPostResponsesPerSession =
    DEFAULT_MAX_STREAMING_POST_RESPONSES_PER_SESSION;
  lastStreamingPostResponseOverflowLog = 0;
  lastStreamingPostResponseResetLog = 0;
  // Quiesce background work before tearing anything down. Only the non-fast
  // path drains — today that's test/eval teardown (the fast process-exit path,
  // the sole production caller, skips this to keep Ctrl+C snappy). Stop the
  // idle scheduler FIRST so no new ticks schedule work, then await every
  // in-flight distillation / curation / idle task. Done while llmClient + the
  // upstream interceptor are still live so DIRECT-callType tasks (incl. the
  // always-scheduled urgent distillation) complete cleanly; a batch-callType
  // task can't flush until llmClient.shutdown below, so it falls back to the
  // bounded drain timeout (rare in tests — incremental distill/curation seldom
  // trigger in short runs). The point: a late `saveSessionTracking()` write
  // must land in THIS process's DB, not leak into the next one's as a phantom
  // row — the cross-harness contamination behind the #859 flake. See #885.
  if (!opts?.fast) {
    if (stopIdleScheduler) {
      stopIdleScheduler();
      stopIdleScheduler = null;
    }
    await drainBackground();
    // Bound this drain too (Seer) — a stalled urgent distillation / curation
    // chain must not hang the reset, matching drainBackground's guarantee.
    await boundedSettle(inFlightBackground);
    inFlightBackground.clear();
  }
  initialized = false;
  maxActivePipelineRequests = DEFAULT_MAX_ACTIVE_PIPELINE_REQUESTS;
  maxDetachedPipelineRequests = MAX_DETACHED_PIPELINE_REQUESTS;
  sessions.clear();
  cwdWarned.clear();
  staleHeaderWarned.clear();
  subagentParentPendingLogged.clear();
  headerSessionIndex.clear();
  ambiguousHeaderSessionKeys.clear();
  provisionalHeaderSessionIndex.clear();
  identityAdmissionTails.clear();
  headerSessionIndexHydrated = false;
  ltmSessionCache.clear();
  ltmPinnedText.clear();
  lastSavedDedupDecisions.clear();
  stableLtmCache.clear();
  stableLtmInFlight.clear();
  sessionLifecycleAborts.clear();
  streamingPostResponseWaiters.clear();
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
  beforeUpstreamCaptureForTest = undefined;
  postResponseStartObserver = undefined;
  recallPersistenceCommitObserver = undefined;
  provisionalFinalizerPauseForTest = undefined;
  foregroundErrorBodyTimeoutMs = FOREGROUND_ERROR_BODY_TIMEOUT_MS;
  if (stopFileWatcher) {
    stopFileWatcher();
    stopFileWatcher = null;
  }
  if (stopIdleScheduler) {
    stopIdleScheduler();
    stopIdleScheduler = null;
  }
  if (stopSyncScheduler) {
    // Awaits a final best-effort push so local changes reach the server on exit.
    await stopSyncScheduler();
    stopSyncScheduler = null;
  }
  _lastSeenSessionModel = null;
  _firstTurnConfirmed = false;
  resetWorkerModelState();
  resetBackgroundLimiter();
}

/** Per-session state tracked across requests. */
const sessions = new Map<string, SessionState>();

const DEFAULT_MAX_STREAMING_POST_RESPONSES = 64;
// Production requests reserve capacity before upstream work. The limits remain
// as defense-in-depth for unreserved/test-only scheduling.
const DEFAULT_MAX_STREAMING_POST_RESPONSES_PER_SESSION = 2;

/**
 * Deferred streaming finalizers keyed by session. The streamer invokes its
 * callback before closing so registration is atomic with terminal delivery,
 * but the expensive synchronous accounting itself runs on the next event-loop
 * turn, allowing the body reader (and Node bridge) to observe EOF first. The
 * bounded registry preserves in-process ordering; a process crash in that one
 * event-loop-turn window can still lose final accounting, which is the explicit
 * availability trade-off required to avoid holding client EOF behind SQLite.
 */
const streamingPostResponseFinalizers = new Map<
  string,
  { tail: Promise<void>; pending: number }
>();
const streamingPostResponsePendingByAdmissionKey = new Map<string, number>();
let streamingPostResponsePending = 0;
let streamingPostResponseGeneration = 0;
let pipelineGenerationAbort = new AbortController();
let streamingPostResponsesAccepting = true;
let maxStreamingPostResponses = DEFAULT_MAX_STREAMING_POST_RESPONSES;
let maxStreamingPostResponsesPerSession =
  DEFAULT_MAX_STREAMING_POST_RESPONSES_PER_SESSION;
let lastStreamingPostResponseOverflowLog = 0;
let lastStreamingPostResponseResetLog = 0;
let streamingPostResponseWaitObserverForTest: (() => void) | undefined;

export function setStreamingPostResponseLimitsForTest(
  globalLimit?: number,
  perSessionLimit?: number,
): void {
  maxStreamingPostResponses =
    globalLimit ?? DEFAULT_MAX_STREAMING_POST_RESPONSES;
  maxStreamingPostResponsesPerSession =
    perSessionLimit ?? DEFAULT_MAX_STREAMING_POST_RESPONSES_PER_SESSION;
}

export function streamingPostResponsePendingForTest(): number {
  return streamingPostResponsePending;
}

export function setStreamingPostResponseWaitObserverForTest(
  observer: (() => void) | undefined,
): void {
  streamingPostResponseWaitObserverForTest = observer;
}

export function scheduleStreamingPostResponseForTest(
  sessionID: string,
  operation: () => void | Promise<void>,
  onDrop: () => void = () => {},
): void {
  scheduleStreamingPostResponse(
    sessionID,
    streamingPostResponseGeneration,
    operation,
    onDrop,
  );
}

function scheduleStreamingPostResponse(
  sessionID: string,
  generation: number,
  operation: () => void | Promise<void>,
  onDrop: () => void,
  // Conversation requests reserve global + session capacity before upstream.
  // Unreserved callers still use the defensive queue limits below.
  capacityReserved = false,
  admissionKey?: string,
): void {
  const drop = (): void => {
    try {
      onDrop();
    } catch (error) {
      log.error("streaming post-response drop cleanup failed:", error);
    }
  };
  if (
    !streamingPostResponsesAccepting ||
    generation !== streamingPostResponseGeneration
  ) {
    const now = Date.now();
    if (now - lastStreamingPostResponseResetLog >= 30_000) {
      lastStreamingPostResponseResetLog = now;
      log.info("streaming post-response skipped during pipeline reset");
    }
    drop();
    return;
  }
  const existing = streamingPostResponseFinalizers.get(sessionID);
  if (
    (!capacityReserved &&
      streamingPostResponsePending >= maxStreamingPostResponses) ||
    (!capacityReserved &&
      (existing?.pending ?? 0) >= maxStreamingPostResponsesPerSession)
  ) {
    const now = Date.now();
    if (now - lastStreamingPostResponseOverflowLog >= 30_000) {
      lastStreamingPostResponseOverflowLog = now;
      log.warn("streaming post-response queue full; dropping finalizer");
    }
    drop();
    return;
  }
  const state = existing ?? { tail: Promise.resolve(), pending: 0 };
  const previous = state.tail;
  state.pending++;
  streamingPostResponsePending++;
  if (admissionKey !== undefined) {
    streamingPostResponsePendingByAdmissionKey.set(
      admissionKey,
      (streamingPostResponsePendingByAdmissionKey.get(admissionKey) ?? 0) + 1,
    );
  }
  const current = (async () => {
    await previous;
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (generation !== streamingPostResponseGeneration) {
      drop();
      return;
    }
    try {
      await operation();
    } catch (error) {
      log.error("streaming post-response processing failed:", error);
    }
  })();
  state.tail = current;
  streamingPostResponseFinalizers.set(sessionID, state);
  void current.finally(() => {
    if (streamingPostResponseFinalizers.get(sessionID) !== state) return;
    state.pending--;
    streamingPostResponsePending--;
    if (admissionKey !== undefined) {
      const remaining =
        (streamingPostResponsePendingByAdmissionKey.get(admissionKey) ?? 1) - 1;
      if (remaining > 0) {
        streamingPostResponsePendingByAdmissionKey.set(admissionKey, remaining);
      } else {
        streamingPostResponsePendingByAdmissionKey.delete(admissionKey);
      }
    }
    if (state.tail === current && state.pending === 0) {
      streamingPostResponseFinalizers.delete(sessionID);
    }
    pumpPendingSessionClaims();
  });
}

const MAX_STREAMING_POST_RESPONSE_WAITERS_PER_SESSION = 16;
const streamingPostResponseWaiters = new Map<string, number>();

class StreamingPostResponseWaitCapacityError extends Error {}

async function awaitStreamingPostResponse(
  sessionID: string,
  signal?: AbortSignal,
): Promise<void> {
  if (!streamingPostResponseFinalizers.has(sessionID)) return;
  const waiters = streamingPostResponseWaiters.get(sessionID) ?? 0;
  if (waiters >= MAX_STREAMING_POST_RESPONSE_WAITERS_PER_SESSION) {
    throw new StreamingPostResponseWaitCapacityError(
      "streaming post-response wait queue full",
    );
  }
  streamingPostResponseWaiters.set(sessionID, waiters + 1);
  try {
    for (;;) {
      const state = streamingPostResponseFinalizers.get(sessionID);
      if (!state) return;
      const tail = state.tail;
      streamingPostResponseWaitObserverForTest?.();
      await promiseAgainstAbort(() => tail, signal);
      const latest = streamingPostResponseFinalizers.get(sessionID);
      if (latest !== state || state.tail === tail) return;
    }
  } finally {
    const remaining = (streamingPostResponseWaiters.get(sessionID) ?? 1) - 1;
    if (remaining > 0) streamingPostResponseWaiters.set(sessionID, remaining);
    else streamingPostResponseWaiters.delete(sessionID);
  }
}

/** Sessions that have already logged the cwd-fallback warning (dedup). */
const cwdWarned = new Set<string>();

/** Sessions that have already logged the stale-header conflict warning (dedup). */
const staleHeaderWarned = new Set<string>();

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
 * Build the idle-gate handed to the temporal re-chunk backfill, wired to live
 * gateway state: park the walk while the background circuit breaker is tripped
 * OR the shared embedding worker is serving a live recall lookup. Exported so
 * the wiring (not just the pure {@link makeTemporalBackfillGate} policy) is
 * unit-testable.
 */
export function buildTemporalBackfillGate(): () => boolean {
  return makeTemporalBackfillGate({
    // Global breaker: a coarse "system is degraded" backstop. It chiefly tracks
    // remote LLM failures, so it just avoids piling work on during an outage.
    isPaused: () => isBackgroundPaused(),
    // The real throttle: yield the shared embedding worker to latency-sensitive
    // recall. Session activity was the old signal, but "a session pinged us
    // recently" says nothing about the embed worker's spare capacity right now —
    // on a busy multi-session host it kept the walk parked indefinitely. An
    // empty recall-embed queue is the direct, live measure of that capacity.
    isEmbedBusy: () => embedding.recallEmbedsInFlight() > 0,
  });
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
 * Reverse lookup: maps tenant-scoped header values to internal session IDs.
 * Key: `credentialFingerprint\x1fheaderName\x1fheaderValue`.
 */
const headerSessionIndex = new Map<string, string>();
const ambiguousHeaderSessionKeys = new Set<string>();
type ProvisionalHeaderMapping = {
  sessionID: string;
  createdAt: number;
  guardProject: boolean;
  adoptionFingerprint?: string;
  expectedUnowned: boolean;
};
const provisionalHeaderSessionIndex = new Map<
  string,
  ProvisionalHeaderMapping
>();
const identityAdmissionTails = new Map<string, Promise<void>>();
const MAX_PROVISIONAL_HEADER_MAPPINGS = 1024;
const PROVISIONAL_HEADER_MAPPING_TTL_MS = 5 * 60_000;
let headerSessionIndexHydrated = false;
const SESSION_INDEX_SEPARATOR = "\x1f";
const TENANT_FINGERPRINT_RE = /^[a-f0-9]{64}$/;

/** Remote and hosted gateways treat the request credential as a tenant boundary. */
function usesRemoteSessionBinding(config: GatewayConfig): boolean {
  return config.remoteGateway || config.hostedMode;
}

/** Server-derived durable storage owner; client headers never select it. */
function requestStorageTenant(
  headers: Record<string, string>,
  config: GatewayConfig,
): string {
  if (!usesRemoteSessionBinding(config)) return "";
  const credential = extractAuth(headers);
  return credential
    ? credentialTenantFingerprint(credential)
    : `unauthenticated:${crypto.randomUUID()}`;
}

/** Run a request under the same server-derived storage owner as the main pipeline. */
function withRequestStorageTenant<T>(
  headers: Record<string, string>,
  config: GatewayConfig,
  fn: () => T,
): T {
  return withTenant(requestStorageTenant(headers, config), fn);
}

function requestHeaders(headers: Headers): Record<string, string> {
  const rawHeaders: Record<string, string> = {};
  headers.forEach((value, key) => {
    rawHeaders[key] = value;
  });
  return rawHeaders;
}

/**
 * Resolve the credential scope used by every session-identity mechanism.
 * `null` means an unauthenticated remote request and must never be correlated.
 */
function requestCredentialFingerprint(
  headers: Record<string, string>,
  config: GatewayConfig,
): string | null {
  const credential = extractAuth(headers);
  if (usesRemoteSessionBinding(config)) {
    return credential ? credentialTenantFingerprint(credential) : null;
  }
  return credential ? authFingerprint(credential) : "";
}

function sessionIndexKey(
  credentialFingerprint: string,
  headerName: string,
  headerValue: string,
): string {
  return [credentialFingerprint, headerName, headerValue].join(
    SESSION_INDEX_SEPARATOR,
  );
}

async function withIdentityAdmission<T>(
  req: GatewayRequest,
  config: GatewayConfig,
  operation: () => Promise<T>,
): Promise<T> {
  const known = extractKnownSessionHeader(req.rawHeaders);
  if (!known) return operation();
  const key = sessionIndexKey(
    requestCredentialFingerprint(req.rawHeaders, config) ?? "",
    known.headerName,
    known.sessionId,
  );
  const previous = identityAdmissionTails.get(key);
  let release!: () => void;
  const ownCompletion = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous ? previous.then(() => ownCompletion) : ownCompletion;
  identityAdmissionTails.set(key, tail);
  try {
    if (previous) await promiseAgainstAbort(() => previous, req.signal);
    return await operation();
  } finally {
    release();
    if (identityAdmissionTails.get(key) === tail) {
      identityAdmissionTails.delete(key);
    }
  }
}

function setProvisionalHeaderMapping(
  key: string,
  sessionID: string,
  guardProject = false,
  adoptionFingerprint?: string,
  expectedUnowned = false,
): void {
  const now = Date.now();
  for (const [candidate, entry] of provisionalHeaderSessionIndex) {
    if (now - entry.createdAt > PROVISIONAL_HEADER_MAPPING_TTL_MS) {
      provisionalHeaderSessionIndex.delete(candidate);
    }
  }
  const existing = getProvisionalHeaderMapping(key);
  if (existing && existing !== sessionID) {
    throw new Error("ambiguous session headers");
  }
  provisionalHeaderSessionIndex.delete(key);
  while (
    provisionalHeaderSessionIndex.size >= MAX_PROVISIONAL_HEADER_MAPPINGS
  ) {
    const oldest = provisionalHeaderSessionIndex.keys().next().value;
    if (oldest === undefined) break;
    provisionalHeaderSessionIndex.delete(oldest);
  }
  provisionalHeaderSessionIndex.set(key, {
    sessionID,
    createdAt: now,
    guardProject,
    adoptionFingerprint,
    expectedUnowned,
  });
}

function getProvisionalHeaderEntry(
  key: string,
): ProvisionalHeaderMapping | null {
  const entry = provisionalHeaderSessionIndex.get(key);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > PROVISIONAL_HEADER_MAPPING_TTL_MS) {
    provisionalHeaderSessionIndex.delete(key);
    return null;
  }
  return entry;
}

function getProvisionalHeaderMapping(key: string): string | undefined {
  return getProvisionalHeaderEntry(key)?.sessionID;
}

function provisionalMappingGuardsProject(
  key: string,
  sessionID: string,
): boolean {
  if (getProvisionalHeaderMapping(key) !== sessionID) return false;
  return provisionalHeaderSessionIndex.get(key)?.guardProject === true;
}

/** @internal Test seam for exercising ownership expiry during an in-flight turn. */
export function expireProvisionalHeaderMappingsForTest(): void {
  provisionalHeaderSessionIndex.clear();
}

function provisionalKeyOwned(key: string, sessionID: string): boolean {
  return (
    headerSessionIndex.get(key) === sessionID ||
    getProvisionalHeaderMapping(key) === sessionID
  );
}

function dropOwnedProvisionalKey(
  key: string | undefined,
  sessionID: string,
): void {
  if (key && getProvisionalHeaderMapping(key) === sessionID) {
    provisionalHeaderSessionIndex.delete(key);
  }
}

function conflictsWithConfidentSessionProject(
  sessionID: string,
  pathResult: ProjectPathResult,
): boolean {
  if (pathResult.source !== "header" && pathResult.source !== "inferred") {
    return false;
  }
  const live = sessions.get(sessionID);
  if (live?.projectPath && live.projectPathProvisional === false) {
    return live.projectPath !== pathResult.path;
  }
  const persisted = loadSessionTracking(sessionID);
  return (
    !!persisted?.projectPath &&
    persisted.projectPathProvisional === false &&
    persisted.projectPath !== pathResult.path
  );
}

function legacyAdoptionTargetIsUnowned(sessionID: string): boolean {
  return loadSessionTracking(sessionID)?.credentialFingerprint === "";
}

function isConfidentlyBoundToProject(
  state: SessionState,
  projectPath: string,
): boolean {
  return (
    state.projectPathProvisional !== true && state.projectPath === projectPath
  );
}

function hydrateHeaderSessionIndex(config: GatewayConfig): void {
  if (headerSessionIndexHydrated) return;
  restoreHeaderSessionMappings(config);
  headerSessionIndexHydrated = true;
}

function findIndexedKnownSessionID(
  req: GatewayRequest,
  config: GatewayConfig,
): string | undefined {
  const credentialFingerprint = requestCredentialFingerprint(
    req.rawHeaders,
    config,
  );
  if (credentialFingerprint === null) return undefined;
  hydrateHeaderSessionIndex(config);
  const known = extractKnownSessionHeader(req.rawHeaders);
  if (!known) return undefined;
  return headerSessionIndex.get(
    sessionIndexKey(credentialFingerprint, known.headerName, known.sessionId),
  );
}

function hasConflictingConfirmedHeader(
  req: GatewayRequest,
  expectedSessionID: string,
  excludedKey: string,
  config: GatewayConfig,
): boolean {
  const credentialFingerprint = requestCredentialFingerprint(
    req.rawHeaders,
    config,
  );
  if (credentialFingerprint === null) return true;
  hydrateHeaderSessionIndex(config);
  for (const [key, sessionID] of headerSessionIndex) {
    if (key === excludedKey || sessionID === expectedSessionID) continue;
    const parsed = parseSessionIndexKey(key);
    if (!parsed || parsed.headerName === "context-marker") continue;
    if (parsed.credentialFingerprint !== credentialFingerprint) continue;
    if (req.rawHeaders[parsed.headerName] === parsed.headerValue) return true;
  }
  return false;
}

type IndexedSessionResolution =
  | {
      kind: "match";
      sessionID: string;
      provisional?: boolean;
      provisionalKey?: string;
    }
  | { kind: "ambiguous" }
  | { kind: "none" };

function resolveIndexedSession(
  req: GatewayRequest,
  config: GatewayConfig,
  includeProvisional = false,
): IndexedSessionResolution {
  const known = extractKnownSessionHeader(req.rawHeaders);
  if (known) {
    if (includeProvisional) {
      const credentialFingerprint = requestCredentialFingerprint(
        req.rawHeaders,
        config,
      );
      if (credentialFingerprint === null) return { kind: "none" };
      const key = sessionIndexKey(
        credentialFingerprint,
        known.headerName,
        known.sessionId,
      );
      const confirmedSessionID = findIndexedKnownSessionID(req, config);
      const sessionID = confirmedSessionID ?? getProvisionalHeaderMapping(key);
      return sessionID
        ? {
            kind: "match",
            sessionID,
            provisional: !confirmedSessionID,
            ...(!confirmedSessionID ? { provisionalKey: key } : {}),
          }
        : { kind: "none" };
    }
    const sessionID = findIndexedKnownSessionID(req, config);
    return sessionID ? { kind: "match", sessionID } : { kind: "none" };
  }

  const credentialFingerprint = requestCredentialFingerprint(
    req.rawHeaders,
    config,
  );
  if (credentialFingerprint === null) return { kind: "none" };
  hydrateHeaderSessionIndex(config);
  let match: string | undefined;
  let provisional = false;
  let provisionalKey: string | undefined;
  for (const [key, sessionID] of headerSessionIndex) {
    const parsed = parseSessionIndexKey(key);
    if (!parsed || parsed.headerName === "context-marker") continue;
    if (parsed.credentialFingerprint !== credentialFingerprint) continue;
    if (req.rawHeaders[parsed.headerName] !== parsed.headerValue) continue;
    if (match && match !== sessionID) return { kind: "ambiguous" };
    match = sessionID;
  }
  if (includeProvisional) {
    for (const [key, entry] of provisionalHeaderSessionIndex) {
      const sessionID = getProvisionalHeaderMapping(key);
      if (!sessionID || sessionID !== entry.sessionID) continue;
      const parsed = parseSessionIndexKey(key);
      if (!parsed || parsed.headerName === "context-marker") continue;
      if (parsed.credentialFingerprint !== credentialFingerprint) continue;
      if (req.rawHeaders[parsed.headerName] !== parsed.headerValue) continue;
      if (match && match !== sessionID) return { kind: "ambiguous" };
      match = sessionID;
      provisional = true;
      provisionalKey ??= key;
    }
  }
  if (match) {
    return { kind: "match", sessionID: match, provisional, provisionalKey };
  }

  const markerSid = extractSessionMarker(req.messages);
  if (!markerSid) return { kind: "none" };
  const sessionID = headerSessionIndex.get(
    sessionIndexKey(credentialFingerprint, "context-marker", markerSid),
  );
  return sessionID ? { kind: "match", sessionID } : { kind: "none" };
}

function findIndexedSessionID(
  req: GatewayRequest,
  config: GatewayConfig,
): string | undefined {
  const resolution = resolveIndexedSession(req, config);
  return resolution.kind === "match" ? resolution.sessionID : undefined;
}

/**
 * Revalidate an authenticated index lookup after an async wait. Affinity
 * rotation can revoke the request's alias while it is queued for the session;
 * callers must fail closed instead of continuing with the stale session ID.
 */
function confirmedIndexedIdentityResolvesTo(
  req: GatewayRequest,
  expectedSessionID: string,
  config: GatewayConfig,
): boolean {
  const resolution = resolveIndexedSession(req, config);
  return (
    resolution.kind === "match" &&
    resolution.sessionID === expectedSessionID &&
    resolution.provisional !== true
  );
}

function findLiveSessionState(
  req: GatewayRequest,
  config: GatewayConfig,
  allSessions: ReadonlyMap<string, SessionState> = sessions,
): SessionState | undefined {
  const known = extractKnownSessionHeader(req.rawHeaders);
  if (known) {
    // An indexed higher-priority header is authoritative even when its session
    // is not currently hydrated; never fall through to a conflicting alias.
    const indexedSid = findIndexedKnownSessionID(req, config);
    return indexedSid ? allSessions.get(indexedSid) : undefined;
  }
  const indexedSid = findIndexedSessionID(req, config);
  return indexedSid ? allSessions.get(indexedSid) : undefined;
}

function resolveAuthenticatedDirectSession(
  req: GatewayRequest,
  projectPath: string,
  config: GatewayConfig,
  knownHeaderOnly = true,
): SessionState | undefined {
  if (knownHeaderOnly && !extractKnownSessionHeader(req.rawHeaders))
    return undefined;
  const sessionID = knownHeaderOnly
    ? findIndexedKnownSessionID(req, config)
    : findIndexedSessionID(req, config);
  if (!sessionID) return undefined;
  try {
    return getOrCreateSession(
      sessionID,
      projectPath,
      "header",
      requestCredentialFingerprint(req.rawHeaders, config) ?? "",
      config,
    );
  } catch (error) {
    if (error instanceof SessionTenantMismatchError) return undefined;
    throw error;
  }
}

function knownSessionHeaderForRequest(
  req: GatewayRequest,
  sessionID: string,
  config: GatewayConfig,
): { headerName: string; sessionId: string } | null {
  const credentialFingerprint = requestCredentialFingerprint(
    req.rawHeaders,
    config,
  );
  if (credentialFingerprint === null) return null;
  let known = extractKnownSessionHeader(req.rawHeaders);
  if (!known) {
    for (const [key, entry] of provisionalHeaderSessionIndex) {
      if (entry.sessionID !== sessionID) continue;
      const parsed = parseSessionIndexKey(key);
      if (!parsed || parsed.headerName === "context-marker") continue;
      if (parsed.credentialFingerprint !== credentialFingerprint) continue;
      if (req.rawHeaders[parsed.headerName] !== parsed.headerValue) continue;
      known = {
        headerName: parsed.headerName,
        sessionId: parsed.headerValue,
      };
      break;
    }
  }
  return known;
}

function publishKnownSessionHeader(
  known: { headerName: string; sessionId: string },
  state: SessionState,
  credentialFingerprint: string,
): void {
  const confirmedKey = sessionIndexKey(
    credentialFingerprint,
    known.headerName,
    known.sessionId,
  );
  if (credentialFingerprint) {
    for (const [key, sessionID] of headerSessionIndex) {
      if (sessionID !== state.sessionID) continue;
      const parsed = parseSessionIndexKey(key);
      if (parsed?.credentialFingerprint === "") {
        headerSessionIndex.delete(key);
      }
    }
  }
  if (isRotationEligible(known.headerName)) {
    for (const [key, sessionID] of headerSessionIndex) {
      if (key === confirmedKey || sessionID !== state.sessionID) continue;
      const parsed = parseSessionIndexKey(key);
      if (
        parsed?.credentialFingerprint === credentialFingerprint &&
        parsed.headerName === known.headerName
      ) {
        headerSessionIndex.delete(key);
      }
    }
  }
  provisionalHeaderSessionIndex.delete(confirmedKey);
  headerSessionIndex.set(confirmedKey, state.sessionID);
  state.headerSessionId = known.sessionId;
  state.headerName = known.headerName;
  state.credentialFingerprint = credentialFingerprint;
}

function confirmKnownSessionHeader(
  req: GatewayRequest,
  state: SessionState,
  config: GatewayConfig,
  tracking: Parameters<typeof saveSessionTracking>[1] = {},
  persistTurn?: () => void,
): void {
  const credentialFingerprint = requestCredentialFingerprint(
    req.rawHeaders,
    config,
  );
  if (credentialFingerprint === null) return;
  const known = knownSessionHeaderForRequest(req, state.sessionID, config);
  if (!known) return;
  withSavepoint("confirm_session_header", () => {
    persistTurn?.();
    saveSessionTracking(state.sessionID, {
      ...tracking,
      headerSessionId: known.sessionId,
      headerName: known.headerName,
      credentialFingerprint,
    });
  });
  publishKnownSessionHeader(known, state, credentialFingerprint);
}

export function evictLiveSessionForTest(
  req: GatewayRequest,
  config?: GatewayConfig,
): boolean {
  const credential = extractAuth(req.rawHeaders);
  const credentialFingerprint = config
    ? requestCredentialFingerprint(req.rawHeaders, config)
    : credential
      ? authFingerprint(credential)
      : "";
  if (credentialFingerprint === null) return false;
  for (const headerName of KNOWN_SESSION_HEADERS) {
    const headerValue = req.rawHeaders[headerName];
    if (!headerValue) continue;
    const sid = headerSessionIndex.get(
      sessionIndexKey(credentialFingerprint, headerName, headerValue),
    );
    if (sid) {
      const removed = sessions.delete(sid);
      if (removed) evictPipelineSessionState(sid);
      return removed;
    }
  }
  return false;
}

function parseSessionIndexKey(key: string): {
  credentialFingerprint: string;
  headerName: string;
  headerValue: string;
} | null {
  const first = key.indexOf(SESSION_INDEX_SEPARATOR);
  const second = key.indexOf(SESSION_INDEX_SEPARATOR, first + 1);
  if (first < 0 || second < 0) return null;
  return {
    credentialFingerprint: key.slice(0, first),
    headerName: key.slice(first + 1, second),
    headerValue: key.slice(second + 1),
  };
}

/**
 * Restore persisted header mappings under the current gateway trust policy.
 * Remote mode accepts only full tenant-bound rows; local mode never interprets
 * a remote tenant row as a local identity. Credential-shaped historical header
 * mappings are cleared rather than merely ignored.
 */
function restoreHeaderSessionMappings(config: GatewayConfig): {
  restored: number;
  cleared: number;
} {
  let restored = 0;
  let cleared = 0;
  for (const entry of loadHeaderSessionIndex()) {
    if (isCredentialHeaderName(entry.headerName)) {
      saveSessionTracking(entry.sessionId, {
        headerSessionId: null,
        headerName: null,
      });
      cleared++;
      continue;
    }
    const remoteFingerprint = TENANT_FINGERPRINT_RE.test(
      entry.credentialFingerprint,
    );
    if (
      usesRemoteSessionBinding(config) ? !remoteFingerprint : remoteFingerprint
    ) {
      continue;
    }
    const key = sessionIndexKey(
      entry.credentialFingerprint,
      entry.headerName,
      entry.headerSessionId,
    );
    if (ambiguousHeaderSessionKeys.has(key)) continue;
    const existing = headerSessionIndex.get(key);
    if (existing && existing !== entry.sessionId) {
      headerSessionIndex.delete(key);
      ambiguousHeaderSessionKeys.add(key);
      continue;
    }
    headerSessionIndex.set(key, entry.sessionId);
    restored++;
  }
  return { restored, cleared };
}

/** Resolve an active header-bound session under the current tenant policy. */
function activeSessionForKnownHeader(
  req: GatewayRequest,
  allSessions: ReadonlyMap<string, SessionState>,
  config: GatewayConfig,
): SessionState | undefined {
  const known = extractKnownSessionHeader(req.rawHeaders);
  if (!known) return undefined;
  const credentialFingerprint = requestCredentialFingerprint(
    req.rawHeaders,
    config,
  );
  if (credentialFingerprint === null) return undefined;
  const sid = headerSessionIndex.get(
    sessionIndexKey(credentialFingerprint, known.headerName, known.sessionId),
  );
  return sid ? allSessions.get(sid) : undefined;
}

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
 * Materiality-aware surface signature for a knowledge entry, used as the hash
 * half of every `id:hash` surfaced/pin key. Hashing a NORMALIZED form (title +
 * content, lowercased, punctuation stripped, whitespace collapsed) means a
 * cosmetic curator reword — reflow/whitespace, added/removed punctuation, a
 * capitalization change — yields the SAME signature. Consequences, all flowing
 * from the single definition:
 *   - `detectSurfacedMutations`: `currentSig === surfacedSig` → no `changed`
 *     entry → no mid-session delta block for a trivial reword.
 *   - `ltmEntryKeys` (pin identity) + `hasMaterialLtmDelta`: the pin key is
 *     unchanged, so `setUnchanged` stays true → system[2] keeps its byte-stable
 *     pinned text and never re-pins on a cosmetic edit.
 * Because the KEY itself is unchanged for an immaterial edit, the surfaced set
 * needs no advancing and the check never re-fires per turn (the 🔴 invariant).
 * A genuine title or content change changes the signature and fires normally.
 * NOTE: category is deliberately NOT part of the signature — a category-only
 * edit keeps the same key, so the pin is reused and the model keeps the old
 * `### Category` grouping until the next natural re-pin (consistent with the
 * materiality intent; a bare re-grouping is not worth a mid-session cache bust).
 * The material (substantive) edit surfaces on the next natural re-pin.
 */
export function surfaceSignature(title: string, content: string): string {
  const normalize = (s: string): string =>
    s
      .toLowerCase()
      // Strip only COSMETIC punctuation: markdown scaffolding (*_`~#),
      // quotes/brackets, and the sentence separators . , ; : … — Deliberately
      // KEEP operator/comparator/boolean chars (= < > & | + / ^ % - ! ?) so a
      // MATERIAL edit that changes only symbols is not collapsed to the same
      // signature — e.g. `>= floor` vs `> floor`, `x == y` vs `x != y`,
      // `a || b` vs `a && b`, `foo?.bar` vs `foo.bar` must remain distinct.
      // `!`/`?` are kept (needed for `!=`, `?.`, ternary) at the cost of a cheap
      // false-positive delta on an "excited!" reword — the safe failure mode.
      // Em/en dashes (— –) are cosmetic typography (an AI-tell in prose) and
      // are stripped; the ASCII hyphen-minus `-` is KEPT since it doubles as
      // the arithmetic/negation operator.
      .replace(/["'`*_~#()[\]{}.,;:…—–]/gu, " ")
      // Collapse all whitespace runs to a single space and trim.
      .replace(/\s+/g, " ")
      .trim();
  return fnv1a(`${normalize(title)}\x1f${normalize(content)}`);
}

/**
 * Compute the sorted entry-key array for a set of context-bound LTM entries.
 * Each key is `"<id>:<surfaceSignature(title, content)>"` — a MATERIALITY-aware
 * signature (normalized title+content), so a cosmetic reword keeps the key
 * stable (see {@link surfaceSignature}). Sorted so order is canonical: the same
 * set of entries always produces the same key array regardless of ranking
 * order, which is exactly the property the reorder-tolerant pin needs.
 *
 * When `renderedIds` is provided, only those entries (the ones that survived
 * budget packing in formatKnowledge and are actually in the rendered text) are
 * keyed — so the key set tracks the rendered selection.
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
    .map((e) => `${e.id}:${surfaceSignature(e.title, e.content)}`)
    .sort();
}

/**
 * A delta baseline that surfaces the FULL current set as "changed".
 *
 * The delta path (`detectSurfacedMutations`) reports an entry only when its
 * CURRENT content hash differs from the hash recorded in the surfaced-set
 * baseline. To surface every entry on FIRST injection — where there is no prior
 * system[2] pin to diff against — we seed the baseline with each id paired with
 * an EMPTY hash sentinel (`"<id>:"`). Every entry's real hash differs from ""
 * so the whole set surfaces once, then the appended block records the true
 * hashes and the surfaced set advances normally (no re-fire on later turns).
 *
 * This mirrors the material-change / `MAX_DELTA_BLOCKS` coalesce path, which
 * likewise re-captures the full set by diffing current content against a
 * stale-hash baseline — here the "stale" hash is simply empty.
 */
export function fullSurfaceBaseline(ids: Iterable<string>): string[] {
  return [...ids].map((id) => `${id}:`).sort();
}

/** system[1] (stable LTM) cache breakpoint TTL in ms. Documents the 1h
 *  `cache_control` TTL carried by the system[1] block. As of v45 system[1] is
 *  frozen for the session's life and never recomputed mid-session, so an idle
 *  gap past this TTL re-warms the SAME frozen bytes rather than rebuilding from
 *  the live knowledge table (which used to bust the prefix on curator deletes). */
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

/** True when two id sets contain exactly the same ids. */
export function sameIdSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) {
    if (!b.has(id)) return false;
  }
  return true;
}

/**
 * Decide whether a persisted pin's `entryKeys` should be silently re-anchored
 * to the freshly-computed `cachedKeys` WITHOUT counting as a change. This is the
 * key-format migration guard for the surfaceSignature switch (#1320): a pin
 * persisted with the old `id:fnv1a(title\x1f content)` keys mismatches the new
 * normalized-signature keys on the first post-deploy turn even though the
 * selection is identical. Re-anchoring costs zero cache bust when — and only
 * when — it is provably the SAME selection:
 *   1. the keys actually differ (nothing to do otherwise),
 *   2. the freshly rendered text is byte-identical to the pinned text (so
 *      system[2] would render the same bytes — no content change hides here),
 *   3. the id SETS are identical (same entries, only the hash encoding moved).
 * A genuine content edit fails (2); a set change fails (3). Both correctly fall
 * through to the normal re-pin path.
 *
 * @internal Exported for tests.
 */
export function shouldReanchorPinKeys(
  pinnedKeys: string[],
  cachedKeys: string[],
  cachedFormatted: string,
  pinnedFormatted: string,
): boolean {
  return (
    !sameEntryKeys(pinnedKeys, cachedKeys) &&
    cachedFormatted === pinnedFormatted &&
    sameIdSet(entryKeyIds(pinnedKeys), entryKeyIds(cachedKeys))
  );
}

const KNOWLEDGE_DELTA_TOKEN_BUDGET = 400;

/** Cap on appended durable-delta blocks before forcing a coalesce. Append-only
 *  blocks normally coalesce at the next reshuffle (layer change / post-idle),
 *  but a pathological no-idle session that churns a pinned entry every turn
 *  (e.g. in-flight curation rewriting the same entry) would otherwise grow the
 *  block count — and thus per-turn context tokens — without bound. When this
 *  many blocks have accumulated, the next append deletes them all and re-derives
 *  ONE cumulative block from the frozen pin baseline (paying one bust to reclaim
 *  budget). Each block is ≤ KNOWLEDGE_DELTA_TOKEN_BUDGET, so the worst-case
 *  durable-delta footprint is bounded at ~MAX_DELTA_BLOCKS × 400 tokens. */
const MAX_DELTA_BLOCKS = 8;

/** Max entries listed in the "Other relevant knowledge" overflow ToC (#917).
 *  Each line is just `[id] title (category)` (~15-20 tokens), so 12 lines is a
 *  ~200-token index — small enough to ride the frozen delta without crowding
 *  out the rendered changed-entry content above it. */
const OVERFLOW_TOC_MAX = 12;

/** Max entries listed in the frozen system[1] project-knowledge catalog (#917,
 *  the "A" floor). Present from turn 1 (before system[2] / any delta exists) so
 *  the agent always knows what project knowledge exists and can recall it. */
const STABLE_KNOWLEDGE_TOC_MAX = 15;

/**
 * Build a compact, recall-by-id catalog of project knowledge titles (#917 "A").
 * Folded into the frozen system[1] baseline so it is present from turn 1 and
 * byte-stable for the session's life (mirrors the entities partial-list block).
 * Entries must be pre-sorted deterministically (forProject orders by confidence
 * desc, updated_at desc) so the frozen bytes never depend on call order.
 *
 * Each line renders the FULL id with a `k:` prefix (`[k:<uuid>]`) — that exact
 * token is what the agent passes to the recall tool's `id` param. Do NOT shorten
 * it: `recallById` (recall.ts) resolves `k:`/`xk:` by EXACT `ltm.get(id)` /
 * `getByLogical(logicalIdOf(id))` with no prefix matching, so an 8-char slice is
 * unresolvable ("No entry found"). `k:` and `xk:` resolve identically (both hit
 * `ltm.get`), so `k:` is safe for project-owned and promoted rows alike.
 */
export function buildKnowledgeCatalogText(
  entries: Array<{ id: string; category: string; title: string }>,
  max: number,
): string {
  if (!entries.length) return "";
  const lines = entries
    .slice(0, max)
    .map((e) => `* [k:${e.id}] ${e.title} (${e.category})`)
    .join("\n");
  const more =
    entries.length > max
      ? `\n* ${entries.length - max} more — use recall with an id for detail.`
      : "";
  return `## Project knowledge (recall by id for detail)\n\n${lines}${more}`;
}

/**
 * Build the set of knowledge entry IDs that are already in the model's visible
 * context, so recall can surface a "N of K results already in LTM" hint and the
 * model doesn't treat a fully-redundant recall as new information.
 *
 * Sources combined (each contributes full UUIDs — the canonical recall form):
 *   1. **Stable system[1] knowledge catalog** — `* [k:<uuid>] <title> (<cat>)`
 *      lines emitted by `buildKnowledgeCatalogText`. Tells the model the title
 *      exists but not the content.
 *   2. **Durable prompt-delta pair** — entries appended by
 *      `appendKnowledgePromptDelta` carry `[<shortId>]` prefixes (8 chars); we
 *      only know the shortId from the conversation text, so this source would
 *      miss full-ID dedup. To keep the contract simple, the caller passes the
 *      *structured* `pendingKnowledgeDelta.entries` (full IDs) instead.
 *
 * Returns an empty set when either input is missing/empty.
 */
export function buildAlreadyInLtmIds(
  stableLtmText: string | undefined,
  pendingKnowledgeDelta:
    | {
        entries: Array<{ id: string }>;
      }
    | undefined,
): Set<string> {
  const ids = new Set<string>();

  // 1) Catalog: extract full UUIDs from `[k:<uuid>]` catalog tokens.
  if (stableLtmText) {
    const re = /\[k:([0-9a-f]{8}-[0-9a-f-]{27,})\]/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(stableLtmText)) !== null) {
      ids.add(m[1].toLowerCase());
    }
  }

  // 2) Knowledge delta: structured entries carry full IDs — preferred source.
  if (pendingKnowledgeDelta?.entries) {
    for (const e of pendingKnowledgeDelta.entries) ids.add(e.id.toLowerCase());
  }

  return ids;
}

type MessageInsertSelector = {
  target: "messages";
  insertAt: number;
};

function parseMessageInsertSelector(raw: string): MessageInsertSelector | null {
  try {
    const parsed = JSON.parse(raw) as Partial<MessageInsertSelector>;
    if (parsed.target !== "messages") return null;
    const insertAt = parsed.insertAt;
    if (!Number.isInteger(insertAt) || insertAt == null || insertAt < 0) {
      return null;
    }
    return { target: "messages", insertAt };
  } catch {
    return null;
  }
}

function isGatewayMessage(v: unknown): v is GatewayMessage {
  const m = v as Partial<GatewayMessage> | null;
  return (
    !!m &&
    (m.role === "user" || m.role === "assistant") &&
    Array.isArray(m.content)
  );
}

// The inert assistant closer that ends the knowledge-delta exchange (the model
// must not treat the pair as an open user turn — #1315). Also the canonical
// assistant text the legacy migration rewrites a payload-carrying assistant to.
// Reads as a system memory-refresh annotation (bracketed markdown emphasis),
// NOT the agent answering the user — so if a harness ever renders it, it does
// not look like a stray reply. Inert and non-eliciting (closes the exchange,
// #1315). Also detected by `isKnowledgeDeltaCloser` so adjacent-assistant
// coalescing never merges it into a real assistant message.
const KNOWLEDGE_DELTA_ASSISTANT_CLOSER = "*🧠 Refreshed memory*";

function firstText(m: GatewayMessage | undefined): string | undefined {
  const b = m?.content?.[0];
  return b && b.type === "text" ? b.text : undefined;
}

/**
 * True when the assistant message is the knowledge-delta closer. Used by
 * `coalesceAdjacentAssistants` to keep the closer as a DISTINCT assistant
 * message — never merged into a real assistant response — so a harness
 * renders it separately and the model never treats it as its own turn.
 */
export function isKnowledgeDeltaCloser(m: GatewayMessage | undefined): boolean {
  if (!m || m.role !== "assistant") return false;
  const text = firstText(m);
  // Match BOTH the current closer AND the legacy `"[memory refreshed]"` text
  // persisted by sessions before #1494 — parseDeltaMessages rewrites legacy
  // assistant payloads to the current constant on replay, but a defensive
  // check here protects any edge case where the legacy closer survives
  // migration (manual `.lore.md` edits, pre-migration blocks from a fresh
  // DB, or any block the migration's `asstText.includes("## Long-term
  // Knowledge")` gate skipped). Without this, legacy closers get folded
  // into adjacent real assistant messages — the exact inline-rendering
  // bug we're guarding against.
  return (
    text === KNOWLEDGE_DELTA_ASSISTANT_CLOSER || text === "[memory refreshed]"
  );
}

// A delta block's content is now a user→assistant PAIR, stored as a JSON array.
// Legacy blocks (persisted before the pair change, and single-message test
// fixtures) stored ONE message object — accept both so already-persisted
// sessions keep replaying and never crash. Returns [] on anything unparseable.
//
// Migration (#1490): blocks persisted before the payload moved off the
// assistant turn store `[{user: framing}, {assistant: "## Long-term Knowledge…"}]`.
// Replayed as-is they keep the payload on a visible/completed assistant turn —
// the exact dump + premature-loop-exit bug this PR fixes — for the life of the
// session. On load, rewrite that legacy pair to the new shape: payload appended
// to the framing-note user message, assistant becomes the inert closer. A block
// already in the new shape (user text already contains the payload) is returned
// unchanged. Only the exact `[user(framing-only), assistant(payload)]` shape is
// migrated; anything else (single message, new pair, non-delta) passes through.
function parseDeltaMessages(raw: string): GatewayMessage[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return isGatewayMessage(parsed) ? [parsed] : [];
  }
  const msgs = parsed.filter(isGatewayMessage);
  if (msgs.length !== 2) return msgs;
  const [m0, m1] = msgs;
  if (m0.role !== "user" || m1.role !== "assistant") return msgs;
  const userText = firstText(m0);
  const asstText = firstText(m1);
  if (
    typeof userText !== "string" ||
    typeof asstText !== "string" ||
    !userText.startsWith(KNOWLEDGE_DELTA_FRAMING_PREFIX) ||
    userText.includes("## Long-term Knowledge") || // already migrated / new shape
    !asstText.includes("## Long-term Knowledge") // nothing to move
  ) {
    return msgs;
  }
  // Legacy pair: move the assistant payload onto the framing-note user message.
  return [
    {
      role: "user",
      content: [{ type: "text", text: `${userText}\n\n${asstText}` }],
    },
    {
      role: "assistant",
      content: [{ type: "text", text: KNOWLEDGE_DELTA_ASSISTANT_CLOSER }],
    },
  ];
}

/**
 * Anthropic requires every `tool_use` block to be immediately followed by its
 * matching `tool_result` block in the next message. Inserting a synthetic
 * delta message between such a pair orphans the `tool_use` and triggers a 400
 * ("tool_use ids were found without tool_result blocks immediately after").
 *
 * Returns an insert index (clamped to [0, messages.length]) that never lands
 * immediately after an assistant `tool_use`. Anthropic requires every
 * `tool_use` to be followed immediately by its `tool_result`; a delta inserted
 * right after the assistant breaks that adjacency and is rejected with a
 * tool-pairing 400 (#747). The desired index is walked backward past the
 * issuing assistant in two cases:
 *
 *  1. The boundary at `idx` sits between an assistant(tool_use) and the
 *     following user(tool_result) — a completed pair (mid-history split).
 *  2. The boundary at `idx` immediately follows an assistant(tool_use) whose
 *     result is NOT present at `idx` — a PENDING/in-flight tool call (the agent
 *     is mid-tool-execution, the tail ends with a dangling tool_use, or the
 *     result lives elsewhere). Inserting here would orphan the tool_use.
 *
 * Both reduce to the same rule: never let `messages[idx-1]` be an
 * assistant(tool_use) — walk before it.
 *
 * @internal Exported for tests.
 */
/**
 * Decide whether the durable knowledge-delta must be re-anchored on THIS turn
 * because the gradient compressed the conversation.
 *
 * The delta's persisted `insertAt` is a frozen absolute index into the
 * gradient-transformed message array. That array is non-stationary: when the
 * gradient compresses (raw-window eviction / layer escalation), the content at
 * each absolute index shifts, so a once-tool-pair-safe index can drift into a
 * tool_use/tool_result pair. A compressing turn ALSO busts the conversation
 * prompt cache anyway, so this is the right moment to re-anchor the blocks to a
 * fresh, tool-pair-safe, near-tail position (preserving their content AND `mut`
 * signatures via reanchorExistingDelta) — paying the (already-incurred) bust
 * once instead of destructively stripping a real tool pair every subsequent
 * turn. Re-anchoring (not deleting) keeps the advancing surfaced set intact, so
 * a fresh delta this same turn appends only its new increment rather than
 * re-deriving the full cumulative pin→DB wall.
 *
 * Layer-only predicate: a compressing turn is any turn at a compressed layer
 * (>= 1) whose layer DIFFERS from the previous turn (entering, escalating, or
 * de-escalating compression — all reshuffle the array). A stable layer
 * (prev === cur) returns false here. Layer 0 (passthrough) never compresses.
 *
 * Same-layer reshuffle: a post-idle compact rebuilds the array (the distilled
 * prefix grows, the raw window is rebuilt) while STAYING at the same layer — a
 * steady layer-1 session resumes at layer 1. That movement is not a layer
 * change, so the layer comparison alone misses it and the frozen absolute
 * insertAt is replayed into a differently-shaped array, busting the prompt
 * cache. `idleRecompacted` captures that case.
 *
 * 🔴 `idleRecompacted` must be TRUE only when the post-idle resume ACTUALLY
 * recompacted (onIdleResume with `!cacheWarm`, which clears the byte-identity
 * caches and rebuilds the raw window). A WARM idle resume (`cacheWarm` /
 * skipCompact, PR #1102) PRESERVES the distilled prefix and raw-window pin
 * byte-for-byte — the array does NOT reshuffle, so the delta's insertAt is
 * still valid and re-anchoring it is pure harm: it moves the delta off its
 * cached position and busts the very warm cache skipCompact was protecting.
 * Passing raw `lastTurnWasIdle` here (the pre-fix behavior) re-anchored on
 * every idle resume, which is what produced the observed 100%→9% "dramatic hit
 * rate drop" busts on large sessions whose returning turn was warm-preserved
 * (divergence at the delta's OLD index, e.g. messages[349].role, prefixMatch
 * ~82% — the conversation was intact, only the delta had moved).
 *
 * @internal Exported for tests.
 */
export function shouldResetDeltaOnCompression(
  prevLayer: number,
  curLayer: number,
  idleRecompacted = false,
): boolean {
  if (curLayer < 1) return false;
  return curLayer !== prevLayer || idleRecompacted;
}

/**
 * True when a post-idle resume ACTUALLY recompacted — i.e. reshuffled the
 * gradient-transformed array — and therefore the durable delta must be
 * re-anchored. This is the `idleRecompacted` input to
 * {@link shouldResetDeltaOnCompression}.
 *
 * 🔴 A resume reshuffles ONLY when it was NOT cache-warm. When `cacheWarm` is
 * true (skipCompact — PR #1102), onIdleResume PRESERVES the distilled prefix
 * and raw-window pin byte-for-byte, so the array is unchanged and the delta's
 * frozen insertAt is still valid; re-anchoring would move the delta off its
 * cached position and bust the very warm cache skipCompact was protecting.
 * Only a `!cacheWarm` resume clears those caches and rebuilds the raw window.
 *
 * @internal Exported for tests (guards the `&& !cacheWarm` fix against revert).
 */
export function idleResumeReshuffled(
  lastTurnWasIdle: boolean,
  cacheWarm: boolean,
): boolean {
  return lastTurnWasIdle && !cacheWarm;
}

/**
 * Re-anchor the existing durable delta blocks (same content) to a fresh, tool-
 * pair-safe near-tail index in the current (post-reshuffle) message array, so a
 * frozen absolute insertAt isn't replayed at a position that no longer matches
 * the array layout. Returns the recomputed insertAt, or null when there is no
 * delta to re-anchor.
 *
 * Append-only sessions can hold MORE THAN ONE block (one per surfaced mutation
 * since the last compaction). All blocks move to the SAME fresh tail index;
 * `applySessionPromptDeltas` sorts by insertAt DESC then seq DESC and splices
 * at that index, so equal insertAt + ascending re-append order replays the
 * blocks in their original chronological order. Each block's mutation signature
 * (and any other selector field) is preserved — only `insertAt` is rewritten —
 * so the advancing surfaced-set reconstruction stays intact across the reshuffle.
 *
 * @internal Exported for tests (covers the call-site behavior — passing the
 * post-compact array and persisting a recomputed index — that the predicate
 * alone does not exercise).
 */
export function reanchorExistingDelta(
  sessionID: string,
  projectPath: string,
  messages: GatewayMessage[],
): number | null {
  const blocks = listSessionPromptDeltas(sessionID);
  if (!blocks.length) return null;
  const reInsertAt = safeDeltaInsertIndex(
    messages,
    Math.max(0, messages.length - 1),
  );
  const projectID = ensureProject(projectPath);
  // Rewrite each block's insertAt while preserving content + mutation signature
  // + chronological (seq) order. Snapshot before mutating the table.
  const preserved = blocks.map((b) => {
    let selectorObj: Record<string, unknown>;
    try {
      selectorObj = JSON.parse(b.selector) as Record<string, unknown>;
    } catch {
      selectorObj = { target: "messages" };
    }
    selectorObj.insertAt = reInsertAt;
    return { content: b.content, selector: JSON.stringify(selectorObj) };
  });
  // Atomic delete + re-append so a crash mid-rewrite can never leave the
  // session with a partial block set (which would drop surfaced-set history and
  // force a one-time full re-derive). Runs on every compressing turn now, so
  // crash-safety is cheap insurance. Uses a SAVEPOINT (not BEGIN) so it stays
  // safe if a future refactor ever calls this from inside an outer transaction.
  withSavepoint("reanchor_delta", () => {
    deleteSessionPromptDelta(sessionID);
    for (const p of preserved) {
      appendSessionPromptDelta({
        sessionID,
        projectID,
        selector: p.selector,
        content: p.content,
      });
    }
  });
  return reInsertAt;
}

/**
 * Compression-reset action for the durable knowledge delta — the single
 * call-site decision behind a testable seam. On a turn where the gradient
 * reshuffled the message array (`shouldResetDeltaOnCompression`), the persisted
 * blocks' frozen absolute `insertAt` can drift into a tool pair, so the blocks
 * are re-anchored to a fresh tool-pair-safe near-tail index against the CURRENT
 * array. No-op (returns null) when this is not a compressing turn or there is
 * no delta to move.
 *
 * 🔴 Re-anchors (via reanchorExistingDelta, preserving each block's content AND
 * its `mut` signature) — it does NOT delete. Deleting the blocks here wiped the
 * surfaced-set history, so a fresh delta produced on the SAME turn re-derived
 * the ENTIRE cumulative pin→DB wall from the frozen baseline. As background
 * consolidation tombstoned/edited more pinned entries over a session, that wall
 * kept growing, so every compression+change turn re-rendered a larger
 * deep-prefix block and busted the conversation cache — the regrowth churn
 * #1013 only trimmed. Re-anchoring keeps advanceSurfacedKeys intact, so the
 * append that follows contributes ONLY the genuinely-new increment (or nothing).
 *
 * @internal Exported for tests (guards the reanchor-not-delete call-site
 * choice, which the inline form left un-testable).
 */
export function reanchorDeltaOnCompression(
  sessionID: string,
  projectPath: string,
  messages: GatewayMessage[],
  deltaCompressed: boolean,
): number | null {
  if (!deltaCompressed) return null;
  return reanchorExistingDelta(sessionID, projectPath, messages);
}

export function safeDeltaInsertIndex(
  messages: GatewayMessage[],
  desired: number,
): number {
  // The injected delta is a user→assistant PAIR. It must NEVER be placed at the
  // true tail (idx == messages.length): the pair's trailing assistant would
  // become the literal last message of the request, so (1) agent harnesses
  // (Claude Code REPL, OpenCode) render it as a stray turn ("Understood.") and
  // (2) the model sees the conversation ending on its OWN turn and ends the
  // agent loop early (the wedge). Cap at messages.length - 1 so at least one
  // real message (a user turn / tool_result) always follows the pair and closes
  // the request. (Only reachable when messages.length >= 1; an empty array has
  // no delta to place.)
  let idx = Math.max(0, Math.min(desired, Math.max(0, messages.length - 1)));
  // Walk backward while the immediately-preceding message is an assistant
  // carrying a tool_use. This covers both a completed pair (the tool_result is
  // at idx) AND a pending tool call (no tool_result follows yet) — in either
  // case the delta must go BEFORE the assistant, never after its tool_use.
  while (idx > 0) {
    const prev = messages[idx - 1];
    const prevHasToolUse =
      prev?.role === "assistant" &&
      prev.content.some((b) => b.type === "tool_use");
    if (!prevHasToolUse) break;
    idx -= 1;
  }
  return idx;
}

/**
 * Tool-pairing 400: Anthropic rejects when a `tool_use` block is not
 * immediately followed by its `tool_result` ("tool_use ids were found without
 * tool_result blocks immediately after"). The gateway forwards the 400 body to
 * the client, which surfaces it as "tool use concurrency" — otherwise invisible
 * to us. This captures diagnostics so the class is measurable.
 *
 * Privacy: counts / layer / model / 16-char session prefix ONLY — never any
 * message content (honors the "NO gen_ai.input.messages" proxy posture).
 *
 * @internal Exported for tests.
 */
export function captureToolPairing400(input: {
  status: number;
  errorBody: string;
  messages: GatewayMessage[];
  layer: number;
  model: string;
  sessionID: string;
}): boolean {
  // Match the specific Anthropic phrasing to avoid false-positiving on other
  // 400s that merely mention tools (e.g. malformed tool schema).
  const isToolPairing400 =
    input.status === 400 &&
    input.errorBody.includes("tool_use") &&
    input.errorBody.includes("without") &&
    input.errorBody.includes("tool_result");
  if (!isToolPairing400) return false;
  if (!Sentry.isInitialized()) return true;

  let toolUseCount = 0;
  let toolResultCount = 0;
  for (const m of input.messages) {
    for (const b of m.content) {
      if (b.type === "tool_use") toolUseCount++;
      else if (b.type === "tool_result") toolResultCount++;
    }
  }
  Sentry.captureException(
    new Error("tool-pairing 400 (tool_use/tool_result concurrency)"),
    {
      tags: {
        error_class: "tool_pairing_400",
        gradient_layer: String(input.layer),
        model: input.model,
      },
      contexts: {
        tool_pairing: {
          layer: input.layer,
          tool_use_count: toolUseCount,
          tool_result_count: toolResultCount,
          message_count: input.messages.length,
          session_id_prefix: input.sessionID.slice(0, 16),
          concurrency_class: true,
        },
      },
    },
  );
  return true;
}

/**
 * Merge runs of adjacent assistant messages into a single assistant message
 * (content blocks concatenated in order). Used after knowledge-delta injection:
 * the injected user→assistant pair can seat its trailing assistant right before
 * a real assistant(tool_use) in a mid-tool-loop turn, which strict-alternation
 * upstreams reject. Merging is a no-op unless such a run exists. user↔user
 * adjacency is intentionally left alone (pre-existing behavior; providers accept
 * it, and the delta-placement tests rely on distinct user blocks).
 *
 * @internal Exported for tests.
 */
export function coalesceAdjacentAssistants(
  messages: GatewayMessage[],
): GatewayMessage[] {
  const merged: GatewayMessage[] = [];
  for (const m of messages) {
    const last = merged[merged.length - 1];
    if (last && last.role === "assistant" && m.role === "assistant") {
      // The knowledge-delta closer (`*🧠 Refreshed memory*`) must ALWAYS stay
      // as a separate assistant message — never coalesced into a real
      // assistant response. A harness would otherwise render the closer inline
      // with the real reply (e.g. "Sure, I'll do that. 🧠 Refreshed memory")
      // and the model could treat the closer as part of its own turn. Insert a
      // user-turn separator if necessary (the closer is always followed by a
      // real message after the safeDeltaInsertIndex cap, but that message may
      // be an assistant(tool_use) in a mid-tool-loop layout).
      if (isKnowledgeDeltaCloser(last) || isKnowledgeDeltaCloser(m)) {
        if (isKnowledgeDeltaCloser(last)) {
          merged.push(m);
        } else {
          merged[merged.length - 1] = last;
          merged.push(m);
        }
        continue;
      }
      // Anthropic (and the block-order-preserving egress) require any leading
      // thinking / redacted_thinking blocks to stay FIRST in an assistant
      // message when extended thinking is active — clients inspect content[0].
      // The injected knowledge-delta payload lives in `last`; naively
      // concatenating `[...last.content, ...m.content]` would push `m`'s leading
      // reasoning blocks off index 0 and produce a wire-invalid message (hard
      // 400 on every replay turn of an extended-thinking tool loop). Splice
      // `last`'s blocks AFTER `m`'s leading reasoning run instead — mirrors the
      // injectContextWarning insertion rule. `last` is the earlier message and
      // never itself leads with reasoning (it is the synthetic delta payload),
      // so only `m`'s leading run needs to be protected.
      let lead = 0;
      while (lead < m.content.length && isReasoningBlock(m.content[lead])) {
        lead++;
      }
      merged[merged.length - 1] = {
        role: "assistant",
        content: [
          ...m.content.slice(0, lead),
          ...last.content,
          ...m.content.slice(lead),
        ],
      };
    } else {
      merged.push(m);
    }
  }
  return merged;
}

/**
 * True for a thinking block or a redacted_thinking block (the latter carried as
 * an `opaque` passthrough — see requestHasThinking). Such blocks must remain at
 * the head of an assistant message when extended thinking is active.
 */
function isReasoningBlock(block: GatewayContentBlock): boolean {
  return (
    block.type === "thinking" ||
    (block.type === "opaque" && block.raw.type === "redacted_thinking")
  );
}

/** @internal Exported for tests. */
export function applySessionPromptDeltas(
  messages: GatewayMessage[],
  sessionID: string,
): GatewayMessage[] {
  const deltas = listSessionPromptDeltas(sessionID);
  if (!deltas.length) return messages;

  const out = messages.slice();
  // We carry the raw selector JSON alongside the validated `insertAt` so the
  // re-anchor path can preserve unknown fields (notably `mut`, the per-block
  // mutation signature used by advanceSurfacedKeys). parseMessageInsertSelector
  // returns ONLY {target, insertAt} — spreading that loses every other field
  // and reintroduces the bug #958 fixed in session 1LYkXZ7jkiHHnqPl. Use the
  // same raw-JSON mutate pattern as reanchorExistingDelta below.
  const parsed: Array<{
    seq: number;
    rawSelector: string;
    clamped: number;
    safe: number;
    messages: GatewayMessage[];
  }> = [];
  for (const delta of deltas) {
    const selector = parseMessageInsertSelector(delta.selector);
    // NB: name this `blockMessages`, NOT `messages` — the function parameter
    // `messages` (the conversation array) must stay in scope below for
    // clamped/safeDeltaInsertIndex, which are relative to the CONVERSATION.
    const blockMessages = parseDeltaMessages(delta.content);
    if (!selector || !blockMessages.length) {
      log.warn(
        `prompt-delta: skipping corrupt delta seq=${delta.seq} session=${sessionID.slice(0, 16)}`,
      );
      continue;
    }
    // Compute the tool-pair-safe index against the ORIGINAL `messages` array —
    // a STABLE reference shared by every block this turn. Computing it against
    // the MUTATING `out` (as earlier blocks splice in) makes a block's nudge
    // depend on processing order: two blocks sharing an insertAt would have the
    // first block's splice shield the second from the tool_use, so they persist
    // DIVERGENT indices and flip their replay order on later turns — a cache
    // bust (Seer, PR #976 follow-up; reanchorExistingDelta deliberately puts
    // all blocks at the SAME insertAt, so the collision is reachable).
    const clamped = Math.min(selector.insertAt, messages.length);
    const safe = safeDeltaInsertIndex(messages, clamped);
    parsed.push({
      seq: delta.seq,
      rawSelector: delta.selector,
      clamped,
      safe,
      messages: blockMessages,
    });
  }
  // Sort by the (stable) safe position DESC, then seq DESC, so splicing
  // back-to-front places equal-position blocks in ascending-seq order (the
  // append-only chronological order). Sorting by safe (not the stored insertAt)
  // keeps the placement consistent with the index we actually splice at.
  parsed.sort((a, b) => {
    const byPosition = b.safe - a.safe;
    return byPosition !== 0 ? byPosition : b.seq - a.seq;
  });

  // Bug 2: when safeDeltaInsertIndex nudges a stored insertAt because the
  // compressed array below it slid (steady-layer-1 layout shifts), persist
  // the new safe index so subsequent replays use it verbatim. Without this,
  // every turn the nudge re-fires and the delta block drifts +N/turn, busting
  // `messages[0]` (production session 1GYu, k:019ece09). Batched at the end so
  // each drift = one DB write, not one per turn.
  const reanchored: Array<{ seq: number; selector: string }> = [];
  for (const { seq, rawSelector, clamped, safe, messages } of parsed) {
    // Selector positions are defined against the transformed upstream message
    // array at the time the delta is created (where they were already made
    // tool-pair-safe via safeDeltaInsertIndex). Re-inserting at the SAME index
    // on subsequent turns is intentional: #747 requires the delta to stay at a
    // byte-identical position to preserve the conversation prompt cache.
    //
    // safeDeltaInsertIndex is run (above, against `messages`) as a tool-pair
    // guard: when the persisted index still points at a safe boundary (the
    // common case) it returns the index unchanged → byte-identical replay.
    // When the layout below the stored index has shifted (compressed layer-1
    // array slides) and the persisted index now lands BETWEEN an
    // assistant(tool_use) and its user(tool_result), the function walks back
    // before the assistant. We persist that nudge so the next turn does NOT
    // re-fire the same nudge (the new persisted index is byte-stable until the
    // next layout shift). `safe` is a `messages`-relative index; splicing it
    // back-to-front into `out` is correct because higher positions are spliced
    // first (lower-index blocks are never shifted by a later, lower splice).
    if (safe !== clamped) {
      // Mutate the raw JSON to preserve unknown fields (mut, etc.) — do NOT
      // spread the typed MessageInsertSelector (only carries target+insertAt).
      let rawSelectorObj: Record<string, unknown>;
      try {
        rawSelectorObj = JSON.parse(rawSelector) as Record<string, unknown>;
      } catch {
        rawSelectorObj = { target: "messages" };
      }
      rawSelectorObj.insertAt = safe;
      reanchored.push({ seq, selector: JSON.stringify(rawSelectorObj) });
    }
    // Splice ALL of a block's messages at `safe`, contiguous and in order (the
    // user→assistant pair; a legacy single-message block splices as one). Blocks
    // are processed high-safe-first, so a block's pair is never split by a later
    // (lower) splice, and stacked pairs alternate cleanly.
    out.splice(safe, 0, ...messages);
  }
  for (const { seq, selector } of reanchored) {
    updateSessionPromptDeltaSelector(sessionID, seq, selector);
  }
  // The knowledge delta is injected as a user→assistant PAIR. In a mid-tool-loop
  // turn (tail = assistant(tool_use) → user(tool_result)) the tool-pair guard
  // walks the insert index to BEFORE the assistant(tool_use), so the pair's
  // trailing (injected) assistant lands immediately before that real assistant —
  // producing two consecutive assistant messages. That index is frozen for the
  // session, so a strict-alternation upstream (Anthropic maps messages 1:1, no
  // merge) would reject it every turn. Collapse adjacent assistant messages into
  // one (concatenated content blocks) — semantically identical on the wire and
  // valid for every egress protocol. tool_use stays in the merged assistant,
  // still immediately followed by its user(tool_result), so tool-pairing holds.
  // Only assistant↔assistant runs are merged (they essentially only arise from
  // this injection); user↔user adjacency — the pre-existing single-message
  // behavior — is left untouched.
  return coalesceAdjacentAssistants(out);
}

function ltmKeyMap(keys: string[] | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const key of keys ?? []) {
    const idx = key.lastIndexOf(":");
    out.set(idx === -1 ? key : key.slice(0, idx), key);
  }
  return out;
}

function changedLtmEntries(
  entries: Array<{
    id: string;
    category: string;
    title: string;
    content: string;
  }>,
  previousKeys: string[] | undefined,
  nextKeys: string[] | undefined,
) {
  const previous = ltmKeyMap(previousKeys);
  const nextIDs = entryKeyIds(nextKeys);
  return entries.filter((entry) => {
    if (!nextIDs.has(entry.id)) return false;
    const nextKey = `${entry.id}:${surfaceSignature(entry.title, entry.content)}`;
    return previous.get(entry.id) !== nextKey;
  });
}

function removedLtmEntryIds(
  previousKeys: string[] | undefined,
  nextKeys: string[] | undefined,
): string[] {
  const nextIDs = entryKeyIds(nextKeys);
  return Array.from(entryKeyIds(previousKeys)).filter((id) => !nextIDs.has(id));
}

function hasMaterialLtmDelta(input: {
  entries: Array<{
    id: string;
    category: string;
    title: string;
    content: string;
  }>;
  previousKeys: string[] | undefined;
  nextKeys: string[] | undefined;
}): boolean {
  return (
    changedLtmEntries(input.entries, input.previousKeys, input.nextKeys)
      .length > 0 ||
    removedLtmEntryIds(input.previousKeys, input.nextKeys).length > 0
  );
}

/**
 * Append-only delta trigger: detect GENUINE knowledge mutations to the
 * already-surfaced set, independent of per-turn relevance ranking.
 *
 * The legacy trigger (`hasMaterialLtmDelta`) compared the frozen system[2] pin
 * against the CURRENT per-turn `forSession()` selection. Because relevance
 * ranking picks a different subset every turn (e.g. 8→7→6→12 entries), an entry
 * that simply wasn't top-K this turn registered as "removed" — firing a delta
 * (and rewriting a deep-prefix message) every turn even though NOTHING changed
 * in the DB. That was the `cause=incremental` bust spiral (session
 * 1LYkXZ7jkiHHnqPl: read pinned at 41k, ~250k rewritten per turn).
 *
 * This trigger ignores ranking entirely. `surfacedKeys` is the set of
 * `id:surfaceSignature(title, content)` keys the model has ALREADY been shown.
 * Today every call site passes the FROZEN system[2] pin keys
 * (`pinned.entryKeys`), so the result is the cumulative delta from the pinned
 * baseline — preserving the single-coalesced-row contract. (The append-only
 * follow-up will widen this to the pin ∪ already-appended blocks.) For each key
 * we look up the entry's CURRENT state in the DB and compare the MATERIALITY
 * signature:
 *   - missing  → the entry was deleted/superseded → `removedIds`
 *   - sig differs → MATERIAL content edit (curator/consolidation) → `changed`
 *   - sig same → no signal (NOT in the result), whether ranking churned OR the
 *     edit was cosmetic (whitespace/punctuation/case only — see surfaceSignature)
 *
 * A delta is emitted iff `changed ∪ removedIds` is non-empty, so a steady
 * session with no real knowledge change emits zero deltas and never busts.
 *
 * @internal Exported for tests.
 */
export function detectSurfacedMutations(
  surfacedKeys: string[] | undefined,
  // Content resolver for SYNTHETIC context-source entries (category
  // `recalled`, ids `d:<id>`/`t:<id>` from distillation/temporal folding). These
  // are point-in-time SNAPSHOTS that do NOT live in the `knowledge` table, so
  // `ltm.get`/`getByLogical` can never resolve them — without this map they'd be
  // silently dropped (never surfaced, never rendered), regressing the default
  // `contextSources: ["distillation"]` passive-fact feature. Keyed by the same
  // id space as `surfacedKeys` (`d:<id>`/`t:<id>`). A synthetic's content is
  // immutable for a given id, so its hash only mismatches on FIRST surface —
  // exactly the turn its entry is present in this map — after which the hash
  // matches and no content lookup is needed.
  syntheticEntries?: Map<
    string,
    { category: string; title: string; content: string }
  >,
): {
  changed: Array<{
    id: string;
    category: string;
    title: string;
    content: string;
  }>;
  removedIds: string[];
} {
  const changed: Array<{
    id: string;
    category: string;
    title: string;
    content: string;
  }> = [];
  const removedIds: string[] = [];
  for (const key of surfacedKeys ?? []) {
    const idx = key.lastIndexOf(":");
    const id = idx === -1 ? key : key.slice(0, idx);
    const surfacedHash = idx === -1 ? "" : key.slice(idx + 1);
    // Resolve the surfaced id to its CURRENT version. The append-only knowledge
    // model (A2/#823) bumps the per-version `id` on every edit while keeping a
    // stable `logical_id`; the surfaced key holds the id as it was at surface
    // time. `get(id)` finds it while that version is still current; once a later
    // version supersedes it, fall back through `logicalIdOf` → `getByLogical` so
    // a mere version bump is reported as a CONTENT change, not a deletion. Only a
    // genuine delete (no current version for the logical_id) resolves to null.
    //
    // 🔴 Coupling: `logicalIdOf` reads the BASE `knowledge` table to map a
    // superseded version id → logical_id, correct only while superseded version
    // rows are NEVER physically purged (today delete = append a death-cert row).
    // A future base-row GC would make `logicalIdOf(purgedId)` fall back to the
    // input id → `getByLogical` null → a FALSE removal + one-time bust. Revisit
    // alongside any version-row compaction.
    const logicalId = ltm.logicalIdOf(id);
    const current = ltm.get(id) ?? ltm.getByLogical(logicalId);
    if (!current) {
      // Not a resolvable `knowledge` row. Before treating it as a non-knowledge
      // synthetic, check the context-source snapshot map: distillation/temporal
      // facts (`d:`/`t:`) are folded into the selection but live outside the
      // knowledge table, so their content must come from the current turn's
      // `entries`, not the DB. Surface on hash mismatch (the first-surface turn)
      // so they reach the wire via the durable delta — parity with the old
      // system[2] render.
      const synthetic = syntheticEntries?.get(id);
      if (synthetic) {
        const currentHash = surfaceSignature(
          synthetic.title,
          synthetic.content,
        );
        if (currentHash !== surfacedHash) {
          changed.push({
            id,
            category: synthetic.category,
            title: synthetic.title,
            content: synthetic.content,
          });
        }
        continue;
      }
      // Null resolution means EITHER a genuinely deleted knowledge entry OR an
      // id that was never a `knowledge` row at all (e.g. lat.md synthetics,
      // which forSession injects as KnowledgeEntry-shaped rows with ids like
      // `file#Heading` that live in lat_sections; or a context-source snapshot
      // that has left the current selection and so is absent from the map on a
      // later turn). Only a real knowledge deletion is a supersession — classify
      // as removed ONLY when the logical id is actually tombstoned. Otherwise the
      // model would be told to ignore still-valid pinned knowledge, and
      // (append-only) that false removal would be frozen into an immutable block
      // + advance the surfaced set past a non-knowledge id.
      if (ltm.isTombstoned(logicalId)) removedIds.push(id);
      continue;
    }
    const currentHash = surfaceSignature(current.title, current.content);
    if (currentHash !== surfacedHash) {
      // Report under the id the model already knows (the surfaced id), so the
      // delta's recall tokens and any later supersession matching stay in the
      // same id space as `surfacedKeys`. Content/title/category are current.
      changed.push({
        id,
        category: current.category,
        title: current.title,
        content: current.content,
      });
    }
  }
  return { changed, removedIds };
}

export function buildKnowledgeDeltaMessage(
  entries: Array<{
    id: string;
    category: string;
    title: string;
    content: string;
  }>,
  removedIds: string[],
  sessionToken: string,
  overflow?: Array<{
    id: string;
    category: string;
    title: string;
  }>,
): GatewayMessage[] {
  // Emit ONLY when there is genuine new/changed knowledge to surface. A
  // removals-only diff (a pinned entry deleted/superseded by background
  // consolidation, or dropped from the selected set) no longer injects a
  // mid-session message: a "## Superseded — ignore these ids" list is content
  // the model cannot reliably act on, and its per-turn churn was the dominant
  // cache-bust driver on long sessions (read floored, deep-prefix rewritten
  // every turn). The removal is still recorded in the block's `mut` signature
  // by the caller (advanceSurfacedKeys), so the surfaced set still advances;
  // the stale pin is simply left for the next session start to refresh.
  if (!entries.length) return [];
  const renderedIds: string[] = [];
  let rendered = formatKnowledge(
    entries.map((entry) => ({
      id: entry.id,
      category: entry.category,
      title: entry.title,
      content: entry.content,
    })),
    KNOWLEDGE_DELTA_TOKEN_BUDGET,
    renderedIds,
  );
  if (!rendered && entries.length) {
    const entry = entries[0];
    const truncated =
      entry.content.length > 900
        ? `${entry.content.slice(0, 900)}…`
        : entry.content;
    rendered =
      `## Long-term Knowledge\n\n### ${entry.category.charAt(0).toUpperCase()}${entry.category.slice(1)}\n\n` +
      `* **${entry.title}**: ${truncated}`;
    renderedIds.push(entry.id);
  }
  rendered ??= "";
  // Fold two groups into ONE compact, ACTIONABLE recall-by-id index:
  //  (1) changed entries that overflowed the full-render budget above —
  //      surfaced as `[k:id]` hints instead of the old "Additional Changed
  //      Knowledge (truncated)" dump (3 cut-off entries + "N more omitted",
  //      which the model couldn't act on);
  //  (2) #917 relevance-scored overflow that didn't fit system[2].
  // Sort by id (NOT relevance order, which churns per turn) so the section is
  // byte-stable across turns and only changes when the SET changes — preserving
  // the conversation prompt cache. Skip ids already fully rendered above, and
  // any removed id (a tombstoned entry must never be suggested for recall).
  const removedSet = new Set(removedIds);
  const tocSeen = new Set<string>(renderedIds);
  const tocEntries: Array<{ id: string; title: string; category: string }> = [];
  for (const e of [...entries, ...(overflow ?? [])]) {
    if (tocSeen.has(e.id) || removedSet.has(e.id)) continue;
    tocSeen.add(e.id);
    tocEntries.push({ id: e.id, title: e.title, category: e.category });
  }
  tocEntries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const tocRendered = tocEntries.length
    ? `\n\n## Other relevant knowledge (recall by id for detail)\n\n${tocEntries
        .slice(0, OVERFLOW_TOC_MAX)
        .map((e) => `* [k:${e.id}] ${e.title} (${e.category})`)
        .join("\n")}${
        tocEntries.length > OVERFLOW_TOC_MAX
          ? `\n* ${tocEntries.length - OVERFLOW_TOC_MAX} more — use recall with an id for detail.`
          : ""
      }`
    : "";
  // Inject as a user→assistant PAIR (mirrors the distilled-prefix pattern in
  // core/gradient.ts `buildPrefixMessages`), NOT a lone user message. A lone
  // user block read as an open user turn, so instruction-literal models (e.g.
  // MiniMax M3) prefaced every turn with "Acknowledged… none of this applies…
  // I won't reference this knowledge." The pair closes the exchange so the model
  // does not react to it.
  //
  // The KNOWLEDGE PAYLOAD rides the USER turn (as ambient context), and the
  // ASSISTANT turn is a tiny inert closer ("[memory refreshed]") that ends the
  // exchange. Putting the markdown payload on the assistant turn (the pre-fix
  // behavior) had two failure modes observed in production: (1) agent harnesses
  // (Claude Code REPL, OpenCode) RENDER the historical assistant message as a
  // visible turn — the recurring `⏺ Long-term Knowledge` dump; and (2) the model
  // treats that fake assistant turn as an already-completed turn and ends early,
  // so the agent loop exits prematurely (needs "continue"). Neither happens when
  // the payload is incoming user-role context and the assistant message carries
  // no markdown.
  //
  // Placement is GUARANTEED never to leave the pair at the true tail:
  // safeDeltaInsertIndex caps the insert index at messages.length - 1, so at
  // least one real message (a user turn / tool_result) always follows the pair
  // and closes the request. Without that cap the pair's trailing assistant could
  // become the literal last message — a harness renders it as a stray turn and
  // the model ends the loop early (the wedge). Stacked pairs alternate cleanly
  // (…user,asst,user,asst,final-user). The only same-role adjacency possible is
  // [user][inj-user] at the leading edge — identical to the prior single-user
  // behavior. The pair carries no tool_use/tool_result.
  //
  // NOTE: keep the substring "Lore knowledge update" in the user note — the
  // cache-stability e2e asserts on it.
  return [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `${buildKnowledgeDeltaFramingNote(sessionToken)}\n\n${rendered}${tocRendered}`,
        },
      ],
    },
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: KNOWLEDGE_DELTA_ASSISTANT_CLOSER,
        },
      ],
    },
  ];
}

/**
 * The mutation signature an appended delta block surfaced, stashed in the
 * block's selector JSON. `parseMessageInsertSelector` only VALIDATES the
 * `{target, insertAt}` shape and discards every other field on read, so this
 * rides alongside `insertAt` without affecting replay — but callers that need
 * to WRITE back a re-anchored selector (e.g. applySessionPromptDeltas' drift
 * fix) MUST go through the raw JSON, not the typed return, or `mut` is lost
 * (re-introduces the bug #958 fixed in session 1LYkXZ7jkiHHnqPl). Lets a
 * later turn reconstruct the ADVANCING surfaced set (frozen pin baseline +
 * every block's increment) purely from the persisted blocks — no extra state,
 * durable across restart for free.
 */
type DeltaMutation = {
  /** ids whose content was surfaced as changed, with the surfaced hash. */
  changed: Array<{ id: string; h: string }>;
  /** ids surfaced as removed/superseded. */
  removed: string[];
};

/** Read a block's stashed {@link DeltaMutation} from its selector JSON. */
function parseDeltaMutation(rawSelector: string): DeltaMutation | null {
  try {
    const parsed = JSON.parse(rawSelector) as { mut?: unknown };
    const mut = parsed.mut as Partial<DeltaMutation> | undefined;
    if (!mut || typeof mut !== "object") return null;
    const removed = Array.isArray(mut.removed)
      ? mut.removed.filter((x): x is string => typeof x === "string")
      : [];
    const changed = Array.isArray(mut.changed)
      ? mut.changed.filter(
          (x): x is { id: string; h: string } =>
            !!x &&
            typeof (x as { id?: unknown }).id === "string" &&
            typeof (x as { h?: unknown }).h === "string",
        )
      : [];
    return { changed, removed };
  } catch {
    return null;
  }
}

/**
 * Reconstruct the ADVANCING surfaced set: the frozen system[2] pin baseline
 * (`baseline` = `id:hash` keys) advanced through every already-appended block's
 * surfaced increment. A `changed` id moves to its surfaced hash; a `removed` id
 * drops out. Blocks must be applied in seq order (the natural order returned by
 * `listSessionPromptDeltas`, `ORDER BY seq`).
 *
 * This is the heart of the append-only redesign: once a mutation has been
 * surfaced by a block, it leaves the surfaced set, so the next turn's
 * `detectSurfacedMutations` sees no outstanding change and appends nothing —
 * killing the per-turn re-fire that rewrote a deep message every turn
 * (session 1LYkXZ7jkiHHnqPl). Old-format blocks (pre-redesign seq=0 rows with
 * no `mut`) contribute nothing here; at worst they cause one extra append on
 * the upgrade boundary, after which the new block carries the advance.
 *
 * @internal Exported for tests.
 */
export function advanceSurfacedKeys(
  baseline: string[] | undefined,
  blocks: Array<{ selector: string }>,
): string[] {
  const map = new Map<string, string>();
  for (const key of baseline ?? []) {
    const idx = key.lastIndexOf(":");
    const id = idx === -1 ? key : key.slice(0, idx);
    map.set(id, key);
  }
  for (const block of blocks) {
    const mut = parseDeltaMutation(block.selector);
    if (!mut) continue;
    for (const c of mut.changed) map.set(c.id, `${c.id}:${c.h}`);
    for (const id of mut.removed) map.delete(id);
  }
  return [...map.values()];
}

/** @internal Exported for tests (guards the DB-mutation wiring at its seam:
 *  a pinned entry that merely dropped out of the per-turn selection — but still
 *  exists in the DB — must produce NO delta, whereas a genuine content change
 *  or deletion must). */
export function appendKnowledgePromptDelta(input: {
  sessionID: string;
  projectPath: string;
  insertAt: number;
  /** Current wall-clock (ms). Used by the debounce window — when the latest
   *  block's `debounceAt` still covers `now`, the new mutations coalesce into
   *  it instead of appending a second block. Defaults to `Date.now()` so a
   *  caller can never silently bypass the debounce by forgetting to pass it
   *  (a previous design used `now?: number` and treated undefined as "skip
   *  debounce, always append", which was an easy footgun for future callers). */
  now?: number;
  previousKeys: string[] | undefined;
  nextKeys: string[] | undefined;
  entries: Array<{
    id: string;
    category: string;
    title: string;
    content: string;
  }>;
  overflow?: Array<{ id: string; category: string; title: string }>;
}): boolean {
  // Source the delta from GENUINE DB mutations to the ADVANCING surfaced set,
  // NOT from the per-turn relevance selection. `previousKeys` is the frozen
  // system[2] pin baseline; the surfaced set is that baseline advanced through
  // every block already appended this session (each block records the
  // `id:hash` mutations it surfaced in its selector). `detectSurfacedMutations`
  // compares the surfaced set against the CURRENT DB state, so:
  //   - an entry that merely wasn't top-K this turn produces no delta (it never
  //     left the surfaced set and the DB is unchanged) — kills the ranking
  //     churn that rewrote a deep message every turn (session 1LYkXZ7jkiHHnqPl:
  //     read pinned at 41k, ~250k rewritten per turn);
  //   - a removal/change ALREADY surfaced by a prior block has left the surfaced
  //     set, so a PERSISTENT mutation (e.g. 66 pinned entries genuinely gone)
  //     fires exactly once, not every turn.
  // `nextKeys` is retained on the input for the gate sites (hasMaterialLtmDelta).
  // `entries` supplies content for SYNTHETIC context-source ids (see
  // syntheticEntries below); knowledge-row content is re-derived from the DB.
  let blocks = listSessionPromptDeltas(input.sessionID);
  // Bound pathological growth: if too many blocks have accumulated without a
  // reshuffle to coalesce them, clear them and re-derive ONE cumulative block
  // from the frozen pin baseline below (advanceSurfacedKeys over [] == the pin,
  // so detectSurfacedMutations re-captures the full pin→DB delta). Costs one
  // bust, paid only when MAX_DELTA_BLOCKS is reached.
  if (blocks.length >= MAX_DELTA_BLOCKS) {
    deleteSessionPromptDelta(input.sessionID);
    blocks = [];
  }
  const surfacedKeys = advanceSurfacedKeys(input.previousKeys, blocks);
  // Context-source snapshots (category `recalled`, ids `d:`/`t:`) don't live in
  // the knowledge table, so detectSurfacedMutations can't resolve their content
  // from the DB — supply it from this turn's selection. A synthetic's content
  // is immutable per id, so it only needs resolving on its first-surface turn,
  // which is exactly when it's present in `input.entries`.
  const syntheticEntries = new Map<
    string,
    { category: string; title: string; content: string }
  >();
  for (const e of input.entries ?? []) {
    if (e.category === ltm.RECALLED_CONTEXT_CATEGORY) {
      syntheticEntries.set(e.id, {
        category: e.category,
        title: e.title,
        content: e.content,
      });
    }
  }
  const { changed, removedIds } = detectSurfacedMutations(
    surfacedKeys,
    syntheticEntries,
  );
  const messages = buildKnowledgeDeltaMessage(
    changed,
    removedIds,
    loreSessionToken(input.sessionID),
    input.overflow,
  );
  if (!messages.length) return false;

  // APPEND a fresh immutable block at the current tail (seq = MAX+1) instead of
  // rewriting one coalesced row in place. The insertAt is computed tool-pair-
  // safe at the call site against the CURRENT array tail, so the new message
  // extends the cache frontier (it sits after everything already cached and
  // before the final uncached user turn) → it never invalidates the prefix. An
  // appended block is never touched again: its content + position are frozen,
  // so later turns replay it byte-identically (cache-stable by construction).
  // The block stashes the mutation signature it surfaced so the NEXT turn can
  // advance the surfaced set past it (see advanceSurfacedKeys).
  //
  // DEBOUNCE: when the latest block is still within KNOWLEDGE_DELTA_DEBOUNCE_MS
  // of its creation, merge the new mutations into it instead of creating a
  // second block. This collapses rapid-fire curator batches (e.g. 3 entries
  // curated back-to-back) into a single block, so the model sees one
  // `[memory refreshed]` cycle instead of three back-to-back. The merged block's
  // `mut` is the union of both, its content is the union payload, and its
  // `insertAt` is the current tail (which may have moved). The debounce window
  // resets on every coalesce — consecutive mutations within the window keep
  // merging into the same block. When the window expires (or a compression
  // fires), the next mutation creates a fresh block and a new window starts.
  const mut: DeltaMutation = {
    changed: changed.map((c) => ({
      id: c.id,
      h: surfaceSignature(c.title, c.content),
    })),
    removed: removedIds,
  };

  const latest = blocks[blocks.length - 1];
  const now = input.now ?? Date.now();
  if (latest && withinDebounceWindow(latest.selector, now)) {
    // Merge into the latest block: union muts, union content, update insertAt.
    const mergedMut = mergeMutations(parseDeltaMutation(latest.selector), mut);
    const mergedMessages = mergeDeltaContent(
      JSON.parse(latest.content) as GatewayMessage[],
      messages,
    );
    updateSessionPromptDeltaSelector(
      input.sessionID,
      latest.seq,
      JSON.stringify({
        target: "messages",
        insertAt: input.insertAt,
        mut: mergedMut,
        debounceAt: now + KNOWLEDGE_DELTA_DEBOUNCE_MS,
      }),
    );
    updateSessionPromptDeltaContent(
      input.sessionID,
      latest.seq,
      JSON.stringify(mergedMessages),
    );
    log.info(
      `prompt-delta: coalesced into latest block for session ${input.sessionID.slice(0, 16)} (now ${mergedMut.changed.length} changed, ${mergedMut.removed.length} removed, insertAt=${input.insertAt}, seq=${latest.seq})`,
    );
    return true;
  }

  appendSessionPromptDelta({
    sessionID: input.sessionID,
    projectID: ensureProject(input.projectPath),
    selector: JSON.stringify({
      target: "messages",
      insertAt: input.insertAt,
      mut,
      debounceAt: now + KNOWLEDGE_DELTA_DEBOUNCE_MS,
    }),
    content: JSON.stringify(messages),
  });
  log.info(
    `prompt-delta: appended knowledge block for session ${input.sessionID.slice(0, 16)} (${changed.length} changed, ${removedIds.length} removed, insertAt=${input.insertAt}, seq=${blocks.length})`,
  );
  return true;
}

/**
 * Window (ms) during which a new mutation merges into the LATEST block instead
 * of appending a new one. Bounds rapid-fire curator batches (e.g. 3 entries
 * curated back-to-back) to a single `[memory refreshed]` cycle. 60s — long
 * enough to absorb a curator batch, short enough that an idle session's next
 * mutation (after the user resumes) gets its own block.
 */
const KNOWLEDGE_DELTA_DEBOUNCE_MS = 60_000;

/** True when the latest block's debounce window still covers `now`. */
function withinDebounceWindow(rawSelector: string, now: number): boolean {
  try {
    const parsed = JSON.parse(rawSelector) as { debounceAt?: unknown };
    return typeof parsed.debounceAt === "number" && parsed.debounceAt > now;
  } catch {
    return false;
  }
}

/**
 * Union two DeltaMutations. `changed` entries: same id → keep the later (higher)
 * hash wins (curator may have re-surfaced the same id with new content). `removed`
 * entries: union of both sets.
 */
function mergeMutations(
  prev: DeltaMutation | null,
  next: DeltaMutation,
): DeltaMutation {
  if (!prev) return next;
  const changedMap = new Map<string, { id: string; h: string }>();
  for (const c of prev.changed) changedMap.set(c.id, c);
  for (const c of next.changed) changedMap.set(c.id, c);
  const removed = new Set([...prev.removed, ...next.removed]);
  return {
    changed: [...changedMap.values()],
    removed: [...removed],
  };
}

/**
 * Merge the new delta messages into the existing block's content. The existing
 * block has a user-turn payload + assistant-closer pair; we replace the user
 * payload with a union of all changed entries (deduped by id, latest content
 * wins) and remove any removed ids from the rendered list.
 */
function mergeDeltaContent(
  prev: GatewayMessage[],
  next: GatewayMessage[],
): GatewayMessage[] {
  // The existing block is [user(payload), assistant(closer)]. The new block is
  // the same shape. Concatenate the payloads and keep the closer.
  const userText = firstText(prev[0]) ?? "";
  const closerText = firstText(prev[1]) ?? KNOWLEDGE_DELTA_ASSISTANT_CLOSER;
  // Reuse the next block's payload text directly — it was just built by
  // buildKnowledgeDeltaMessage from the latest changed/removed set, which is
  // a superset of the previous block's (the previous block's entries are
  // already in the surfaced set, so they would NOT appear in `changed` again;
  // the new payload contains only the genuinely-new mutations).
  const nextUserText = firstText(next[0]) ?? "";
  return [
    {
      role: "user",
      content: [{ type: "text", text: `${userText}\n\n${nextUserText}` }],
    },
    {
      role: "assistant",
      content: [{ type: "text", text: closerText }],
    },
  ];
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

/**
 * Single-flight memoizer for the per-session stable-LTM recompute.
 *
 * The stable-LTM block (preferences + known entities + project-knowledge
 * catalog) is computed once per session, then pinned for ≥1h. The compute is
 * heavy (ltm.forSession ×2, entity fetch, catalog scan — all read-worker pool
 * jobs). When a gateway restarts, the in-memory cache is cold, and the client's
 * header-timeout retries can fire THREE concurrent identical turns at the same
 * session BEFORE any of them has populated the cache. Without dedup, all three
 * recompute the block independently and thrash the DB — which compounds the
 * very latency that caused the retries.
 *
 * The settled cache (stableLtmCache) only helps the NEXT turn. This map dedups
 * concurrent in-flight recomputes so a burst of retries shares ONE compute and
 * the session recovers (headers flush, retries stop) instead of re-entering the
 * slow path.
 *
 * Keyed by sessionID. Entries are deleted on settle (the settled value goes
 * into stableLtmCache), so a LATER miss after a restart recomputes fresh.
 */
const stableLtmInFlight = new Map<string, Promise<void>>();
const sessionLifecycleAborts = new Map<string, AbortController>();

function sessionLifecycleSignal(sessionID: string): AbortSignal {
  let controller = sessionLifecycleAborts.get(sessionID);
  if (!controller) {
    controller = new AbortController();
    sessionLifecycleAborts.set(sessionID, controller);
  }
  return controller.signal;
}

function stableLtmComputeSignal(sessionID: string): AbortSignal {
  return AbortSignal.any([
    pipelineGenerationAbort.signal,
    sessionLifecycleSignal(sessionID),
  ]);
}

function evictStableLtmSession(sessionID: string): void {
  sessionLifecycleAborts
    .get(sessionID)
    ?.abort(new DOMException("stable LTM session was evicted", "AbortError"));
  sessionLifecycleAborts.delete(sessionID);
  stableLtmCache.delete(sessionID);
  stableLtmInFlight.delete(sessionID);
}

function evictPipelineSessionState(sessionID: string): void {
  // Keep the persisted header→session mapping warm. Eviction removes only the
  // heavy live state; dropping this index would force an unbounded DB reload on
  // the next request and would make state-changing slash commands unable to
  // rehydrate the authoritative canonical session safely.
  ltmSessionCache.delete(sessionID);
  ltmPinnedText.delete(sessionID);
  lastSavedDedupDecisions.delete(sessionID);
  evictStableLtmSession(sessionID);
  cwdWarned.delete(sessionID);
  staleHeaderWarned.delete(sessionID);
  for (const key of subagentParentPendingLogged) {
    if (key.startsWith(`${sessionID}:`))
      subagentParentPendingLogged.delete(key);
  }
}

/** Test seam for exercising the same cleanup used by idle session eviction. */
export function evictStableLtmSessionForTest(sessionID: string): void {
  evictStableLtmSession(sessionID);
}

/** Exercise idle eviction with the production ownership and satellite cleanup. */
export function evictIdlePipelineSessionsForTest(
  config: GatewayConfig,
  now: number,
): number {
  return evictIdleSessions(
    config,
    sessions,
    new Set(),
    new Set(),
    now,
    evictPipelineSessionState,
    isPipelineSessionActive,
  );
}

/**
 * Run a stable-LTM compute under single-flight dedup for a session. If a
 * compute is already in flight for the session, await it and return its
 * settled cache value; otherwise run `compute`, set the settled cache, and
 * clear the in-flight entry. The cache is always populated BEFORE the in-flight
 * promise resolves, so a concurrent awaiter re-reads it race-free.
 */
export async function singleFlightStableLtm(
  sessionID: string,
  compute: (
    signal: AbortSignal,
  ) => Promise<{ formatted: string; tokenCount: number } | undefined>,
  callerSignal?: AbortSignal,
): Promise<{ formatted: string; tokenCount: number } | undefined> {
  // Cache hit — fast path. Reading the cache FIRST is essential: a previous
  // caller may have already settled and deleted its in-flight entry, so a
  // cache-only check avoids a redundant recompute on the next call.
  const cached = stableLtmCache.get(sessionID);
  if (cached) return cached;
  const inFlight = stableLtmInFlight.get(sessionID);
  if (inFlight) {
    await promiseAgainstAbort(() => inFlight, callerSignal);
    return stableLtmCache.get(sessionID);
  }
  const signal = stableLtmComputeSignal(sessionID);
  let promise!: Promise<void>;
  promise = (async () => {
    try {
      const result = await promiseAgainstAbort(() => compute(signal), signal);
      signal.throwIfAborted();
      if (result) stableLtmCache.set(sessionID, result);
    } finally {
      if (stableLtmInFlight.get(sessionID) === promise) {
        stableLtmInFlight.delete(sessionID);
      }
    }
  })();
  stableLtmInFlight.set(sessionID, promise);
  await promiseAgainstAbort(() => promise, callerSignal);
  return stableLtmCache.get(sessionID);
}

/**
 * Compute the stable-LTM system[1] block (preferences + known entities +
 * project-knowledge catalog) for a session. Extracted from the turn pipeline so
 * it can be single-flighted across concurrent retries. Sets stableLtmCache +
 * persisted tracking before returning (matching the original inline behavior).
 */
async function computeStableLtm(
  sessionID: string,
  projectPath: string,
  cfg: ReturnType<typeof loreConfig>,
  contextHint: string | undefined,
  prefBudget: number,
  signal?: AbortSignal,
  requestGeneration?: number,
): Promise<{ formatted: string; tokenCount: number } | undefined> {
  const prefEntries = await ltm.forSession(projectPath, sessionID, prefBudget, {
    signal,
    categories: ["preference"],
    ...(contextHint ? { contextHint } : {}),
  });
  const prefText = prefEntries.length
    ? formatKnowledge(
        prefEntries.map((e) => ({
          id: e.id,
          category: e.category,
          title: e.title,
          content: e.content,
        })),
        prefBudget,
      )
    : "";

  // Known-entities block — folded into the stable system[1] block so it is
  // present from turn 1. Visibility is intentionally conservative:
  // entitiesForSession() returns only the current project's + genuinely-global
  // (cross_project) entities. Discoverable on demand via the recall tool.
  let entitiesText = "";
  if (cfg.knowledge.maxEntityInject > 0) {
    try {
      const sessionEntities = await entities.entitiesForSessionOffloaded(
        projectPath,
        cfg.knowledge.maxEntityInject,
      );
      if (sessionEntities.length) {
        const formattedEntities = entities.formatForPrompt(sessionEntities);
        if (formattedEntities) {
          entitiesText = `${formattedEntities}\n\n(Partial list — use the recall tool to resolve any name not shown here, including repositories, people, or services from your other projects.)`;
        }
      }
    } catch (err) {
      log.warn("entity injection failed (non-fatal):", err);
    }
  }

  // Project-knowledge catalog (#917 "A") — compact recall-by-id index.
  let knowledgeTocText = "";
  try {
    const catalog = (await ltm.forProjectOffloaded(projectPath, false))
      .filter((e) => e.category !== "preference")
      .map((e) => ({ id: e.id, category: e.category, title: e.title }));
    knowledgeTocText = buildKnowledgeCatalogText(
      catalog,
      STABLE_KNOWLEDGE_TOC_MAX,
    );
  } catch (err) {
    log.warn("knowledge catalog injection failed (non-fatal):", err);
  }

  const formatted = [
    buildLoreContextCapabilityNote(loreSessionToken(sessionID)),
    prefText,
    entitiesText,
    knowledgeTocText,
  ]
    .filter(Boolean)
    .join("\n\n");
  if (requestGeneration !== undefined) {
    assertCurrentPipelineGeneration(signal, requestGeneration);
  } else {
    signal?.throwIfAborted();
  }
  const tokenCount = formatted ? coreEstimateTokens(formatted) : 0;
  const stable = { formatted, tokenCount };
  stableLtmCache.set(sessionID, stable);
  saveSessionTracking(sessionID, {
    stableLtmText: formatted,
    stableLtmTokens: tokenCount,
  });
  return stable;
}

/**
 * Background precompute of the stable-LTM cache for an idle session.
 *
 * Runs from the idle handler (fire-and-forget) so that when a session idles
 * past the resume threshold, the next (cold post-idle) turn reads the stable
 * block from `stableLtmCache` instead of recomputing the heavy
 * ltm.forSession/entity/catalog chain on the request's critical path — the
 * exact path that pushed the gateway past opencode's 10s header timeout.
 *
 * Guards:
 *  - Only computes when the cache is genuinely missing (a warm cache is left
 *    alone — the 1h pinned bytes must not churn).
 *  - Reuses `singleFlightStableLtm`, so a concurrent in-flight turn compute is
 *    shared rather than duplicated.
 *  - Fire-and-forget: never rejects into the idle handler; a failure just
 *    leaves the cache cold and the next turn computes on demand.
 *  - The precompute omits `contextHint` (there's no last user message at idle).
 *    The cache-first design is intentional: a session idling past the resume
 *    threshold has no recent turn context, so the coarse ranking is the best
 *    available signal. The next turn's per-turn compute will land on the
 *    warmed cache (one DB hit instead of two).
 */
async function precomputeStableLtmForIdleSession(
  sessionID: string,
  state: SessionState,
): Promise<void> {
  const requestGeneration = streamingPostResponseGeneration;
  try {
    if (stableLtmCache.has(sessionID)) return;
    const cfg = loreConfig();
    if (!cfg.knowledge.enabled) return;
    const projectPath = state.projectPath;
    if (!projectPath) return;
    const ltmBudgetOpts = { isSubagent: !!state.isSubagent };
    const prefBudget = getPreferenceLtmBudget(
      cfg.budget.preferenceLtm,
      sessionID ?? undefined,
      ltmBudgetOpts,
    );
    log.info(
      `idle precompute: warming stable LTM for session ${sessionID.slice(0, 16)} (pref=${prefBudget})`,
    );
    await singleFlightStableLtm(sessionID, (signal) =>
      computeStableLtm(
        sessionID,
        projectPath,
        cfg,
        undefined,
        prefBudget,
        signal,
        requestGeneration,
      ),
    );
  } catch (err) {
    log.warn(
      `idle precompute: stable LTM warm failed for ${sessionID.slice(0, 16)}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/** Cached LLM client for background workers. */
let llmClient: LLMClient | null = null;
/** Whether the batch queue wrapper is active (set once in getLLMClient). */
let batchQueueEnabled = false;

/** Cleanup function for the idle scheduler timer. */
let stopIdleScheduler: (() => void) | null = null;
let stopSyncScheduler: (() => Promise<void>) | null = null;

/** Cleanup function for the .lore.md / agents-file watcher. */
let stopFileWatcher: (() => void) | null = null;

/** Last seen session model ID — used for worker model discovery context. */
let _lastSeenSessionModel: string | null = null;

/**
 * Whether we've logged the one-time "traffic is flowing" confirmation. New
 * users (Erica, Kjaer) had no clear signal that their agent was actually
 * routed through Lore — they'd run turns and wonder if anything was happening.
 * We emit a single friendly confirmation the first time a credentialed turn is
 * proxied, then stay quiet. Reset with the rest of pipeline state.
 */
let _firstTurnConfirmed = false;

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
  /**
   * Per-model quality knee: the context fill fraction (tokens / context) past
   * which lost-in-the-middle degradation is treated as material and the
   * compression quality penalty begins to ramp. Resolved by `getModelSpec` via
   * `resolveQualityKnee(model, cfg.budget.qualityKnee)`: config override →
   * literature-seeded per-family table → 0.4 default. These are priors;
   * empirically-measured per-model knees (via the eval harness / #1402) will
   * replace the seed table (#1404-B). Undefined only when explicitly unset.
   */
  qualityKneeFraction?: number;
};

const DEFAULT_MODEL_SPEC: ModelSpec = { context: 200_000, output: 8_192 };

/**
 * Look up model limits and cost data from models.dev.
 *
 * Uses the sync cache populated by `fetchModelData()` during init.
 * Falls back to sensible defaults if the cache isn't warm yet.
 *
 * `providerID` (when known from the request route) selects the
 * provider-qualified pricing entry so a bare id published by many providers at
 * different cache prices (e.g. `deepseek/deepseek-v4-flash` on openrouter vs
 * zenmux) is priced from the provider the session is ACTUALLY routed to — the
 * flat map is last-write-wins across providers and would otherwise corrupt
 * `cacheReadCost` → `computeLayer0Cap`.
 */
export function getModelSpec(model: string, providerID?: string): ModelSpec {
  const entry = getModelEntrySyncForProvider(providerID, model);
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
    // Per-model quality knee: config override wins, else the literature-seeded
    // per-family table (frontier models degrade later, cheaper models earlier),
    // else the 0.4 default. These are priors, not yet empirically measured
    // (#1404-A); #1402's rot-curve A/B will replace the table (#1404-B).
    qualityKneeFraction: resolveQualityKnee(
      model,
      loreConfig().budget.qualityKnee,
    ),
  };
}

// ---------------------------------------------------------------------------
// Dynamic max_tokens sizing for non-Claude-Code clients
// ---------------------------------------------------------------------------

const MAX_TOKENS_FLOOR = 8192;
const MAX_TOKENS_BUFFER = 1000;
const MAX_TOKENS_EMA_MULTIPLIER = 3;
/**
 * Minimum room reserved for visible output (text + tool calls) on top of the
 * extended-thinking budget. For Anthropic, `max_tokens` is the COMBINED cap on
 * thinking + visible output, and the API requires `max_tokens > budget_tokens`.
 * If the cap is sized without accounting for the thinking budget, a deep-think
 * turn can consume the entire allowance on reasoning, hit `stop_reason:"length"`
 * mid-thought, and emit no text/tool call — the turn "stops" with nothing
 * rendered and the agent loop exits with no auto-recovery.
 */
const THINKING_OUTPUT_HEADROOM = 8192;

/**
 * Compute a right-sized `max_tokens` value for a conversation turn using
 * a hybrid headroom + history approach.
 *
 * - Turn 1 (no history): returns `ceiling` (32K) — matches Claude Code.
 * - Turns 2+: 3× output EMA, clamped by context headroom and ceiling.
 * - After truncation (`stop_reason: "length"`): jumps back to ceiling.
 *
 * When extended thinking is enabled (`thinkingBudget > 0`), the result is
 * floored at `thinkingBudget + THINKING_OUTPUT_HEADROOM` so reasoning never
 * starves the visible output. Anthropic requires `max_tokens > budget_tokens`;
 * a low output EMA (e.g. after a run of short tool-call turns) would otherwise
 * collapse the cap to `MAX_TOKENS_FLOOR`, truncating thinking-heavy turns.
 *
 * When thinking is active but no budget was declared (`thinkingActive` —
 * thinking-by-default models like claude-opus-4-8 emit thinking blocks without
 * a `thinking` request param, so the budget is unknowable), the floor is raised
 * to the soft ceiling so the same EMA collapse can't truncate mid-thought.
 *
 * Exported for testing.
 */
export function computeMaxTokens(
  modelOutput: number,
  modelContext: number,
  outputEMA: number | undefined,
  lastStopReason: string | undefined,
  lastInputTokens: number | undefined,
  thinkingBudget?: number,
  thinkingActive?: boolean,
): number {
  const ceiling = Math.min(modelOutput, 32_000);

  // Extended thinking: max_tokens must leave room for visible output ON TOP of
  // the thinking budget (Anthropic counts both against max_tokens and requires
  // max_tokens > budget_tokens). This raises the effective floor — but never
  // above the model's hard output limit. Two signals, in priority order:
  //   1. thinkingBudget (explicit `thinking` param) → budget + headroom.
  //   2. thinkingActive (structural — thinking blocks present but no declared
  //      budget) → reserve the full soft ceiling, since the budget is unknowable
  //      and a low EMA must not be allowed to collapse the cap mid-thought.
  let baseFloor: number;
  if (thinkingBudget && thinkingBudget > 0) {
    baseFloor = thinkingBudget + THINKING_OUTPUT_HEADROOM;
  } else if (thinkingActive) {
    baseFloor = ceiling;
  } else {
    baseFloor = MAX_TOKENS_FLOOR;
  }
  const floor = Math.min(baseFloor, modelOutput);

  // Turn 1: no history — use ceiling (matches Claude Code default), but never
  // below the thinking floor.
  if (outputEMA == null) return Math.max(ceiling, floor);

  // Headroom: how much output the context can afford given last known input
  const estimatedInput = lastInputTokens ?? 0;
  const headroom = Math.max(
    floor,
    modelContext - estimatedInput - MAX_TOKENS_BUFFER,
  );

  // History: 3× recent output EMA — generous multiplier to absorb spikes
  let adaptive = Math.max(floor, MAX_TOKENS_EMA_MULTIPLIER * outputEMA);

  // Safety: if last turn was truncated, jump to ceiling
  if (lastStopReason === "length") {
    adaptive = ceiling;
  }

  // Clamp: history within headroom, within ceiling; never below the floor.
  return Math.max(
    floor,
    Math.min(headroom, Math.max(adaptive, floor), ceiling),
  );
}

/**
 * True when the request carries extended-thinking content — i.e. an assistant
 * message contains a `thinking` block.
 *
 * Thinking-by-default reasoning models (e.g. claude-opus-4-8) emit thinking
 * blocks WITHOUT sending an explicit `thinking` request param, so
 * `req.metadata.thinking` is absent and the budget can't be read. The presence
 * of thinking blocks in the conversation is direct evidence the model is
 * reasoning, so `max_tokens` must still reserve headroom — otherwise the
 * EMA-based down-rewrite collapses the cap to `MAX_TOKENS_FLOOR` and truncates
 * mid-thought (the turn emits no visible output and the agent loop exits).
 *
 * Scans newest-first and returns on the first hit; the latest assistant turn
 * almost always carries the signal, so this is effectively O(1) in practice.
 *
 * Also detects `redacted_thinking`, which Anthropic returns when reasoning is
 * flagged for safety. It has no dedicated `GatewayContentBlock` member, so
 * `toGatewayBlock` carries it as an `opaque` passthrough — but it still means
 * the model is reasoning, so a redacted-only turn must not collapse the cap.
 *
 * Exported for testing.
 */
export function requestHasThinking(messages: GatewayMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    for (const block of msg.content) {
      if (block.type === "thinking") return true;
      if (block.type === "opaque" && block.raw.type === "redacted_thinking") {
        return true;
      }
    }
  }
  return false;
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
      // No session hint here — resolve "auto" via existing-file detection
      // (prefers a CLAUDE.md the idle exporter already wrote, else AGENTS.md).
      const agentsFileName = resolveAgentsFileName(cfg.agentsFile.path, {
        projectPath,
      });
      const filePath = join(projectPath, agentsFileName);
      if (shouldImport({ projectPath, filePath })) {
        importFromFile({ projectPath, filePath });
        log.info("imported knowledge from", agentsFileName);
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

  // Watch the agents file(s) as fallback. Under "auto" we don't know which
  // agent will run, so watch BOTH candidates (AGENTS.md + CLAUDE.md); an
  // explicit path watches just that file.
  if (cfg.agentsFile.enabled) {
    const agentsFileNames =
      cfg.agentsFile.path === "auto"
        ? [...AGENTS_FILE_CANDIDATES]
        : [cfg.agentsFile.path];
    for (const name of agentsFileNames) {
      const agentsFilePath = join(projectPath, name);
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
  signal?: AbortSignal,
  requestGeneration?: number,
): Promise<void> {
  if (!pipelineResetInProgress) streamingPostResponsesAccepting = true;
  if (requestGeneration !== undefined) {
    assertCurrentPipelineGeneration(signal, requestGeneration);
  }
  if (initialized) return;

  // Enable hosted mode before any FS operations — once set, all core
  // functions that touch client-controlled paths become safe no-ops.
  if (config.hostedMode) {
    enableHostedMode();
  }

  await load(projectPath);
  if (requestGeneration !== undefined) {
    assertCurrentPipelineGeneration(signal, requestGeneration);
  }
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
  if (process.env.NODE_ENV !== "test") {
    // Warm the local embedding worker NOW (throwaway embed) so the ~21s ONNX
    // cold-load is paid at startup instead of on the first real distillation
    // embed — which on a short/fast session would otherwise race gateway
    // teardown and never write its `distillation_vec` row (#1331). Local-only,
    // fire-and-forget; the model loads during the backfill's startup delay.
    embedding.warmupEmbedding();
    // Idle-gate the heavy temporal re-chunk walk so it yields the shared embed
    // pool to live traffic: park while the breaker is tripped or a live recall
    // embed is in flight, resume the instant the worker drains.
    const startupBackfill = spanStartupBackfill(() => {
      const backfill = embedding.runStartupBackfill({
        shouldPause: buildTemporalBackfillGate(),
      });
      // When embeddings are available, runStartupBackfill synchronously
      // reconciles config and attempts vec0 cutover before its first await.
      // Start durable live-message scheduling after those transitions.
      temporalEmbeddingQueue.startTemporalEmbeddingScheduler();
      return backfill;
    });
    startupBackfill.catch((e) => {
      log.error("embedding backfill failed:", e);
    });
  }

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
    const restored = restoreHeaderSessionMappings(config);
    if (restored.cleared > 0) {
      log.warn(
        `cleared ${restored.cleared} unsafe persisted header→session mapping(s)`,
      );
    }
    if (restored.restored > 0) {
      log.info(`restored ${restored.restored} header→session mappings from DB`);
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
    const baseIdleHandler = buildIdleWorkHandler(llm);
    // Wrap the idle handler to ALSO precompute the stable-LTM cache for idle
    // sessions. When a session idles long enough that the next turn is a cold
    // post-idle resume, the gateway's LTM injection would otherwise recompute
    // the heavy stable block (ltm.forSession ×2 + entity fetch + catalog scan)
    // on the request's critical path — compounding the client header-timeout
    // latency. Precomputing at idle warms stableLtmCache (and the persisted
    // session tracking) so the resume turn reads it from cache instead. The
    // compute is single-flighted per session; a concurrent turn's
    // `singleFlightStableLtm` shares the same in-flight promise.
    const idleHandler = async (sessionID: string, state: SessionState) =>
      withTenant(state.storageTenantId ?? "", async () => {
        void precomputeStableLtmForIdleSession(sessionID, state);
        await baseIdleHandler(sessionID, state);
      });
    stopIdleScheduler = startIdleScheduler(
      config,
      sessions,
      idleHandler,
      evictPipelineSessionState,
      isPipelineSessionActive,
    );
  }

  // Start background cloud sync (no-op until the user runs `lore sync enable`).
  if (!stopSyncScheduler) {
    const { startSyncScheduler } = await import("./sync");
    if (requestGeneration !== undefined) {
      assertCurrentPipelineGeneration(signal, requestGeneration);
    }
    if (!stopSyncScheduler) stopSyncScheduler = startSyncScheduler(config);
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
      ? (_sessionID, providerID) => ({
          // Scheme is provider-aware: a GitHub-Models worker needs the key as a
          // Bearer token; every other provider uses api-key (x-api-key), the
          // long-standing dedicated-key shape. getAuth is invoked with the
          // worker MODEL's providerID (see llm-adapter), so this resolves per
          // worker call, not once at setup.
          scheme: workerKeyScheme(providerID),
          value: workerApiKey,
        })
      : (sessionID, providerID) => {
          if (sessionID) return resolveAuth(sessionID, providerID);
          return usesRemoteSessionBinding(config)
            ? null
            : resolveAuth(undefined, providerID);
        };

    // Worker-specific upstream: when LORE_WORKER_UPSTREAM is set, all worker
    // calls route to this URL instead of the default upstream URLs.
    const workerUpstreams = config.workerUpstream
      ? { anthropic: config.workerUpstream, openai: config.workerUpstream }
      : { anthropic: config.upstreamAnthropic, openai: config.upstreamOpenAI };

    if (config.workerApiKey || config.workerUpstream) {
      log.info(
        `worker routing: ` +
          `source=${config.workerApiKey ? "dedicated key" : "session"}, ` +
          `upstream=${
            config.workerUpstream
              ? upstreamUrlForLog(config.workerUpstream)
              : "default"
          }`,
      );
    }

    const rawClient = createGatewayLLMClient(
      workerUpstreams,
      getWorkerAuth,
      defaultModel,
      {
        dedicatedWorkerKey: !!workerApiKey,
        vertexProject: config.vertexProject,
      },
    );

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
    const dispatchClient = batchDisabled
      ? rawClient
      : createBatchLLMClient(
          rawClient,
          workerUpstreams,
          getWorkerAuth,
          defaultModel,
        );
    batchQueueEnabled = !batchDisabled;

    // Resolve routing BEFORE the batch client sees opts. Batch enqueue chooses
    // provider, model, auth, and grouping immediately; wrapping it on the inside
    // would queue stale/default opts and only correct them during sync fallback.
    // Current session state is authoritative over a caller's stale opts.model.
    const routedClient: LLMClient & {
      shutdown?: (options?: { drainQueue?: boolean }) => Promise<void>;
      stats?: () => unknown;
    } = {
      recordWorkerSuccess: rawClient.recordWorkerSuccess?.bind(rawClient),
      async prompt(system, user, opts) {
        if (!opts?.sessionID || opts.upstreamUrl) {
          return dispatchClient.prompt(system, user, opts);
        }
        const state = sessions.get(opts.sessionID);
        const effectiveModel =
          (state ? getWorkerModel(state.lastUpstream) : undefined) ??
          opts.model ??
          defaultModel;
        const snapshot = state
          ? matchingProviderSnapshot(state, effectiveModel.providerID)
          : undefined;
        const effectiveOpts: GatewayPromptOptions = {
          ...opts,
          model: effectiveModel,
        };
        if (
          snapshot?.providerOptions &&
          canonicalWorkerProviderID(effectiveModel.providerID) === "openrouter"
        ) {
          effectiveOpts.providerOptions = snapshot.providerOptions;
        }
        if (!workerApiKey && snapshot?.url && snapshot.providerID) {
          effectiveOpts.upstreamUrl = snapshot.url;
          effectiveOpts.upstreamProviderID = snapshot.providerID;
          effectiveOpts.protocol = snapshot.protocol;
        }
        return dispatchClient.prompt(system, user, effectiveOpts);
      },
    };
    if ("shutdown" in dispatchClient && "stats" in dispatchClient) {
      routedClient.shutdown = (options) => dispatchClient.shutdown(options);
      routedClient.stats = () => dispatchClient.stats();
    }
    llmClient = routedClient;
  }
  return llmClient;
}

/** Test-only access to the fully wrapped gateway worker client. */
export function getLLMClientForTest(config: GatewayConfig): LLMClient {
  return getLLMClient(config);
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

    // A stale/static `X-Lore-Project` header was overridden by an authoritative
    // inference (config.ts getProjectPath set `overrodeHeaderPath`). Warn once
    // per session so the misconfiguration is observable in the logs — a fixed
    // header (e.g. baked into ANTHROPIC_CUSTOM_HEADERS) collapses unrelated
    // projects together, which is otherwise silent.
    if (
      result.overrodeHeaderPath &&
      !staleHeaderWarned.has(sessionState.sessionID)
    ) {
      staleHeaderWarned.add(sessionState.sessionID);
      log.notice(
        `warning: session ${sessionState.sessionID.slice(0, 16)} sent ` +
          `X-Lore-Project header "${result.overrodeHeaderPath}" but its system ` +
          `prompt's working directory is "${projectPath}" — trusting the ` +
          `inferred path. A stale/static X-Lore-Project header (e.g. a fixed ` +
          `ANTHROPIC_CUSTOM_HEADERS) causes unrelated projects to collapse into ` +
          `one. Remove the static header or set it per-project.`,
      );
    }

    // Self-heal: if the session was previously bound to a provisional path
    // (cwd fallback or synthetic bucket) under which rows may already be
    // stored, migrate those rows into the real project now that we know it.
    // Only clear the provisional flag once the migration succeeds — otherwise
    // a transient failure (e.g. SQLITE_BUSY from a separate process) would
    // permanently strand the bucket data with no retry. Keeping the flag set
    // lets the next confident turn re-attempt.
    //
    // `confidentlyWrong`: the session is currently CONFIDENTLY bound (not
    // provisional) to the EXACT path a stale header just tried to assert, and
    // an authoritative inference now contradicts it. This is the only case
    // where we re-point an already-confident binding — gated tightly on
    // `previous === result.overrodeHeaderPath` so a normal header/inference
    // change can never trigger it. The re-attribution itself is merge-safe:
    // `reattributeProvisionalProject` only folds rows when corroborated (shared
    // git remote or synthetic bucket); for distinct real projects it re-binds
    // the session WITHOUT merging, so a stale header can never leak one
    // project's data into another.
    const confidentlyWrong =
      !wasProvisional &&
      !!previous &&
      !!result.overrodeHeaderPath &&
      previous === result.overrodeHeaderPath &&
      previous !== projectPath;

    let healed = true;
    if (
      (wasProvisional || confidentlyWrong) &&
      previous &&
      previous !== projectPath
    ) {
      healed = reattributeProvisionalProject(
        previous,
        projectPath,
        effectiveRemote,
      );
    }

    if (!healed && previous) {
      // Keep writing to the original bucket until re-attribution succeeds.
      // Moving the binding to projectPath here would lose `previous`, so the
      // next confident turn could never retry and the old rows would remain
      // permanently split from the session.
      sessionState.projectPath = previous;
      sessionState.projectPathProvisional = true;
      return previous;
    }

    sessionState.projectPath = projectPath;
    sessionState.projectPathProvisional = false;

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
    log.notice(
      `warning: could not determine project for session ` +
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
export function applySyntheticResolution(
  sessionState: SessionState,
  resolved: ResolveProjectResult,
  currentProjectPath: string,
): string {
  try {
    const { root, gitRemote, gitHead } = resolved;
    if (!root && !gitRemote) return currentProjectPath; // nothing useful — no-op

    const newPath = root ?? currentProjectPath;
    const previous = sessionState.projectPath;
    const wasProvisional = sessionState.projectPathProvisional === true;

    if (wasProvisional && previous && previous !== newPath) {
      if (!reattributeProvisionalProject(previous, newPath, gitRemote)) {
        return currentProjectPath;
      }
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
    // Bind the captured commit SHA (#627 Phase 1) so subsequent knowledge
    // creations in this session can stamp `metadata.gitHead`. The probe
    // already validates the format (synthetic-tools.ts:621), so no second
    // guard is needed here.
    if (gitHead) {
      sessionState.gitHead = gitHead;
    }

    if (gitRemote || root) {
      ensureProject(newPath, undefined, gitRemote);
    }

    log.info(
      `synthetic-resolve: bound session ${sessionState.sessionID.slice(0, 16)} → ` +
        `path=${newPath}${gitRemote ? ` remote=${gitRemote}` : ""}` +
        `${gitHead ? ` head=${gitHead.slice(0, 8)}` : ""}`,
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
      return translateAnthropicStreamToOpenAI(anthropicSSE, {
        signal: req.signal,
      });
    }
    if (req.protocol === "openai-responses") {
      return translateAnthropicStreamToResponses(anthropicSSE, {
        signal: req.signal,
      });
    }
    if (req.protocol === "gemini") {
      return translateAnthropicStreamToGemini(anthropicSSE, {
        signal: req.signal,
      });
    }
    return anthropicSSE;
  }

  // Non-streaming: use the existing format builders. (Synthetic tool_use carries
  // ZERO usage, so the cap never bites — thread longContext anyway for uniform
  // behavior and to stay correct if this response ever carries real usage.)
  return nonStreamHttpResponse(
    resp,
    req.protocol,
    req.stream,
    undefined,
    requestEnablesLongContext(req),
  );
}

// ---------------------------------------------------------------------------
// Session management helpers
// ---------------------------------------------------------------------------

const UPSTREAM_STATE_VERSION = 2;
const MAX_UPSTREAM_SNAPSHOTS_PER_SESSION = 16;
const MAX_PROVIDER_OPTIONS_BYTES = 64 * 1024;
const UPSTREAM_PROTOCOLS = new Set<UpstreamSnapshot["protocol"]>([
  "anthropic",
  "openai",
  "openai-responses",
  "vertex",
  "gemini",
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function freezeRecursively<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) freezeRecursively(child);
  return Object.freeze(value);
}

function freezeUpstreamSnapshot(snapshot: UpstreamSnapshot): UpstreamSnapshot {
  const providerOptions = snapshot.providerOptions
    ? freezeRecursively(structuredClone(snapshot.providerOptions))
    : undefined;
  return Object.freeze({
    ...snapshot,
    headers: Object.freeze({ ...snapshot.headers }),
    ...(providerOptions ? { providerOptions } : {}),
  });
}

function validatedUpstreamSnapshot(value: unknown): UpstreamSnapshot | null {
  if (!isPlainRecord(value)) return null;
  if (typeof value.url !== "string") return null;
  if (!UPSTREAM_PROTOCOLS.has(value.protocol as UpstreamSnapshot["protocol"])) {
    return null;
  }
  if (typeof value.model !== "string" || value.model.length === 0) return null;
  if (
    value.providerID !== undefined &&
    (typeof value.providerID !== "string" || value.providerID.length === 0)
  ) {
    return null;
  }
  if (
    !isPlainRecord(value.headers) ||
    !Object.values(value.headers).every((header) => typeof header === "string")
  ) {
    return null;
  }
  if (
    Object.hasOwn(value, "providerOptions") &&
    !isPlainRecord(value.providerOptions)
  ) {
    return null;
  }
  return freezeUpstreamSnapshot({
    url: value.url,
    // Legacy snapshots predate provenance. Treat them as caller-selected so a
    // remote gateway never revives a pre-policy arbitrary destination.
    callerSelected:
      typeof value.callerSelected === "boolean" ? value.callerSelected : true,
    protocol: value.protocol as UpstreamSnapshot["protocol"],
    ...(value.providerID ? { providerID: value.providerID } : {}),
    model: value.model,
    // Older persisted snapshots may contain credentials from before routing
    // state became credential-safe. Re-run the current forwarding filter when
    // hydrating instead of trusting those historical header bytes.
    headers: buildUpstreamSnapshotHeaders(
      value.headers as Record<string, string>,
    ),
    ...(isPlainRecord(value.providerOptions)
      ? { providerOptions: value.providerOptions }
      : {}),
  });
}

function providersEquivalent(left: string, right: string): boolean {
  return canonicalWorkerProviderID(left) === canonicalWorkerProviderID(right);
}

function matchingProviderSnapshot(
  state: SessionState,
  providerID: string,
): UpstreamSnapshot | undefined {
  const direct = state.upstreamByProvider.get(providerID);
  if (direct?.providerID === providerID) return direct;
  for (const snapshot of state.upstreamByProvider.values()) {
    if (
      snapshot.providerID &&
      providersEquivalent(snapshot.providerID, providerID) &&
      workerProviderSupportsProtocol(providerID, snapshot.protocol)
    ) {
      return snapshot;
    }
  }
  return undefined;
}

/** Test-only visibility into protocol-aware alias selection. */
export function matchingProviderSnapshotForTest(
  state: SessionState,
  providerID: string,
): UpstreamSnapshot | undefined {
  return matchingProviderSnapshot(state, providerID);
}

type MutableUpstreamState = Pick<
  SessionState,
  | "lastUpstream"
  | "upstreamByProvider"
  | "_upstreamRequestOrder"
  | "_upstreamRequestOrderByProvider"
>;

function serializeUpstreamState(state: MutableUpstreamState): string {
  const stripHeaders = (snapshot: UpstreamSnapshot) => ({
    ...snapshot,
    headers: {},
  });
  const upstreamByProvider: Record<string, unknown> = Object.create(null);
  for (const [providerID, snapshot] of state.upstreamByProvider) {
    upstreamByProvider[providerID] = stripHeaders(snapshot);
  }
  return JSON.stringify({
    version: UPSTREAM_STATE_VERSION,
    ...(state.lastUpstream
      ? { lastUpstream: stripHeaders(state.lastUpstream) }
      : {}),
    upstreamByProvider,
  });
}

function deserializeUpstreamState(
  serialized: string,
  config: GatewayConfig,
): {
  lastUpstream?: UpstreamSnapshot;
  upstreamByProvider: Map<string, UpstreamSnapshot>;
} {
  const parsed = JSON.parse(serialized) as unknown;
  const legacy = validatedUpstreamSnapshot(parsed);
  if (legacy) {
    const restored = {
      lastUpstream: legacy,
      upstreamByProvider: new Map(
        legacy.providerID ? [[legacy.providerID, legacy]] : [],
      ),
    };
    return filterRestoredUpstreamState(restored, config);
  }
  if (
    !isPlainRecord(parsed) ||
    parsed.version !== UPSTREAM_STATE_VERSION ||
    !isPlainRecord(parsed.upstreamByProvider)
  ) {
    throw new Error("invalid persisted upstream state");
  }

  const upstreamByProvider = new Map<string, UpstreamSnapshot>();
  for (const [providerID, rawSnapshot] of Object.entries(
    parsed.upstreamByProvider,
  )) {
    const snapshot = validatedUpstreamSnapshot(rawSnapshot);
    if (
      providerID.length === 0 ||
      !snapshot?.providerID ||
      providerID !== snapshot.providerID
    ) {
      throw new Error("invalid persisted provider upstream snapshot");
    }
    upstreamByProvider.set(providerID, snapshot);
  }

  let lastUpstream: UpstreamSnapshot | undefined;
  if (Object.hasOwn(parsed, "lastUpstream")) {
    lastUpstream = validatedUpstreamSnapshot(parsed.lastUpstream) ?? undefined;
    if (!lastUpstream) throw new Error("invalid persisted last upstream");
    const lastProviderID = lastUpstream.providerID;
    if (lastProviderID) {
      const providerSnapshot = upstreamByProvider.get(lastProviderID);
      if (
        !providerSnapshot ||
        providerSnapshot.url !== lastUpstream.url ||
        providerSnapshot.callerSelected !== lastUpstream.callerSelected ||
        providerSnapshot.protocol !== lastUpstream.protocol ||
        providerSnapshot.model !== lastUpstream.model ||
        JSON.stringify(providerSnapshot.providerOptions) !==
          JSON.stringify(lastUpstream.providerOptions)
      ) {
        throw new Error("inconsistent persisted last upstream");
      }
    }
  }
  return filterRestoredUpstreamState(
    { lastUpstream, upstreamByProvider },
    config,
  );
}

/**
 * Re-apply the current remote-gateway origin policy to persisted route state.
 * Legacy snapshots are marked caller-selected by validation above, so an
 * upgrade cannot revive an arbitrary pre-policy URL for workers or warmups.
 */
function filterRestoredUpstreamState(
  restored: {
    lastUpstream?: UpstreamSnapshot;
    upstreamByProvider: Map<string, UpstreamSnapshot>;
  },
  config: GatewayConfig,
): {
  lastUpstream?: UpstreamSnapshot;
  upstreamByProvider: Map<string, UpstreamSnapshot>;
} {
  if (!usesRemoteSessionBinding(config)) return restored;
  const allowed = (snapshot: UpstreamSnapshot): boolean =>
    snapshot.callerSelected === false ||
    (snapshot.callerSelected === true &&
      isCallerUpstreamAllowed(config, snapshot.url));
  return {
    ...(restored.lastUpstream && allowed(restored.lastUpstream)
      ? { lastUpstream: restored.lastUpstream }
      : {}),
    upstreamByProvider: new Map(
      [...restored.upstreamByProvider].filter(([, snapshot]) =>
        allowed(snapshot),
      ),
    ),
  };
}

/** Test-only access to persisted-route policy revalidation. */
export function restoreUpstreamStateForTest(
  serialized: string,
  config: GatewayConfig,
): {
  lastUpstream?: UpstreamSnapshot;
  upstreamByProvider: Map<string, UpstreamSnapshot>;
} {
  return deserializeUpstreamState(serialized, config);
}

function buildRequestUpstreamSnapshot(
  req: GatewayRequest,
  route: ResolvedRequestUpstreamRoute,
): UpstreamSnapshot {
  const providerRouting = providerRoutingValue(req);
  const providerOptions =
    !req.codex &&
    requestTargetsOpenRouter(req, route.effectiveUpstreamBase) &&
    providerRouting.present &&
    isPlainRecord(providerRouting.value)
      ? providerRouting.value
      : undefined;
  if (
    providerOptions &&
    Buffer.byteLength(JSON.stringify(providerOptions)) >
      MAX_PROVIDER_OPTIONS_BYTES
  ) {
    throw new Error(
      `OpenRouter provider routing options exceed ${MAX_PROVIDER_OPTIONS_BYTES} bytes`,
    );
  }
  const snapshot: UpstreamSnapshot = {
    url: route.effectiveUpstreamBase,
    callerSelected: route.headerUpstream !== undefined,
    protocol: route.effectiveProtocol,
    ...(route.providerID ? { providerID: route.providerID } : {}),
    model: req.model,
    headers: buildUpstreamSnapshotHeaders(req.rawHeaders),
    ...(providerOptions ? { providerOptions } : {}),
  };
  return freezeUpstreamSnapshot(snapshot);
}

function prepareRequestUpstream(
  req: GatewayRequest,
  config: GatewayConfig,
): {
  route: ResolvedRequestUpstreamRoute;
  snapshot: UpstreamSnapshot;
} {
  const route = resolveRequestUpstreamRoute(req, config);
  const snapshot = buildRequestUpstreamSnapshot(req, route);
  return { route, snapshot };
}

function applyRequestUpstream(
  state: MutableUpstreamState,
  snapshot: UpstreamSnapshot,
  requestOrder: number,
  config: GatewayConfig,
): { changed: boolean; resetCache: boolean } {
  let changed = false;
  let resetCache = false;

  if (requestOrder >= (state._upstreamRequestOrder ?? 0)) {
    const previous = state.lastUpstream;
    if (
      (previous &&
        (previous.url !== snapshot.url ||
          previous.protocol !== snapshot.protocol ||
          previous.model !== snapshot.model ||
          previous.providerID !== snapshot.providerID ||
          !isDeepStrictEqual(
            previous.providerOptions,
            snapshot.providerOptions,
          ))) ||
      (Object.keys(config.upstreamExtraHeaders).length > 0 &&
        Object.keys(extraHeadersForUpstream(config, snapshot.url)).length === 0)
    ) {
      // The cached body is route-specific and may contain a prior turn's full
      // transcript. Clear it synchronously with route capture so a failed or
      // in-flight policy-tightening request cannot let the idle warmer replay
      // that body (or admin extras) to the newly selected destination.
      resetCache = true;
    }
    state.lastUpstream = snapshot;
    state._upstreamRequestOrder = requestOrder;
    changed = true;
  }

  if (snapshot.providerID) {
    state._upstreamRequestOrderByProvider ??= new Map();
    const previousOrder =
      state._upstreamRequestOrderByProvider.get(snapshot.providerID) ?? 0;
    if (requestOrder >= previousOrder) {
      if (
        !state.upstreamByProvider.has(snapshot.providerID) &&
        state.upstreamByProvider.size >= MAX_UPSTREAM_SNAPSHOTS_PER_SESSION
      ) {
        const oldestProviderID = state.upstreamByProvider.keys().next().value;
        if (oldestProviderID !== undefined) {
          state.upstreamByProvider.delete(oldestProviderID);
          state._upstreamRequestOrderByProvider.delete(oldestProviderID);
        }
      }
      state.upstreamByProvider.set(snapshot.providerID, snapshot);
      state._upstreamRequestOrderByProvider.set(
        snapshot.providerID,
        requestOrder,
      );
      changed = true;
    }
  }

  return { changed, resetCache };
}

function captureRequestUpstream(
  req: GatewayRequest,
  state: SessionState,
  config: GatewayConfig,
  requestOrder: number,
): ResolvedRequestUpstreamRoute {
  const prepared = prepareRequestUpstream(req, config);
  const { changed, resetCache } = applyRequestUpstream(
    state,
    prepared.snapshot,
    requestOrder,
    config,
  );
  if (resetCache) state.cacheAnalytics.lastRequestBody = null;

  if (changed) {
    saveSessionTracking(state.sessionID, {
      lastUpstream: serializeUpstreamState(state),
    });
  }
  return prepared.route;
}

class SessionTenantMismatchError extends Error {
  constructor() {
    super("Session storage tenant does not match the authenticated request");
    this.name = "SessionTenantMismatchError";
  }
}

function getOrCreateSession(
  sessionID: string,
  projectPath: string,
  pathSource: ProjectPathResult["source"],
  credentialFingerprint: string,
  config: GatewayConfig,
): SessionState {
  const storageTenantId = currentTenantId();
  let state = sessions.get(sessionID);
  if (state) {
    // A session's storage owner is immutable. Reassigning it to whichever
    // request happened to touch it most recently turns an isolation failure
    // into durable cross-tenant background work. Missing ownership is accepted
    // only for the historical local namespace.
    if (
      (state.storageTenantId === undefined && storageTenantId !== "") ||
      (state.storageTenantId !== undefined &&
        state.storageTenantId !== storageTenantId) ||
      (usesRemoteSessionBinding(config) &&
        credentialFingerprint !== "" &&
        state.credentialFingerprint !== credentialFingerprint)
    ) {
      throw new SessionTenantMismatchError();
    }
    state.storageTenantId ??= "";
  }
  if (!state) {
    // Restore persisted tracking state from DB (survives process restarts)
    const persisted = loadSessionTracking(sessionID);
    // In remote mode the full credential fingerprint is both the authenticated
    // session owner and the durable storage tenant. A corrupt/stale index must
    // never hydrate a row owned by a different credential.
    if (
      usesRemoteSessionBinding(config) &&
      credentialFingerprint !== "" &&
      (storageTenantId !== credentialFingerprint ||
        (persisted !== null &&
          persisted.credentialFingerprint !== credentialFingerprint))
    ) {
      throw new SessionTenantMismatchError();
    }
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
      credentialFingerprint:
        persisted?.credentialFingerprint || credentialFingerprint,
      storageTenantId,
      lastRequestTime: Date.now(),
      lastUserTurnTime: 0,
      messageCount: persisted?.messageCount ?? 0,
      turnsSinceCuration: persisted?.turnsSinceCuration ?? 0,
      consecutiveTextOnlyTurns: persisted?.consecutiveTextOnlyTurns ?? 0,
      amnesia: persisted?.amnesia ?? false,
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
      const indexKey = sessionIndexKey(
        persisted.credentialFingerprint,
        persisted.headerName,
        persisted.headerSessionId,
      );
      headerSessionIndex.set(indexKey, sessionID);
    }

    // Restore cache warming state (v24) — preserves earned TTL tier
    if (persisted?.resolvedConversationTTL) {
      const ttl = persisted.resolvedConversationTTL;
      state.resolvedConversationTTL = ttl === "5m" || ttl === "1h" ? ttl : "5m";
    }
    if (persisted?.warmupState) {
      try {
        const restored = JSON.parse(persisted.warmupState) as WarmupState;
        state.warmup = restored;
        // 🔴 Phantom-savings defense-in-depth (Bug A): a persisted blob
        // represents a warmup THIS sid fired, so its refresh credit is valid
        // only if totalWarmups>0. If the blob is inconsistent (lastWarmupAt /
        // lastWarmupRefreshTokens set but totalWarmups===0 — e.g. an old
        // corrupt row or an inherited blob), drop the credit so no phantom
        // hit can be booked on the next turn.
        if ((state.warmup.totalWarmups ?? 0) === 0) {
          state.warmup.lastWarmupAt = 0;
          state.warmup.lastWarmupRefreshTokens = 0;
        }
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
    // Restore the frozen stable LTM block (system[1]) so it replays
    // byte-identically across process restarts and idle resumes — never
    // recomputed from the live knowledge table mid-session (v45). This is what
    // prevents a curator/consolidation delete from busting the cached prefix.
    if (persisted?.stableLtmText != null && persisted.stableLtmTokens != null) {
      stableLtmCache.set(sessionID, {
        formatted: persisted.stableLtmText,
        tokenCount: persisted.stableLtmTokens,
      });
    }
    // Restore the recall store (v46) so historical recall markers still expand
    // to their original tool_use + tool_result pair after a restart, instead of
    // leaking upstream as raw marker text and rewriting that message.
    if (persisted?.recallStore != null) {
      state.recallStore = deserializeRecallStore(persisted.recallStore);
    }
    if (persisted?.lastUpstream != null) {
      try {
        const restored = deserializeUpstreamState(
          persisted.lastUpstream,
          config,
        );
        state.lastUpstream = restored.lastUpstream;
        state.upstreamByProvider = restored.upstreamByProvider;
      } catch {
        log.warn(
          `corrupt last upstream for session ${sessionID.slice(0, 16)}, ignoring`,
        );
      }
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
  if (credentialFingerprint) {
    state.credentialFingerprint = credentialFingerprint;
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
      // oxlint-disable-next-line no-control-regex -- intentional control-character sanitization
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

/** How many leading messages to probe for content-hash overlap when adopting a
 *  resumed session after a restart (Tier 3b, issue #796). */
const ADOPT_PROBE_MESSAGES = 16;
/** Minimum confirmed user-message overlap to adopt a fingerprint-matched
 *  candidate — requires evidence beyond the (fingerprint-implied) first message. */
const ADOPT_MIN_OVERLAP = 2;

/**
 * Restart-proof session adoption (issue #796). Recovers a prior session for a
 * resumed conversation from its persisted fingerprint, CONFIRMS it by
 * content-hash overlap of the leading USER messages, and ADOPTS its id so the
 * conversation inherits the prior distillations, gradient calibration, and LTM
 * pin. Returns the adopted session (isNew=false) or null when no candidate is
 * confidently confirmed.
 *
 * Confirmation uses user messages only: temporal storage persists user messages
 * with position-stable deterministic IDs, while assistant responses are stored
 * under a synthetic index-0 ID — so only user messages are a reliable
 * cross-restart match signal. Confidently bound candidates require overlap in
 * the incoming project. A provisionally bound candidate instead checks its
 * existing bucket, allowing a later confident path to self-heal that bucket
 * without weakening the cross-project guard for confident bindings. Subagent
 * status must match, and a fork guard rejects a count that dropped far below the
 * candidate's stored count.
 *
 * Called from BOTH mint paths: the Tier-1 path (known header present but its
 * value is new — the opencode restart case; `known` is rebound to the adopted
 * sid for a future Tier-1 fast path) and the Tier-3 path (no known header).
 */
function trustedAdoptionRemote(
  projectPath: string,
  headers: Record<string, string>,
): string | undefined {
  const supplied = extractGitRemoteHeader(headers);
  // Adoption is read-only, so it cannot call ensureProject's trusted-remote
  // resolver. Match the current path's on-disk remote locally; only a hosted
  // gateway, which cannot inspect client disk, may trust the normalized header.
  return isHostedMode() ? supplied : (getGitRemote(projectPath) ?? undefined);
}

async function adoptByFingerprint(input: {
  req: GatewayRequest;
  headers: Record<string, string>;
  projectPath: string;
  gitRemote?: string;
  known: { headerName: string; sessionId: string } | null;
  msgCount: number;
  requestGeneration?: number;
  config: GatewayConfig;
  credentialFingerprint: string;
}): Promise<{
  sessionID: string;
  isNew: false;
  tier: 3;
  provisionalIdentity: true;
  provisionalKey?: string;
  adoptionFingerprint: string;
  expectedUnowned: boolean;
} | null> {
  const {
    req,
    headers,
    projectPath,
    gitRemote,
    known,
    msgCount,
    requestGeneration,
    config,
    credentialFingerprint,
  } = input;
  if (!projectPath) return null;

  const cred = extractAuth(req.rawHeaders);
  // Restart adoption grants access to an existing session, so an upstream URL
  // alone is not sufficient proof of ownership.
  if (!cred) return null;
  const authenticatedFingerprint = usesRemoteSessionBinding(config)
    ? credentialTenantFingerprint(cred)
    : authFingerprint(cred);
  if (credentialFingerprint !== authenticatedFingerprint) return null;
  const fingerprintInput = req.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));
  const remoteBinding = usesRemoteSessionBinding(config);
  const fingerprint = await fingerprintMessages(
    fingerprintInput,
    remoteBinding
      ? { tenantFingerprint: credentialFingerprint }
      : { authSuffix: cred ? authFingerprint(cred) : "" },
  );
  if (requestGeneration !== undefined) {
    assertCurrentPipelineGeneration(req.signal, requestGeneration);
  }

  const reqIsSubagent =
    !!headers["x-parent-session-id"] || isClaudeCodeSubagent(headers);
  const candidates = findSessionStatesByFingerprint(fingerprint, {
    credentialFingerprint,
  }).map((candidate) => ({ ...candidate, credentialBound: true }));
  // v78 added the credential suffix to conversation fingerprints. Legacy
  // candidates have the old unsuffixed fingerprint and no persisted owner;
  // they still require the same multi-message overlap policy below.
  const legacyFingerprint = await fingerprintMessages(fingerprintInput);
  if (requestGeneration !== undefined) {
    assertCurrentPipelineGeneration(req.signal, requestGeneration);
  }
  if (!remoteBinding) {
    candidates.push(
      ...findSessionStatesByFingerprint(legacyFingerprint, {
        legacyUnownedOnly: true,
      }).map((candidate) => ({ ...candidate, credentialBound: false })),
    );
  }
  const eligibleCandidates = candidates.filter(
    (c) => (c.is_subagent === 1) === reqIsSubagent,
  );
  if (eligibleCandidates.length === 0) return null;

  // Hash the leading user messages by their absolute index (the only
  // position-stable IDs in temporal storage). NOTE: identifySession runs before
  // stripContextMarkers, so these IDs (and the fingerprint above) are computed
  // from UN-stripped content, while stored IDs are post-strip. Adoption thus
  // assumes the LEADING user messages are marker-free; a `[lore:...]` marker in
  // an early message only lowers overlap (graceful miss → no adoption), never a
  // false positive. The primary target (opencode x-lore-session-id) sends no
  // such markers, and marker clients carry them on the latest turn only.
  const probeMessages: Array<{ index: number; message: GatewayMessage }> = [];
  let probedUsers = 0;
  const probeLimit = Math.min(req.messages.length, ADOPT_PROBE_MESSAGES);
  for (let i = 0; i < probeLimit; i++) {
    const m = req.messages[i];
    if (m.role !== "user") continue;
    probedUsers++;
    probeMessages.push({ index: i, message: m });
  }
  if (probeMessages.length < ADOPT_MIN_OVERLAP) return null;

  const incomingProjectId = resolveProjectByRemoteOrPath(
    gitRemote,
    projectPath,
  );
  const minOverlap = Math.max(ADOPT_MIN_OVERLAP, Math.ceil(probedUsers * 0.5));
  let best: {
    sid: string;
    overlap: number;
    countDiff: number;
    credentialBound: boolean;
  } | null = null;
  // Source IDs include the candidate session, so valid rows cannot give two
  // sessions the same positive overlap set. Keep the tie guard as defense in
  // depth for a corrupt/imported database rather than selecting by row order.
  let ambiguousBest = false;
  for (const c of eligibleCandidates) {
    // Fork guard (mirrors the in-memory Tier-3 scan): a count that dropped far
    // below the stored count is a fork, not a resume.
    if (msgCount - c.message_count < -MESSAGE_COUNT_PROXIMITY_THRESHOLD) {
      continue;
    }
    // A confident or legacy-unowned candidate remains scoped to the incoming
    // project. Only a credential-bound provisional binding may prove continuity
    // against its current bucket before the incoming project has been created.
    const usesPersistedProvisionalProject =
      c.credentialBound && c.project_path_provisional === 1 && !!c.project_path;
    const candidateProjectId = c.project_path
      ? resolveProjectByRemoteOrPath(undefined, c.project_path)
      : null;
    if (
      !usesPersistedProvisionalProject &&
      (!incomingProjectId || candidateProjectId !== incomingProjectId)
    ) {
      continue;
    }
    // Derive message IDs from the persisted canonical path. A new clone path
    // can resolve to the same project by git remote without being an alias yet;
    // deriving IDs from that unregistered path would create a second project
    // and make genuine transcript overlap impossible to observe.
    const overlapProjectPath =
      c.project_path && (usesPersistedProvisionalProject || candidateProjectId)
        ? c.project_path
        : projectPath;
    const overlapProjectId = usesPersistedProvisionalProject
      ? candidateProjectId
      : incomingProjectId;
    if (!overlapProjectId) continue;
    const probeIDs = probeMessages.map(({ index, message }) => {
      const sourceID = deterministicID(
        c.session_id,
        message.role,
        index,
        message.content,
      );
      return temporal.storedMessageId({
        projectPath: overlapProjectPath,
        sessionID: c.session_id,
        sourceID,
        legacySourceID: legacyDeterministicID(
          message.role,
          index,
          message.content,
        ),
      });
    });
    const overlap = countMatchingTemporalIds(
      overlapProjectId,
      c.session_id,
      probeIDs,
    );
    if (overlap < minOverlap) continue;
    const countDiff = Math.abs(msgCount - c.message_count);
    if (
      !best ||
      overlap > best.overlap ||
      (overlap === best.overlap && countDiff < best.countDiff)
    ) {
      best = {
        sid: c.session_id,
        overlap,
        countDiff,
        credentialBound: c.credentialBound,
      };
      ambiguousBest = false;
    } else if (overlap === best.overlap && countDiff === best.countDiff) {
      ambiguousBest = true;
    }
  }
  if (!best || ambiguousBest) return null;

  // Keep the adopted header provisional until a successful response confirms
  // it in postResponse. This preserves retry continuity without authorizing
  // sensitive routes after a failed/aborted adoption turn.
  log.info(
    `adopted prior session ${best.sid.slice(0, 16)} for resumed conversation ` +
      `(overlap=${best.overlap}/${probedUsers}` +
      `${known ? `, header=${known.headerName}` : ""})`,
  );
  if (known) {
    const provisionalKey = sessionIndexKey(
      credentialFingerprint,
      known.headerName,
      known.sessionId,
    );
    setProvisionalHeaderMapping(
      provisionalKey,
      best.sid,
      false,
      fingerprint,
      !best.credentialBound,
    );
    return {
      sessionID: best.sid,
      isNew: false,
      tier: 3,
      provisionalIdentity: true,
      provisionalKey,
      adoptionFingerprint: fingerprint,
      expectedUnowned: !best.credentialBound,
    };
  }
  return {
    sessionID: best.sid,
    isNew: false,
    tier: 3,
    provisionalIdentity: true,
    adoptionFingerprint: fingerprint,
    expectedUnowned: !best.credentialBound,
  };
}

type IdentifiedSession = {
  sessionID: string;
  isNew: boolean;
  tier: 1 | 2 | 2.5 | 3;
  provisionalIdentity?: boolean;
  provisionalKey?: string;
  guardProject?: boolean;
  adoptionFingerprint?: string;
  expectedUnowned?: boolean;
};

async function identifySession(
  req: GatewayRequest,
  projectPath: string,
  projectPathSource: ProjectPathResult["source"] | undefined,
  requestGeneration: number | undefined,
  config: GatewayConfig,
): Promise<IdentifiedSession> {
  const headers = req.rawHeaders;
  const credentialFingerprint = requestCredentialFingerprint(headers, config);

  // Remote correlation is authenticated. Without a usable credential, every
  // request receives an unindexed session rather than inheriting another
  // client's header, marker, fingerprint, or worker credential.
  if (credentialFingerprint === null) {
    return { sessionID: generateSessionID(), isNew: true, tier: 3 };
  }

  // --- Tier 1: Known headers ---
  // Sub-agent requests (carrying x-parent-session-id) are NOT merged into the
  // parent session. They carry their own x-session-affinity nanoid and get
  // independent sessions, benefiting from the full Lore pipeline (LTM,
  // gradient, distillation) on their own state without corrupting the parent.

  const known = extractKnownSessionHeader(headers);
  if (known) {
    const indexKey = sessionIndexKey(
      credentialFingerprint,
      known.headerName,
      known.sessionId,
    );
    hydrateHeaderSessionIndex(config);
    if (ambiguousHeaderSessionKeys.has(indexKey)) {
      throw new Error("ambiguous persisted session header");
    }
    let existingSid = headerSessionIndex.get(indexKey);
    let provisionalIdentity = false;
    let guardProject = false;
    let adoptionFingerprint: string | undefined;
    let expectedUnowned = false;
    if (!existingSid) {
      const provisional = getProvisionalHeaderEntry(indexKey);
      existingSid = provisional?.sessionID;
      provisionalIdentity = provisional !== null;
      guardProject =
        existingSid !== undefined &&
        provisionalMappingGuardsProject(indexKey, existingSid);
      adoptionFingerprint = provisional?.adoptionFingerprint;
      expectedUnowned = provisional?.expectedUnowned === true;
    }
    if (existingSid) {
      if (
        provisionalIdentity &&
        hasConflictingConfirmedHeader(req, existingSid, indexKey, config)
      ) {
        throw new Error("ambiguous session headers");
      }
      if (provisionalIdentity) {
        setProvisionalHeaderMapping(
          indexKey,
          existingSid,
          guardProject,
          adoptionFingerprint,
          expectedUnowned,
        );
      }
      // Session may only exist in DB (after gateway restart) — that's fine,
      // getOrCreateSession() will hydrate it from the session_state table.
      return {
        sessionID: existingSid,
        isNew: false,
        tier: 1,
        provisionalIdentity,
        ...(provisionalIdentity ? { provisionalKey: indexKey } : {}),
        ...(guardProject ? { guardProject: true } : {}),
        ...(adoptionFingerprint ? { adoptionFingerprint } : {}),
        ...(expectedUnowned ? { expectedUnowned: true } : {}),
      };
    }

    // --- Tier 1a: Cross-header migration ---
    // The primary known header is new (e.g. plugin upgrade started sending
    // x-lore-session-id), but the request also contains a lower-priority
    // known header that IS already indexed (e.g. x-session-affinity from
    // before the upgrade). Re-index under the new header and resume.
    let fallbackMatch: { sessionID: string; headerName: string } | undefined;
    for (const fallbackName of KNOWN_SESSION_HEADERS) {
      if (fallbackName === known.headerName) continue; // skip the primary
      const fallbackValue = headers[fallbackName];
      if (!fallbackValue) continue;
      const fallbackKey = sessionIndexKey(
        credentialFingerprint,
        fallbackName,
        fallbackValue,
      );
      const fallbackSid = headerSessionIndex.get(fallbackKey);
      if (fallbackSid) {
        if (fallbackMatch && fallbackMatch.sessionID !== fallbackSid) {
          throw new Error("ambiguous session headers");
        }
        fallbackMatch = { sessionID: fallbackSid, headerName: fallbackName };
      }
    }
    if (fallbackMatch) {
      const incomingProject =
        projectPathSource === "header" || projectPathSource === "inferred"
          ? projectPath
          : undefined;
      const existing = loadSessionTracking(fallbackMatch.sessionID);
      const conflictsWithConfidentProject =
        !!incomingProject &&
        !!existing?.projectPath &&
        existing.projectPathProvisional === false &&
        existing.projectPath !== incomingProject;
      if (!conflictsWithConfidentProject) {
        setProvisionalHeaderMapping(indexKey, fallbackMatch.sessionID, true);
        log.info(
          `session ${fallbackMatch.sessionID.slice(0, 16)}: provisional migration from ${fallbackMatch.headerName} to ${known.headerName}`,
        );
        return {
          sessionID: fallbackMatch.sessionID,
          isNew: false,
          tier: 1,
          provisionalIdentity: true,
          provisionalKey: indexKey,
          guardProject: true,
        };
      }
      log.warn(
        `session migration refused (${fallbackMatch.headerName}): incoming project ` +
          `${incomingProject} differs from session ${fallbackMatch.sessionID.slice(0, 16)} ` +
          `project ${existing.projectPath} - creating a new session instead of merging.`,
      );
    }

    // --- Tier 1 → 3b: overlap-proven restart adoption ---
    // A new known-header value is never continuity proof by itself. Before
    // minting a fresh session, adopt only when the persisted fingerprint and
    // project-scoped leading-user-message overlap prove that this is the same
    // conversation. Successful publication below still revokes an old value
    // for rotation-eligible headers such as x-session-affinity. (issue #796)
    const adopted = await adoptByFingerprint({
      req,
      headers,
      projectPath,
      gitRemote: trustedAdoptionRemote(projectPath, headers),
      known,
      msgCount: req.messages.length,
      requestGeneration,
      config,
      credentialFingerprint,
    });
    if (adopted) return adopted;

    // If a lower-priority confirmed identity existed but project validation
    // rejected the migration, keep this replacement provisional until success.
    // A completely new header can retain the normal eager session bootstrap.
    const sessionID = generateSessionID();
    if (fallbackMatch) {
      setProvisionalHeaderMapping(indexKey, sessionID);
      return {
        sessionID,
        isNew: true,
        tier: 1,
        provisionalIdentity: true,
        provisionalKey: indexKey,
      };
    }
    headerSessionIndex.set(indexKey, sessionID);
    saveSessionTracking(sessionID, {
      headerSessionId: known.sessionId,
      headerName: known.headerName,
      credentialFingerprint,
    });
    return { sessionID, isNew: true, tier: 1 };
  }

  // --- Tier 2: Learned headers ---
  // Resolve through the shared index so multiple headers identifying different
  // sessions fail closed instead of selecting insertion order.
  const indexedResolution = resolveIndexedSession(req, config, true);
  if (indexedResolution.kind === "ambiguous") {
    throw new Error("ambiguous session headers");
  }
  if (indexedResolution.kind === "match") {
    return {
      sessionID: indexedResolution.sessionID,
      isNew: false,
      tier: 2,
      provisionalIdentity: indexedResolution.provisional,
      provisionalKey: indexedResolution.provisionalKey,
    };
  }

  // --- Tier 2.5: Context markers (injected by Hermes plugin pre_llm_call) ---
  // The lore-hermes plugin injects [lore:session-id=<hex>] into the user
  // message context.  This is more reliable than fingerprint fallback (Tier 3)
  // but less authoritative than explicit headers (Tier 1).
  const markerSid = extractSessionMarker(req.messages);
  if (markerSid) {
    const markerKey = sessionIndexKey(
      credentialFingerprint,
      "context-marker",
      markerSid,
    );
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
  const fingerprint = await fingerprintMessages(
    rawMessages,
    usesRemoteSessionBinding(config)
      ? { tenantFingerprint: credentialFingerprint }
      : { authSuffix: cred ? authFingerprint(cred) : "" },
  );
  if (requestGeneration !== undefined) {
    assertCurrentPipelineGeneration(req.signal, requestGeneration);
  }
  const msgCount = req.messages.length;

  // Find the best matching session: same fingerprint + closest message count
  let bestMatch: { sid: string; countDiff: number } | null = null;
  let ambiguousBestMatch = false;

  if (cred) {
    for (const [sid, state] of sessions) {
      if (state.credentialFingerprint !== credentialFingerprint) continue;
      if (state.fingerprint !== fingerprint) continue;
      if (
        (projectPathSource === "header" || projectPathSource === "inferred") &&
        state.projectPathProvisional === false &&
        state.projectPath !== projectPath
      ) {
        continue;
      }

      const diff = msgCount - state.messageCount;

      // Normal session: count grows by 2–6 per turn.
      // Fork: count drops significantly (parent at 600, fork at 300).
      // Reject if the count dropped too far (likely a fork).
      if (diff < -MESSAGE_COUNT_PROXIMITY_THRESHOLD) continue;

      const absDiff = Math.abs(diff);
      if (!bestMatch || absDiff < bestMatch.countDiff) {
        bestMatch = { sid, countDiff: absDiff };
        ambiguousBestMatch = false;
      } else if (absDiff === bestMatch.countDiff) {
        ambiguousBestMatch = true;
      }
    }
  }
  if (ambiguousBestMatch) bestMatch = null;

  if (bestMatch) {
    // Run header learning on the matched session (Tier 2 bootstrap).
    const state = sessions.get(bestMatch.sid);
    if (state && !state.headerSessionId) {
      const candidateSnapshot = state.candidateHeaders
        ? new Map(
            Array.from(state.candidateHeaders, ([name, candidate]) => [
              name,
              { ...candidate },
            ]),
          )
        : undefined;
      const result = learnHeaders(candidateSnapshot, headers, {
        commitGlobal: false,
      });
      if (result.promoted) {
        // Preserve retry continuity in memory, but do not authorize the learned
        // header until a successful response confirms it in postResponse.
        const indexKey = sessionIndexKey(
          credentialFingerprint,
          result.promoted.name,
          result.promoted.value,
        );
        setProvisionalHeaderMapping(indexKey, bestMatch.sid);
        log.info(
          `session ${bestMatch.sid.slice(0, 16)}: provisional header promotion ${result.promoted.name}`,
        );
        return {
          sessionID: bestMatch.sid,
          isNew: false,
          tier: 3,
          provisionalIdentity: true,
          provisionalKey: indexKey,
        };
      }
    }
    return { sessionID: bestMatch.sid, isNew: false, tier: 3 };
  }

  // --- Tier 3b: DB-backed fingerprint adoption (restart-proof) ---
  // The in-memory scan above is empty after a restart, so it can never rematch
  // a resumed conversation. For a header-less client, recover + adopt the prior
  // session from its persisted fingerprint, confirmed by content overlap. (The
  // header-bearing case — e.g. opencode's x-lore-session-id — is handled in the
  // Tier 1 mint path above.) (issue #796)
  const adopted = await adoptByFingerprint({
    req,
    headers,
    projectPath,
    gitRemote: trustedAdoptionRemote(projectPath, headers),
    known: null,
    msgCount,
    requestGeneration,
    config,
    credentialFingerprint,
  });
  if (adopted) return adopted;

  // No matching session → create new.
  const sessionID = generateSessionID();
  return { sessionID, isNew: true, tier: 3 };
}

// ---------------------------------------------------------------------------
// Upstream forwarding
// ---------------------------------------------------------------------------

type EffectiveUpstreamProtocol = UpstreamSnapshot["protocol"];

type ResolvedRequestUpstreamRoute = {
  /** Explicit, sanitized X-Lore-Provider value (not inferred signals). */
  providerHeader?: string;
  /** Provider identity actually selected, including Copilot inference. */
  providerID?: string;
  headerUpstream?: string;
  headerUpstreamPath?: string;
  providerRoute: ReturnType<typeof resolveProviderRoute>;
  modelRoute: ReturnType<typeof resolveUpstreamRoute>;
  effectiveProtocol: EffectiveUpstreamProtocol;
  effectiveUpstreamBase: string;
  bedrockMantle: boolean;
};

/**
 * Preserve the legacy process-global credential only for a local, unambiguous
 * direct-provider request to the exact configured base. Remote/hosted gateways,
 * explicit provider selection, and client-selected URLs never populate it.
 */
function captureLegacyGlobalAuth(
  req: GatewayRequest,
  config: GatewayConfig,
  cred: AuthCredential,
): string | undefined {
  if (usesRemoteSessionBinding(config)) return undefined;
  if (
    req.rawHeaders["x-lore-provider"] ||
    req.rawHeaders["x-lore-upstream-url"]
  ) {
    return undefined;
  }
  const route = resolveRequestUpstreamRoute(req, config);
  const providerID =
    route.effectiveProtocol === "anthropic"
      ? "anthropic"
      : route.effectiveProtocol === "openai" ||
          route.effectiveProtocol === "openai-responses"
        ? "openai"
        : undefined;
  if (!providerID) return undefined;
  const configuredBase =
    providerID === "anthropic"
      ? config.upstreamAnthropic
      : config.upstreamOpenAI;
  const routeBase = normalizeUpstreamBase(route.effectiveUpstreamBase);
  const trustedBase = normalizeUpstreamBase(configuredBase);
  if (!routeBase || !trustedBase || routeBase !== trustedBase) {
    return undefined;
  }
  setLastSeenAuth(cred, providerID);
  return providerID;
}

/**
 * Single source of truth for foreground routing and its durable snapshot.
 * This is deliberately synchronous: dynamic models.dev lookup is cache-only,
 * so capture can run before any fetch/interceptor and failed requests still
 * retain the exact route intent used by forwardToUpstream.
 */
function resolveRequestUpstreamRoute(
  req: GatewayRequest,
  config: GatewayConfig,
): ResolvedRequestUpstreamRoute {
  const headerUpstream = extractUpstreamUrlHeader(req.rawHeaders);
  const headerUpstreamPath = extractUpstreamPathHeader(req.rawHeaders);
  const providerHeader = extractProviderHeader(req.rawHeaders);
  if (req.rawHeaders["x-lore-provider"] && !providerHeader) {
    throw new Error("Unsupported or invalid X-Lore-Provider");
  }
  if (req.rawHeaders["x-lore-upstream-url"] && !headerUpstream) {
    throw new Error("Invalid X-Lore-Upstream-URL");
  }
  if (headerUpstream && !isCallerUpstreamAllowed(config, headerUpstream)) {
    throw new Error(
      "X-Lore-Upstream-URL origin is not allowed by this remote gateway",
    );
  }
  let providerID = providerHeader;
  let providerRoute = providerID ? resolveProviderRoute(providerID) : null;
  if (!providerRoute && providerID) {
    // Explicit request routing is cache-only. An unknown untrusted provider
    // must fail closed without triggering side-channel network activity.
    providerRoute = lookupProviderRoute(providerID, false);
  }
  if (
    !providerRoute &&
    !headerUpstream &&
    hasCopilotIntegrationHeader(req.rawHeaders)
  ) {
    providerID = "github-copilot";
    providerRoute = resolveProviderRoute(providerID);
  }
  const modelRoute = resolveUpstreamRoute(req.model);
  const selfUrlBuildingProtocol =
    providerRoute?.bedrockMantle === true ||
    providerRoute?.protocol === "vertex";
  if (headerUpstream && !extractAuth(req.rawHeaders)) {
    throw new Error("An explicit upstream URL requires client authentication");
  }
  if (
    headerUpstream &&
    headerUpstreamPath &&
    !isUpstreamWithinBase(
      new URL(headerUpstreamPath, new URL(h…70030 tokens truncated…nal?.throwIfAborted();

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
    await promiseAgainstAbort(() => {
      const operation = distillation.run({
        llm,
        projectPath,
        sessionID,
        model,
        force: true,
        urgent: true,
        callType: "direct",
        signal: opts.signal,
        workerHealth: makeWorkerHealth(sessionID, "lore-distill"),
        // #627 Phase 1: stamp the session's gitHead on urgent-compaction rows.
        // Compaction is invoked via HTTP intercept or /v1/compact, so we look up
        // the session by ID rather than threading state through the call.
        metadata: buildSessionMetadata(sessions.get(sessionID)?.gitHead),
      });
      opts.trackOperation?.(operation);
      return operation;
    }, opts.signal);
  }

  // 2. Load distillation summaries + long-term knowledge.
  const distillations = distillation.loadForSession(projectPath, sessionID);
  const cfg = loreConfig();
  const entries = cfg.knowledge.enabled
    ? await promiseAgainstAbort(() => {
        const operation = ltm.forProjectOffloaded(
          projectPath,
          cfg.crossProject,
        );
        opts.trackOperation?.(operation);
        return operation;
      }, opts.signal)
    : [];
  opts.signal?.throwIfAborted();
  const knowledge = entries.length
    ? formatKnowledge(
        entries.map((e) => ({
          id: e.id,
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

async function handleCompactionInner(
  req: GatewayRequest,
  config: GatewayConfig,
  requestGeneration: number,
  trackOperation: (operation: Promise<unknown>) => void,
  claimSession: (sessionID: string) => Promise<void>,
): Promise<Response> {
  if (!req.rawHeaders["x-lore-project"]) {
    const markerProject = extractProjectMarker(req.messages);
    if (markerProject) req.rawHeaders["x-lore-project"] = markerProject;
  }
  const pathResult = getProjectPath(req.system, req.rawHeaders);
  const credential = extractAuth(req.rawHeaders);
  if (!credential) {
    return errorResponse(401, "A provider credential is required");
  }
  const sessionState = resolveAuthenticatedDirectSession(
    req,
    pathResult.path,
    config,
    false,
  );
  if (
    !sessionState ||
    (!sessionState.lastUpstream &&
      !streamingPostResponseFinalizers.has(sessionState.sessionID))
  ) {
    return errorResponse(404, "No authenticated session found");
  }
  if (
    sessionState.projectPathProvisional === true ||
    (pathResult.source !== "cwd" &&
      sessionState.projectPath !== pathResult.path)
  ) {
    return errorResponse(
      403,
      "Project path does not match the authenticated session",
    );
  }
  const sessionID = sessionState.sessionID;
  const authorizedProjectPath = sessionState.projectPath;
  await claimSession(sessionID);
  if (!confirmedIndexedIdentityResolvesTo(req, sessionID, config)) {
    return errorResponse(404, "No authenticated session found");
  }
  await awaitStreamingPostResponse(sessionID, req.signal);
  assertCurrentPipelineGeneration(req.signal, requestGeneration);
  if (!confirmedIndexedIdentityResolvesTo(req, sessionID, config)) {
    return errorResponse(404, "No authenticated session found");
  }
  if (!isConfidentlyBoundToProject(sessionState, authorizedProjectPath)) {
    return errorResponse(
      403,
      "Project path does not match the authenticated session",
    );
  }
  stripContextMarkers(req.messages);
  const projectPath = sessionState.projectPath;
  setSessionAuth(sessionID, credential, sessionState.lastUpstream?.providerID);
  // NOTE: the project binding is NOT persisted here — compaction never changes
  // the binding, and the preceding normal turn already persisted it. A restart
  // between the last normal turn and a compaction-only turn rehydrates the
  // binding from the prior save, which is always present (compaction requires
  // accumulated context that implies at least one normal turn happened first).

  // Initialize the project AFTER path correction so we never create a row for
  // the gateway's cwd / an unattributed bucket from a path-less probe request.
  await initIfNeeded(
    projectPath,
    config,
    pathResult.gitRemote,
    req.signal,
    requestGeneration,
  );
  assertCurrentPipelineGeneration(req.signal, requestGeneration);

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
    signal: req.signal,
    trackOperation,
  });
  trackOperation(summaryPromise);

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
      return translateAnthropicStreamToOpenAI(anthropicSSE, {
        signal: req.signal,
      });
    }
    if (req.protocol === "openai-responses") {
      return translateAnthropicStreamToResponses(anthropicSSE, {
        signal: req.signal,
      });
    }
    if (req.protocol === "gemini") {
      return translateAnthropicStreamToGemini(anthropicSSE, {
        signal: req.signal,
      });
    }
    return anthropicSSE;
  }

  // Non-streaming clients: await the summary and return JSON. Fall back to
  // upstream passthrough only when there is genuinely nothing to compact.
  const summary = await summaryPromise;
  if (summary == null) {
    log.warn(
      `compaction summary empty for session ${sessionID.slice(0, 16)} — using authenticated upstream`,
    );
    const trustedUpstream = extractUpstreamUrlHeader({
      "x-lore-upstream-url": sessionState.lastUpstream?.url ?? "",
    });
    if (!trustedUpstream) {
      return errorResponse(502, "No trusted upstream destination");
    }
    const fallbackHeaders = { ...req.rawHeaders };
    fallbackHeaders["x-lore-upstream-url"] = trustedUpstream;
    if (sessionState.lastUpstream?.providerID) {
      fallbackHeaders["x-lore-provider"] = sessionState.lastUpstream.providerID;
    } else {
      delete fallbackHeaders["x-lore-provider"];
    }
    return await handlePassthrough(
      { ...req, rawHeaders: fallbackHeaders },
      config,
    );
  }
  const resp = buildCompactionResponse(sessionID, summary, req.model);
  return nonStreamHttpResponse(
    resp,
    req.protocol,
    req.stream,
    undefined,
    requestEnablesLongContext(req),
  );
}

async function handleCompaction(
  req: GatewayRequest,
  config: GatewayConfig,
  requestGeneration: number,
  trackOperation: (operation: Promise<unknown>) => void,
  claimSession: (sessionID: string) => Promise<void>,
): Promise<Response> {
  const abortScope = createForegroundAbortScope(req.signal);
  try {
    const run = (signal: AbortSignal) => {
      if (
        pipelineResetInProgress ||
        requestGeneration !== streamingPostResponseGeneration
      ) {
        return Promise.resolve(
          errorResponse(503, "Gateway pipeline generation changed"),
        );
      }
      return handleCompactionInner(
        { ...req, signal },
        config,
        requestGeneration,
        trackOperation,
        claimSession,
      );
    };
    const response = await run(abortScope.signal);
    return wrapBodyWithCleanup(
      response,
      abortScope.dispose,
      abortScope.signal,
      (reason) =>
        abortScope.abort(
          reason ?? new DOMException("response cancelled", "AbortError"),
        ),
    );
  } catch (error) {
    abortScope.dispose();
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Case 1b: Explicit compaction endpoint (POST /v1/compact)
// ---------------------------------------------------------------------------

function directCompactionFailureResponse(
  route: string,
  error: unknown,
): Response {
  log.error(`${route} error:`, error);
  const unavailable =
    error instanceof StreamingPostResponseWaitCapacityError ||
    error instanceof PipelineCapacityError;
  const aborted =
    error instanceof DOMException &&
    (error.name === "AbortError" || error.name === "TimeoutError");
  return new Response(
    JSON.stringify({
      error: "compaction_failed",
      message: unavailable
        ? "Compaction temporarily unavailable"
        : "Compaction failed",
    }),
    {
      status: unavailable ? 503 : aborted ? 502 : 500,
      headers: { "content-type": "application/json" },
    },
  );
}

function preflightDirectCompactionSession(
  req: Request,
  config: GatewayConfig,
): Response | null {
  const rawHeaders: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    rawHeaders[key] = value;
  });
  if (hasConflictingAuthHeaders(rawHeaders)) {
    return errorResponse(
      400,
      "Conflicting authentication headers: send either x-api-key or Authorization, not both",
    );
  }
  if (!extractAuth(rawHeaders)) {
    return new Response(
      JSON.stringify({
        error: "unauthorized",
        message: "A provider credential is required",
      }),
      { status: 401, headers: { "content-type": "application/json" } },
    );
  }
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
  const sessionID = findIndexedKnownSessionID(minimalReq, config);
  if (!sessionID || (loadSessionTracking(sessionID)?.messageCount ?? 0) === 0) {
    return new Response(
      JSON.stringify({
        error: "session_not_found",
        message: "No authenticated session found for the given headers",
      }),
      { status: 404, headers: { "content-type": "application/json" } },
    );
  }
  return null;
}

function directRequestCredentialFingerprint(
  req: Request,
  config: GatewayConfig,
): string {
  const rawHeaders: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    rawHeaders[key] = value;
  });
  return requestCredentialFingerprint(rawHeaders, config) ?? "";
}

/**
 * Cancel-when-fits decision for the explicit `/v1/compact` endpoint.
 *
 * Returns:
 *   { cancel: true, reason: string, mustCompact: false }   — caller should
 *       cancel the host agent's compaction and keep the raw context
 *   { cancel: false, reason: string, mustCompact: true  }  — caller should
 *       proceed to generate a Lore-aware summary
 *   { cancel: false, reason: string, mustCompact: false }  — caller cannot
 *       decide (no upstream on session, or tokens_before is unknown /
 *       missing); default to the existing summary path
 *
 * Pure: no I/O, no state mutation. Easy to unit-test in isolation.
 *
 * The "budget" is `model.context - model.output` (per models.dev). The
 * reasoning is documented at the call site in `handleCompactEndpoint`.
 */
export type CompactCancelDecision =
  | { cancel: true; mustCompact: false; reason: string }
  | { cancel: false; mustCompact: true; reason: string }
  | { cancel: false; mustCompact: false; reason: string };

export function shouldCancelCompactionFromBudget(
  tokensBefore: number | undefined,
  upstream: { model?: string; providerID?: string } | undefined,
): CompactCancelDecision {
  // Caller didn't pass tokens_before → we can't decide; fall through to
  // the existing summary path (preserves the pre-#961 contract).
  if (typeof tokensBefore !== "number" || !Number.isFinite(tokensBefore)) {
    return {
      cancel: false,
      mustCompact: false,
      reason: "tokens_before is unknown (caller did not pass it)",
    };
  }
  // tokens_before <= 0 is treated as "unknown" — defensible because every
  // real session in flight has >0 tokens. Skipping the cancel path here
  // matches the existing 0-value behavior in the gradient layer.
  if (tokensBefore <= 0) {
    return {
      cancel: false,
      mustCompact: false,
      reason: `tokens_before=${tokensBefore} is non-positive; treating as unknown`,
    };
  }
  // No upstream on session → no model spec to compute the budget from.
  // Conservatively generate a summary rather than cancel.
  if (!upstream?.model) {
    return {
      cancel: false,
      mustCompact: false,
      reason: "no upstream model on session; cannot compute budget",
    };
  }
  const spec = getModelSpec(upstream.model, upstream.providerID);
  const effectiveBudget = spec.context - spec.output;
  if (tokensBefore <= effectiveBudget) {
    return {
      cancel: true,
      mustCompact: false,
      reason: `tokensBefore=${tokensBefore} <= budget=${effectiveBudget} (model=${spec.context} − output=${spec.output}); host should keep raw context`,
    };
  }
  return {
    cancel: false,
    mustCompact: true,
    reason: `tokensBefore=${tokensBefore} > budget=${effectiveBudget} (model=${spec.context} − output=${spec.output}); must compact`,
  };
}

/**
 * Handle an explicit compaction summary request from a plugin (e.g. Pi).
 * Unlike `handleCompaction` which detects compaction from request patterns,
 * this endpoint accepts a direct JSON body with project path and optional
 * previous summary.
 *
 * The caller must include a session-identifying header (e.g. x-lore-session-id)
 * so the gateway can resolve the correct internal session.
 *
 * Body schema:
 *   project_path:     string   (required) — absolute project root
 *   previous_summary: string?  (optional) — last summary, for iterative update
 *   tokens_before:    number?  (optional) — caller's estimate of the session's
 *                     current pre-compaction token count. When provided, the
 *                     gateway compares it against the resolved model's
 *                     `context - output` budget; if it fits, the gateway
 *                     returns `{ cancel: true }` and does NOT generate a
 *                     summary. The caller (e.g. Pi) is expected to relay this
 *                     to the host's `session_before_compact` hook as
 *                     `{ cancel: true }`, which prevents the host from
 *                     compacting at all and keeps the raw context end-to-end.
 *                     This is the on-Pi analog of OpenCode's
 *                     `cfg.compaction = { auto: false, prune: false }` — the
 *                     gateway manages the window, not the host agent.
 */
async function handleCompactEndpointInner(
  req: Request,
  config: GatewayConfig,
  signal: AbortSignal,
  requestGeneration: number,
  trackOperation: (operation: Promise<unknown>) => void,
  claimSession: (sessionID: string) => Promise<void>,
  rawHeaders: Record<string, string>,
): Promise<Response> {
  if (hasConflictingAuthHeaders(rawHeaders)) {
    return new Response(
      JSON.stringify({
        error: "invalid_request",
        message:
          "Conflicting authentication headers: send either x-api-key or Authorization, not both",
      }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }
  // Authenticate from headers before touching a potentially unbounded or
  // stalled upload. This endpoint always requires a provider credential.
  const credential = extractAuth(rawHeaders);
  if (!credential) {
    return new Response(
      JSON.stringify({
        error: "unauthorized",
        message: "A provider credential is required",
      }),
      { status: 401, headers: { "content-type": "application/json" } },
    );
  }

  let body: {
    project_path?: string;
    previous_summary?: string;
    tokens_before?: number;
  };
  try {
    // Decode any Content-Encoding (e.g. zstd) before JSON-parsing.
    body = JSON.parse(await decodeRequestBody(req, signal)) as typeof body;
  } catch {
    signal.throwIfAborted();
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
  const gitRemote = extractGitRemoteHeader(rawHeaders);

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
    signal,
  };

  const state = resolveAuthenticatedDirectSession(
    minimalReq,
    projectPath,
    config,
  );
  if (!state) {
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

  if (!isConfidentlyBoundToProject(state, projectPath)) {
    return new Response(
      JSON.stringify({
        error: "project_mismatch",
        message: "project_path does not match the authenticated session",
      }),
      { status: 403, headers: { "content-type": "application/json" } },
    );
  }
  const sessionID = state.sessionID;
  await claimSession(sessionID);
  if (!confirmedIndexedIdentityResolvesTo(minimalReq, sessionID, config)) {
    return new Response(
      JSON.stringify({
        error: "session_not_found",
        message: "No authenticated session found for the given headers",
      }),
      { status: 404, headers: { "content-type": "application/json" } },
    );
  }
  await awaitStreamingPostResponse(sessionID, signal);
  assertCurrentPipelineGeneration(signal, requestGeneration);
  if (!confirmedIndexedIdentityResolvesTo(minimalReq, sessionID, config)) {
    return new Response(
      JSON.stringify({
        error: "session_not_found",
        message: "No authenticated session found for the given headers",
      }),
      { status: 404, headers: { "content-type": "application/json" } },
    );
  }
  if (
    state.projectPathProvisional === true ||
    state.projectPath !== projectPath
  ) {
    return new Response(
      JSON.stringify({
        error: "project_mismatch",
        message: "project_path does not match the authenticated session",
      }),
      { status: 403, headers: { "content-type": "application/json" } },
    );
  }
  setSessionAuth(sessionID, credential, state.lastUpstream?.providerID);

  await initIfNeeded(
    state.projectPath,
    config,
    gitRemote,
    signal,
    requestGeneration,
  );
  assertCurrentPipelineGeneration(signal, requestGeneration);

  // Cancel-when-fits policy. The gateway is the authoritative source for
  // "does this session's raw context fit in the layer-0 budget?" — the plugin
  // just relays. We resolve the session's lastUpstream to a real ModelSpec
  // (per models.dev context/output limits) and compare tokensBefore to
  // (context - output). If the caller's claim of "the session fits" is
  // genuine, return { cancel: true } and skip the summary work entirely.
  //
  // Above-budget sessions still get the existing summary path. Below-budget
  // sessions are canceled — the host agent keeps the raw context, and Lore
  // continues to manage the window via distillation + recall on subsequent
  // turns.
  //
  // This intentionally does NOT consult maxLayer0Tokens (the per-model cost
  // cap from setModelLimits). That value is per-request and is not stored
  // across turns, so reading it from the gradient module here would be
  // racy/zero. The natural cancel threshold IS the model's real context
  // window minus output reserve — anything that fits there is safe to
  // keep raw; anything above it must be summarized (or the next LLM call
  // will overflow). If we later want a tighter per-session cap, it's a
  // single constant in one place to change.
  const cancelDecision = shouldCancelCompactionFromBudget(
    body.tokens_before,
    state?.lastUpstream,
  );
  if (cancelDecision.cancel) {
    log.info(`compact endpoint: cancel — ${cancelDecision.reason}`);
    return new Response(JSON.stringify({ cancel: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (cancelDecision.mustCompact) {
    log.info(`compact endpoint: must compact — ${cancelDecision.reason}`);
  }

  log.info(
    `compact endpoint: generating summary for session ${sessionID.slice(0, 16)}`,
  );

  try {
    const summary = await generateCompactionSummary({
      projectPath,
      sessionID,
      config,
      previousSummary:
        typeof body.previous_summary === "string"
          ? body.previous_summary
          : undefined,
      sessionUpstream: state?.lastUpstream,
      signal,
      trackOperation,
    });
    assertCurrentPipelineGeneration(signal, requestGeneration);

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
    log.error("compact endpoint error:", err);
    return new Response(
      JSON.stringify({
        error: "compaction_failed",
        message: "Compaction failed",
      }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }
}

export async function handleCompactEndpoint(
  req: Request,
  config: GatewayConfig,
): Promise<Response> {
  const rawHeaders = requestHeaders(req.headers);
  return withRequestStorageTenant(rawHeaders, config, async () => {
    if (pipelineResetInProgress) {
      return errorResponse(503, "Gateway pipeline is resetting");
    }
    const preflight = preflightDirectCompactionSession(req, config);
    if (preflight) return preflight;
    streamingPostResponsesAccepting = true;
    const requestGeneration = streamingPostResponseGeneration;
    const abortScope = createForegroundAbortScope(req.signal);
    try {
      const response = await runActivePipelineRequest(
        abortScope.signal,
        (signal, trackOperation, claimSession) =>
          handleCompactEndpointInner(
            req,
            config,
            signal,
            requestGeneration,
            trackOperation,
            claimSession,
            rawHeaders,
          ),
        undefined,
        undefined,
        directRequestCredentialFingerprint(req, config),
      );
      return wrapBodyWithCleanup(
        response,
        abortScope.dispose,
        abortScope.signal,
      );
    } catch (error) {
      abortScope.dispose();
      return directCompactionFailureResponse("compact endpoint", error);
    }
  });
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
async function handleResponsesCompactEndpointInner(
  req: Request,
  config: GatewayConfig,
  signal: AbortSignal,
  requestGeneration: number,
  trackOperation: (operation: Promise<unknown>) => void,
  claimSession: (sessionID: string) => Promise<void>,
  rawHeaders: Record<string, string>,
): Promise<Response> {
  if (hasConflictingAuthHeaders(rawHeaders)) {
    return new Response(
      JSON.stringify({
        error: "invalid_request",
        message:
          "Conflicting authentication headers: send either x-api-key or Authorization, not both",
      }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }
  const credential = extractAuth(rawHeaders);
  if (!credential) {
    return new Response(
      JSON.stringify({
        error: "unauthorized",
        message: "A provider credential is required",
      }),
      { status: 401, headers: { "content-type": "application/json" } },
    );
  }
  // Read the body as text so we can both parse it and replay it for passthrough.
  // Decode any Content-Encoding (Codex sends zstd by default) first — otherwise
  // the raw compressed bytes fail to JSON.parse and the passthrough replays
  // undecodable bytes upstream.
  let bodyText: string;
  try {
    bodyText = await decodeRequestBody(req, signal);
  } catch {
    signal.throwIfAborted();
    return new Response(
      JSON.stringify({
        error: "invalid_request",
        message: "Invalid JSON body",
      }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }
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

  // Parse the body as a Responses API request to get messages for session
  // fingerprinting. The compact request body has the same shape as a normal
  // /v1/responses request (model, instructions, input, tools, etc.).
  let gatewayReq: GatewayRequest;
  try {
    gatewayReq = parseOpenAIResponsesRequest(body, rawHeaders);
    gatewayReq.signal = signal;
  } catch {
    return new Response(
      JSON.stringify({
        error: "invalid_request",
        message: "Invalid Responses compaction body",
      }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  const pathResult = getProjectPath(gatewayReq.system, rawHeaders);
  const gitRemote = extractGitRemoteHeader(rawHeaders);
  const state = resolveAuthenticatedDirectSession(
    gatewayReq,
    pathResult.path,
    config,
  );
  if (!state) {
    if (!extractKnownSessionHeader(rawHeaders)) {
      return await passthroughResponsesCompact(
        bodyText,
        rawHeaders,
        config,
        signal,
        undefined,
        gatewayReq,
      );
    }
    return new Response(
      JSON.stringify({
        error: "session_not_found",
        message: "No authenticated session found for the given headers",
      }),
      { status: 404, headers: { "content-type": "application/json" } },
    );
  }
  if (!isConfidentlyBoundToProject(state, pathResult.path)) {
    return new Response(
      JSON.stringify({
        error: "project_mismatch",
        message: "project path does not match the authenticated session",
      }),
      { status: 403, headers: { "content-type": "application/json" } },
    );
  }
  const sessionID = state.sessionID;
  await claimSession(sessionID);
  if (!confirmedIndexedIdentityResolvesTo(gatewayReq, sessionID, config)) {
    return new Response(
      JSON.stringify({
        error: "session_not_found",
        message: "No authenticated session found for the given headers",
      }),
      { status: 404, headers: { "content-type": "application/json" } },
    );
  }
  await awaitStreamingPostResponse(sessionID, signal);
  assertCurrentPipelineGeneration(signal, requestGeneration);
  if (!confirmedIndexedIdentityResolvesTo(gatewayReq, sessionID, config)) {
    return new Response(
      JSON.stringify({
        error: "session_not_found",
        message: "No authenticated session found for the given headers",
      }),
      { status: 404, headers: { "content-type": "application/json" } },
    );
  }
  if (
    state.projectPathProvisional === true ||
    state.projectPath !== pathResult.path
  ) {
    return new Response(
      JSON.stringify({
        error: "project_mismatch",
        message: "project path does not match the authenticated session",
      }),
      { status: 403, headers: { "content-type": "application/json" } },
    );
  }
  setSessionAuth(sessionID, credential, state.lastUpstream?.providerID);

  await initIfNeeded(
    state.projectPath,
    config,
    gitRemote,
    signal,
    requestGeneration,
  );
  assertCurrentPipelineGeneration(signal, requestGeneration);

  log.info(
    `responses/compact: generating Lore summary for session ${sessionID.slice(0, 16)}`,
  );

  try {
    const summary = await generateCompactionSummary({
      projectPath: state.projectPath,
      sessionID,
      config,
      sessionUpstream: state.lastUpstream,
      signal,
      trackOperation,
    });
    assertCurrentPipelineGeneration(signal, requestGeneration);

    if (summary != null) {
      state.cacheAnalytics.lastRequestBody = null;

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
    signal.throwIfAborted();
    log.warn(
      "responses/compact: Lore compaction error, falling back to upstream:",
      err,
    );
  }

  // Fallback only to the destination previously authenticated by a normal turn.
  return await passthroughResponsesCompact(
    bodyText,
    rawHeaders,
    config,
    signal,
    state.lastUpstream?.url || null,
    gatewayReq,
  );
}

export async function handleResponsesCompactEndpoint(
  req: Request,
  config: GatewayConfig,
): Promise<Response> {
  const rawHeaders = requestHeaders(req.headers);
  return withRequestStorageTenant(rawHeaders, config, async () => {
    if (pipelineResetInProgress) {
      return errorResponse(503, "Gateway pipeline is resetting");
    }
    streamingPostResponsesAccepting = true;
    const requestGeneration = streamingPostResponseGeneration;
    const abortScope = createForegroundAbortScope(req.signal);
    try {
      const response = await runActivePipelineRequest(
        abortScope.signal,
        (signal, trackOperation, claimSession) =>
          handleResponsesCompactEndpointInner(
            req,
            config,
            signal,
            requestGeneration,
            trackOperation,
            claimSession,
            rawHeaders,
          ),
        undefined,
        undefined,
        directRequestCredentialFingerprint(req, config),
      );
      return wrapBodyWithCleanup(
        response,
        abortScope.dispose,
        abortScope.signal,
      );
    } catch (error) {
      abortScope.dispose();
      return directCompactionFailureResponse(
        "responses/compact endpoint",
        error,
      );
    }
  });
}

/**
 * Forward a compaction request to the upstream OpenAI API as-is.
 */
export async function passthroughResponsesCompact(
  bodyText: string,
  rawHeaders: Record<string, string>,
  config: GatewayConfig,
  callerSignal?: AbortSignal,
  trustedUpstreamBase?: string | null,
  parsedRequest?: GatewayRequest,
): Promise<Response> {
  const abortScope = createForegroundAbortScope(callerSignal);
  if (hasConflictingAuthHeaders(rawHeaders)) {
    abortScope.dispose();
    return errorResponse(
      400,
      "Conflicting authentication headers: send either x-api-key or Authorization, not both",
    );
  }

  // Resolve with the same provider/header/model priority chain as a normal
  // Responses request. If parsing failed, an explicit validated URL override is
  // the only safe custom route; an explicit provider without a compatible URL
  // fails closed because model routing is unavailable.
  const trustedUpstream =
    trustedUpstreamBase === undefined
      ? undefined
      : trustedUpstreamBase
        ? extractUpstreamUrlHeader({
            "x-lore-upstream-url": trustedUpstreamBase,
          })
        : undefined;
  if (trustedUpstreamBase !== undefined && !trustedUpstream) {
    abortScope.dispose();
    return new Response(
      JSON.stringify({
        error: "compaction_failed",
        message: "No trusted upstream destination",
      }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }
  const headerUpstream =
    trustedUpstreamBase === undefined
      ? extractUpstreamUrlHeader(rawHeaders)
      : undefined;
  if (headerUpstream && !extractAuth(rawHeaders)) {
    abortScope.dispose();
    return new Response(
      JSON.stringify({
        error: "compaction_routing_failed",
        message: "An explicit upstream URL requires client authentication",
      }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }
  let route: ResolvedRequestUpstreamRoute | undefined;
  if (parsedRequest && trustedUpstreamBase === undefined) {
    try {
      route = resolveRequestUpstreamRoute(parsedRequest, config);
    } catch (error) {
      abortScope.dispose();
      return new Response(
        JSON.stringify({
          error: "compaction_routing_failed",
          message:
            error instanceof Error ? error.message : "Invalid compact route",
        }),
        { status: 502, headers: { "content-type": "application/json" } },
      );
    }
  }
  const fallbackProviderID = route
    ? route.providerID
    : extractProviderHeader(rawHeaders);
  if (
    trustedUpstreamBase === undefined &&
    rawHeaders["x-lore-provider"] &&
    !fallbackProviderID
  ) {
    abortScope.dispose();
    return new Response(
      JSON.stringify({
        error: "compaction_routing_failed",
        message: "Unsupported or invalid X-Lore-Provider",
      }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }
  if (
    trustedUpstreamBase === undefined &&
    rawHeaders["x-lore-upstream-url"] &&
    !headerUpstream
  ) {
    abortScope.dispose();
    return new Response(
      JSON.stringify({
        error: "compaction_routing_failed",
        message: "Invalid X-Lore-Upstream-URL",
      }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }
  if (headerUpstream && !isCallerUpstreamAllowed(config, headerUpstream)) {
    abortScope.dispose();
    return new Response(
      JSON.stringify({
        error: "compaction_routing_failed",
        message:
          "X-Lore-Upstream-URL origin is not allowed by this remote gateway",
      }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }
  const fallbackProviderRoute =
    !route && fallbackProviderID
      ? (resolveProviderRoute(fallbackProviderID) ??
        lookupProviderRoute(fallbackProviderID, false))
      : null;
  if (
    route?.providerID &&
    !route.headerUpstream &&
    (!route.providerRoute?.url ||
      (route.providerRoute.protocol !== null &&
        route.providerRoute.protocol !== "openai-responses"))
  ) {
    abortScope.dispose();
    return new Response(
      JSON.stringify({
        error: "compaction_routing_failed",
        message: `Cannot safely resolve a Responses compact endpoint for provider "${route.providerID}"`,
      }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }
  if (
    !route &&
    fallbackProviderID &&
    !headerUpstream &&
    (!fallbackProviderRoute?.url ||
      (fallbackProviderRoute.protocol !== null &&
        fallbackProviderRoute.protocol !== "openai-responses"))
  ) {
    abortScope.dispose();
    return new Response(
      JSON.stringify({
        error: "compaction_routing_failed",
        message: `Cannot safely resolve a Responses compact endpoint for provider "${fallbackProviderID}"`,
      }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }
  const effectiveUpstreamBase =
    trustedUpstream ??
    route?.effectiveUpstreamBase ??
    headerUpstream ??
    fallbackProviderRoute?.url ??
    config.upstreamOpenAI;
  const effectiveProtocol = trustedUpstream
    ? "openai-responses"
    : (route?.effectiveProtocol ??
      fallbackProviderRoute?.protocol ??
      "openai-responses");
  if (effectiveProtocol !== "openai-responses") {
    abortScope.dispose();
    return new Response(
      JSON.stringify({
        error: "compaction_routing_failed",
        message:
          "The resolved upstream does not support the OpenAI Responses compact protocol",
      }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }
  const upstreamPath = extractUpstreamPathHeader(rawHeaders);
  const compactPath = upstreamPath?.endsWith("/responses/compact")
    ? upstreamPath
    : undefined;
  const upstreamUrl = compactPath
    ? new URL(compactPath, `${effectiveUpstreamBase.replace(/\/+$/, "")}/`).href
    : fallbackProviderID === "openai-codex"
      ? `${effectiveUpstreamBase}/codex/responses/compact`
      : `${effectiveUpstreamBase}/v1/responses/compact`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };

  // Preserve the one centrally-approved provider-auth scheme exactly.
  Object.assign(headers, copyProviderAuthHeaders(rawHeaders));

  // Forward OpenAI-specific headers
  const openAiBeta = rawHeaders["openai-beta"];
  if (openAiBeta) headers["openai-beta"] = openAiBeta;

  // Re-compress with the client's original Content-Encoding (Codex sends zstd):
  // `bodyText` was decoded on ingress, so replay it in the same wire encoding.
  // This is a native passthrough — `/v1/responses/compact` in, the same OpenAI
  // endpoint out, no gateway protocol translation — so it routes through the
  // same `encodeUpstreamBodyForRoute` chokepoint (equal protocols => trusted)
  // rather than the raw encoder, keeping that the single re-encode path (#1032).
  const { body: passthroughBody, contentEncoding } = encodeUpstreamBodyForRoute(
    bodyText,
    rawHeaders["content-encoding"],
    buildUpstreamRouteContext({
      upstreamUrlHeader: headerUpstream,
      providerHeader: fallbackProviderID,
      ingressProtocol: "openai-responses",
      effectiveProtocol,
      ingressUpstreamBase: config.upstreamOpenAI,
      effectiveUpstreamBase,
    }),
  );
  if (contentEncoding) headers["content-encoding"] = contentEncoding;

  // Apply user-supplied LORE_UPSTREAM_EXTRA_HEADERS as a final overlay so
  // corporate proxies / LiteLLM team-routing tokens / Cloudflare AI Gateway
  // / service-account scenarios work for compaction-passthrough calls too.
  applyUpstreamExtraHeaders(
    headers,
    extraHeadersForUpstream(config, upstreamUrl),
  );

  try {
    const upstream = await responseAgainstAbort(
      () =>
        upstreamFetch(upstreamUrl, {
          method: "POST",
          headers,
          body: passthroughBody,
          signal: abortScope.signal,
        }),
      abortScope.signal,
    );
    return wrapBodyWithCleanup(upstream, abortScope.dispose, abortScope.signal);
  } catch (err) {
    abortScope.dispose();
    log.error("responses/compact upstream passthrough error:", err);
    return new Response(
      JSON.stringify({
        error: "compaction_failed",
        message: "Failed to reach upstream",
      }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }
}

// ---------------------------------------------------------------------------
// Case 2: Meta request passthrough (title gen, summaries, categorization, etc.)
// ---------------------------------------------------------------------------

const FOREGROUND_REQUEST_TIMEOUT_MS = 300_000;

export function abortAwareDelay(
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();
  signal?.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => signal?.removeEventListener("abort", onAbort);
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      operation();
    };
    const onAbort = (): void => finish(() => reject(signal?.reason));
    const timer = setTimeout(() => finish(resolve), delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export async function completeBudgetThrottleDelay(
  delayMs: number,
  signal: AbortSignal | undefined,
  record: () => void,
): Promise<void> {
  await abortAwareDelay(delayMs, signal);
  signal?.throwIfAborted();
  record();
}

export function createForegroundAbortScope(caller?: AbortSignal): {
  signal: AbortSignal;
  abort: (reason?: unknown) => void;
  dispose: () => void;
  deadlineAt: number;
} {
  const controller = new AbortController();
  activeForegroundAbortControllers.add(controller);
  const abort = (reason?: unknown) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  const onCallerAbort = () => abort(caller?.reason);
  caller?.addEventListener("abort", onCallerAbort, { once: true });
  if (caller?.aborted) onCallerAbort();
  const deadlineAt = Date.now() + FOREGROUND_REQUEST_TIMEOUT_MS;
  const timer = setTimeout(
    () =>
      abort(new DOMException("foreground request timed out", "TimeoutError")),
    FOREGROUND_REQUEST_TIMEOUT_MS,
  );
  return {
    signal: controller.signal,
    abort,
    deadlineAt,
    dispose: () => {
      activeForegroundAbortControllers.delete(controller);
      clearTimeout(timer);
      caller?.removeEventListener("abort", onCallerAbort);
    },
  };
}

export function wrapBodyWithCleanup(
  response: Response,
  cleanup: () => void,
  signal?: AbortSignal,
  onCancel?: (reason?: unknown) => void,
): Response {
  if (!response.body) {
    cleanup();
    return response;
  }
  const reader = response.body.getReader();
  let finished = false;
  let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const onAbort = (): void => {
    if (finished) return;
    const reason = signal?.reason;
    finish();
    cancelAndReleaseReader(reader, reason);
    try {
      bodyController?.error(reason);
    } catch {
      // Already closed/cancelled.
    }
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    signal?.removeEventListener("abort", onAbort);
    cleanup();
  };
  const body = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        bodyController = controller;
      },
      async pull(controller) {
        try {
          const { done, value } = signal
            ? await readStreamChunk(reader, { signal })
            : await reader.read();
          if (done) {
            finish();
            try {
              reader.releaseLock();
            } catch {
              // The stream completed with no pending read in normal runtimes.
            }
            controller.close();
          } else if (value) {
            controller.enqueue(value);
          }
        } catch (error) {
          finish();
          cancelAndReleaseReader(reader, error);
          controller.error(error);
        }
      },
      cancel(reason) {
        onCancel?.(reason);
        finish();
        cancelAndReleaseReader(reader, reason);
      },
    },
    // Do not read ahead while a terminal-aware downstream parser is handling
    // the current chunk. It may cancel at that terminal while the transport
    // remains open, and a speculative read can otherwise strand the wrapper.
    { highWaterMark: 0 },
  );
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function claimPipelineSession(
  active: ActivePipelineRequest,
  sessionID: string,
  signal: AbortSignal,
): Promise<void> {
  if (active.sessionIDs.has(sessionID)) return;
  signal.throwIfAborted();
  if (pipelineSessionHasCapacity(sessionID)) {
    active.sessionIDs.add(sessionID);
    return;
  }
  if (
    pendingSessionClaims.has(sessionID) ||
    pendingSessionClaims.size >= MAX_PENDING_SESSION_CLAIMS ||
    pendingSessionClaimsForAdmissionKey(active.admissionKey) >=
      MAX_ACTIVE_PIPELINE_REQUESTS_PER_ADMISSION_KEY
  ) {
    throw new PipelineCapacityError("session request queue full");
  }

  activePipelineRequests.delete(active);
  return new Promise<void>((resolve, reject) => {
    let claim: PendingSessionClaim;
    const onAbort = () => {
      if (pendingSessionClaims.get(sessionID) !== claim) return;
      pendingSessionClaims.delete(sessionID);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
      pumpPendingSessionClaims();
    };
    claim = { active, sessionID, signal, resolve, reject, onAbort };
    pendingSessionClaims.set(sessionID, claim);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    else pumpPendingSessionClaims();
  });
}

async function runActivePipelineRequest(
  callerSignal: AbortSignal | undefined,
  operation: (
    signal: AbortSignal,
    trackOperation: (operation: Promise<unknown>) => void,
    claimSession: (sessionID: string) => Promise<void>,
  ) => Promise<Response>,
  onResponseBodySettled?: () => void,
  onResponseBodyCancelled?: () => void,
  admissionKey = "",
): Promise<Response> {
  if (
    detachedPipelineRequests.size +
      activePipelineRequests.size +
      pendingSessionClaims.size >=
      maxDetachedPipelineRequests ||
    activePipelineRequests.size + streamingPostResponsePending >=
      maxActivePipelineRequests ||
    activePipelineRequestsForAdmissionKey(admissionKey) +
      (streamingPostResponsePendingByAdmissionKey.get(admissionKey) ?? 0) >=
      MAX_ACTIVE_PIPELINE_REQUESTS_PER_ADMISSION_KEY
  ) {
    return errorResponse(503, "Gateway is busy");
  }
  const lifecycle = new AbortController();
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, lifecycle.signal])
    : lifecycle.signal;
  let settle: (() => void) | undefined;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const pendingOperations = new Set<Promise<void>>();
  let finished = false;
  let bodySettled = false;
  let responseReturned = false;
  let responseCancelled = false;
  const markResponseCancelled = (): void => {
    if (responseCancelled) return;
    responseCancelled = true;
    onResponseBodyCancelled?.();
  };
  function onAbort(): void {
    if (responseReturned) {
      if (callerSignal?.aborted) markResponseCancelled();
      settleResponse();
    }
  }
  const trackOperation = (operation: Promise<unknown>): void => {
    const tracked = operation.then(
      () => {},
      () => {},
    );
    pendingOperations.add(tracked);
    void tracked.finally(() => pendingOperations.delete(tracked));
  };
  async function finish(): Promise<void> {
    if (finished) return;
    finished = true;
    signal.removeEventListener("abort", onAbort);
    while (pendingOperations.size > 0) {
      await Promise.all(pendingOperations);
    }
    activePipelineRequests.delete(active);
    detachedPipelineRequests.delete(active);
    pumpPendingSessionClaims();
    settle?.();
  }
  function settleResponse(): void {
    if (bodySettled) return;
    bodySettled = true;
    onResponseBodySettled?.();
    void finish();
  }
  const active: ActivePipelineRequest = {
    admissionKey,
    abort: (reason) => {
      lifecycle.abort(reason);
      if (responseReturned) settleResponse();
    },
    settled,
    sessionIDs: new Set(),
  };
  activePipelineRequests.add(active);
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    const response = await operation(signal, trackOperation, (sessionID) =>
      claimPipelineSession(active, sessionID, signal),
    );
    responseReturned = true;
    if (signal.aborted) {
      if (callerSignal?.aborted) markResponseCancelled();
      settleResponse();
    }
    return wrapBodyWithCleanup(response, settleResponse, undefined, () => {
      markResponseCancelled();
      settleResponse();
    });
  } catch (error) {
    onResponseBodySettled?.();
    void finish();
    throw error;
  }
}

export function validatedMetaStream(
  response: Response,
  protocol: "anthropic" | "openai" | "openai-responses" | "gemini",
  codex: boolean,
  signal?: AbortSignal,
): Response {
  if (protocol === "openai-responses") {
    return streamResponsesPassthrough(
      response,
      () => {},
      undefined,
      codex ? "codex" : "public",
      signal,
    );
  }
  const abort = new AbortController();
  let downstreamCancelled = false;
  let externalAborted = false;
  let pumpStarted = false;
  let resumeDemand: (() => void) | undefined;
  const cleanup = (): void => {
    signal?.removeEventListener("abort", onAbort);
  };
  const onAbort = () => {
    externalAborted = true;
    resumeDemand?.();
    resumeDemand = undefined;
    abort.abort(signal?.reason);
    if (!pumpStarted)
      void response.body?.cancel(signal?.reason).catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let settled = false;
      const waitForDemand = async (): Promise<void> => {
        while (
          !downstreamCancelled &&
          !externalAborted &&
          (controller.desiredSize ?? 1) <= 0
        ) {
          await new Promise<void>((resolve) => {
            resumeDemand = resolve;
          });
        }
        if (externalAborted) throw signal?.reason;
      };
      const forward = async (event: string, data: string): Promise<void> => {
        await waitForDemand();
        const wire =
          event === "message"
            ? `data: ${data}\n\n`
            : formatSSEEvent(event, data);
        controller.enqueue(encoder.encode(wire));
      };
      const safeClose = (): void => {
        if (downstreamCancelled || settled) return;
        settled = true;
        cleanup();
        try {
          controller.close();
        } catch {
          // Already closed/cancelled.
        }
      };
      const safeError = (error: unknown): void => {
        if (downstreamCancelled || settled) return;
        settled = true;
        cleanup();
        try {
          controller.error(error);
        } catch {
          // Already closed/cancelled.
        }
      };
      const pump = async (): Promise<void> => {
        pumpStarted = true;
        if (downstreamCancelled) return;
        try {
          if (protocol === "anthropic") {
            if (!response.body)
              throw new Error("Upstream response has no body");
            const reader = response.body.getReader();
            const validator = new AnthropicSSEValidator();
            try {
              for await (const { event, data } of parseSSEStream(reader, {
                signal: abort.signal,
                requireEventTerminator: true,
                fatalUtf8: true,
                maxFrames: DEFAULT_MAX_SSE_FRAMES,
                maxTotalBytes: MAX_FOREGROUND_RESPONSE_BYTES,
              })) {
                validator.process(event, data);
                await forward(event, data);
                if (validator.isDone()) break;
              }
              validator.assertDone();
            } finally {
              cancelAndReleaseReader(reader);
            }
          } else if (protocol === "openai") {
            await accumulateOpenAISSEStream(response, {
              signal: abort.signal,
              strict: true,
              stopAtTerminal: true,
              consumeUntilDone: true,
              onValidatedEvent: forward,
            });
          } else {
            await accumulateGeminiSSEStream(response, {
              signal: abort.signal,
              strict: true,
              stopAtTerminal: true,
              onValidatedEvent: forward,
            });
          }
          safeClose();
        } catch (error) {
          if (downstreamCancelled) {
            cleanup();
            return;
          }
          safeError(externalAborted ? (signal?.reason ?? error) : error);
        }
      };
      queueMicrotask(() => void pump().catch((error) => safeError(error)));
    },
    pull() {
      resumeDemand?.();
      resumeDemand = undefined;
    },
    cancel(reason) {
      resumeDemand?.();
      resumeDemand = undefined;
      downstreamCancelled = true;
      abort.abort(new DOMException("client disconnected", "AbortError"));
      cleanup();
      if (!pumpStarted) void response.body?.cancel(reason).catch(() => {});
    },
  });
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function handlePassthrough(
  req: GatewayRequest,
  config: GatewayConfig,
): Promise<Response> {
  setSentryLightContext({ model: req.model });

  const abortScope = createForegroundAbortScope(req.signal);
  let forwarded: UpstreamResult;
  try {
    forwarded = await forwardToUpstream(
      req,
      config,
      undefined,
      undefined,
      abortScope.signal,
    );
  } catch (error) {
    abortScope.dispose();
    throw error;
  }
  const effectiveProtocol = forwarded.effectiveProtocol;
  const upstreamResponse = wrapBodyWithCleanup(
    forwarded.response,
    abortScope.dispose,
    abortScope.signal,
  );

  const withLimits = (response: Response): Response => {
    copyUsageLimitHeaders(upstreamResponse.headers, response.headers);
    return response;
  };

  // Meta/side-channel calls must preserve provider errors as ordinary HTTP
  // responses. Running a 4xx/429 body through an SSE validator would launder
  // it into status 200 or a synthetic stream failure.
  if (!upstreamResponse.ok) {
    return preserveUpstreamErrorResponse(upstreamResponse, abortScope.signal);
  }

  // Vertex speaks the native Anthropic wire format (Anthropic SSE for streaming
  // and the native Anthropic JSON shape for non-streaming), so for passthrough
  // routing it is wire-equivalent to "anthropic". Without this mapping a
  // streaming meta request (title-gen/summary) on a Vertex session would fail
  // the same-wire fast path below and get buffered+re-emitted through the
  // cross-protocol branch instead of streaming through raw. Collapse
  // vertex→anthropic here so a same-wire client (anthropic) streams through
  // unchanged.
  const wireProtocol: typeof effectiveProtocol =
    effectiveProtocol === "vertex" ? "anthropic" : effectiveProtocol;

  // When upstream and client use the same protocol, pass through unchanged.
  // Cross-protocol translation is only needed when provider routing maps
  // to a different protocol (e.g., OpenAI client → Anthropic upstream).
  if (wireProtocol === req.protocol) {
    if (req.stream && upstreamResponse.body) {
      return withLimits(
        validatedMetaStream(
          upstreamResponse,
          wireProtocol,
          req.codex === true,
          abortScope.signal,
        ),
      );
    }
    const body = await readForegroundBody(
      upstreamResponse,
      false,
      undefined,
      abortScope.signal,
    );
    if (wireProtocol === "openai-responses") {
      parseResponsesNonStreamEnvelope(
        JSON.parse(body) as Record<string, unknown>,
      );
    }
    const headers = new Headers({ "content-type": "application/json" });
    copyUsageLimitHeaders(upstreamResponse.headers, headers);
    return new Response(body, { status: upstreamResponse.status, headers });
  }

  // Cross-protocol: accumulate the upstream response and re-emit in the
  // client's wire format (reuses the same translation infrastructure as
  // conversation turns).
  if (req.stream && upstreamResponse.body) {
    if (wireProtocol === "anthropic") {
      // Anthropic SSE upstream (incl. Vertex) → translate to client's format
      const anthropicSSE = new Response(upstreamResponse.body, {
        status: upstreamResponse.status,
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
      if (req.protocol === "openai") {
        return withLimits(
          translateAnthropicStreamToOpenAI(anthropicSSE, {
            strict: true,
            signal: abortScope.signal,
          }),
        );
      }
      if (req.protocol === "openai-responses") {
        return withLimits(
          translateAnthropicStreamToResponses(anthropicSSE, {
            strict: true,
            signal: abortScope.signal,
          }),
        );
      }
      if (req.protocol === "gemini") {
        return withLimits(
          translateAnthropicStreamToGemini(anthropicSSE, {
            strict: true,
            signal: abortScope.signal,
          }),
        );
      }
    }
    // Other cross-protocol streaming combos: accumulate + re-emit
    const resp = await preserveIncompleteResponsesTerminal(
      wireProtocol === "openai"
        ? accumulateOpenAISSEStream(upstreamResponse, {
            signal: abortScope.signal,
            strict: true,
            stopAtTerminal: true,
            consumeUntilDone: true,
          })
        : wireProtocol === "openai-responses"
          ? accumulateResponsesSSEStream(upstreamResponse, {
              signal: abortScope.signal,
              validation: req.codex === true ? "codex" : "public",
              stopAtTerminal: true,
              requireCompletedTerminal: true,
            })
          : wireProtocol === "gemini"
            ? accumulateGeminiSSEStream(upstreamResponse, {
                signal: abortScope.signal,
                strict: true,
                stopAtTerminal: true,
              })
            : accumulateSSEResponse(upstreamResponse, {
                signal: abortScope.signal,
                strict: true,
                stopAtTerminal: true,
              }),
    );
    return withLimits(
      nonStreamHttpResponse(
        resp,
        req.protocol,
        req.stream,
        undefined,
        requestEnablesLongContext(req),
      ),
    );
  }

  // Non-streaming cross-protocol: accumulate + re-emit
  const resp = await preserveIncompleteResponsesTerminal(
    accumulateNonStreamResponse(
      upstreamResponse,
      wireProtocol,
      req.codex === true,
      abortScope.signal,
    ),
  );
  return withLimits(
    nonStreamHttpResponse(
      resp,
      req.protocol,
      req.stream,
      undefined,
      requestEnablesLongContext(req),
    ),
  );
}

/**
 * Validate a provisional session identity without touching session-owned state.
 * The full Lore turn runs only on a later retry after this successful response
 * confirms the presented header. Failed and incomplete attempts leave the
 * adopted session, project rows, auth registries, and gradient state untouched.
 */
async function handleProvisionalConversationTurn(
  req: GatewayRequest,
  config: GatewayConfig,
  identified: IdentifiedSession,
  pathResult: ProjectPathResult,
  requestOrder: number,
  requestGeneration: number,
  downstreamSettled: Promise<void>,
  downstreamWasCancelled: () => boolean,
): Promise<Response> {
  // Resolve and validate route intent once, but keep it private until the
  // provisional identity is confirmed by a complete response and client EOF.
  const requestUpstream = prepareRequestUpstream(req, config);
  const abortScope = createForegroundAbortScope(req.signal);
  let forwarded: UpstreamResult;
  try {
    forwarded = await forwardToUpstream(
      req,
      config,
      undefined,
      undefined,
      abortScope.signal,
      requestUpstream.route,
    );
  } catch (error) {
    abortScope.dispose();
    throw error;
  }
  const upstreamResponse = wrapBodyWithCleanup(
    forwarded.response,
    abortScope.dispose,
    abortScope.signal,
  );
  if (!upstreamResponse.ok) {
    // A provisional request cannot use provider diagnostics for recovery, and
    // must never expose them while proving a session identity.
    void upstreamResponse.body?.cancel().catch(() => {});
    return sanitizedUpstreamErrorResponse(upstreamResponse);
  }

  let accumulated: GatewayResponse;
  try {
    accumulated = req.stream
      ? forwarded.effectiveProtocol === "openai-responses"
        ? await accumulateResponsesSSEStream(upstreamResponse, {
            signal: abortScope.signal,
            validation: req.codex ? "codex" : "public",
            stopAtTerminal: true,
            requireCompletedTerminal: true,
          })
        : forwarded.effectiveProtocol === "openai"
          ? await accumulateOpenAISSEStream(upstreamResponse, {
              signal: abortScope.signal,
              strict: true,
              stopAtTerminal: true,
              consumeUntilDone: true,
            })
          : forwarded.effectiveProtocol === "gemini"
            ? await accumulateGeminiSSEStream(upstreamResponse, {
                signal: abortScope.signal,
                strict: true,
                stopAtTerminal: true,
              })
            : await accumulateSSEResponse(upstreamResponse, {
                signal: abortScope.signal,
                strict: true,
                stopAtTerminal: true,
              })
      : await accumulateNonStreamResponse(
          upstreamResponse,
          forwarded.effectiveProtocol,
          req.codex === true,
          abortScope.signal,
          true,
        );
  } catch (error) {
    abortScope.dispose();
    if (!(error instanceof ResponsesTerminalError)) throw error;
    scheduleStreamingPostResponse(
      identified.sessionID,
      requestGeneration,
      async () => {
        await downstreamSettled;
        await new Promise<void>((resolve) => setImmediate(resolve));
        const pause = provisionalFinalizerPauseForTest;
        if (pause) {
          pause.onWait();
          await pause.pause;
        }
        if (requestGeneration !== streamingPostResponseGeneration) return;
        if (
          identified.guardProject &&
          conflictsWithConfidentSessionProject(identified.sessionID, pathResult)
        ) {
          dropOwnedProvisionalKey(
            identified.provisionalKey,
            identified.sessionID,
          );
          return;
        }
        accountUnsuccessfulResponse(
          error.response,
          identified.sessionID,
          conversationTTLForAccounting(identified.sessionID),
          undefined,
          () => {},
          () => {
            const state = sessions.get(identified.sessionID);
            if (state) state._dirty = true;
          },
        );
      },
      () => {},
      true,
      requestCredentialFingerprint(req.rawHeaders, config) ?? undefined,
    );
    if (error.status === "incomplete" && !hasRecallToolUse(error.response)) {
      const response = nonStreamHttpResponse(
        error.response,
        req.protocol,
        req.stream,
        undefined,
        requestEnablesLongContext(req),
      );
      copyUsageLimitHeaders(upstreamResponse.headers, response.headers);
      return response;
    }
    return errorResponse(502, "Gateway request failed");
  }
  if (
    forwarded.effectiveProtocol === "gemini" &&
    !["end_turn", "max_tokens", "tool_use"].includes(accumulated.stopReason)
  ) {
    throw new Error("upstream Gemini request did not complete");
  }
  abortScope.dispose();
  const response = nonStreamHttpResponse(
    accumulated,
    req.protocol,
    req.stream,
    undefined,
    requestEnablesLongContext(req),
  );
  copyUsageLimitHeaders(upstreamResponse.headers, response.headers);

  const commit = async (): Promise<boolean> => {
    if (
      requestGeneration !== streamingPostResponseGeneration ||
      req.signal?.aborted ||
      downstreamWasCancelled()
    ) {
      return false;
    }
    if (
      identified.provisionalKey &&
      !provisionalKeyOwned(identified.provisionalKey, identified.sessionID)
    ) {
      return false;
    }
    const credential = extractAuth(req.rawHeaders);
    const persisted = loadSessionTracking(identified.sessionID);
    const liveState = sessions.get(identified.sessionID);
    let restoredUpstream:
      | ReturnType<typeof deserializeUpstreamState>
      | undefined;
    if (!liveState && persisted?.lastUpstream) {
      try {
        restoredUpstream = deserializeUpstreamState(
          persisted.lastUpstream,
          config,
        );
      } catch {
        log.warn(
          `corrupt last upstream for session ${identified.sessionID.slice(0, 16)}, ignoring`,
        );
      }
    }
    const upstreamState: MutableUpstreamState = {
      lastUpstream: liveState?.lastUpstream ?? restoredUpstream?.lastUpstream,
      upstreamByProvider: new Map(
        liveState?.upstreamByProvider ?? restoredUpstream?.upstreamByProvider,
      ),
      _upstreamRequestOrder: liveState?._upstreamRequestOrder,
      _upstreamRequestOrderByProvider:
        liveState?._upstreamRequestOrderByProvider
          ? new Map(liveState._upstreamRequestOrderByProvider)
          : undefined,
    };
    const upstreamUpdate = applyRequestUpstream(
      upstreamState,
      requestUpstream.snapshot,
      requestOrder,
      config,
    );
    // Reconstruct the binding exactly as the full pipeline does, but keep it
    // private until this successful provisional turn is durably committed.
    // This is what self-heals rows written to a cwd/unattributed bucket before
    // publishing the newly adopted header and confident path.
    postResponseStartObserver?.();
    const noStore =
      persisted?.amnesia === true ||
      req.rawHeaders["x-lore-no-store"] === "true";
    const userIndex = req.messages.findLastIndex(
      (message) => message.role === "user",
    );
    const temporalInput: TurnTemporalInput = {
      assistantIndex: req.messages.length,
      ...(userIndex >= 0
        ? {
            latestUser: gatewayMessagesToLore(
              [req.messages[userIndex]],
              identified.sessionID,
              userIndex,
              userIndex,
            )[0],
          }
        : {}),
    };
    const credentialFingerprint =
      requestCredentialFingerprint(req.rawHeaders, config) ?? "";
    const known = knownSessionHeaderForRequest(
      req,
      identified.sessionID,
      config,
    );
    let projectPath = pathResult.path;
    let projectPathProvisional = pathResult.source === "cwd";
    withSavepoint("commit_provisional_turn", () => {
      if (
        identified.expectedUnowned &&
        !legacyAdoptionTargetIsUnowned(identified.sessionID)
      ) {
        dropOwnedProvisionalKey(
          identified.provisionalKey,
          identified.sessionID,
        );
        throw new Error("legacy session owner changed during adoption");
      }
      if (
        identified.guardProject &&
        conflictsWithConfidentSessionProject(identified.sessionID, pathResult)
      ) {
        dropOwnedProvisionalKey(
          identified.provisionalKey,
          identified.sessionID,
        );
        throw new Error("session project changed during provisional migration");
      }
      // Project creation/reattribution belongs to the same transaction as the
      // turn, tracking, route, and header confirmation. A local write failure
      // must leave the provisional project and identity wholly unchanged.
      const pathState = {
        sessionID: identified.sessionID,
        projectPath: persisted?.projectPath ?? pathResult.path,
        projectPathProvisional: persisted?.projectPath
          ? persisted.projectPathProvisional
          : pathResult.source === "cwd",
        gitRemote: pathResult.gitRemote,
      } as Partial<SessionState> as SessionState;
      projectPath = resolveSessionProjectPath(pathResult, pathState, config);
      projectPathProvisional = pathState.projectPathProvisional === true;
      if (
        projectPathProvisional &&
        (pathResult.source === "header" || pathResult.source === "inferred")
      ) {
        throw new Error("provisional project re-attribution failed");
      }
      ensureProject(projectPath, undefined, pathResult.gitRemote);
      storeTurnTemporal({
        temporalInput,
        assistantContentBlocks: accumulated.content,
        usage: accumulated.usage ?? ZERO_USAGE,
        model: accumulated.model,
        projectPath,
        sessionID: identified.sessionID,
        noStore,
      });
      saveSessionTracking(identified.sessionID, {
        messageCount: req.messages.length,
        turnsSinceCuration: persisted?.turnsSinceCuration ?? 0,
        consecutiveTextOnlyTurns: persisted?.consecutiveTextOnlyTurns ?? 0,
        projectPath,
        projectPathProvisional,
        credentialFingerprint,
        ...(identified.adoptionFingerprint
          ? { fingerprint: identified.adoptionFingerprint }
          : {}),
        ...(upstreamUpdate.changed
          ? { lastUpstream: serializeUpstreamState(upstreamState) }
          : {}),
        ...(known
          ? {
              headerSessionId: known.sessionId,
              headerName: known.headerName,
            }
          : {}),
      });
    });
    const state = getOrCreateSession(
      identified.sessionID,
      projectPath,
      projectPathProvisional ? "cwd" : "header",
      credentialFingerprint,
      config,
    );
    if (upstreamUpdate.changed) {
      if (upstreamState.lastUpstream) {
        state.lastUpstream = upstreamState.lastUpstream;
      } else {
        delete state.lastUpstream;
      }
      state.upstreamByProvider = upstreamState.upstreamByProvider;
      if (upstreamState._upstreamRequestOrder !== undefined) {
        state._upstreamRequestOrder = upstreamState._upstreamRequestOrder;
      } else {
        delete state._upstreamRequestOrder;
      }
      if (upstreamState._upstreamRequestOrderByProvider) {
        state._upstreamRequestOrderByProvider =
          upstreamState._upstreamRequestOrderByProvider;
      } else {
        delete state._upstreamRequestOrderByProvider;
      }
      if (upstreamUpdate.resetCache) {
        state.cacheAnalytics.lastRequestBody = null;
      }
    }
    if (known) publishKnownSessionHeader(known, state, credentialFingerprint);
    else state.credentialFingerprint = credentialFingerprint;
    if (identified.tier === 3) observeHeaderValues(req.rawHeaders);
    state.projectPath = projectPath;
    state.projectPathProvisional = projectPathProvisional;
    if (identified.adoptionFingerprint) {
      state.fingerprint = identified.adoptionFingerprint;
    }
    if (pathResult.gitRemote) state.gitRemote = pathResult.gitRemote;
    state.messageCount = req.messages.length;
    state._dirty = true;
    if (credential) {
      captureLegacyGlobalAuth(req, config, credential);
      setSessionAuth(
        state.sessionID,
        credential,
        extractProviderHeader(req.rawHeaders) || undefined,
      );
    }
    captureBillingPrefix(state.sessionID, req.system);
    captureSessionHeaders(state.sessionID, req.rawHeaders);
    return true;
  };
  scheduleStreamingPostResponse(
    identified.sessionID,
    requestGeneration,
    async () => {
      await downstreamSettled;
      await new Promise<void>((resolve) => setImmediate(resolve));
      const pause = provisionalFinalizerPauseForTest;
      if (pause) {
        pause.onWait();
        await pause.pause;
      }
      if (requestGeneration !== streamingPostResponseGeneration) return;
      if (downstreamWasCancelled()) {
        accountUnsuccessfulResponse(
          accumulated,
          identified.sessionID,
          conversationTTLForAccounting(identified.sessionID),
          undefined,
          () => {},
        );
        return;
      }
      if (
        identified.guardProject &&
        conflictsWithConfidentSessionProject(identified.sessionID, pathResult)
      ) {
        dropOwnedProvisionalKey(
          identified.provisionalKey,
          identified.sessionID,
        );
        return;
      }
      if (!(await commit())) return;
      accountConversationUsage(
        accumulated.usage ?? ZERO_USAGE,
        accumulated.model,
        identified.sessionID,
        conversationTTLForAccounting(identified.sessionID),
      );
      const state = sessions.get(identified.sessionID);
      if (state) state._dirty = true;
    },
    () => {},
    true,
    requestCredentialFingerprint(req.rawHeaders, config) ?? undefined,
  );
  return response;
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

/**
 * Decide whether to skip post-idle compaction (PR2b). The unified cache-economics
 * strategy provides the INTENT (hold-warm → protect the warm prefix by skipping
 * compaction; cool-bust/cool-full-write → let it compact), but the cache must
 * ACTUALLY still be live (`cacheIsLive` — the `isCacheWarm` time check) — a stale
 * hold-warm strategy whose cache has expired must NOT skip compaction (the cache
 * is cold; compaction is free and reduces ongoing read cost). Non-confident
 * strategy → `cacheIsLive` alone (the legacy behavior, byte-identical).
 */
export function decideSkipCompact(
  econ: {
    result: { strategy: CacheStrategy; confident: boolean };
    decidedAt: number;
  } | null,
  cacheIsLive: boolean,
): boolean {
  if (!econ?.result.confident) return cacheIsLive;
  // Confident hold-warm wants to skip, but ONLY if the cache is actually live.
  if (strategyWantsWarming(econ.result.strategy)) return cacheIsLive;
  // cool-bust / cool-full-write: don't skip — let it compact.
  return false;
}

// ---------------------------------------------------------------------------
// Case 3: Normal conversation turn — full pipeline
// ---------------------------------------------------------------------------

export function mergeRecallUsage(
  current: GatewayUsage,
  continuation: GatewayUsage,
): GatewayUsage {
  const merged: GatewayUsage = {
    inputTokens: safeTokenSum(
      [current.inputTokens, continuation.inputTokens],
      "recall usage token overflow",
    ),
    outputTokens: safeTokenSum(
      [current.outputTokens, continuation.outputTokens],
      "recall usage token overflow",
    ),
  };
  if (
    current.cacheReadInputTokens !== undefined ||
    continuation.cacheReadInputTokens !== undefined
  ) {
    merged.cacheReadInputTokens = safeTokenSum(
      [current.cacheReadInputTokens, continuation.cacheReadInputTokens],
      "recall usage token overflow",
    );
  }
  if (
    current.cacheCreationInputTokens !== undefined ||
    continuation.cacheCreationInputTokens !== undefined
  ) {
    merged.cacheCreationInputTokens = safeTokenSum(
      [current.cacheCreationInputTokens, continuation.cacheCreationInputTokens],
      "recall usage token overflow",
    );
  }
  safeTokenSum(
    [
      merged.inputTokens,
      merged.outputTokens,
      merged.cacheReadInputTokens,
      merged.cacheCreationInputTokens,
    ],
    "recall usage token overflow",
  );
  return merged;
}

/** Compact, provider-neutral finalization guidance appended only to the last tool result. */
function recallBudgetGuidance(
  result: string,
  reason: RecallStopReason | undefined,
): string {
  if (!reason) return result;
  return (
    `${result}\n\n[Recall policy: stop further recall because ${reason}. ` +
    "Use the evidence above to answer now or hand back an ordinary tool.]"
  );
}

function assertCurrentPipelineGeneration(
  signal: AbortSignal | undefined,
  requestGeneration: number,
): void {
  signal?.throwIfAborted();
  if (
    pipelineResetInProgress ||
    requestGeneration !== streamingPostResponseGeneration
  ) {
    throw new DOMException("gateway pipeline generation changed", "AbortError");
  }
}

async function handleConversationTurn(
  req: GatewayRequest,
  config: GatewayConfig,
  requestOrder: number,
  requestGeneration: number,
  downstreamSettled: Promise<void>,
  downstreamWasCancelled: () => boolean,
  claimSession: (sessionID: string) => Promise<void>,
  onSessionIdentified?: (sessionID: string) => void,
): Promise<Response> {
  if (
    pipelineResetInProgress ||
    requestGeneration !== streamingPostResponseGeneration
  ) {
    return errorResponse(503, "Gateway pipeline generation changed");
  }
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

  // --- 3. Session identification ---
  const admitted = await withIdentityAdmission(req, config, async () => {
    const result = await identifySession(
      req,
      pathResult.path,
      pathResult.source,
      requestGeneration,
      config,
    );
    const claimed = result.isNew || result.provisionalIdentity === true;
    if (claimed) await claimSession(result.sessionID);
    const revalidateConfirmedIdentity =
      !result.isNew && result.provisionalIdentity !== true && result.tier !== 3;
    return { identified: result, claimed, revalidateConfirmedIdentity };
  });
  const { identified } = admitted;
  const { sessionID, isNew, tier } = identified;
  try {
    onSessionIdentified?.(sessionID);
  } catch (error) {
    log.warn("session diagnostic failed:", error);
  }
  if (!admitted.claimed) await claimSession(sessionID);
  if (identified.expectedUnowned && !legacyAdoptionTargetIsUnowned(sessionID)) {
    dropOwnedProvisionalKey(identified.provisionalKey, sessionID);
    return errorResponse(404, "No authenticated session found");
  }
  if (
    admitted.revalidateConfirmedIdentity &&
    !confirmedIndexedIdentityResolvesTo(req, sessionID, config)
  ) {
    return errorResponse(404, "No authenticated session found");
  }
  if (
    identified.guardProject &&
    conflictsWithConfidentSessionProject(sessionID, pathResult)
  ) {
    dropOwnedProvisionalKey(identified.provisionalKey, sessionID);
    throw new Error("session project changed during provisional migration");
  }
  await awaitStreamingPostResponse(sessionID, req.signal);
  assertCurrentPipelineGeneration(req.signal, requestGeneration);
  if (
    admitted.revalidateConfirmedIdentity &&
    !confirmedIndexedIdentityResolvesTo(req, sessionID, config)
  ) {
    return errorResponse(404, "No authenticated session found");
  }
  // Marker-derived project/session data has already been copied into headers;
  // strip it before either the provisional verifier or full pipeline forwards.
  stripContextMarkers(req.messages);
  if (identified.provisionalIdentity) {
    const preUpstreamPause = pipelinePreUpstreamPauseForTest;
    if (preUpstreamPause) {
      preUpstreamPause.onWait();
      await preUpstreamPause.pause;
      assertCurrentPipelineGeneration(req.signal, requestGeneration);
    }
    return handleProvisionalConversationTurn(
      req,
      config,
      identified,
      pathResult,
      requestOrder,
      requestGeneration,
      downstreamSettled,
      downstreamWasCancelled,
    );
  }
  const legacyGlobalProvider = cred
    ? captureLegacyGlobalAuth(req, config, cred)
    : undefined;

  const sessionState = getOrCreateSession(
    sessionID,
    pathResult.path,
    pathResult.source,
    requestCredentialFingerprint(req.rawHeaders, config) ?? "",
    config,
  );
  await beforeUpstreamCaptureForTest?.(req, sessionState);
  const sessionSignal = sessionLifecycleSignal(sessionID);
  const suppressTemporalStorage =
    sessionState.amnesia || req.rawHeaders["x-lore-no-store"] === "true";
  const preUpstreamPause = pipelinePreUpstreamPauseForTest;
  if (preUpstreamPause) {
    preUpstreamPause.onWait();
    await preUpstreamPause.pause;
    assertCurrentPipelineGeneration(req.signal, requestGeneration);
  }
  let projectPath = resolveSessionProjectPath(pathResult, sessionState, config);

  // Routing and policy are request intent, not a property of a successful
  // response. Capture now so a failed policy-tightening request still governs
  // workers, and use the order assigned synchronously in handleRequest so an
  // older concurrent turn can never overwrite a newer one.
  const requestUpstreamRoute = captureRequestUpstream(
    req,
    sessionState,
    config,
    requestOrder,
  );

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
      // A combined shell probe (#627 piggyback) carries the project-resolution
      // output AND, after a separator, a reference-validity snapshot. Split
      // first so resolution parsing only sees its own lines.
      const split = sessionState.refcheckInProbe
        ? splitProbeOutput(captured.text)
        : { resolution: captured.text, refcheck: null };
      const resolved = captured.isError
        ? {}
        : parseResolveProjectResult(
            sessionState.syntheticResolveKind,
            split.resolution,
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

      // Apply the piggybacked reference-validity snapshot against the NOW-BOUND
      // project (#627). A missing/errored snapshot → NoopResolver (neutral, but
      // still stamps the 24h gate). Never throws into the request path.
      if (sessionState.refcheckInProbe) {
        try {
          const resolver =
            captured.isError || split.refcheck == null
              ? new NoopResolver()
              : new SyntheticProbeResolver(split.refcheck);
          const refRes = await ltm.validateProjectReferences(
            projectPath,
            resolver,
            Date.now(),
            req.signal,
          );
          assertCurrentPipelineGeneration(req.signal, requestGeneration);
          if (refRes.penalized > 0) {
            log.info(
              `reference drift (remote): penalized ${refRes.penalized}/${refRes.checked} ` +
                `entries for session ${sessionID.slice(0, 16)}`,
            );
          }
        } catch (e) {
          assertCurrentPipelineGeneration(req.signal, requestGeneration);
          log.warn("synthetic reference-validation error (non-fatal):", e);
        }
        sessionState.refcheckInProbe = false;
      }

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
      sessionState.refcheckInProbe = false;
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
  await initIfNeeded(
    projectPath,
    config,
    pathResult.gitRemote,
    req.signal,
    requestGeneration,
  );
  assertCurrentPipelineGeneration(req.signal, requestGeneration);

  // Mark sub-agent sessions (x-parent-session-id OR x-claude-code-agent-id
  // present). These get their own session but are flagged for cache warming
  // exemption. Resolve the client-side parent ID to a Lore internal session ID
  // via the headerSessionIndex (searches all indexed headers, including Tier 2
  // learned). Tier 3 (fingerprint-only) parents have no index entry — resolution
  // will fail and a warning is logged.
  //
  // Claude Code sub-agents do NOT carry x-parent-session-id (that header is
  // OpenCode-only); they carry x-claude-code-agent-id. Their parent session is
  // the one that shares the x-claude-code-session-id with this request, so we
  // resolve it through the index by that shared session-id value.
  {
    const isClaudeSubagent = isClaudeCodeSubagent(req.rawHeaders);
    const parentClientId = req.rawHeaders["x-parent-session-id"];
    const sharedSessionId = req.rawHeaders["x-claude-code-session-id"];
    const credentialFingerprint = requestCredentialFingerprint(
      req.rawHeaders,
      config,
    );
    // Resolve by the OpenCode parent-session-id, or — for Claude Code — by
    // the parent's shared x-claude-code-session-id (the only stable link back
    // to the parent session; x-claude-code-parent-agent-id identifies the
    // parent *agent*, not its session). May be undefined for a malformed or
    // adversarial sub-agent request that carries neither header.
    const parentLookupValue = parentClientId ?? sharedSessionId;
    const shouldResolveParent =
      credentialFingerprint !== null &&
      (!sessionState.isSubagent || !sessionState.parentSessionId) &&
      (isClaudeSubagent || !!parentClientId) &&
      !!parentLookupValue;
    if (shouldResolveParent) {
      if (!sessionState.isSubagent) {
        sessionState.isSubagent = true;
      }
      // Search the full headerSessionIndex — covers Tier 1 (known) and Tier 2 (learned) headers.
      let resolvedParent: string | undefined;
      for (const [key, loreId] of headerSessionIndex) {
        const parsed = parseSessionIndexKey(key);
        if (
          parsed?.credentialFingerprint === credentialFingerprint &&
          parsed.headerValue === parentLookupValue
        ) {
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
        const pendingKey = `${sessionID}:${parentLookupValue}`;
        if (!subagentParentPendingLogged.has(pendingKey)) {
          subagentParentPendingLogged.add(pendingKey);
          log.info(
            `session ${sessionID.slice(0, 16)}: subagent parent resolution pending for client ID ${parentLookupValue.slice(0, 16)}`,
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
    const reqProviderID =
      requestUpstreamRoute.providerID ??
      (requestUpstreamRoute.effectiveProtocol === "anthropic"
        ? "anthropic"
        : requestUpstreamRoute.effectiveProtocol === "openai" ||
            requestUpstreamRoute.effectiveProtocol === "openai-responses"
          ? "openai"
          : requestUpstreamRoute.effectiveProtocol === "gemini"
            ? "google"
            : undefined);
    setSessionAuth(sessionID, cred, reqProviderID);
    clearWarmupAuthDisabled(sessionID); // Re-enable cache warming on fresh credential

    // One-time "it's working" signal. A fresh user has no easy way to tell
    // their agent is actually routed through Lore; this confirms it the first
    // time a credentialed turn is proxied, then stays quiet for the process.
    if (!_firstTurnConfirmed) {
      _firstTurnConfirmed = true;
      log.info(
        "\u2713 Connected — your agent's traffic is now flowing through Lore.",
      );
    }

    // A session-less import may use only the deliberately captured local,
    // configured direct-provider credential. Remote/custom routes never expose
    // their credential through the process-global fallback.
    if (legacyGlobalProvider) {
      trackBackground(flushPendingImport(legacyGlobalProvider));
    }
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
    if (!suppressTemporalStorage) {
      const credentialFingerprint =
        requestCredentialFingerprint(req.rawHeaders, config) ?? "";
      const fingerprint = await fingerprintMessages(
        req.messages.map((m) => ({ role: m.role, content: m.content })),
        usesRemoteSessionBinding(config)
          ? { tenantFingerprint: credentialFingerprint }
          : { authSuffix: cred ? authFingerprint(cred) : "" },
      );
      assertCurrentPipelineGeneration(req.signal, requestGeneration);
      sessionState.fingerprint = fingerprint;
      // Persist fingerprint immediately — rare event (new session only)
      saveSessionTracking(sessionID, { fingerprint, credentialFingerprint });
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
    credentialFingerprint: sessionState.credentialFingerprint ?? "",
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

  // Anchor provenance must use the normalized client transcript before recall
  // expansion mutates historical markers into synthetic tool round trips.
  const recallClientMessages = req.messages.map((message) => ({
    role: message.role,
    content: [...message.content],
    ...(message.provenanceContent
      ? { provenanceContent: [...message.provenanceContent] }
      : {}),
    ...(message.provenancePositions
      ? { provenancePositions: [...message.provenancePositions] }
      : {}),
  }));

  // --- Expand recall markers from previous turns ---
  // Scan all assistant messages for marker text blocks and restore them
  // to tool_use + tool_result pairs before forwarding upstream.
  if (sessionState.recallStore.size > 0) {
    // Cleanup must inspect the client transcript while anchors still exist.
    // Expanding first would make every live anchor look orphaned.
    const recallStoreChanged = cleanupRecallStore(
      req,
      sessionState.recallStore,
    );
    const expanded = expandRecallMarkers(req, sessionState.recallStore);
    if (expanded) {
      log.info(`expanded recall markers for session ${sessionID.slice(0, 16)}`);
    }
    if (recallStoreChanged) {
      saveSessionTracking(sessionID, {
        recallStore: serializeRecallStore(sessionState.recallStore),
      });
    }
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
  const preparationTiming = new PreparationTiming(req);
  log.info(
    `turn: session=${sessionID.slice(0, 16)} messages=${req.messages.length} ` +
      `model=${req.model} stream=${req.stream} new=${isNew} tier=${tier} ` +
      `subagent=${!!sessionState.isSubagent} ` +
      `source=${pathResult.source} ` +
      `hdrProject=${req.rawHeaders["x-lore-project"] ? "present" : "absent"} ` +
      `provisional=${sessionState.projectPathProvisional === true} ` +
      `remoteGateway=${config.remoteGateway} hosted=${isHostedMode()} ` +
      `project=${projectPath}`,
  );

  // --- 4. Resolve this request's model budget ---
  // Snapshot ALL model-derived budget inputs into one object keyed to THIS
  // request's model. The host does async work (ltm.forSession awaits) between
  // here and the gradient transform; passing this snapshot to transform()
  // applies it atomically there, so a concurrently-running request for a
  // different model can't clobber the values mid-flight (the cross-model
  // contamination that flipped l0cap 200000 ↔ 3571428 and thrashed layers).
  //
  // Close the cold-start race: the very first request after a restart can land
  // before the fire-and-forget models.dev pre-warm resolves, which would size
  // this turn's budget from fallback pricing/limits (wrong l0cap/usable for one
  // turn). Wait briefly for real data; bounded so a slow/unreachable models.dev
  // never hangs the request (falls back to the same fallback path as before).
  // INVARIANT: this await must stay immediately before getModelSpec — it exists
  // to make the budget below read real model data, not fallback. (Secondary
  // getModelEntrySync sites — worker selection, cost metrics — intentionally
  // keep using the sync fallback on the very first turn; they self-correct.)
  await ensureModelDataReady();
  assertCurrentPipelineGeneration(req.signal, requestGeneration);
  // Price the session model from the provider it is actually routed to (the
  // X-Lore-Provider header), not the flat last-write-wins entry — a bare id
  // published by several providers at different cache prices would otherwise
  // corrupt cacheReadCost → computeLayer0Cap.
  const modelSpec = getModelSpec(
    req.model,
    extractProviderHeader(req.rawHeaders),
  );
  const cfg = loreConfig();

  // Cost-aware layer-0 cap: explicit config wins > cost formula > disabled.
  // never inherit another model's layer-0 cap: when this model has no
  // cacheReadCost we resolve to 0 (disabled), NOT whatever the previous
  // request left in the global.
  let layer0Cap = 0;
  if (cfg.budget.maxLayer0Tokens !== undefined) {
    layer0Cap = cfg.budget.maxLayer0Tokens;
  } else if (
    modelSpec.cacheReadCost &&
    cfg.budget.targetCacheReadCostPerTurn > 0
  ) {
    layer0Cap = computeLayer0Cap(
      cfg.budget.targetCacheReadCostPerTurn,
      modelSpec.cacheReadCost,
      modelSpec.context,
    );
  }

  // Cache pricing for tier-based bust-vs-continue decisions in gradient.ts.
  // Anthropic charges 2× cache_write for 1h TTL — adjust so shouldCompress()
  // uses the actual write cost. When the model has no pricing data, resolve to
  // 0/0 (conservative: do-not-compress) rather than the previous model's price.
  let cacheWriteCostPerToken = 0;
  let cacheReadCostPerToken = 0;
  if (modelSpec.cacheWriteCost && modelSpec.cacheReadCost) {
    cacheWriteCostPerToken =
      sessionState.resolvedConversationTTL === "1h"
        ? modelSpec.cacheWriteCost * 2
        : modelSpec.cacheWriteCost;
    cacheReadCostPerToken = modelSpec.cacheReadCost;
  }

  const modelBudget = {
    contextLimit: modelSpec.context,
    outputReserved: modelSpec.output,
    maxLayer0Tokens: layer0Cap,
    cacheWriteCostPerToken,
    cacheReadCostPerToken,
    qualityKneeFraction: modelSpec.qualityKneeFraction,
  };

  // Also apply to the module globals now, so any gradient helper invoked
  // BEFORE transform() (and outside the atomic transform path) reads this
  // request's values. transform() re-applies modelBudget atomically.
  setModelLimits({ context: modelSpec.context, output: modelSpec.output });
  setMaxLayer0Tokens(layer0Cap);
  setCachePricing(cacheWriteCostPerToken, cacheReadCostPerToken);
  setQualityKnee(
    modelSpec.qualityKneeFraction ?? DEFAULT_QUALITY_KNEE_FRACTION,
  );

  // --- 4c. Dynamic max_tokens sizing for non-Claude-Code clients ---
  // Claude Code manages its own max_tokens (32K for modern models). Other
  // clients often send low/missing values (defaults to 4096 in ingress
  // parsing). Apply a hybrid headroom + history algorithm that tightens
  // from the 32K ceiling based on actual output patterns.
  const isCC =
    isClaudeCodeClient(req.rawHeaders) || hasBillingHeader(req.system);
  if (!isCC) {
    // Anthropic extended thinking arrives as `metadata.thinking =
    // { type: "enabled", budget_tokens: N }` (not a KNOWN_BODY_FIELD, so it
    // lands in metadata). Extract the budget so max_tokens leaves room above it
    // — otherwise a low output EMA collapses the cap to the floor and truncates
    // thinking-heavy turns mid-reasoning.
    const thinkingMeta = req.metadata?.thinking as
      | { type?: string; budget_tokens?: number }
      | undefined;
    const thinkingBudget =
      thinkingMeta?.type === "enabled" &&
      typeof thinkingMeta.budget_tokens === "number" &&
      thinkingMeta.budget_tokens > 0
        ? thinkingMeta.budget_tokens
        : undefined;
    // Structural fallback: thinking-by-default models (e.g. claude-opus-4-8)
    // emit thinking blocks WITHOUT an explicit `thinking` param, so the budget
    // above is undefined. Detect active reasoning from the request's thinking
    // blocks so the rewrite still reserves headroom and doesn't truncate the
    // turn at the end of a thinking block.
    const thinkingActive =
      thinkingBudget !== undefined || requestHasThinking(req.messages);
    // Unsatisfiable budget: if the thinking budget alone meets or exceeds the
    // model's hard output limit, no rewrite can produce a valid
    // `max_tokens > budget_tokens` (Anthropic 400s otherwise). The request is
    // the client's responsibility — leave its max_tokens untouched rather than
    // rewrite it into an invalid value.
    if (thinkingBudget !== undefined && modelSpec.output <= thinkingBudget) {
      // When models.dev data isn't loaded, modelSpec.output is the fallback
      // (8192) — likely understating the model's true output limit and making
      // a legitimate thinking budget look unsatisfiable. Surface that at WARN so
      // a cold-cache/outage misfire is visible (vs. a genuinely invalid budget).
      const onFallback = !isModelDataLoaded();
      const logFn = onFallback ? log.warn : log.info;
      logFn(
        `max_tokens: leaving client value ${req.maxTokens} untouched ` +
          `(thinkingBudget=${thinkingBudget} >= modelOutput=${modelSpec.output}` +
          (onFallback
            ? "; model data not loaded — using fallback limits"
            : "") +
          `)`,
      );
    } else {
      const computed = computeMaxTokens(
        modelSpec.output,
        modelSpec.context,
        sessionState.outputTokensEMA,
        sessionState.lastStopReason,
        sessionState.lastInputTokens,
        thinkingBudget,
        thinkingActive,
      );
      if (req.maxTokens !== computed) {
        log.info(
          `max_tokens: ${req.maxTokens} → ${computed} ` +
            `(ema=${sessionState.outputTokensEMA ?? "none"}, ` +
            `lastStop=${sessionState.lastStopReason ?? "none"}` +
            (thinkingBudget
              ? `, thinkingBudget=${thinkingBudget}`
              : thinkingActive
                ? ", thinking=active(no budget)"
                : "") +
            `)`,
        );
        req.maxTokens = computed;
      }
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
  // PR2b: the unified cache-economics strategy decides whether to skip
  // post-idle compaction. When confident AND the cache is actually still live
  // (isCacheWarm time check), hold-warm → skip compaction (protect the warm
  // prefix); cool-bust/cool-full-write → don't skip (let it compact). The
  // isCacheWarm liveness floor is ALWAYS required — a stale hold-warm strategy
  // with an expired cache must NOT skip compaction (the cache is cold, compaction
  // is free and beneficial). Falls back to isCacheWarm when non-confident.
  const econ = getCacheStrategy(sessionID);
  const cacheWarm = decideSkipCompact(econ, isCacheWarm(sessionState));
  // `cacheWarm` also tells onIdleResume to PRESERVE the byte-identity caches
  // (distilled prefix + raw-window pin) so the warm prefix survives the resume.
  // A false-positive here (isCacheWarm true but the warmed bytes actually
  // diverged) is safe: preserving at worst defers folding idle-distilled rows
  // into the prefix by one cold cycle — never a worse cache bust than clearing
  // (both produce a full write on a genuine miss; the preserved body is ≤ the
  // re-rendered one).
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
    // NOTE: the stable LTM block (system[1]: preferences + entities) is
    // deliberately NOT refreshed here (v45). It is frozen for the session's life
    // and replayed byte-identically — recomputing it from the live knowledge
    // table on idle resume is what let a curator/consolidation delete change the
    // "stable" prefix and bust the whole prompt cache (ses_14b9bf3d… incident).
    // Re-warming after the 1h breakpoint expires re-sends the same frozen bytes;
    // newly-curated preferences are picked up by the NEXT session, not mid-session.
    log.info(
      `session idle ${Math.round(idleResult.idleMs / 60_000)}min — refreshing caches` +
        (cacheWarm ? " (cache warm — skipping compact)" : "") +
        (econ?.result.confident
          ? ` (strategy=${econ.result.strategy})`
          : " (legacy isCacheWarm)"),
    );
    if (econ) {
      log.info(
        `cache-economics (compaction): session=${sessionID.slice(0, 16)} ` +
          `strategy=${econ.result.strategy} skipCompact=${cacheWarm} ` +
          `confident=${econ.result.confident === true} strategyAgeMs=${Date.now() - econ.decidedAt}`,
      );
    }
  }

  // Build the Lore message array once (resolved) — shared by the turn-1 LTM
  // decision below (isLargeColdStart) and the gradient transform in step 7, so
  // both see identical input and agree on whether this cold session compresses.
  let {
    loreMessages,
    temporalInput,
    provenanceByMessageId,
    sourceWindow,
    checkpoint,
  } = await prepareSemanticMessages({
    messages: req.messages,
    sessionID,
    projectPath,
    noStore: suppressTemporalStorage,
    protocol: req.protocol,
    timing: preparationTiming,
  });
  assertCurrentPipelineGeneration(req.signal, requestGeneration);

  // --- 6. LTM injection (system[1] stable prefix + durable-delta context LTM) ---
  // system[0]: Host prompt              [no cache_control]
  // system[1]: Stable LTM (preferences) [cache_control: 1h] — pinned ≥1h
  //
  // system[0]+[1] form a stable prefix cached at 1h TTL (written at 2×
  // cost, read at 0.1×). Context-bound LTM (gotchas/patterns/architecture +
  // distillation/temporal context-sources) is NO LONGER emitted as a system[2]
  // block — it rides the durable prompt-delta path from its FIRST injection
  // onward (appended [user,assistant] pair at a frozen conversation-tail
  // position, replayed byte-identically, re-anchored on compression). This
  // removes the once-per-session first-population bust that a system[2] block
  // caused (amplified on the OpenAI/OpenRouter path, where the whole system
  // string shares a single cache_control breakpoint). The durable delta is the
  // sole injection channel for context-bound LTM; the pin/cache bookkeeping
  // below survives purely as the delta's diff baseline.
  let stableLtmText: string | undefined; // block 2: preferences (system[1])
  let pendingKnowledgeDelta:
    | {
        previousKeys: string[] | undefined;
        nextKeys: string[] | undefined;
        entries: Array<{
          id: string;
          category: string;
          title: string;
          content: string;
        }>;
        // #917: relevance-scored entries that didn't fit the system[2] budget,
        // surfaced as a recall-by-id ToC inside the (frozen) knowledge delta.
        overflow?: Array<{ id: string; category: string; title: string }>;
      }
    | undefined;
  if (cfg.knowledge.enabled) {
    // Track whether LTM state changed for batched DB persistence
    let ltmDirty = false;
    let pinDirty = false;

    try {
      const ltmFraction = cfg.budget.ltm;
      // Per-session overhead (Bug 1, lever 2): budget off this session's own
      // calibrated overhead, not a global EMA blended across sessions.
      // Sub-agent sessions get a smaller, needs-based LTM budget so injected
      // knowledge doesn't crowd out a short focused task's own context/output.
      const ltmBudgetOpts = { isSubagent: !!sessionState.isSubagent };
      const ltmBudget = getLtmBudget(
        ltmFraction,
        sessionID ?? undefined,
        ltmBudgetOpts,
      );
      const prefBudget = getPreferenceLtmBudget(
        cfg.budget.preferenceLtm,
        sessionID ?? undefined,
        ltmBudgetOpts,
      );
      // Surface the resolved LTM budget so a "knowledge is crowding my
      // sub-agent" report is a one-grep diagnosis (LORE_DEBUG=1) instead of an
      // inference from window sizes: sub-agents are capped tighter
      // (SUBAGENT_MAX_LTM_BUDGET_FRACTION) so a small ctxBound here is expected
      // and NOT the crowding cause — see the Onur sub-agent triage, Jul 2026.
      log.info(
        `ltm-budget: session=${sessionID?.slice(0, 16) ?? "none"} ` +
          `subagent=${!!sessionState.isSubagent} ` +
          `ctxBound=${ltmBudget} pref=${prefBudget} fraction=${ltmFraction}`,
      );
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
        // Single-flight: a client header-timeout retry burst can fire several
        // concurrent identical turns at a cold session. Without dedup they ALL
        // recompute the heavy stable block (ltm.forSession ×2 + entity fetch +
        // catalog scan) independently, compounding the very latency that caused
        // the retries. Share one in-flight compute; the settled value lands in
        // stableLtmCache before the promise resolves, so re-reading is race-free.
        stable = await singleFlightStableLtm(
          sessionID,
          (signal) =>
            computeStableLtm(
              sessionID,
              projectPath,
              cfg,
              contextHint,
              prefBudget,
              signal,
              requestGeneration,
            ),
          req.signal,
        );
        assertCurrentPipelineGeneration(req.signal, requestGeneration);
      }
      stableLtmText = stable?.formatted;

      // Fallback for a genuinely-new but already-large session (no prior session
      // to adopt — e.g. a transcript imported from another machine): the gradient
      // will compress it on turn 1 (see gradient.isLargeColdStart), so inject
      // context-bound LTM (system[2]) NOW instead of deferring to turn 2,
      // collapsing the turn-2 system[2] bust and the turn-3 Layer 0→1 bust into
      // the single cold write. Pass the stable-LTM token count as the ltm hint:
      // when this returns false we skip system[2] and setLtmTokens(stableOnly),
      // so the gradient transform sees the SAME expectedInput tested here — no
      // decision-vs-compression drift band. (Adopted/resumed sessions are
      // calibrated, so this is false for them — the restored pin handles
      // system[2].) (issue #796)
      const largeColdStart =
        isFirstTurn &&
        isLargeColdStart({
          sourceWindow,
          messages: loreMessages,
          sessionID,
          ltmTokens: stable?.tokenCount ?? 0,
          // Re-apply this request's budget atomically: intervening awaits since
          // the module globals were set (ltm/entity fetches above) could have
          // let a concurrent request for a different model clobber them. (#1401)
          budget: modelBudget,
        });

      // --- Context-bound LTM (non-preference entries; rides the durable prompt
      // delta, NOT a system[2] block — issue #1502 retired that channel) ---
      // Deferred to turn 2+ when real session context exists for relevance
      // scoring. On turn 1, only stable LTM (preferences) is injected — EXCEPT
      // for an already-large cold start (largeColdStart), where we inject now so
      // LTM + the turn-1 compression are decided together (relevance scoring
      // still works: contextHint comes from the incoming request, not temporal
      // storage). (issue #796)
      if (!isFirstTurn || largeColdStart) {
        let cached = ltmSessionCache.get(sessionID);
        // Entry-set keys for the *freshly computed* selection. Only populated
        // on the recompute path (when ltmSessionCache was cold/invalidated) —
        // that's the only path where re-ranking can churn the text. On the
        // warm-cache path the text is unchanged, so byte equality with the pin
        // suffices and keys aren't needed.
        let cachedKeys: string[] | undefined;
        let freshContextEntries:
          | Array<{
              id: string;
              category: string;
              title: string;
              content: string;
            }>
          | undefined;
        // #917: the budget-overflow tail from this turn's forSession, mapped to
        // the ToC shape. Threaded into the knowledge delta below.
        let freshContextOverflow:
          | Array<{ id: string; category: string; title: string }>
          | undefined;

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
          const overflowSink: ltm.KnowledgeEntry[] = [];
          const contextEntries = await ltm.forSession(
            projectPath,
            sessionID,
            contextBudget,
            {
              signal: req.signal,
              excludeCategories: ["preference"],
              ...(contextHint ? { contextHint } : {}),
              ...(stickyIds.size ? { stickyIds } : {}),
              ...(cfg.knowledge.contextSources?.length
                ? { includeContextSources: cfg.knowledge.contextSources }
                : {}),
              overflowSink,
            },
          );
          assertCurrentPipelineGeneration(req.signal, requestGeneration);
          freshContextEntries = contextEntries;
          freshContextOverflow = overflowSink.map((e) => ({
            id: e.id,
            category: e.category,
            title: e.title,
          }));
          if (contextEntries.length) {
            const renderedIds: string[] = [];
            const formatted = formatKnowledge(
              contextEntries.map((e) => ({
                id: e.id,
                category: e.category,
                title: e.title,
                content: e.content,
              })),
              contextBudget,
              renderedIds,
            );
            if (formatted) {
              const tokenCount = coreEstimateTokens(formatted);
              cached = { formatted, tokenCount };
              cachedKeys = ltmEntryKeys(contextEntries, renderedIds);
              ltmSessionCache.set(sessionID, cached);
              ltmDirty = true;
            }
          }

          const pinned = ltmPinnedText.get(sessionID);
          if (!cached && pinned) {
            // The fresh selection is empty, but removing the pinned system[2]
            // block would still bust the cached prefix. Preserve the exact
            // bytes and append a durable removal delta instead. Keep entryKeys
            // frozen at the baseline (not []) so the coalesced delta describes
            // the full frozen→current (empty) supersession — see the Layer-1
            // material-delta note.
            pendingKnowledgeDelta = {
              previousKeys: pinned.entryKeys,
              nextKeys: [],
              entries: [],
            };
            cached = {
              formatted: pinned.formatted,
              tokenCount: pinned.tokenCount,
            };
            cachedKeys = [];
            ltmSessionCache.set(sessionID, cached);
            ltmPinnedText.set(sessionID, {
              formatted: pinned.formatted,
              tokenCount: pinned.tokenCount,
              entryKeys: pinned.entryKeys,
            });
            ltmDirty = true;
            pinDirty = true;
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
          // Key-format migration guard (#1320): a persisted pin from before the
          // surfaceSignature change stores entryKeys in the old
          // `id:fnv1a(title\x1f content)` format. On the first post-deploy turn
          // the recomputed `cachedKeys` use the new normalized signature, so a
          // pure element-wise compare would spuriously mismatch and re-pin (one-
          // time cache bust for every warm session). shouldReanchorPinKeys
          // detects the SAME selection in a new key encoding (same id set +
          // byte-identical rendered text) so we re-anchor with zero bust.
          if (
            pinned?.entryKeys &&
            cachedKeys &&
            shouldReanchorPinKeys(
              pinned.entryKeys,
              cachedKeys,
              cached.formatted,
              pinned.formatted,
            )
          ) {
            pinned.entryKeys = cachedKeys;
          }
          const setUnchanged = cachedKeys
            ? // Recompute path: compare entry-key sets.
              sameEntryKeys(pinned?.entryKeys, cachedKeys)
            : // Warm-cache path (no fresh entries): the text didn't change, so
              // byte equality against the pin is sufficient.
              pinned != null && pinned.formatted === cached.formatted;

          if (pinned && setUnchanged) {
            // Same entry set (or identical text) — nothing to surface. The full
            // set is already carried by the durable prompt-delta (appended on
            // first injection), so we do NOT emit a system[2] block. Keep the
            // session cache in lock-step with the pin so the
            // persisted ltmCacheText never diverges from ltmPinText (a restart
            // would otherwise reload cache=freshText / pin=oldText and spuriously
            // re-pin). The pin is baseline-only metadata now — never on the wire.
            if (cachedKeys && cached.formatted !== pinned.formatted) {
              ltmSessionCache.set(sessionID, {
                formatted: pinned.formatted,
                tokenCount: pinned.tokenCount,
              });
              ltmDirty = true;
            }
          } else if (
            pinned &&
            cachedKeys &&
            freshContextEntries &&
            hasMaterialLtmDelta({
              entries: freshContextEntries,
              previousKeys: pinned.entryKeys,
              nextKeys: cachedKeys,
            })
          ) {
            // Material LTM changed mid-session. Surface the change via the
            // durable prompt delta at the conversation tail; system[2] is never
            // emitted, so the system prefix is never busted.
            //
            // CRITICAL: keep `entryKeys` frozen at the baseline that matches the
            // set the durable delta was last coalesced against — do NOT advance
            // it to cachedKeys. The delta is coalesced into a single row that is
            // REPLACED each turn, so it must describe the CUMULATIVE delta from
            // the frozen baseline. If we advanced the baseline, the next turn's
            // delta would only describe that turn's increment and the coalesced
            // row would silently drop earlier supersessions. The diff is
            // recomputed from the frozen baseline every turn → re-upserting the
            // same (frozen, current) pair yields byte-identical content
            // (idempotent, no extra cache bust).
            pendingKnowledgeDelta = {
              previousKeys: pinned.entryKeys,
              nextKeys: cachedKeys,
              entries: freshContextEntries,
              overflow: freshContextOverflow,
            };
            ltmPinnedText.set(sessionID, {
              formatted: pinned.formatted,
              tokenCount: pinned.tokenCount,
              entryKeys: pinned.entryKeys,
            });
            ltmSessionCache.set(sessionID, {
              formatted: pinned.formatted,
              tokenCount: pinned.tokenCount,
            });
            ltmDirty = true;
            pinDirty = true;
            // Context-bound LTM rides the durable delta — no system[2] block.
          } else if (freshContextEntries?.length && cachedKeys) {
            // First injection (no prior system[2] pin). Historically this
            // seeded a system[2] block, which — because system[2] sits inside
            // the cached system prefix — cost a full
            // prefix re-creation the first turn context-bound LTM appeared
            // (~90–174K tokens; amplified on the OpenAI/OpenRouter path, where
            // the whole system string shares a single cache_control breakpoint).
            //
            // Instead, route the first injection through the SAME durable
            // prompt-delta path that already carries mid-session changes: append
            // a [user,assistant] pair at the conversation tail (byte-stable,
            // replayed verbatim, re-anchored on compression). system[2] is never
            // populated, so the system prefix is never busted by context-bound
            // LTM.
            //
            // Seed the delta baseline with an EMPTY-hash sentinel per current id
            // (`fullSurfaceBaseline`) so `detectSurfacedMutations` surfaces the
            // FULL set once (each entry's real hash differs from ""). The
            // appended block records the true hashes, so the surfaced set
            // advances and later turns don't re-fire — identical mechanics to
            // the material-change branch, just with an empty baseline instead of
            // a stale pinned one. We pin the RENDERED text bytes so the persisted
            // pin (`ltmPinnedText`) keeps its entry-key identity as the baseline
            // for subsequent material-delta detection, but we do NOT emit it as
            // a system[2] block.
            pendingKnowledgeDelta = {
              previousKeys: fullSurfaceBaseline(entryKeyIds(cachedKeys)),
              nextKeys: cachedKeys,
              entries: freshContextEntries,
              overflow: freshContextOverflow,
            };
            ltmPinnedText.set(sessionID, {
              formatted: cached.formatted,
              tokenCount: cached.tokenCount,
              entryKeys: cachedKeys,
            });
            pinDirty = true;
            // Context-bound LTM rides the durable delta — no system[2] block.
          } else if (cached) {
            // Fallback: a `cached` block reached here without matching the
            // first-injection / material-change / setUnchanged branches — e.g.
            // the empty-selection removal path above (cachedKeys=[], no fresh
            // entries), which already queued its removal delta. Keep the pin as
            // baseline metadata but do NOT emit system[2] — the durable delta
            // is the sole carrier.
            ltmPinnedText.set(sessionID, {
              ...cached,
              entryKeys: cachedKeys ?? ltmPinnedText.get(sessionID)?.entryKeys,
            });
            pinDirty = true;
            // Context-bound LTM rides the durable delta — no system[2] block.
          }
        }
      }

      // Use the stable block's stored tokenCount rather than re-estimating
      // from string length — avoids inconsistent estimates. Context-bound
      // LTM rides the durable delta (accounted against the delta token
      // budget, not the system cache budget), so it adds nothing here.
      setLtmTokens(stable?.tokenCount ?? 0, sessionID);
    } catch (e) {
      assertCurrentPipelineGeneration(req.signal, requestGeneration);
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
  // loreMessages was built + resolved once before the LTM block (step 6) so the
  // turn-1 LTM decision and this transform share identical input. Reuse it.
  //
  // Pre-load the session's distillation snapshot off-thread first (#1082): the
  // sync transform() below would otherwise run an unbounded distillation scan on
  // this pre-upstream critical path. prewarm populates the same per-session
  // snapshot transform() reads, so its loadDistillationsCached hits the cache
  // instead of the DB. On a pool timeout it's a no-op and transform() falls back
  // to the identical in-process load.
  await prewarmDistillationSnapshot(
    projectPath,
    sessionID,
    loreMessages,
    req.signal,
  );
  assertCurrentPipelineGeneration(req.signal, requestGeneration);
  let result;
  try {
    result = transform({
      messages: loreMessages,
      projectPath,
      sessionID,
      budget: modelBudget,
      sourceWindow,
    });
  } catch (error) {
    if (!(error instanceof FullSourceRequired) || !sourceWindow) throw error;
    preparationTiming.metric(`source_fallback_${error.reason}`, 1);
    ({
      loreMessages,
      temporalInput,
      provenanceByMessageId,
      sourceWindow,
      checkpoint,
    } = await prepareSemanticMessages({
      messages: req.messages,
      sessionID,
      projectPath,
      noStore: suppressTemporalStorage,
      protocol: req.protocol,
      forceFull: true,
      timing: preparationTiming,
    }));
    assertCurrentPipelineGeneration(req.signal, requestGeneration);
    result = transform({
      messages: loreMessages,
      projectPath,
      sessionID,
      budget: modelBudget,
    });
  }
  checkpoint?.finish(result.messages);

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
      // Per-session overhead (Bug 1, lever 2). Sub-agents keep the smaller
      // needs-based budget on the emergency-refresh path too.
      const ltmBudget = getLtmBudget(ltmFraction, sessionID, {
        isSubagent: !!sessionState.isSubagent,
      });
      // Full context-bound budget — preferences have their own dedicated budget.
      const contextBudget = ltmBudget;
      const stableTokens = stableLtmCache.get(sessionID)?.tokenCount ?? 0;
      const contextHint = lastUserTextTrimmed(req);
      // Stability hint: keep the previously-pinned set sticky so consecutive
      // Layer-4 turns don't churn the selection (see step-6).
      const stickyIds = entryKeyIds(ltmPinnedText.get(sessionID)?.entryKeys);
      const overflowSink: ltm.KnowledgeEntry[] = [];
      const contextEntries = await ltm.forSession(
        projectPath,
        sessionID,
        contextBudget,
        {
          signal: req.signal,
          excludeCategories: ["preference"],
          ...(contextHint ? { contextHint } : {}),
          ...(stickyIds.size ? { stickyIds } : {}),
          ...(cfg.knowledge.contextSources?.length
            ? { includeContextSources: cfg.knowledge.contextSources }
            : {}),
          overflowSink,
        },
      );
      assertCurrentPipelineGeneration(req.signal, requestGeneration);
      const contextOverflow = overflowSink.map((e) => ({
        id: e.id,
        category: e.category,
        title: e.title,
      }));
      let refreshed = false;

      if (contextEntries.length) {
        const renderedIds: string[] = [];
        const formatted = formatKnowledge(
          contextEntries.map((e) => ({
            id: e.id,
            category: e.category,
            title: e.title,
            content: e.content,
          })),
          contextBudget,
          renderedIds,
        );

        if (formatted) {
          const tokenCount = coreEstimateTokens(formatted);
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
            // Same entry set — nothing to surface. The durable delta already
            // carries the full set; do NOT emit a system[2] block.
            setLtmTokens(stableTokens, sessionID);
            saveSessionTracking(sessionID, {
              ltmCacheText: formatted,
              ltmCacheTokens: tokenCount,
              // pin unchanged — don't write ltmPinText/ltmPinTokens/ltmPinKeys
            });
          } else if (
            pinned &&
            hasMaterialLtmDelta({
              entries: contextEntries,
              previousKeys: pinned.entryKeys,
              nextKeys: entryKeys,
            })
          ) {
            // Material LTM changed during emergency refresh. Surface the change
            // as a durable prompt delta; system[2] is not emitted.
            //
            // CRITICAL: keep `entryKeys` frozen at the baseline matching the set
            // the durable delta was last coalesced against — do NOT advance to
            // the current `entryKeys`. The coalesced durable delta is replaced
            // each turn, so it must describe the CUMULATIVE delta from the frozen
            // baseline to the current selection; advancing the baseline would
            // drop earlier supersessions from the single row.
            const frozenKeys = pinned.entryKeys;
            pendingKnowledgeDelta = {
              previousKeys: frozenKeys,
              nextKeys: entryKeys,
              entries: contextEntries,
              overflow: contextOverflow,
            };
            ltmPinnedText.set(sessionID, {
              formatted: pinned.formatted,
              tokenCount: pinned.tokenCount,
              entryKeys: frozenKeys,
            });
            ltmSessionCache.delete(sessionID);
            ltmSessionCache.set(sessionID, {
              formatted: pinned.formatted,
              tokenCount: pinned.tokenCount,
            });
            setLtmTokens(stableTokens, sessionID);
            saveSessionTracking(sessionID, {
              ltmCacheText: pinned.formatted,
              ltmCacheTokens: pinned.tokenCount,
              ltmPinText: pinned.formatted,
              ltmPinTokens: pinned.tokenCount,
              ltmPinKeys: JSON.stringify(frozenKeys),
            });
            // Context-bound LTM rides the durable delta — no system[2] block.
          } else {
            // First Layer 4 injection of context-bound LTM. Route it through the
            // durable delta (full-surface baseline) rather than seeding system[2]
            // — same rationale as the step-6 first-injection path. Layer 4 busts
            // the prefix anyway, but keeping context-bound LTM out of system[2]
            // means it stays cache-stable on the NEXT (non-emergency) turn too.
            pendingKnowledgeDelta = {
              previousKeys: fullSurfaceBaseline(entryKeyIds(entryKeys)),
              nextKeys: entryKeys,
              entries: contextEntries,
              overflow: contextOverflow,
            };
            ltmPinnedText.set(sessionID, { formatted, tokenCount, entryKeys });
            setLtmTokens(stableTokens, sessionID);
            saveSessionTracking(sessionID, {
              ltmCacheText: formatted,
              ltmCacheTokens: tokenCount,
              ltmPinText: formatted,
              ltmPinTokens: tokenCount,
              ltmPinKeys: JSON.stringify(entryKeys),
            });
            // Context-bound LTM rides the durable delta — no system[2] block.
          }
          refreshed = true;
          log.info(
            "Context-bound LTM refreshed on emergency layer (Layer 4) for session",
            sessionID,
          );
        }
      }

      if (!refreshed) {
        const pinned = ltmPinnedText.get(sessionID);
        if (pinned) {
          // No fresh context-bound entries were selected. Append a durable
          // removal delta so the model knows the older entries are superseded;
          // system[2] is not emitted.
          //
          // CRITICAL: keep entryKeys FROZEN at the baseline matching the set the
          // durable delta was last coalesced against — do NOT wipe to []. The
          // coalesced durable delta is replaced each turn and must describe the
          // full cumulative frozen→current (empty) supersession. Wiping the
          // baseline to [] here (in memory AND persisted) makes the next turn
          // compute previous=[]→next=[] = no removals, dropping every earlier
          // supersession from the single row.
          const frozenKeys = pinned.entryKeys;
          pendingKnowledgeDelta = {
            previousKeys: frozenKeys,
            nextKeys: [],
            entries: [],
          };
          ltmPinnedText.set(sessionID, {
            formatted: pinned.formatted,
            tokenCount: pinned.tokenCount,
            entryKeys: frozenKeys,
          });
          ltmSessionCache.delete(sessionID);
          ltmSessionCache.set(sessionID, {
            formatted: pinned.formatted,
            tokenCount: pinned.tokenCount,
          });
          setLtmTokens(stableTokens, sessionID);
          saveSessionTracking(sessionID, {
            ltmCacheText: pinned.formatted,
            ltmCacheTokens: pinned.tokenCount,
            ltmPinText: pinned.formatted,
            ltmPinTokens: pinned.tokenCount,
            ltmPinKeys: JSON.stringify(frozenKeys),
          });
          // Context-bound LTM rides the durable delta — no system[2] block.
          log.info(
            "Context-bound LTM refresh returned no entries; superseding via durable delta for session",
            sessionID,
          );
        } else {
          // forSession() returned no context-bound entries and there is no prior
          // pin to preserve — clear context LTM state. Stable LTM (system[1]) is
          // preserved.
          ltmSessionCache.delete(sessionID);
          ltmPinnedText.delete(sessionID);
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
      }
    } catch (e) {
      assertCurrentPipelineGeneration(req.signal, requestGeneration);
      // On error, leave the step-6 LTM state intact (cache, pin, text)
      // so the turn proceeds with the pre-refresh knowledge rather than
      // an inconsistent state. The next turn will retry via step 6.
      log.error("LTM refresh on emergency layer failed:", e);
    }
  }

  // --- 7c. (removed) Context health note ---
  // Previously a per-turn "Context health" note was appended to system[2] when
  // the gradient compressed context (layer ≥1). Its wording varied by layer,
  // which busted the conversation cache on every layer oscillation (1→2→1)
  // because system[2] has no cache_control of its own. The note was also
  // largely redundant with the per-distillation "lossy" tags and the recall
  // tool description. Its one unique signal (verify omitted specifics —
  // rejected alternatives, exact errors, file paths, numbers — via recall) now
  // lives statically in RECALL_TOOL_DESCRIPTION, which never busts the cache.
  // See issue #741.

  // --- 7d. Response-side warning injection ---
  // The previous "unsustainable conversation detected (N consecutive cache busts)"
  // warning was removed (#797). Rationale: the user has no actionable response
  // (cache spirals are almost always upstream bugs — prefix drift, idle
  // recompression artifacts, LTM pin mismatch — not user-correctable behavior),
  // and the message was misleading. The bust-spiral signal is now routed
  // directly to Sentry via `setupBustSpiralCapture` (past-grace = error,
  // in-grace = info breadcrumb, recovery = info breadcrumb).
  //
  // Worker-degradation warning: still surfaced when background workers
  // (distillation, curation, cache-warming) have been failing for a sustained
  // period, so the user is told instead of silently losing compression/LTM.
  // The user CAN act on this (e.g. check credentials / provider status), so
  // user-visible text remains the right channel.
  const workerWarningText = buildWorkerDegradationWarning(sessionID);
  if (workerWarningText) {
    log.warn(
      `session ${sessionID}: worker degradation detected — warning will be prepended to response.`,
    );
  }
  // A single combined flag/text drives all injection sites below.
  const warningText: string | undefined = workerWarningText ?? undefined;
  const shouldInjectWarning = !!warningText;

  // --- 8. Build the modified request ---
  // Reconstruct GatewayMessages from the transformed Lore messages.
  // loreMessagesToGateway reconstructs tool_result blocks from assistant's
  // completed/error tool parts; removeOrphanedToolResults is a safety net
  // that catches any remaining orphaned tool_result references.
  const transformedMessages = loreMessagesToGateway(
    result.messages,
    provenanceByMessageId,
    !sourceWindow &&
      result.messages.length === loreMessages.length &&
      result.messages.every(
        (message, index) => message.info.id === loreMessages[index]?.info.id,
      ),
  );
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
  if (
    modifiedReq.protocol === "openai-responses" &&
    clientHasRecallTool(modifiedReq.tools)
  ) {
    modifiedReq.extras = {
      ...modifiedReq.extras,
      parallel_tool_calls: false,
    };
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
        // Piggyback the #627 reference-validity snapshot onto the SHELL probe so
        // it costs NO extra round-trip (a separate probe would short-circuit an
        // additional turn). Only the shell stage can run a script; the read
        // probe can't. Ref scope is best-effort: the project is still provisional
        // here, so refs come from the provisional binding — capture re-gathers
        // from the RESOLVED project, and file/command checks are repo-level
        // (identity-independent), so accuracy is preserved; only a line ref whose
        // basename wasn't pre-listed degrades to 'unknown' (neutral).
        let block = buildSyntheticToolUseBlock(target);
        if (
          target.kind === "shell" &&
          cfg.knowledge.enabled &&
          cfg.knowledge.referenceValidation
        ) {
          const peek = await ltm.peekProjectRefsOffloaded(projectPath);
          assertCurrentPipelineGeneration(req.signal, requestGeneration);
          if (!peek.gated && peek.refs.length > 0) {
            block = buildCombinedResolveRefcheckBlock(
              target,
              buildRefcheckProbeScript(peek.refs),
            );
            sessionState.refcheckInProbe = true;
          }
        }
        sessionState.syntheticResolveState =
          target.kind === "read" ? "readPending" : "shellPending";
        sessionState.syntheticResolveToolUseId = block.id;
        sessionState.syntheticResolveKind = target.kind;
        log.info(
          `synthetic-resolve: injecting ${target.kind} probe ` +
            `(tool=${target.toolName}${sessionState.refcheckInProbe ? "+refcheck" : ""}) ` +
            `for session ${sessionID.slice(0, 16)}`,
        );
        // SHORT-CIRCUIT: do NOT forward upstream. Return our own tool_use
        // response so the client harness executes the probe locally.
        return syntheticToolUseResponse(req, block);
      }
      // No usable tool — give up permanently for this session.
      sessionState.syntheticResolveState = "done";
    }
  }

  // Reset the durable delta when the gradient-transformed array reshuffles.
  // The delta's persisted insertAt is a frozen absolute index into that array;
  // when it reshuffles, the once-safe index can drift into a tool_use/
  // tool_result pair (or simply onto a different message), busting the prompt
  // cache. On such a turn we recompute the delta (position + content) THIS turn
  // rather than replaying a stale index — keeping the request coherent and
  // stopping removeOrphanedToolResults from destructively stripping a real tool
  // pair every subsequent turn.
  //
  // Two events reshuffle the array: (1) a LAYER CHANGE (entering/escalating/
  // de-escalating compression), and (2) a POST-IDLE COMPACT, which rebuilds the
  // array (the distilled prefix grows, the raw window is rebuilt) while STAYING
  // at the same layer — a steady layer-1 session resumes at layer 1. The layer
  // comparison alone misses (2).
  //
  // 🔴 But (2) only reshuffles when the resume ACTUALLY recompacted. A WARM
  // idle resume (`cacheWarm` / skipCompact — PR #1102) PRESERVES the distilled
  // prefix and raw-window pin byte-for-byte, so the array does NOT reshuffle
  // and the delta's insertAt stays valid. Gating on raw `lastTurnWasIdle`
  // re-anchored the delta on those warm resumes too, moving it off its cached
  // position and busting the very cache skipCompact was protecting (observed:
  // 100%→9% drops at the delta's old index on large sessions). So a post-idle
  // resume counts as a reshuffle ONLY when it was NOT cache-warm.
  const idleRecompacted = idleResumeReshuffled(
    sessionState.lastTurnWasIdle ?? false,
    cacheWarm,
  );
  const deltaCompressed = shouldResetDeltaOnCompression(
    sessionState.lastDeltaLayer ?? 0,
    result.layer,
    idleRecompacted,
  );
  // On a compressing turn the gradient reshuffled the array; re-anchor the
  // durable delta blocks (preserving content + `mut`) to a fresh tool-pair-safe
  // index. 🔴 Re-anchor — NOT delete — even when a fresh knowledge delta is
  // produced this turn (see reanchorDeltaOnCompression): deleting wiped the
  // surfaced-set history, so the append below re-derived the full cumulative
  // pin→DB wall every compression+change turn (the regrowth #1013 only trimmed).
  const reInsertAt = reanchorDeltaOnCompression(
    sessionID,
    projectPath,
    modifiedReq.messages,
    deltaCompressed,
  );
  if (reInsertAt !== null) {
    log.info(
      `prompt-delta: re-anchored durable delta for session ${sessionID.slice(0, 16)} after compression (layer ${sessionState.lastDeltaLayer ?? 0}→${result.layer}, insertAt=${reInsertAt})`,
    );
  }

  if (pendingKnowledgeDelta) {
    // Place the durable delta near the tail, but never between an
    // assistant(tool_use) and its user(tool_result) — inserting there orphans
    // the tool_use and triggers an Anthropic 400 (#747 regression). The index
    // is computed tool-pair-safe and persisted; replay reuses it verbatim to
    // keep the delta byte-position-stable for the prompt cache until the next
    // compression resets it.
    const insertAt = safeDeltaInsertIndex(
      modifiedReq.messages,
      Math.max(0, modifiedReq.messages.length - 1),
    );
    appendKnowledgePromptDelta({
      sessionID,
      projectPath,
      insertAt,
      now: Date.now(),
      ...pendingKnowledgeDelta,
    });
  }
  // Track the layer that produced the current delta placement so the next turn
  // can detect a compression-driven reshuffle.
  sessionState.lastDeltaLayer = result.layer;
  modifiedReq.messages = applySessionPromptDeltas(
    modifiedReq.messages,
    sessionID,
  );
  // Hard guarantee: deltas are spliced into the wire array AFTER the orphan
  // safety net (step 8) and persisted indices are replayed verbatim, so a
  // later turn whose layout differs from the delta's creation turn could place
  // a delta adjacent to a tool turn. Re-running the safety net ensures no
  // orphaned tool_use/tool_result ever reaches the API. Note this is a
  // last-ditch net: if it fires it strips the orphaned tool_use, which rewrites
  // a historical assistant message and busts the cache from that point — strictly
  // better than a hard 400, but it should essentially never fire given the
  // creation-time placement above.
  removeOrphanedToolResults(modifiedReq.messages);

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
    cacheTools: true,
    cacheConversation: true,
    conversationTTL: resolvedConversationTTL,
    // Lore's distilled prefix (buildPrefixMessages) is the first 2 messages
    // (a [user, assistant] pair) whenever distillation is active
    // (distilledTokens > 0), and always sits at the front of the transformed
    // array ([...prefix, ...rawWindow]); the durable delta is inserted near the
    // tail and orphan-removal never touches the front, so [0,1] stay the prefix.
    // Passing 2 places an interior breakpoint on its boundary so a raw-window
    // divergence falls back to the cached prefix instead of the ~54K head.
    distilledPrefixLength: result.distilledTokens > 0 ? 2 : 0,
  };

  // The throttle is part of the foreground request's absolute lifetime. Start
  // the shared scope before delaying so the 300-second deadline includes both
  // the wait and every later upstream/recall phase.
  const foregroundAbort = createForegroundAbortScope(modifiedReq.signal);

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
      coreEstimateTokens(JSON.stringify(modifiedReq.messages));
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
        try {
          await completeBudgetThrottleDelay(
            actualDelay * 1000,
            foregroundAbort.signal,
            () => {
              const costs = getSessionCosts(sessionID);
              if (costs) {
                costs.throttle.events++;
                costs.throttle.totalDelayMs += actualDelay * 1000;
              }
            },
          );
        } catch (error) {
          foregroundAbort.dispose();
          throw error;
        }
      }
    }
  }
  assertCurrentPipelineGeneration(req.signal, requestGeneration);

  // Start gen_ai.chat span before the upstream call so it captures real
  // wall-clock duration (including network latency and streaming time).
  // The span is ended in postResponse() after usage attributes are set.
  const genAiSpan = Sentry.startInactiveSpan({
    op: "gen_ai.chat",
    name: `chat ${req.model}`,
    attributes: {
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": req.model,
      "gen_ai.provider.name":
        requestUpstreamRoute.providerID ??
        requestUpstreamRoute.effectiveProtocol,
      "gen_ai.response.streaming": req.stream,
      // NO gen_ai.input.messages — privacy (proxy for other people's projects)
    },
  });
  let streamingFinalizerRegistered = false;
  let genAiSpanEnded = false;
  let recallPersistenceTransaction:
    | { commit: () => void; rollback: () => void }
    | undefined;
  const rollbackRecallPersistence = (): void => {
    recallPersistenceTransaction?.rollback();
    recallPersistenceTransaction = undefined;
  };
  const endGenAiSpan = (): void => {
    if (genAiSpanEnded) return;
    genAiSpanEnded = true;
    genAiSpan?.end();
  };
  const dropStreamingFinalizer = (): void => {
    rollbackRecallPersistence();
    streamingFinalizerRegistered = true;
    genAiSpan?.setStatus({
      code: 2,
      message: "post-response finalizer dropped",
    });
    endGenAiSpan();
  };
  const releaseForeground = (): void => {
    if (!streamingFinalizerRegistered && !genAiSpanEnded) {
      genAiSpan?.setStatus({
        code: 2,
        message: req.stream
          ? "stream cancelled before terminal response"
          : "request ended before terminal response",
      });
      endGenAiSpan();
    }
    foregroundAbort.dispose();
  };

  let upstreamResult: UpstreamResult;
  try {
    preparationTiming.upstreamStart();
    upstreamResult = await forwardToUpstream(
      modifiedReq,
      config,
      undefined,
      cacheOptions,
      foregroundAbort.signal,
      requestUpstreamRoute,
    );
  } catch (error) {
    releaseForeground();
    throw error;
  }
  const upstreamResponse = wrapBodyWithCleanup(
    upstreamResult.response,
    () => {},
    foregroundAbort.signal,
  );
  let foregroundOwnershipTransferred = false;
  const finishForeground = (response: Response): Response => {
    if (foregroundOwnershipTransferred) return response;
    foregroundOwnershipTransferred = true;
    copyUsageLimitHeaders(upstreamResponse.headers, response.headers);
    return wrapBodyWithCleanup(
      response,
      releaseForeground,
      foregroundAbort.signal,
      rollbackRecallPersistence,
    );
  };
  const awaitForeground = async <T>(operation: Promise<T>): Promise<T> => {
    try {
      return await operation;
    } catch (error) {
      if (!foregroundOwnershipTransferred) releaseForeground();
      throw error;
    }
  };
  const { serializedBody: requestBody, effectiveProtocol } = upstreamResult;

  if (!upstreamResponse.ok) {
    const errorBodySignal = AbortSignal.any([
      foregroundAbort.signal,
      AbortSignal.timeout(foregroundErrorBodyTimeoutMs),
    ]);
    let errorBody = "";
    try {
      errorBody = await readForegroundBody(
        upstreamResponse,
        true,
        undefined,
        errorBodySignal,
      );
    } catch (error) {
      if (foregroundAbort.signal.aborted) {
        releaseForeground();
        throw error;
      }
      log.warn("upstream error body read timed out");
    }
    log.error(`upstream error: ${upstreamResponse.status}`);

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

    captureToolPairing400({
      status: upstreamResponse.status,
      errorBody,
      messages: modifiedReq.messages,
      layer: result.layer,
      model: req.model,
      sessionID,
    });

    genAiSpan.setStatus({
      code: 2,
      message: `HTTP ${upstreamResponse.status}`,
    });
    endGenAiSpan();
    return finishForeground(sanitizedUpstreamErrorResponse(upstreamResponse));
  }

  // Run the recall-interception loop over an already-accumulated
  // (internal Anthropic-format) GatewayResponse and return the client HTTP
  // response. Shared by the non-streaming path AND the OpenAI/openai-responses
  // streaming paths — those accumulate the upstream SSE into the same internal
  // Anthropic-format response, so the recall loop is protocol-agnostic here.
  // Without this, a `recall` tool_use injected by the gateway would leak to the
  // client (e.g. "Model tried to call unavailable tool 'recall'").
  const bufferedRecallDiagnostics = createRecallDiagnostics(
    !suppressTemporalStorage,
  );
  const finalizeWithRecall = async (
    resp: GatewayResponse,
  ): Promise<Response> => {
    // --- Recall interception (non-streaming) ---
    // Loop allows the model to call recall multiple times (e.g. drill down
    // into t:<id> source citations). Resource, progress, and time budgets
    // normally end the chain before its configured emergency ceiling.
    let currentResp = resp;
    let recallDepth = 0;
    let currentModifiedReq = modifiedReq;
    const responsesVisibleContent: GatewayContentBlock[] = [];
    const cumulativeUsage = { ...(resp.usage ?? ZERO_USAGE) };
    const recallBudget = new RecallChainBudget({
      maxExecutions: loreConfig().search.recall.chainMaxExecutions,
      deadlineAt: foregroundAbort.deadlineAt,
    });
    // Account the principal response before the first recall admission. Each
    // subsequent continuation is recorded below exactly once.
    recallBudget.recordUsage(resp.usage);
    const logRecallBudgetStop = (reason: RecallStopReason): void => {
      log.info(`recall final continuation: budget exhausted reason=${reason}`);
    };
    const bufferedRecallTransaction = createRecallPersistenceTransaction(
      sessionState,
      suppressTemporalStorage,
    );
    const finishBufferedResponse = (response: GatewayResponse): void => {
      if (req.stream || recallDepth > 0) {
        // Recall state and successful-turn storage share the existing atomic
        // finalizer, after downstream EOF, for buffered clients as well.
        finishStreaming(response);
      } else {
        postResponse(
          req,
          response,
          sessionState,
          config,
          temporalInput,
          requestBody,
          genAiSpan,
          suppressTemporalStorage,
          endGenAiSpan,
        );
      }
    };
    const failRecall = (
      category: RecallContinuationFailureCategory,
    ): Response => {
      reportRecallContinuationFailure(category);
      rollbackRecallPersistence();
      finishUnsuccessfulStreaming({ ...currentResp, usage: cumulativeUsage });
      return errorResponse(502, "Recall continuation failed");
    };
    // Whether this request opted into the 1M window (context-1m beta); gates the
    // client-usage cap so a 1M-capable model the client meters against 200K is
    // clamped below its ~167K auto-compact threshold (#910 regression).
    const longContext = requestEnablesLongContext(req);

    // Snapshot LTM-in-context IDs once per request — system[1] catalog and
    // durable delta entries are stable across the recall loop iterations, so
    // reuse the same set for every recall (Seer 15623149/1). Mirrors the
    // streaming path's pre-loop snapshot.
    const alreadyInLtmIds = buildAlreadyInLtmIds(
      stableLtmText,
      pendingKnowledgeDelta,
    );

    while (hasRecallToolUse(currentResp)) {
      if (
        currentResp.content.filter(
          (block) =>
            block.type === "tool_use" && block.name === RECALL_TOOL_NAME,
        ).length > 1
      )
        return failRecall("parallel_recall");
      const recallBlock = findRecallToolUse(currentResp);
      if (!recallBlock) break;
      const requestedItems = Array.isArray(
        (recallBlock.input as Record<string, unknown>).ids,
      )
        ? ((recallBlock.input as Record<string, unknown>).ids as unknown[])
            .length
        : 1;
      const admission = recallBudget.admit(requestedItems);
      if (admission) {
        logRecallBudgetStop(admission);
        return failRecall("depth_exhausted");
      }
      recallDepth++;
      recallPersistenceTransaction ??= bufferedRecallTransaction;
      const { result, input, coverage } = await promiseAgainstAbort(
        () =>
          executeRecall(
            recallBlock,
            sessionState.projectPath,
            sessionState.sessionID,
            getLLMClient(config),
            alreadyInLtmIds.size > 0 ? alreadyInLtmIds : undefined,
            foregroundAbort.signal,
            bufferedRecallTransaction.deferTransfer,
          ),
        foregroundAbort.signal,
      );

      bufferedRecallDiagnostics.record(input, result, coverage);
      const stopReason = recallBudget.record({
        resultBytes: Buffer.byteLength(result),
        coverage,
      });
      if (stopReason) logRecallBudgetStop(stopReason);
      const followUpResult = recallBudgetGuidance(result, stopReason);
      // Store recall result for marker round-trip expansion
      const scope = input.scope ?? "all";
      const anchorId = crypto.randomUUID();
      const storeKey = `anchor:${anchorId}`;
      const position = currentResp.content.indexOf(recallBlock);
      const anchorContextId = responsesAnchorContext(
        recallClientMessages,
        responsesVisibleContent,
        currentResp,
        recallBlock.id,
      );
      const companionToolUses = currentResp.content.flatMap((block, index) => {
        if (block.type !== "tool_use" || block.id === recallBlock.id) return [];
        const side: "before" | "after" = index < position ? "before" : "after";
        return [{ id: block.id, name: block.name, input: block.input, side }];
      });
      if (!suppressTemporalStorage) {
        const storedRecall: StoredRecall = {
          toolUseId: recallBlock.id,
          anchorId,
          anchorContextId,
          input,
          position,
          result,
          ...(companionToolUses.length > 0 ? { companionToolUses } : {}),
        };
        bufferedRecallTransaction.stage(storeKey, storedRecall);
      }

      const markerText = buildAnchoredRecallMarker(
        input.query,
        scope,
        input.id,
        input.ids,
        anchorId,
      );
      const markerResp = replaceRecallWithMarker(
        currentResp,
        new Map([[recallBlock.id, markerText]]),
      );
      responsesVisibleContent.push(
        ...responsesProvenanceContent(
          currentResp,
          new Map([[recallBlock.id, markerText]]),
        ),
      );

      if (hasOtherToolUse(currentResp)) {
        // Mixed tools — return response with marker, client handles the rest
        log.info(
          `recall (non-stream, mixed, depth=${recallDepth}): stored result for session ${sessionState.sessionID.slice(0, 16)}`,
        );
        markerResp.usage = cumulativeUsage;
        finishBufferedResponse(markerResp);
        return nonStreamHttpResponse(
          shouldInjectWarning
            ? injectContextWarning(markerResp, warningText)
            : markerResp,
          req.protocol,
          req.stream,
          { "x-lore-recall-invoked": "true" },
          longContext,
        );
      }

      // Recall-only — send follow-up request for seamless UX.
      // Build + forward + assert-content-type + parse in one coupled call so
      // the follow-up's stream flag can never diverge from how the continuation
      // is consumed.
      //
      // openai-codex (ChatGPT) MANDATES streaming: its `/backend-api/codex/
      // responses` backend rejects `stream: false` with
      // `400 {"detail":"Stream must be set to true"}`. A plain stream:false
      // JSON follow-up therefore 400s on every Codex recall continuation. For
      // codex we force the follow-up to stream and accumulate its SSE body back
      // into a non-streaming continuation, so the recall loop below is
      // unchanged. Every other backend keeps the stream:false JSON follow-up
      // (the standard Responses API and Chat Completions both accept it).
      const followUpRequiresStream = currentModifiedReq.codex === true;
      log.info(
        `recall (non-stream, depth=${recallDepth}, codex=${followUpRequiresStream}): executing follow-up for session ${sessionState.sessionID.slice(0, 16)}`,
      );
      const jsonRecallCtx: RecallFollowUpCtx = {
        forward: (r, signal) =>
          forwardToUpstream(
            r,
            config,
            undefined,
            {
              ...cacheOptions,
              cacheConversation: false,
            },
            signal,
            requestUpstreamRoute,
          ),
        parseJSON: (response, protocol, signal) =>
          accumulateNonStreamResponse(
            response,
            protocol,
            false,
            signal,
            stopReason !== undefined,
          ),
        parseSSE: (response, signal) =>
          accumulateResponsesSSEStream(response, {
            signal,
            validation: currentModifiedReq.codex ? "codex" : "public",
            stopAtTerminal: true,
            requireCompletedTerminal: true,
          }),
      };
      let jsonFollowUp: Awaited<ReturnType<typeof runRecallFollowUpJSON>>;
      try {
        jsonFollowUp = followUpRequiresStream
          ? await runRecallFollowUpStreamAccumulated(
              jsonRecallCtx,
              currentModifiedReq,
              currentResp,
              followUpResult,
              recallBlock,
              foregroundAbort.signal,
              stopReason !== undefined,
            )
          : await runRecallFollowUpJSON(
              jsonRecallCtx,
              currentModifiedReq,
              currentResp,
              followUpResult,
              recallBlock,
              foregroundAbort.signal,
              stopReason !== undefined,
            );
      } catch (fetchErr) {
        if (
          foregroundAbort.signal.aborted ||
          (fetchErr instanceof Error && fetchErr.name === "AbortError")
        ) {
          throw fetchErr;
        }
        if (
          fetchErr instanceof ResponsesTerminalError ||
          fetchErr instanceof NonStreamCompletionError
        ) {
          Object.assign(
            cumulativeUsage,
            mergeRecallUsage(
              cumulativeUsage,
              fetchErr.response.usage ?? ZERO_USAGE,
            ),
          );
        }
        log.error(
          `recall follow-up fetch failed (non-stream, depth=${recallDepth}) for session ${sessionState.sessionID.slice(0, 16)}`,
        );
        if (stopReason) return failRecall("follow_up_failed");
        bufferedRecallDiagnostics.finish("failed");
        // Fall back to response with marker (no continuation)
        markerResp.usage = cumulativeUsage;
        finishBufferedResponse(markerResp);
        return nonStreamHttpResponse(
          shouldInjectWarning
            ? injectContextWarning(markerResp, warningText)
            : markerResp,
          req.protocol,
          req.stream,
          { "x-lore-recall-invoked": "true" },
          longContext,
        );
      }

      if (!jsonFollowUp.ok) {
        log.error(
          `recall follow-up upstream error: ${jsonFollowUp.status ?? "?"}`,
          new Error(`recall follow-up upstream ${jsonFollowUp.status ?? "?"}`),
        );
        captureToolPairing400({
          status: jsonFollowUp.status ?? 0,
          errorBody: jsonFollowUp.detail,
          messages: currentModifiedReq.messages,
          // `result` here is the recall string (shadowed); the transform layer
          // is not in scope on the recall continuation. -1 signals "unknown".
          layer: -1,
          model: currentModifiedReq.model,
          sessionID: sessionState.sessionID,
        });
        if (stopReason) return failRecall("follow_up_failed");
        bufferedRecallDiagnostics.finish("failed");
        // Fall back to response with marker (no continuation)
        markerResp.usage = cumulativeUsage;
        finishBufferedResponse(markerResp);
        return nonStreamHttpResponse(
          shouldInjectWarning
            ? injectContextWarning(markerResp, warningText)
            : markerResp,
          req.protocol,
          req.stream,
          { "x-lore-recall-invoked": "true" },
          longContext,
        );
      }

      const { continuation: continuationResp, followUp } = jsonFollowUp;

      // Accumulate usage from this iteration
      const contUsage = continuationResp.usage ?? ZERO_USAGE;
      recallBudget.recordUsage(contUsage);
      Object.assign(
        cumulativeUsage,
        mergeRecallUsage(cumulativeUsage, contUsage),
      );

      // Update for next iteration
      currentModifiedReq = followUp;
      // Recall can consume another quota window or omit quota metadata entirely.
      // Keep this turn's ordered updates so the rebuilt stream reports every
      // bucket, with newer updates following older ones.
      if (currentResp.codexRateLimits?.length) {
        continuationResp.codexRateLimits = [
          ...currentResp.codexRateLimits,
          ...(continuationResp.codexRateLimits ?? []),
        ];
      }
      currentResp = continuationResp;
      // Loop continues — hasRecallToolUse checked at top
    }

    if (hasRecallToolUse(currentResp)) return failRecall("depth_exhausted");
    if (recallBudget.stopReason() && !isUsableRecallContinuation(currentResp))
      return failRecall("follow_up_failed");
    currentResp.usage = cumulativeUsage;
    if (recallBudget.stopReason())
      log.info("recall final continuation: completed");
    finishBufferedResponse(currentResp);
    // Telemetry: flag a completion we're about to hand back with NO usable
    // content (no text, no tool_use) — the "no response data" class
    // (github-copilot #1052 follow-up). Checked on the model's response, before
    // any lore context-warning banner is layered on. Never throws / never
    // blocks the read path.
    if (isEmptyCompletion(currentResp)) {
      const emptyOutputTokens = currentResp.usage?.outputTokens ?? 0;
      log.warn(
        `empty completion → client: protocol=${effectiveProtocol} ` +
          `model=${req.model} stopReason=${currentResp.stopReason} ` +
          `outputTokens=${emptyOutputTokens} recallDepth=${recallDepth} ` +
          `session=${sessionState.sessionID.slice(0, 16)}`,
      );
      captureEmptyCompletion({
        protocol: effectiveProtocol,
        model: req.model,
        sessionID: sessionState.sessionID,
        stopReason: currentResp.stopReason,
        outputTokens: emptyOutputTokens,
        recallDepth,
      });
    }
    const recallHeaders =
      recallDepth > 0 ? { "x-lore-recall-invoked": "true" } : undefined;
    return nonStreamHttpResponse(
      shouldInjectWarning
        ? injectContextWarning(currentResp, warningText)
        : currentResp,
      req.protocol,
      req.stream,
      recallHeaders,
      longContext,
    );
  };
  const finishWithRecall = async (resp: GatewayResponse): Promise<Response> => {
    try {
      const response = await awaitForeground(finalizeWithRecall(resp));
      bufferedRecallDiagnostics.finish(response.ok ? "completed" : "failed");
      return finishForeground(response);
    } catch (error) {
      rollbackRecallPersistence();
      bufferedRecallDiagnostics.finish(
        foregroundAbort.signal.aborted ? "aborted" : "failed",
      );
      throw error;
    }
  };
  function finishStreaming(resp: GatewayResponse): void {
    if (streamingFinalizerRegistered) return;
    streamingFinalizerRegistered = true;
    scheduleStreamingPostResponse(
      sessionState.sessionID,
      requestGeneration,
      async () => {
        await downstreamSettled;
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (requestGeneration !== streamingPostResponseGeneration) {
          dropStreamingFinalizer();
          return;
        }
        if (sessionSignal.aborted) {
          dropStreamingFinalizer();
          return;
        }
        if (downstreamWasCancelled()) {
          rollbackRecallPersistence();
          accountUnsuccessfulResponse(
            resp,
            sessionState.sessionID,
            sessionState.resolvedConversationTTL,
            genAiSpan,
            endGenAiSpan,
            () => {
              sessionState._dirty = true;
            },
          );
          return;
        }
        try {
          const postResponseFailed = new Error(
            "Responses recall post-response persistence failed",
          );
          try {
            withTenant(sessionState.storageTenantId ?? "", () =>
              withSavepoint("responses_recall_post_response", () => {
                const persisted = postResponseForTenant(
                  req,
                  resp,
                  sessionState,
                  config,
                  temporalInput,
                  requestBody,
                  genAiSpan,
                  suppressTemporalStorage,
                  endGenAiSpan,
                );
                if (!persisted) throw postResponseFailed;
                recallPersistenceTransaction?.commit();
              }),
            );
            recallPersistenceTransaction = undefined;
          } catch (error) {
            rollbackRecallPersistence();
            if (error !== postResponseFailed) throw error;
          }
        } catch (error) {
          rollbackRecallPersistence();
          throw error;
        }
      },
      dropStreamingFinalizer,
      true,
      requestCredentialFingerprint(req.rawHeaders, config) ?? undefined,
    );
  }
  function finishUnsuccessfulStreaming(resp: GatewayResponse): void {
    if (streamingFinalizerRegistered) return;
    streamingFinalizerRegistered = true;
    scheduleStreamingPostResponse(
      sessionState.sessionID,
      requestGeneration,
      async () => {
        await downstreamSettled;
        await new Promise<void>((resolve) => setImmediate(resolve));
        rollbackRecallPersistence();
        if (
          requestGeneration !== streamingPostResponseGeneration ||
          sessionSignal.aborted
        ) {
          dropStreamingFinalizer();
          return;
        }
        accountUnsuccessfulResponse(
          resp,
          sessionState.sessionID,
          sessionState.resolvedConversationTTL,
          genAiSpan,
          endGenAiSpan,
          () => {
            sessionState._dirty = true;
          },
        );
      },
      dropStreamingFinalizer,
      true,
      requestCredentialFingerprint(req.rawHeaders, config) ?? undefined,
    );
  }
  async function captureUnsuccessfulResponses(
    operation: Promise<GatewayResponse>,
  ): Promise<{ response: GatewayResponse; successful: boolean } | undefined> {
    try {
      return { response: await operation, successful: true };
    } catch (error) {
      if (!(error instanceof ResponsesTerminalError)) throw error;
      finishUnsuccessfulStreaming(error.response);
      return error.status === "incomplete"
        ? { response: error.response, successful: false }
        : undefined;
    }
  }

  if (req.stream && upstreamResponse.body) {
    // Non-Anthropic upstream streaming responses need their own accumulator
    // since the Anthropic SSE accumulator can't parse OpenAI SSE formats.
    // Both OpenAI variants accumulate into internal Anthropic-format and then
    // run the SAME recall interception loop as the non-streaming path —
    // otherwise an injected `recall` tool_use would leak straight to the client.
    if (effectiveProtocol === "openai-responses") {
      // True streaming fast path: when the client also speaks the Responses API
      // (the codex/ChatGPT case), no `recall` tool can appear (so no
      // interception is needed), and there's no warning to layer in, forward
      // each upstream SSE event to the client AS IT ARRIVES. This fixes the
      // codex "waiting for response headers" hang — the buffered path below
      // withholds all client bytes until the (slow, reasoning-heavy) upstream
      // fully completes.
      const hasRecallTool = modifiedReq.tools.some(
        (t) => t.name === RECALL_TOOL_NAME,
      );

      // Only stream through recall-aware when the client ALSO speaks the
      // Responses API AND no warning needs to be layered in. The recall-aware
      // streamer forwards events live (fixing the header-timeout hang) while
      // transparently intercepting a recall `function_call` — the buffered
      // path (used otherwise) can't, so a recall tool_use would leak to the
      // client.
      if (req.protocol === "openai-responses" && !shouldInjectWarning) {
        if (hasRecallTool) {
          let responsesRecallRequest = modifiedReq;
          const responsesVisibleContent: GatewayContentBlock[] = [];
          return finishForeground(
            streamResponsesRecallAware(upstreamResponse, {
              validation: req.codex ? "codex" : "public",
              onComplete: (response, successful) => {
                if (successful) finishStreaming(response);
                else finishUnsuccessfulStreaming(response);
              },
              onTransactionReady: (transaction) => {
                rollbackRecallPersistence();
                recallPersistenceTransaction = transaction;
              },
              sessionID: sessionState.sessionID,
              maxRecallExecutions:
                loreConfig().search.recall.chainMaxExecutions,
              noStore: suppressTemporalStorage,
              signal: foregroundAbort.signal,
              recallDeadlineAt: foregroundAbort.deadlineAt,
              onRecall: async ({
                query,
                scope,
                id,
                ids,
                detailOffset,
                detailLimit,
                toolUseId,
                contentPosition,
                acc,
                signal,
              }) => {
                const alreadyInLtm = buildAlreadyInLtmIds(
                  stableLtmText,
                  pendingKnowledgeDelta,
                );
                const deferredTransferRecordings: Array<() => void> = [];
                const { result, input, coverage } = await withTenant(
                  sessionState.storageTenantId ?? "",
                  () =>
                    executeRecall(
                      {
                        type: "tool_use",
                        id: `recall_stream_${query}_${scope ?? ""}_${id ?? ""}_${ids?.join(",") ?? ""}`,
                        name: RECALL_TOOL_NAME,
                        input: {
                          query,
                          scope,
                          id,
                          ids,
                          detailOffset,
                          detailLimit,
                        },
                      },
                      sessionState.projectPath,
                      sessionState.sessionID,
                      getLLMClient(config),
                      alreadyInLtm.size > 0 ? alreadyInLtm : undefined,
                      signal,
                      (record) => deferredTransferRecordings.push(record),
                    ),
                );
                const recallBlock = acc.content[contentPosition];
                if (
                  recallBlock?.type !== "tool_use" ||
                  recallBlock.id !== toolUseId ||
                  recallBlock.name !== RECALL_TOOL_NAME
                ) {
                  throw new Error(
                    "recall execution: recall block not found in accumulated response",
                  );
                }
                const anchorId = crypto.randomUUID();
                const position = contentPosition;
                const anchorContextId = responsesAnchorContext(
                  recallClientMessages,
                  responsesVisibleContent,
                  acc,
                  recallBlock.id,
                );
                const companionToolUses = acc.content.flatMap(
                  (block, index) => {
                    if (block.type !== "tool_use" || block.id === toolUseId) {
                      return [];
                    }
                    const side: "before" | "after" =
                      index < position ? "before" : "after";
                    return [
                      {
                        id: block.id,
                        name: block.name,
                        input: block.input,
                        side,
                      },
                    ];
                  },
                );
                const storeKey = `anchor:${anchorId}`;
                const storedRecall = {
                  toolUseId,
                  anchorId,
                  anchorContextId,
                  input,
                  position,
                  result,
                  ...(companionToolUses.length > 0
                    ? { companionToolUses }
                    : {}),
                } satisfies StoredRecall;
                const persistStore = (): void => {
                  saveSessionTracking(sessionState.sessionID, {
                    recallStore: serializeRecallStore(sessionState.recallStore),
                  });
                };
                const anchorText = buildRecallAnchor(anchorId);
                responsesVisibleContent.push(
                  ...responsesProvenanceContent(
                    acc,
                    new Map([[toolUseId, anchorText]]),
                  ),
                );
                return {
                  anchorText,
                  resultText: result,
                  coverage,
                  commit: () => {
                    if (suppressTemporalStorage) return;
                    for (const record of deferredTransferRecordings) record();
                    addRecallStoreEntry(
                      sessionState.recallStore,
                      storeKey,
                      storedRecall,
                    );
                    persistStore();
                    recallPersistenceCommitObserver?.();
                  },
                  rollback: () => {
                    if (suppressTemporalStorage) return;
                    if (sessionState.recallStore.delete(storeKey))
                      persistStore();
                  },
                };
              },
              runFollowUp: async ({
                finalRecallRound,
                acc,
                resultText,
                toolUseId,
                contentPosition,
                signal,
              }) => {
                // Reconstruct the recall tool_use block for the follow-up request.
                const recallBlock = acc.content[contentPosition];
                if (
                  recallBlock?.type !== "tool_use" ||
                  recallBlock.id !== toolUseId ||
                  recallBlock.name !== RECALL_TOOL_NAME
                ) {
                  throw new Error(
                    "recall follow-up: recall block not found in accumulated response",
                  );
                }
                const followUpCtx: RecallFollowUpCtx = {
                  forward: (r, followUpSignal) =>
                    forwardToUpstream(
                      r,
                      config,
                      undefined,
                      {
                        ...cacheOptions,
                        cacheConversation: false,
                      },
                      followUpSignal,
                      requestUpstreamRoute,
                    ),
                  parseJSON: () => {
                    throw new Error(
                      "parseJSON must not be called on the streaming recall path",
                    );
                  },
                };
                const followUpBaseRequest = responsesRecallRequest;
                const follow = await runRecallFollowUpStreaming(
                  followUpCtx,
                  followUpBaseRequest,
                  acc,
                  resultText,
                  recallBlock,
                  signal,
                  finalRecallRound,
                );
                if (!follow.ok) {
                  throw new Error(
                    `recall follow-up upstream error: ${follow.status ?? "?"}`,
                  );
                }
                return {
                  reader: follow.reader,
                  commit: () => {
                    responsesRecallRequest = follow.followUp;
                  },
                };
              },
            }),
          );
        }
        // No recall tool — plain passthrough.
        return finishForeground(
          streamResponsesPassthrough(
            upstreamResponse,
            (response, successful) => {
              if (successful) finishStreaming(response);
              else finishUnsuccessfulStreaming(response);
            },
            sessionState.sessionID,
            req.codex ? "codex" : "public",
            foregroundAbort.signal,
          ),
        );
      }
      // Warning to inject, or a non-Responses client: buffer the full
      // upstream, run recall interception, then re-emit.
      const captured = await awaitForeground(
        captureUnsuccessfulResponses(
          accumulateResponsesSSEStream(upstreamResponse, {
            signal: foregroundAbort.signal,
            validation: req.codex ? "codex" : "public",
            stopAtTerminal: true,
            requireCompletedTerminal: true,
          }),
        ),
      );
      if (!captured) {
        return finishForeground(errorResponse(502, "Gateway request failed"));
      }
      if (!captured.successful) {
        if (hasRecallToolUse(captured.response)) {
          return finishForeground(errorResponse(502, "Gateway request failed"));
        }
        return finishForeground(
          nonStreamHttpResponse(
            captured.response,
            req.protocol,
            req.stream,
            undefined,
            requestEnablesLongContext(req),
          ),
        );
      }
      return finishWithRecall(captured.response);
    }

    if (effectiveProtocol === "openai") {
      // OpenAI Chat Completions streaming — accumulate and return as
      // non-streaming Anthropic format (same pattern as non-stream path).
      const resp = await awaitForeground(
        accumulateOpenAISSEStream(upstreamResponse, {
          signal: foregroundAbort.signal,
          strict: true,
          stopAtTerminal: true,
          consumeUntilDone: true,
        }),
      );
      return finishWithRecall(resp);
    }

    if (effectiveProtocol === "gemini") {
      // Gemini native streaming — accumulate the SSE frames, then re-emit via
      // the recall-aware finalizer (same buffered pattern as the OpenAI paths).
      const resp = await awaitForeground(
        accumulateGeminiSSEStream(upstreamResponse, {
          signal: foregroundAbort.signal,
          strict: true,
          stopAtTerminal: true,
        }),
      );
      return finishWithRecall(resp);
    }

    // Anthropic streaming: forward events and accumulate in parallel.
    // Pass recall context so the accumulator can intercept recall tool_use.
    const hasRecallTool = modifiedReq.tools.some(
      (t) => t.name === RECALL_TOOL_NAME,
    );
    const anthropicSSE = buildStreamingResponse(
      upstreamResponse,
      finishStreaming,
      hasRecallTool
        ? {
            clientMessages: recallClientMessages,
            modifiedReq,
            config,
            sessionState,
            cacheOptions,
            upstreamRoute: requestUpstreamRoute,
            noStore: suppressTemporalStorage,
            onFailure: finishUnsuccessfulStreaming,
            onTransactionReady: (transaction) => {
              rollbackRecallPersistence();
              recallPersistenceTransaction = transaction;
            },
            clientSpeaksAnthropic: req.protocol === "anthropic",
            stableLtmText,
            recallDeadlineAt: foregroundAbort.deadlineAt,
            ...(pendingKnowledgeDelta ? { pendingKnowledgeDelta } : {}),
          }
        : undefined,
      warningText,
      sessionState.sessionID,
      // Cap usage against the window the CLIENT meters against: the model's real
      // window only when this request opted into it via the context-1m beta,
      // else 200K — so a 1M-capable model the client meters against 200K can't
      // cross its ~167K auto-compact threshold (#910 regression; MiniMax-M3).
      maxReportedUsageForModelID(req.model, requestEnablesLongContext(req)),
      foregroundAbort.signal,
    );
    // Translate to client's wire format if needed. When the upstream is
    // Anthropic but the client speaks OpenAI, wrap the Anthropic SSE stream.
    if (req.protocol === "openai") {
      return finishForeground(
        translateAnthropicStreamToOpenAI(anthropicSSE, {
          signal: foregroundAbort.signal,
          propagateErrors: true,
        }),
      );
    }
    if (req.protocol === "openai-responses") {
      return finishForeground(
        translateAnthropicStreamToResponses(anthropicSSE, {
          signal: foregroundAbort.signal,
        }),
      );
    }
    if (req.protocol === "gemini") {
      return finishForeground(
        translateAnthropicStreamToGemini(anthropicSSE, {
          signal: foregroundAbort.signal,
        }),
      );
    }
    return finishForeground(anthropicSSE);
  }

  // Non-streaming: dispatch to correct accumulator based on upstream protocol.
  const captured = await awaitForeground(
    captureUnsuccessfulResponses(
      accumulateNonStreamResponse(
        upstreamResponse,
        effectiveProtocol,
        modifiedReq.codex === true,
        foregroundAbort.signal,
      ),
    ),
  );
  if (!captured) {
    return finishForeground(errorResponse(502, "Gateway request failed"));
  }
  if (!captured.successful) {
    if (hasRecallToolUse(captured.response)) {
      return finishForeground(errorResponse(502, "Gateway request failed"));
    }
    return finishForeground(
      nonStreamHttpResponse(
        captured.response,
        req.protocol,
        req.stream,
        undefined,
        requestEnablesLongContext(req),
      ),
    );
  }
  return finishWithRecall(captured.response);
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
  provenanceByMessageId: ReadonlyMap<
    string,
    Pick<
      GatewayMessage,
      "content" | "provenanceContent" | "provenancePositions"
    >
  > = new Map(),
  allowProvenance = true,
): GatewayMessage[] {
  const out: GatewayMessage[] = [];

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
            toolName?: string;
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
              ...(toolPart.toolName ? { toolName: toolPart.toolName } : {}),
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
                toolName: toolPart.toolName ?? toolPart.tool,
                content: toolResultContent(toolPart.state),
              });
            } else if (toolPart.state.status === "error") {
              pendingToolResults.push({
                type: "tool_result",
                toolUseId: toolPart.callID,
                toolName: toolPart.toolName ?? toolPart.tool,
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

    const message: GatewayMessage = { role: msg.info.role, content };
    const provenance = allowProvenance
      ? provenanceByMessageId.get(msg.info.id)
      : undefined;
    if (
      provenance?.provenanceContent &&
      JSON.stringify(content) === JSON.stringify(provenance.content)
    ) {
      message.provenanceContent = [...provenance.provenanceContent];
      if (provenance.provenancePositions) {
        message.provenancePositions = [...provenance.provenancePositions];
      }
    }
    out.push(message);
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
      (b) => b.type !== "tool_result" || toolUseIds.has(b.toolUseId),
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
      (b) => b.type !== "tool_use" || toolResultIds.has(b.id),
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
      .map((b) => b.text)
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
  claimSession: (sessionID: string) => Promise<void>,
): Promise<Response | null> {
  const text = lastUserTextTrimmed(req);
  if (!text.toLowerCase().startsWith("/lore:")) return null;

  let state = findLiveSessionState(req, config, allSessions);
  const indexedSessionID = findIndexedSessionID(req, config);
  if (!state && indexedSessionID) {
    const pathResult = getProjectPath(req.system, req.rawHeaders);
    state = getOrCreateSession(
      indexedSessionID,
      pathResult.path,
      pathResult.source,
      requestCredentialFingerprint(req.rawHeaders, config) ?? "",
      config,
    );
  }
  const sessionID = indexedSessionID ?? state?.sessionID;
  if (sessionID) {
    await claimSession(sessionID);
    if (
      indexedSessionID &&
      !confirmedIndexedIdentityResolvesTo(req, sessionID, config)
    ) {
      return slashResponse(
        req,
        "No authenticated active session found.",
        `msg_lore_${Date.now()}`,
      );
    }
    await awaitStreamingPostResponse(sessionID, req.signal);
    req.signal?.throwIfAborted();
    if (
      indexedSessionID &&
      !confirmedIndexedIdentityResolvesTo(req, sessionID, config)
    ) {
      return slashResponse(
        req,
        "No authenticated active session found.",
        `msg_lore_${Date.now()}`,
      );
    }
  }

  // Route to specific handlers
  const warmupResult = handleWarmupSlashCommand(req, allSessions, config);
  if (warmupResult) return warmupResult;

  const curateResult = await handleCurateSlashCommand(
    req,
    allSessions,
    config,
    claimSession,
  );
  if (curateResult) return curateResult;

  const amnesiaResult = handleAmnesiaSlashCommand(req, allSessions, config);
  if (amnesiaResult) return amnesiaResult;

  // Unknown /lore:* command — return error instead of forwarding upstream
  log.warn(`unknown slash command: ${text}`);
  return slashResponse(
    req,
    `Unknown command: ${text}. Available: /lore:curate, /lore:warm:stop|keep|auto|on|off|reset, /lore:amnesia:on|off`,
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
  config: GatewayConfig,
): Response | null {
  const text = lastUserTextTrimmed(req);
  const lower = text.toLowerCase();

  const isOn = lower === "/lore:amnesia:on";
  const isOff = lower === "/lore:amnesia:off";
  if (!isOn && !isOff) return null;

  const state = findLiveSessionState(req, config, allSessions);

  if (!state) {
    return slashResponse(
      req,
      "No active session found. Amnesia mode was not changed.",
      `msg_lore_${Date.now()}`,
    );
  }

  state.amnesia = isOn;
  saveSessionTracking(state.sessionID, { amnesia: isOn });
  log.info(
    `amnesia: ${lower} for session=${state.sessionID.slice(0, 16)} — ` +
      `storage ${isOn ? "suppressed" : "resumed"}`,
  );

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
 * `/lore:warm:reset` — clears ALL tripped circuit-breaker buckets (re-enables
 *   warming that was disabled after repeated uncached warmups).
 * `/lore:warm:off` — disables cache warming GLOBALLY (persisted override).
 * `/lore:warm:on` — re-enables cache warming globally.
 *
 * Returns a synthetic Anthropic-format response if a command was matched,
 * or null to continue normal processing.
 */
function handleWarmupSlashCommand(
  req: GatewayRequest,
  allSessions: Map<string, SessionState>,
  config: GatewayConfig,
): Response | null {
  const text = lastUserTextTrimmed(req);
  const lower = text.toLowerCase();

  const isStop = lower === "/lore:warm:stop";
  const isKeep = lower === "/lore:warm:keep";
  const isAuto = lower === "/lore:warm:auto";
  const isReset = lower === "/lore:warm:reset";
  const isOff = lower === "/lore:warm:off";
  const isOn = lower === "/lore:warm:on";
  if (!isStop && !isKeep && !isAuto && !isReset && !isOff && !isOn) return null;

  const state = findLiveSessionState(req, config, allSessions);

  if (
    (isReset || isOff || isOn) &&
    (config.remoteGateway || config.hostedMode)
  ) {
    return errorResponse(
      403,
      "Global cache-warming administration is unavailable on remote gateways",
    );
  }

  // Global controls require an authenticated, resolved session. Otherwise any
  // network caller could persistently change warming for every tenant.
  if (
    (isReset || isOff || isOn) &&
    (isHostedMode() ||
      !state ||
      !state.lastUpstream ||
      !extractAuth(req.rawHeaders))
  ) {
    return slashResponse(
      req,
      "No authenticated active session found. Global cache warming was not changed.",
      `msg_lore_${Date.now()}`,
    );
  }

  // Reset is a breaker-wide admin action.
  if (isReset) {
    resetCircuitBreaker();
    log.info(
      "cache-warmer: /lore:warm:reset received — circuit breaker cleared",
    );
    return slashResponse(
      req,
      "Cache warming circuit breaker reset.",
      `msg_lore_${Date.now()}`,
    );
  }

  // on/off are GLOBAL admin actions (persisted KV override).
  if (isOff || isOn) {
    setWarmingEnabled(isOn);
    log.info(
      `cache-warmer: /lore:warm:${isOn ? "on" : "off"} received — warming globally ${isOn ? "enabled" : "disabled"}`,
    );
    return slashResponse(
      req,
      isOn
        ? "Cache warming enabled globally."
        : "Cache warming disabled globally.",
      `msg_lore_${Date.now()}`,
    );
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
  claimSession: (sessionID: string) => Promise<void>,
): Promise<Response | null> {
  const text = lastUserTextTrimmed(req);
  if (text.toLowerCase() !== "/lore:curate") return null;

  const indexedSessionID = findIndexedSessionID(req, config);
  const pathResult = getProjectPath(req.system, req.rawHeaders);
  let state = findLiveSessionState(req, config, allSessions);
  let sessionID = state?.sessionID;

  if (!state && indexedSessionID) {
    state = getOrCreateSession(
      indexedSessionID,
      pathResult.path,
      pathResult.source,
      requestCredentialFingerprint(req.rawHeaders, config) ?? "",
      config,
    );
    sessionID = indexedSessionID;
  }

  if (!sessionID || !state) {
    return slashResponse(
      req,
      "No active session found for curation.",
      "msg_lore_curate_none",
    );
  }

  await claimSession(sessionID);
  if (
    indexedSessionID &&
    !confirmedIndexedIdentityResolvesTo(req, sessionID, config)
  ) {
    return slashResponse(
      req,
      "No active session found for curation.",
      "msg_lore_curate_none",
    );
  }
  await awaitStreamingPostResponse(sessionID, req.signal);
  req.signal?.throwIfAborted();
  if (
    indexedSessionID &&
    !confirmedIndexedIdentityResolvesTo(req, sessionID, config)
  ) {
    return slashResponse(
      req,
      "No active session found for curation.",
      "msg_lore_curate_none",
    );
  }

  const projectPath = resolveSessionProjectPath(pathResult, state, config);
  saveSessionTracking(sessionID, {
    projectPath: state.projectPath || null,
    projectPathProvisional: state.projectPathProvisional === true,
  });
  const { distillation, curator } = await import("@loreai/core");
  req.signal?.throwIfAborted();
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
      signal: req.signal,
      workerHealth: makeWorkerHealth(sessionID, "lore-distill"),
      // #627 Phase 1: stamp the session's gitHead on slash-curate rows.
      metadata: buildSessionMetadata(state.gitHead),
    });
    req.signal?.throwIfAborted();
    distilled = dResult.distilled;
  } catch (e) {
    req.signal?.throwIfAborted();
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
      signal: req.signal,
      workerHealth: makeWorkerHealth(sessionID, "lore-curator"),
      // #627 Phase 1: stamp the session's gitHead on slash-curate entries.
      metadata: buildSessionMetadata(state.gitHead),
    });
    req.signal?.throwIfAborted();
    created = cResult.created;
    updated = cResult.updated;
    deleted = cResult.deleted;
  } catch (e) {
    req.signal?.throwIfAborted();
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
      return translateAnthropicStreamToOpenAI(anthropicSSE, {
        signal: req.signal,
      });
    }
    if (req.protocol === "openai-responses") {
      return translateAnthropicStreamToResponses(anthropicSSE, {
        signal: req.signal,
      });
    }
    if (req.protocol === "gemini") {
      return translateAnthropicStreamToGemini(anthropicSSE, {
        signal: req.signal,
      });
    }
    return anthropicSSE;
  }

  return nonStreamHttpResponse(
    resp,
    req.protocol,
    req.stream,
    undefined,
    requestEnablesLongContext(req),
  );
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
async function handleRequestForTenant(
  req: GatewayRequest,
  config: GatewayConfig,
): Promise<Response> {
  if (!req?.rawHeaders) {
    return errorResponse(400, "Malformed request: missing headers");
  }
  if (pipelineResetInProgress) {
    return errorResponse(503, "Gateway pipeline is resetting");
  }
  streamingPostResponsesAccepting = true;
  const requestGeneration = streamingPostResponseGeneration;
  let resolveDownstreamSettled: (() => void) | undefined;
  let downstreamCancelled = false;
  const downstreamSettled = new Promise<void>((resolve) => {
    resolveDownstreamSettled = resolve;
  });
  return runActivePipelineRequest(
    req.signal,
    (signal, trackOperation, claimSession) =>
      handleRequestInner(
        { ...req, signal },
        config,
        requestGeneration,
        downstreamSettled,
        () => downstreamCancelled,
        trackOperation,
        claimSession,
      ),
    () => resolveDownstreamSettled?.(),
    () => {
      downstreamCancelled = true;
    },
    requestCredentialFingerprint(req.rawHeaders, config) ?? undefined,
  );
}

async function handleRequestInner(
  req: GatewayRequest,
  config: GatewayConfig,
  requestGeneration: number,
  downstreamSettled: Promise<void>,
  downstreamWasCancelled: () => boolean,
  trackOperation: (operation: Promise<unknown>) => void,
  claimSession: (sessionID: string) => Promise<void>,
): Promise<Response> {
  const requestStartMs = Date.now();
  const requestOrder = ++upstreamRequestOrder;
  try {
    // Guard against malformed invocations (e.g. fuzzers / direct module calls
    // that pass an undefined or header-less request). The real server path
    // always supplies a fully-formed GatewayRequest; bailing out cleanly here
    // avoids a TypeError on `req.rawHeaders` deeper in the pipeline.
    if (!req?.rawHeaders) {
      return errorResponse(400, "Malformed request: missing headers");
    }

    if (hasConflictingAuthHeaders(req.rawHeaders)) {
      return errorResponse(
        400,
        "Conflicting authentication headers: send either x-api-key or Authorization, not both",
      );
    }

    // Validate explicit provider/upstream selection before slash, side-channel,
    // compaction, and meta branches can take alternate paths. This resolver is
    // synchronous and performs no network I/O.
    try {
      resolveRequestUpstreamRoute(req, config);
    } catch (error) {
      return errorResponse(
        400,
        error instanceof Error ? error.message : "Invalid upstream route",
      );
    }

    // Preserve the process-global legacy credential only for a local,
    // header-less request to the exact configured provider base.
    const earlyAuth = extractAuth(req.rawHeaders);
    if (earlyAuth) {
      captureLegacyGlobalAuth(req, config, earlyAuth);
    }

    // --- Quick Tier-1 session lookup for structural compaction detection ---
    // O(1) header + map lookup — lets us compare message counts before routing.
    const priorState = activeSessionForKnownHeader(req, sessions, config);

    // --- Case 0: Slash command interception (/lore:*) ---
    // All /lore:* commands are intercepted here and never forwarded upstream.
    const slashResult = await handleLoreSlashCommand(
      req,
      sessions,
      config,
      claimSession,
    );
    if (slashResult) return slashResult;

    // --- Case 0.5: Claude Code side-channel → forward upstream untouched ---
    // Auto-mode permission classifier, title/topic generation, and subagent
    // namer/summary calls carry the live session's `x-claude-code-session-id`
    // but NO coding system prompt (skipSystemPromptPrefix). They must never
    // enter the pipeline: running them through it injects LTM/distilled
    // prefixes or (worse) mis-routes them to compaction — corrupting the
    // auto-mode classifier verdict and tripping Claude Code's 3-strike fallback
    // that drops auto mode back to prompting for every action. This check MUST
    // stay ahead of the structural-compaction detection below.
    if (isClaudeCodeSideChannel(req)) {
      log.info(
        `claude-code side-channel: passthrough (messages=${req.messages.length} tools=${req.tools.length} maxTokens=${req.maxTokens})`,
      );
      return await handlePassthrough(req, config);
    }

    // --- Case 1: Compaction request → intercept ---
    // Structural detection (session-aware) first, pattern matching as fallback.
    // Sub-agents now get their own sessions (separate x-session-affinity /
    // x-claude-code-agent-id), so priorState is the sub-agent's own state —
    // structural detection is safe.
    //
    // IMPORTANT: a Claude Code sub-agent still shares the parent's
    // `x-claude-code-session-id`. Before x-claude-code-agent-id was added to the
    // known-header priority (see credential-headers.ts), `activeSessionForKnownHeader`
    // resolved it to the PARENT session, whose large message count made the
    // sub-agent's short first request (1 user message + tool-schema attachments)
    // look like a structural compaction. The gateway then intercepted it and
    // returned the offline "# Session Summary" block as the sub-agent's
    // task_result. Guarding structural detection on the sub-agent signal closes
    // that hole regardless of which header resolved the session.
    const isClaudeSubagent = isClaudeCodeSubagent(req.rawHeaders);
    const structuralCompaction =
      !isClaudeSubagent && isStructuralCompaction(req, priorState);
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
      return await handleCompaction(
        req,
        config,
        requestGeneration,
        trackOperation,
        claimSession,
      );
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
    return await handleConversationTurn(
      req,
      config,
      requestOrder,
      requestGeneration,
      downstreamSettled,
      downstreamWasCancelled,
      claimSession,
    );
  } catch (err) {
    // Client disconnect / abort is benign — downgrade from error to info.
    const isAbort = err instanceof DOMException && err.name === "AbortError";
    if (isAbort) {
      log.info("pipeline aborted (client disconnect)");
      // Only surfaces to Sentry if the host was under pressure at abort time.
      captureClientAbortUnderPressure({
        startMs: requestStartMs,
        route: "request",
      });
    } else {
      // Only log fixed internal failures. Arbitrary parser/fetch messages can
      // contain upstream response content, which must never reach the log.
      const detail =
        err instanceof Error &&
        [
          "fetch failed",
          "malformed OpenAI stream event",
          "missing OpenAI finish_reason terminal",
          "missing OpenAI [DONE] terminal",
          "Upstream response has no body",
        ].includes(err.message)
          ? `: ${err.message}`
          : "";
      log.error(`pipeline request failed${detail}`);
    }
    return errorResponse(502, "Gateway request failed");
  }
}

export async function handleRequest(
  req: GatewayRequest,
  config: GatewayConfig,
): Promise<Response> {
  if (!req?.rawHeaders) return handleRequestForTenant(req, config);
  return withRequestStorageTenant(req.rawHeaders, config, () =>
    handleRequestForTenant(req, config),
  );
}
