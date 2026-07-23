# binpatch

Reusable binary delta-update engine. Apply a **TRDIFF10 / bsdiff** patch chain
to a binary, with an offline patch cache.

> **Status: prototype.** This package lives inside the loreai monorepo and is
> **unpublished** while its API stabilizes. Once the design settles it will move
> to its own public repository. Consumed today only by `@loreai/gateway`.

## Why

Two projects (Lore's gateway and `getsentry/cli`) independently carry the same
delta-update code, ported from a common ancestor, and have drifted apart — a
bug fixed in one was missing from the other. `binpatch` is the shared,
general-purpose extraction so that code lives in exactly one place.

## Scope

The system splits into two halves joined by a single **wire contract**:

1. **Apply + discovery** — runtime code that runs inside the consumer's binary.
   This npm package. Pure Node (`node:*` builtins only), zero product coupling.
2. **Generation + publishing** — CI-side patch creation and upload to
   GHCR / GitHub Releases. A reusable GitHub Action (separate, later).

This package currently covers the **apply core** (PR1): patch parsing, chain
application, an offline cache, and byte-progress reporting. Chain **discovery**
(a pluggable `SourceStrategy` over GHCR tags and GitHub Release assets) lands in
a follow-up.

## API

```ts
import {
  applyPatchChainInMemory,
  parsePatchHeader,
  makeCache,
} from "binpatch";

// Apply an ordered chain of patches to an old binary, writing the final
// output to disk. Intermediate hops stay in memory; only the final hop is
// written and hashed. Returns the SHA-256 of the produced binary.
const sha256 = await applyPatchChainInMemory(oldPath, patches, destPath, {
  onBytes: (n) => { /* progress: n output bytes produced this chunk */ },
});

// Offline cache — the consumer decides where it lives (no config lookup here).
const cache = makeCache("/path/to/cache-dir");
await cache.save(chain, steps);
const cached = await cache.load(currentVersion, targetVersion);
await cache.cleanup(); // drop entries past the 7-day TTL
await cache.clear();   // wipe everything (e.g. after a successful upgrade)
```

### Exports

- `parsePatchHeader`, `offtin`, `PatchHeader`, `MAX_OUTPUT_SIZE`, `addDiffChunk`
  — TRDIFF10 header parsing + the vectorized diff-add primitive.
- `applyPatch`, `applyPatchToMemory`, `applyPatchChainInMemory` — patch apply.
- `makeByteProgress`, `ByteProgress`, `ByteProgressOut` — a simple byte-progress
  bar (a thin default; the eventual public API is pure event hooks so any
  consumer can plug in any indicator, or none).
- `makeCache`, `PatchCache`, `patchFileName`, `chainFileName`, `ChainMeta`,
  `PatchStepMeta` — the offline patch cache.

## Wire contract (summary)

- **Patch format (TRDIFF10):** `"TRDIFF10"` magic + `offtin` sign-magnitude i64
  `controlLen` / `diffLen` / `newSize`, followed by `zstd(control) | zstd(diff)
  | zstd(extra)`. `newSize` is bounded by `MAX_OUTPUT_SIZE` (2 GiB) on parse.
- **Integrity:** after applying a whole chain the result is SHA-256'd against
  the expected hash; a mismatch discards the result and the consumer falls back
  to a full download.

The generator (the GitHub Action, later) produces this layout; this package
consumes it. Either half is usable on its own as long as both honor the
contract.

## License

FSL-1.1-Apache-2.0. The apply algorithm derives from Colin Percival's bsdiff
(BSD) via the TRDIFF10 (zstd) variant.
