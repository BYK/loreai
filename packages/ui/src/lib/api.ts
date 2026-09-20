/**
 * Minimal typed fetch client for the gateway management API.
 *
 * Every response is validated at runtime (ArkType contracts in
 * `~/contracts`) before it reaches a view, and every failure is classified
 * into one of a few `ApiErrorKind`s so the shell can show the right
 * connection state:
 *
 *   - `unreachable`  network failure / gateway down / non-JSON body
 *   - `unauthorized` 401 / 403, or the bodyless 404 the gateway uses to hide
 *                    management routes from non-loopback peers
 *   - `not_found`    a JSON 404 (`{ type: "error", error: {...} }`)
 *   - `invalid`      2xx whose body failed validation (`ContractError`)
 *   - `http`         any other non-2xx
 */
import { type Type } from "arktype";

import {
  accountStatus,
  ApiError,
  apiErrorBody,
  cursorPage,
  distillationDetail,
  distillationList,
  knowledgeEntry,
  knowledgeList,
  knowledgeVersionHistory,
  parseContract,
  projectList,
  recallResponse,
  safeParseContract,
  sessionDetail,
  sessionList,
  sessionSummary,
  sessionPage,
  sessionSearchPage,
  sharingStatus,
  syncStatus,
  teamList,
  type AccountStatus,
  type CursorPage,
  type DistillationDetail,
  type DistillationSummary,
  type KnowledgeEntry,
  type KnowledgeVersionHistory,
  type ProjectSummary,
  type RecallResponse,
  type RecallScope,
  type KnowledgeCategory,
  type KnowledgeScope,
  type KnowledgeSort,
  type SessionDetail,
  type SessionPage,
  type SessionSearchPage,
  type SessionSummary,
  type SharingStatus,
  type SyncStatus,
  type TeamList,
} from "~/contracts";

export {
  ApiError,
  ContractError,
  isApiError,
  isContractError,
  type ApiErrorKind,
  type ContractIssue,
} from "~/contracts";

export const API_BASE = "/api/v1";

export function query(
  params: Record<string, string | number | boolean | null | undefined>,
): string {
  const values = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined) {
      values.set(key, String(value));
    }
  }
  const encoded = values.toString();
  return encoded ? `?${encoded}` : "";
}

/** True for any abort rejection (`DOMException`, `Error`, or a custom `abort(reason)`). */
export function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  );
}

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export interface ApiClientOptions {
  /** Injected for tests; defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** Path prefix, defaults to `/api/v1` (same-origin; the Vite dev server proxies it). */
  base?: string;
}

async function readErrorMessage(res: Response): Promise<string | null> {
  const text = await res.text().catch(() => "");
  if (!text) return null;
  try {
    const parsed = safeParseContract("<error>", apiErrorBody, JSON.parse(text));
    return parsed.ok ? parsed.value.error.message : text.slice(0, 200);
  } catch {
    return text.slice(0, 200);
  }
}

