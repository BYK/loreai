/**
 * scope.ts — Worktree-aware path enumeration for conversation import.
 *
 * Agent history (Codex/Claude/Pi/OpenCode/...) is keyed by the directory the
 * agent actually ran in. A single git repo's history is therefore spread across
 * its main checkout and every worktree/clone path. lore's runtime project
 * resolution already collapses those to one project (git remote +
 * `project_path_aliases`), but import historically matched only `process.cwd()`,
 * so it silently missed every session recorded under a sibling worktree.
 *
 * `projectSearchPaths()` computes the union of:
 *   1. the current project path (always first),
 *   2. every worktree path reported by `git worktree list --porcelain`, and
 *   3. every path lore already associates with this project in its DB.
 *
 * All branches fail open: any git/DB error degrades to `[projectPath]` and never
 * throws. In hosted mode the git subprocess is skipped entirely (never run git
 * against a client-controlled cwd — mirrors `getGitRemote`).
 */
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { isHostedMode } from "../hosted";
import { projectKnownPaths } from "../db";

/**
 * Enumerate all filesystem paths that should be treated as the same project as
 * `projectPath` for conversation import. The returned array is deduplicated and
 * always begins with the resolved `projectPath`.
 *
 * @param projectPath  The directory import was invoked for (typically cwd).
 * @param opts.worktrees  When `false`, restrict to `projectPath` only (plus DB
 *                        aliases are also skipped — the caller asked for cwd
 *                        scope). Defaults to `true`.
 */
export function projectSearchPaths(
  projectPath: string,
  opts?: { worktrees?: boolean },
): string[] {
  try {
    const base = resolve(projectPath);
    const ordered: string[] = [base];

    // `--no-worktrees` restricts to the current directory only.
    if (opts?.worktrees === false) return ordered;

    // 1. git worktrees for the repo containing `base`.
    for (const p of gitWorktreePaths(base)) ordered.push(p);

    // 2. DB-known paths (main path + aliases) for the resolved project.
    try {
      for (const p of projectKnownPaths(base)) ordered.push(resolve(p));
    } catch {
      // fail open — DB unavailable / project unknown
    }

    // Dedupe, preserving order (base guaranteed first).
    return [...new Set(ordered)];
  } catch {
    // Fail open: never let path resolution / DB access break import detection.
    return [projectPath];
  }
}

/**
 * Return the worktree paths reported by `git worktree list --porcelain`,
 * resolved to absolute paths. Returns `[]` on any failure (not a repo, git
 * missing, timeout) and in hosted mode.
 */
function gitWorktreePaths(cwd: string): string[] {
  // Never run git subprocesses against a client-controlled cwd on a hosted
  // gateway (same invariant as getGitRemote()).
  if (isHostedMode()) return [];

  try {
    const output = execSync("git worktree list --porcelain", {
      cwd,
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"], // suppress stderr
    });
    const paths: string[] = [];
    for (const line of output.split("\n")) {
      // Porcelain format: each worktree stanza starts with `worktree <path>`.
      if (line.startsWith("worktree ")) {
        const p = line.slice("worktree ".length).trim();
        if (p) paths.push(resolve(p));
      }
    }
    return paths;
  } catch {
    return [];
  }
}
