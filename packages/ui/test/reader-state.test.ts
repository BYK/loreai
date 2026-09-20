/**
 * Paged session reader state: newest page first, older pages prepend, the
 * cursor chain restarts with a new first page, and the shared message-block
 * cache is written through (honestly marked partial for a window).
 */
import { describe, expect, it } from "vitest";
import { createRoot, createSignal } from "solid-js";
import { IDBFactory } from "./idb-globals";

import type { ApiClient } from "~/lib/api";
import type { SessionPage, TemporalMessage } from "~/contracts";
import {
  closeLoreDb,
  createMessageBlocksRepo,
  createSessionsRepo,
  openLoreDb,
} from "~/db";
import { createSessionsState } from "~/state/sessions";

const tracked = <T>(read: () => Promise<T>) => read();

async function flush() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

const message = (n: number): TemporalMessage => ({
  id: `lore_tm_v1_${String(n).padStart(4, "0")}`,
  project_id: "p1",
  session_id: "s1",
  role: n % 2 ? "user" : "assistant",
  content: `message ${n}`,
  tokens: 1,
  distilled: 0,
  created_at: 1_700_000_000_000 + n * 1000,
  metadata: "{}",
});

/** A fake server holding `total` messages, paging `limit` at a time. */
function fakeServer(total: number) {
  const all = Array.from({ length: total }, (_, i) => message(i + 1));
  const calls: Array<{ cursor: string | null; limit: number }> = [];
  let block: ((v: void) => void) | null = null;
  const client = {
    getSessionPage: async (
      _path: string,
      _sid: string,
      cursor: string | null,
      limit: number,
      signal?: AbortSignal,
    ): Promise<SessionPage> => {
      calls.push({ cursor, limit });
      if (block) await new Promise<void>((r) => (block = r));
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      // Cursor = the exclusive upper index into `all`.
      const end = cursor === null ? all.length : Number(cursor);
      const start = Math.max(0, end - limit);
      return {
        messages: all.slice(start, end),
        distillations: [],
        next_cursor: start > 0 ? String(start) : null,
        message_count: all.length,
      };
    },
  } as unknown as ApiClient;
  return { client, calls, all };
}

function readerFor(
  client: ApiClient,
  messageBlocks = createMessageBlocksRepo(null),
  pageSize = 3,
) {
  const [sid, setSid] = createSignal<string | null>("s1");
  return createRoot((dispose) => {
    const state = createSessionsState({
      client,
      repos: { sessions: createSessionsRepo(null), messageBlocks },
      projectPathOf: () => "/home/me/lore",
      tracked,
    });
    const reader = state.reader(() => "p1", sid, { pageSize });
    return { reader, setSid, dispose, state };
  });
}

