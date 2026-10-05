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
): DedupReviewMark {
  const keep = group.candidates.find(
    (candidate) => candidate.logical_id === keepId,
  );
  if (!keep) throw new Error("Keeper must be a candidate in the group");

  const mergeIds = group.candidates
    .map((candidate) => candidate.logical_id)
    .filter((id) => id !== keepId)
    .sort();
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
    markedAt: Date.now(),
  };
}
