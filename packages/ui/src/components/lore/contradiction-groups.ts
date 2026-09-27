/**
 * Group open contradiction pairs by project for /ui/contradictions (#1919).
 * A pair belongs to a project only when both sides share the same non-null
 * project_id; anything else — differing ids or a global (null) side — goes to
 * the single cross-project group, rendered last.
 */
import type { ContradictionListItem } from "~/contracts";

export const CROSS_PROJECT_KEY = "cross-project";

export interface ContradictionGroup {
  /** Project id, or "cross-project". */
  key: string;
  /** Project name (or id when the name is null), or "Cross-project". */
  label: string;
  projectId: string | null;
  crossProject: boolean;
  pairs: ContradictionListItem[];
}

export function groupContradictions(
  pairs: readonly ContradictionListItem[],
): ContradictionGroup[] {
  const byProject = new Map<string, ContradictionGroup>();
  const cross: ContradictionGroup = {
    key: CROSS_PROJECT_KEY,
    label: "Cross-project",
    projectId: null,
    crossProject: true,
    pairs: [],
  };

  for (const pair of pairs) {
    const projectId =
      pair.project_id_a !== null && pair.project_id_a === pair.project_id_b
        ? pair.project_id_a
        : null;
    if (projectId === null) {
      cross.pairs.push(pair);
      continue;
    }
    let group = byProject.get(projectId);
    if (!group) {
      group = {
        key: projectId,
        label: pair.project_name_a ?? projectId,
        projectId,
        crossProject: false,
        pairs: [],
      };
      byProject.set(projectId, group);
    }
    group.pairs.push(pair);
  }

  const groups = [...byProject.values()].sort(
    (a, b) =>
      b.pairs.length - a.pairs.length ||
      a.label.localeCompare(b.label) ||
      a.key.localeCompare(b.key),
  );
  if (cross.pairs.length > 0) groups.push(cross);
  return groups;
}
