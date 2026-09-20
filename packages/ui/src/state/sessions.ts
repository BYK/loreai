import type { Accessor } from "solid-js";
import {
  batch,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  untrack,
} from "solid-js";

import type {
  SessionDetail,
  SessionPage,
  SessionSummary,
  TemporalMessage,
} from "~/contracts";
import type { ApiClient } from "~/lib/api";
import { isApiError } from "~/lib/api";
import { MESSAGE_BLOCK_SIZE, type MessageBlock, type Repository } from "~/db";
import { createLoader, type CachedResult, type Loader } from "~/lib/loader";

import { createEntityStore } from "./entity-store";
import { statusOf, type KeyStatus } from "./status";
import type { CursorPage } from "~/contracts";

export interface SessionsDeps {
  client: ApiClient;
  repos: {
    sessions: Repository<SessionSummary>;
    messageBlocks: Repository<MessageBlock>;
  };
  /**
   * `GET /sessions/:id` resolves its project via `?path=` only, so the state
   * needs a way to turn a project id into a path (the projects repo/state).
   */
  projectPathOf?: (projectId: string) => string | undefined;
  tracked: <T>(read: () => Promise<T>) => Promise<T>;
}

export type EvidenceState = "available" | "summary_only" | "unavailable";

export interface EvidenceResult {
  state: EvidenceState;
  detail?: SessionDetail;
}

/** Default page size of the paged reader (`GET /sessions/:id?page=cursor`). */
export const READER_PAGE_SIZE = 100;

