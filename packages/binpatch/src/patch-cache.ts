/**
 * Patch Cache
 *
 * File-based cache for delta upgrade patches. Patches are downloaded
 * during background version checks so that an upgrade can apply them
 * offline without any network calls.
 *
 * Cache layout, under the caller-provided cache directory:
 * - <fromVersion>-<toVersion>.patch — raw binary patch data
 * - chain-<fromVersion>-<toVersion>.json — chain metadata
 *
 * Uses file-based storage to avoid bloating a DB with 50-80KB binary
 * blobs. Channel-agnostic — the same version-based naming works for
 * both nightly (GHCR) and stable (GitHub Releases) channels.
 *
 * The cache directory is injected by the consumer via `makeCache(cacheDir)`
 * so this module carries no product-specific coupling (no config-dir
 * lookup, no env vars). Adapted from Sentry CLI's patch-cache.ts.
 */

import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** 7-day TTL for cached patches (milliseconds) */
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Maximum number of chain steps to prevent infinite loops */
const MAX_CHAIN_WALK_DEPTH = 10;

/** Metadata for a single patch step */
export type PatchStepMeta = {
  fromVersion: string;
  toVersion: string;
  size: number;
};

/** Chain metadata stored alongside patch files */
export type ChainMeta = {
  fromVersion: string;
  toVersion: string;
  expectedSha256: string;
  cachedAt: number;
  patches: PatchStepMeta[];
};

/**
 * Sanitize version strings for safe filenames.
 */
function sanitizeVersion(version: string): string {
  return version.replace(/[^a-zA-Z0-9.-]/g, "_");
}

/** Build the filename for a patch file given a from->to version pair. */
export function patchFileName(fromVersion: string, toVersion: string): string {
  return `${sanitizeVersion(fromVersion)}-${sanitizeVersion(toVersion)}.patch`;
}

/** Build the filename for a chain metadata file. */
export function chainFileName(fromVersion: string, toVersion: string): string {
  return `chain-${sanitizeVersion(fromVersion)}-${sanitizeVersion(toVersion)}.json`;
}

function isNotFound(err: unknown): boolean {
  return err instanceof Error && "code" in err && err.code === "ENOENT";
}

/**
 * Save a patch file and its chain metadata to the cache.
 */
async function savePatchesToCache(
  cacheDir: string,
  chain: {
    patches: { data: Uint8Array; size: number }[];
    expectedSha256: string;
  },
  steps: { fromVersion: string; toVersion: string }[],
): Promise<void> {
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });

  // Save all patch files in parallel
  await Promise.all(
    chain.patches.flatMap((patch, i) => {
      const step = steps[i];
      if (!(step && patch)) return [];
      const filePath = join(
        cacheDir,
        patchFileName(step.fromVersion, step.toVersion),
      );
      return [writeFile(filePath, patch.data)];
    }),
  );

  // Save chain metadata
  if (steps.length > 0) {
    const firstStep = steps.at(0);
    const lastStep = steps.at(-1);
    if (firstStep && lastStep) {
      const meta: ChainMeta = {
        fromVersion: firstStep.fromVersion,
        toVersion: lastStep.toVersion,
        expectedSha256: chain.expectedSha256,
        cachedAt: Date.now(),
        patches: steps.map((s, i) => ({
          fromVersion: s.fromVersion,
          toVersion: s.toVersion,
          size: chain.patches[i]?.size ?? 0,
        })),
      };
      const metaPath = join(
        cacheDir,
        chainFileName(firstStep.fromVersion, lastStep.toVersion),
      );
      await writeFile(metaPath, JSON.stringify(meta));
    }
  }
}

/**
 * Load all chain metadata files from the cache directory.
 */
async function loadAllChainMetas(cacheDir: string): Promise<ChainMeta[]> {
  let files: string[];
  try {
    files = await readdir(cacheDir);
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }

  const metaFiles = files.filter(
    (f) => f.startsWith("chain-") && f.endsWith(".json"),
  );

  const results = await Promise.all(
    metaFiles.map(async (file) => {
      try {
        return JSON.parse(
          await readFile(join(cacheDir, file), "utf-8"),
        ) as ChainMeta;
      } catch {
        return null;
      }
    }),
  );

  return results.filter((m): m is ChainMeta => m !== null);
}

/**
 * Build a step map from chain metadata: fromVersion -> { toVersion, size }.
 */
function buildStepMap(
  chainMetas: ChainMeta[],
): Map<string, { toVersion: string; size: number }> {
  const stepMap = new Map<string, { toVersion: string; size: number }>();
  for (const meta of chainMetas) {
    for (const step of meta.patches) {
      stepMap.set(step.fromVersion, {
        toVersion: step.toVersion,
        size: step.size,
      });
    }
  }
  return stepMap;
}

/**
 * Walk from currentVersion toward targetVersion using the step map.
 */
function walkChainSteps(
  stepMap: Map<string, { toVersion: string; size: number }>,
  currentVersion: string,
  targetVersion: string,
): { fromVersion: string; toVersion: string }[] | null {
  const steps: { fromVersion: string; toVersion: string }[] = [];
  let version = currentVersion;
  while (version !== targetVersion) {
    const next = stepMap.get(version);
    if (!next) return null;
    steps.push({ fromVersion: version, toVersion: next.toVersion });
    version = next.toVersion;

    if (steps.length > MAX_CHAIN_WALK_DEPTH) return null;
  }
  return steps.length > 0 ? steps : null;
}

