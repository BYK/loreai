#!/bin/bash
# Pre-release version bump for all five Lore workspace packages.
#
# Why this exists instead of letting craft auto-bump:
#
# Craft's built-in auto-bumping runs `npm version --workspaces --include-workspace-root`.
# On our monorepo this succeeds in updating the version field in every package.json,
# but then npm *also* validates dependency URLs during the version command and
# errors out with EUNSUPPORTEDPROTOCOL on `workspace:*` specifiers. The exit
# status propagates back to craft which treats the whole step as failed and
# falls back to per-package bumping — which fails identically, because the
# workspace deps are still there.
#
# We bypass npm entirely by editing package.json files with jq directly.
# Release packaging uses `pnpm pack`, which rewrites `workspace:*` specifiers
# from each package.json at pack time — so no lockfile patching is required.
#
# Upstream tracking: https://github.com/getsentry/craft/issues/804
#
# Craft passes the new version via CRAFT_NEW_VERSION. Command-line args are a
# legacy fallback — prefer the env var.
set -euo pipefail

NEW_VERSION="${CRAFT_NEW_VERSION:-${2:-}}"
if [ -z "$NEW_VERSION" ]; then
  echo "error: CRAFT_NEW_VERSION not set and no positional version argument" >&2
  exit 1
fi

echo "Bumping Lore workspace packages to ${NEW_VERSION}"

for f in \
  packages/core/package.json \
  packages/gateway/package.json \
  packages/opencode/package.json \
  packages/pi/package.json \
  packages/sqlite-vec-vendored/package.json; do
  # Preserve trailing newline by piping through jq then appending.
  tmp="$(mktemp)"
  jq --arg v "$NEW_VERSION" '.version = $v' "$f" > "$tmp"
  mv "$tmp" "$f"
  name=$(jq -r '.name' "$f")
  echo "  ✓ ${name} → ${NEW_VERSION}"
done

echo "Version bump complete."
