/**
 * Chain discovery + resolve-and-apply orchestration.
 *
 * A {@link SourceStrategy} knows how to resolve a {@link PatchChain} from some
 * backing store (an OCI registry, GitHub Release assets, ...). This module ties
 * a strategy together with the offline cache, the apply core, integrity
 * verification, and progress events — with every product-specific concern
 * (version, telemetry, logging, cache location) injected.
 */

import { applyPatchChainInMemory, parsePatchHeader } from "./bspatch";
import type { PatchCache } from "./patch-cache";
import type { DeltaResult, PatchChain } from "./contract";
import { type ProgressHandler, safeProgress } from "./events";

/**
 * A source of patch chains. Given the current and target versions, resolve the
 * ordered chain of patches (oldest hop first) plus the expected final SHA-256,
 * or `null` when no usable chain exists (caller falls back to a full download).
 *
 * A source may optionally classify *why* it returned `null` by invoking the
 * `report` callback with a {@link DeltaUnavailableReason}. This is telemetry
 * only — it never changes control flow (a `null` return is always a full-
 * download fallback). It lets a consumer distinguish a benign "no patches
 * published yet" from a `malformed_chain` (a published-but-broken manifest in
 * the range), so a poisoned publish can be alerted on immediately instead of
 * silently degrading every spanning upgrade to a full download.
 */
export type SourceStrategy = {
  resolveChain(
    currentVersion: string,
    targetVersion: string,
    signal?: AbortSignal,
    report?: UnavailableReporter,
  ): Promise<PatchChain | null>;
};

/** Where a resolved chain came from, for telemetry. */
export type DeltaSource = "cache" | "network" | "offline_miss";

/**
 * Why a source could not produce a usable chain (telemetry only).
 *
 * - `no_patches` — no patch tags/assets exist in the range (benign: the
 *   channel simply has no deltas published for this hop yet).
 * - `malformed_chain` — patch tags exist in the range but the chain is broken:
 *   a manifest is missing the expected `<binaryName>` patch layer, has a bad
 *   `from-version` back-pointer, is missing its target SHA-256 annotation, or
 *   otherwise fails validation. A published-but-unusable chain — the signal a
 *   poisoned publish produces.
 * - `too_long` — the chain exceeds the max depth (deltas would cost more than a
 *   full download).
 * - `over_budget` — the cumulative patch size exceeds the size-ratio gate.
 * - `network` — a transient network failure prevented resolution.
 */
export type DeltaUnavailableReason =
  | "no_patches"
  | "malformed_chain"
  | "too_long"
  | "over_budget"
  | "network";

/** Callback a source uses to classify a `null` (no-chain) result. */
export type UnavailableReporter = (reason: DeltaUnavailableReason) => void;

/** Optional telemetry callback invoked as facts become known. */
export type DeltaTelemetry = {
  onResolved?: (info: { source: DeltaSource; chain: PatchChain }) => void;
  onOfflineMiss?: () => void;
  /**
   * Invoked when the source returns no usable chain, with the source's best
   * classification of why. Telemetry only — the caller always falls back to a
   * full download regardless of reason.
   */
  onUnavailable?: (reason: DeltaUnavailableReason) => void;
};

export type ResolveAndApplyOpts = {
  source: SourceStrategy;
  currentVersion: string;
  targetVersion: string;
  oldPath: string;
  destPath: string;
  /** Offline patch cache. When present, checked before hitting the network. */
  cache?: PatchCache;
  /** When true, never touch the network — cache hit or bust. */
  offline?: boolean;
  /** Progress events (phase/bytes/done). Never rendered by the library. */
  onProgress?: ProgressHandler;
  /** Telemetry hooks; the library stays telemetry-agnostic. */
  telemetry?: DeltaTelemetry;
  signal?: AbortSignal;
};

