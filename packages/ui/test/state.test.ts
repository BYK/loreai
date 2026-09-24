/**
 * State layer tests: cache-first loading, server reconciliation, cursor page
 * merging, entity-store identity — with a controllable mocked client and a
 * fake-indexeddb cache.
 */
import { describe, expect, it, vi } from "vitest";
import { createComputed, createRoot, createSignal } from "solid-js";
import { IDBFactory } from "./idb-globals";

import type { ApiClient } from "~/lib/api";
import { ApiError } from "~/lib/api";
import {
  closeLoreDb,
  createKnowledgeRepo,
  createMessageBlocksRepo,
  createProjectsRepo,
  createSessionsRepo,
  openLoreDb,
} from "~/db";
import { createRepository } from "~/db/repository";
import type { MessageBlock } from "~/db";
import type {
  KnowledgeEntry,
  ProjectSummary,
  SessionDetail,
  TemporalMessage,
} from "~/contracts";
import { mergeCursorPage } from "~/state/pages";
import { createEntityStore } from "~/state/entity-store";
import { createAppState } from "~/state";
import { createProjectsState } from "~/state/projects";
import { createKnowledgeState } from "~/state/knowledge";
import { createSessionsState } from "~/state/sessions";
import { createRecallState } from "~/state/recall";

const PROJECTS: ProjectSummary[] = [
  {
    id: "p1",
    path: "/home/me/lore",
    name: "lore",
    git_remote: null,
    created_at: 1_700_000_000_000,
    knowledge_count: 2,
    session_count: 1,
    message_count: 3,
    distillation_count: 0,
  },
];

const ENTRIES: KnowledgeEntry[] = [
  {
    id: "k1",
    project_id: "p1",
    category: "decision",
    title: "Keep SQLite",
    content: "Portability.",
    confidence: 0.9,
    created_at: 1,
    updated_at: 2,
  },
  {
    id: "k2",
    project_id: "p1",
    category: "gotcha",
    title: "WAL recovery",
    content: "Test it.",
    confidence: 0.5,
    created_at: 1,
    updated_at: 1,
  },
];

