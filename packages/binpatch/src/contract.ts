/**
 * Wire-contract constants and shared types.
 *
 * These values are part of the binpatch wire contract — the generator (the
 * publishing side) and this library MUST agree on them. See the package README
 * for the full contract spec.
 */

/** Maximum stable patches to chain before falling back to a full download. */
export const MAX_STABLE_CHAIN_DEPTH = 10;

/** Maximum nightly patches to chain before falling back to a full download. */
export const MAX_NIGHTLY_CHAIN_DEPTH = 30;

/**
 * Maximum ratio of total patch-chain size to the full (gzipped) download size.
 * Above this, a full download is cheaper — abandon the chain.
 */
export const SIZE_THRESHOLD_RATIO = 0.6;

/** GHCR tag prefix under which per-version patch manifests are published. */
export const PATCH_TAG_PREFIX = "patch-";

/** A single link in a patch chain: the raw patch bytes and their size. */
export type PatchLink = {
  data: Uint8Array;
  size: number;
};

/** One from->to hop, used for cache keying. */
export type ChainStep = {
  fromVersion: string;
  toVersion: string;
};

/**
 * A resolved chain of patches from a current version to a target version,
 * plus the expected SHA-256 of the final produced binary (the sole trust
 * anchor) and the per-hop steps (for the offline cache).
 */
export type PatchChain = {
  patches: PatchLink[];
  totalSize: number;
  expectedSha256: string;
  steps?: ChainStep[];
};

/** Result of a successfully applied delta chain. */
export type DeltaResult = {
  sha256: string;
  patchBytes: number;
  chainLength: number;
};
