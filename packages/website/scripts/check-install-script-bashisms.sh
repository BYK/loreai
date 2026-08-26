#!/usr/bin/env bash
# Lint packages/website/public/install for bash-4.x-only constructs.
#
# The installer is run via `curl ... | bash` on macOS, whose default /bin/bash
# is 3.2. It must stay compatible with that interpreter, so it can use neither
# named file descriptors (bash 4.1+) nor any other 4.0+/4.1+ feature. This
# script rejects the constructs that break on macOS stock bash.
#
# Usage: check-install-script-bashisms.sh [path-to-install-script]
set -euo pipefail

target="${1:-packages/website/public/install}"

if [[ ! -f "$target" ]]; then
  echo "error: install script not found at: $target" >&2
  exit 2
fi

failures=()

# Patterns that require bash 4.0+ or 4.1+ and break on macOS stock bash 3.2.
# These are deliberately strict: only flag the modifier immediately following
# the variable name (e.g. ${var,} ${var^}), not the harmless ${var:-default}.
patterns=(
  'exec \{[a-zA-Z_]+[0-9]*\}[<>]'            # named fds (4.1)
  'exec \{[a-zA-Z_]+[0-9]*\}[<>]&-'          # named fd close (4.1)
  '\[\[[[:space:]]*-v[[:space:]]+[a-zA-Z_]'  # test -v (4.1)
  '\bmapfile\b|\breadarray\b'                # mapfile (4.0)
  '\bcoproc\b'                              # coproc (4.0)
  ';;&|;&'                                  # case fallthrough (4.0)
  'declare[[:space:]]+-A[[:space:]]|local[[:space:]]+-A[[:space:]]' # assoc arrays (4.0)
  '\$\{[a-zA-Z_][a-zA-Z0-9_]*[,^]'           # case-modifying expansion (4.0)
  '\$\{[a-zA-Z_][a-zA-Z0-9_]*@(U|L|E|P|Q|a|A)\}' # transform expansion (4.0)
)

labels=(
  'named file descriptor (bash 4.1+)'
  'named file descriptor close (bash 4.1+)'
  '[[ -v var ]] (bash 4.1+)'
  'mapfile/readarray (bash 4.0+)'
  'coproc (bash 4.0+)'
  'case fallthrough ;& / ;;& (bash 4.0+)'
  'associative arrays (bash 4.0+)'
  'case-modifying parameter expansion (bash 4.0+)'
  'parameter transformation expansion (bash 4.0+)'
)

while IFS= read -r line; do
  lineno="${line%%:*}"
  content="${line#*:}"
  for i in "${!patterns[@]}"; do
    if [[ "$content" =~ ${patterns[$i]} ]]; then
      failures+=("$lineno: ${labels[$i]}")
    fi
  done
done < <(grep -nE . "$target")

if [[ "${#failures[@]}" -gt 0 ]]; then
  echo "bash-3.2 incompatibility detected in $target:" >&2
  for f in "${failures[@]}"; do
    echo "  line ${f}" >&2
  done
  echo "The installer runs on macOS stock bash 3.2 via 'curl | bash';" >&2
  echo "remove these bash-4.x-only constructs." >&2
  exit 1
fi

echo "ok: $target is compatible with bash 3.2"
