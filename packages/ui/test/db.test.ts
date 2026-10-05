/**
 * IndexedDB cache tests over fake-indexeddb: schema/upgrade/recovery in
 * `open.ts`, TTL+LRU eviction in `repository.ts`, local working-state stores.
 */
import { describe, expect, it } from "vitest";
import { IDBFactory } from "./idb-globals";

import {
  closeLoreDb,
  createDraftsStore,
  createKnowledgeRepo,
  createMessageBlocksRepo,
  createPendingChangesStore,
  createReviewDecisionsStore,
  createProjectsRepo,
  createSessionsRepo,
  getMeta,
  LORE_DB_NAME,
  LORE_DB_VERSION,
  openLoreDb,
  resetCache,
  setMeta,
  type DedupApplyRecord,
  type LocalDraft,
  type PendingChange,
} from "~/db";
import { createRepository } from "~/db/repository";
import { LOCAL_CAP } from "~/db/local";
import { createDedupReviewState } from "~/state/dedup-review";
import type {
  KnowledgeEntry,
  ProjectSummary,
  SessionSummary,
} from "~/contracts";
import type { MessageBlock } from "~/db";

const PROJECT: ProjectSummary = {
  id: "p1",
  path: "/home/me/lore",
  name: "lore",
  git_remote: null,
  created_at: 1_700_000_000_000,
  knowledge_count: 1,
  session_count: 0,
  message_count: 0,
  distillation_count: 0,
  last_activity: null,
};

const ENTRY: KnowledgeEntry = {
  id: "k1",
  project_id: "p1",
  category: "decision",
  title: "Keep SQLite",
  content: "Portability.",
  confidence: 0.9,
};

function factory(): IDBFactory {
  return new IDBFactory();
}

async function open(f: IDBFactory) {
  await closeLoreDb();
  return openLoreDb({ factory: f });
}

