import { describe, expect, it } from "vitest";

import type { DedupPreviewGroup } from "~/contracts";
import { markFrom, markStatus } from "~/lib/dedup-review";

const GROUP: DedupPreviewGroup = {
  group_id: "project:abc",
  scope: "project",
  project_id: "p1",
  suggested_keep_id: "v1",
  candidates: [
    {
      id: "v1",
      logical_id: "k1",
      revision: 3,
      title: "First",
      content_excerpt: "First content",
      scope: "project",
      project_id: "p1",
      category: "gotcha",
      confidence: 0.9,
      source_session: null,
      updated_at: 100,
      score: 0.8,
      reasons: ["title_overlap"],
    },
    {
      id: "v2",
      logical_id: "k2",
      revision: 2,
      title: "Second",
      content_excerpt: "Second content",
      scope: "shared",
      project_id: null,
      category: "decision",
      confidence: 0.7,
      source_session: "s1",
      updated_at: null,
      score: 0.8,
      reasons: ["embedding_similarity"],
    },
  ],
};

describe("dedup review decisions", () => {
  it("builds a local mark with sorted logical merge ids and revision snapshot", () => {
    expect(markFrom(GROUP, "accept", "k2", "p1")).toMatchObject({
      key: "p1/project:abc",
      kind: "dedup",
      projectId: "p1",
      groupId: "project:abc",
      decision: "accept",
      keepId: "k2",
      mergeIds: ["k1"],
      expectedRevisions: { k1: 3, k2: 2 },
    });
  });

  it("distinguishes pending, accepted, skipped and stale marks", () => {
    expect(markStatus(GROUP, undefined)).toBe("pending");
    const accepted = markFrom(GROUP, "accept", "k1", "p1");
    expect(markStatus(GROUP, accepted)).toBe("accepted");
    expect(markStatus(GROUP, { ...accepted, decision: "skip" })).toBe(
      "skipped",
    );

    const changedRevision = {
      ...GROUP,
      candidates: GROUP.candidates.map((candidate) =>
        candidate.logical_id === "k2"
          ? { ...candidate, revision: candidate.revision + 1 }
          : candidate,
      ),
    };
    expect(markStatus(changedRevision, accepted)).toBe("stale");

    const changedMembership = {
      ...GROUP,
      candidates: GROUP.candidates.slice(0, 1),
    };
    expect(markStatus(changedMembership, accepted)).toBe("stale");
    expect(
      markStatus(GROUP, {
        ...accepted,
        expectedRevisions: {
          ...accepted.expectedRevisions,
          "unexpected-entry": 1,
        },
      }),
    ).toBe("stale");
  });
});
