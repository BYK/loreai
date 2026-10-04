/**
 * Sidebar project sectioning (#1918): Pinned / Recent / filter / All.
 * Pure logic — `Nav` renders what this returns.
 */
import type { ProjectSummary } from "~/contracts";
import { fuzzyRank, normalizeFuzzy, FUZZY_MIN_QUERY } from "~/lib/fuzzy";

export const RECENT_LIMIT = 5;

export interface ProjectSections {
  /** Projects whose id is in `pinnedIds`, in pin order. */
  pinned: ProjectSummary[];
  /** First RECENT_LIMIT non-pinned projects by recency. */
  recent: ProjectSummary[];
  /** Remaining non-pinned projects by recency. */
  rest: ProjectSummary[];
  /** Filter hits (pinned included), or null when the filter is empty. */
  matches: ProjectSummary[] | null;
  /** True when the filter produced hits but none is an exact substring
   *  match (#1948) — the UI shows an "approximate matches" hint. The
   *  active-project prepend does not count. */
  approximate: boolean;
}

/**
 * last_activity desc, nulls last, then created_at desc. Mirrors the
 * server-side ORDER BY so a cached list written before the server
 * ordering existed still renders correctly.
 */
export function byRecency(a: ProjectSummary, b: ProjectSummary): number {
  // `?? null` covers cached rows written before `last_activity` existed.
  const activityA = a.last_activity ?? null;
  const activityB = b.last_activity ?? null;
  if (activityA === null && activityB === null) {
    return b.created_at - a.created_at;
  }
  if (activityA === null) return 1;
  if (activityB === null) return -1;
  return activityB - activityA || b.created_at - a.created_at;
}

export function sectionProjects(
  projects: readonly ProjectSummary[],
  pinnedIds: readonly string[],
  filter: string,
  activeId: string | null = null,
): ProjectSections {
  const sorted = [...projects].sort(byRecency);
  const byId = new Map(projects.map((p) => [p.id, p]));

  const pinned: ProjectSummary[] = [];
  for (const id of pinnedIds) {
    const project = byId.get(id);
    if (project) pinned.push(project);
  }
  const pinnedSet = new Set(pinned.map((p) => p.id));
  const unpinned = sorted.filter((p) => !pinnedSet.has(p.id));

  let recent = unpinned.slice(0, RECENT_LIMIT);
  let rest = unpinned.slice(RECENT_LIMIT);
  const active = activeId
    ? rest.find((project) => project.id === activeId)
    : undefined;
  if (active) {
    recent = [active, ...recent];
    rest = rest.filter((project) => project.id !== active.id);
  }

  const query = filter.trim();
  const activeProject = activeId ? byId.get(activeId) : undefined;
  let matches: ProjectSummary[] | null = null;
  let approximate = false;
  if (query) {
    if (normalizeFuzzy(query).length >= FUZZY_MIN_QUERY) {
      // `sorted` is recency-ordered, so fuzzyRank's stable score-desc sort
      // keeps recency order among equal scores; exact hits rank first (#1948).
      const hits = fuzzyRank(query, sorted, (p) => [p.name ?? "", p.path]);
      matches = hits.map((hit) => hit.item);
      approximate = hits.length > 0 && hits.every((hit) => !hit.exact);
    } else {
      // Below FUZZY_MIN_QUERY fuzzy matching is too noisy — plain substring.
      const lowered = query.toLowerCase();
      matches = sorted.filter(
        (p) =>
          p.name?.toLowerCase().includes(lowered) ||
          p.path.toLowerCase().includes(lowered),
      );
    }
  }
  if (
    matches &&
    activeProject &&
    !matches.some((project) => project.id === activeProject.id)
  ) {
    matches = [activeProject, ...matches];
  }

  return { pinned, recent, rest, matches, approximate };
}
