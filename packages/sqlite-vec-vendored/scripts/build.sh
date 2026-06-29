#!/usr/bin/env bash
#
# Build the patched sqlite-vec loadable extension for one target.
#
#   scripts/build.sh [--target <os-arch>]
#
# Targets: linux-x64 | linux-arm64 | darwin-arm64 | windows-x64
# When --target is omitted it is auto-detected from the host (uname/OS).
#
# This is the SINGLE source of truth for the build recipe. It:
#   1. copies the pristine upstream sources (../upstream) into a temp dir,
#   2. applies ../patches/*.patch in order,
#   3. generates sqlite-vec.h from the upstream template + VERSION,
#   4. compiles the single translation unit (sqlite-vec.c #includes the rest),
#   5. writes the artifact to ../prebuilt/<target>/vec0.<ext>.
#
# Feature flags (see SOURCE.md for rationale):
#   * DiskANN + rescore are enabled explicitly. They default ON in the alpha.4
#     source (`#ifndef ... #define ... 1`); we pass them anyway so an upstream
#     default flip can never silently drop them.
#   * IVF (SQLITE_VEC_EXPERIMENTAL_IVF_ENABLE) is left OFF (upstream default).
#   * AVX is enabled on x86_64 only, WITHOUT global -mavx/-mavx2. Patch 0002
#     confines AVX2 codegen to two functions via target attributes and gates
#     them behind a runtime __builtin_cpu_supports("avx2") check, so the binary
#     runs on pre-AVX2 CPUs (no SIGILL). NEON is enabled on darwin-arm64.
set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UPSTREAM_DIR="$PKG_DIR/upstream"
PATCH_DIR="$PKG_DIR/patches"

# --- Resolve target -------------------------------------------------------
TARGET=""
while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="$2"; shift 2 ;;
    --target=*) TARGET="${1#*=}"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$TARGET" ]; then
  os="$(uname -s)"; arch="$(uname -m)"
  case "$os" in
    Linux)  os_name="linux" ;;
    Darwin) os_name="darwin" ;;
    MINGW*|MSYS*|CYGWIN*|Windows_NT) os_name="windows" ;;
    *) echo "unsupported OS: $os" >&2; exit 2 ;;
  esac
  case "$arch" in
    x86_64|amd64) arch_name="x64" ;;
    arm64|aarch64) arch_name="arm64" ;;
    *) echo "unsupported arch: $arch" >&2; exit 2 ;;
  esac
  TARGET="$os_name-$arch_name"
fi

case "$TARGET" in
  linux-x64|linux-arm64|darwin-arm64|windows-x64) ;;
  *) echo "unsupported target: $TARGET (want linux-x64|linux-arm64|darwin-arm64|windows-x64)" >&2; exit 2 ;;
esac

case "$TARGET" in
  windows-*) EXT="dll" ;;
  darwin-*)  EXT="dylib" ;;
  *)         EXT="so" ;;
esac

echo "[build] target=$TARGET ext=$EXT"

# --- Stage pristine sources + patches ------------------------------------
BUILD_DIR="$(mktemp -d)"
trap 'rm -rf "$BUILD_DIR"' EXIT
cp -r "$UPSTREAM_DIR"/. "$BUILD_DIR"/
cd "$BUILD_DIR"

for p in "$PATCH_DIR"/*.patch; do
  echo "[build] applying $(basename "$p")"
  patch -p1 < "$p"
done

# --- Generate sqlite-vec.h from the upstream template --------------------
# Deterministic provenance values (cosmetic; vec_version() returns VERSION).
VER="$(tr -d '\r\n' < VERSION)"          # e.g. 0.1.10-alpha.4
MAJOR="${VER%%.*}"
_rest="${VER#*.}"; MINOR="${_rest%%.*}"
_rest2="${_rest#*.}"; PATCH="${_rest2%%[-.]*}"
SOURCE="refs/tags/v${VER}"
DATE="2026-05-18T00:00:00Z"

sed \
  -e "s|\${VERSION}|${VER}|g" \
  -e "s|\${DATE}|${DATE}|g" \
  -e "s|\${SOURCE}|${SOURCE}|g" \
  -e "s|\${VERSION_MAJOR}|${MAJOR}|g" \
  -e "s|\${VERSION_MINOR}|${MINOR}|g" \
  -e "s|\${VERSION_PATCH}|${PATCH}|g" \
  sqlite-vec.h.tmpl > sqlite-vec.h
echo "[build] generated sqlite-vec.h (v${VER}, major=${MAJOR} minor=${MINOR} patch=${PATCH})"

# --- Compile -------------------------------------------------------------
OUT_DIR="$PKG_DIR/prebuilt/$TARGET"
mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/vec0.$EXT"

COMMON_DEFS="-DSQLITE_VEC_ENABLE_DISKANN=1 -DSQLITE_VEC_ENABLE_RESCORE"

if [ "$TARGET" = "windows-x64" ]; then
  # MSVC. AVX is NOT defined on Windows (matching upstream); the AVX blocks —
  # including the GCC-only __attribute__/__builtin_cpu_supports from patch 0002
  # — are #ifdef'd out, so cl.exe never sees them.
  # MSYS_NO_PATHCONV/ARG_CONV_EXCL stop Git Bash from rewriting the leading-slash
  # MSVC flags (e.g. /nologo) into Windows paths.
  OUT_WIN="$(cygpath -w "$OUT" 2>/dev/null || echo "$OUT")"
  echo "[build] compiling with cl.exe -> $OUT_WIN"
  MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' \
    cl.exe /nologo /O2 /I vendor /D SQLITE_VEC_ENABLE_DISKANN=1 /D SQLITE_VEC_ENABLE_RESCORE \
      /LD sqlite-vec.c /Fe:"$OUT_WIN"
  # /LD emits an import lib + exports table next to the DLL; neither is needed
  # to load the extension at runtime, so drop them — only vec0.dll ships.
  rm -f "$OUT_DIR/vec0.lib" "$OUT_DIR/vec0.exp"
else
  CC="${CC:-cc}"
  CFLAGS="-fPIC -shared -Wall -Wextra -Ivendor/ -O3 $COMMON_DEFS"
  LDLIBS=""
  case "$TARGET" in
    linux-x64)    CFLAGS="$CFLAGS -DSQLITE_VEC_ENABLE_AVX"; LDLIBS="-lm" ;;
    linux-arm64)  LDLIBS="-lm" ;;                       # no AVX, no NEON (matches upstream)
    darwin-arm64) CFLAGS="$CFLAGS -mcpu=apple-m1 -DSQLITE_VEC_ENABLE_NEON" ;;  # libm in libSystem
  esac
  echo "[build] compiling: $CC $CFLAGS sqlite-vec.c -o $OUT $LDLIBS"
  # shellcheck disable=SC2086
  "$CC" $CFLAGS sqlite-vec.c -o "$OUT" $LDLIBS
fi

ls -l "$OUT"
echo "[build] done: $OUT"
