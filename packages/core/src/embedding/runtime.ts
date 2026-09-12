/** Provider selection, health, admission, and public embed API. */

import { config } from "../config";
import * as log from "../log";
import { OwnedRetirements } from "../owned-retirements";
import {
  EmbeddingAbortError,
  type EmbeddingAbortGuard,
  EmbeddingProviderError,
  EmbeddingQueueCapacityError,
  EmbeddingRequestAbortedError,
  EmbeddingWorkerWatchdogError,
  type EmbeddingOperationOptions,
  type EmbeddingProvider,
  LocalProviderUnavailableError,
  createEmbeddingAbortGuard,
  isRecallEmbed,
  l2Normalize,
  throwIfEmbeddingAborted,
  awaitEmbeddingOperation,
} from "./contract";
import {
  localEmbeddingState,
  localProviderKnownUnavailable,
  prepareLocalProviderSelfHeal,
} from "./local";
import { EmbeddingPool } from "./pool";
import { createRemoteProvider } from "./remote";

/** Re-open provider admission after the local self-heal cadence allows a probe. */
export function maybeSelfHealEmbeddingProvider(nowMs = Date.now()): boolean {
  if (!prepareLocalProviderSelfHeal(nowMs)) return false;
  void resetProvider().catch((error: unknown) => {
    log.error("self-heal embedding worker shutdown was not confirmed", error);
  });
  return true;
}

let cachedProvider: EmbeddingProvider | null | undefined;
/** One-way process-shutdown latch. Config resets must never reopen admission. */
let providerAdmissionClosed = false;
/** Every local-provider generation remains owned until worker exit is known. */
const providerGenerations = new OwnedRetirements<object>();

function trackProviderGenerationShutdown(
  shutdown: Promise<void>,
): Promise<void> {
  return providerGenerations.track(shutdown);
}

async function settleProviderGenerations(): Promise<void> {
  await providerGenerations.settle({
    failureMessage: "embedding worker termination was not confirmed",
  });
}

export function getProvider(): EmbeddingProvider | null {
  if (providerAdmissionClosed) return null;
  if (cachedProvider !== undefined) return cachedProvider;

  const cfg = config().search.embeddings;
  if (cfg.enabled === false) {
    cachedProvider = null;
    return null;
  }

  const providerName = cfg.provider;
  const model = cfg.model;

  if (providerName === "local") {
    cachedProvider = new EmbeddingPool(model, cfg.dimensions);
  } else if (providerName === "voyage" || providerName === "openai") {
    cachedProvider = createRemoteProvider(providerName, model, cfg.dimensions);
  } else {
    log.info(`unknown embedding provider: ${String(providerName)}`);
    cachedProvider = null;
  }

  return cachedProvider;
}

/** Reset cached provider — called when config changes. */
export function resetProvider(timeoutMs?: number): Promise<void> {
  let shutdownPromise: Promise<void> = Promise.resolve();
  if (cachedProvider instanceof EmbeddingPool) {
    shutdownPromise = trackProviderGenerationShutdown(
      cachedProvider.shutdown(timeoutMs),
    );
  }
  // A config reset normally admits a fresh generation. Once process shutdown
  // owns teardown, preserve the closed latch so a late callback cannot reopen
  // the pool after shutdownProvider has snapshotted all owned generations.
  cachedProvider = providerAdmissionClosed ? null : undefined;
  return shutdownPromise;
}

/** Shut down the current provider and prevent any new provider from being created. */
export async function shutdownProvider(timeoutMs?: number): Promise<void> {
  providerAdmissionClosed = true;
  if (cachedProvider instanceof EmbeddingPool) {
    void trackProviderGenerationShutdown(cachedProvider.shutdown(timeoutMs));
  }
  cachedProvider = null; // null (not undefined) → getProvider() returns null, won't create new
  await settleProviderGenerations();
}

/** @deprecated Test compatibility alias; use {@link shutdownProvider}. */
export const _shutdownAndDisable = shutdownProvider;

/** Test-only: clear settled generation failures between isolated cases. */
export function _resetProviderShutdownTrackingForTest(): void {
  providerGenerations.reset();
}

/**
 * Save the current cached provider reference (including the live worker) and clear the cache so the next
 * `getProvider()` call creates a fresh one.
 */
export function _saveAndClearProvider(): unknown {
  const saved = {
    provider: cachedProvider,
    admissionClosed: providerAdmissionClosed,
  };
  providerAdmissionClosed = false;
  cachedProvider = undefined;
  return saved;
}

/** Restore a provider previously saved by `_saveAndClearProvider()`. */
export function _restoreProvider(token: unknown): void {
  const saved = token as {
    provider: EmbeddingProvider | null | undefined;
    admissionClosed?: boolean;
  };
  providerAdmissionClosed = saved.admissionClosed ?? false;
  cachedProvider = saved.provider;
}

