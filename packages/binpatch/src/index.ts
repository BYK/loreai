/**
 * binpatch — reusable binary delta-update engine.
 *
 * Two things, joined by one wire contract (see README):
 * - **apply core** — parse + apply a TRDIFF10/bsdiff patch chain to a binary.
 * - **discovery** — resolve a patch chain from a pluggable `SourceStrategy`
 *   (OCI/GHCR tags or GitHub Release assets), then apply + verify it.
 *
 * Pure Node (`node:*` builtins only), zero product coupling — the consumer
 * injects the cache directory, the download source, version comparison,
 * progress handling, and telemetry.
 */

export {
  addDiffChunk,
  applyPatch,
  applyPatchChainInMemory,
  applyPatchToMemory,
  MAX_OUTPUT_SIZE,
  offtin,
  parsePatchHeader,
  type PatchHeader,
} from "./bspatch";

export {
  type ByteProgress,
  type ByteProgressOut,
  makeByteProgress,
} from "./progress";

export {
  type ChainMeta,
  chainFileName,
  makeCache,
  type PatchCache,
  patchFileName,
  type PatchStepMeta,
} from "./patch-cache";

// Wire-contract constants + shared chain types.
export {
  type ChainStep,
  type DeltaResult,
  MAX_NIGHTLY_CHAIN_DEPTH,
  MAX_STABLE_CHAIN_DEPTH,
  PATCH_TAG_PREFIX,
  type PatchChain,
  type PatchLink,
  SIZE_THRESHOLD_RATIO,
} from "./contract";

export { BinpatchError, type BinpatchErrorReason } from "./errors";

// Progress events (the library never renders — it emits these).
export {
  type ProgressEvent,
  type ProgressHandler,
  type ProgressPhase,
  safeProgress,
} from "./events";

// Discovery + orchestration.
export {
  type DeltaSource,
  type DeltaTelemetry,
  resolveAndApply,
  type ResolveAndApplyOpts,
  type SourceStrategy,
} from "./discover";

// Sources.
export {
  type GhcrSourceConfig,
  ghcrSource,
  getPatchFromVersion,
  getPatchTargetSha256,
  filterAndSortChainTags,
  validateChainStep,
} from "./sources/ghcr";

export {
  extractSha256,
  extractStableChain,
  type ExtractStableChainOpts,
  type GitHubAsset,
  type GitHubRelease,
  type GitHubReleaseSourceConfig,
  githubReleaseSource,
  getStableTargetSha256,
  type StableChainInfo,
} from "./sources/github-release";

export {
  OciClient,
  type OciClientConfig,
  type OciLayer,
  type OciManifest,
} from "./sources/oci";
