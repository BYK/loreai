/**
 * REST API for remote data management, recall, and import.
 *
 * All endpoints live under `/api/v1/`. This module is lazy-imported from
 * `server.ts` when the request path starts with `/api/` — keeping the
 * hot LLM-proxy path free of the extra imports.
 *
 * Project resolution: endpoints that need a project accept either:
 *   - `:id` URL param (project UUID)
 *   - `?git_remote=...` query param (preferred for remote clients)
 *   - `?path=...` query param (fallback)
 */

import {
  data,
  ltm,
  temporal,
  embedding,
  conversationImport,
  entityRebuild,
  runRecall,
  config as loreConfig,
  resolveProjectByRemoteOrPath,
  projectPath as getProjectPathById,
  isHostedMode,
  type RecallScope,
  type LLMClient,
} from "@loreai/core";
import type { GatewayConfig } from "./config";
import { createGatewayLLMClient } from "./llm-adapter";
import { resolveAuth } from "./auth";
import { zstdDecompressSync } from "node:zlib";

// ---------------------------------------------------------------------------
// Route matching (adapted from ui.ts)
// ---------------------------------------------------------------------------

type RouteParams = Record<string, string>;

function matchRoute(pathname: string, pattern: string): RouteParams | null {
  const patternParts = pattern.split("/");
  const pathParts = pathname.split("/");
  if (patternParts.length !== pathParts.length) return null;
  const params: RouteParams = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(":")) {
      params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(
  status: number,
  type: string,
  message: string,
): Response {
  return jsonResponse({ type: "error", error: { type, message } }, status);
}

/**
 * Parse request body with optional zstd decompression.
 * Checks `Content-Encoding: zstd` header — if present, decompresses
 * the raw bytes before JSON-parsing.
 */
async function parseBody<T = unknown>(req: Request): Promise<T> {
  const encoding = req.headers.get("content-encoding");
  if (encoding === "zstd") {
    const raw = new Uint8Array(await req.arrayBuffer());
    const decompressed = zstdDecompressSync(raw);
    return JSON.parse(new TextDecoder().decode(decompressed)) as T;
  }
  return (await req.json()) as T;
}

/**
 * Resolve a project from URL params + query string.
 *
 * Priority:
 *   1. `:id` route param (direct UUID)
 *   2. `?git_remote=...` query param (preferred for remote clients)
 *   3. `?path=...` query param (fallback)
 *
 * Returns `{ id, path }` or null if not found.
 */
function resolveProject(
  url: URL,
  routeId?: string,
): { id: string; path: string } | null {
  // 1. Direct UUID from route param
  if (routeId) {
    const path = getProjectPathById(routeId);
    if (path) return { id: routeId, path };
    // Maybe it's a git_remote or path passed as route param — unlikely but handle gracefully
    return null;
  }

  // 2. Query params: git_remote preferred, path fallback
  const gitRemote = url.searchParams.get("git_remote") ?? undefined;
  const pathParam = url.searchParams.get("path") ?? undefined;
  const id = resolveProjectByRemoteOrPath(gitRemote, pathParam);
  if (!id) return null;

  const path = getProjectPathById(id);
  if (!path) return null;
  return { id, path };
}

/** Extract `?limit=N` with a default and a max cap. */
function getLimit(url: URL, defaultLimit = 50, maxLimit = 1000): number {
  const raw = url.searchParams.get("limit");
  if (!raw) return defaultLimit;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < 1) return defaultLimit;
  return Math.min(n, maxLimit);
}

// ---------------------------------------------------------------------------
// LLM client (lazy singleton — same pattern as pipeline.ts)
// ---------------------------------------------------------------------------

let apiLLMClient: LLMClient | null = null;

function getAPILLMClient(config: GatewayConfig): LLMClient {
  if (!apiLLMClient) {
    const cfg = loreConfig();
    const defaultModel = cfg.model ?? {
      providerID: "anthropic",
      modelID: "claude-sonnet-4-6",
    };
    apiLLMClient = createGatewayLLMClient(
      { anthropic: config.upstreamAnthropic, openai: config.upstreamOpenAI },
      resolveAuth,
      defaultModel,
    );
  }
  return apiLLMClient;
}

// ---------------------------------------------------------------------------
// Data read handlers
// ---------------------------------------------------------------------------

