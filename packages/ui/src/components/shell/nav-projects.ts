/**
 * Sidebar project sectioning (#1918): Pinned / Recent / filter / All.
 * Pure logic — `Nav` renders what this returns.
 */
import type { ProjectSummary } from "~/contracts";

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

  const recent = unpinned.slice(0, RECENT_LIMIT);
  const rest = unpinned.slice(RECENT_LIMIT);

  const query = filter.trim().toLowerCase();
  const matches = query
    ? sorted.filter(
        (p) =>
          p.name?.toLowerCase().includes(query) ||
          p.path.toLowerCase().includes(query),
      )
    : null;

  return { pinned, recent, rest, matches };
}