describe("openLoreDb", () => {
  it("creates a v4 database with every store", async () => {
    const f = factory();
    const db = await open(f);
    expect(db).not.toBeNull();
    expect(db!.version).toBe(LORE_DB_VERSION);
    for (const name of [
      "meta",
      "projects",
      "knowledge",
      "sessions",
      "entities",
      "messageBlocks",
      "collections",
      "drafts",
      "pendingChanges",
      "reviewDecisions",
    ] as const) {
      expect(db!.objectStoreNames.contains(name)).toBe(true);
    }
  });

  it("upgrades v3 to v4 without dropping local data", async () => {
    const f = factory();
    const v3 = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = f.open(LORE_DB_NAME, 3);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore("meta", { keyPath: "key" });
        for (const name of [
          "projects",
          "knowledge",
          "sessions",
          "messageBlocks",
          "entities",
        ]) {
          const store = db.createObjectStore(name, { keyPath: "key" });
          store.createIndex("by-scope", "scope");
          store.createIndex("by-accessed", "accessedAt");
          store.createIndex("by-stored", "storedAt");
        }
        db.createObjectStore("collections", { keyPath: "key" });
        const drafts = db.createObjectStore("drafts", { keyPath: "key" });
        drafts.createIndex("by-updated", "updatedAt");
        const pending = db.createObjectStore("pendingChanges", {
          keyPath: "key",
        });
        pending.createIndex("by-created", "createdAt");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = v3.transaction(
        ["meta", "drafts", "pendingChanges"],
        "readwrite",
      );
      tx.objectStore("meta").put({
        key: "theme",
        value: "dark",
        updatedAt: 1,
      });
      tx.objectStore("drafts").put({
        key: "p1/k1",
        kind: "knowledge",
        target: "k1",
        body: { title: "Draft", content: "", category: "gotcha" },
        updatedAt: 1,
      });
      tx.objectStore("pendingChanges").put({
        key: "change-1",
        op: "update",
        entity: "knowledge",
        target: "k1",
        payload: {},
        createdAt: 1,
        attempts: 0,
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    v3.close();

    const db = await open(f);
    expect(db?.version).toBe(4);
    expect(await getMeta(db, "theme")).toBe("dark");
    expect(await createDraftsStore(db).get("p1/k1")).toMatchObject({
      body: { title: "Draft" },
    });
    expect(await createPendingChangesStore(db).get("change-1")).toMatchObject({
      attempts: 0,
    });
    const marks = createReviewDecisionsStore(db);
    await marks.put({
      key: "p1/group-1",
      kind: "dedup",
      projectId: "p1",
      groupId: "group-1",
      decision: "accept",
      keepId: "k1",
      mergeIds: ["k2"],
      expectedRevisions: { k1: 1, k2: 2 },
      markedAt: 1,
    });
    const applyRecord: DedupApplyRecord = {
      key: "p1/apply/op-1",
      kind: "dedup-apply",
      projectId: "p1",
      operationId: "op-1",
      body: {
        operationId: "op-1",
        projectId: null,
        reviewedAt: 2,
        actor: "lore-ui",
        decisions: [
          {
            keepId: "k1",
            mergeIds: ["k2"],
            expectedRevisions: { k1: 1, k2: 2 },
          },
        ],
      },
      groupIds: ["project:group-1"],
      candidateTitles: { k1: "Keep", k2: "Merge" },
      createdAt: 2,
    };
    await marks.put(applyRecord);
    expect(await marks.list("p1")).toHaveLength(2);

    const state = createDedupReviewState(async () => db);
    expect(await state.list("p1")).toMatchObject([
      { kind: "dedup", groupId: "group-1" },
    ]);
    expect(await state.listApplies("p1")).toEqual([applyRecord]);
  });

  it("upgrades a v1 database without touching meta rows", async () => {
    const f = factory();
    const v1 = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = f.open(LORE_DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore("meta", { keyPath: "key" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = v1.transaction("meta", "readwrite");
      tx.objectStore("meta").put({
        key: "pref",
        value: { theme: "dark" },
        updatedAt: 1,
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    v1.close();

    const db = await open(f);
    expect(db).not.toBeNull();
    expect(db!.version).toBe(4);
    expect(await getMeta(db, "pref")).toEqual({ theme: "dark" });
    expect(db!.objectStoreNames.contains("knowledge")).toBe(true);
    expect(db!.objectStoreNames.contains("entities")).toBe(true);
  });

  it("resets a corrupted database missing stores and reopens", async () => {
    const f = factory();
    // Foreign/corrupted DB at version 2 with only a meta store.
    const bad = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = f.open(LORE_DB_NAME, 2);
      req.onupgradeneeded = () => {
        req.result.createObjectStore("meta", { keyPath: "key" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    bad.close();

    const db = await open(f);
    expect(db).not.toBeNull();
    expect(db!.objectStoreNames.contains("projects")).toBe(true);
    expect(db!.objectStoreNames.contains("collections")).toBe(true);
  });

  it("resets when a higher version exists (VersionError) and reopens at v4", async () => {
    const f = factory();
    const v4 = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = f.open(LORE_DB_NAME, 5);
      req.onupgradeneeded = () => {
        req.result.createObjectStore("meta", { keyPath: "key" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    v4.close();

    const db = await open(f);
    expect(db).not.toBeNull();
    expect(db!.version).toBe(4);
  });

  it("resolves null when open keeps failing", async () => {
    const f = factory();
    const broken = {
      open() {
        throw new Error("no indexeddb");
      },
      deleteDatabase: f.deleteDatabase.bind(f),
    } as unknown as IDBFactory;
    await closeLoreDb();
    const db = await openLoreDb({ factory: broken });
    expect(db).toBeNull();
  });

  it("resolves null with status blocked while an old connection is held", async () => {
    const f = factory();
    // Hold a v1 connection open with no onversionchange handler.
    const old = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = f.open(LORE_DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore("meta", { keyPath: "key" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const statuses: string[] = [];
    await closeLoreDb();
    const db = await openLoreDb({
      factory: f,
      blockedTimeoutMs: 50,
      onStatus: (s) => statuses.push(s),
    });
    expect(db).toBeNull();
    expect(statuses).toContain("blocked");

    old.close();
    await closeLoreDb();
    const db2 = await openLoreDb({ factory: f });
    expect(db2).not.toBeNull();
    expect(db2!.objectStoreNames.contains("projects")).toBe(true);
  });

  it("resetCache leaves the next open with empty stores", async () => {
    const f = factory();
    const db = await open(f);
    await createProjectsRepo(db).put(PROJECT, "all");
    await closeLoreDb();
    await resetCache({ factory: f });
    const db2 = await open(f);
    expect(await createProjectsRepo(db2).getScope("all")).toEqual([]);
  });
});

describe("repositories", () => {
  it("round-trips records by scope", async () => {
    const db = await open(factory());
    const repo = createKnowledgeRepo(db);
    await repo.put(ENTRY, "p1");
    expect(await repo.get("k1")).toEqual(ENTRY);
    expect(await repo.get("missing")).toBeUndefined();
    expect(await repo.getScope("p1")).toEqual([ENTRY]);
    expect(await repo.getScope("other")).toEqual([]);
  });

  it("keeps an existing row scope when requested", async () => {
    const db = await open(factory());
    const repo = createKnowledgeRepo(db);
    await repo.put(ENTRY, "p1");

    const updated = { ...ENTRY, title: "Updated title" };
    await repo.put(updated, "other", { keepScope: true });
    expect(await repo.getScope("p1")).toEqual([updated]);
    expect(await repo.getScope("other")).toEqual([]);

    await repo.put(updated, "other");
    expect(await repo.getScope("p1")).toEqual([]);
    expect(await repo.getScope("other")).toEqual([updated]);
  });

  it("hides and deletes expired rows", async () => {
    const db = await open(factory());
    const now = { t: 1_000_000 };
    const repo = createRepository<KnowledgeEntry>(
      db,
      "knowledge",
      (k) => k.id,
      { maxEntries: 10, maxAgeMs: 100 },
      () => now.t,
    );
    await repo.put(ENTRY, "p1");
    now.t += 200;
    expect(await repo.get("k1")).toBeUndefined();
    expect(await repo.getScope("p1")).toEqual([]);
    // The expired row is physically deleted on the next write.
    await repo.put({ ...ENTRY, id: "k2" }, "p1");
    now.t = 1_000_000 + 1;
    expect(await repo.getScope("p1")).toEqual([{ ...ENTRY, id: "k2" }]);
  });

  it("evicts the least-recently-accessed row past maxEntries", async () => {
    const db = await open(factory());
    const clock = { t: 1_000 };
    const repo = createRepository<KnowledgeEntry>(
      db,
      "knowledge",
      (k) => k.id,
      { maxEntries: 3, maxAgeMs: 1e12 },
      () => clock.t,
    );
    // Adversarial order: a,b,c then `get a` (making it the most recent),
    // then put d — b must be the evicted row, not a or c.
    for (const id of ["a", "b", "c"]) {
      clock.t += 1;
      await repo.put({ ...ENTRY, id }, "p1");
    }
    clock.t += 1;
    await repo.get("a");
    await repo.put({ ...ENTRY, id: "d" }, "p1");
    expect(await repo.get("a")).toBeDefined();
    expect(await repo.get("b")).toBeUndefined();
    expect(await repo.get("c")).toBeDefined();
    expect(await repo.get("d")).toBeDefined();
  });

  it("replaceScope removes stale rows but leaves other scopes alone", async () => {
    const db = await open(factory());
    const repo = createKnowledgeRepo(db);
    await repo.put(ENTRY, "p1");
    await repo.put({ ...ENTRY, id: "k2" }, "p2");
    await repo.putMany([{ ...ENTRY, id: "k3" }], "p1", {
      replaceScope: true,
    });
    expect(await repo.getScope("p1")).toEqual([{ ...ENTRY, id: "k3" }]);
    expect(await repo.getScope("p2")).toEqual([{ ...ENTRY, id: "k2" }]);
  });

  it("tracks collection state per scope", async () => {
    const db = await open(factory());
    const repo = createSessionsRepo(db);
    expect(await repo.collection("p1")).toBeUndefined();
    await repo.setCollection("p1", {
      complete: false,
      count: 0,
      nextCursor: "tok",
      fetchedAt: 1,
    });
    expect(await repo.collection("p1")).toMatchObject({
      store: "sessions",
      scope: "p1",
      complete: false,
      nextCursor: "tok",
    });
  });

  it("collection count outlives the rows it counts", async () => {
    const db = await open(factory());
    const clock = { t: 1000 };
    const repo = createRepository<KnowledgeEntry>(
      db,
      "knowledge",
      (k) => k.id,
      { maxEntries: 2, maxAgeMs: 1e12 },
      () => clock.t,
    );
    await repo.putMany(
      [ENTRY, { ...ENTRY, id: "k2" }, { ...ENTRY, id: "k3" }],
      "p1",
      {
        replaceScope: true,
      },
    );
    await repo.setCollection("p1", {
      complete: true,
      count: 3,
      nextCursor: null,
      fetchedAt: 0,
    });
    // Cap of 2 evicted one row on write; the count still reports the
    // server's 3 so the cache can tell "complete but thinned".
    expect((await repo.getScope("p1")).length).toBe(2);
    expect((await repo.collection("p1"))?.count).toBe(3);
  });

  it("keys sessions by `${projectId}/${session_id}`", async () => {
    const db = await open(factory());
    const repo = createSessionsRepo(db);
    const session: SessionSummary = {
      session_id: "s1",
      message_count: 1,
      first_message_at: 1,
      last_message_at: 2,
      distilled_count: 0,
      undistilled_count: 1,
      distillation_count: 0,
      title: "s1",
      title_source: "id",
    };
    await repo.put(session, "p1");
    expect(await repo.get("p1/s1")).toEqual(session);
  });

  it("splits and joins message blocks", async () => {
    const db = await open(factory());
    const repo = createMessageBlocksRepo(db);
    const block: MessageBlock = {
      sessionKey: "p1/s1",
      index: 0,
      messages: [],
    };
    await repo.put(block, "p1/s1");
    expect(await repo.get("p1/s1#0")).toEqual(block);
  });

  it("degrades to no-ops on a null db", async () => {
    const repo = createKnowledgeRepo(null);
    await repo.put(ENTRY, "p1");
    expect(await repo.get("k1")).toBeUndefined();
    expect(await repo.getScope("p1")).toEqual([]);
    await repo.delete("k1");
    await repo.clear();
    expect(await repo.collection("p1")).toBeUndefined();
    await repo.setCollection("p1", {
      complete: true,
      count: 0,
      nextCursor: null,
      fetchedAt: 0,
    });
  });

  it("rejects local working-state types at the type level", () => {
    const repo = createKnowledgeRepo(null);
    const draft: LocalDraft = {
      key: "d1",
      kind: "knowledge",
      target: null,
      body: { title: "t", content: "c", category: "decision" },
      updatedAt: 0,
    };
    const change: PendingChange = {
      key: "pc1",
      op: "create",
      entity: "knowledge",
      target: null,
      payload: {},
      createdAt: 0,
      attempts: 0,
    };
    // @ts-expect-error local drafts are not KnowledgeEntry records
    void repo.put(draft, "p1");
    // @ts-expect-error pending changes are not KnowledgeEntry records
    void repo.put(change, "p1");
    expect(true).toBe(true);
  });
});

describe("local working-state stores", () => {
  it("round-trips drafts and pending changes", async () => {
    const db = await open(factory());
    const drafts = createDraftsStore(db);
    const pending = createPendingChangesStore(db);
    const draft: LocalDraft = {
      key: "d1",
      kind: "knowledge",
      target: "k1",
      body: { title: "t", content: "c", category: "gotcha" },
      updatedAt: 5,
    };
    await drafts.put(draft);
    expect(await drafts.get("d1")).toEqual(draft);
    expect(await drafts.list()).toEqual([draft]);
    const change: PendingChange = {
      key: "pc1",
      op: "update",
      entity: "knowledge",
      target: "k1",
      payload: { title: "t2" },
      createdAt: 6,
      attempts: 0,
    };
    await pending.put(change);
    expect(await pending.get("pc1")).toEqual(change);
    expect(await pending.list()).toEqual([change]);
    await drafts.delete("d1");
    expect(await drafts.get("d1")).toBeUndefined();
    await pending.clear();
    expect(await pending.list()).toEqual([]);
  });

  it("keeps unavailable review decisions in memory for the session", async () => {
    const marks = createReviewDecisionsStore(null);
    const mark = {
      key: "p1/group-1",
      kind: "dedup" as const,
      projectId: "p1",
      groupId: "group-1",
      decision: "skip" as const,
      keepId: "k1",
      mergeIds: ["k2"],
      expectedRevisions: { k1: 1, k2: 1 },
      markedAt: 1,
    };
    await marks.put(mark);
    expect(await marks.get(mark.key)).toEqual(mark);
    expect(await marks.list("p1")).toEqual([mark]);
    expect(await marks.list("other")).toEqual([]);
    await marks.delete(mark.key);
    expect(await marks.get(mark.key)).toBeUndefined();
  });

  it("does not evict the newly written oldest draft", async () => {
    const db = await open(factory());
    const drafts = createDraftsStore(db);
    const rows: LocalDraft[] = Array.from({ length: LOCAL_CAP }, (_, i) => ({
      key: `d${i}`,
      kind: "knowledge",
      target: null,
      body: { title: `title ${i}`, content: "content", category: "pattern" },
      updatedAt: i + 1,
    }));
    for (const row of rows) await drafts.put(row);

    const oldest = {
      key: "new-oldest",
      kind: "knowledge" as const,
      target: null,
      body: { title: "old", content: "content", category: "pattern" },
      updatedAt: 0,
    };
    await drafts.put(oldest);

    expect(await drafts.list()).toHaveLength(LOCAL_CAP);
    expect(await drafts.get(oldest.key)).toEqual(oldest);
    expect(await drafts.get("d0")).toBeUndefined();
    expect(await drafts.get("d1")).toEqual(rows[1]);
  });

  it("meta accessor round-trips", async () => {
    const db = await open(factory());
    await setMeta(db, "k", { a: 1 });
    expect(await getMeta(db, "k")).toEqual({ a: 1 });
    expect(await getMeta(db, "missing")).toBeUndefined();
  });
});