function handleListProjects(): Response {
  return jsonResponse(data.listProjects());
}

function handleGlobalStats(): Response {
  return jsonResponse(data.globalStats());
}

function handleListKnowledge(_url: URL, projectPath: string): Response {
  const entries = ltm.forProject(projectPath, false);
  return jsonResponse(entries);
}

function handleListSessions(url: URL, projectPath: string): Response {
  const limit = getLimit(url);
  return jsonResponse(data.listSessions(projectPath, limit));
}

function handleListDistillations(url: URL, projectPath: string): Response {
  const limit = getLimit(url);
  const sessionId = url.searchParams.get("session") ?? undefined;
  return jsonResponse(
    data.listDistillations(projectPath, { sessionId, limit }),
  );
}

function handleShowKnowledge(id: string): Response {
  // Support prefix resolution
  const resolvedId = data.resolveId("knowledge", id) ?? id;
  const entry = ltm.get(resolvedId);
  if (!entry)
    return errorResponse(404, "not_found", `Knowledge entry not found: ${id}`);
  return jsonResponse(entry);
}

function handleShowSession(url: URL, sessionId: string): Response {
  // Session show needs a project to scope the query
  const project = resolveProject(url);
  if (!project) {
    return errorResponse(
      400,
      "invalid_request",
      "Session show requires ?git_remote or ?path to identify the project",
    );
  }
  const messages = temporal.bySession(project.path, sessionId);
  const distillations = data.listDistillations(project.path, { sessionId });
  return jsonResponse({ messages, distillations });
}

function handleShowDistillation(id: string): Response {
  const resolvedId = data.resolveId("distillations", id) ?? id;
  const entry = data.getDistillation(resolvedId);
  if (!entry)
    return errorResponse(404, "not_found", `Distillation not found: ${id}`);
  return jsonResponse(entry);
}

// ---------------------------------------------------------------------------
// Data mutation handlers
// ---------------------------------------------------------------------------

function handleDeleteKnowledge(id: string): Response {
  const resolvedId = data.resolveId("knowledge", id) ?? id;
  if (data.deleteKnowledge(resolvedId)) {
    return jsonResponse({ deleted: true, id: resolvedId });
  }
  return errorResponse(404, "not_found", `Knowledge entry not found: ${id}`);
}

function handleDeleteSession(url: URL, sessionId: string): Response {
  const project = resolveProject(url);
  if (!project) {
    return errorResponse(
      400,
      "invalid_request",
      "Session delete requires ?git_remote or ?path to identify the project",
    );
  }
  const result = data.deleteSession(project.path, sessionId);
  return jsonResponse(result);
}

function handleDeleteDistillation(id: string): Response {
  const resolvedId = data.resolveId("distillations", id) ?? id;
  if (data.deleteDistillation(resolvedId)) {
    return jsonResponse({ deleted: true, id: resolvedId });
  }
  return errorResponse(404, "not_found", `Distillation not found: ${id}`);
}

function handleDeleteProject(id: string): Response {
  const result = data.deleteProject(id);
  if (!result)
    return errorResponse(404, "not_found", `Project not found: ${id}`);
  return jsonResponse(result);
}

async function handleClearProject(
  req: Request,
  projectPath: string,
): Promise<Response> {
  let body: {
    knowledge?: boolean;
    temporal?: boolean;
    distillations?: boolean;
  } = {};
  try {
    body = (await parseBody(req)) ?? {};
  } catch {
    // Empty body = clear all
  }

  // If specific flags are set, clear selectively
  const hasFlags = body.knowledge || body.temporal || body.distillations;
  if (hasFlags) {
    const result: Record<string, number> = {};
    if (body.knowledge)
      result.knowledge_deleted = data.clearKnowledge(projectPath);
    if (body.temporal)
      result.temporal_deleted = data.clearTemporal(projectPath);
    if (body.distillations)
      result.distillations_deleted = data.clearDistillations(projectPath);
    return jsonResponse(result);
  }

  // No flags = clear everything
  return jsonResponse(data.clearProject(projectPath));
}

/**
 * Resolve a target project from a `to_project` body field.
 * Accepts `{ id: "uuid" }`, `{ git_remote: "..." }`, or `{ path: "..." }`.
 */
