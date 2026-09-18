/**
 * Reviewed dedup apply (MEM-02, #1804).
 *
 * A dedup preview is read-only; this module is the ONLY write path for a
 * reviewed set of merge decisions. Every decision group is re-checked against
 * the live database (existence, project scope, revision) inside its own short
 * transaction and either fully applied or fully refused — never partially.
 *
 * Merging reuses the ordinary knowledge primitives: the survivor is untouched
 * and each merged entry receives an immutable death-certificate version via
 * `ltm.remove()`, so its history stays in `knowledge` and it can be restored
 * with `ltm.appendVersion()`. The `dedup_operations` / `dedup_provenance`
 * ledger records why the merge happened and makes the operation idempotent.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import type { Database } from "#db/driver";
import {
  databaseInTransaction,
  db,
  isCurrentDatabase,
  projectPath as projectPathById,
  withTransaction,
} from "./db";
import * as ltm from "./ltm";
import * as agentsFile from "./agents-file";
import { config as loreConfig } from "./config";
import * as log from "./log";
import { currentTenantId } from "./tenant";

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

/** One reviewed merge group: `mergeIds` fold into `keepId`. */
export type DedupDecision = {
  keepId: string;
  mergeIds: string[];
  /**
   * Revision (`knowledge.version`) each referenced entry had when the reviewer
   * saw it, keyed by the exact id used in `keepId` / `mergeIds`.
   */
  expectedRevisions: Record<string, number>;
};

export type DedupApplyRequest = {
  /** Project scope of every referenced entry; `null` = global entries. */
  projectId: string | null;
  /** Client-chosen stable id; a retry with the same id replays the receipt. */
  operationId: string;
  /** Epoch ms at which the reviewer saw the preview. */
  reviewedAt: number;
  decisions: DedupDecision[];
  actor: string;
};

export type DedupRefusalReason =
  | "not_found"
  | "scope_mismatch"
  | "stale_revision";

export type DedupRefusalDetail = {
  id: string;
  reason: DedupRefusalReason | "conflicting_groups";
  expectedRevision?: number;
  actualRevision?: number;
};

export type DedupGroupErrorCode = DedupRefusalReason | "conflicting_groups";

export type DedupGroupRefused = {
  groupIndex: number;
  keepId: string;
  mergeIds: string[];
  error: {
    code: DedupGroupErrorCode;
    message: string;
    details: DedupRefusalDetail[];
  };
};

export type DedupMergedEntry = {
  id: string;
  revision: number;
  /** Death-certificate version id written by this operation. */
  tombstoneVersionId: string;
};

export type DedupGroupApplied = {
  groupIndex: number;
  keepId: string;
  keepRevision: number;
  merged: DedupMergedEntry[];
  appliedAt: number;
};

export type DedupApplyReceipt = {
  operationId: string;
  projectId: string | null;
  applied: DedupGroupApplied[];
  refused: DedupGroupRefused[];
  startedAt: number;
  finishedAt: number;
  /** True when a stored receipt was returned instead of re-applying. */
  replayed: boolean;
};

export type DedupApplyErrorCode =
  | "invalid_request"
  | "not_found"
  | "operation_conflict";

/** Request-level failure: nothing was applied. Group-level refusals are
 *  reported in the receipt instead. */
export class DedupApplyError extends Error {
  readonly code: DedupApplyErrorCode;
  constructor(code: DedupApplyErrorCode, message: string) {
    super(message);
    this.name = "DedupApplyError";
    this.code = code;
  }
}

export const DEDUP_APPLY_LIMITS = Object.freeze({
  maxGroups: 200,
  maxMergeIdsPerGroup: 100,
  maxOperationIdLength: 128,
  maxActorLength: 256,
  maxIdLength: 128,
});

const OPERATION_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function invalid(message: string): never {
  throw new DedupApplyError("invalid_request", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0)
    invalid(`${label} must be a non-empty string`);
  if (value.length > DEDUP_APPLY_LIMITS.maxIdLength)
    invalid(`${label} exceeds ${DEDUP_APPLY_LIMITS.maxIdLength} characters`);
  return value;
}

function requireRevision(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    invalid(`${label} must be a positive integer revision`);
  return value;
}

