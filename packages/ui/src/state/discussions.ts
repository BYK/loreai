/**
 * Discussion state (APP-02): the gateway's SQLite store is the authority;
 * this module only caches what was fetched in memory so the inline reader
 * indicators, the focused view and the project list agree after a write.
 * Unsent text lives in the IndexedDB `drafts` store and is only ever sent by
 * an explicit submit.
 */
import { createStore, produce } from "solid-js/store";

import type {
  Discussion,
  DiscussionAnchor,
  DiscussionReply,
  DiscussionSourceKind,
} from "~/contracts";
import { createDraftsStore, type DiscussionDraft, type LoreUiDb } from "~/db";
import { encodeAnchor, type SourceAnchor } from "~/reader/anchors";
import type { ApiClient } from "~/lib/api";
import { isApiError } from "~/lib/api";

export interface DiscussionSource {
  kind: DiscussionSourceKind;
  id: string;
}

interface ListState {
  ids: string[];
  loaded: boolean;
  loading: boolean;
  error: unknown;
  next: string | null;
}

const EMPTY_LIST: ListState = {
  ids: [],
  loaded: false,
  loading: false,
  error: undefined,
  next: null,
};

/** Bounded so a pathological source cannot page forever. */
const SOURCE_PAGES = 10;
const SOURCE_PAGE_SIZE = 200;
const PROJECT_PAGE_SIZE = 50;

export function sourceKey(projectId: string, source: DiscussionSource) {
  return `${projectId}\u0000${source.kind}\u0000${source.id}`;
}

export function replyDraftKey(discussionId: string): string {
  return `discussion-reply:${discussionId}`;
}

export function newDiscussionDraftKey(
  projectId: string,
  source: DiscussionSource,
  anchor: SourceAnchor,
): string {
  return `discussion-new:${projectId}:${source.kind}:${source.id}:${encodeAnchor(anchor)}`;
}

/** True for the 409 the API returns on a stale `expected_revision`. */
export function isRevisionConflict(error: unknown): boolean {
  return isApiError(error) && error.status === 409;
}