function resolveTargetProject(
  toProject: { id?: string; git_remote?: string; path?: string } | undefined,
): string | null {
  if (!toProject) return null;
  if (toProject.id) {
    return getProjectPathById(toProject.id);
  }
  if (toProject.git_remote || toProject.path) {
    const id = resolveProjectByRemoteOrPath(
      toProject.git_remote,
      toProject.path,
    );
    if (id) return getProjectPathById(id);
    // If not found by remote/path but a path was given, use it directly
    // (ensureProject will create the project row).
    if (toProject.path) return toProject.path;
  }
  return null;
}

async function handleMoveSessions(req: Request): Promise<Response> {
  type MoveBody = {
    session_ids: string[];
    from_project_id: string;
    to_project?: { id?: string; git_remote?: string; path?: string };
    include_children?: boolean;
  };
  let body: MoveBody;
  try {
    body = await parseBody<MoveBody>(req);
  } catch {
    return errorResponse(400, "invalid_request", "Invalid request body");
  }

  if (!body.session_ids?.length || !body.from_project_id || !body.to_project) {
    return errorResponse(
      400,
      "invalid_request",
      "Required: session_ids (array), from_project_id, to_project ({ id | git_remote | path })",
    );
  }

  const targetPath = resolveTargetProject(body.to_project);
  if (!targetPath) {
    return errorResponse(
      400,
      "invalid_request",
      "Could not resolve target project from to_project",
    );
  }

  const result = data.moveSessions(
    body.session_ids,
    body.from_project_id,
    targetPath,
    { includeChildren: body.include_children },
  );

  // Update in-memory active session bindings so the live dashboard
  // reflects the move immediately — use the expanded list (includes
  // BFS-expanded children) rather than the user-supplied IDs.
  try {
    const { rebindActiveSession } = await import("./pipeline");
    for (const sid of result.movedSessionIds) {
      rebindActiveSession(sid, targetPath);
    }
  } catch {
    // Best-effort — pipeline may not be loaded in all contexts.
  }

  return jsonResponse(result);
}

async function handleMoveKnowledge(
  req: Request,
  knowledgeId: string,
): Promise<Response> {
  type MoveKnowledgeBody = {
    to_project?: { id?: string; git_remote?: string; path?: string };
  };
  let body: MoveKnowledgeBody;
  try {
    body = await parseBody<MoveKnowledgeBody>(req);
  } catch {
    return errorResponse(400, "invalid_request", "Invalid request body");
  }

  if (!body.to_project) {
    return errorResponse(
      400,
      "invalid_request",
      "Required: to_project ({ id | git_remote | path })",
    );
  }

  const targetPath = resolveTargetProject(body.to_project);
  if (!targetPath) {
    return errorResponse(
      400,
      "invalid_request",
      "Could not resolve target project from to_project",
    );
  }

  const resolvedId = data.resolveId("knowledge", knowledgeId) ?? knowledgeId;
  const success = data.reassignKnowledge(resolvedId, targetPath);
  if (!success) {
    return errorResponse(
      404,
      "not_found",
      `Knowledge entry not found: ${knowledgeId}`,
    );
  }
  return jsonResponse({ moved: true, id: resolvedId });
}

function handleMergeProjects(): Response {
  if (isHostedMode()) {
    return errorResponse(
      400,
      "invalid_request",
      "Merge is not supported in hosted mode (requires local filesystem access to scan git remotes)",
    );
  }
  const result = data.backfillGitRemotes();
  return jsonResponse(result);
}

async function handleReindex(): Promise<Response> {
  const knowledge = await embedding.backfillEmbeddings();
  const distillations = await embedding.backfillDistillationEmbeddings();
  return jsonResponse({
    knowledge_embedded: knowledge,
    distillations_embedded: distillations,
  });
}

async function handleDedup(projectPath: string): Promise<Response> {
  // Always dry-run via API; apply requires explicit ?apply=true
  const projectResult = await ltm.deduplicate(projectPath, { dryRun: true });
  const globalResult = await ltm.deduplicateGlobal({ dryRun: true });
  return jsonResponse({ project: projectResult, global: globalResult });
}

// ---------------------------------------------------------------------------
// Recall handler
// ---------------------------------------------------------------------------

