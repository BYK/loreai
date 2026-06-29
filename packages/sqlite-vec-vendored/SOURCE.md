# Provenance & build

This package vendors the [`sqlite-vec`](https://github.com/asg017/sqlite-vec)
SQLite loadable extension, rebuilt from source with **DiskANN** and **rescore**
enabled, and ships prebuilt binaries for the four platforms Lore targets.

## Why vendor instead of using the `sqlite-vec` npm package?

The upstream npm releases (and their `sqlite-vec-<os>-<arch>` platform packages)
are built with `make loadable`, which compiles only the brute-force distance
path. The approximate-nearest-neighbour index (**DiskANN**) and the **rescore**
helpers are gated behind `SQLITE_VEC_ENABLE_DISKANN` / `SQLITE_VEC_ENABLE_RESCORE`.
Those default to `1` in the alpha.4 *source* (`#ifndef … #define … 1`), but the
published binaries are functionally brute-force-only for our purposes and the
0.1.10 line is unreleased on npm. To get DiskANN we must build from source — so
we vendor the binaries here and depend on this package instead of `sqlite-vec`.

## Upstream source

| | |
|---|---|
| Repo | https://github.com/asg017/sqlite-vec |
| Tag | `v0.1.10-alpha.4` |
| Source tarball sha256 | `dbb3f0ee83bd2788d84a9e1ff3edfaac74ccb017c1de20fb044b0a9feb2210df` |
| Vendored SQLite headers | amalgamation `3.47.0` (`sqlite-amalgamation-3470000`), public domain |

`upstream/` holds the **pristine** subset we compile:

- `sqlite-vec.c` — the single translation unit; it `#include`s the sibling
  `.c` files below.
- `sqlite-vec-diskann.c` — DiskANN index (enabled).
- `sqlite-vec-rescore.c` — rescore helpers (enabled).
- `sqlite-vec-ivf.c`, `sqlite-vec-ivf-kmeans.c` — experimental IVF index, present
  for completeness but **not compiled** (`SQLITE_VEC_EXPERIMENTAL_IVF_ENABLE` is
  left undefined, matching upstream's default).
- `sqlite-vec.h.tmpl`, `VERSION` — header template + version string; `build.sh`
  generates `sqlite-vec.h` from these.
- `vendor/sqlite3.h`, `vendor/sqlite3ext.h` — SQLite 3.47.0 amalgamation
  headers. (Upstream's `vendor.sh` pins 3.45.3; we vendor 3.47.0. The loadable
  extension only uses the long-stable `sqlite3_api_routines` surface via
  `SQLITE_EXTENSION_INIT2`, so the host SQLite — node:sqlite / bun:sqlite —
  provides the runtime implementation; the header version only affects which
  API slots are visible at compile time. All four binaries are built and
  functionally verified against these headers in CI.)

## Patches

Applied in order by `scripts/build.sh` (`patch -p1`):

- **`0001-diskann-int8-saturate.patch`** — upstream PR
  [#311](https://github.com/asg017/sqlite-vec/pull/311), commit
  `59e63dbe75d7339e09ddb5e042dbaa39c1911119`. Saturates the DiskANN int8
  quantizer to `[-128, 127]` before the float→int8 cast, fixing undefined
  behaviour (out-of-range float→int conversion) flagged by ASan/UBSan.
- **`0002-avx-runtime-dispatch.patch`** — upstream PR
  [#307](https://github.com/asg017/sqlite-vec/pull/307), commit
  `b1c8b216c108dedb10eb0c79665a11b19e4b7de4` (fixes upstream #302). Confines AVX2
  codegen to two functions via `__attribute__((target(...)))` and gates them
  behind a runtime `__builtin_cpu_supports("avx2")` check, so a binary built with
  AVX support still runs on pre-AVX2 CPUs (no SIGILL).
  *Trimmed:* only the `sqlite-vec.c` hunks are taken. The original commit also
  removes `-mavx -mavx2` from upstream's Makefile — we don't vendor that Makefile
  (`build.sh` compiles directly and never passes global `-mavx/-mavx2`, which is
  the same intent). The two Rust criterion-benchmark commits in PR #307 are
  omitted as build-irrelevant.

## Build recipe

`scripts/build.sh [--target <os-arch>]` is the single source of truth. It copies
`upstream/` to a temp dir, applies `patches/`, generates `sqlite-vec.h`, compiles
`sqlite-vec.c`, and writes `prebuilt/<target>/vec0.<ext>`.

| Target | Toolchain | SIMD flag | Notes |
|---|---|---|---|
| `linux-x64` | `cc` (gcc) | `-DSQLITE_VEC_ENABLE_AVX` | `-lm`; AVX2 runtime-dispatched |
| `linux-arm64` | `cc` (gcc) | *(none)* | `-lm`; matches upstream (no NEON on linux-arm64) |
| `darwin-arm64` | `cc` (clang) | `-DSQLITE_VEC_ENABLE_NEON` | `-mcpu=apple-m1` |
| `windows-x64` | `cl.exe` (MSVC) | *(none)* | AVX path `#ifdef`'d out; MSVC never sees the GCC-only intrinsics from patch 0002 |

All targets pass `-DSQLITE_VEC_ENABLE_DISKANN=1 -DSQLITE_VEC_ENABLE_RESCORE`
explicitly (defensive — they default on in source) and `-O3` (`/O2` on MSVC).
AVX is enabled on x86_64 only; because patch 0002 runtime-gates it, the same
`linux-x64` binary is safe on pre-AVX2 hardware.

## How the binaries are produced & committed

The four `prebuilt/<target>/` binaries are built on **native runners** by
`.github/workflows/build-sqlite-vec.yml` (linux-x64 / linux-arm64 / darwin-arm64
/ windows-x64), which also functionally verifies each (`vec_version()` +
a DiskANN int8 KNN query) before uploading. The committed binaries are the
artifacts from that workflow. Building natively per platform side-steps the
`__cpu_model`/`__builtin_cpu_supports` link failures seen with cross-compilers.

## Consuming this package

`getLoadablePath()` mirrors `sqlite-vec`'s API (path to the current platform's
`vec0` extension, or `undefined`). The package MUST stay **external** in consumer
bundles (core's esbuild, the gateway bundle) so `import.meta.url` resolves to the
installed package and the `prebuilt/` lookup works. The gateway SEA packer uses
`getLoadablePathForTarget()` to embed every platform's extension.

This package is **ESM-only** (it uses `import.meta.url`), unlike the dual-mode
`sqlite-vec` npm wrapper it replaces. `@loreai/core` imports it from ESM, and the
gateway's CJS bundle `require()`s it — `require()` of an ESM module is supported
unflagged on Node ≥ 22.12, which the gateway's `engines.node` (`>=22.15`)
guarantees. There is no top-level `await`, so the synchronous `require(ESM)`
path is safe.
