/**
 * Model-usage export endpoints (`GET /api/v1/model-usage[/export]`) (#2026).
 * Returns the model-tides daily document built by
 * `modelUsage.buildDailyModelUsage` — per-day session counts keyed by
 * `provider/model`, scoped to the current tenant.
 *
 * `project` filters by internal project id (same lookup convention as the
 * project-scoped knowledge list: unknown id → 404 `not_found`).
 */
import { modelUsage, projectPath } from "@loreai/core";
import { errorResponse, jsonResponse } from "./management-access";

class ProjectNotFound extends Error {
  constructor(readonly projectId: string) {
    super(`Project not found: ${projectId}`);
  }
}

function parseFilter(url: URL): modelUsage.ModelUsageFilter {
  const filter: {
    -readonly [K in keyof modelUsage.ModelUsageFilter]?: modelUsage.ModelUsageFilter[K];
  } = {};
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (from !== null) filter.from = from;
  if (to !== null) filter.to = to;
  if (url.searchParams.has("project")) {
    const id = url.searchParams.get("project") ?? "";
    if (!id) {
      throw new modelUsage.ModelUsageFilterError("project must not be empty");
    }
    if (!projectPath(id)) throw new ProjectNotFound(id);
    filter.projectId = id;
  }
  return filter;
}

function toErrorResponse(err: unknown): Response {
  if (err instanceof ProjectNotFound) {
    return errorResponse(404, "not_found", err.message);
  }
  if (err instanceof modelUsage.ModelUsageFilterError) {
    return errorResponse(400, "invalid_request", err.message);
  }
  if (err instanceof modelUsage.ModelUsageLimitError) {
    return errorResponse(422, "result_too_large", err.message);
  }
  if (err instanceof modelUsage.ModelUsageUnavailableError) {
    return errorResponse(503, "service_unavailable", err.message);
  }
  throw err;
}

function documentResponse(doc: modelUsage.DailyUsageDocument): Response {
  const response = jsonResponse(doc);
  response.headers.set("cache-control", "no-store");
  return response;
}

export async function handleGetModelUsage(url: URL): Promise<Response> {
  try {
    return documentResponse(
      await modelUsage.buildDailyModelUsage(parseFilter(url)),
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function handleExportModelUsage(url: URL): Promise<Response> {
  try {
    const doc = await modelUsage.buildDailyModelUsage(parseFilter(url));
    const today = new Date().toISOString().slice(0, 10);
    const from = url.searchParams.get("from") ?? doc.days[0]?.day ?? today;
    const to =
      url.searchParams.get("to") ?? doc.days[doc.days.length - 1]?.day ?? today;
    const response = new Response(`${JSON.stringify(doc)}\n`, {
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        "content-disposition": `attachment; filename="lore-model-usage-${from}-${to}.json"`,
      },
    });
    return response;
  } catch (err) {
    return toErrorResponse(err);
  }
}
