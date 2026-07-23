/**
 * Delta Upgrade Glue
 *
 * Thin gateway-side glue over `binpatch`'s chain discovery + apply. All the
 * generic delta machinery (chain resolution from GHCR / GitHub Releases, the
 * offline cache, apply + SHA verification, progress) lives in `binpatch`; this
 * module only injects Lore-specific product values (version, binary name,
 * GHCR/Release coordinates, user-agent, cache location, Sentry telemetry) and
 * decides the channel.
 *
 * Falls back to a full download when no usable chain exists or any error
 * occurs.
 */

import {
  compareVersions,
  GITHUB_RELEASES_URL,
  getPatchCache,
  getPlatformBinaryName,
  getUserAgent,
  isDowngrade,
  isNightlyVersion,
} from "./binary";
import { GHCR_REGISTRY, GHCR_REPO } from "./ghcr";
import {
  type DeltaResult,
  type DeltaSource,
  ghcrSource,
  githubReleaseSource,
  resolveAndApply,
  type SourceStrategy,
} from "binpatch";
import { spanDeltaUpgrade } from "../../sentry";
import { VERSION } from "../version";

export type { DeltaResult, PatchChain } from "binpatch";

// ---------------------------------------------------------------------------
// Pre-flight check
// ---------------------------------------------------------------------------

/**
 * Check whether a delta upgrade can be attempted.
 */
export function canAttemptDelta(targetVersion: string): boolean {
  if (VERSION === "dev" || VERSION === "0.0.0-dev") {
    return false;
  }

  // Cross-channel upgrades are rare one-off operations; skip delta.
  if (isNightlyVersion(VERSION) !== isNightlyVersion(targetVersion)) {
    return false;
  }

  if (isDowngrade(VERSION, targetVersion)) {
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Source construction (inject Lore product values into binpatch sources)
// ---------------------------------------------------------------------------

/** Build the GHCR (nightly) source for the current platform binary. */
function nightlySource(): SourceStrategy {
  return ghcrSource({
    registry: GHCR_REGISTRY,
    repo: GHCR_REPO,
    userAgent: getUserAgent(),
    binaryName: getPlatformBinaryName(),
    targetTag: (version) => `nightly-${version}`,
    compareVersions,
  });
}

/** Build the GitHub Release (stable) source for the current platform binary. */
function stableSource(): SourceStrategy {
  return githubReleaseSource({
    releasesUrl: GITHUB_RELEASES_URL,
    binaryName: getPlatformBinaryName(),
    userAgent: getUserAgent(),
  });
}

function sourceForChannel(channel: "nightly" | "stable"): SourceStrategy {
  return channel === "nightly" ? nightlySource() : stableSource();
}

// ---------------------------------------------------------------------------
// Main entry point: attempt delta upgrade
// ---------------------------------------------------------------------------

/**
 * Attempt to download and apply delta patches instead of a full binary.
 *
 * This is the main entry point called by `downloadBinaryToTemp()` in the
 * upgrade module. Falls back gracefully to null on any failure.
 */
export async function attemptDeltaUpgrade(
  targetVersion: string,
  oldBinaryPath: string,
  destPath: string,
  offline?: boolean,
): Promise<DeltaResult | null> {
  if (!canAttemptDelta(targetVersion)) {
    return null;
  }

  const channel = isNightlyVersion(targetVersion) ? "nightly" : "stable";

  // Wrap the attempt in a `lore.upgrade.delta` span recording the same decision
  // points Sentry CLI captures (result/source/patch_bytes/chain_length). The
  // report callback is filled in as facts become known.
  return spanDeltaUpgrade(
    { channel, fromVersion: VERSION, toVersion: targetVersion },
    async (report) => {
      // Record where the chain resolved from so the final "ok" report can
      // attribute cache vs network; `offline_miss` is reported directly.
      let resolvedSource: DeltaSource | undefined;
      try {
        const result = await resolveAndApply({
          source: sourceForChannel(channel),
          currentVersion: VERSION,
          targetVersion,
          oldPath: oldBinaryPath,
          destPath,
          cache: getPatchCache(),
          offline,
          telemetry: {
            onResolved: (info) => {
              resolvedSource = info.source;
            },
            onOfflineMiss: () => {
              report({
                channel,
                fromVersion: VERSION,
                toVersion: targetVersion,
                source: "offline_miss",
                result: "unavailable",
              });
            },
          },
        });

        if (result === null) {
          report({
            channel,
            fromVersion: VERSION,
            toVersion: targetVersion,
            result: "unavailable",
          });
        } else {
          report({
            channel,
            fromVersion: VERSION,
            toVersion: targetVersion,
            source: resolvedSource,
            result: "ok",
            patchBytes: result.patchBytes,
            chainLength: result.chainLength,
            sha256: result.sha256,
          });
        }
        return result;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        report({
          channel,
          fromVersion: VERSION,
          toVersion: targetVersion,
          result: "error",
          errorMessage: msg,
        });
        console.error(
          `[lore] Delta upgrade failed (${msg}), falling back to full download`,
        );
        return null;
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Patch pre-fetching (called during background version checks)
// ---------------------------------------------------------------------------

async function prefetchAndCache(
  targetVersion: string,
  source: SourceStrategy,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!canAttemptDelta(targetVersion) || signal?.aborted) {
    return;
  }

  const chain = await source.resolveChain(VERSION, targetVersion, signal);
  if (!chain?.steps || signal?.aborted) {
    return;
  }

  await getPatchCache().save(chain, chain.steps);
}

/** Pre-fetch nightly delta patches for a future upgrade. */
export function prefetchNightlyPatches(
  targetVersion: string,
  signal?: AbortSignal,
): Promise<void> {
  return prefetchAndCache(targetVersion, nightlySource(), signal);
}

/** Pre-fetch stable delta patches for a future upgrade. */
export function prefetchStablePatches(
  targetVersion: string,
  signal?: AbortSignal,
): Promise<void> {
  return prefetchAndCache(targetVersion, stableSource(), signal);
}
