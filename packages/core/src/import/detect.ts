/**
 * Detection orchestrator — scans all registered providers for conversation
 * history matching a given project path.
 */
import type { DetectionResult } from "./types";
import { getProviders } from "./providers";
import { projectSearchPaths } from "./scope";

/**
 * Scan all registered providers for conversation history matching the
 * given project path.
 *
 * Detection is worktree-aware: agent history is keyed by the directory the
 * agent ran in, so a repo's history is spread across its main checkout and
 * every worktree/clone path. `detectAll` resolves that full set of paths (see
 * `projectSearchPaths`) and matches sessions recorded under any of them, unless
 * `opts.worktrees === false` (restrict to `projectPath` only).
 *
 * @returns Results from all providers that found data, sorted by
 *          total messages descending (richest source first).
 */
export function detectAll(
  projectPath: string,
  opts?: { worktrees?: boolean },
): DetectionResult[] {
  const results: DetectionResult[] = [];
  const paths = projectSearchPaths(projectPath, opts);

  for (const provider of getProviders()) {
    try {
      const sessions = provider.detect(paths);
      if (sessions.length > 0) {
        results.push({
          agentName: provider.name,
          agentDisplayName: provider.displayName,
          sessions,
          totalTokens: sessions.reduce(
            (s, sess) => s + sess.estimatedTokens,
            0,
          ),
          totalMessages: sessions.reduce((s, sess) => s + sess.messageCount, 0),
        });
      }
    } catch (_err) {
      // Provider failed (e.g. corrupt DB, missing directory) — skip silently.
      // Avoid log.warn to not alarm users about agents they don't use.
    }
  }

  return results.sort((a, b) => b.totalMessages - a.totalMessages);
}
