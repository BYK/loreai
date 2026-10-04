/**
 * Minimal typed fetch client for the gateway management API.
 *
 * Every response is validated at runtime (ArkType contracts in
 * `~/contracts`) before it reaches a view, and every failure is classified
 * into one of a few `ApiErrorKind`s so the shell can show the right
 * connection state:
 *
 *   - `unreachable`  network failure / gateway down / non-JSON body
 *   - `unauthorized` 401, a bodyless 403, or the bodyless 404 the gateway
 *                    uses to hide management routes from non-loopback peers
 *   - `forbidden`    a JSON-bodied 403 (`{ type: "error", ... }`) — the
 *                    hosted-mode refusal, distinct from the boundary denial
 *   - `not_found`    a JSON 404 (`{ type: "error", error: {...} }`)
 *   - `invalid`      2xx whose body failed validation (`ContractError`)
 *   - `http`         any other non-2xx
 */
import { type Type } from "arktype";

import {
  accountStatus,
  crossProjectKnowledgeEntry,
  ApiError,
  apiErrorBody,
  apiPath,
  cursorPage,
  circuitBreakerResetResult,
  costsSnapshot,
  dailyBudgetResult,
  dedupApplyReceipt,
  dedupPreviewResponse,
  contradictionDecisionResult,
  contradictionListResponse,
  distillationDetail,
  distillationList,
  entityDeleted,
  entityDetail,
  entityListPage,
  entityRebuildCancelResult,
  entityRebuildResult,
  entityRebuildStatus,
  importListPage,
  knowledgeEntry,
  knowledgeList,
  formatKnowledgeSort,
  knowledgeSearchResponse,
  knowledgeVersionHistory,
  sessionWarmingModeResult,
  parseContract,
  projectClearResult,
  projectDeleteResult,
  projectList,
  projectRenameResult,
  projectsMergeResult,
  query,
  sessionsMoveResult,
  recallResponse,
  safeParseContract,
  sessionContext,
  sessionDetail,
  sessionList,
  sessionSummary,
  sessionPage,
  sessionSearchPage,
  sharingStatus,
  syncStatus,
  teamList,
  warmingSettingsResult,
  warmingSnapshot,
  type AccountStatus,
  type CrossProjectKnowledgeEntry,
  type CursorPage,
  type CostsSnapshot,
  type ContradictionDecision,
  type ContradictionDecisionResult,
  type ContradictionListResponse,
  type DistillationDetail,
  type DistillationSummary,
  type DedupApplyBody,
  type DedupApplyReceipt,
  type DedupPreviewResponse,
  type EntityDetail,
  type EntityListPage,
  type EntityRebuildResult,
  type EntityRebuildStatus,
  type ImportListPage,
  type KnowledgeEntry,
  type KnowledgeSearchResponse,
  type KnowledgeVersionHistory,
  type ProjectClearResult,
  type ProjectDeleteResult,
  type ProjectRenameResult,
  type ProjectSummary,
  type ProjectsMergeResult,
  type RecallResponse,
  type SessionsMoveResult,
  type RecallScope,
  type KnowledgeCategory,
  type KnowledgeScope,
  type KnowledgeSort,
  type SessionContext,
  type SessionDetail,
  type SessionPage,
  type SessionSearchPage,
  type SessionSummary,
  type SharingStatus,
  type SyncStatus,
  type TeamList,
  type WarmingSnapshot,
} from "~/contracts";

export {
  ApiError,
  ContractError,
  isApiError,
  isContractError,
  type ApiErrorKind,
  type ContractIssue,
} from "~/contracts";
export { apiPath, query };

export const API_BASE = "/api/v1";

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

async function readErrorDetails(
  res: Response,
): Promise<{ message: string | null; isErrorEnvelope: boolean }> {
  const text = await res.text().catch(() => "");
  if (!text) return { message: null, isErrorEnvelope: false };
  try {
    const parsed = safeParseContract("<error>", apiErrorBody, JSON.parse(text));
    if (parsed.ok) {
      return {
        message: parsed.value.error.message,
        isErrorEnvelope: true,
      };
    }
  } catch {
    // Fall through to the bounded text diagnostic for generic HTTP errors.
  }
  return { message: text.slice(0, 200), isErrorEnvelope: false };
}

async function readErrorMessage(res: Response): Promise<string | null> {
  return (await readErrorDetails(res)).message;
}

