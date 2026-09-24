/** Vector-search orchestration for embedding-backed recall. */

import { performance } from "node:perf_hooks";
import { db, getKV } from "../db";
import { isVecAvailable } from "../db/vec";
import {
  readStorageMode,
  resolveReadMode,
  TEMPORAL_PARTITION_MODE_KEY,
} from "../db/vec-store";
import * as log from "../log";
import { ReadPreparationUnavailableError } from "../read-offload";
import { currentTenantId } from "../tenant";
import { recordVecReadLatency } from "../vec-latency";
import {
  runVectorQuery,
  type DistillationVectorHit,
  type VectorHit,
  type VectorQuerySpec,
} from "../vector-query";
import {
  inProcessReadFallbackForTest,
  type ReadPoolRequestOptions,
  tryPoolVectorSearch,
  VECTOR_SEARCH_PRESSURED,
  VECTOR_SEARCH_TIMED_OUT,
} from "../vector-pool";

type VectorSearchOptions = ReadPoolRequestOptions & {
  /** Lets a background caller distinguish refused admission from a real
   * empty result, without changing the optional-read policy for others. */
  onPressure?: () => void;
};

async function poolOrInProcess(
  spec: VectorQuerySpec,
  queryEmbedding: Float32Array,
  failurePhase?: ReadPreparationUnavailableError["phase"],
  options?: VectorSearchOptions,
): Promise<VectorHit[] | DistillationVectorHit[]> {
  const started = performance.now();
  const cohort = resolveReadMode(readStorageMode(db()), isVecAvailable());
  try {
    const pooled = await tryPoolVectorSearch(spec, queryEmbedding, options);
    // Never repeat a timed-out worker scan on the event loop.
    if (pooled === VECTOR_SEARCH_TIMED_OUT) {
      if (failurePhase)
        throw new ReadPreparationUnavailableError(failurePhase, "timeout");
      return [];
    }
    if (pooled === VECTOR_SEARCH_PRESSURED) {
      // An observer must not turn an optional-read refusal into an exception.
      try {
        options?.onPressure?.();
      } catch {
        // Keep the normal pressure policy even if a caller's observer fails.
      }
      if (failurePhase)
        throw new ReadPreparationUnavailableError(failurePhase, "pressure");
      return [];
    }
    if (pooled !== null) return pooled;
    if (!inProcessReadFallbackForTest()) {
      if (failurePhase)
        throw new ReadPreparationUnavailableError(failurePhase, "unavailable");
      return [];
    }

    const readMode = resolveReadMode(readStorageMode(db()), isVecAvailable());
    const temporalPartitionMode =
      spec.kind === "temporal" ? getKV(TEMPORAL_PARTITION_MODE_KEY) : null;
    try {
      return runVectorQuery(
        db(),
        readMode,
        queryEmbedding,
        spec,
        temporalPartitionMode,
      );
    } catch (error) {
      if (failurePhase)
        throw new ReadPreparationUnavailableError(failurePhase, "unavailable");
      // Native vec0 failures degrade this recall to FTS rather than crashing.
      log.error("in-process vector search failed; returning empty:", error);
      return [];
    }
  } finally {
    recordVecReadLatency(cohort, performance.now() - started);
  }
}

export async function vectorSearch(
  queryEmbedding: Float32Array,
  limit = 10,
  excludeCategories?: string[],
  selectionPhase?: ReadPreparationUnavailableError["phase"],
  options?: ReadPoolRequestOptions,
): Promise<VectorHit[]> {
  return poolOrInProcess(
    {
      kind: "knowledge",
      tenantId: currentTenantId(),
      limit,
      excludeCategories,
    },
    queryEmbedding,
    selectionPhase,
    options,
  );
}

export async function vectorSearchEntities(
  queryEmbedding: Float32Array,
  limit = 10,
): Promise<VectorHit[]> {
  return poolOrInProcess(
    { kind: "entities", tenantId: currentTenantId(), limit },
    queryEmbedding,
  );
}

export async function vectorSearchDistillations(
  queryEmbedding: Float32Array,
  limit = 10,
  selectionPhase?: ReadPreparationUnavailableError["phase"],
  options?: ReadPoolRequestOptions,
): Promise<VectorHit[]> {
  return poolOrInProcess(
    { kind: "distillations", tenantId: currentTenantId(), limit },
    queryEmbedding,
    selectionPhase,
    options,
  );
}

export async function vectorSearchAllDistillations(
  queryEmbedding: Float32Array,
  projectId: string,
  limit = 20,
  options?: VectorSearchOptions,
): Promise<DistillationVectorHit[]> {
  return (await poolOrInProcess(
    { kind: "allDistillations", projectId, limit },
    queryEmbedding,
    undefined,
    options,
  )) as DistillationVectorHit[];
}

export async function vectorSearchTemporal(
  queryEmbedding: Float32Array,
  projectId: string,
  limit = 10,
  sessionId?: string,
  selectionPhase?: ReadPreparationUnavailableError["phase"],
  options?: ReadPoolRequestOptions,
): Promise<VectorHit[]> {
  return poolOrInProcess(
    { kind: "temporal", projectId, limit, sessionId },
    queryEmbedding,
    selectionPhase,
    options,
  );
}
