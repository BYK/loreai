import { data, isHostedMode, knowledgeEdit, ltm } from "@loreai/core";
import { decodeRequestBody } from "./http-body";
import { errorResponse, jsonResponse } from "./api-lists";

const EDIT_KEYS = new Set([
  "expected_revision",
  "title",
  "content",
  "category",
  "confidence",
  "scope",
  "actor",
]);
const RESTORE_KEYS = new Set(["expected_revision", "version_id", "actor"]);

class InvalidKnowledgeRequest extends Error {}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readBody(request: Request): Promise<JsonObject> {
  let value: unknown;
  try {
    value = JSON.parse(await decodeRequestBody(request));
  } catch {
    throw new InvalidKnowledgeRequest("Invalid JSON body");
  }
  if (!isObject(value))
    throw new InvalidKnowledgeRequest("Request body must be a JSON object");
  return value;
}

function assertKnownKeys(body: JsonObject, allowed: Set<string>): void {
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length > 0)
    throw new InvalidKnowledgeRequest(
      `Unknown request field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`,
    );
}

function assertRevision(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new InvalidKnowledgeRequest(
      "expected_revision must be a positive integer",
    );
}

function assertOptionalString(body: JsonObject, key: string): void {
  if (body[key] !== undefined && typeof body[key] !== "string")
    throw new InvalidKnowledgeRequest(`${key} must be a string`);
}

function hosted(configuredHostedMode: boolean): boolean {
  return configuredHostedMode || isHostedMode();
}

function hostedResponse(): Response {
  return errorResponse(
    403,
    "forbidden",
    "Knowledge editing is not available in hosted mode.",
  );
}

function handleFailure(error: unknown): Response {
  if (error instanceof InvalidKnowledgeRequest)
    return errorResponse(400, "invalid_request", error.message);
  if (error instanceof knowledgeEdit.KnowledgeEditError) {
    const status =
      error.code === "invalid_request"
        ? 400
        : error.code === "not_found"
          ? 404
          : 409;
    return jsonResponse(
      {
        type: "error",
        error: {
          type: error.code,
          message: error.message,
          ...(error.expected_revision === undefined
            ? {}
            : { expected_revision: error.expected_revision }),
          ...(error.current_revision === undefined
            ? {}
            : { current_revision: error.current_revision }),
          ...(error.conflicting_entry === undefined
            ? {}
            : { conflicting_entry: error.conflicting_entry }),
        },
      },
      status,
    );
  }
  throw error;
}

function resolvedKnowledgeId(id: string): string {
  return data.resolveId("knowledge", id) ?? id;
}

function currentEntry(id: string) {
  const entry = ltm.getByLogical(id);
  return entry ? { ...entry, id: entry.logical_id } : null;
}

export async function handlePatchKnowledge(
  request: Request,
  id: string,
  configuredHostedMode = false,
): Promise<Response> {
  if (hosted(configuredHostedMode)) return hostedResponse();
  try {
    const body = await readBody(request);
    assertKnownKeys(body, EDIT_KEYS);
    assertRevision(body.expected_revision);
    for (const key of ["title", "content", "category", "scope", "actor"])
      assertOptionalString(body, key);
    if (body.confidence !== undefined && typeof body.confidence !== "number")
      throw new InvalidKnowledgeRequest("confidence must be a number");

    const idResolved = resolvedKnowledgeId(id);
    const result = knowledgeEdit.editKnowledge(idResolved, {
      expectedRevision: body.expected_revision,
      actor: (body.actor as string | undefined) ?? "lore-ui",
      ...(body.title === undefined ? {} : { title: body.title as string }),
      ...(body.content === undefined
        ? {}
        : { content: body.content as string }),
      ...(body.category === undefined
        ? {}
        : { category: body.category as string }),
      ...(body.confidence === undefined ? {} : { confidence: body.confidence }),
      ...(body.scope === undefined
        ? {}
        : { scope: body.scope as "project" | "shared" }),
    });
    return jsonResponse({ ...result, entry: currentEntry(result.id) });
  } catch (error) {
    return handleFailure(error);
  }
}

export async function handleRestoreKnowledge(
  request: Request,
  id: string,
  configuredHostedMode = false,
): Promise<Response> {
  if (hosted(configuredHostedMode)) return hostedResponse();
  try {
    const body = await readBody(request);
    assertKnownKeys(body, RESTORE_KEYS);
    assertRevision(body.expected_revision);
    assertOptionalString(body, "version_id");
    assertOptionalString(body, "actor");
    const result = knowledgeEdit.restoreKnowledge(resolvedKnowledgeId(id), {
      expectedRevision: body.expected_revision,
      actor: (body.actor as string | undefined) ?? "lore-ui",
      ...(body.version_id === undefined
        ? {}
        : { versionId: body.version_id as string }),
    });
    return jsonResponse({ ...result, entry: currentEntry(result.id) });
  } catch (error) {
    return handleFailure(error);
  }
}

export function handleKnowledgeEffects(id: string): Response {
  const result = knowledgeEdit.knowledgeEffects(resolvedKnowledgeId(id));
  if (!result)
    return errorResponse(404, "not_found", `Knowledge entry not found: ${id}`);
  return jsonResponse(result);
}

export function handleCheckedDeleteKnowledge(
  url: URL,
  id: string,
  configuredHostedMode = false,
): Response {
  if (hosted(configuredHostedMode)) return hostedResponse();
  const values = url.searchParams.getAll("expected_revision");
  if (values.length !== 1 || !/^[1-9]\d*$/.test(values[0] ?? "")) {
    return errorResponse(
      400,
      "invalid_request",
      "expected_revision must be a positive integer",
    );
  }
  const expectedRevision = Number(values[0]);
  if (!Number.isSafeInteger(expectedRevision))
    return errorResponse(
      400,
      "invalid_request",
      "expected_revision must be a positive integer",
    );
  try {
    const result = knowledgeEdit.deleteKnowledgeChecked(
      resolvedKnowledgeId(id),
      { expectedRevision, actor: "lore-ui" },
    );
    return jsonResponse({
      deleted: true,
      ...result,
      entry: null,
    });
  } catch (error) {
    return handleFailure(error);
  }
}