export function createApiClient(options: ApiClientOptions = {}) {
  const base = options.base ?? API_BASE;
  const doFetch: FetchLike =
    options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  /**
   * Shared transport + error classifier for GET (getJson) and the write
   * methods (mutateJson). `init` is the method/headers/body bundle.
   */
  async function requestJson<T>(
    path: string,
    init: RequestInit,
    schema: Type<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        credentials: "same-origin",
        ...init,
        headers,
        signal,
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new ApiError("unreachable", path, "Gateway unreachable");
    }

    if (res.status === 401) {
      throw new ApiError(
        "unauthorized",
        path,
        "Gateway refused this browser",
        res.status,
      );
    }

    if (res.status === 403) {
      // Only the gateway's JSON error envelope denotes a hosted-mode refusal.
      // A bodyless 403 is the management-boundary denial; plain-text proxy
      // responses stay generic HTTP errors instead of being mislabeled.
      const details = await readErrorDetails(res);
      if (details.isErrorEnvelope) {
        throw new ApiError(
          "forbidden",
          path,
          details.message ?? "Gateway refused this operation",
          res.status,
        );
      }
      if (details.message === null) {
        throw new ApiError(
          "unauthorized",
          path,
          "Gateway refused this browser",
          res.status,
        );
      }
      throw new ApiError("http", path, details.message, res.status);
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

  function getJson<T>(
    path: string,
    schema: Type<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return requestJson(path, { method: "GET" }, schema, signal);
  }

  /**
   * Write twin of `getJson`: POST/PATCH/DELETE with an optional JSON body.
   * Shares the error classifier, so a hosted-mode 403 lands as `forbidden`
   * and a missing record as `not_found`.
   */
  function mutateJson<T>(
    method: "POST" | "PATCH" | "DELETE",
    path: string,
    body: unknown,
    schema: Type<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const headers: Record<string, string> = {};
    let encoded: string | undefined;
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      encoded = JSON.stringify(body);
    }
    return requestJson(
      path,
      { method, headers, body: encoded },
      schema,
      signal,
    );
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
        apiPath(["projects", projectId, "knowledge"]),
        knowledgeList,
        signal,
      );
    },
    previewDedup(
      projectId: string,
      signal?: AbortSignal,
    ): Promise<DedupPreviewResponse> {
      return mutateJson(
        "POST",
        apiPath(["projects", projectId, "dedup"]),
        {},
        dedupPreviewResponse,
        signal,
      );
    },
    applyDedup(
      projectId: string,
      body: DedupApplyBody,
      signal?: AbortSignal,
    ): Promise<DedupApplyReceipt> {
      return mutateJson(
        "POST",
        apiPath(["projects", projectId, "dedup", "apply"]),
        body,
        dedupApplyReceipt,
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
        apiPath(["projects", projectId, "knowledge"], {
          page: "cursor",
          cursor: opts.cursor,
          limit: opts.limit,
          q: opts.q,
          category: opts.category,
          scope: opts.scope,
          sort: opts.sort ? formatKnowledgeSort(opts.sort) : undefined,
        }),
        cursorPage(knowledgeEntry),
        signal,
      );
    },
    listKnowledgePage(
      opts: {
        cursor?: string | null;
        limit?: number;
        q?: string;
        category?: KnowledgeCategory;
        scope?: KnowledgeScope;
        sort?: KnowledgeSort;
        project?: string;
      } = {},
      signal?: AbortSignal,
    ): Promise<CursorPage<CrossProjectKnowledgeEntry>> {
      return getJson(
        apiPath(["knowledge"], {
          cursor: opts.cursor,
          limit: opts.limit,
          q: opts.q,
          category: opts.category,
          scope: opts.scope,
          sort: opts.sort ? formatKnowledgeSort(opts.sort) : undefined,
          project: opts.project,
        }),
        cursorPage(crossProjectKnowledgeEntry),
        signal,
      );
    },
    searchKnowledge(
      opts: {
        q: string;
        limit?: number;
        project?: string;
        category?: KnowledgeCategory;
        scope?: KnowledgeScope;
      },
      signal?: AbortSignal,
    ): Promise<KnowledgeSearchResponse> {
      return getJson(
        apiPath(["knowledge", "search"], {
          q: opts.q,
          limit: opts.limit,
          project: opts.project,
          category: opts.category,
          scope: opts.scope,
        }),
        knowledgeSearchResponse,
        signal,
      );
    },
    getKnowledge(id: string, signal?: AbortSignal): Promise<KnowledgeEntry> {
      return getJson(apiPath(["knowledge", id]), knowledgeEntry, signal);
    },
    listKnowledgeVersions(
      id: string,
      opts: { includeDeleted?: boolean; signal?: AbortSignal } = {},
    ): Promise<KnowledgeVersionHistory> {
      return getJson(
        apiPath(["knowledge", id, "versions"], {
          include_deleted: opts.includeDeleted || null,
        }),
        knowledgeVersionHistory,
        opts.signal,
      );
    },
    listProjectSessions(
      projectId: string,
      signal?: AbortSignal,
    ): Promise<SessionSummary[]> {
      return getJson(
        apiPath(["projects", projectId, "sessions"]),
        sessionList,
        signal,
      );
    },
    listProjectSessionsPage(
      projectId: string,
      opts: { cursor?: string | null; limit?: number; q?: string } = {},
      signal?: AbortSignal,
    ): Promise<CursorPage<SessionSummary>> {
      return getJson(
        apiPath(["projects", projectId, "sessions"], {
          page: "cursor",
          cursor: opts.cursor,
          limit: opts.limit,
          q: opts.q?.trim() || null,
        }),
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
        apiPath(["recall"], {
          q: opts.q,
          scope: opts.scope,
          expand: false,
          limit: Math.max(1, Math.min(50, opts.limit ?? 20)),
          git_remote: opts.project.git_remote,
          path: opts.project.git_remote ? null : opts.project.path,
          session: opts.session,
        }),
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
        apiPath(["sessions", sessionId], { path: projectPath }),
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
        apiPath(["sessions", sessionId], {
          path: projectPath,
          page: cursor ? null : "cursor",
          limit: cursor ? null : limit,
          cursor,
        }),
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
      return getJson(
        apiPath(["sessions", sessionId, "search"], {
          path: projectPath,
          q,
          limit,
          cursor,
        }),
        sessionSearchPage,
        signal,
      );
    },
    /**
     * `GET /sessions/:id/context?path=` — the session's real context window
     * (#1924): gradient layer, distilled prefix, injected knowledge, prompt
     * deltas and per-turn transform stats. Opt-in; the legacy session
     * response is untouched.
     */
    getSessionContext(
      projectPath: string,
      sessionId: string,
      signal?: AbortSignal,
    ): Promise<SessionContext> {
      return getJson(
        apiPath(["sessions", sessionId, "context"], { path: projectPath }),
        sessionContext,
        signal,
      );
    },
    listProjectDistillations(
      projectId: string,
      signal?: AbortSignal,
    ): Promise<DistillationSummary[]> {
      return getJson(
        apiPath(["projects", projectId, "distillations"]),
        distillationList,
        signal,
      );
    },
    getDistillation(
      id: string,
      signal?: AbortSignal,
    ): Promise<DistillationDetail> {
      return getJson(
        apiPath(["distillations", id]),
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
        apiPath(["projects", projectId, "sharing"]),
        sharingStatus,
        signal,
      );
    },
    /**
     * Keyset-paged entities list. `page` is the previous response's
     * `next_cursor` token (null for the first page); `type` filters by
     * entity_type.
     */
    listEntities(
      opts: { type?: string | null; page?: string | null; limit?: number } = {},
      signal?: AbortSignal,
    ): Promise<EntityListPage> {
      return getJson(
        `/entities${query({
          type: opts.type,
          page: opts.page,
          limit: opts.limit,
        })}`,
        entityListPage,
        signal,
      );
    },
    /**
     * Keyset-paged conversation-import history for one project
     * (`GET /api/v1/projects/:id/imports`). `page` is the previous
     * response's `next_cursor` token.
     */
    listProjectImports(
      projectId: string,
      opts: { page?: string | null; limit?: number } = {},
      signal?: AbortSignal,
    ): Promise<ImportListPage> {
      return getJson(
        `${apiPath(["projects", projectId, "imports"])}${query({
          page: opts.page,
          limit: opts.limit,
        })}`,
        importListPage,
        signal,
      );
    },
    getEntity(id: string, signal?: AbortSignal): Promise<EntityDetail> {
      return getJson(apiPath(["entities", id]), entityDetail, signal);
    },
    /** Whether a rebuild POST is in flight (started anywhere). */
    getEntityRebuildStatus(signal?: AbortSignal): Promise<EntityRebuildStatus> {
      return getJson("/entities/rebuild", entityRebuildStatus, signal);
    },
    /**
     * Rebuild entities across all projects (`{all: true}`). `dryRun` runs the
     * same extraction (still calls the model) but writes nothing.
     */
    rebuildEntities(
      opts: { dryRun: boolean },
      signal?: AbortSignal,
    ): Promise<EntityRebuildResult> {
      return mutateJson(
        "POST",
        "/entities/rebuild",
        { all: true, dryRun: opts.dryRun },
        entityRebuildResult,
        signal,
      );
    },
    cancelEntityRebuild(signal?: AbortSignal): Promise<{ cancelled: boolean }> {
      return mutateJson(
        "POST",
        "/entities/rebuild/cancel",
        undefined,
        entityRebuildCancelResult,
        signal,
      );
    },
    updateEntityMetadata(
      id: string,
      patch: {
        role?: string | null;
        description?: string | null;
        notes?: string | null;
      },
      signal?: AbortSignal,
    ): Promise<EntityDetail> {
      return mutateJson(
        "PATCH",
        apiPath(["entities", id]),
        patch,
        entityDetail,
        signal,
      );
    },
    deleteEntity(
      id: string,
      signal?: AbortSignal,
    ): Promise<{ deleted: boolean }> {
      return mutateJson(
        "DELETE",
        apiPath(["entities", id]),
        undefined,
        entityDeleted,
        signal,
      );
    },
    getWarming(signal?: AbortSignal): Promise<WarmingSnapshot> {
      return getJson("/warming", warmingSnapshot, signal);
    },
    setWarmingEnabled(
      enabled: boolean,
      signal?: AbortSignal,
    ): Promise<{ enabled: boolean; override: boolean | null }> {
      return mutateJson(
        "PATCH",
        "/warming/settings",
        { enabled },
        warmingSettingsResult,
        signal,
      );
    },
    resetWarmingCircuitBreaker(
      signal?: AbortSignal,
    ): Promise<{ reset: boolean; tripped_count: number }> {
      return mutateJson(
        "POST",
        "/warming/circuit-breaker/reset",
        undefined,
        circuitBreakerResetResult,
        signal,
      );
    },
    setSessionWarmingMode(
      sessionId: string,
      mode: "keep" | "stop" | "auto",
      signal?: AbortSignal,
    ): Promise<{
      session_id: string;
      mode: "keep" | "stop" | "auto";
      disabled: boolean;
      force_keep_warm: boolean;
    }> {
      return mutateJson(
        "PATCH",
        apiPath(["warming", "sessions", sessionId, "mode"]),
        { mode },
        sessionWarmingModeResult,
        signal,
      );
    },
    getCosts(signal?: AbortSignal): Promise<CostsSnapshot> {
      return getJson("/costs", costsSnapshot, signal);
    },
    setDailyBudget(
      amount: number,
      signal?: AbortSignal,
    ): Promise<{ amount: number; disabled: boolean }> {
      return mutateJson(
        "PATCH",
        "/costs/budget",
        { amount },
        dailyBudgetResult,

        signal,
      );
    },
    listContradictions(
      signal?: AbortSignal,
    ): Promise<ContradictionListResponse> {
      return getJson("/contradictions", contradictionListResponse, signal);
    },
    /** `PATCH /projects/:id` — rename; returns the stored trimmed name. */
    renameProject(
      id: string,
      name: string,
      signal?: AbortSignal,
    ): Promise<ProjectRenameResult> {
      return mutateJson(
        "PATCH",
        apiPath(["projects", id]),
        { name },
        projectRenameResult,
        signal,
      );
    },
    /**
     * `POST /sessions/move` — move sessions (children included unless
     * `include_children: false`) between projects.
     */
    moveSessions(
      body: {
        session_ids: string[];
        from_project_id: string;
        to_project: { id?: string; git_remote?: string; path?: string };
        include_children?: boolean;
      },
      signal?: AbortSignal,
    ): Promise<SessionsMoveResult> {
      return mutateJson(
        "POST",
        "/sessions/move",
        body,
        sessionsMoveResult,
        signal,
      );
    },
    /** `POST /projects/:id/clear` — deletes content, keeps the project row. */
    clearProject(
      id: string,
      signal?: AbortSignal,
    ): Promise<ProjectClearResult> {
      return mutateJson(
        "POST",
        apiPath(["projects", id, "clear"]),
        {},
        projectClearResult,
        signal,
      );
    },
    /** `DELETE /projects/:id` — deletes the project and everything in it. */
    deleteProject(
      id: string,
      signal?: AbortSignal,
    ): Promise<ProjectDeleteResult> {
      return mutateJson(
        "DELETE",
        apiPath(["projects", id]),
        undefined,
        projectDeleteResult,
        signal,
      );
    },
    /**
     * `POST /projects/merge` — merges projects that share a git remote.
     * Hosted mode answers 400 `invalid_request` (not `forbidden`).
     */
    mergeProjects(signal?: AbortSignal): Promise<ProjectsMergeResult> {
      return mutateJson(
        "POST",
        "/projects/merge",
        undefined,
        projectsMergeResult,
        signal,
      );
    },
    decideContradiction(
      idA: string,
      idB: string,
      decision: ContradictionDecision,
      signal?: AbortSignal,
    ): Promise<ContradictionDecisionResult> {
      return mutateJson(
        "PATCH",
        apiPath(["contradictions", idA, idB]),
        { decision },
        contradictionDecisionResult,

        signal,
      );
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

export const api: ApiClient = createApiClient();
