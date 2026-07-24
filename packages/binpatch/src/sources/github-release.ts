/**
 * GitHub Release-asset patch source (the "stable" channel).
 *
 * Resolves a patch chain from GitHub Release assets. Each release for the
 * target platform publishes three assets:
 * - `<binaryName>`        — the binary (its digest → expected SHA-256)
 * - `<binaryName>.gz`     — gzipped binary (its size → the ratio gate)
 * - `<binaryName>.patch`  — the delta patch from the previous release
 *
 * The chain is the releases between current and target, oldest-first, capped
 * at {@link MAX_STABLE_CHAIN_DEPTH} and by {@link SIZE_THRESHOLD_RATIO}.
 *
 * All product specifics (owner/repo, binary name, user-agent, fetch) are
 * injected. Generalized from Lore's stable-channel resolver.
 */

import {
  MAX_STABLE_CHAIN_DEPTH,
  type PatchChain,
  type PatchLink,
  SIZE_THRESHOLD_RATIO,
} from "../contract";
import type { SourceStrategy } from "../discover";

const SHA256_DIGEST_PATTERN = /^sha256:([0-9a-f]+)$/i;

export type GitHubAsset = {
  name: string;
  size: number;
  digest?: string;
  browser_download_url: string;
};

export type GitHubRelease = {
  tag_name: string;
  assets: GitHubAsset[];
  body?: string;
};

/** Extract the SHA-256 hex digest from a GitHub asset's `digest` field. */
export function extractSha256(asset: GitHubAsset): string | null {
  if (!asset.digest) return null;
  const match = SHA256_DIGEST_PATTERN.exec(asset.digest);
  return match ? (match[1]?.toLowerCase() ?? null) : null;
}

/** Extract the target binary's SHA-256 from a release. */
export function getStableTargetSha256(
  release: GitHubRelease,
  binaryName: string,
): string | null {
  const binaryAsset = release.assets.find((a) => a.name === binaryName);
  if (!binaryAsset) return null;
  return extractSha256(binaryAsset);
}

export type ExtractStableChainOpts = {
  releases: GitHubRelease[];
  currentVersion: string;
  targetVersion: string;
  binaryName: string;
  fullGzSize: number;
};

export type StableChainInfo = {
  patchUrls: string[];
  expectedSha256: string;
  steps: { fromVersion: string; toVersion: string }[];
};

/**
 * Extract the chain of patch URLs from an already-fetched release list.
 * Pure computation — no HTTP.
 */
/** A stable-chain extraction failure, classified for telemetry. */
export type StableChainFailure = {
  failure: "no_patches" | "malformed_chain" | "too_long" | "over_budget";
};

function isStableChainFailure(
  v: StableChainInfo | StableChainFailure,
): v is StableChainFailure {
  return "failure" in v;
}

export function extractStableChain(
  opts: ExtractStableChainOpts,
): StableChainInfo | StableChainFailure {
  const { releases, currentVersion, targetVersion, binaryName, fullGzSize } =
    opts;
  const patchAssetName = `${binaryName}.patch`;

  const targetIdx = releases.findIndex((r) => r.tag_name === targetVersion);
  const currentIdx = releases.findIndex((r) => r.tag_name === currentVersion);
  if (targetIdx === -1 || currentIdx === -1 || targetIdx >= currentIdx) {
    // The current or target release isn't in the fetched window (or they're
    // mis-ordered) — no chain to build, not a broken one.
    return { failure: "no_patches" };
  }

  const chainReleases = releases.slice(targetIdx, currentIdx);
  if (chainReleases.length > MAX_STABLE_CHAIN_DEPTH) {
    return { failure: "too_long" };
  }

  const targetRelease = chainReleases[0];
  if (!targetRelease) return { failure: "no_patches" };
  const expectedSha256 = getStableTargetSha256(targetRelease, binaryName) ?? "";
  if (!expectedSha256) return { failure: "malformed_chain" };

  const patchUrls: string[] = [];
  let totalSize = 0;
  for (const release of chainReleases) {
    const patchAsset = release.assets.find((a) => a.name === patchAssetName);
    // A release in the range with no patch asset for this platform is a
    // published-but-broken hop — the poisoned-publish signature.
    if (!patchAsset) return { failure: "malformed_chain" };
    patchUrls.push(patchAsset.browser_download_url);
    totalSize += patchAsset.size;
    if (totalSize > fullGzSize * SIZE_THRESHOLD_RATIO) {
      return { failure: "over_budget" };
    }
  }

  // Reverse to apply order: oldest patch first.
  patchUrls.reverse();

  const reversedReleases = [...chainReleases].reverse();
  const steps: { fromVersion: string; toVersion: string }[] = [];
  let prevVersion = currentVersion;
  for (const release of reversedReleases) {
    steps.push({ fromVersion: prevVersion, toVersion: release.tag_name });
    prevVersion = release.tag_name;
  }

  return { patchUrls, expectedSha256, steps };
}

