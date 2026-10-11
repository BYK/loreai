import { describe, expect, it } from "vitest";

import { ACTIVITY_KINDS } from "@loreai/core/activity-query";
import { ACTIVITY_KIND_UI } from "~/lib/activity-kinds";
import type { ActivityItem } from "~/contracts";
import fixture from "./fixtures/activity.json";

const fixtureRows = fixture.items as ActivityItem[];

describe("activity kind fan-out", () => {
  it("has a core leg, UI route entry, and gateway-shaped fixture row for every kind", () => {
    expect(Object.keys(ACTIVITY_KIND_UI).sort()).toEqual(
      [...ACTIVITY_KINDS].sort(),
    );
    for (const kind of ACTIVITY_KINDS) {
      expect(ACTIVITY_KIND_UI[kind], kind).toBeDefined();
      expect(
        fixtureRows.some((row) => row.kind === kind),
        kind,
      ).toBe(true);
    }
  });

  it("builds kind-specific logical routes through the registry", () => {
    for (const item of fixtureRows) {
      expect(ACTIVITY_KIND_UI[item.kind].href(item)).toMatch(
        /^\/(projects|knowledge|contradictions)/,
      );
    }
  });
});
