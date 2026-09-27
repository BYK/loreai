/**
 * Pure grouping logic for /ui/contradictions (#1919).
 */
import { describe, expect, it } from "vitest";

import {
  groupContradictions,
  CROSS_PROJECT_KEY,
} from "~/components/lore/contradiction-groups";
import type { ContradictionListItem } from "~/contracts";

const pair = (
  overrides: Partial<ContradictionListItem> = {},
): ContradictionListItem => ({
  id_a: "a",
  id_b: "b",
  title_a: "A",
  title_b: "B",
  similarity: 0.9,
  rationale: null,
  detected_at: 1,
  project_id_a: "p1",
  project_name_a: "one",
  project_id_b: "p1",
  project_name_b: "one",
  ...overrides,
});

describe("groupContradictions", () => {
  it("groups a same-project pair under that project", () => {
    const groups = groupContradictions([pair()]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!).toMatchObject({
      key: "p1",
      label: "one",
      projectId: "p1",
      crossProject: false,
    });
    expect(groups[0]!.pairs).toHaveLength(1);
  });

  it("sends differing project ids to cross-project", () => {
    const groups = groupContradictions([
      pair({ project_id_b: "p2", project_name_b: "two" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.key).toBe(CROSS_PROJECT_KEY);
    expect(groups[0]!.crossProject).toBe(true);
  });

  it("sends a pair with a null side to cross-project", () => {
    const groups = groupContradictions([
      pair({ project_id_b: null, project_name_b: null }),
    ]);
    expect(groups[0]!.key).toBe(CROSS_PROJECT_KEY);
  });

  it("sends a pair where both sides are null to cross-project", () => {
    const groups = groupContradictions([
      pair({
        project_id_a: null,
        project_name_a: null,
        project_id_b: null,
        project_name_b: null,
      }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.key).toBe(CROSS_PROJECT_KEY);
  });

  it("orders project groups by count desc then label, cross-project last", () => {
    const groups = groupContradictions([
      pair({
        id_a: "1",
        project_id_a: "p-zed",
        project_name_a: "zed",
        project_id_b: "p-zed",
        project_name_b: "zed",
      }),
      pair({
        id_a: "2",
        project_id_a: "p-alpha",
        project_name_a: "alpha",
        project_id_b: "p-alpha",
        project_name_b: "alpha",
      }),
      pair({ id_a: "3", project_id_a: "p-alpha", project_id_b: "p-alpha" }),
      pair({ id_a: "4", project_id_b: "other" }), // cross-project
    ]);
    expect(groups.map((g) => g.key)).toEqual([
      "p-alpha",
      "p-zed",
      CROSS_PROJECT_KEY,
    ]);
    expect(groups[0]!.pairs).toHaveLength(2);
  });

  it("uses the project id as label when the name is null", () => {
    const groups = groupContradictions([
      pair({ project_name_a: null, project_name_b: null }),
    ]);
    expect(groups[0]!.label).toBe("p1");
  });

  it("keeps input order within a group and returns [] for empty input", () => {
    expect(groupContradictions([])).toEqual([]);
    const groups = groupContradictions([
      pair({ id_a: "first" }),
      pair({ id_a: "second" }),
    ]);
    expect(groups[0]!.pairs.map((p) => p.id_a)).toEqual(["first", "second"]);
  });
});