function parseDecision(raw: unknown, index: number): DedupDecision {
  const label = `decisions[${index}]`;
  if (!isRecord(raw)) invalid(`${label} must be an object`);
  const keepId = requireId(raw.keepId, `${label}.keepId`);
  if (!Array.isArray(raw.mergeIds) || raw.mergeIds.length === 0)
    invalid(`${label}.mergeIds must be a non-empty array`);
  if (raw.mergeIds.length > DEDUP_APPLY_LIMITS.maxMergeIdsPerGroup)
    invalid(
      `${label}.mergeIds exceeds ${DEDUP_APPLY_LIMITS.maxMergeIdsPerGroup} entries`,
    );
  const mergeIds = raw.mergeIds.map((id, i) =>
    requireId(id, `${label}.mergeIds[${i}]`),
  );
  const seen = new Set<string>([keepId]);
  for (const id of mergeIds) {
    if (seen.has(id))
      invalid(`${label} references ${id} more than once (keepId/mergeIds)`);
    seen.add(id);
  }
  if (!isRecord(raw.expectedRevisions))
    invalid(`${label}.expectedRevisions must be an object`);
  const expectedRevisions: Record<string, number> = {};
  for (const id of [keepId, ...mergeIds]) {
    if (!Object.hasOwn(raw.expectedRevisions, id))
      invalid(`${label}.expectedRevisions is missing an entry for ${id}`);
    expectedRevisions[id] = requireRevision(
      raw.expectedRevisions[id],
      `${label}.expectedRevisions[${id}]`,
    );
  }
  return { keepId, mergeIds, expectedRevisions };
}

/**
 * Validate an untrusted value (e.g. a parsed JSON body) into a request.
 * Throws `DedupApplyError("invalid_request")` describing the first problem.
 */
export function parseDedupApplyRequest(raw: unknown): DedupApplyRequest {
  if (!isRecord(raw)) invalid("request body must be a JSON object");
  if (raw.projectId !== null && typeof raw.projectId !== "string")
    invalid("projectId must be a string or null");
  if (typeof raw.projectId === "string" && raw.projectId.length === 0)
    invalid("projectId must not be empty");
  const operationId = requireId(raw.operationId, "operationId");
  if (
    operationId.length > DEDUP_APPLY_LIMITS.maxOperationIdLength ||
    !OPERATION_ID_PATTERN.test(operationId)
  )
    invalid(
      `operationId must match ${OPERATION_ID_PATTERN} and be at most ${DEDUP_APPLY_LIMITS.maxOperationIdLength} characters`,
    );
  if (
    typeof raw.reviewedAt !== "number" ||
    !Number.isSafeInteger(raw.reviewedAt) ||
    raw.reviewedAt < 0
  )
    invalid("reviewedAt must be a non-negative integer (epoch ms)");
  if (typeof raw.actor !== "string" || raw.actor.trim().length === 0)
    invalid("actor must be a non-empty string");
  if (raw.actor.length > DEDUP_APPLY_LIMITS.maxActorLength)
    invalid(`actor exceeds ${DEDUP_APPLY_LIMITS.maxActorLength} characters`);
  if (!Array.isArray(raw.decisions) || raw.decisions.length === 0)
    invalid("decisions must be a non-empty array");
  if (raw.decisions.length > DEDUP_APPLY_LIMITS.maxGroups)
    invalid(`decisions exceeds ${DEDUP_APPLY_LIMITS.maxGroups} groups`);
  return {
    projectId: raw.projectId,
    operationId,
    reviewedAt: raw.reviewedAt,
    actor: raw.actor,
    decisions: raw.decisions.map(parseDecision),
  };
}

/**
 * Order-insensitive fingerprint of everything that defines the operation.
 * Two submissions with the same hash are the same reviewed operation.
 */