export function isAvailable(): boolean {
  const provider = getProvider();
  if (!provider) return false;
  if (provider instanceof EmbeddingPool) {
    if (
      localProviderKnownUnavailable() &&
      !(
        localEmbeddingState.failureCause === "transient-init-exhausted" &&
        provider.hasHealthySlot()
      )
    ) {
      // One-time log so the user knows why vector search is degraded.
      if (!localEmbeddingState.errorLogged) {
        localEmbeddingState.errorLogged = true;
        log.info(
          "local embedding provider unavailable — recall will use FTS-only search. " +
            "To use a remote provider, set search.embeddings.provider in .lore.json.",
        );
      }
      return false;
    }
    if (localEmbeddingState.initRetryAt > 0) {
      // A proven sibling remains usable while a failed slot cools down. The
      // pool blocks replacement spawning but continues routing to that sibling.
      if (provider.hasHealthySlot()) return true;
      // A transient init failure is cooling down before its next retry.
      if (Date.now() < localEmbeddingState.initRetryAt) return false; // FTS-only until then
      // Cooldown elapsed: report available so the next embed can enter the
      // pool, which admits exactly one fresh recovery slot and clears the arm.
    }
  }
  return true;
}

/** Coarse embedding-subsystem state for health surfaces. */
export type EmbeddingHealthState =
  | "ok"
  | "retrying"
  | "unavailable"
  | "disabled";

export interface EmbeddingHealth {
  /** Whether vector recall is currently usable. */
  available: boolean;
  state: EmbeddingHealthState;
  provider: "local" | "remote" | "none";
  /** Human-readable explanation for logs / `lore doctor` / `/health`. */
  detail: string;
}

/** Read-only snapshot of embedding availability for health surfaces (`/health`, `lore doctor`). */
export function embeddingStatus(): EmbeddingHealth {
  const provider = getProvider();
  if (!provider) {
    return {
      available: false,
      state: "disabled",
      provider: "none",
      detail:
        "no embedding provider configured (or disabled) — recall uses FTS-only search",
    };
  }
  if (provider instanceof EmbeddingPool) {
    if (
      localProviderKnownUnavailable() &&
      !(
        localEmbeddingState.failureCause === "transient-init-exhausted" &&
        provider.hasHealthySlot()
      )
    ) {
      return {
        available: false,
        state: "unavailable",
        provider: "local",
        detail:
          "local embedding provider failed to initialize — recall is FTS-only (semantic search degraded)",
      };
    }
    if (localEmbeddingState.initRetryAt > 0) {
      if (provider.hasHealthySlot()) {
        return {
          available: true,
          state: "ok",
          provider: "local",
          detail:
            "local ONNX embeddings active on a healthy pool slot (failed slot retry pending)",
        };
      }
      // A transient init failure has a retry armed. This is a pure read, so —
      // unlike isAvailable() — we do NOT clear the deadline or trigger the
      // reset here; the provider is not confirmed healthy until a later embed
      // re-inits it. Report "retrying" (recall is FTS-only) for the whole
      // armed window, whether or not the cooldown has elapsed, so health checks
      // never show a false "ok" before recovery actually happens.
      return {
        available: false,
        state: "retrying",
        provider: "local",
        detail:
          "local embedding provider init failed; a retry is armed — recall is FTS-only until it recovers",
      };
    }
    return {
      available: true,
      state: "ok",
      provider: "local",
      detail: "local ONNX embeddings active (vector recall enabled)",
    };
  }
  return {
    available: true,
    state: "ok",
    provider: "remote",
    detail: "remote embedding provider active (vector recall enabled)",
  };
}