export function createApiClient(options: ApiClientOptions = {}) {
  const base = options.base ?? API_BASE;
  const doFetch: FetchLike =
    options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  async function getJson<T>(
    path: string,
    schema: Type<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method: "GET",
        headers: { accept: "application/json" },
        credentials: "same-origin",
        signal,
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new ApiError("unreachable", path, "Gateway unreachable");
    }

    if (res.status === 401 || res.status === 403) {
      throw new ApiError(
        "unauthorized",
        path,
        "Gateway refused this browser",
        res.status,
      );
    }

    if (res.status === 502 || res.status === 503 || res.status === 504) {
      const message = await readErrorMessage(res);
      throw new ApiError(
        "unreachable",
        path,
        message ?? `Gateway responded ${res.status}`,
        res.status,
      );
    }

    if (!res.ok) {
      const message = await readErrorMessage(res);
      if (res.status === 404) {
        // A bodyless 404 is the management-boundary denial; a JSON 404 is a
        // real "no such record".
        if (message === null) {
          throw new ApiError(
            "unauthorized",
            path,
            "Gateway hid this route from the current peer",
            404,
          );
        }
        throw new ApiError("not_found", path, message, 404);
      }
      throw new ApiError(
        "http",
        path,
        message ?? `Gateway responded ${res.status}`,
        res.status,
      );
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new ApiError(
        "unreachable",
        path,
        "Gateway returned a non-JSON response",
        res.status,
      );
    }
    // `path` is the route without the query string — it is what lands in
    // ContractError.route/path.
    return parseContract(path, schema, body);
  }

  return {
    listProjects(signal?: AbortSignal): Promise<ProjectSummary[]> {
      return getJson("/projects", projectList, signal);
    },
    listProjectKnowledge(
      projectId: string,
      signal?: AbortSignal,
    ): Promise<KnowledgeEntry[]> {
      return getJson(
        `/projects/${encodeURIComponent(projectId)}/knowledge`,
        knowledgeList,
        signal,
      );
    },
    /**
     * Cursor-mode variant of `listProjectKnowledge` (`?page=cursor` /
     * `?cursor=`). Pass `cursor === null` for the first page.
     */
    listProjectKnowledgePage(
      projectId: string,
      opts: {
        cursor?: string | null;
        limit?: number;
        q?: string;
        category?: KnowledgeCategory;
        scope?: KnowledgeScope;
        sort?: KnowledgeSort;
      } = {},
      signal?: AbortSignal,
    ): Promise<CursorPage<KnowledgeEntry>> {
      return getJson(
        `/projects/${encodeURIComponent(projectId)}/knowledge${query({
          page: "cursor",
          cursor: opts.cursor,
          limit: opts.limit,
          q: opts.q,
          category: opts.category,
          scope: opts.scope,
          sort: opts.sort,
        })}`,
        cursorPage(knowledgeEntry),
        signal,
      );
    },
    getKnowledge(id: string, signal?: AbortSignal): Promise<KnowledgeEntry> {
      return getJson(
        `/knowledge/${encodeURIComponent(id)}`,
        knowledgeEntry,
        signal,
      );
    },
    listKnowledgeVersions(
      id: string,
      opts: { includeDeleted?: boolean; signal?: AbortSignal } = {},
    ): Promise<KnowledgeVersionHistory> {
      return getJson(
        `/knowledge/${encodeURIComponent(id)}/versions${query({
          include_deleted: opts.includeDeleted || null,
        })}`,
        knowledgeVersionHistory,
        opts.signal,
      );
    },
    listProjectSessions(
      projectId: string,
      signal?: AbortSignal,
    ): Promise<SessionSummary[]> {
      return getJson(
        `/projects/${encodeURIComponent(projectId)}/sessions`,
        sessionList,
        signal,
      );
    },
    listProjectSessionsPage(
      projectId: string,
      opts: { cursor?: string | null; limit?: number } = {},
      signal?: AbortSignal,
    ): Promise<CursorPage<SessionSummary>> {
      return getJson(
        `/projects/${encodeURIComponent(projectId)}/sessions${query({
          page: "cursor",
          cursor: opts.cursor,
          limit: opts.limit,
        })}`,
        cursorPage(sessionSummary),
        signal,
      );
    },
    recall(
      opts: {
        q: string;
        project: { git_remote: string | null; path: string };
        scope: RecallScope;
        limit?: number;
        session?: string;
      },
      signal?: AbortSignal,
    ): Promise<RecallResponse> {
      return getJson(
        `/recall${query({
          q: opts.q,
          scope: opts.scope,
          expand: false,
          limit: Math.max(1, Math.min(50, opts.limit ?? 20)),
          git_remote: opts.project.git_remote,
          path: opts.project.git_remote ? null : opts.project.path,
          session: opts.session,
        })}`,
        recallResponse,
        signal,
      );
    },
    /**
     * `GET /sessions/:id` resolves its project from `?git_remote`/`?path`
     * only (no project-id query key — see `resolveProject` in the gateway),
     * so the caller passes the project path.
     */
    getSession(
      projectPath: string,
      sessionId: string,
      signal?: AbortSignal,
    ): Promise<SessionDetail> {
      return getJson(
        `/sessions/${encodeURIComponent(sessionId)}${query({ path: projectPath })}`,
        sessionDetail,
        signal,
      );
    },
    /**
     * Opt-in paged variant of `getSession` (`?page=cursor&limit=` /
     * `?cursor=`). `cursor === null` fetches the newest `limit` messages;
     * each `next_cursor` fetches the page *older* than the previous one.
     */
    getSessionPage(
      projectPath: string,
      sessionId: string,
      cursor: string | null,
      limit: number,
      signal?: AbortSignal,
    ): Promise<SessionPage> {
      return getJson(
        `/sessions/${encodeURIComponent(sessionId)}${query({
          path: projectPath,
          page: cursor ? null : "cursor",
          limit: cursor ? null : limit,
          cursor,
        })}`,
        sessionPage,
        signal,
      );
    },

    /**
     * `GET /sessions/:id/search?q=` — ids of the messages whose stored text
     * matches `q`, newest first across pages (`cursor === null` is the first
     * page; each `next_cursor` fetches older hits). The server only knows
     * message ids and raw text; the reader maps a hit onto rendered blocks
     * and computes displayed-text offsets itself.
     */
    searchSession(
      projectPath: string,
      sessionId: string,
      q: string,
      cursor: string | null,
      limit: number,
      signal?: AbortSignal,
    ): Promise<SessionSearchPage> {
      const params = new URLSearchParams({
        path: projectPath,
        q,
        limit: String(limit),
      });
      if (cursor !== null) params.set("cursor", cursor);
      return getJson(
        `/sessions/${encodeURIComponent(sessionId)}/search?${params.toString()}`,
        sessionSearchPage,
        signal,
      );
    },
    listProjectDistillations(
      projectId: string,
      signal?: AbortSignal,
    ): Promise<DistillationSummary[]> {
      return getJson(
        `/projects/${encodeURIComponent(projectId)}/distillations`,
        distillationList,
        signal,
      );
    },
    getDistillation(
      id: string,
      signal?: AbortSignal,
    ): Promise<DistillationDetail> {
      return getJson(
        `/distillations/${encodeURIComponent(id)}`,
        distillationDetail,
        signal,
      );
    },
    getAccount(signal?: AbortSignal): Promise<AccountStatus> {
      return getJson("/account", accountStatus, signal);
    },
    getTeams(signal?: AbortSignal): Promise<TeamList> {
      return getJson("/teams", teamList, signal);
    },
    getSyncStatus(signal?: AbortSignal): Promise<SyncStatus> {
      return getJson("/sync/status", syncStatus, signal);
    },
    getProjectSharing(
      projectId: string,
      signal?: AbortSignal,
    ): Promise<SharingStatus> {
      return getJson(
        `/projects/${encodeURIComponent(projectId)}/sharing`,
        sharingStatus,
        signal,
      );
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

export const api: ApiClient = createApiClient();
