# binpatch delta-patch Action

A composite GitHub Action that generates binary delta patches with
[`zig-bsdiff`](https://github.com/blackboardsh/zig-bsdiff) and publishes them in
the layout the [`binpatch`](../README.md) library reads at download time.

It is the CI-side other half of the `binpatch` wire contract: the library
*applies* patch chains it discovers from a registry / release; this Action
*produces and publishes* those chains. The two must stay in lockstep — the tag
scheme, annotation keys, artifact-type strings, layer titles, and the
uncompressed-binary SHA-256 are all load-bearing. A drift here breaks live delta
upgrades.

## Modes

Each mode maps 1:1 to a CI job so you can drop it into an existing
generate/publish job graph without reshaping it.

| `mode` | What it does |
|---|---|
| `generate-ghcr` | Diff freshly built binaries against the previous **GHCR nightly**, size-gate the patches, leave them in `patches/` for a later publish step. |
| `publish-ghcr` | Push the compressed binaries to the registry (`:<nightly-tag>`), create the immutable `<nightly-tag-prefix><version>` tag, and push the patch manifest (`:<patch-tag-prefix><version>`) with the integrity annotations the client reads. |
| `generate-release` | Diff freshly built binaries against the previous stable **GitHub Release**, size-gate, leave them in `patches/` for a release-artifact upload (e.g. consumed by Craft). |

## Wire contract (defaults)

- **Nightly binaries:** tag `<repo>:<nightly-tag>` (default `nightly`), immutable
  copy `<repo>:<nightly-tag-prefix><version>` (default `nightly-<version>`),
  artifact-type `<artifact-type-prefix>.nightly`, layer titles = **bare
  filenames** (push runs from inside `artifacts-dir`).
- **Patches:** manifest tag `<repo>:<patch-tag-prefix><version>` (default
  `patch-<version>`), artifact-type `<artifact-type-prefix>.patch`, annotations:
  - `from-version=<prevVersion>` — the chain back-pointer.
  - `sha256-<binaryName>=<hex>` — the target integrity anchor, computed from the
    **uncompressed** binary. This is the sole trust anchor the client verifies
    after applying a chain.
- **Size gate:** a patch larger than `max-ratio`% (default 50) of the gzipped
  binary is dropped (kept under the client's 60% `SIZE_THRESHOLD_RATIO` with
  margin).
- **Format:** patches are TRDIFF10 + zstd, produced by `zig-bsdiff --use-zstd`.

## Requirements

The job must `actions/checkout` the repository first (the Action is referenced
by local path, `uses: ./packages/binpatch/action`) and must provide the built
binaries via `actions/download-artifact` before calling the Action. The ghcr
modes need `packages: write` permission and a `github-token` that can push to the
registry.

## Inputs

See [`action.yml`](./action.yml) for the full list and defaults. The commonly
overridden ones:

| Input | Default | Notes |
|---|---|---|
| `mode` | — | **required**; one of the three modes above. |
| `version` | `""` | Required for the ghcr modes; unused by `generate-release`. |
| `repo` | `""` | Registry repo path (ghcr modes), lowercase. |
| `registry` | `ghcr.io` | OCI registry host. |
| `new-binaries-dir` | `new-binaries` | Uncompressed patch sources. |
| `new-gz-dir` | `new-binaries` | `.gz` binaries for the size gate. |
| `binaries-dir` | `binaries` | (publish) uncompressed binaries for SHA-256. |
| `artifacts-dir` | `artifacts` | (publish) `.gz` layers to push. |
| `patches-dir` | `patches` | Where patches are written / read. |
| `binary-glob` | `*` | Selects binaries to diff (e.g. `lore-*`). |
| `max-ratio` | `50` | Size-gate percentage. |
| `zig-bsdiff-version` / `zig-bsdiff-sha256` | pinned | Encoder, SHA-verified. |
| `oras-version` / `oras-sha256` | pinned | OCI client, SHA-verified. |

## Outputs

| Output | Notes |
|---|---|
| `has-patches` | `'true'` when at least one patch survived the size gate. |
| `from-version` | The previous version the patches diff against (may be empty). |