function tracked<T>(read: () => Promise<T>): Promise<T> {
  return read();
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush() {
  // Several event-loop turns: IndexedDB (even fake-indexeddb) resolves over
  // multiple tasks, not a single microtask.
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

describe("projects state: cached-first then server", () => {
  it("renders cached rows as stale, then replaces them with the server list", async () => {
    const factory = new IDBFactory();
    await closeLoreDb();
    const handle = (await openLoreDb({ factory }))!;
    await createProjectsRepo(handle).putMany(PROJECTS, "all", {
      replaceScope: true,
    });
    await createProjectsRepo(handle).setCollection("all", {
      complete: true,
      count: 1,
      nextCursor: null,
      fetchedAt: Date.now(),
    });

    const server = deferred<ProjectSummary[]>();
    const client = {
      listProjects: () => server.promise,
    } as unknown as ApiClient;

    const state = createRoot(() =>
      createProjectsState({
        client,
        repo: createProjectsRepo(handle),
        tracked,
      }),
    );
    await flush();
    expect(state.list.data()?.map((p) => p.id)).toEqual(["p1"]);
    expect(state.list.stale()).toBe(true);
    expect(state.list.source()).toBe("cache");
    expect(state.status().stale).toBe(true);

    server.resolve([{ ...PROJECTS[0]!, name: "lore-renamed" }]);
    await flush();
    expect(state.list.data()![0]!.name).toBe("lore-renamed");
    expect(state.list.stale()).toBe(false);
    expect(state.list.source()).toBe("server");
    // The server value was written back through.
    const repo = createProjectsRepo(await openLoreDb({ factory }));
    expect((await repo.getScope("all"))[0]!.name).toBe("lore-renamed");
    await closeLoreDb();
  });

  it("keeps cached rows (stale) when the server rejects", async () => {
    const factory = new IDBFactory();
    await closeLoreDb();
    const db = (await openLoreDb({ factory }))!;
    const repo = createProjectsRepo(db);
    await repo.putMany(PROJECTS, "all", { replaceScope: true });
    await repo.setCollection("all", {
      complete: true,
      count: 1,
      nextCursor: null,
      fetchedAt: 0,
    });

    const server = deferred<ProjectSummary[]>();
    const client = {
      listProjects: () => server.promise,
    } as unknown as ApiClient;
    const state = createRoot(() =>
      createProjectsState({ client, repo, tracked }),
    );
    await flush();
    expect(state.list.source()).toBe("cache");

    server.reject(new Error("down"));
    await flush();
    expect(state.list.error()).toBeInstanceOf(Error);
    expect(state.list.data()?.map((p) => p.id)).toEqual(["p1"]);
    expect(state.list.stale()).toBe(true);
    await closeLoreDb();
  });

  it("never resolves cache-first with an empty scope and no collection", async () => {
    const factory = new IDBFactory();
    await closeLoreDb();
    const db = (await openLoreDb({ factory }))!;
    const server = deferred<ProjectSummary[]>();
    const client = {
      listProjects: () => server.promise,
    } as unknown as ApiClient;
    const state = createRoot(() =>
      createProjectsState({ client, repo: createProjectsRepo(db), tracked }),
    );
    await flush();
    expect(state.list.data()).toBeUndefined();
    expect(state.list.loading()).toBe(true);
    server.resolve(PROJECTS);
    await flush();
    expect(state.list.data()?.length).toBe(1);
    await closeLoreDb();
  });

  it("a server answer before the cache read is never overwritten by it", async () => {
    // Adversarial order: server resolves BEFORE the repo's cached read.
    const gate = deferred<void>();
    const repo = createProjectsRepo(null);
    const slowRepo: typeof repo = {
      ...repo,
      async getScope(scope: string) {
        await gate.promise;
        return repo.getScope(scope);
      },
    };
    const server = deferred<ProjectSummary[]>();
    const client = {
      listProjects: () => server.promise,
    } as unknown as ApiClient;
    const state = createRoot(() =>
      createProjectsState({ client, repo: slowRepo, tracked }),
    );
    await flush();
    server.resolve([{ ...PROJECTS[0]!, name: "fresh" }]);
    await flush();
    gate.resolve();
    await flush();
    expect(state.list.data()![0]!.name).toBe("fresh");
    expect(state.list.source()).toBe("server");
  });
});

describe("knowledge state", () => {
  it("serves the list in the server's order (confidence DESC, updated_at DESC)", async () => {
    const factory = new IDBFactory();
    await closeLoreDb();
    const db = (await openLoreDb({ factory }))!;
    const repo = createKnowledgeRepo(db);
    // Cache rows in the opposite order to prove sorting happens.
    await repo.putMany([ENTRIES[1]!, ENTRIES[0]!], "p1", {
      replaceScope: true,
    });
    await repo.setCollection("p1", {
      complete: true,
      count: 2,
      nextCursor: null,
      fetchedAt: 0,
    });
    const server = deferred<KnowledgeEntry[]>();
    const client = {
      listProjectKnowledge: () => server.promise,
    } as unknown as ApiClient;
    const [projectId] = createSignal("p1");
    createRoot((dispose) => {
      const state = createKnowledgeState({ client, repo, tracked });
      const list = state.list(projectId);
      void (async () => {
        await flush();
        expect(list.loader.data()?.map((k) => k.id)).toEqual(["k1", "k2"]);
        expect(list.loader.stale()).toBe(true);
        server.resolve([ENTRIES[0]!]);
        await flush();
        expect(list.loader.data()?.map((k) => k.id)).toEqual(["k1"]);
        expect(list.loader.stale()).toBe(false);
        dispose();
      })();
    });
    await flush();
    await flush();
    await closeLoreDb();
  });

  it("preserves a global entry in the project list after loading its detail", async () => {
    const factory = new IDBFactory();
    await closeLoreDb();
    const db = (await openLoreDb({ factory }))!;
    const globalEntry = { ...ENTRIES[0]!, project_id: null };
    const client = {
      listProjectKnowledge: () => Promise.resolve([globalEntry, ENTRIES[1]!]),
      getKnowledge: () => Promise.resolve(globalEntry),
    } as unknown as ApiClient;
    const state = createRoot(() =>
      createKnowledgeState({
        client,
        repo: createKnowledgeRepo(db),
        tracked,
      }),
    );

    const list = state.list(() => "p1");
    await flush();
    expect(list.loader.data()).toHaveLength(2);
    expect(list.status().partial).toBe(false);

    const detail = state.entry(() => globalEntry.id);
    await flush();
    expect(detail.loader.data()).toEqual(globalEntry);
    // The detail write-through must not move the row out of the list scope.
    const repo = createKnowledgeRepo(db);
    expect(await repo.getScope("p1")).toHaveLength(2);
    expect(await repo.getScope("global")).toHaveLength(0);

    const fresh = createRoot(() =>
      createKnowledgeState({
        client,
        repo: createKnowledgeRepo(db),
        tracked,
      }),
    ).list(() => "p1");
    await flush();
    expect(fresh.loader.data()).toHaveLength(2);
    expect(fresh.status().partial).toBe(false);
    await closeLoreDb();
  });

  it("evicts a permanently removed entry from memory and IndexedDB", async () => {
    const factory = new IDBFactory();
    await closeLoreDb();
    const db = (await openLoreDb({ factory }))!;
    const repo = createKnowledgeRepo(db);
    await repo.put(ENTRIES[0]!, "p1");
    await repo.setCollection("p1", {
      complete: true,
      count: 1,
      nextCursor: null,
      fetchedAt: 0,
    });
    const notFound = new Error("knowledge entry no longer exists");
    const client = {
      getKnowledge: async () => {
        throw notFound;
      },
      listProjectKnowledge: async () => {
        throw new Error("offline");
      },
    } as unknown as ApiClient;
    const state = createKnowledgeState({ client, repo, tracked });
    state.store.reconcileOne(ENTRIES[0]!);
    state.store.reconcileList("p1", [ENTRIES[0]!], { complete: true });

    await state.remove("k1");
    expect(state.store.select("k1")).toBeUndefined();
    expect(state.store.selectList("p1")).toEqual([]);
    expect(await repo.get("k1")).toBeUndefined();

    const detail = createRoot(() => state.entry(() => "k1"));
    await flush();
    expect(detail.loader.data()).toBeUndefined();
    expect(detail.loader.error()).toBe(notFound);

    const list = createRoot(() => state.list(() => "p1"));
    await flush();
    expect(list.loader.data()).toEqual([]);
    expect(list.status().partial).toBe(true);
    await closeLoreDb();
  });

  it("pages via listPaged with mergeCursorPage", async () => {
    const pages = [
      { items: [ENTRIES[0]!], next_cursor: "tok" },
      { items: [ENTRIES[0]!, ENTRIES[1]!], next_cursor: null },
    ];
    let call = 0;
    const seen: (string | null)[] = [];
    const client = {
      listProjectKnowledgePage: (
        _p: string,
        opts: { cursor?: string | null },
      ) => {
        seen.push(opts.cursor ?? null);
        return Promise.resolve(pages[call++]!);
      },
    } as unknown as ApiClient;
    const state = createKnowledgeState({
      client,
      repo: createKnowledgeRepo(null),
      tracked,
    });
    const paged = state.listPaged("p1");
    await paged.loadMore();
    expect(paged.page()!.items.map((k) => k.id)).toEqual(["k1"]);
    expect(paged.page()!.complete).toBe(false);
    expect(paged.status().partial).toBe(true);
    await paged.loadMore();
    // Dedupe by id across pages.
    expect(paged.page()!.items.map((k) => k.id)).toEqual(["k1", "k2"]);
    expect(paged.page()!.complete).toBe(true);
    expect(paged.status().partial).toBe(false);
    expect(seen).toEqual([null, "tok"]);
    await paged.loadMore();
    expect(call).toBe(2); // complete lists stop fetching
  });

  it("clears a paged-list error after a successful retry", async () => {
    let calls = 0;
    const client = {
      listProjectKnowledgePage: () => {
        calls++;
        return calls === 1
          ? Promise.reject(new Error("temporary failure"))
          : Promise.resolve({
              items: [ENTRIES[0]!],
              next_cursor: null,
            });
      },
    } as unknown as ApiClient;
    const state = createKnowledgeState({
      client,
      repo: createKnowledgeRepo(null),
      tracked,
    });
    const paged = state.listPaged("p1");

    await expect(paged.loadMore()).rejects.toThrow("temporary failure");
    expect(paged.status().error).toBeInstanceOf(Error);
    await paged.loadMore();

    expect(paged.status().error).toBeUndefined();
    expect(paged.page()?.items).toEqual([ENTRIES[0]]);
  });
});

describe("knowledge state: partial collections", () => {
  const ENTRY3: KnowledgeEntry = { ...ENTRIES[0]!, id: "k3" };

  function knowledgeRepoWith(
    db: Parameters<typeof createKnowledgeRepo>[0],
    limits: { maxEntries: number; maxAgeMs: number },
    now?: () => number,
  ) {
    return createRepository<KnowledgeEntry>(
      db,
      "knowledge",
      (k) => k.id,
      limits,
      now,
    );
  }

  it("marks cached rows partial when cap eviction dropped rows", async () => {
    const factory = new IDBFactory();
    await closeLoreDb();
    const db = (await openLoreDb({ factory }))!;
    const repo = knowledgeRepoWith(db, { maxEntries: 2, maxAgeMs: 1e12 });
    // 3 rows under a cap of 2 → one is evicted on write; collection.count
    // records the server's 3.
    await repo.putMany([...ENTRIES, ENTRY3], "p1", { replaceScope: true });
    await repo.setCollection("p1", {
      complete: true,
      count: 3,
      nextCursor: null,
      fetchedAt: 0,
    });

    const server = deferred<KnowledgeEntry[]>();
    const client = {
      listProjectKnowledge: () => server.promise,
    } as unknown as ApiClient;
    const state = createRoot(() =>
      createKnowledgeState({ client, repo, tracked }),
    );
    const list = state.list(() => "p1");
    await flush();
    expect(list.loader.data()!.length).toBe(2);
    expect(list.status().stale).toBe(true);
    expect(list.status().partial).toBe(true);

    server.resolve([...ENTRIES, ENTRY3]);
    await flush();
    expect(list.status().partial).toBe(false);
    expect(list.status().stale).toBe(false);
    await closeLoreDb();
  });

  it("marks scope A partial when scope B's writes evicted its rows", async () => {
    const factory = new IDBFactory();
    await closeLoreDb();
    const db = (await openLoreDb({ factory }))!;
    const clock = { t: 1000 };
    const repo = knowledgeRepoWith(
      db,
      { maxEntries: 3, maxAgeMs: 1e12 },
      () => clock.t,
    );
    // Scope A's two rows are the least-recently-accessed once scope B fills
    // the store past the cap.
    clock.t += 1;
    await repo.putMany(ENTRIES, "a", { replaceScope: true });
    await repo.setCollection("a", {
      complete: true,
      count: 2,
      nextCursor: null,
      fetchedAt: 0,
    });
    for (const id of ["b1", "b2", "b3", "b4"]) {
      clock.t += 1;
      await repo.put({ ...ENTRIES[0]!, id }, "b");
    }

    const server = deferred<KnowledgeEntry[]>();
    const client = {
      listProjectKnowledge: () => server.promise,
    } as unknown as ApiClient;
    const state = createRoot(() =>
      createKnowledgeState({ client, repo, tracked }),
    );
    const list = state.list(() => "a");
    await flush();
    expect(list.loader.data()!.length).toBeLessThan(2);
    expect(list.status().partial).toBe(true);
    await closeLoreDb();
  });

  it("marks a cached list partial when a row aged out", async () => {
    const factory = new IDBFactory();
    await closeLoreDb();
    const db = (await openLoreDb({ factory }))!;
    const clock = { t: 1000 };
    const repo = knowledgeRepoWith(
      db,
      { maxEntries: 50, maxAgeMs: 150 },
      () => clock.t,
    );
    await repo.put(ENTRIES[0]!, "p1"); // stored at t=1000
    clock.t += 100;
    await repo.put(ENTRIES[1]!, "p1"); // stored at t=1100
    await repo.setCollection("p1", {
      complete: true,
      count: 2,
      nextCursor: null,
      fetchedAt: 0,
    });
    clock.t += 140; // t=1240 → cutoff 1090: first row expired, second alive

    const server = deferred<KnowledgeEntry[]>();
    const client = {
      listProjectKnowledge: () => server.promise,
    } as unknown as ApiClient;
    const state = createRoot(() =>
      createKnowledgeState({ client, repo, tracked }),
    );
    const list = state.list(() => "p1");
    await flush();
    expect(list.loader.data()!.length).toBe(1);
    expect(list.status().stale).toBe(true);
    expect(list.status().partial).toBe(true);
    await closeLoreDb();
  });
});

describe("sessions state: detail waits for the project path", () => {
  it("does not fetch (or error) until projectPathOf resolves", async () => {
    const calls: string[] = [];
    const client = {
      getSession: (path: string, sid: string) => {
        calls.push(`${path}/${sid}`);
        return Promise.resolve({ messages: [], distillations: [] });
      },
    } as unknown as ApiClient;
    const [path, setPath] = createSignal<string | undefined>(undefined);
    const state = createRoot(() =>
      createSessionsState({
        client,
        repos: {
          sessions: createSessionsRepo(null),
          messageBlocks: createMessageBlocksRepo(null),
        },
        projectPathOf: () => path(),
        tracked,
      }),
    );
    const detail = state.detail(
      () => "p1",
      () => "s1",
    );
    await flush();
    // Deep link before projects load: idle, not an error.
    expect(calls).toEqual([]);
    expect(detail.loader.error()).toBeUndefined();
    expect(detail.loader.loading()).toBe(false);

    setPath("/home/me/lore");
    await flush();
    expect(calls).toEqual(["/home/me/lore/s1"]);
    expect(detail.loader.data()).toBeTruthy();
    expect(detail.loader.error()).toBeUndefined();
  });

  it("passes session ids containing slashes intact", async () => {
    const calls: Array<[string, string]> = [];
    const client = {
      getSession: (path: string, sid: string) => {
        calls.push([path, sid]);
        return Promise.resolve({ messages: [], distillations: [] });
      },
    } as unknown as ApiClient;
    const state = createRoot(() =>
      createSessionsState({
        client,
        repos: {
          sessions: createSessionsRepo(null),
          messageBlocks: createMessageBlocksRepo(null),
        },
        projectPathOf: () => "/home/me/lore",
        tracked,
      }),
    );

    const detail = state.detail(
      () => "p1",
      () => "a/b",
    );
    await flush();
    expect(calls).toEqual([["/home/me/lore", "a/b"]]);
    expect(detail.loader.error()).toBeUndefined();
  });

  const block = (
    key: string,
    index: number,
    from: number,
    n: number,
  ): MessageBlock => ({
    sessionKey: key,
    index,
    messages: Array.from(
      { length: n },
      (_, i): TemporalMessage => ({
        id: `m${from + i}`,
        project_id: "p1",
        session_id: "s1",
        role: "user",
        content: `msg ${from + i}`,
        tokens: 1,
        distilled: 0,
        created_at: from + i,
        metadata: "{}",
      }),
    ),
  });

  function sessionsState(
    messageBlocks: ReturnType<typeof createMessageBlocksRepo>,
  ) {
    const server = deferred<SessionDetail>();
    const client = {
      getSession: () => server.promise,
    } as unknown as ApiClient;
    const state = createRoot(() =>
      createSessionsState({
        client,
        repos: { sessions: createSessionsRepo(null), messageBlocks },
        projectPathOf: () => "/home/me/lore",
        tracked,
      }),
    );
    return state;
  }

  it("marks cached session detail partial when a message block is missing", async () => {
    const factory = new IDBFactory();
    await closeLoreDb();
    const db = (await openLoreDb({ factory }))!;
    const messageBlocks = createMessageBlocksRepo(db);
    const key = "projectId=p1&sessionId=s1";
    // 250 messages = a full block of 200 plus a tail of 50.
    await messageBlocks.putMany(
      [block(key, 0, 0, 200), block(key, 1, 200, 50)],
      key,
      { replaceScope: true },
    );
    await messageBlocks.setCollection(key, {
      complete: true,
      count: 250,
      nextCursor: null,
      fetchedAt: 0,
    });

    const state = sessionsState(messageBlocks);
    const detail = state.detail(
      () => "p1",
      () => "s1",
    );
    await flush();
    expect(detail.loader.data()!.messages.length).toBe(250);
    expect(detail.status().partial).toBe(false);

    // Evict the tail block → 200 of the server's 250 messages remain.
    await messageBlocks.delete(`${key}#1`);
    const detail2 = state.detail(
      () => "p1",
      () => "s1",
    );
    await flush();
    expect(detail2.loader.data()!.messages.length).toBe(200);
    expect(detail2.status().stale).toBe(true);
    expect(detail2.status().partial).toBe(true);
    await closeLoreDb();
  });

  it("serves an intentionally empty session from cache", async () => {
    const factory = new IDBFactory();
    await closeLoreDb();
    const db = (await openLoreDb({ factory }))!;
    const messageBlocks = createMessageBlocksRepo(db);
    const key = "projectId=p1&sessionId=s1";
    // The server answered with zero messages: no blocks, but the
    // collections row records `count: 0`.
    await messageBlocks.setCollection(key, {
      complete: true,
      count: 0,
      nextCursor: null,
      fetchedAt: 0,
    });

    const state = sessionsState(messageBlocks);
    const detail = state.detail(
      () => "p1",
      () => "s1",
    );
    await flush();
    expect(detail.loader.data()!.messages.length).toBe(0);
    expect(detail.status().stale).toBe(true);
    expect(detail.status().partial).toBe(false);
    await closeLoreDb();
  });

  it("does not cache-hit an empty session with no collections row", async () => {
    const factory = new IDBFactory();
    await closeLoreDb();
    const db = (await openLoreDb({ factory }))!;
    const messageBlocks = createMessageBlocksRepo(db);

    const state = sessionsState(messageBlocks);
    const detail = state.detail(
      () => "p1",
      () => "s1",
    );
    await flush();
    // No blocks and no collections record → cache miss, no stale value.
    expect(detail.loader.data()).toBeUndefined();
    expect(detail.status().stale).toBe(false);
    await closeLoreDb();
  });

  it("marks cached session detail partial when the collections row is missing", async () => {
    const factory = new IDBFactory();
    await closeLoreDb();
    const db = (await openLoreDb({ factory }))!;
    const messageBlocks = createMessageBlocksRepo(db);
    const key = "projectId=p1&sessionId=s1";
    // Legacy write: blocks present, no collections record at all.
    await messageBlocks.putMany([block(key, 0, 0, 10)], key, {
      replaceScope: true,
    });

    const state = sessionsState(messageBlocks);
    const detail = state.detail(
      () => "p1",
      () => "s1",
    );
    await flush();
    expect(detail.loader.data()!.messages.length).toBe(10);
    expect(detail.status().partial).toBe(true);
    await closeLoreDb();
  });
});

describe("mergeCursorPage", () => {
  const keyOf = (v: { id: string }) => v.id;
  it("appends pages and completes only on null", () => {
    const p1 = mergeCursorPage(
      undefined,
      { items: [{ id: "a" }, { id: "b" }], next_cursor: "x" },
      keyOf,
    );
    expect(p1.complete).toBe(false);
    expect(p1.nextCursor).toBe("x");
    const p2 = mergeCursorPage(
      p1,
      { items: [{ id: "b" }, { id: "c" }], next_cursor: "" },
      keyOf,
    );
    expect(p2.items.map((i) => i.id)).toEqual(["a", "b", "c"]);
    // An empty-string cursor is still a cursor — partial.
    expect(p2.complete).toBe(false);
    const p3 = mergeCursorPage(p2, { items: [], next_cursor: null }, keyOf);
    expect(p3.complete).toBe(true);
    expect(p3.items.map((i) => i.id)).toEqual(["a", "b", "c"]);
  });
});

describe("entity store", () => {
  it("reconcile only notifies when a field actually changed", async () => {
    createRoot((dispose) => {
      const store = createEntityStore<KnowledgeEntry>((k) => k.id);
      store.reconcileOne(ENTRIES[0]!);
      let runs = 0;
      createComputed(() => {
        void store.select("k1")?.title;
        runs++;
      });
      expect(runs).toBe(1);
      // Same content: reconcile diffs to a no-op — the observer must not fire.
      store.reconcileOne({ ...ENTRIES[0]! });
      expect(runs).toBe(1);
      store.reconcileOne({ ...ENTRIES[0]!, title: "changed" });
      expect(runs).toBe(2);
      dispose();
    });
  });

  it("reconcileList appends on partial and replaces on complete", () => {
    createRoot((dispose) => {
      const store = createEntityStore<KnowledgeEntry>((k) => k.id);
      store.reconcileList("p1", [ENTRIES[0]!], { complete: false });
      store.reconcileList("p1", [ENTRIES[1]!], { complete: false });
      expect(store.selectList("p1")?.map((k) => k.id)).toEqual(["k1", "k2"]);
      expect(store.statusOf("p1").partial).toBe(true);
      store.reconcileList("p1", [ENTRIES[1]!], { complete: true });
      expect(store.selectList("p1")?.map((k) => k.id)).toEqual(["k2"]);
      expect(store.statusOf("p1").partial).toBe(false);
      dispose();
    });
  });
});

describe("paged sessions and recall state", () => {
  it("sessions.page passes project id and cursor to the server", async () => {
    const seen: unknown[] = [];
    const client = {
      listProjectSessionsPage: async (
        projectId: string,
        opts: { cursor: string | null; limit: number },
      ) => {
        seen.push([projectId, opts]);
        return { items: [], next_cursor: null };
      },
    } as unknown as ApiClient;
    const state = createSessionsState({
      client,
      repos: {
        sessions: createSessionsRepo(null),
        messageBlocks: createMessageBlocksRepo(null),
      },
      tracked,
    });
    const page = state.page(() => ({ projectId: "p1", cursor: "next" }));
    await flush();
    expect(seen).toEqual([["p1", { cursor: "next", limit: 50 }]]);
    expect(page.loader.data()?.items).toEqual([]);
  });

  it("recall.search forwards the project query and scope", async () => {
    const seen: unknown[] = [];
    const client = {
      recall: async (opts: unknown) => {
        seen.push(opts);
        return {
          query: "SQLite",
          scope: "project",
          projectPath: "/tmp/project",
          result: "No results found for this query.",
        };
      },
    } as unknown as ApiClient;
    const state = createRecallState({ client, tracked });
    const project = PROJECTS[0]!;
    const search = state.search(() => ({
      project,
      q: "SQLite",
      scope: "project",
    }));
    await flush();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(
      expect.objectContaining({ q: "SQLite", scope: "project", project }),
    );
    expect(search.loader.data()?.result).toBe(
      "No results found for this query.",
    );
  });

  it("recall.search remains idle when the query is absent", async () => {
    const recall = vi.fn();
    const state = createRecallState({
      client: { recall } as unknown as ApiClient,
      tracked,
    });
    const search = state.search(() => null);
    await flush();
    expect(recall).not.toHaveBeenCalled();
    expect(search.loader.data()).toBeUndefined();
  });

  it("refetches when slash-containing recall key components change", async () => {
    const recall = vi.fn(async () => ({
      query: "result",
      scope: "project" as const,
      projectPath: "/tmp/project",
      result: "No results found for this query.",
    }));
    const state = createRecallState({
      client: { recall } as unknown as ApiClient,
      tracked,
    });
    const [source, setSource] = createSignal({
      project: { ...PROJECTS[0]!, id: "p" },
      q: "one/two",
      scope: "project" as const,
    });
    createRoot(() => state.search(source));

    await flush();
    expect(recall).toHaveBeenCalledTimes(1);

    setSource({
      project: { ...PROJECTS[0]!, id: "p/one" },
      q: "two",
      scope: "project",
    });
    await flush();
    expect(recall).toHaveBeenCalledTimes(2);
  });

  it("non-default paged queries do not read the knowledge list cache", async () => {
    const read = vi.fn();
    const repo = createKnowledgeRepo(null);
    (repo as unknown as { getScope: typeof read }).getScope = read;
    const client = {
      listProjectKnowledgePage: async () => ({ items: [], next_cursor: null }),
    } as unknown as ApiClient;
    const state = createKnowledgeState({ client, repo, tracked });
    const page = state.page(() => ({
      projectId: "p1",
      query: {
        q: "SQLite",
        category: null,
        scope: null,
        sort: "updated_desc",
        cursor: null,
      },
    }));
    await flush();
    expect(page.loader.data()?.items).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });
});

describe("knowledge versions and source evidence", () => {
  it("loads versions from the server without touching the cache", async () => {
    const read = vi.fn();
    const repo = createKnowledgeRepo(null);
    (repo as unknown as { getScope: typeof read }).getScope = read;
    const client = {
      listKnowledgeVersions: async (id: string) => ({
        id,
        current_version_id: "v1",
        versions: [],
      }),
    } as unknown as ApiClient;
    const state = createKnowledgeState({ client, repo, tracked });
    const versions = state.versions(() => "k1");
    await flush();
    expect(versions.loader.data()?.id).toBe("k1");
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    ["available", { messages: [{ id: "m1" }], distillations: [] }, "available"],
    [
      "summary_only",
      { messages: [], distillations: [{ id: "d1" }] },
      "summary_only",
    ],
    ["unavailable", { messages: [], distillations: [] }, "unavailable"],
  ] as const)(
    "derives %s evidence state from the session response",
    async (_label, detail, expected) => {
      const client = {
        getSession: async () => detail,
      } as unknown as ApiClient;
      const state = createRoot(() =>
        createSessionsState({
          client,
          repos: {
            sessions: createSessionsRepo(null),
            messageBlocks: createMessageBlocksRepo(null),
          },
          projectPathOf: () => undefined,
          tracked,
        }),
      );
      const evidence = state.evidence(() => ({
        projectPath: "/tmp/project",
        sessionId: "s1",
      }));
      await flush();
      expect(evidence.loader.data()?.state).toBe(expected);
    },
  );

  it("turns a missing source session into unavailable evidence", async () => {
    const client = {
      getSession: async () => {
        throw new ApiError("not_found", "/sessions/s1", "gone", 404);
      },
    } as unknown as ApiClient;
    const state = createSessionsState({
      client,
      repos: {
        sessions: createSessionsRepo(null),
        messageBlocks: createMessageBlocksRepo(null),
      },
      projectPathOf: () => undefined,
      tracked,
    });
    const evidence = state.evidence(() => ({
      projectPath: "/tmp/project",
      sessionId: "s1",
    }));
    await flush();
    expect(evidence.loader.data()?.state).toBe("unavailable");
    expect(evidence.loader.error()).toBeUndefined();
  });
});

describe("app state: cache reset", () => {
  it("reports ready again once the database has been reopened", async () => {
    const factory = new IDBFactory();
    await closeLoreDb();
    const client = {
      listProjects: async () => PROJECTS,
    } as unknown as ApiClient;
    const state = createRoot(() =>
      createAppState({ client, db: openLoreDb({ factory }), tracked }),
    );
    expect(await state.ready).not.toBeNull();
    expect(state.cache.status()).toBe("ready");
    await state.cache.reset();
    expect(state.cache.status()).toBe("ready");
    await closeLoreDb();
  });

  it("rebinds repositories to the reopened database after reset", async () => {
    const factory = new IDBFactory();
    await closeLoreDb();
    let online = true;
    const client = {
      listProjects: async () => PROJECTS,
      listProjectKnowledge: async () => {
        if (!online) throw new Error("offline");
        return ENTRIES;
      },
    } as unknown as ApiClient;
    const state = createRoot(() =>
      createAppState({ client, db: openLoreDb({ factory }), tracked }),
    );

    expect(await state.ready).not.toBeNull();
    const first = state.knowledge.list(() => "p1");
    await flush();
    expect(first.loader.data()).toEqual(ENTRIES);

    await state.cache.reset();
    expect(state.cache.status()).toBe("ready");

    const afterReset = state.knowledge.list(() => "p1");
    await flush();
    expect(afterReset.loader.data()).toEqual(ENTRIES);
    const reopened = await openLoreDb({ factory });
    expect(await createKnowledgeRepo(reopened).getScope("p1")).toEqual(ENTRIES);

    online = false;
    const cached = state.knowledge.list(() => "p1");
    await flush();
    expect(cached.loader.data()).toEqual(ENTRIES);
    expect(cached.status().source).toBe("cache");
    await closeLoreDb();
  });
});
