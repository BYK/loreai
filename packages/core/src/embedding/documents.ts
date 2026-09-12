/** Best-effort document embedding and token-batched write operations. */

import { db } from "../db";
import { storeEmbedding } from "../db/vec-store";
import { config } from "../config";
import * as log from "../log";
import { nextEmbeddingBatch } from "./batching";
import {
  EmbeddingAbortError,
  EmbeddingQueueCapacityError,
  LocalProviderUnavailableError,
  awaitEmbeddingOperation,
  createEmbeddingAbortGuard,
  throwIfEmbeddingAborted,
  type EmbeddingOperationOptions,
} from "./contract";
import { EmbeddingPool, embeddingOperationKey } from "./pool";
import { embed, embedWithProvider, getProvider, isAvailable } from "./runtime";

// ---------------------------------------------------------------------------
// Fire-and-forget embedding
// ---------------------------------------------------------------------------

// Fire-and-forget document embeds (knowledge, distillation, entity) must not
// block the write path, so callers don't await them. They are tracked here so
// callers can drain them: at the test boundary (a promise that resolves AFTER
// the harness closes/swaps the DB would otherwise write to the wrong DB or log
// spurious errors — issue #885), and on graceful gateway shutdown (a
// distillation embed still mid-flight when the worker is torn down never writes
// its `distillation_vec` row → silent recall degradation on short/fast
// sessions — issue #1331).
const _docEmbedsInFlight = new Set<Promise<unknown>>();
function trackDocEmbed(p: Promise<unknown>): void {
  _docEmbedsInFlight.add(p);
  void p.finally(() => _docEmbedsInFlight.delete(p));
}

function isExpectedBestEffortEmbeddingError(error: unknown): boolean {
  return (
    error instanceof LocalProviderUnavailableError ||
    error instanceof EmbeddingQueueCapacityError
  );
}

/** Await all in-flight fire-and-forget document embeds (knowledge / distillation / entity). */
export async function settleDocumentEmbeds(
  timeoutOrOptions?: number | EmbeddingOperationOptions,
): Promise<void> {
  const legacyBestEffort = typeof timeoutOrOptions === "number";
  const options: EmbeddingOperationOptions = legacyBestEffort
    ? {
        deadlineMs: Number.isFinite(timeoutOrOptions)
          ? Math.max(0, timeoutOrOptions)
          : 0,
      }
    : (timeoutOrOptions ?? {});
  const guard = createEmbeddingAbortGuard("settle-document-embeds", options);

  try {
    while (_docEmbedsInFlight.size > 0) {
      throwIfEmbeddingAborted(guard);
      // Loop so embeds spawned mid-drain are picked up. An opted-in signal or
      // deadline stops waiting promptly; already-running embeds remain tracked
      // and can be drained by a later shutdown call.
      await awaitEmbeddingOperation(
        Promise.allSettled(_docEmbedsInFlight).then(() => undefined),
        guard,
      );
    }
    throwIfEmbeddingAborted(guard);
  } catch (error) {
    // Preserve the historical shutdown contract: the numeric form is a
    // best-effort bounded drain that resolves at timeout. The options form is
    // the typed lint/orchestration API and throws on abort/deadline.
    if (
      legacyBestEffort &&
      error instanceof EmbeddingAbortError &&
      error.code === "deadline-exceeded"
    ) {
      return;
    }
    throw error;
  }
}

function embedDocument(
  table: "knowledge" | "entities" | "distillations",
  id: string,
  text: string,
  label: string,
): void {
  if (!isAvailable()) return;
  trackDocEmbed(
    embed([text], "document")
      .then(([vector]) => storeEmbedding(db(), table, id, vector))
      .catch((error) => {
        if (!isExpectedBestEffortEmbeddingError(error))
          log.error(`embedding failed for ${label}`, id, ":", error);
      }),
  );
}

export function embedKnowledgeEntry(
  id: string,
  title: string,
  content: string,
): void {
  embedDocument("knowledge", id, `${title}\n${content}`, "knowledge entry");
}

export function embedEntity(
  id: string,
  canonicalName: string,
  aliasValues: string[],
): void {
  const seen = new Set<string>();
  const parts = [canonicalName, ...aliasValues]
    .map((value) => value.trim())
    .filter((value) => {
      const key = value.toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const text = parts.join(" ");
  if (text) embedDocument("entities", id, text, "entity");
}

export function embedDistillation(id: string, observations: string): void {
  embedDocument("distillations", id, observations, "distillation");
}

/**
 * Pay the local ONNX model's cold-load cost (~21s measured) up front by firing one throwaway embed at
 * gateway startup, so the FIRST real distillation embed of the session is already warm and finishes
 * within the turn instead of racing teardown (#1331).
 */
export function warmupEmbedding(): void {
  if (!isAvailable()) return;
  if (config().search.embeddings.provider !== "local") return;
  void embed(["warmup"], "document").catch((err) => {
    if (isExpectedBestEffortEmbeddingError(err)) return;
    log.error("embedding warmup failed:", err);
  });
}

/** Hard cap on how many vec0 chunks a single temporal message may fan out to. */
export { MAX_TEMPORAL_CHUNKS_PER_MESSAGE } from "../embedding-units";

/**
 * Embed `texts` in token-area-bounded sub-batches (via {@link nextBatch}) and return the vectors in
 * input order.
 */
export async function embedInTokenBatches(
  texts: string[],
  inputType: "document" | "query",
  signal?: AbortSignal,
): Promise<Float32Array[]> {
  const provider = getProvider();
  if (!provider) throw new Error("No embedding provider available");
  const localPool =
    provider instanceof EmbeddingPool && signal ? provider : undefined;
  const checkpointKey = localPool
    ? embeddingOperationKey(texts, inputType)
    : undefined;
  const checkpoint =
    localPool && checkpointKey
      ? localPool.takeTokenBatchCheckpoint(checkpointKey)
      : undefined;
  const items = texts.map((text) => ({ text }));
  const out = checkpoint?.vectors ?? [];
  let nextIndex = checkpoint?.nextIndex ?? 0;
  try {
    while (nextIndex < items.length) {
      const batch = nextEmbeddingBatch(items, nextIndex);
      const vecs = await embedWithProvider(
        provider,
        batch.map((b) => b.text),
        inputType,
        signal,
      );
      if (vecs.length !== batch.length) {
        throw new Error(
          "embedding provider returned an unexpected vector count",
        );
      }
      out.push(...vecs);
      nextIndex += batch.length;
    }
    return out;
  } catch (error) {
    if (localPool && checkpointKey && nextIndex > 0) {
      localPool.storeTokenBatchCheckpoint(checkpointKey, nextIndex, out);
    }
    throw error;
  }
}
