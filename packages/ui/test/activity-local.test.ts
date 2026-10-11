import { afterEach, describe, expect, it } from "vitest";
import { IDBFactory } from "./idb-globals";

import {
  archive,
  createActivityLocalState,
  createFolder,
  deleteFolder,
  folderNameError,
  markRead,
  markReadTo,
  markUnread,
  moveToFolder,
  pin,
  renameFolder,
  unarchive,
  unpin,
} from "~/state/activity-local";
import {
  activityItemKey,
  activityUnreadChip,
  clientFilter,
  unreadCount,
} from "~/state/activity-filter";
import type { ActivityItem } from "~/contracts";
import { parseActivityQuery } from "@loreai/core/activity-query";
import { closeLoreDb, openLoreDb } from "~/db";

afterEach(async () => {
  await closeLoreDb();
});

const item: ActivityItem = {
  kind: "knowledge",
  id: "entry-1",
  project_id: "project-1",
  project_name: "Project",
  title: "Entry",
  snippet: "Content",
  participants: [],
  last_activity_at: 1_700_000_000_000,
  total: 4,
  match: "exact",
};

describe("activity local transitions", () => {
  it("keeps read positions monotonic and supports unread, archive, and pin", () => {
    const state = { key: activityItemKey(item) };
    expect(markRead(state, 3, 10)).toMatchObject({
      read_total: 3,
      read_at: 10,
    });
    expect(markReadTo(markRead(state, 3, 10), 2, 11).read_total).toBe(3);
    expect(markUnread(state, 12).read_total).toBe(0);
    expect(archive(state, 13).archived_at).toBe(13);
    expect(unarchive(archive(state, 13))).not.toHaveProperty("archived_at");
    expect(pin(state, 14).pinned_at).toBe(14);
    expect(unpin(pin(state, 14))).not.toHaveProperty("pinned_at");
  });

  it("hydrates and persists activity state and folders", async () => {
    const db = await openLoreDb({ factory: new IDBFactory() });
    expect(db).not.toBeNull();
    const state = createActivityLocalState(async () => db);
    await state.ready;
    const key = activityItemKey(item);
    state.markRead(key, 2, 10);
    state.archive(key, 11);
    state.pin(key, 12);
    state.createFolder("Work", "folder-1", 13);
    state.moveToFolder([key], "folder-1");
    await state.flush();

    const reloaded = createActivityLocalState(async () => db);
    await reloaded.ready;
    expect(reloaded.record(key)).toMatchObject({
      read_total: 2,
      archived_at: 11,
      pinned_at: 12,
    });
    expect(reloaded.snapshot().folders).toMatchObject([
      { key: "folder-1", name: "Work", keys: [key], created_at: 13 },
    ]);
  });

  it("keeps transitions available without IndexedDB", async () => {
    const state = createActivityLocalState(async () => null);
    await state.ready;
    state.markRead("session:p:s", 1, 10);
    state.createFolder("Work", "folder-1", 11);
    expect(state.record("session:p:s").read_total).toBe(1);
    expect(state.snapshot().folders[0]?.name).toBe("Work");
  });

  it("validates unique folder names and moves keys exclusively", () => {
    const first = createFolder([], " Work ", "one", 1)[0]!;
    expect(first.name).toBe("Work");
    expect(folderNameError("  ", [first])).toContain("required");
    expect(folderNameError("work", [first])).toContain("already exists");
    const renamed = renameFolder([first], "one", "Notes");
    expect(renamed[0]?.name).toBe("Notes");
    const second = createFolder(renamed, "Other", "two", 2)[1]!;
    const moved = moveToFolder(
      [
        { ...first, keys: ["a", "b"] },
        { ...second, keys: ["b", "c"] },
      ],
      ["b"],
      "one",
    );
    expect(moved.map((folder) => folder.keys)).toEqual([["a", "b"], ["c"]]);
    expect(deleteFolder(moved, "one").map((folder) => folder.key)).toEqual([
      "two",
    ]);
  });
});

describe("activity client filtering", () => {
  const key = activityItemKey(item);
  const state = {
    records: {
      [key]: {
        key,
        read_total: 2,
        archived_at: item.last_activity_at,
        pinned_at: 2,
      },
    },
    folders: [
      { key: "folder-1", name: "Work Notes", keys: [key], created_at: 1 },
    ],
  };
  const filter = (query: string, local = state) =>
    clientFilter(item, parseActivityQuery(query).client, local);

  it("filters unread/read, pinned, archive, inbox reappearance, and folders", () => {
    expect(unreadCount(item, state)).toBe(2);
    expect(activityUnreadChip(item, state)).toEqual({
      label: "2 of 4",
      unread: true,
    });
    expect(activityUnreadChip(item, { records: {}, folders: [] })).toEqual({
      label: "4 msgs",
      unread: true,
    });
    expect(
      activityUnreadChip(item, {
        ...state,
        records: { [key]: { key, read_total: item.total } },
      }),
    ).toEqual({ label: "4 msgs", unread: false });
    expect(filter("is:unread")).toBe(true);
    expect(filter("is:read")).toBe(false);
    expect(filter("is:pinned")).toBe(true);
    expect(filter("in:archive")).toBe(true);
    expect(filter("in:inbox")).toBe(false);
    expect(filter('in:folder:"work notes"')).toBe(true);
    expect(filter("in:folder:missing")).toBe(false);
    const newer = {
      ...item,
      last_activity_at: item.last_activity_at + 1,
    };
    expect(
      clientFilter(newer, parseActivityQuery("in:inbox").client, state),
    ).toBe(true);
  });
});