/** Paged session reader: the loaded window of one session's history. */
export interface SessionReader {
  /** Newest page (or the cached projection). Errors/loading of the first load. */
  loader: Loader<SessionPage>;
  status: Accessor<KeyStatus>;
  /** Every loaded message, chronological: older pages followed by the newest. */
  messages: Accessor<TemporalMessage[]>;
  distillations: Accessor<SessionPage["distillations"]>;
  /** Messages in the session at the server's last answer; null until known. */
  messageCount: Accessor<number | null>;
  /**
   * Whether older history exists beyond the loaded window. `null` while the
   * first page has not been confirmed by the server (nothing to page from).
   */
  hasOlder: Accessor<boolean | null>;
  loadingOlder: Accessor<boolean>;
  olderError: Accessor<unknown>;
  /** Fetch the next older page and prepend it. No-op when none is known. */
  loadOlder: () => Promise<void>;
}
export function createSessionsState({
  client,
  repos,
  projectPathOf,
  tracked,
}: SessionsDeps) {
  const store = createEntityStore<SessionSummary>((s) => s.session_id);

  function sessionKeyOf(projectId: string, sessionId: string) {
    return `${encodeURIComponent(projectId)}/${sessionId}`;
  }

  function splitKey(key: string): { pid: string; sid: string; path: string } {
    const sep = key.indexOf("/");
    const pid = decodeURIComponent(key.slice(0, sep));
    const sid = key.slice(sep + 1);
    const path = projectPathOf?.(pid);
    if (path === undefined) throw new Error(`No path for project ${pid}`);
    return { pid, sid, path };
  }

  // The source stays null until the project path is known: resolving it
  // inside the fetcher would fire once with `undefined` and surface a
  // permanent error on deep links before projects load.
  function sessionSource(
    projectId: Accessor<string | null>,
    sessionId: Accessor<string | null>,
  ): Accessor<string | null> {
    return () => {
      const pid = projectId();
      const sid = sessionId();
      const path = pid ? projectPathOf?.(pid) : undefined;
      return pid && sid && path !== undefined ? sessionKeyOf(pid, sid) : null;
    };
  }

  /**
   * Cached projection of a session's messages. Distillations are not cached;
   * the server fills them in. `partial` when blocks were lost to TTL/LRU
   * eviction or the cached window is a tail of the session (paged reader).
   */
  async function readCachedMessages(key: string): Promise<
    | CachedResult<{
        messages: TemporalMessage[];
        nextCursor: string | null;
        count: number;
      }>
    | undefined
  > {
    const [blocks, collection] = await Promise.all([
      repos.messageBlocks.getScope(key),
      repos.messageBlocks.collection(key),
    ]);
    if (blocks.length === 0) {
      // An intentionally empty session: the collections row proves the
      // server answered with zero messages, so this is a cache hit.
      if (collection?.complete && collection.count === 0) {
        return {
          value: { messages: [], nextCursor: null, count: 0 },
          partial: false,
        };
      }
      return undefined;
    }
    const messages = blocks
      .sort((a, b) => a.index - b.index)
      .flatMap((b) => b.messages);
    return {
      value: {
        messages,
        nextCursor: collection?.nextCursor ?? null,
        count: collection?.count ?? messages.length,
      },
      // Legacy writes with no collections row are partial too.
      partial:
        !collection ||
        !collection.complete ||
        collection.count !== messages.length,
    };
  }

  /**
   * Write-through of a loaded window. `count` is the session's message total
   * (equal to `messages.length` only when the window is the whole history).
   */
  async function writeCachedMessages(
    key: string,
    messages: TemporalMessage[],
    page: { nextCursor: string | null; count: number },
  ): Promise<void> {
    const blocks: MessageBlock[] = [];
    for (let i = 0; i < messages.length; i += MESSAGE_BLOCK_SIZE) {
      blocks.push({
        sessionKey: key,
        index: i / MESSAGE_BLOCK_SIZE,
        messages: messages.slice(i, i + MESSAGE_BLOCK_SIZE),
      });
    }
    await repos.messageBlocks.putMany(blocks, key, { replaceScope: true });
    await repos.messageBlocks.setCollection(key, {
      complete: page.nextCursor === null && page.count === messages.length,
      count: page.count,
      nextCursor: page.nextCursor,
      fetchedAt: Date.now(),
    });
  }

  function list(projectId: Accessor<string | null>): {
    loader: Loader<SessionSummary[]>;
    status: Accessor<KeyStatus>;
  } {
    const loader = createLoader(
      projectId,
      (id, signal) => tracked(() => client.listProjectSessions(id, signal)),
      {
        async cached(id) {
          const [rows, collection] = await Promise.all([
            repos.sessions.getScope(id),
            repos.sessions.collection(id),
          ]);
          if (!collection) return undefined;
          for (const s of rows) store.reconcileOne(s);
          // Server order: last_message_at DESC.
          return {
            value: [...rows].sort(
              (a, b) => b.last_message_at - a.last_message_at,
            ),
            // Rows lost to TTL/LRU eviction → render them, marked partial.
            partial: rows.length !== collection.count,
          };
        },
        async onServer(id, values) {
          for (const s of values) store.reconcileOne(s);
          store.reconcileList(id, values, { complete: true });
          await repos.sessions.putMany(values, id, { replaceScope: true });
          await repos.sessions.setCollection(id, {
            complete: true,
            count: values.length,
            nextCursor: null,
            fetchedAt: Date.now(),
          });
        },
      },
    );
    return { loader, status: statusOf(loader) };
  }

  function detail(
    projectId: Accessor<string | null>,
    sessionId: Accessor<string | null>,
  ): { loader: Loader<SessionDetail>; status: Accessor<KeyStatus> } {
    const loader = createLoader(
      sessionSource(projectId, sessionId),
      async (key, signal) => {
        const { sid, path } = splitKey(key);
        return tracked(() => client.getSession(path, sid, signal));
      },
      {
        async cached(key) {
          const hit = await readCachedMessages(key);
          if (!hit) return undefined;
          return {
            value: {
              messages: hit.value.messages,
              distillations: [],
            } satisfies SessionDetail,
            partial: hit.partial,
          };
        },
        onServer: (key, value) =>
          writeCachedMessages(key, value.messages, {
            nextCursor: null,
            count: value.messages.length,
          }),
      },
    );
    return { loader, status: statusOf(loader) };
  }

  function page(
    source: Accessor<{
      projectId: string;
      cursor: string | null;
    } | null>,
  ): {
    loader: Loader<CursorPage<SessionSummary>>;
    status: Accessor<KeyStatus>;
  } {
    const loader = createLoader(
      () => {
        const value = source();
        return value
          ? `${encodeURIComponent(value.projectId)}/${encodeURIComponent(value.cursor ?? "")}`
          : null;
      },
      (_, signal) => {
        const value = source();
        if (!value) throw new Error("Session query changed");
        return tracked(async () => {
          return client.listProjectSessionsPage(
            value.projectId,
            { cursor: value.cursor, limit: 50 },
            signal,
          );
        });
      },
      {
        async onServer(key, value) {
          const projectId = decodeURIComponent(key.slice(0, key.indexOf("/")));
          for (const session of value.items) {
            store.reconcileOne(session);
            await repos.sessions.put(session, projectId, {
              keepScope: true,
            });
          }
        },
      },
    );
    return { loader, status: statusOf(loader) };
  }

  function evidence(
    source: Accessor<{
      projectPath: string;
      sessionId: string;
    } | null>,
  ): {
    loader: Loader<EvidenceResult>;
    status: Accessor<KeyStatus>;
  } {
    const keyed = createMemo(() => {
      const value = source();
      return value ? `${value.projectPath}\u0000${value.sessionId}` : null;
    });
    const loader = createLoader(keyed, async (key, signal) => {
      const separator = key.indexOf("\u0000");
      const projectPath = key.slice(0, separator);
      const sessionId = key.slice(separator + 1);
      let session: SessionDetail;
      try {
        session = await tracked(() =>
          client.getSession(projectPath, sessionId, signal),
        );
      } catch (error) {
        if (isApiError(error) && error.kind === "not_found")
          return { state: "unavailable" as const };
        throw error;
      }
      if (session.messages.length > 0)
        return { state: "available" as const, detail: session };
      if (session.distillations.length > 0)
        return { state: "summary_only" as const, detail: session };
      return { state: "unavailable" as const, detail: session };
    });
    return { loader, status: statusOf(loader) };
  }

  /**
   * The paged reader shares the detail cache: it starts from the newest
   * `pageSize` messages (or whatever the cache holds) and `loadOlder()`
   * prepends server pages. Each page is written through, so a later visit
   * — by this reader or by `detail()` — sees the loaded window, honestly
   * marked partial until the first message is reached.
   */
  function reader(
    projectId: Accessor<string | null>,
    sessionId: Accessor<string | null>,
    options: { pageSize?: number } = {},
  ): SessionReader {
    const pageSize = options.pageSize ?? READER_PAGE_SIZE;
    const source = sessionSource(projectId, sessionId);
    const [older, setOlder] = createSignal<TemporalMessage[]>([]);
    const [olderCursor, setOlderCursor] = createSignal<string | null>(null);
    const [messageCount, setMessageCount] = createSignal<number | null>(null);
    const [loadingOlder, setLoadingOlder] = createSignal(false);
    const [olderError, setOlderError] = createSignal<unknown>(undefined);
    let olderController: AbortController | null = null;

    const loader = createLoader<string, SessionPage>(
      source,
      async (key, signal) => {
        const { sid, path } = splitKey(key);
        return tracked(() =>
          client.getSessionPage(path, sid, null, pageSize, signal),
        );
      },
      {
        async cached(key) {
          const hit = await readCachedMessages(key);
          if (!hit) return undefined;
          return {
            value: {
              messages: hit.value.messages,
              distillations: [],
              next_cursor: hit.value.nextCursor,
              message_count: hit.value.count,
            } satisfies SessionPage,
            partial: hit.partial,
          };
        },
        onServer: (key, page) =>
          writeCachedMessages(key, page.messages, {
            nextCursor: page.next_cursor,
            count: page.message_count,
          }),
      },
    );

    const cancelOlder = () => {
      olderController?.abort();
      olderController = null;
      setLoadingOlder(false);
    };

    // A new first page (new session, cache → server, reload) restarts the
    // window: older pages belonged to the previous answer's cursor chain.
    createEffect(
      on(loader.data, (page) => {
        cancelOlder();
        setOlder([]);
        setOlderError(undefined);
        setOlderCursor(page?.next_cursor ?? null);
        setMessageCount(page ? page.message_count : null);
      }),
    );
    onCleanup(cancelOlder);

    const messages = createMemo<TemporalMessage[]>(() => {
      const newest = loader.data()?.messages;
      return newest ? [...older(), ...newest] : [];
    });

    async function loadOlder(): Promise<void> {
      const cursor = untrack(olderCursor);
      const key = untrack(source);
      // Nothing to page from while the newest page is unconfirmed: a cached
      // cursor may not match what the server answers.
      if (
        !cursor ||
        !key ||
        untrack(loadingOlder) ||
        untrack(loader.stale) ||
        untrack(loader.source) !== "server"
      ) {
        return;
      }
      const c = new AbortController();
      olderController = c;
      setLoadingOlder(true);
      setOlderError(undefined);
      try {
        const { sid, path } = splitKey(key);
        const page = await tracked(() =>
          client.getSessionPage(path, sid, cursor, pageSize, c.signal),
        );
        if (c.signal.aborted || untrack(source) !== key) return;
        batch(() => {
          setOlder((prev) => [...page.messages, ...prev]);
          setOlderCursor(page.next_cursor);
          setMessageCount(page.message_count);
        });
        try {
          await writeCachedMessages(key, untrack(messages), {
            nextCursor: page.next_cursor,
            count: page.message_count,
          });
        } catch (reason) {
          console.warn("cache write failed", reason);
        }
      } catch (reason) {
        if (c.signal.aborted) return;
        setOlderError(() => reason);
      } finally {
        if (olderController === c) {
          olderController = null;
          setLoadingOlder(false);
        }
      }
    }

    return {
      loader,
      status: statusOf(loader),
      messages,
      distillations: () => loader.data()?.distillations ?? [],
      messageCount,
      hasOlder: () =>
        loader.source() === "server" && !loader.stale()
          ? olderCursor() !== null
          : null,
      loadingOlder,
      olderError,
      loadOlder,
    };
  }

  return { list, detail, page, evidence, reader, store };
}
