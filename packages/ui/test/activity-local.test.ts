import { afterEach, describe, expect, it, vi } from "vitest";
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
import { closeLoreDb, openLoreDb, type LoreUiDb } from "~/db";

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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

  it("replays pre-hydration reads over persisted activity fields", async () => {
    const db = await openLoreDb({ factory: new IDBFactory() });
    if (!db) throw new Error("database did not open");
    const key = "knowledge:project-1:entry-1";
    await db.put("activityState", {
      key,
      archived_at: 5,
      pinned_at: 6,
    });
    const pendingDb = deferred<LoreUiDb | null>();
    const state = createActivityLocalState(() => pendingDb.promise);

    state.markRead(key, 3, 10);
    pendingDb.resolve(db);
    await state.flush();

    expect(state.record(key)).toMatchObject({
      archived_at: 5,
      pinned_at: 6,
      read_total: 3,
      read_at: 10,
    });
    expect(
      (await db.getAll("activityState")).find((record) => record.key === key),
    ).toMatchObject({
      archived_at: 5,
      pinned_at: 6,
      read_total: 3,
      read_at: 10,
    });
  });

  it("writes through a replacement database handle and rehydrates its snapshot", async () => {
    const oldDb = await openLoreDb({ factory: new IDBFactory() });
    const newDb = await openLoreDb({ factory: new IDBFactory() });
    if (!oldDb || !newDb) throw new Error("database did not open");
    const key = "knowledge:project-1:entry-1";
    await newDb.put("activityState", { key, archived_at: 5 });
    let current = oldDb;
    const state = createActivityLocalState(async () => current);
    await state.ready;

    current = newDb;
    state.markRead(key, 3, 10);
    await state.flush();

    expect(await newDb.get("activityState", key)).toMatchObject({
      archived_at: 5,
      read_total: 3,
      read_at: 10,
    });
    await state.rehydrate();
    expect(state.record(key)).toMatchObject({
      archived_at: 5,
      read_total: 3,
      read_at: 10,
    });
  });

  it("keeps later writes enabled when a hydration replay put fails", async () => {
    const db = await openLoreDb({ factory: new IDBFactory() });
    if (!db) throw new Error("database did not open");
    const key = "knowledge:project-1:entry-1";
    await db.put("activityState", { key, archived_at: 5 });

    const transaction = db.transaction.bind(db);
    let rejectReplayPut = true;
    vi.spyOn(db, "transaction").mockImplementation((...args) => {
      const tx = transaction(...args);
      if (!rejectReplayPut || args[1] !== "readwrite") return tx;
      rejectReplayPut = false;
      const store = tx.objectStore("activityState");
      const activityStore = store as unknown as {
        put: (record: { key: string }) => Promise<string>;
      };
      activityStore.put = () => Promise.reject(new Error("replay put failed"));
      return tx;
    });

    const state = createActivityLocalState(async () => db);
    state.markRead(key, 3, 10);
    await state.ready;
    state.pin(key, 11);
    await state.flush();

    expect(await db.get("activityState", key)).toMatchObject({
      archived_at: 5,
      read_total: 3,
      read_at: 10,
      pinned_at: 11,
    });
  });

  it("persists actions arriving while hydration replay writes are pending", async () => {
    const db = await openLoreDb({ factory: new IDBFactory() });
    if (!db) throw new Error("database did not open");
    const firstKey = "knowledge:project-1:first";
    const secondKey = "knowledge:project-1:second";
    await db.put("activityState", { key: firstKey, pinned_at: 6 });
    await db.put("activityState", { key: secondKey, archived_at: 7 });

    const replayPutStarted = deferred<void>();
    const releaseReplayPut = deferred<void>();
    const transaction = db.transaction.bind(db);
    let holdReplayPut = true;
    vi.spyOn(db, "transaction").mockImplementation((...args) => {
      const tx = transaction(...args);
      if (!holdReplayPut || args[1] !== "readwrite") return tx;
      holdReplayPut = false;
      const store = tx.objectStore("activityState");
      const activityStore = store as unknown as {
        put: (record: { key: string }) => Promise<string>;
      };
      const put = activityStore.put.bind(activityStore);
      activityStore.put = async (record) => {
        const write = put(record);
        replayPutStarted.resolve();
        await releaseReplayPut.promise;
        return write;
      };
      return tx;
    });

    const pendingDb = deferred<LoreUiDb | null>();
    const state = createActivityLocalState(() => pendingDb.promise);
    state.archive(firstKey, 11);
    pendingDb.resolve(db);

    await replayPutStarted.promise;
    state.pin(secondKey, 20);
    state.markRead(firstKey, 4, 30);
    releaseReplayPut.resolve();
    await state.flush();

    const expectedFirst = {
      archived_at: 11,
      pinned_at: 6,
      read_total: 4,
      read_at: 30,
    };
    const expectedSecond = { archived_at: 7, pinned_at: 20 };
    expect(state.record(firstKey)).toMatchObject(expectedFirst);
    expect(state.record(secondKey)).toMatchObject(expectedSecond);
    const records = await db.getAll("activityState");
    expect(records.find((record) => record.key === firstKey)).toMatchObject(
      expectedFirst,
    );
    expect(records.find((record) => record.key === secondKey)).toMatchObject(
      expectedSecond,
    );
  });

  it("replays a pre-hydration folder move over persisted folders", async () => {
    const db = await openLoreDb({ factory: new IDBFactory() });
    if (!db) throw new Error("database did not open");
    await db.put("activityFolders", {
      key: "F1",
      name: "First",
      keys: ["a"],
      created_at: 1,
    });
    await db.put("activityFolders", {
      key: "F2",
      name: "Second",
      keys: ["b"],
      created_at: 2,
    });
    const pendingDb = deferred<LoreUiDb | null>();
    const state = createActivityLocalState(() => pendingDb.promise);

    state.moveToFolder(["a"], "F2");
    pendingDb.resolve(db);
    await state.flush();

    const folders = state.snapshot().folders;
    const persistedFolders = await db.getAll("activityFolders");
    expect(
      folders.map((folder) => [folder.key, [...folder.keys].sort()]),
    ).toEqual([
      ["F1", []],
      ["F2", ["a", "b"]],
    ]);
    expect(
      persistedFolders.map((folder) => [folder.key, [...folder.keys].sort()]),
    ).toEqual([
      ["F1", []],
      ["F2", ["a", "b"]],
    ]);
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

it("applies checked-item transitions together and persists every record", async () => {
  const db = await openLoreDb({ factory: new IDBFactory() });
  if (!db) throw new Error("database did not open");
  const state = createActivityLocalState(async () => db);
  await state.ready;
  const keys = ["knowledge:project-1:alpha", "knowledge:project-1:beta"];

  state.applyBatch(
    keys.map((key) => ({
      key,
      transition: (record) => pin(record, 10),
    })),
  );
  await state.flush();
  expect(await db.getAll("activityState")).toEqual(
    keys.map((key) => ({ key, pinned_at: 10 })),
  );

  state.applyBatch(keys.map((key) => ({ key, transition: unpin })));
  await state.flush();
  expect(await db.getAll("activityState")).toEqual(
    keys.map((key) => ({ key })),
  );
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
