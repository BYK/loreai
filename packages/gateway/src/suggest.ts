/**
 * suggest.ts — Best-effort project suggestion for mis-grouped sessions.
 *
 * Used by `lore data split` to re-attribute sessions that collapsed into a
 * single "magnet" project (e.g. a gateway cwd or a stale-header bucket). Each
 * session is classified by the strongest signal available, in priority order:
 *
 *   Tier A — the session's CONFIDENT `session_state.project_path` (provisional
 *            = 0). The gateway already resolved this from a header or an
 *            authoritative system-prompt inference; it's the cleanest signal
 *            and is already in the DB.
 *   Tier P — a dominant absolute project path found in stored message content
 *            (tool outputs, file reads) that maps to a known project. Requires
 *            DOMINANCE (single path, OR ≥60% of mentions, OR ≥1.5× the
 *            runner-up) so a session that merely references a sibling project
 *            in passing isn't mis-attributed.
 *   Tier B — a dominant git-remote slug (e.g. `owner/repo`) referenced in
 *            content that maps to a known project's remote. GitHub UI/org
 *            "chrome" slugs (features, sponsors, …) are filtered as noise.
 *
 * Since the system prompt itself is NOT stored in temporal_messages, Tier P/B
 * are inherently best-effort; Tier A is exact when present. Only projects that
 * already exist in the DB are ever suggested — never auto-created.
 *
 * This is the generalized form of the per-machine "magnet repair" script; the
 * user-specific heuristics from that script (lore-vocabulary terms, hardcoded
 * paths) are intentionally NOT included here.
 */

import {
  data,
  projectId,
  projectName,
  projectPath as getProjectPathById,
  temporal,
} from "@loreai/core";
import { AUTHORITATIVE_PATTERN_COUNT, PROJECT_PATH_PATTERNS } from "./config";

export type SessionSuggestion = {
  sessionId: string;
  suggestedProjectId: string | null;
  suggestedProjectName: string | null;
  suggestedProjectPath: string | null;
  confidence: "high" | "low" | null;
  /** Which signal produced the suggestion (diagnostics / review display). */
  tier: "session_state" | "path" | "git_remote" | null;
  matchedPath: string | null;
};

/**
 * GitHub "slugs" that are UI chrome / org pages, not project repos. References
 * to these must never count toward attribution (a session that links to
 * `github.com/features/...` in passing is not "the features project").
 */
const NOISE_ORGS = new Set([
  "features",
  "orgs",
  "enterprise",
  "sponsors",
  "marketplace",
  "topics",
  "about",
  "pricing",
  "settings",
  "login",
  "join",
  "new",
  "notifications",
  "site",
  "contact",
  "security",
  "readme",
  "apps",
  "customer-stories",
  "solutions",
  "resources",
]);

function isNoiseSlug(slug: string): boolean {
  return NOISE_ORGS.has(slug.split("/")[0]);
}

