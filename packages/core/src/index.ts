// @loreai/core — shared memory engine for Lore.
//
// This barrel re-exports every core module so hosts (the OpenCode plugin, the
// Pi extension, or any future adapter) can import from a single entry:
//
//   import { ltm, temporal, gradient, ... } from "@loreai/core"
//
// Modules that are intentionally not re-exported:
// - `db.ts` internals are exposed via specific functions (db(), ensureProject(), etc.)
// - No Plugin/Hooks surface — those live in host-specific packages.

export * as temporal from "./temporal";
export * as ltm from "./ltm";
export * as references from "./references";
export {
  DirectFsResolver,
  NoopResolver,
  SyntheticProbeResolver,
  extractReferences,
  buildRefcheckProbeScript,
  parseProbeSnapshot,
  resolveRefAgainstView,
  type Reference,
  type ReferenceResolver,
  type RefStatus,
  type RepoView,
} from "./references";
export * as syncData from "./sync-data";
export * as data from "./data";
export * as distillation from "./distillation";
export * as curator from "./curator";
export type { ChangedEntry } from "./curator";
export * as embedding from "./embedding";
export * as embeddingVendor from "./embedding-vendor";
export * as latReader from "./lat-reader";
export * as entities from "./entities";
export * as entityRebuild from "./entity-rebuild";
export * as patternExtract from "./pattern-extract";
export * as instructionDetect from "./instruction-detect";
export * as log from "./log";
export * as conversationImport from "./import";

export {
  runRecall,
  searchRecall,
  recallById,
  RECALL_TOOL_DESCRIPTION,
  RECALL_PARAM_DESCRIPTIONS,
  type RecallInput,
  type RecallResult,
  type RecallScope,
  type ScoredDistillation,
  type TaggedResult,
  type ScoredTaggedResult,
} from "./recall";

export type {
  LoreMessage,
  LoreUserMessage,
  LoreAssistantMessage,
  LorePart,
  LoreTextPart,
  LoreReasoningPart,
  LoreToolPart,
  LoreGenericPart,
  LoreContentBlock,
  LoreToolState,
  LoreToolStatePending,
  LoreToolStateRunning,
  LoreToolStateCompleted,
  LoreToolStateError,
  LoreMessageWithParts,
  LLMClient,
} from "./types";
export { isTextPart, isReasoningPart, isToolPart } from "./types";

