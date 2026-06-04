/**
 * workspace.ts — Workspace root discovery and sub-project resolution.
 *
 * Provides two directions of discovery for monorepo support:
 *
 * 1. **Upward** (`discoverWorkspaceRoot`): Walk from a start directory toward
 *    the filesystem root, checking for project markers at each level. Returns
 *    the highest meaningful project root — the monorepo/workspace root.
 *
 * 2. **Downward** (`resolveWorkspaces`): Given a root directory and an array
 *    of path patterns (from `.lore.json` `workspaces` field), resolve them to
 *    concrete sub-project directories.
 *
 * Inspired by Sentry CLI's `walk-up.ts` and `project-root.ts` but kept
 * synchronous and much simpler — runs once at startup, not in the hot path.
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { isHostedMode } from "./hosted";

// ---------------------------------------------------------------------------
// Marker taxonomy
// ---------------------------------------------------------------------------

/**
 * VCS markers — definitive project root indicators.
 * Finding one of these stops the walk immediately.
 */
const VCS_MARKERS = [".git", ".hg", ".svn", ".jj", ".bzr", "_darcs", ".fossil"];

/**
 * Workspace/monorepo markers — definitive root indicators.
 * These explicitly declare "I am a monorepo/workspace root".
 */
const WORKSPACE_MARKERS = [
  "pnpm-workspace.yaml",
  "lerna.json",
  "nx.json",
  "rush.json",
  "turbo.json",
  "go.work",
];

/**
 * Language markers — soft project indicators.
 * The closest one to startDir wins, but the walk continues past them
 * looking for a definitive marker higher up.
 */
const LANGUAGE_MARKERS = [
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "composer.json",
  "Gemfile",
  "mix.exs",
  "pubspec.yaml",
  "dune-project",
];

// ---------------------------------------------------------------------------
// Upward discovery — discoverWorkspaceRoot()
// ---------------------------------------------------------------------------

/** Process-lifetime cache for workspace root lookups. */
const workspaceRootCache = new Map<string, string>();

/**
 * Check whether a directory contains a `.lore.json` with a non-empty
 * `workspaces` array. This is the strongest signal for a workspace root —
 * the user explicitly declared it.
 */
function hasLoreWorkspacesConfig(dir: string): boolean {
  const configPath = join(dir, ".lore.json");
  if (!existsSync(configPath)) return false;
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf8"));
    return Array.isArray(raw.workspaces) && raw.workspaces.length > 0;
  } catch {
    return false;
  }
}

/** Check whether any of the given marker files/dirs exist in `dir`. */
function hasAnyMarker(dir: string, markers: readonly string[]): boolean {
  for (const marker of markers) {
    if (existsSync(join(dir, marker))) return true;
  }
  return false;
}

/**
 * Walk up from `startDir` toward the filesystem root, checking for project
 * markers at each level. Returns the highest meaningful project root.
 *
 * Priority (checked at each directory level):
 *   1. `.lore.json` with `workspaces` field (definitive — strongest signal)
 *   2. VCS markers: `.git`, `.hg`, `.svn`, `.jj`, etc. (definitive)
 *   3. Workspace markers: `pnpm-workspace.yaml`, `nx.json`, etc. (definitive)
 *   4. Language markers: `package.json`, `pyproject.toml`, etc. (closest-wins)
 *
 * The walk stops at `os.homedir()` to prevent walking into system directories.
 * Results are cached for the process lifetime.
 *
 * In hosted mode, returns `startDir` unchanged (no filesystem traversal with
 * client-controlled paths).
 */
export function discoverWorkspaceRoot(startDir: string): string {
  if (isHostedMode()) return startDir;

  const resolved = resolve(startDir);
  const cached = workspaceRootCache.get(resolved);
  if (cached !== undefined) return cached;

  const stopBoundary = homedir();
  const seen = new Set<string>();
  let closestLanguageMarker: string | null = null;
  let current = resolved;

  while (true) {
    // Cycle detection via realpath
    let real: string;
    try {
      real = realpathSync(current);
    } catch {
      // Broken symlink or permission denied — stop walking
      break;
    }
    if (seen.has(real)) break;
    seen.add(real);

    // Stop boundary — check BEFORE marker detection so we never claim
    // $HOME as a workspace root (many devs have ~/.git for dotfiles).
    if (current === stopBoundary) break;

    // 1. .lore.json with workspaces — strongest signal
    if (hasLoreWorkspacesConfig(current)) {
      workspaceRootCache.set(resolved, current);
      return current;
    }

    // 2. VCS markers — definitive root
    if (hasAnyMarker(current, VCS_MARKERS)) {
      workspaceRootCache.set(resolved, current);
      return current;
    }

    // 3. Workspace markers — definitive root
    if (hasAnyMarker(current, WORKSPACE_MARKERS)) {
      workspaceRootCache.set(resolved, current);
      return current;
    }

    // 4. Language markers — remember closest, but keep walking
    if (
      closestLanguageMarker === null &&
      hasAnyMarker(current, LANGUAGE_MARKERS)
    ) {
      closestLanguageMarker = current;
    }

    const parent = dirname(current);
    if (parent === current) break; // filesystem root
    current = parent;
  }

  const result = closestLanguageMarker ?? resolved;
  workspaceRootCache.set(resolved, result);
  return result;
}

