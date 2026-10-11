import { describe, expect, it } from "vitest";

import { parseActivityQuery } from "@loreai/core/activity-query";
import type { ActivityItem } from "~/contracts";
import {
  activityItemKey,
  clientFilter,
  DEFAULT_ACTIVITY_LOCAL_STATE,
} from "~/state/activity-filter";
import type { ActivityLocalSnapshot } from "~/state/activity-local";

const item: ActivityItem = {
  kind: "knowledge",
  id: "entry-1",
  project_id: "project-1",
  project_name: "Project",
  title: "Entry",
  snippet: "Content",
  participants: [],
  last_activity_at: 1_700_000_000_000,
  total: 1,
  match: "exact",
};

const filter = (q: string, state = DEFAULT_ACTIVITY_LOCAL_STATE) =>
  clientFilter(item, parseActivityQuery(q).client, state);

describe("activity client filters", () => {
  it("uses stable activity keys and keeps the PR2 inbox readable", () => {
    expect(activityItemKey(item)).toBe("knowledge:project-1:entry-1");
    expect(filter("in:inbox")).toBe(true);
    expect(filter("is:unread")).toBe(true);
  });

  it("leaves archive, folder, read and pinned results empty by default", () => {
    expect(filter("in:archive")).toBe(false);
    expect(filter("in:folder:work")).toBe(false);
    expect(filter("is:read")).toBe(false);
    expect(filter("is:pinned")).toBe(false);
  });

  it("uses local read and archive state when supplied", () => {
    const key = activityItemKey(item);
    const state: ActivityLocalSnapshot = {
      records: {
        [key]: {
          key,
          archived_at: item.last_activity_at,
          pinned_at: item.last_activity_at,
          read_total: item.total,
        },
      },
      folders: [],
    };
    expect(filter("in:archive is:read is:pinned", state)).toBe(true);
    expect(filter("in:inbox", state)).toBe(false);
    expect(filter("is:unread", state)).toBe(false);
  });
});
