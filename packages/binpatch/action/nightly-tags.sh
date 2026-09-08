#!/usr/bin/env bash
# Helpers shared by the nightly delta-patch generation and publish steps.
#
# Keep this dependency-free: a composite Action runs before the repository's
# Node dependencies are installed. `sort -V` is available on the Ubuntu GitHub
# runners and correctly orders Lore's SemVer dev timestamp versions.

version_is_before() {
  local left="${1-}"
  local right="${2-}"

  [ -n "$left" ] && [ -n "$right" ] && [ "$left" != "$right" ] || return 1
  [ "$(printf '%s\n%s\n' "$left" "$right" | sort -V | sed -n '1p')" = "$left" ]
}

# Print the greatest versioned-nightly tag strictly below $3. The target tag
# need not exist yet: generation intentionally happens before publication.
select_previous_nightly_tag() {
  local tags="${1-}"
  local prefix="${2-}"
  local target_version="${3-}"
  local tag version previous_tag="" previous_version=""

  [ -n "$prefix" ] && [ -n "$target_version" ] || return 2

  while IFS= read -r tag; do
    case "$tag" in
      "${prefix}"*) ;;
      *) continue ;;
    esac

    version="${tag#"${prefix}"}"
    case "$version" in
      [0-9]*) ;;
      *) continue ;;
    esac

    if version_is_before "$version" "$target_version" && {
      [ -z "$previous_version" ] || version_is_before "$previous_version" "$version";
    }; then
      previous_tag="$tag"
      previous_version="$version"
    fi
  done <<< "$tags"

  printf '%s\n' "$previous_tag"
}
