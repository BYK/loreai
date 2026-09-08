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

# The rolling nightly tag must never move backwards when an older workflow
# finishes after a newer one. Callers serialize the read/compare/write window;
# this helper makes the version decision deterministic within that window.
should_advance_rolling_nightly() {
  local current_version="${1-}"
  local candidate_version="${2-}"

  [ -n "$candidate_version" ] || return 2
  [ -z "$current_version" ] || version_is_before "$current_version" "$candidate_version"
}

# Advance a rolling nightly tag only when a candidate is strictly newer. The
# caller must serialize this function across publishers targeting the same
# registry/tag; registry lookup failures deliberately leave the pointer alone.
advance_rolling_nightly() {
  local full_repo="${1-}"
  local nightly_tag="${2-}"
  local nightly_tag_prefix="${3-}"
  local candidate_version="${4-}"
  local tags current_manifest current_version=""

  [ -n "$full_repo" ] && [ -n "$nightly_tag" ] && [ -n "$nightly_tag_prefix" ] && [ -n "$candidate_version" ] || return 2

  if ! tags=$(oras repo tags "$full_repo"); then
    echo "::warning::Unable to list tags for ${full_repo}; not advancing rolling nightly"
    return 0
  fi

  if grep -Fqx -- "$nightly_tag" <<< "$tags"; then
    if ! current_manifest=$(oras manifest fetch "${full_repo}:${nightly_tag}"); then
      echo "::warning::Unable to read ${nightly_tag}; not advancing rolling nightly"
      return 0
    fi
    current_version=$(printf '%s' "$current_manifest" | jq -r '.annotations.version // empty')
    if [ -z "$current_version" ]; then
      echo "::warning::${nightly_tag} has no version annotation; not advancing rolling nightly"
      return 0
    fi
  fi

  if ! should_advance_rolling_nightly "$current_version" "$candidate_version"; then
    echo "Rolling nightly remains at ${current_version}; candidate ${candidate_version} is not newer"
    return 0
  fi

  oras tag "${full_repo}:${nightly_tag_prefix}${candidate_version}" "$nightly_tag"
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
