import { describe, expect, it } from "vitest";
import { IDBFactory } from "./idb-globals";

import { closeLoreDb, createDraftsStore, openLoreDb } from "~/db";
import {
  createDiscussionsState,
  newDiscussionDraftKey,
  replyDraftKey,
} from "~/state/discussions";

/** A client whose every member throws: drafts must never reach the API. */
const neverClient = new Proxy(
  {},
  {
    get(_t, name) {
      throw new Error(`draft path touched client.${String(name)}`);
    },
  },
) as never;

describe("discussion drafts", () => {
  it("persist in IndexedDB across a reopen and never call the API", async () => {
    const factory = new IDBFactory();
    await closeLoreDb();
    const db = await openLoreDb({ factory });
    const state = createDiscussionsState({
      client: neverClient,
      tracked: (read) => read(),
      db: () => Promise.resolve(db),
    });
    const key = replyDraftKey("d1");
    await state.drafts.put({
      key,
      projectId: "p1",
      target: "d1",
      body: { text: "half-written thought" },
    });
    await closeLoreDb();

    const reopened = await openLoreDb({ factory });
    const again = createDiscussionsState({
      client: neverClient,
      tracked: (read) => read(),
      db: () => Promise.resolve(reopened),
    });
    expect(await again.drafts.get(key)).toMatchObject({
      kind: "discussion",
      projectId: "p1",
      target: "d1",
      body: { text: "half-written thought" },
    });
    await again.drafts.delete(key);
    expect(await again.drafts.get(key)).toBeUndefined();
  });

  it("does not surface knowledge drafts as discussion drafts", async () => {
    await closeLoreDb();
    const db = await openLoreDb({ factory: new IDBFactory() });
    await createDraftsStore(db).put({
      key: "discussion-reply:k",
      kind: "knowledge",
      target: null,
      body: { title: "t", content: "c", category: "gotcha" },
      updatedAt: 1,
    });
    const state = createDiscussionsState({
      client: neverClient,
      tracked: (read) => read(),
      db: () => Promise.resolve(db),
    });
    expect(await state.drafts.get("discussion-reply:k")).toBeUndefined();
  });

  it("degrades to no-ops without IndexedDB", async () => {
    const state = createDiscussionsState({
      client: neverClient,
      tracked: (read) => read(),
      db: () => Promise.resolve(null),
    });
    await state.drafts.put({
      key: "x",
      projectId: "p1",
      target: null,
      body: { text: "t" },
    });
    expect(await state.drafts.get("x")).toBeUndefined();
  });

  it("keys new-discussion drafts by project, source and exact anchor", () => {
    const anchor = {
      blockId: "m.1",
      partIndex: 0,
      start: 1,
      end: 4,
      contentHash: "abc",
    };
    const k1 = newDiscussionDraftKey(
      "p1",
      { kind: "session", id: "s1" },
      anchor,
    );
    const k2 = newDiscussionDraftKey(
      "p1",
      { kind: "session", id: "s1" },
      { ...anchor, end: 5 },
    );
    const k3 = newDiscussionDraftKey(
      "p2",
      { kind: "session", id: "s1" },
      anchor,
    );
    expect(new Set([k1, k2, k3]).size).toBe(3);
  });
});