async function handleRecall(
  url: URL,
  config: GatewayConfig,
): Promise<Response> {
  const query = url.searchParams.get("q");
  if (!query) {
    return errorResponse(
      400,
      "invalid_request",
      "Missing required query parameter: q",
    );
  }

  const project = resolveProject(url);
  if (!project) {
    return errorResponse(
      400,
      "invalid_request",
      "Recall requires ?git_remote or ?path to identify the project",
    );
  }

  const VALID_SCOPES = new Set(["all", "session", "project", "knowledge"]);
  const rawScope = url.searchParams.get("scope") ?? "all";
  if (!VALID_SCOPES.has(rawScope)) {
    return errorResponse(
      400,
      "invalid_request",
      `Invalid scope: "${rawScope}". Must be one of: all, session, project, knowledge`,
    );
  }
  const scope = rawScope as RecallScope;
  const sessionID = url.searchParams.get("session") ?? undefined;
  const limit = getLimit(url, 10, 50);

  const cfg = loreConfig();
  const searchConfig = {
    ...cfg.search,
    recallLimit: limit,
  };

  let llm: LLMClient | undefined;
  try {
    llm = getAPILLMClient(config);
  } catch {
    // No LLM available — proceed without query expansion
  }

  const result = await runRecall({
    query,
    scope,
    projectPath: project.path,
    sessionID,
    llm,
    searchConfig,
  });

  return jsonResponse({ query, scope, projectPath: project.path, result });
}

// ---------------------------------------------------------------------------
// Import handlers
// ---------------------------------------------------------------------------

async function handleImportExtract(
  req: Request,
  config: GatewayConfig,
): Promise<Response> {
  const body = await parseBody<{
    git_remote?: string;
    path?: string;
    chunks: Array<{
      label: string;
      text: string;
      estimatedTokens: number;
      timestamp: number;
    }>;
    model?: { providerID: string; modelID: string };
  }>(req);

  if (!body.chunks?.length) {
    return errorResponse(
      400,
      "invalid_request",
      "Missing or empty chunks array",
    );
  }

  // Resolve project
  const projectId = resolveProjectByRemoteOrPath(body.git_remote, body.path);
  const projectPath = projectId ? getProjectPathById(projectId) : body.path;
  if (!projectPath) {
    return errorResponse(
      404,
      "not_found",
      "Project not found. Provide git_remote or path.",
    );
  }

  const cfg = loreConfig();
  const defaultModel = body.model ??
    cfg.model ?? {
      providerID: "anthropic",
      modelID: "claude-sonnet-4-6",
    };

  let llm: LLMClient;
  try {
    llm = getAPILLMClient(config);
  } catch {
    return errorResponse(
      503,
      "service_unavailable",
      "No LLM client available for extraction",
    );
  }

  const result = await conversationImport.extractKnowledge({
    llm,
    projectPath,
    chunks: body.chunks,
    model: defaultModel,
  });

  return jsonResponse(result);
}

/**
 * Tracks the in-flight entity rebuild so a separate cancel request can abort it
 * between batches/projects. Single active rebuild at a time (local dashboard);
 * a new rebuild supersedes any stale controller.
 */
let activeRebuildAbort: AbortController | null = null;

/**
 * POST /api/v1/entities/rebuild — re-derive entities from distillation history.
 *
 * Body: { git_remote?, path?, all?, dryRun?, model? }. Provide a project
 * (git_remote or path) OR `all: true` to process every project with history.
 * `dryRun: true` returns the candidate entities without writing.
 *
 * Blocked in hosted mode — this triggers LLM calls that incur real cost and
 * should only run on the operator's own gateway, not from untrusted callers.
 */