/** Configuration for {@link githubReleaseSource}. */
export type GitHubReleaseSourceConfig = {
  /** GitHub API releases URL, e.g.
   * `https://api.github.com/repos/<owner>/<repo>/releases`. */
  releasesUrl: string;
  /** Platform binary asset name, e.g. `lore-linux-x64`. */
  binaryName: string;
  /** User-Agent header for GitHub API requests. */
  userAgent: string;
  /** Injectable fetch (defaults to global `fetch`). */
  fetch?: typeof fetch;
};

/**
 * Build a {@link SourceStrategy} backed by GitHub Release assets.
 */
export function githubReleaseSource(
  config: GitHubReleaseSourceConfig,
): SourceStrategy {
  const doFetch = config.fetch ?? fetch;
  const { releasesUrl, binaryName, userAgent } = config;

  async function fetchRecentReleases(
    signal?: AbortSignal,
  ): Promise<GitHubRelease[] | null> {
    const perPage = MAX_STABLE_CHAIN_DEPTH + 2;
    let response: Response;
    try {
      response = await doFetch(`${releasesUrl}?per_page=${perPage}`, {
        headers: {
          Accept: "application/vnd.github.v3+json",
          "User-Agent": userAgent,
        },
        signal,
      });
    } catch {
      // Network failure — distinct from a genuinely empty release list.
      return null;
    }
    if (!response.ok) return null;
    return (await response.json()) as GitHubRelease[];
  }

  async function downloadPatch(
    url: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array | null> {
    let response: Response;
    try {
      response = await doFetch(url, {
        headers: { "User-Agent": userAgent },
        signal,
      });
    } catch {
      return null;
    }
    if (!response.ok) return null;
    return new Uint8Array(await response.arrayBuffer());
  }

  return {
    async resolveChain(currentVersion, targetVersion, signal, report) {
      const releases = await fetchRecentReleases(signal);
      if (releases === null) {
        report?.("network");
        return null;
      }

      const targetRelease = releases.find((r) => r.tag_name === targetVersion);
      if (!targetRelease) {
        report?.("no_patches");
        return null;
      }
      const gzAsset = targetRelease.assets.find(
        (a) => a.name === `${binaryName}.gz`,
      );
      // The target release exists but has no `.gz` asset for this platform —
      // the target publish itself is malformed for this binary.
      if (!gzAsset) {
        report?.("malformed_chain");
        return null;
      }

      const chainInfo = extractStableChain({
        releases,
        currentVersion,
        targetVersion,
        binaryName,
        fullGzSize: gzAsset.size,
      });
      if (isStableChainFailure(chainInfo)) {
        report?.(chainInfo.failure);
        return null;
      }

      const downloadResults = await Promise.all(
        chainInfo.patchUrls.map((url) => downloadPatch(url, signal)),
      );

      const patches: PatchLink[] = [];
      let totalSize = 0;
      for (const data of downloadResults) {
        // A listed patch asset failed to download — transient, not a broken
        // publish (the asset exists on the release).
        if (!data) {
          report?.("network");
          return null;
        }
        patches.push({ data, size: data.byteLength });
        totalSize += data.byteLength;
      }

      return {
        patches,
        totalSize,
        expectedSha256: chainInfo.expectedSha256,
        steps: chainInfo.steps,
      } satisfies PatchChain;
    },
  };
}
