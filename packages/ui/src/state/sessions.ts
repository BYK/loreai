import type { Accessor } from "solid-js";

import type { SessionDetail, SessionSummary } from "~/contracts";
import type { ApiClient } from "~/lib/api";
import { MESSAGE_BLOCK_SIZE, type MessageBlock, type Repository } from "~/db";
import { createLoader, type Loader } from "~/lib/loader";

import { createEntityStore } from "./entity-store";
import { statusOf, type KeyStatus } from "./status";

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

export function createSessionsState({
  client,
  repos,
  projectPathOf,
  tracked,
}: SessionsDeps) {
  const store = createEntityStore<SessionSummary>((s) => s.session_id);

  function sessionKeyOf(projectId: string, sessionId: string) {
    return `${projectId}/${sessionId}`;
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
          if (rows.length === 0 && !collection) return undefined;
          for (const s of rows) store.reconcileOne(s);
          // Server order: last_message_at DESC.
          return [...rows].sort(
            (a, b) => b.last_message_at - a.last_message_at,
          );
        },
        async onServer(id, values) {
          for (const s of values) store.reconcileOne(s);
          store.reconcileList(id, values, { complete: true });
          await repos.sessions.putMany(values, id, { replaceScope: true });
          await repos.sessions.setCollection(id, {
            complete: true,
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
    const source: Accessor<string | null> = () => {
      const pid = projectId();
      const sid = sessionId();
      return pid && sid ? sessionKeyOf(pid, sid) : null;
    };
    const loader = createLoader(
      source,
      async (key, signal) => {
        const [pid, sid] = key.split("/", 2) as [string, string];
        const path = projectPathOf?.(pid);
        if (path === undefined) throw new Error(`No path for project ${pid}`);
        return tracked(() => client.getSession(path, sid, signal));
      },
      {
        async cached(key) {
          const blocks = await repos.messageBlocks.getScope(key);
          if (blocks.length === 0) return undefined;
          return {
            messages: blocks
              .sort((a, b) => a.index - b.index)
              .flatMap((b) => b.messages),
            // Distillations are not cached; the server fills them in. The
            // cached projection returns what it knows.
            distillations: [],
          } satisfies SessionDetail;
        },
        async onServer(key, value) {
          const blocks: MessageBlock[] = [];
          for (let i = 0; i < value.messages.length; i += MESSAGE_BLOCK_SIZE) {
            blocks.push({
              sessionKey: key,
              index: i / MESSAGE_BLOCK_SIZE,
              messages: value.messages.slice(i, i + MESSAGE_BLOCK_SIZE),
            });
          }
          await repos.messageBlocks.putMany(blocks, key, {
            replaceScope: true,
          });
        },
      },
    );
    return { loader, status: statusOf(loader) };
  }

  return { list, detail, store };
}
