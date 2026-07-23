/**
 * binpatch — reusable binary delta-update engine.
 *
 * Apply a TRDIFF10/bsdiff patch chain to a binary, with an offline patch
 * cache. Pure Node (only `node:*` builtins), zero product coupling — the
 * consumer injects the cache directory and (later) the download source.
 *
 * PR1 scope: the apply core + progress + patch cache. Chain discovery
 * (a pluggable `SourceStrategy`) lands in a follow-up.
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