export function dedupApplyPayloadHash(request: DedupApplyRequest): string {
  const groups = request.decisions
    .map((d) => ({
      keepId: d.keepId,
      mergeIds: [...d.mergeIds].sort(),
      expectedRevisions: Object.keys(d.expectedRevisions)
        .sort()
        .map((id) => [id, d.expectedRevisions[id]] as const),
    }))
    .sort((a, b) => a.keepId.localeCompare(b.keepId));
  const canonical = JSON.stringify({
    v: 1,
    projectId: request.projectId,
    actor: request.actor,
    reviewedAt: request.reviewedAt,
    groups,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

type CurrentRow = {
  id: string;
  logical_id: string;
  project_id: string | null;
  version: number;
  is_deleted: number;
};

type ResolvedGroup = {
  index: number;
  decision: DedupDecision;
  /** Given id → stable logical id. */
  logical: Map<string, string>;
};

type StoredReceipt = Omit<DedupApplyReceipt, "replayed">;

function currentRow(logicalId: string): CurrentRow | null {
  return db()
    .query(
      `SELECT id, logical_id, project_id, version, is_deleted
         FROM knowledge WHERE tenant_id = ? AND logical_id = ? AND is_current = 1`,
    )
    .get(currentTenantId(), logicalId) as CurrentRow | null;
}

function checkGroup(
  group: ResolvedGroup,
  projectId: string | null,
): { rows: Map<string, CurrentRow> } | DedupGroupRefused["error"] {
  const details: DedupRefusalDetail[] = [];
  const rows = new Map<string, CurrentRow>();
  const { decision } = group;
  for (const id of [decision.keepId, ...decision.mergeIds]) {
    const logicalId = group.logical.get(id) ?? id;
    const row = currentRow(logicalId);
    const expectedRevision = decision.expectedRevisions[id];
    if (!row || row.is_deleted) {
      details.push({ id, reason: "not_found", expectedRevision });
      continue;
    }
    if (row.project_id !== projectId) {
      details.push({ id, reason: "scope_mismatch", expectedRevision });
      continue;
    }
    if (row.version !== expectedRevision) {
      details.push({
        id,
        reason: "stale_revision",
        expectedRevision,
        actualRevision: row.version,
      });
      continue;
    }
    rows.set(id, row);
  }
  if (details.length === 0) return { rows };
  const code = details[0].reason;
  return {
    code,
    message: `group ${group.index} refused: ${details
      .map((d) => `${d.id} ${d.reason}`)
      .join(", ")}`,
    details,
  };
}

function refusal(
  group: ResolvedGroup,
  error: DedupGroupRefused["error"],
): DedupGroupRefused {
  return {
    groupIndex: group.index,
    keepId: group.decision.keepId,
    mergeIds: [...group.decision.mergeIds],
    error,
  };
}

/**
 * Every reference to each logical id across the request, counted per group.
 * A logical id referenced twice — by two groups, or twice within one group
 * through different aliases (version id + logical id) — is a conflict.
 */
function logicalIdReferences(groups: ResolvedGroup[]): Map<string, number[]> {
  const owners = new Map<string, number[]>();
  for (const group of groups)
    for (const logicalId of group.logical.values()) {
      const list = owners.get(logicalId) ?? [];
      list.push(group.index);
      owners.set(logicalId, list);
    }
  return owners;
}

/** Groups referencing a logical id more than once (anywhere) are all refused;
 *  the rest still proceed. */
function conflictingGroups(groups: ResolvedGroup[]): Set<number> {
  const conflicting = new Set<number>();
  for (const indexes of logicalIdReferences(groups).values())
    if (indexes.length > 1) for (const i of indexes) conflicting.add(i);
  return conflicting;
}

function conflictRefusal(
  group: ResolvedGroup,
  groups: ResolvedGroup[],
): DedupGroupRefused {
  const references = logicalIdReferences(groups);
  const details: DedupRefusalDetail[] = [];
  for (const [id, logicalId] of group.logical)
    if ((references.get(logicalId)?.length ?? 0) > 1)
      details.push({ id, reason: "conflicting_groups" });
  return refusal(group, {
    code: "conflicting_groups",
    message: `group ${group.index} refused: ${details
      .map((d) => d.id)
      .join(", ")} refer to an entry that is referenced more than once`,
    details,
  });
}

function checkedRow(rows: Map<string, CurrentRow>, id: string): CurrentRow {
  const row = rows.get(id);
  if (!row) throw new Error(`dedup apply: ${id} passed checks but has no row`);
  return row;
}

function applyGroup(
  group: ResolvedGroup,
  request: DedupApplyRequest,
): DedupGroupApplied | DedupGroupRefused {
  return withTransaction(() => {
    const checked = checkGroup(group, request.projectId);
    if (!("rows" in checked)) return refusal(group, checked);
    const { decision } = group;
    const keepRow = checkedRow(checked.rows, decision.keepId);
    const appliedAt = Date.now();
    const merged: DedupMergedEntry[] = [];
    const tenantId = currentTenantId();
    for (const id of decision.mergeIds) {
      const before = checkedRow(checked.rows, id);
      if (before.logical_id === keepRow.logical_id)
        throw new Error(
          `dedup apply: ${id} aliases the survivor ${decision.keepId}`,
        );
      ltm.remove(before.logical_id);
      const after = currentRow(before.logical_id);
      if (!after || !after.is_deleted)
        throw new Error(
          `dedup apply: ${before.logical_id} has no death-certificate version after remove()`,
        );
      db()
        .query(
          `INSERT INTO dedup_provenance (
             tenant_id, operation_id, group_index, keep_logical_id, merged_logical_id,
             merged_version_id, expected_revision, actual_revision,
             keep_expected_revision, keep_actual_revision, actor, reviewed_at, applied_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          tenantId,
          request.operationId,
          group.index,
          keepRow.logical_id,
          before.logical_id,
          after.id,
          decision.expectedRevisions[id],
          before.version,
          decision.expectedRevisions[decision.keepId],
          keepRow.version,
          request.actor,
          request.reviewedAt,
          appliedAt,
        );
      merged.push({
        id,
        revision: before.version,
        tombstoneVersionId: after.id,
      });
    }
    return {
      groupIndex: group.index,
      keepId: decision.keepId,
      keepRevision: keepRow.version,
      merged,
      appliedAt,
    };
  });
}

/**
 * Claim `operationId` for this payload, or return the receipt a previous
 * identical submission stored. A row without a receipt means an earlier run
 * never finished (crash between groups); it cannot be resumed safely because
 * the reviewed revisions no longer describe the database.
 */
function claimOperation(
  request: DedupApplyRequest,
  payloadHash: string,
  startedAt: number,
): StoredReceipt | null {
  return withTransaction(() => {
    const tenantId = currentTenantId();
    const existing = db()
      .query(
        "SELECT payload_hash, receipt FROM dedup_operations WHERE tenant_id = ? AND operation_id = ?",
      )
      .get(tenantId, request.operationId) as {
      payload_hash: string;
      receipt: string | null;
    } | null;
    if (existing) {
      if (existing.payload_hash !== payloadHash)
        throw new DedupApplyError(
          "operation_conflict",
          `operation ${request.operationId} was already submitted with a different payload`,
        );
      if (existing.receipt === null)
        throw new DedupApplyError(
          "operation_conflict",
          `operation ${request.operationId} was started but never finished; re-run the preview under a new operation id`,
        );
      return JSON.parse(existing.receipt) as StoredReceipt;
    }
    db()
      .query(
        `INSERT INTO dedup_operations (
           tenant_id, operation_id, project_id, actor, reviewed_at, payload_hash, receipt, started_at, finished_at
         ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL)`,
      )
      .run(
        tenantId,
        request.operationId,
        request.projectId,
        request.actor,
        request.reviewedAt,
        payloadHash,
        startedAt,
      );
    return null;
  });
}

function storeReceipt(receipt: StoredReceipt): void {
  db()
    .query(
      "UPDATE dedup_operations SET receipt = ?, finished_at = ? WHERE tenant_id = ? AND operation_id = ?",
    )
    .run(
      JSON.stringify(receipt),
      receipt.finishedAt,
      currentTenantId(),
      receipt.operationId,
    );
}

/** Same post-commit hook the other core knowledge mutations run (data.ts). */
function exportAfterCommit(projectId: string | null): void {
  if (projectId === null) return;
  const path = projectPathById(projectId);
  if (!path || !existsSync(path)) return;
  try {
    if (loreConfig().loreFile.enabled) agentsFile.exportLoreFile(path);
  } catch (e) {
    log.warn("dedup apply: .lore.md export failed:", e);
  }
}

/**
 * Apply reviewed dedup decisions.
 *
 * Atomicity is PER GROUP: each group is one short transaction that is either
 * fully applied or fully refused. Groups are independent review units, so a
 * stale group must not veto the ones the reviewer verified — the receipt tells
 * the caller exactly which groups need a refreshed preview. The whole
 * operation is claimed first, so a retry with the same `operationId` replays
 * the stored receipt and never re-applies (a different payload under the same
 * id is `operation_conflict`).
 *
 * Throws `DedupApplyError` for request-level problems (`invalid_request`,
 * `not_found` for the project, `operation_conflict`); per-group problems
 * (`stale_revision`, `not_found`, `scope_mismatch`, `conflicting_groups`) are
 * returned in `receipt.refused`.
 *
 * Must be called outside any transaction: inside one, the per-group
 * transactions would collapse into savepoints of the caller's and a refused
 * group could roll back applied ones. Such a call is refused up front.
 */
export function applyDedupDecisions(
  database: Database,
  input: DedupApplyRequest,
): DedupApplyReceipt {
  if (!isCurrentDatabase(database))
    invalid("database must be the current lore connection");
  if (databaseInTransaction(database))
    invalid(
      "applyDedupDecisions must not run inside a transaction (per-group atomicity)",
    );
  const request = parseDedupApplyRequest(input);
  if (request.projectId !== null && projectPathById(request.projectId) === null)
    throw new DedupApplyError(
      "not_found",
      `Project not found: ${request.projectId}`,
    );

  const startedAt = Date.now();
  const payloadHash = dedupApplyPayloadHash(request);
  const stored = claimOperation(request, payloadHash, startedAt);
  if (stored) return { ...stored, replayed: true };

  const groups: ResolvedGroup[] = request.decisions.map((decision, index) => ({
    index,
    decision,
    logical: new Map(
      [decision.keepId, ...decision.mergeIds].map((id) => [
        id,
        ltm.logicalIdOf(id),
      ]),
    ),
  }));
  const conflicting = conflictingGroups(groups);

  const applied: DedupGroupApplied[] = [];
  const refused: DedupGroupRefused[] = [];
  for (const group of groups) {
    if (conflicting.has(group.index)) {
      refused.push(conflictRefusal(group, groups));
      continue;
    }
    const outcome = applyGroup(group, request);
    if ("error" in outcome) refused.push(outcome);
    else applied.push(outcome);
  }

  const receipt: StoredReceipt = {
    operationId: request.operationId,
    projectId: request.projectId,
    applied,
    refused,
    startedAt,
    finishedAt: Date.now(),
  };
  storeReceipt(receipt);
  if (applied.length > 0) exportAfterCommit(request.projectId);
  return { ...receipt, replayed: false };
}

/**
 * Current revision for each id (logical or version id), as `applyDedupDecisions`
 * will check it. Ids that do not resolve to a live current row are omitted, so a
 * preview built from this map cannot carry a revision the apply would accept for
 * a deleted entry.
 */
export function currentRevisions(ids: Iterable<string>): Map<string, number> {
  const out = new Map<string, number>();
  for (const id of ids) {
    if (out.has(id)) continue;
    const row = currentRow(ltm.logicalIdOf(id));
    if (row && !row.is_deleted) out.set(id, row.version);
  }
  return out;
}

/** Provenance rows written by an operation, oldest group first. */
export function dedupProvenanceFor(operationId: string): DedupProvenanceRow[] {
  return db()
    .query(
      `SELECT operation_id, group_index, keep_logical_id, merged_logical_id, merged_version_id,
              expected_revision, actual_revision, keep_expected_revision, keep_actual_revision,
              actor, reviewed_at, applied_at
         FROM dedup_provenance WHERE tenant_id = ? AND operation_id = ?
        ORDER BY group_index, merged_logical_id`,
    )
    .all(currentTenantId(), operationId) as DedupProvenanceRow[];
}

export type DedupProvenanceRow = {
  operation_id: string;
  group_index: number;
  keep_logical_id: string;
  merged_logical_id: string;
  merged_version_id: string;
  expected_revision: number;
  actual_revision: number;
  keep_expected_revision: number;
  keep_actual_revision: number;
  actor: string;
  reviewed_at: number;
  applied_at: number;
};