/**
 * Try to load a complete patch chain from the cache.
 */
async function loadCachedChain(
  cacheDir: string,
  currentVersion: string,
  targetVersion: string,
): Promise<{
  patches: { data: Uint8Array; size: number }[];
  totalSize: number;
  expectedSha256: string;
} | null> {
  const chainMetas = await loadAllChainMetas(cacheDir);
  if (chainMetas.length === 0) return null;

  const stepMap = buildStepMap(chainMetas);
  const steps = walkChainSteps(stepMap, currentVersion, targetVersion);
  if (!steps) return null;

  // Find the expectedSha256 from metadata
  let expectedSha256 = "";
  for (const meta of chainMetas) {
    if (meta.toVersion === targetVersion && meta.expectedSha256) {
      expectedSha256 = meta.expectedSha256;
      break;
    }
  }
  if (!expectedSha256) return null;

  // Load all patch files in parallel
  const loadResults = await Promise.all(
    steps.map(async (step) => {
      const filePath = join(
        cacheDir,
        patchFileName(step.fromVersion, step.toVersion),
      );
      try {
        const data = await readFile(filePath);
        return { data, size: data.byteLength };
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    }),
  );

  const patches: { data: Uint8Array; size: number }[] = [];
  let totalSize = 0;
  for (const result of loadResults) {
    if (!result) return null;
    patches.push(result);
    totalSize += result.size;
  }

  return { patches, totalSize, expectedSha256 };
}

/**
 * Remove expired chain entries and their exclusive patch files.
 */
async function removeExpiredEntries(
  cacheDir: string,
  files: string[],
  now: number,
): Promise<void> {
  const expiredMetas: ChainMeta[] = [];
  const livePatchFiles = new Set<string>();

  const metaResults = await Promise.all(
    files
      .filter((f) => f.startsWith("chain-") && f.endsWith(".json"))
      .map(async (file) => {
        try {
          const meta = JSON.parse(
            await readFile(join(cacheDir, file), "utf-8"),
          ) as ChainMeta;
          return { file, meta };
        } catch {
          await unlink(join(cacheDir, file)).catch(() => {});
          return null;
        }
      }),
  );

  for (const result of metaResults) {
    if (!result) continue;
    if (now - result.meta.cachedAt > CACHE_MAX_AGE_MS) {
      expiredMetas.push(result.meta);
    } else {
      for (const step of result.meta.patches) {
        livePatchFiles.add(patchFileName(step.fromVersion, step.toVersion));
      }
    }
  }

  const deletions: Promise<void>[] = [];
  for (const meta of expiredMetas) {
    for (const step of meta.patches) {
      const name = patchFileName(step.fromVersion, step.toVersion);
      if (!livePatchFiles.has(name)) {
        deletions.push(unlink(join(cacheDir, name)).catch(() => {}));
      }
    }
    deletions.push(
      unlink(
        join(cacheDir, chainFileName(meta.fromVersion, meta.toVersion)),
      ).catch(() => {}),
    );
  }

  await Promise.all(deletions);
}

/**
 * Remove stale cache entries older than 7 days.
 * Called opportunistically. Fire-and-forget.
 */
async function cleanupPatchCache(cacheDir: string): Promise<void> {
  let files: string[];
  try {
    files = await readdir(cacheDir);
  } catch (err) {
    if (isNotFound(err)) return;
    throw err;
  }
  await removeExpiredEntries(cacheDir, files, Date.now());
}

/**
 * Remove all cached patch files and chain metadata.
 * Called after a successful upgrade.
 */
async function clearPatchCache(cacheDir: string): Promise<void> {
  let files: string[];
  try {
    files = await readdir(cacheDir);
  } catch (err) {
    if (isNotFound(err)) return;
    throw err;
  }

  await Promise.all(
    files.map((file) => unlink(join(cacheDir, file)).catch(() => {})),
  );
}

/**
 * A patch cache bound to a specific directory. The consumer decides where the
 * cache lives (e.g. `<configDir>/patch-cache`) and injects it here, keeping
 * this module free of any product-specific config/path lookup.
 */
export type PatchCache = {
  /** Save a patch chain and its metadata to the cache. */
  save(
    chain: {
      patches: { data: Uint8Array; size: number }[];
      expectedSha256: string;
    },
    steps: { fromVersion: string; toVersion: string }[],
  ): Promise<void>;
  /** Try to assemble a complete cached chain from current -> target. */
  load(
    currentVersion: string,
    targetVersion: string,
  ): Promise<{
    patches: { data: Uint8Array; size: number }[];
    totalSize: number;
    expectedSha256: string;
  } | null>;
  /** Remove entries older than the TTL. Fire-and-forget. */
  cleanup(): Promise<void>;
  /** Remove all cached patches and metadata (e.g. after a successful upgrade). */
  clear(): Promise<void>;
};

/**
 * Create a {@link PatchCache} rooted at `cacheDir`. The directory is created
 * lazily on first write; reads of a missing directory resolve to empty.
 */
export function makeCache(cacheDir: string): PatchCache {
  return {
    save: (chain, steps) => savePatchesToCache(cacheDir, chain, steps),
    load: (currentVersion, targetVersion) =>
      loadCachedChain(cacheDir, currentVersion, targetVersion),
    cleanup: () => cleanupPatchCache(cacheDir),
    clear: () => clearPatchCache(cacheDir),
  };
}