/** Normalize a git remote URL to a lowercase `owner/repo` slug. */
function slugOf(remote: string): string {
  return remote
    .replace(/^git@github\.com:/, "")
    .replace(/^https?:\/\/github\.com\//, "")
    .replace(/^github\.com\//, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/**
 * Attempt to suggest the correct project for a session.
 *
 * Returns a suggestion with a confidence level:
 *  - `"high"` — Tier A (confident session_state), or an authoritative path /
 *    dominant git-remote slug that maps to a known project.
 *  - `"low"`  — a weak (`/home|/Users` catch-all) path match.
 *  - `null`   — no usable signal.
 */
export function suggestProjectForSession(
  sessionId: string,
  sourceProjectId: string,
  sourceProjectPath: string,
): SessionSuggestion {
  const noSuggestion: SessionSuggestion = {
    sessionId,
    suggestedProjectId: null,
    suggestedProjectName: null,
    suggestedProjectPath: null,
    confidence: null,
    tier: null,
    matchedPath: null,
  };

  const build = (
    pid: string,
    confidence: "high" | "low",
    tier: "session_state" | "path" | "git_remote",
  ): SessionSuggestion => ({
    sessionId,
    suggestedProjectId: pid,
    suggestedProjectName: projectName(pid),
    suggestedProjectPath: getProjectPathById(pid),
    confidence,
    tier,
    matchedPath: getProjectPathById(pid),
  });

  // --- Tier A: confident session_state.project_path (strongest signal) ---
  const confidentPath = data.getSessionConfidentProjectPath(sessionId);
  if (confidentPath && confidentPath !== sourceProjectPath) {
    const pid = projectId(confidentPath);
    if (pid && pid !== sourceProjectId) {
      return build(pid, "high", "session_state");
    }
  }

  // Load all stored messages for this session in the source project.
  let messages: Array<{ content: string }>;
  try {
    messages = temporal.bySession(sourceProjectPath, sessionId);
  } catch {
    return noSuggestion;
  }
  if (!messages.length) return noSuggestion;
  const allContent = messages.map((m) => m.content).join("\n");

  // --- Tier P: dominant absolute project path in content ---
  // Count each known-project path by how many distinct messages mention it,
  // tracking the strongest (lowest-index) pattern that produced it.
  const pathCounts = new Map<
    string,
    { count: number; bestPatternIndex: number }
  >();
  for (let i = 0; i < PROJECT_PATH_PATTERNS.length; i++) {
    const pattern = PROJECT_PATH_PATTERNS[i];
    const flags = pattern.flags.includes("g")
      ? pattern.flags
      : `${pattern.flags}g`;
    const globalPattern = new RegExp(pattern.source, flags);
    for (
      let match = globalPattern.exec(allContent);
      match !== null;
      match = globalPattern.exec(allContent)
    ) {
      const rawPath = match[1]?.replace(/\/+$/, "");
      if (!rawPath) continue;
      const pid = projectId(rawPath);
      if (!pid || pid === sourceProjectId) continue;
      const existing = pathCounts.get(pid);
      if (existing) {
        existing.count++;
        existing.bestPatternIndex = Math.min(existing.bestPatternIndex, i);
      } else {
        pathCounts.set(pid, { count: 1, bestPatternIndex: i });
      }
    }
  }
  if (pathCounts.size > 0) {
    const sorted = [...pathCounts.entries()].sort(
      (a, b) => b[1].count - a[1].count,
    );
    const [topPid, topInfo] = sorted[0];
    const topN = topInfo.count;
    const runnerN = sorted[1]?.[1].count ?? 0;
    const total = sorted.reduce((sum, [, info]) => sum + info.count, 0);
    // Dominance: a single path, a strong plurality (≥60%), or a clear lead
    // (≥1.5× the runner-up). Otherwise the session is genuinely split across
    // projects — fall through to the git-remote scan / give up.
    const dominant =
      sorted.length === 1 || topN >= 0.6 * total || topN >= 1.5 * runnerN;
    if (dominant) {
      const authoritative =
        topInfo.bestPatternIndex < AUTHORITATIVE_PATTERN_COUNT;
      return build(topPid, authoritative ? "high" : "low", "path");
    }
  }

  // --- Tier B: dominant git-remote slug referenced in content ---
  // Build slug → projectId from known project remotes, then count references.
  const slugToPid = new Map<string, string>();
  for (const p of data.listProjects()) {
    if (!p.git_remote) continue;
    const slug = slugOf(p.git_remote);
    if (!slug || isNoiseSlug(slug)) continue;
    if (p.id === sourceProjectId) continue;
    if (!slugToPid.has(slug)) slugToPid.set(slug, p.id);
  }
  if (slugToPid.size > 0) {
    const lowerContent = allContent.toLowerCase();
    const slugCounts: Array<{ pid: string; count: number }> = [];
    for (const [slug, pid] of slugToPid) {
      // Only count the slug when it appears in a git-remote-SHAPED context
      // (`github.com/<slug>` or `git@github.com:<slug>`) followed by a word
      // boundary. This avoids two false positives: (a) a slug matching as a
      // bare substring of a LONGER slug (`onur/widget` inside
      // `onur/widget-helper`), and (b) a bare `owner/repo` mention in prose
      // that isn't actually a repo reference. A real checkout/remote reference
      // is a much stronger attribution signal than an in-passing mention.
      const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(
        `(?:github\\.com/|git@github\\.com:)${escaped}(?![\\w/-])`,
        "g",
      );
      const count = (lowerContent.match(re) ?? []).length;
      if (count > 0) slugCounts.push({ pid, count });
    }
    if (slugCounts.length > 0) {
      slugCounts.sort((a, b) => b.count - a.count);
      const top = slugCounts[0];
      const runner = slugCounts[1]?.count ?? 0;
      // A single slug, or a clear lead, attributes. A lone in-passing mention
      // is weak evidence, so a single reference is only `low` confidence
      // (excluded under the default --min-confidence high) — it takes repeated
      // references for a `high`-confidence git-remote attribution.
      if (slugCounts.length === 1 || top.count >= 1.5 * runner) {
        const confidence: "high" | "low" = top.count >= 2 ? "high" : "low";
        return build(top.pid, confidence, "git_remote");
      }
    }
  }

  return noSuggestion;
}

/**
 * Batch version: suggest projects for multiple sessions.
 */
export function suggestProjectsForSessions(
  sessionIds: string[],
  sourceProjectId: string,
  sourceProjectPath: string,
): SessionSuggestion[] {
  return sessionIds.map((id) =>
    suggestProjectForSession(id, sourceProjectId, sourceProjectPath),
  );
}
