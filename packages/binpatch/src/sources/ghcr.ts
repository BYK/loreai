/**
 * GHCR / OCI patch source (the "nightly" channel).
 *
 * Resolves a patch chain from OCI patch-manifest tags. Patches are published
 * under `<patchTagPrefix><version>` tags whose manifests carry:
 * - annotation `from-version=<prev>` — the chain back-pointer
 * - annotation `sha256-<binaryName>=<hex>` — the target's uncompressed SHA-256
 * - a patch layer whose title is `<binaryName>.patch`
 *
 * The target binary's gzipped size (for the ratio gate) is read from the
 * target's own image manifest (its `<binaryName>.gz` layer). All product
 * specifics — registry, repo, user-agent, binary name, the version→target-tag
 * scheme, and version comparison — are injected. Generalized from Lore's
 * nightly-channel resolver.
 */

import {
  MAX_NIGHTLY_CHAIN_DEPTH,
  PATCH_TAG_PREFIX,
  type PatchChain,
  type PatchLink,
  SIZE_THRESHOLD_RATIO,
} from "../contract";
import type { SourceStrategy } from "../discover";
import { BinpatchError } from "../errors";
import { OciClient, type OciClientConfig, type OciManifest } from "./oci";

export function getPatchFromVersion(manifest: OciManifest): string | null {
  return manifest.annotations?.["from-version"] ?? null;
}

export function getPatchTargetSha256(
  manifest: OciManifest,
  binaryName: string,
): string | null {
  return manifest.annotations?.[`sha256-${binaryName}`] ?? null;
}

/**
 * Filter patch tags to those in the upgrade chain (current, target], sorted in
 * apply order by `compareVersions`.
 */
export function filterAndSortChainTags(
  allTags: string[],
  currentVersion: string,
  targetVersion: string,
  compareVersions: (a: string, b: string) => -1 | 0 | 1,
): string[] {
  const chainTags: { tag: string; version: string }[] = [];

  for (const tag of allTags) {
    const version = tag.slice(PATCH_TAG_PREFIX.length);
    if (
      compareVersions(version, currentVersion) === 1 &&
      compareVersions(version, targetVersion) !== 1
    ) {
      chainTags.push({ tag, version });
    }
  }
  chainTags.sort((a, b) => compareVersions(a.version, b.version));
  return chainTags.map((t) => t.tag);
}

type ChainStepResult =
  | { ok: true; digest: string; size: number }
  | { ok: false };

export function validateChainStep(
  manifest: OciManifest,
  opts: { expectedFrom: string; patchLayerName: string; sizeLimit: number },
): ChainStepResult {
  const fromVersion = getPatchFromVersion(manifest);
  if (fromVersion !== opts.expectedFrom) {
    return { ok: false };
  }

  const layer = manifest.layers.find(
    (l) =>
      l.annotations?.["org.opencontainers.image.title"] === opts.patchLayerName,
  );
  if (!layer) return { ok: false };
  if (layer.size > opts.sizeLimit) return { ok: false };

  return { ok: true, digest: layer.digest, size: layer.size };
}

type NightlyChainValidation = {
  digests: string[];
  totalSize: number;
  expectedSha256: string;
};

type ValidateChainOpts = {
  manifests: OciManifest[];
  chainTags: string[];
  currentVersion: string;
  targetVersion: string;
  patchLayerName: string;
  binaryName: string;
  fullGzSize: number;
};

function validateNightlyChain(
  opts: ValidateChainOpts,
): NightlyChainValidation | null {
  const {
    manifests,
    chainTags,
    currentVersion,
    targetVersion,
    patchLayerName,
    binaryName,
    fullGzSize,
  } = opts;
  const digests: string[] = [];
  let totalSize = 0;
  let prevVersion = currentVersion;

  for (let i = 0; i < manifests.length; i++) {
    const manifest = manifests[i];
    const tag = chainTags[i];
    if (!(manifest && tag)) return null;

    const remainingBudget = fullGzSize * SIZE_THRESHOLD_RATIO - totalSize;
    const result = validateChainStep(manifest, {
      expectedFrom: prevVersion,
      patchLayerName,
      sizeLimit: remainingBudget,
    });
    if (!result.ok) return null;

    digests.push(result.digest);
    totalSize += result.size;
    prevVersion = tag.slice(PATCH_TAG_PREFIX.length);

    if (i === manifests.length - 1) {
      if (prevVersion !== targetVersion) return null;
      const sha256 = getPatchTargetSha256(manifest, binaryName) ?? "";
      if (!sha256) return null;
      return { digests, totalSize, expectedSha256: sha256 };
    }
  }

  return null;
}

