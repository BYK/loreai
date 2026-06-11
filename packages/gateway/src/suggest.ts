/**
 * suggest.ts — Best-effort project suggestion for mis-grouped sessions.
 *
 * Scans stored temporal message content (tool outputs, file paths, etc.) for
 * absolute project paths using the same `PROJECT_PATH_PATTERNS` used by the
 * gateway to infer the project path from system prompts. Matches are compared
 * against known projects in the DB. Since the system prompt itself is NOT
 * stored in temporal_messages, this is inherently best-effort / low-confidence.
 */

import {
  projectId,
  projectName,
  projectPath as getProjectPathById,
  temporal,
} from "@loreai/core";
import { PROJECT_PATH_PATTERNS, AUTHORITATIVE_PATTERN_COUNT } from "./config";

export type SessionSuggestion = {
  sessionId: string;
  suggestedProjectId: string | null;
  suggestedProjectName: string | null;
  suggestedProjectPath: string | null;
  confidence: "high" | "low" | null;
  matchedPath: string | null;
};

/**
 * Attempt to suggest the correct project for a session by scanning its
 * stored message content for absolute project paths.
 *
 * Returns a suggestion with a confidence level:
 *  - `"high"` — matched by an authoritative pattern (cwd field, Working
 *    directory line, or .lore.md path) AND maps to a known project.
 *  - `"low"` — matched by the generic `/home|/Users` catch-all pattern
 *    or maps to an unknown project path.
 *  - `null` — no match found.
 *
 * Only suggests projects that already exist in the DB. Never auto-creates
 * from a suggestion.
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
    matchedPath: null,
  };

  // Load all stored messages for this session in the source project.
  let messages: Array<{ content: string }>;
  try {
    messages = temporal.bySession(sourceProjectPath, sessionId);
  } catch {
    return noSuggestion;
  }

  if (!messages.length) return noSuggestion;

  // Concatenate all message content for pattern scanning.
  const allContent = messages.map((m) => m.content).join("\n");

  // Track candidate matches with frequency and best confidence.
  const candidates = new Map<
    string,
    { count: number; bestPatternIndex: number }
  >();

  for (let i = 0; i < PROJECT_PATH_PATTERNS.length; i++) {
    const pattern = PROJECT_PATH_PATTERNS[i];
    // Use a global copy to find all matches, not just the first.
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

      // Look up in the DB — only suggest paths that map to known projects.
      const pid = projectId(rawPath);
      if (!pid || pid === sourceProjectId) continue;

      const existing = candidates.get(pid);
      if (existing) {
        existing.count++;
        existing.bestPatternIndex = Math.min(existing.bestPatternIndex, i);
      } else {
        candidates.set(pid, { count: 1, bestPatternIndex: i });
      }
    }
  }

  if (candidates.size === 0) return noSuggestion;

  // Pick the candidate with the best (lowest) pattern index, breaking ties
  // by frequency.
  let bestPid: string | null = null;
  let bestScore = { patternIndex: Number.MAX_SAFE_INTEGER, count: 0 };
  for (const [pid, info] of candidates) {
    if (
      info.bestPatternIndex < bestScore.patternIndex ||
      (info.bestPatternIndex === bestScore.patternIndex &&
        info.count > bestScore.count)
    ) {
      bestPid = pid;
      bestScore = { patternIndex: info.bestPatternIndex, count: info.count };
    }
  }

  if (!bestPid) return noSuggestion;

  const isAuthoritative = bestScore.patternIndex < AUTHORITATIVE_PATTERN_COUNT;

  return {
    sessionId,
    suggestedProjectId: bestPid,
    suggestedProjectName: projectName(bestPid),
    suggestedProjectPath: getProjectPathById(bestPid),
    confidence: isAuthoritative ? "high" : "low",
    matchedPath: getProjectPathById(bestPid),
  };
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