describe("session reader: paging", () => {
  it("loads the newest page and prepends older pages in order", async () => {
    const { client, calls, all } = fakeServer(8);
    const { reader } = readerFor(client);
    await flush();

    expect(calls).toEqual([{ cursor: null, limit: 3 }]);
    expect(reader.messages().map((m) => m.id)).toEqual(
      all.slice(5).map((m) => m.id),
    );
    expect(reader.messageCount()).toBe(8);
    expect(reader.hasOlder()).toBe(true);
    expect(reader.status().partial).toBe(false);

    await reader.loadOlder();
    expect(reader.messages().map((m) => m.id)).toEqual(
      all.slice(2).map((m) => m.id),
    );
    expect(reader.hasOlder()).toBe(true);

    await reader.loadOlder();
    expect(reader.messages().map((m) => m.id)).toEqual(all.map((m) => m.id));
    expect(reader.hasOlder()).toBe(false);
    expect(calls).toHaveLength(3);

    // Nothing left: a further call is a no-op, not a request.
    await reader.loadOlder();
    expect(calls).toHaveLength(3);
  });

  it("does not page before the server has confirmed the first page", async () => {
    const { client, calls } = fakeServer(5);
    const { reader } = readerFor(client);
    expect(reader.hasOlder()).toBeNull();
    await reader.loadOlder();
    expect(calls.filter((c) => c.cursor !== null)).toEqual([]);
    await flush();
    expect(reader.hasOlder()).toBe(true);
  });

  it("restarts the window when the session changes, dropping in-flight older pages", async () => {
    const { client, calls } = fakeServer(9);
    const { reader, setSid } = readerFor(client);
    await flush();
    const first = reader.messages().map((m) => m.id);
    const pending = reader.loadOlder();
    setSid("s2");
    await pending;
    await flush();
    // The newest page of s2 only — no older rows from s1 leaked in.
    expect(reader.messages().map((m) => m.id)).toEqual(first);
    expect(calls.filter((c) => c.cursor === null)).toHaveLength(2);
    expect(reader.loadingOlder()).toBe(false);
    expect(reader.olderError()).toBeUndefined();
  });

  it("surfaces an older-page failure without losing the loaded window", async () => {
    const { client, all } = fakeServer(6);
    const failing = {
      getSessionPage: async (
        path: string,
        sid: string,
        cursor: string | null,
        limit: number,
        signal?: AbortSignal,
      ) => {
        if (cursor !== null) throw new Error("boom");
        return client.getSessionPage(path, sid, cursor, limit, signal);
      },
    } as unknown as ApiClient;
    const { reader } = readerFor(failing);
    await flush();
    await reader.loadOlder();
    expect(reader.olderError()).toBeInstanceOf(Error);
    expect(reader.messages().map((m) => m.id)).toEqual(
      all.slice(3).map((m) => m.id),
    );
    expect(reader.hasOlder()).toBe(true);
    expect(reader.loadingOlder()).toBe(false);
  });
});

describe("session reader: shared cache", () => {
  it("writes the loaded window through as a partial collection and serves it back stale", async () => {
    const factory = new IDBFactory();
    await closeLoreDb();
    const db = (await openLoreDb({ factory }))!;
    const repo = createMessageBlocksRepo(db);
    const { client, all } = fakeServer(7);

    const { reader, dispose } = readerFor(client, repo);
    await flush();
    await reader.loadOlder();
    await flush();
    const collection = await repo.collection("p1/s1");
    expect(collection).toMatchObject({
      complete: false,
      count: 7,
      nextCursor: "1",
    });
    dispose();

    // A second visit with the gateway hanging serves the cached window,
    // marked partial+stale, and refuses to page from a cached cursor.
    const hanging = {
      getSessionPage: () => new Promise<never>(() => {}),
    } as unknown as ApiClient;
    const second = readerFor(hanging, repo);
    await flush();
    expect(second.reader.messages().map((m) => m.id)).toEqual(
      all.slice(1).map((m) => m.id),
    );
    expect(second.reader.status().stale).toBe(true);
    expect(second.reader.status().partial).toBe(true);
    expect(second.reader.messageCount()).toBe(7);
    expect(second.reader.hasOlder()).toBeNull();
    await second.reader.loadOlder();
    expect(second.reader.loadingOlder()).toBe(false);

    // The legacy detail store reads the same blocks and reports them partial.
    const detail = second.state.detail(
      () => "p1",
      () => "s1",
    );
    await flush();
    expect(detail.loader.data()?.messages.length).toBe(6);
    expect(detail.status().partial).toBe(true);
    second.dispose();
    await closeLoreDb();
  });

  it("marks the collection complete once the first message is loaded", async () => {
    const factory = new IDBFactory();
    await closeLoreDb();
    const db = (await openLoreDb({ factory }))!;
    const repo = createMessageBlocksRepo(db);
    const { client } = fakeServer(4);
    const { reader, dispose } = readerFor(client, repo);
    await flush();
    await reader.loadOlder();
    await flush();
    expect(await repo.collection("p1/s1")).toMatchObject({
      complete: true,
      count: 4,
      nextCursor: null,
    });
    dispose();
    await closeLoreDb();
  });
});