export { dataDir } from "./data-dir";
export { load, config, type LoreConfig } from "./config";
export {
  db,
  dbPath,
  ensureProject,
  getLastImportAt,
  setLastImportAt,
  isFirstRun,
  projectId,
  projectName,
  projectPath,
  projectGitRemote,
  resolveProjectByRemoteOrPath,
  mergeProjectInternal,
  UNATTRIBUTED_PROJECT_PREFIX,
  isUnattributedProjectPath,
  loadForceMinLayer,
  saveForceMinLayer,
  saveSessionCosts,
  loadSessionCosts,
  loadAllSessionCosts,
  type SessionCostSnapshot,
  addDailyCost,
  getDailyCostTotals,
  getDailyCostForDay,
  type DailyCostBucket,
  saveSessionTracking,
  loadSessionTracking,
  findSessionStatesByFingerprint,
  countMatchingTemporalIds,
  appendSessionPromptDelta,
  upsertSessionPromptDelta,
  deleteSessionPromptDelta,
  listSessionPromptDeltas,
  updateSessionPromptDeltaSelector,
  recordCacheBustObservation,
  getCacheBustStats,
  summarizeCacheBustStats,
  type CacheBustStat,
  type CacheBustSummary,
  loadHeaderSessionIndex,
  loadParentChildMap,
  type SessionTrackingState,
  type LoadedSessionTracking,
  type SessionPromptDelta,
  getKV,
  setKV,
  getTeamConfig,
  setTeamConfig,
  deleteTeamConfig,
  getAllTeamConfig,
  getMeta,
  setMeta,
  getInstanceId,
  runUpsert,
  withTransaction,
  close,
} from "./db";
export {
  normalizeRemoteUrl,
  getGitRemote,
  clearGitRemoteCache,
  getGitUser,
  clearGitUserCache,
} from "./git";
export {
  enableHostedMode,
  isHostedMode,
  _resetHostedModeForTest,
} from "./hosted";
export {
  transform,
  setModelLimits,
  setMaxLayer0Tokens,
  computeLayer0Cap,
  setCachePricing,
  getCachePricing,
  shouldCompress,
  getTier,
  recordCacheUsage,
  exportDedupDecisions,
  importDedupDecisions,
  needsUrgentDistillation,
  calibrate,
  setLtmTokens,
  getLtmTokens,
  getLtmBudget,
  getPreferenceLtmBudget,
  setForceMinLayer,
  getLastTransformedCount,
  getLastTransformEstimate,
  getLastLayer,
  toolStripAnnotation,
  onIdleResume,
  getLastTurnAt,
  consumeCameOutOfIdle,
  saveGradientState,
  evictSession,
  // Test-only — exposed at the barrel so host-package tests can simulate idle
  // gaps without sleeping. Not part of the public API.
  setLastTurnAtForTest,
  setConsecutiveBustsForTest,
  setTransformCountForTest,
  inspectSessionState,
  getConsecutiveBusts,
  BUST_PRESSURE_THRESHOLD,
  DEEP_IDLE_MS,
  COLD_START_GRACE_TURNS,
  effectiveMetaThreshold,
  isLargeColdStart,
  setCacheSizeSnapshot,
  computeCompressedCacheSize,
  evaluateCacheStrategy,
  getCacheStrategy,
  getCacheSizeSnapshot,
  // #797: bust-spiral alerting hook. The gateway registers this once at
  // startup (`setupBustSpiralCapture`) to surface cache-bust spirals to Sentry
  // (cold-start info-breadcrumb + past-grace error alert + recovery breadcrumb).
  setBustSpiralHook,
} from "./gradient";
export type {
  CacheSurvivalInputs,
  CacheBustCause,
  BustSpiralInfo,
  BustSpiralHook,
} from "./gradient";
export {
  formatKnowledge,
  formatKnowledgeDelta,
  shortId,
  DELTA_MAX_ENTRIES,
  DELTA_TOKEN_BUDGET,
  formatDistillations,
  DISTILLATION_SYSTEM,
  distillationUser,
  RECURSIVE_SYSTEM,
  recursiveUser,
  CURATOR_SYSTEM,
  curatorUser,
  CONSOLIDATION_SYSTEM,
  consolidationUser,
  QUERY_EXPANSION_SYSTEM,
  COMPACT_SUMMARY_TEMPLATE,
  buildCompactPrompt,
} from "./prompt";
export type { DeltaOp, DeltaEntry } from "./prompt";
export {
  shouldImport,
  importFromFile,
  exportToFile,
  exportLoreFile,
  exportInlineToAgentsFile,
  deleteLoreFile,
  removeLoreSectionFromFile,
  importLoreFile,
  shouldImportLoreFile,
  loreFileExists,
  clearLoreFileCache,
  importLoreFileAs,
  LORE_FILE,
} from "./agents-file";
export {
  discoverWorkspaceRoot,
  resolveWorkspaces,
  clearWorkspaceCache,
} from "./workspace";
export { workerSessionIDs, isWorkerSession } from "./worker";
export { distillLimiter, curatorLimiter } from "./session-limiter";
export {
  installFetchInterceptor,
  getOriginalFetch,
  shouldIntercept,
  type FetchInterceptorConfig,
} from "./fetch-interceptor";
export * as workerModel from "./worker-model";
export {
  ftsQuery,
  ftsQueryOr,
  ftsQueryRelaxed,
  EMPTY_QUERY,
  reciprocalRankFusion,
  expandQuery,
  extractTopTerms,
  exactTermMatchRank,
} from "./search";
export {
  serialize,
  inline,
  h,
  p,
  ul,
  lip,
  liph,
  t,
  root,
  strong,
  normalize,
  sanitizeSurrogates,
  unescapeMarkdown,
  renderMarkdown,
} from "./markdown";
export {
  decideCacheStrategy,
  strategyWantsWarming,
  strategyWantsCompaction,
  estimateMetaDistillCostPerCall,
} from "./cache-economics";
export type {
  CacheStrategy,
  CacheEconomicsInput,
  CacheEconomicsResult,
} from "./cache-economics";