async function waitForEmbeddingRetry(
  delayMs: number,
  guard: EmbeddingAbortGuard,
): Promise<void> {
  if (delayMs <= 0) {
    throwIfEmbeddingAborted(guard);
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wait = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, delayMs);
  });
  try {
    await awaitEmbeddingOperation(wait, guard);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Await a proven local embedding worker, including bounded transient-init retries. */
export async function ensureEmbeddingReady(
  options: EmbeddingOperationOptions = {},
): Promise<void> {
  const guard = createEmbeddingAbortGuard("provider-readiness", options);
  throwIfEmbeddingAborted(guard);

  for (;;) {
    throwIfEmbeddingAborted(guard);
    const provider = getProvider();
    if (!provider) {
      throw new LocalProviderUnavailableError(
        "no embedding provider is configured",
      );
    }
    if (!(provider instanceof EmbeddingPool)) {
      throwIfEmbeddingAborted(guard);
      return;
    }
    if (
      localEmbeddingState.failureCause === "terminal" ||
      (localEmbeddingState.failureCause === "transient-init-exhausted" &&
        !provider.hasHealthySlot())
    ) {
      throw new LocalProviderUnavailableError(
        "local embedding provider is unavailable",
      );
    }
    if (provider.hasHealthySlot()) {
      throwIfEmbeddingAborted(guard);
      return;
    }

    try {
      await awaitEmbeddingOperation(
        provider.embed(["warmup"], "document"),
        guard,
      );
      throwIfEmbeddingAborted(guard);
      return;
    } catch (error) {
      if (error instanceof EmbeddingAbortError) throw error;
      // Worker watchdogs are an internal lifecycle classification. Keep the
      // public readiness contract provider-shaped so orchestration that already
      // handles an unavailable local provider does not need to know which
      // worker-owned deadline expired.
      if (error instanceof EmbeddingWorkerWatchdogError) {
        throw new LocalProviderUnavailableError(error);
      }
      if (!(error instanceof LocalProviderUnavailableError)) throw error;
      throwIfEmbeddingAborted(guard);
      if (
        localEmbeddingState.failureCause !== null ||
        localEmbeddingState.initRetryAt <= 0
      ) {
        throw error;
      }
      await waitForEmbeddingRetry(
        Math.max(0, localEmbeddingState.initRetryAt - Date.now()),
        guard,
      );
    }
  }
}

let _recallEmbedsInFlight = 0;

const EMBEDDING_ABORT_PHASES = new Set([
  "provider-readiness",
  "settle-document-embeds",
  "knowledge-backfill",
]);

function sanitizeProviderFailure(error: unknown, signal?: AbortSignal): Error {
  try {
    if (signal?.aborted) return new EmbeddingRequestAbortedError();
    if (error instanceof EmbeddingProviderError) {
      const status = error.status;
      return typeof status === "number" &&
        Number.isInteger(status) &&
        status >= 100 &&
        status <= 599
        ? new EmbeddingProviderError(
            `Embedding provider failed with HTTP ${status}`,
            status,
          )
        : new EmbeddingProviderError();
    }
    if (error instanceof EmbeddingQueueCapacityError) {
      return new EmbeddingQueueCapacityError();
    }
    if (error instanceof EmbeddingRequestAbortedError) {
      return new EmbeddingRequestAbortedError();
    }
    if (error instanceof EmbeddingWorkerWatchdogError) {
      return error.stage === "init" || error.stage === "execution"
        ? new EmbeddingWorkerWatchdogError(error.stage)
        : new EmbeddingProviderError();
    }
    if (error instanceof LocalProviderUnavailableError) {
      return new LocalProviderUnavailableError();
    }
    if (error instanceof EmbeddingAbortError) {
      const phase = error.phase;
      const code = error.code;
      return EMBEDDING_ABORT_PHASES.has(phase) &&
        (code === "aborted" || code === "deadline-exceeded")
        ? new EmbeddingAbortError(phase, code)
        : new EmbeddingProviderError();
    }
  } catch {
    // Hostile proxies/getters must not escape the privacy boundary.
  }
  return new EmbeddingProviderError();
}

/**
 * Live count of in-flight recall (single query-text) embeds — the temporal re-chunk backfill's idle
 * signal.
 */
export function recallEmbedsInFlight(): number {
  return _recallEmbedsInFlight;
}

/**
 * Test seam: force the in-flight recall-embed counter to a known value so the gateway's idle-gate wiring
 * can be exercised deterministically without driving a real (async, provider-dependent) embed.
 */
export function _setRecallEmbedsInFlightForTest(n: number): void {
  _recallEmbedsInFlight = n;
}

/** Generate embeddings for the given texts using the configured provider. */
export async function embed(
  texts: string[],
  inputType: "document" | "query",
  signal?: AbortSignal,
): Promise<Float32Array[]> {
  const provider = getProvider();
  if (!provider) throw new Error("No embedding provider available");
  return await embedWithProvider(provider, texts, inputType, signal);
}

/** Run one request against a fixed provider instance. */
export async function embedWithProvider(
  provider: EmbeddingProvider,
  texts: string[],
  inputType: "document" | "query",
  signal?: AbortSignal,
): Promise<Float32Array[]> {
  // A single-text query embed is a recall lookup (see isRecallEmbed — the same
  // predicate the worker uses for high priority). Track it in flight so the
  // temporal re-chunk backfill can yield the shared worker while recall is
  // active. The counter is decremented in `finally` so a rejected embed
  // (provider gone, OOM, timeout) can never leak a permanent "busy" that would
  // wedge the backfill forever.
  const isRecall = isRecallEmbed(texts, inputType);
  if (isRecall) _recallEmbedsInFlight++;
  try {
    const vecs = await provider.embed(texts, inputType, signal);
    // Enforce the L2-normalization invariant at the single chokepoint so the JS
    // dot-product path and sqlite-vec's vec_distance_cosine() always agree. See
    // l2Normalize() for the full rationale.
    return vecs.map(l2Normalize);
  } catch (error) {
    throw sanitizeProviderFailure(error, signal);
  } finally {
    if (isRecall) _recallEmbedsInFlight--;
  }
}