// ---------------------------------------------------------------------------
// Downward resolution — resolveWorkspaces()
// ---------------------------------------------------------------------------

/** Process-lifetime cache for workspace resolution. */
const workspacesCache = new Map<string, string[]>();

/** Check if a string contains glob metacharacters. */
function isGlob(pattern: string): boolean {
  return /[*?[\]]/.test(pattern);
}

/**
 * Simple single-segment glob matcher for patterns like `packages/*`.
 * Only supports `*` (match any) and `?` (match one character).
 * Bracket expressions `[...]` are not supported for simplicity.
 */
function matchGlob(name: string, pattern: string): boolean {
  // Convert glob to regex: * → .*, ? → .
  const regex = new RegExp(
    "^" +
      pattern
        .replace(/[.+^${}()|\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".") +
      "$",
  );
  return regex.test(name);
}

/**
 * Resolve workspace patterns to concrete sub-project directories.
 *
 * Patterns can be:
 *   - Literal relative paths: `"project-a"`, `"tools/cli"`
 *   - Single-level globs: `"packages/*"`, `"apps/*"`
 *
 * For glob patterns containing a `/` (e.g. `packages/*`), the prefix before
 * the glob segment is treated as a parent directory to scan, and the glob
 * segment filters its children.
 *
 * Returns deduplicated absolute paths of directories that actually exist.
 * Results are cached for the process lifetime.
 *
 * In hosted mode, returns an empty array (no filesystem traversal with
 * client-controlled paths).
 */
export function resolveWorkspaces(
  rootDir: string,
  patterns: string[],
): string[] {
  if (isHostedMode()) return [];
  if (patterns.length === 0) return [];

  const resolvedRoot = resolve(rootDir);
  const rootPrefix = resolvedRoot + "/";
  const cacheKey = `${resolvedRoot}\0${patterns.join("\0")}`;
  const cached = workspacesCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const results = new Set<string>();

  for (const pattern of patterns) {
    if (!isGlob(pattern)) {
      // Literal path — resolve and check existence
      const absPath = resolve(resolvedRoot, pattern);
      // Guard: resolved path must be under rootDir (prevent "../" escapes)
      if (!absPath.startsWith(rootPrefix)) continue;
      try {
        if (statSync(absPath).isDirectory()) {
          results.add(absPath);
        }
      } catch {
        // Does not exist or not accessible — skip
      }
      continue;
    }

    // Glob pattern — split into parent dir + glob segment
    // e.g. "packages/*" → parent="packages", globPart="*"
    // e.g. "*" → parent=".", globPart="*"
    const lastSlash = pattern.lastIndexOf("/");
    const parentRel = lastSlash >= 0 ? pattern.slice(0, lastSlash) : ".";
    const globPart = lastSlash >= 0 ? pattern.slice(lastSlash + 1) : pattern;
    const parentAbs = resolve(resolvedRoot, parentRel);

    // Guard: glob parent must be under (or equal to) rootDir
    if (parentAbs !== resolvedRoot && !parentAbs.startsWith(rootPrefix))
      continue;

    try {
      const entries = readdirSync(parentAbs, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        // Skip dot-prefixed directories (.git, .vscode, etc.) — matches
        // npm/pnpm workspace glob behavior.
        if (entry.name.startsWith(".")) continue;
        if (matchGlob(entry.name, globPart)) {
          results.add(join(parentAbs, entry.name));
        }
      }
    } catch {
      // Parent dir does not exist or not readable — skip
    }
  }

  const result = Array.from(results);
  workspacesCache.set(cacheKey, result);
  return result;
}

// ---------------------------------------------------------------------------
// Cache management (for tests)
// ---------------------------------------------------------------------------

/**
 * Clear all workspace discovery caches.
 * Intended for test harnesses that need deterministic behavior.
 */
export function clearWorkspaceCache(): void {
  workspaceRootCache.clear();
  workspacesCache.clear();
}