async function handleEntityRebuild(
  req: Request,
  config: GatewayConfig,
): Promise<Response> {
  if (isHostedMode()) {
    return errorResponse(
      403,
      "forbidden",
      "Entity rebuild is not available in hosted mode (triggers LLM calls with cost).",
    );
  }
  const body = await parseBody<{
    git_remote?: string;
    path?: string;
    all?: boolean;
    dryRun?: boolean;
    model?: { providerID: string; modelID: string };
  }>(req);

  const cfg = loreConfig();
  const defaultModel = body.model ??
    cfg.model ?? {
      providerID: "anthropic",
      modelID: "claude-sonnet-4-6",
    };

  let llm: LLMClient;
  try {
    llm = getAPILLMClient(config);
  } catch {
    return errorResponse(
      503,
      "service_unavailable",
      "No LLM client available for entity rebuild",
    );
  }

  // Resolve the set of project paths to process.
  let projectPaths: string[];
  if (body.all) {
    projectPaths = data
      .listProjects()
      .filter((p) => p.distillation_count > 0)
      .map((p) => p.path);
  } else {
    const projectId = resolveProjectByRemoteOrPath(body.git_remote, body.path);
    const projectPath = projectId ? getProjectPathById(projectId) : body.path;
    if (!projectPath) {
      return errorResponse(
        404,
        "not_found",
        "Project not found. Provide git_remote, path, or all=true.",
      );
    }
    projectPaths = [projectPath];
  }

  const abort = new AbortController();
  activeRebuildAbort = abort;
  try {
    const results = [];
    for (const projectPath of projectPaths) {
      if (abort.signal.aborted) break;
      results.push(
        await entityRebuild.rebuildEntitiesFromHistory({
          llm,
          projectPath,
          model: defaultModel,
          dryRun: body.dryRun ?? false,
          signal: abort.signal,
        }),
      );
    }
    return jsonResponse({
      dryRun: body.dryRun ?? false,
      cancelled: abort.signal.aborted,
      results,
    });
  } finally {
    if (activeRebuildAbort === abort) activeRebuildAbort = null;
  }
}

/**
 * POST /api/v1/entities/rebuild/cancel — abort the in-flight rebuild (if any).
 * The running rebuild stops at the next batch/project boundary.
 */
function handleEntityRebuildCancel(): Response {
  if (isHostedMode()) {
    return errorResponse(403, "forbidden", "Not available in hosted mode.");
  }
  const cancelled = activeRebuildAbort !== null;
  activeRebuildAbort?.abort();
  return jsonResponse({ cancelled });
}

function handleImportHistory(url: URL): Response {
  const project = resolveProject(url);
  if (!project) {
    return errorResponse(
      400,
      "invalid_request",
      "Import history requires ?git_remote or ?path to identify the project",
    );
  }

  const records = conversationImport.listImports(project.path);
  return jsonResponse(records);
}

async function handleImportRecord(req: Request): Promise<Response> {
  const body = await parseBody<{
    git_remote?: string;
    path?: string;
    agent_name: string;
    source_id: string;
    source_hash: string;
    stats: { created: number; updated: number };
  }>(req);

  if (!body.agent_name || !body.source_id || !body.source_hash || !body.stats) {
    return errorResponse(
      400,
      "invalid_request",
      "Missing required fields: agent_name, source_id, source_hash, stats",
    );
  }

  const projectId = resolveProjectByRemoteOrPath(body.git_remote, body.path);
  const projectPath = projectId ? getProjectPathById(projectId) : body.path;
  if (!projectPath) {
    return errorResponse(
      404,
      "not_found",
      "Project not found. Provide git_remote or path.",
    );
  }

  conversationImport.recordImport(
    projectPath,
    body.agent_name,
    body.source_id,
    body.source_hash,
    body.stats,
  );
  return jsonResponse({ recorded: true });
}

// ---------------------------------------------------------------------------
// Main request dispatcher
// ---------------------------------------------------------------------------

