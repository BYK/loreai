import { currentTenantId, db, ltm, syncData } from "@loreai/core";
import type { GatewayConfig } from "./config";
import {
  errorResponse,
  hostedRefusal,
  json,
  readObjectBody,
  requestIsHosted,
} from "./folk-access";

interface ConflictRow {
  id: number;
  table_name: string;
  row_id: string;
  detected_at: number;
  resolution: string | null;
  local_content: string | null;
}

interface CurrentKnowledge {
  version_id: string;
  version: number;
  title: string;
  content: string;
  category: string;
  is_deleted: number;
}

type RestoreMetadata = Parameters<
  typeof ltm.restoreDeletedKnowledge
>[1]["metadata"];

function currentKnowledge(
  logicalId: string,
  includeDeleted = false,
): CurrentKnowledge | null {
  return (
    (db()
      .query(
        `SELECT id AS version_id, version, title, content, category, is_deleted
           FROM knowledge
          WHERE tenant_id = ? AND COALESCE(logical_id, id) = ? AND is_current = 1
            AND (? = 1 OR is_deleted = 0)
          LIMIT 1`,
      )
      .get(currentTenantId(), logicalId, includeDeleted ? 1 : 0) as unknown as
      | CurrentKnowledge
      | undefined) ?? null
  );
}

interface ParsedLocalKnowledge {
  title: string;
  content: string;
  category?: string;
  metadata: RestoreMetadata;
}

function parseLocalKnowledge(
  content: string | null,
): ParsedLocalKnowledge | null {
  if (content === null) return null;
  try {
    const parsed: unknown = JSON.parse(content);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      typeof (parsed as Record<string, unknown>).title !== "string" ||
      typeof (parsed as Record<string, unknown>).content !== "string"
    ) {
      return null;
    }
    const rawMetadata = (parsed as Record<string, unknown>).metadata;
    let metadata: Record<string, unknown> | null = null;
    if (typeof rawMetadata === "string") {
      try {
        const value: unknown = JSON.parse(rawMetadata);
        if (
          typeof value === "object" &&
          value !== null &&
          !Array.isArray(value)
        ) {
          metadata = value as RestoreMetadata;
        }
      } catch {
        metadata = null;
      }
    } else if (
      typeof rawMetadata === "object" &&
      rawMetadata !== null &&
      !Array.isArray(rawMetadata)
    ) {
      metadata = rawMetadata as Record<string, unknown>;
    }
    return {
      title: (parsed as Record<string, unknown>).title as string,
      content: (parsed as Record<string, unknown>).content as string,
      ...(typeof (parsed as Record<string, unknown>).category === "string"
        ? { category: (parsed as Record<string, string>).category }
        : {}),
      metadata,
    };
  } catch {
    return null;
  }
}

function currentShape(entry: CurrentKnowledge | null, showDeleted = false) {
  return entry
    ? {
        version_id: entry.version_id,
        version: entry.version,
        title: entry.title,
        content: entry.content,
        ...(showDeleted && entry.is_deleted === 1 ? { deleted: true } : {}),
      }
    : null;
}

function shapeConflict(row: ConflictRow) {
  if (row.table_name !== "knowledge") {
    return {
      id: row.id,
      table: row.table_name,
      row_id: row.row_id,
      detected_at: new Date(row.detected_at).toISOString(),
      resolution: row.resolution ?? "",
      recoverable: false,
      unrecoverable_reason: "not_knowledge" as const,
      local: null,
      current: null,
    };
  }

  const parsed = parseLocalKnowledge(row.local_content);
  const isRemoteDelete = row.resolution === "remote_delete_wins";
  const current = currentKnowledge(row.row_id, isRemoteDelete);
  let reason: "remote_delete" | "entry_missing" | "unreadable" | null = null;
  if (
    row.resolution === "remote_delete_wins" &&
    parsed !== null &&
    current === null
  ) {
    reason = "entry_missing";
  } else if (
    row.resolution === "remote_delete_wins" &&
    parsed !== null &&
    current !== null
  ) {
    reason = null;
  } else if (row.resolution === "remote_delete_wins" || parsed === null) {
    reason = "unreadable";
  } else if (!current) reason = "entry_missing";
  else if (row.resolution !== "remote_upsert_wins") reason = "unreadable";

  return {
    id: row.id,
    table: row.table_name,
    row_id: row.row_id,
    detected_at: new Date(row.detected_at).toISOString(),
    resolution: row.resolution ?? "",
    recoverable: reason === null,
    unrecoverable_reason: reason,
    local: parsed
      ? {
          title: parsed.title,
          content: parsed.content,
          category: parsed.category ?? current?.category ?? "",
        }
      : null,
    current: currentShape(current, isRemoteDelete),
  };
}