export function createDiscussionsState(deps: {
  client: ApiClient;
  tracked: <T>(read: () => Promise<T>) => Promise<T>;
  db: () => Promise<LoreUiDb | null>;
}) {
  const { client, tracked } = deps;
  const [store, setStore] = createStore<{
    byId: Record<string, Discussion>;
    replies: Record<string, DiscussionReply[]>;
    sources: Record<string, ListState>;
    projects: Record<string, ListState>;
  }>({ byId: {}, replies: {}, sources: {}, projects: {} });

  function upsert(d: Discussion) {
    setStore("byId", d.id, d);
  }

  function listOf(state: ListState | undefined): Discussion[] {
    return (state?.ids ?? [])
      .map((id) => store.byId[id])
      .filter((d): d is Discussion => d !== undefined);
  }

  /** Latest load per source key: an older, slower load never overwrites it. */
  const sourceLoads = new Map<string, number>();

  async function loadSource(projectId: string, source: DiscussionSource) {
    const key = sourceKey(projectId, source);
    const token = (sourceLoads.get(key) ?? 0) + 1;
    sourceLoads.set(key, token);
    const current = () => sourceLoads.get(key) === token;
    setStore("sources", key, (s) => ({
      ...(s ?? EMPTY_LIST),
      loading: true,
      error: undefined,
    }));
    try {
      const ids: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < SOURCE_PAGES; page++) {
        const result = await tracked(() =>
          client.listDiscussions(projectId, {
            source,
            cursor,
            limit: SOURCE_PAGE_SIZE,
          }),
        );
        for (const d of result.discussions) {
          upsert(d);
          ids.push(d.id);
        }
        cursor = result.next_cursor;
        if (!cursor) break;
      }
      if (!current()) return;
      setStore("sources", key, {
        ids,
        loaded: true,
        loading: false,
        error: undefined,
        next: cursor,
      });
    } catch (error) {
      if (!current()) return;
      setStore("sources", key, (s) => ({
        ...(s ?? EMPTY_LIST),
        loading: false,
        error,
      }));
    }
  }

  async function loadProject(projectId: string, more = false) {
    const current = store.projects[projectId] ?? EMPTY_LIST;
    if (current.loading) return;
    if (more && !current.next) return;
    setStore("projects", projectId, {
      ...current,
      loading: true,
      error: undefined,
    });
    try {
      const result = await tracked(() =>
        client.listDiscussions(projectId, {
          cursor: more ? current.next : null,
          limit: PROJECT_PAGE_SIZE,
        }),
      );
      for (const d of result.discussions) upsert(d);
      const fresh = result.discussions.map((d) => d.id);
      setStore("projects", projectId, {
        ids: more ? [...current.ids, ...fresh] : fresh,
        loaded: true,
        loading: false,
        error: undefined,
        next: result.next_cursor,
      });
    } catch (error) {
      setStore("projects", projectId, (s) => ({
        ...(s ?? EMPTY_LIST),
        loading: false,
        error,
      }));
    }
  }

  async function loadDiscussion(projectId: string, id: string) {
    const { discussion } = await tracked(() =>
      client.getDiscussion(projectId, id),
    );
    upsert(discussion);
    return discussion;
  }

  async function loadReplies(projectId: string, id: string) {
    const all: DiscussionReply[] = [];
    let after: number | null = null;
    for (let page = 0; page < SOURCE_PAGES; page++) {
      const result = await tracked(() =>
        client.listDiscussionReplies(projectId, id, { after }),
      );
      all.push(...result.replies);
      after = result.next_after;
      if (after === null) break;
    }
    setStore("replies", id, all);
    return all;
  }

  function track(id: string, sourceList: string, projectId: string) {
    setStore(
      produce((s) => {
        const src = s.sources[sourceList];
        if (src && !src.ids.includes(id)) src.ids.push(id);
        const proj = s.projects[projectId];
        if (proj && !proj.ids.includes(id)) proj.ids.unshift(id);
      }),
    );
  }

  async function create(input: {
    projectId: string;
    kind: "discussion" | "note";
    source: DiscussionSource;
    anchors: DiscussionAnchor[];
    quote: string;
    body?: string;
  }): Promise<Discussion> {
    const { discussion, reply } = await tracked(() =>
      client.createDiscussion(input),
    );
    upsert(discussion);
    setStore("replies", discussion.id, reply ? [reply] : []);
    track(
      discussion.id,
      sourceKey(input.projectId, input.source),
      input.projectId,
    );
    return discussion;
  }

  /**
   * Post a reply against the revision this client last saw. On a 409 the
   * discussion and its replies are reloaded and the error rethrown: the
   * caller keeps the draft so the user can look and submit again.
   */
  async function reply(projectId: string, d: Discussion, body: string) {
    try {
      const result = await tracked(() =>
        client.addDiscussionReply(projectId, d.id, {
          expected_revision: d.revision,
          body,
        }),
      );
      upsert(result.discussion);
      setStore("replies", d.id, (rs) => [...(rs ?? []), result.reply]);
      return result.reply;
    } catch (error) {
      if (isRevisionConflict(error)) {
        await Promise.all([
          loadDiscussion(projectId, d.id),
          loadReplies(projectId, d.id),
        ]).catch(() => undefined);
      }
      throw error;
    }
  }

  async function setState(
    projectId: string,
    d: Discussion,
    state: "open" | "resolved",
  ) {
    try {
      const { discussion } = await tracked(() =>
        client.updateDiscussion(projectId, d.id, {
          expected_revision: d.revision,
          state,
        }),
      );
      upsert(discussion);
      return discussion;
    } catch (error) {
      if (isRevisionConflict(error)) {
        await loadDiscussion(projectId, d.id).catch(() => undefined);
      }
      throw error;
    }
  }

  const drafts = {
    async get(key: string): Promise<DiscussionDraft | undefined> {
      const row = await createDraftsStore(await deps.db()).get(key);
      return row?.kind === "discussion" ? row : undefined;
    },
    async put(draft: Omit<DiscussionDraft, "kind" | "updatedAt">) {
      await createDraftsStore(await deps.db()).put({
        ...draft,
        kind: "discussion",
        updatedAt: Date.now(),
      });
    },
    async delete(key: string) {
      await createDraftsStore(await deps.db()).delete(key);
    },
  };

  return {
    byId: (id: string): Discussion | undefined => store.byId[id],
    replies: (id: string): DiscussionReply[] | undefined => store.replies[id],
    forSource: (projectId: string, source: DiscussionSource) =>
      listOf(store.sources[sourceKey(projectId, source)]),
    sourceState: (projectId: string, source: DiscussionSource) =>
      store.sources[sourceKey(projectId, source)] ?? EMPTY_LIST,
    forProject: (projectId: string) => listOf(store.projects[projectId]),
    projectState: (projectId: string) =>
      store.projects[projectId] ?? EMPTY_LIST,
    loadSource,
    loadProject,
    loadDiscussion,
    loadReplies,
    create,
    reply,
    setState,
    drafts,
  };
}

export type DiscussionsState = ReturnType<typeof createDiscussionsState>;
