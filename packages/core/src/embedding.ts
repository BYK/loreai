/**
 * Public embedding facade.
 *
 * Implementation is split by responsibility so lifecycle ownership, search,
 * document writes, and migrations/backfills can evolve independently without
 * changing the long-standing public API imported by core and gateway callers.
 */

export {
  EmbeddingAbortError,
  EmbeddingQueueCapacityError,
  EmbeddingRequestAbortedError,
  EmbeddingWorkerWatchdogError,
  LocalProviderUnavailableError,
  awaitWorkerShutdown,
  l2Normalize,
} from "./embedding/contract";
export type {
  EmbeddingAbortCode,
  EmbeddingAbortPhase,
  EmbeddingOperationOptions,
  EmbeddingProvider,
  ShutdownableWorker,
} from "./embedding/contract";

export {
  _getLocalInitRetryAtForTest,
  _markLocalProviderUnavailable,
  _persistEmbedCap,
  _readPersistedEmbedCap,
  _resetLocalProviderProbe,
  _setConstrainedMemoryForTest,
  _setContainerFreeForTest,
  _setLocalInitCooldownMsForTest,
  _setLocalInitRetryAtForTest,
  _setTestWorkerFactory,
  computeInitRetryDelayMs,
  setEmbeddingFailureHook,
} from "./embedding/local";
export type { EmbeddingFailureInfo } from "./embedding/local";

export {
  _configuredBackfillCpuDuty,
  _configuredEmbedPoolSize,
  _setEmbedPoolSizeForTest,
  _setEmbeddingWorkerWatchdogsForTest,
  _setPoolFreememForTest,
} from "./embedding/pool";

export {
  _resetProviderShutdownTrackingForTest,
  _restoreProvider,
  _saveAndClearProvider,
  _setRecallEmbedsInFlightForTest,
  _shutdownAndDisable,
  embed,
  embeddingStatus,
  ensureEmbeddingReady,
  isAvailable,
  maybeSelfHealEmbeddingProvider,
  recallEmbedsInFlight,
  resetProvider,
  shutdownProvider,
} from "./embedding/runtime";
export type {
  EmbeddingHealth,
  EmbeddingHealthState,
} from "./embedding/runtime";

export { pickRemoteFallback } from "./embedding/remote";

export {
  embedDistillation,
  embedEntity,
  embedInTokenBatches,
  embedKnowledgeEntry,
  settleDocumentEmbeds,
  warmupEmbedding,
} from "./embedding/documents";
export { MAX_TEMPORAL_CHUNKS_PER_MESSAGE } from "./embedding-units";

export {
  vectorSearch,
  vectorSearchAllDistillations,
  vectorSearchDistillations,
  vectorSearchEntities,
  vectorSearchTemporal,
} from "./embedding/search";

export {
  backfillDistillationEmbeddings,
  backfillEmbeddings,
  backfillEntityEmbeddings,
  backfillTemporalEmbeddings,
  checkConfigChange,
  formatTemporalRechunkProgress,
  maybeCutoverToVec0,
  resetTemporalRechunkProgress,
  runStartupBackfill,
} from "./embedding/backfill";
export type { BackfillOptions, BackfillStats } from "./embedding/backfill";

export {
  cosineSimilarity,
  fromBlob,
  toBlob,
  type DistillationVectorHit,
  type VectorHit,
} from "./vector-query";
