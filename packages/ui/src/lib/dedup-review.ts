import type { DedupPreviewGroup } from "~/contracts";
import type { DedupReviewMark } from "~/db";

export type DedupReviewStatus = "pending" | "accepted" | "skipped" | "stale";

export function markStatus(
  group: DedupPreviewGroup,
  mark: DedupReviewMark | undefined,
): DedupReviewStatus {
  if (!mark) return "pending";

  const candidateIds = group.candidates.map(
    (candidate) => candidate.logical_id,
  );
  const markedIds = [mark.keepId, ...mark.mergeIds];
  const candidateSet = new Set(candidateIds);
  const markedSet = new Set(markedIds);
  const membershipMatches =
    candidateSet.size === candidateIds.length &&
    markedSet.size === markedIds.length &&
    candidateSet.size === markedSet.size &&
    [...candidateSet].every((id) => markedSet.has(id));
  const revisionIds = Object.keys(mark.expectedRevisions);
  const revisionsMatch =
    revisionIds.length === candidateSet.size &&
    group.candidates.every(
      (candidate) =>
        mark.expectedRevisions[candidate.logical_id] === candidate.revision,
    );
  if (!membershipMatches || !revisionsMatch) return "stale";
  return mark.decision === "accept" ? "accepted" : "skipped";
}

export function markFrom(
  group: DedupPreviewGroup,
  decision: DedupReviewMark["decision"],
  keepId: string,
  projectId = group.project_id ?? "shared",
  contentFromId?: string,
): DedupReviewMark {
  const keep = group.candidates.find(
    (candidate) => candidate.logical_id === keepId,
  );
  if (!keep) throw new Error("Keeper must be a candidate in the group");

  const mergeIds = group.candidates
    .map((candidate) => candidate.logical_id)
    .filter((id) => id !== keepId)
    .sort();
  if (contentFromId !== undefined && !mergeIds.includes(contentFromId))
    throw new Error("Content source must be a merge candidate in the group");
  return {
    key: `${projectId}/${group.group_id}`,
    kind: "dedup",
    projectId,
    groupId: group.group_id,
    decision,
    keepId,
    mergeIds,
    expectedRevisions: Object.fromEntries(
      group.candidates.map((candidate) => [
        candidate.logical_id,
        candidate.revision,
      ]),
    ),
    ...(contentFromId === undefined ? {} : { contentFromId }),
    markedAt: Date.now(),
  };
}

export function loreFileConsequence(
  group: DedupPreviewGroup,
  keepId: string,
  routeProjectId: string,
  projects: readonly { id: string; name: string | null }[],
  contentFromId?: string,
): string {
  const affectedProjects = group.candidates
    .filter(
      (candidate) =>
        candidate.logical_id !== keepId && candidate.project_id !== null,
    )
    .map((candidate) => candidate.project_id as string);
  if (contentFromId !== undefined) {
    const keeper = group.candidates.find(
      (candidate) => candidate.logical_id === keepId,
    );
    if (keeper?.project_id !== null && keeper?.project_id !== undefined)
      affectedProjects.push(keeper.project_id);
  }
  const uniqueProjects = [...new Set(affectedProjects)];
  if (uniqueProjects.length === 0)
    return ".lore.md files are not affected (the removed entries belong to no project)";

  const labels = uniqueProjects.map((id) =>
    id === routeProjectId
      ? "this project"
      : (projects.find((project) => project.id === id)?.name ?? id),
  );
  return `Regenerates .lore.md for ${labels.join(", ")} (when .lore.md export is enabled)`;
}
