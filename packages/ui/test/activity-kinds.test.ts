import { describe, expect, it } from "vitest";

import { ACTIVITY_KINDS } from "@loreai/core/activity-query";
import { ACTIVITY_LEGS } from "@loreai/core/activity";
import { ACTIVITY_KIND_UI } from "~/lib/activity-kinds";
import type { ActivityItem } from "~/contracts";
import fixture from "./fixtures/activity.json";

const fixtureRows = fixture.items as ActivityItem[];

describe("activity kind fan-out", () => {
  it("has a core leg, UI route entry, and gateway-shaped fixture row for every kind", () => {
    for (const kind of ACTIVITY_KINDS) {
      expect(ACTIVITY_LEGS[kind], kind).toBeDefined();
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
