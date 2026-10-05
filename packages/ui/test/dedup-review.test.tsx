import { render, screen } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";

import type { DedupPreviewGroup } from "~/contracts";
import { loreFileConsequence, markFrom, markStatus } from "~/lib/dedup-review";

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

  it("describes the affected project for project groups", () => {
    const projectGroup = {
      ...GROUP,
      candidates: GROUP.candidates.map((candidate) => ({
        ...candidate,
        project_id: "p1",
      })),
    };
    expect(
      loreFileConsequence(projectGroup, "k1", "p1", [
        { id: "p1", name: "Project" },
      ]),
    ).toBe(
      "Regenerates .lore.md for this project (when .lore.md export is enabled)",
    );
  });

  it("does not claim projectless removed candidates regenerate an export", () => {
    const global = {
      ...GROUP,
      scope: "global" as const,
      project_id: null,
      candidates: GROUP.candidates.map((candidate) => ({
        ...candidate,
        project_id: null,
      })),
    };
    expect(loreFileConsequence(global, "k1", "p1", [])).toBe(
      ".lore.md files are not affected (the removed entries belong to no project)",
    );
  });

  it("names another project when a removed global candidate belongs to it", () => {
    const global = {
      ...GROUP,
      scope: "global" as const,
      project_id: null,
      candidates: [
        GROUP.candidates[0]!,
        { ...GROUP.candidates[1]!, project_id: "p2" },
      ],
    };
    expect(
      loreFileConsequence(global, "k1", "p1", [
        { id: "p2", name: "Other Project" },
      ]),
    ).toBe(
      "Regenerates .lore.md for Other Project (when .lore.md export is enabled)",
    );
  });

  it("lists distinct affected projects in first-seen order", () => {
    const global = {
      ...GROUP,
      scope: "global" as const,
      project_id: null,
      candidates: [
        GROUP.candidates[0]!,
        { ...GROUP.candidates[1]!, logical_id: "third", project_id: "p2" },
        { ...GROUP.candidates[1]!, logical_id: "fourth", project_id: "p3" },
        { ...GROUP.candidates[1]!, logical_id: "fifth", project_id: "p2" },
      ],
    };
    expect(
      loreFileConsequence(global, "k1", "p1", [
        { id: "p2", name: "Project Two" },
        { id: "p3", name: "Project Three" },
      ]),
    ).toBe(
      "Regenerates .lore.md for Project Two, Project Three (when .lore.md export is enabled)",
    );
  });

  it("ignores a project assigned only to the keeper", () => {
    const global = {
      ...GROUP,
      scope: "global" as const,
      project_id: null,
      candidates: [
        { ...GROUP.candidates[0]!, project_id: "p2" },
        { ...GROUP.candidates[1]!, project_id: null },
      ],
    };
    expect(
      loreFileConsequence(global, "k1", "p1", [
        { id: "p2", name: "Other Project" },
      ]),
    ).toBe(
      ".lore.md files are not affected (the removed entries belong to no project)",
    );
  });

  it("falls back to the project id when its name is unknown", () => {
    const global = {
      ...GROUP,
      scope: "global" as const,
      project_id: null,
      candidates: [
        GROUP.candidates[0]!,
        { ...GROUP.candidates[1]!, project_id: "missing-project" },
      ],
    };
    expect(loreFileConsequence(global, "k1", "p1", [])).toContain(
      "missing-project",
    );
  });

  it("renders a hostile project name as inert text", () => {
    const global = {
      ...GROUP,
      scope: "global" as const,
      project_id: null,
      candidates: [
        GROUP.candidates[0]!,
        { ...GROUP.candidates[1]!, project_id: "p2" },
      ],
    };
    const consequence = loreFileConsequence(global, "k1", "p1", [
      { id: "p2", name: "<img src=x onerror=alert(1)>" },
    ]);
    render(() => <p>{consequence}</p>);
    expect(
      screen.getByText(
        "Regenerates .lore.md for <img src=x onerror=alert(1)> (when .lore.md export is enabled)",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
});