/** Configuration for {@link ghcrSource}. */
export type GhcrSourceConfig = OciClientConfig & {
  /** Platform binary name, e.g. `lore-linux-x64` (used for layer/annotation keys). */
  binaryName: string;
  /**
   * Map a target version to the OCI tag of its full image manifest, whose
   * `<binaryName>.gz` layer size feeds the ratio gate, e.g.
   * `(v) => `nightly-${v}``.
   */
  targetTag: (version: string) => string;
  /** Version comparator (semver-aware), for ordering patch tags. */
  compareVersions: (a: string, b: string) => -1 | 0 | 1;
};

/**
 * Build a {@link SourceStrategy} backed by OCI patch-manifest tags (GHCR).
 */
export function ghcrSource(config: GhcrSourceConfig): SourceStrategy {
  const { binaryName, targetTag, compareVersions } = config;
  const client = new OciClient(config);
  const patchLayerName = `${binaryName}.patch`;

  async function resolveNightlyChain(opts: {
    token: string;
    currentVersion: string;
    targetVersion: string;
    fullGzSize: number;
    preloadedTags: string[];
    signal?: AbortSignal;
  }): Promise<PatchChain | null> {
    const {
      token,
      currentVersion,
      targetVersion,
      fullGzSize,
      preloadedTags,
      signal,
    } = opts;

    const chainTags = filterAndSortChainTags(
      preloadedTags,
      currentVersion,
      targetVersion,
      compareVersions,
    );
    if (chainTags.length === 0 || chainTags.length > MAX_NIGHTLY_CHAIN_DEPTH) {
      return null;
    }

    // Fetch manifests for all chain tags in parallel.
    const fetchedManifests = new Map<string, OciManifest>();
    const results = await Promise.all(
      chainTags.map(async (tag) => {
        try {
          const manifest = await client.fetchManifest(token, tag, signal);
          return { tag, manifest };
        } catch {
          return { tag, manifest: null };
        }
      }),
    );
    for (const { tag, manifest } of results) {
      if (manifest) fetchedManifests.set(tag, manifest);
    }

    const manifests = chainTags.map((tag) => fetchedManifests.get(tag));
    if (manifests.some((m) => !m)) return null;

    const validation = validateNightlyChain({
      manifests: manifests as OciManifest[],
      chainTags,
      currentVersion,
      targetVersion,
      patchLayerName,
      binaryName,
      fullGzSize,
    });
    if (!validation) return null;

    const downloadResults = await Promise.all(
      validation.digests.map((digest) =>
        client
          .downloadBlobBuffer(token, digest, signal)
          .then((buf) => new Uint8Array(buf)),
      ),
    );

    const patches: PatchLink[] = [];
    let downloadedSize = 0;
    for (const data of downloadResults) {
      patches.push({ data, size: data.byteLength });
      downloadedSize += data.byteLength;
    }

    const steps: { fromVersion: string; toVersion: string }[] = [];
    let prevVersion = currentVersion;
    for (const tag of chainTags) {
      const toVersion = tag.slice(PATCH_TAG_PREFIX.length);
      steps.push({ fromVersion: prevVersion, toVersion });
      prevVersion = toVersion;
    }

    return {
      patches,
      totalSize: downloadedSize,
      expectedSha256: validation.expectedSha256,
      steps,
    } satisfies PatchChain;
  }

  return {
    async resolveChain(currentVersion, targetVersion, signal) {
      // A network failure anywhere in resolution (token exchange, manifest /
      // tag listing, or blob download) means "no usable chain" per the
      // SourceStrategy contract — return null so the caller falls back to a
      // full download and it is reported as `unavailable`, not a system
      // `error`. Only BinpatchError (network) is swallowed; a programming bug
      // still propagates.
      try {
        const token = await client.getAnonymousToken(signal);

        const [targetManifest, patchTags] = await Promise.all([
          client.fetchManifest(token, targetTag(targetVersion), signal),
          client.listTags(token, PATCH_TAG_PREFIX, signal),
        ]);

        const gzLayer = targetManifest.layers.find(
          (l) =>
            l.annotations?.["org.opencontainers.image.title"] ===
            `${binaryName}.gz`,
        );
        if (!gzLayer) return null;

        return await resolveNightlyChain({
          token,
          currentVersion,
          targetVersion,
          fullGzSize: gzLayer.size,
          preloadedTags: patchTags,
          signal,
        });
      } catch (error) {
        if (error instanceof BinpatchError) return null;
        throw error;
      }
    },
  };
}