export async function handleAPIRequest(
  req: Request,
  url: URL,
  config: GatewayConfig,
): Promise<Response> {
  const { pathname } = url;
  const method = req.method;
  let params: RouteParams | null;

  // -----------------------------------------------------------------------
  // Data read endpoints
  // -----------------------------------------------------------------------

  if (method === "GET") {
    // GET /api/v1/projects
    if (pathname === "/api/v1/projects") {
      return handleListProjects();
    }

    // GET /api/v1/stats
    if (pathname === "/api/v1/stats") {
      return handleGlobalStats();
    }

    // GET /api/v1/projects/:id/knowledge
    params = matchRoute(pathname, "/api/v1/projects/:id/knowledge");
    if (params) {
      const project = resolveProject(url, params.id);
      if (!project)
        return errorResponse(
          404,
          "not_found",
          `Project not found: ${params.id}`,
        );
      return handleListKnowledge(url, project.path);
    }

    // GET /api/v1/projects/:id/sessions
    params = matchRoute(pathname, "/api/v1/projects/:id/sessions");
    if (params) {
      const project = resolveProject(url, params.id);
      if (!project)
        return errorResponse(
          404,
          "not_found",
          `Project not found: ${params.id}`,
        );
      return handleListSessions(url, project.path);
    }

    // GET /api/v1/projects/:id/distillations
    params = matchRoute(pathname, "/api/v1/projects/:id/distillations");
    if (params) {
      const project = resolveProject(url, params.id);
      if (!project)
        return errorResponse(
          404,
          "not_found",
          `Project not found: ${params.id}`,
        );
      return handleListDistillations(url, project.path);
    }

    // GET /api/v1/knowledge/:id
    params = matchRoute(pathname, "/api/v1/knowledge/:id");
    if (params) return handleShowKnowledge(params.id);

    // GET /api/v1/sessions/:id
    params = matchRoute(pathname, "/api/v1/sessions/:id");
    if (params) return handleShowSession(url, params.id);

    // GET /api/v1/distillations/:id
    params = matchRoute(pathname, "/api/v1/distillations/:id");
    if (params) return handleShowDistillation(params.id);

    // GET /api/v1/recall
    if (pathname === "/api/v1/recall") {
      return await handleRecall(url, config);
    }

    // GET /api/v1/import/history
    if (pathname === "/api/v1/import/history") {
      return handleImportHistory(url);
    }
  }

  // -----------------------------------------------------------------------
  // Data mutation endpoints
  // -----------------------------------------------------------------------

  if (method === "DELETE") {
    // DELETE /api/v1/knowledge/:id
    params = matchRoute(pathname, "/api/v1/knowledge/:id");
    if (params) return handleDeleteKnowledge(params.id);

    // DELETE /api/v1/sessions/:id
    params = matchRoute(pathname, "/api/v1/sessions/:id");
    if (params) return handleDeleteSession(url, params.id);

    // DELETE /api/v1/distillations/:id
    params = matchRoute(pathname, "/api/v1/distillations/:id");
    if (params) return handleDeleteDistillation(params.id);

    // DELETE /api/v1/projects/:id
    params = matchRoute(pathname, "/api/v1/projects/:id");
    if (params) return handleDeleteProject(params.id);
  }

  if (method === "POST") {
    // Literal routes first (before parameterized :id routes)

    // POST /api/v1/projects/merge
    if (pathname === "/api/v1/projects/merge") {
      return handleMergeProjects();
    }

    // POST /api/v1/reindex — global, not project-scoped (backfill is DB-wide)
    if (pathname === "/api/v1/reindex") {
      return await handleReindex();
    }

    // POST /api/v1/import/extract
    if (pathname === "/api/v1/import/extract") {
      return await handleImportExtract(req, config);
    }

    // POST /api/v1/entities/rebuild/cancel — abort the in-flight rebuild
    if (pathname === "/api/v1/entities/rebuild/cancel") {
      return handleEntityRebuildCancel();
    }

    // POST /api/v1/entities/rebuild — re-derive entities from history
    if (pathname === "/api/v1/entities/rebuild") {
      return await handleEntityRebuild(req, config);
    }

    // POST /api/v1/import/record
    if (pathname === "/api/v1/import/record") {
      return await handleImportRecord(req);
    }

    // POST /api/v1/sessions/move — move sessions between projects
    if (pathname === "/api/v1/sessions/move") {
      return await handleMoveSessions(req);
    }

    // Parameterized routes

    // POST /api/v1/knowledge/:id/move — reassign a knowledge entry
    params = matchRoute(pathname, "/api/v1/knowledge/:id/move");
    if (params) {
      return await handleMoveKnowledge(req, params.id);
    }

    // POST /api/v1/projects/:id/clear
    params = matchRoute(pathname, "/api/v1/projects/:id/clear");
    if (params) {
      const project = resolveProject(url, params.id);
      if (!project)
        return errorResponse(
          404,
          "not_found",
          `Project not found: ${params.id}`,
        );
      return await handleClearProject(req, project.path);
    }

    // POST /api/v1/projects/:id/dedup
    params = matchRoute(pathname, "/api/v1/projects/:id/dedup");
    if (params) {
      const project = resolveProject(url, params.id);
      if (!project)
        return errorResponse(
          404,
          "not_found",
          `Project not found: ${params.id}`,
        );
      return await handleDedup(project.path);
    }
  }

  return errorResponse(
    404,
    "not_found",
    `No API route for ${method} ${pathname}`,
  );
}