function conflictId(segment: string): number | Response {
  let value: string;
  try {
    value = decodeURIComponent(segment);
  } catch {
    return errorResponse(
      400,
      "invalid_request",
      "Conflict id must be positive",
    );
  }
  if (!/^[1-9]\d*$/.test(value)) {
    return errorResponse(
      400,
      "invalid_request",
      "Conflict id must be positive",
    );
  }
  const id = Number(value);
  return Number.isSafeInteger(id)
    ? id
    : errorResponse(400, "invalid_request", "Conflict id must be positive");
}

function unavailableConflict(id: number): Response {
  return errorResponse(404, "not_found", `Sync conflict ${id} not found`);
}

function findConflict(id: number): ConflictRow | null {
  return syncData.getSyncConflict(id);
}

async function keepLocal(req: Request, id: number): Promise<Response> {
  const body = await readObjectBody(req);
  if (body instanceof Response) return body;
  if (
    Object.keys(body).some((key) => key !== "expected_version_id") ||
    typeof body.expected_version_id !== "string"
  ) {
    return errorResponse(
      400,
      "invalid_request",
      "expected_version_id is required",
    );
  }
  const conflict = findConflict(id);
  if (!conflict) return unavailableConflict(id);
  const shaped = shapeConflict(conflict);
  if (!shaped.recoverable) {
    return errorResponse(
      409,
      "not_recoverable",
      "This sync conflict cannot be restored as a knowledge entry.",
    );
  }
  const local = shaped.local;
  if (!local)
    return errorResponse(
      409,
      "not_recoverable",
      "Local snapshot is unreadable.",
    );
  if (conflict.resolution === "remote_delete_wins") {
    const result = ltm.restoreDeletedKnowledge(conflict.row_id, {
      expectedDeletedVersionId: body.expected_version_id,
      conflictId: id,
      title: local.title,
      content: local.content,
      metadata: parseLocalKnowledge(conflict.local_content)
        ?.metadata as RestoreMetadata,
    });
    if (!result.ok) {
      return errorResponse(
        409,
        "stale_version",
        "Knowledge entry changed; reload the conflict.",
        { current_version_id: result.currentVersionId },
      );
    }
  } else {
    const current = currentKnowledge(conflict.row_id);
    if (!current) {
      return errorResponse(
        409,
        "not_recoverable",
        "The current knowledge entry is no longer available.",
      );
    }
    if (body.expected_version_id !== current.version_id) {
      return errorResponse(
        409,
        "stale_version",
        "Knowledge entry changed; reload the conflict.",
        { current_version_id: current.version_id },
      );
    }
    ltm.update(conflict.row_id, {
      title: local.title,
      content: local.content,
    });
  }
  syncData.deleteSyncConflict(id);
  const updated = currentKnowledge(conflict.row_id);
  return updated
    ? json({ kept: "local", current: currentShape(updated) })
    : errorResponse(
        409,
        "not_recoverable",
        "The knowledge entry is no longer available.",
      );
}

async function discard(req: Request, id: number): Promise<Response> {
  const body = await readObjectBody(req);
  if (body instanceof Response) return body;
  if (Object.keys(body).length !== 0) {
    return errorResponse(
      400,
      "invalid_request",
      "Discard accepts an empty object",
    );
  }
  if (!findConflict(id)) return unavailableConflict(id);
  syncData.deleteSyncConflict(id);
  return json({ discarded: id });
}

export async function handleSyncConflictRequest(
  req: Request,
  url: URL,
  config: GatewayConfig,
): Promise<Response | null> {
  const path = url.pathname;
  if (req.method === "GET" && path === "/api/v1/sync/conflicts") {
    if (requestIsHosted(config)) {
      return json({ available: false, complete: true, conflicts: [] });
    }
    const rows = syncData.listSyncConflicts(101);
    return json({
      available: true,
      complete: rows.length <= 100,
      conflicts: rows.slice(0, 100).map(shapeConflict),
    });
  }
  if (req.method === "POST") {
    const match =
      /^\/api\/v1\/sync\/conflicts\/([^/]+)\/(keep-local|discard)$/.exec(path);
    if (!match) return null;
    if (requestIsHosted(config)) {
      return hostedRefusal(
        "Sync conflict actions are not available in hosted mode.",
      );
    }
    const id = conflictId(match[1]);
    if (id instanceof Response) return id;
    return match[2] === "keep-local" ? keepLocal(req, id) : discard(req, id);
  }
  return null;
}
