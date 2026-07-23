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

This package covers the **apply core** (patch parsing, chain application, an
offline cache, byte-progress reporting) and **chain discovery** — a pluggable
`SourceStrategy` over OCI/GHCR patch-manifest tags and GitHub Release assets,
plus a cache-first `resolveAndApply` orchestrator. The CI-side patch
*generation* half ships separately as a composite GitHub Action (later).

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

### Discovery + resolve-and-apply

Higher level: hand `resolveAndApply` a `SourceStrategy` and it does cache-first
resolution, apply, SHA verification, and progress events. All product specifics
are injected — the library has no GitHub/registry/version knowledge baked in.

```ts
import {
  resolveAndApply,
  ghcrSource,
  githubReleaseSource,
} from "binpatch";

// Nightly channel — OCI patch-manifest tags on a registry (e.g. GHCR).
const nightly = ghcrSource({
  registry: "https://ghcr.io",
  repo: "owner/project",
  userAgent: "my-cli/1.2.3",
  binaryName: "my-cli-linux-x64",
  targetTag: (v) => `nightly-${v}`,   // where the target image manifest lives
  compareVersions,                     // your semver comparator (-1|0|1)
});

// Stable channel — GitHub Release assets.
const stable = githubReleaseSource({
  releasesUrl: "https://api.github.com/repos/owner/project/releases",
  binaryName: "my-cli-linux-x64",
  userAgent: "my-cli/1.2.3",
});

const result = await resolveAndApply({
  source: nightly,            // or stable
  currentVersion, targetVersion,
  oldPath, destPath,
  cache,                       // optional — enables offline upgrades
  offline,                     // optional — cache-only, never touch the network
  onProgress: (e) => { /* {type:"phase"|"bytes"|"done", ...} */ },
  telemetry: {                 // optional — the library is telemetry-agnostic
    onResolved: ({ source }) => {/* "cache" | "network" */},
    onOfflineMiss: () => {},
  },
});
// result: { sha256, patchBytes, chainLength } | null (fall back to full download)
```

Implement your own `SourceStrategy` for any other layout — the contract is a
single method: `resolveChain(current, target, signal?) => PatchChain | null`.

### Progress is events, never rendering

The library **never draws** progress. `resolveAndApply` emits
`{ type: "phase" | "bytes" | "done"; phase; ... }` events via `onProgress`; a
missing handler is silent, and a throwing handler can never abort the operation
(`safeProgress`). Each consumer renders however it likes — a stderr bar
(`makeByteProgress` ships as a convenience), a spinner message, or a log line.

### Exports

- `parsePatchHeader`, `offtin`, `PatchHeader`, `MAX_OUTPUT_SIZE`, `addDiffChunk`
  — TRDIFF10 header parsing + the vectorized diff-add primitive.
- `applyPatch`, `applyPatchToMemory`, `applyPatchChainInMemory` — patch apply.
- `resolveAndApply`, `SourceStrategy`, `ghcrSource`, `githubReleaseSource`,
  `OciClient` — chain discovery + orchestration.
- `ProgressEvent`, `ProgressHandler`, `safeProgress` — progress events.
- `PatchChain`, `PatchLink`, `ChainStep`, `DeltaResult`, `BinpatchError`,
  and the contract constants (`MAX_STABLE_CHAIN_DEPTH`,
  `MAX_NIGHTLY_CHAIN_DEPTH`, `SIZE_THRESHOLD_RATIO`, `PATCH_TAG_PREFIX`).
- `makeByteProgress` — a convenience stderr byte-progress bar (optional).
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
