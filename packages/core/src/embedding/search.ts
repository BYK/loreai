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
import { currentTenantId } from "../tenant";
import { recordVecReadLatency } from "../vec-latency";
import {
  runVectorQuery,
  type DistillationVectorHit,
  type VectorHit,
  type VectorQuerySpec,
} from "../vector-query";
import { tryPoolVectorSearch, VECTOR_SEARCH_TIMED_OUT } from "../vector-pool";

async function poolOrInProcess(
  spec: VectorQuerySpec,
  queryEmbedding: Float32Array,
): Promise<VectorHit[] | DistillationVectorHit[]> {
  const started = performance.now();
  const cohort = resolveReadMode(readStorageMode(db()), isVecAvailable());
  try {
    const pooled = await tryPoolVectorSearch(spec, queryEmbedding);
    // Never repeat a timed-out worker scan on the event loop.
    if (pooled === VECTOR_SEARCH_TIMED_OUT) return [];
    if (pooled !== null) return pooled;

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
): Promise<VectorHit[]> {
  return poolOrInProcess(
    {
      kind: "knowledge",
      tenantId: currentTenantId(),
      limit,
      excludeCategories,
    },
    queryEmbedding,
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
): Promise<VectorHit[]> {
  return poolOrInProcess(
    { kind: "distillations", tenantId: currentTenantId(), limit },
    queryEmbedding,
  );
}

export async function vectorSearchAllDistillations(
  queryEmbedding: Float32Array,
  projectId: string,
  limit = 20,
): Promise<DistillationVectorHit[]> {
  return (await poolOrInProcess(
    { kind: "allDistillations", projectId, limit },
    queryEmbedding,
  )) as DistillationVectorHit[];
}

export async function vectorSearchTemporal(
  queryEmbedding: Float32Array,
  projectId: string,
  limit = 10,
  sessionId?: string,
): Promise<VectorHit[]> {
  return poolOrInProcess(
    { kind: "temporal", projectId, limit, sessionId },
    queryEmbedding,
  );
}