/**
 * Resolve a patch chain (cache-first, then the source unless offline), apply
 * it to `oldPath`, verify the SHA-256, and write the result to `destPath`.
 * Returns the {@link DeltaResult}, or `null` when no chain is usable.
 *
 * Throws only on a genuine apply/verification failure (SHA mismatch, corrupt
 * patch) — the caller treats a throw as "fall back to a full download".
 */
export async function resolveAndApply(
  opts: ResolveAndApplyOpts,
): Promise<DeltaResult | null> {
  const {
    source,
    currentVersion,
    targetVersion,
    oldPath,
    destPath,
    cache,
    offline,
    onProgress,
    telemetry,
    signal,
  } = opts;
  const progress = safeProgress(onProgress);

  // Cache first — enables fully offline upgrades.
  if (cache) {
    const cached = await tryLoadCachedChain(
      cache,
      currentVersion,
      targetVersion,
    );
    if (cached) {
      telemetry?.onResolved?.({ source: "cache", chain: cached });
      return applyChain(cached, oldPath, destPath, progress);
    }
  }

  if (offline) {
    telemetry?.onOfflineMiss?.();
    return null;
  }

  progress({ type: "phase", phase: "resolve" });
  // Let the source classify a no-chain outcome for telemetry. Default to
  // `no_patches` (the benign case) unless the source reports something more
  // specific such as `malformed_chain`.
  let unavailableReason: DeltaUnavailableReason = "no_patches";
  const report: UnavailableReporter = (reason) => {
    unavailableReason = reason;
  };
  const chain = await source.resolveChain(
    currentVersion,
    targetVersion,
    signal,
    report,
  );
  if (!chain) {
    telemetry?.onUnavailable?.(unavailableReason);
    return null;
  }

  // Persist for future offline upgrades, then apply.
  if (cache && chain.steps) {
    cache.save(chain, chain.steps).catch(() => {});
  }

  telemetry?.onResolved?.({ source: "network", chain });
  return applyChain(chain, oldPath, destPath, progress);
}

async function tryLoadCachedChain(
  cache: PatchCache,
  currentVersion: string,
  targetVersion: string,
): Promise<PatchChain | null> {
  try {
    return await cache.load(currentVersion, targetVersion);
  } catch {
    return null;
  }
}

/**
 * Apply a resolved chain, emitting apply-phase byte progress, and verify the
 * final SHA-256 against the chain's expected value.
 */
async function applyChain(
  chain: PatchChain,
  oldPath: string,
  destPath: string,
  progress: ProgressHandler,
): Promise<DeltaResult> {
  // Apply-phase progress total = SUM of every hop's declared output size
  // (each patch header's `newSize`), because `onBytes` fires for the output
  // bytes of EVERY hop — the in-memory intermediates AND the final disk write.
  // Using only the last hop's size makes a multi-hop bar hit 100% after the
  // first hop and then freeze.
  let total: number | null = 0;
  try {
    for (const patch of chain.patches) {
      total += parsePatchHeader(patch.data).newSize;
    }
  } catch {
    // Header parse is best-effort for the bar; a corrupt header is rejected
    // properly downstream. Leave the total indeterminate in that case.
    total = null;
  }

  progress({ type: "phase", phase: "apply" });
  let written = 0;
  const sha256 = await applyPatchChainInMemory(
    oldPath,
    chain.patches.map((p) => p.data),
    destPath,
    (bytes) => {
      written += bytes;
      progress({ type: "bytes", phase: "apply", written, total });
    },
  );
  progress({ type: "done", phase: "apply" });

  progress({ type: "phase", phase: "verify" });
  if (sha256 !== chain.expectedSha256) {
    throw new Error(
      `SHA-256 mismatch after patching: got ${sha256}, expected ${chain.expectedSha256}`,
    );
  }
  progress({ type: "done", phase: "verify" });

  return {
    sha256,
    patchBytes: chain.totalSize,
    chainLength: chain.patches.length,
  };
}
