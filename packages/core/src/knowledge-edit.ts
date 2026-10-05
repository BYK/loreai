import { existsSync } from "node:fs";
import { resolve } from "node:path";
import * as agentsFile from "./agents-file";
import { config } from "./config";
import { databaseInTransaction, db, projectPath, withTransaction } from "./db";
import * as data from "./data";
import * as embedding from "./embedding";
import * as ltm from "./ltm";
import * as log from "./log";
import * as syncData from "./sync-data";
import { currentTenantId } from "./tenant";

const CATEGORIES = new Set([
  "decision",
  "pattern",
  "preference",
  "architecture",
  "gotcha",
]);

export type KnowledgeEditErrorCode =
  | "invalid_request"
  | "not_found"
  | "deleted"
  | "stale_revision"
  | "title_conflict";

export class KnowledgeEditError extends Error {
  readonly code: KnowledgeEditErrorCode;
  readonly expected_revision?: number;
  readonly current_revision?: number;

  constructor(
    code: KnowledgeEditErrorCode,
    message: string,
    details?: { expected_revision?: number; current_revision?: number },
  ) {
    super(message);
    this.name = "KnowledgeEditError";
    this.code = code;
    this.expected_revision = details?.expected_revision;
    this.current_revision = details?.current_revision;
  }
}

type KnowledgeHead = {
  id: string;
  logical_id: string;
  version: number;
  project_id: string | null;
  cross_project: number;
  category: string;
  title: string;
  content: string;
  is_deleted: number;
};

export type KnowledgeEffects = {
  scope: "project" | "shared";
  project_id: string | null;
  revision: number;
  is_deleted: boolean;
  lore_file: {
    enabled: boolean;
    path: string | null;
    affected: boolean;
  };
  agents_file: {
    enabled: boolean;
    mode: "pointer" | "inline" | "off";
    immediate: false;
  };
  sync: { enabled: boolean };
};

export type KnowledgeMutationResult = {
  id: string;
  revision: number;
  previous_revision: number;
  version_id: string;
  changed: string[];
  effects: KnowledgeEffects & {
    lore_file: KnowledgeEffects["lore_file"] & { regenerated: boolean };
  };
};

export type KnowledgeRestoreResult = KnowledgeMutationResult & {
  restored_from: { version_id: string; version: number };
};

export type EditKnowledgeInput = {
  expectedRevision: number;
  actor: string;
  title?: string;
  content?: string;
  category?: string;
  confidence?: number;
  scope?: "project" | "shared";
};

export type CheckedDeleteInput = {
  expectedRevision: number;
  actor: string;
};

export type RestoreKnowledgeInput = CheckedDeleteInput & {
  versionId?: string;
};

function invalid(message: string): never {
  throw new KnowledgeEditError("invalid_request", message);
}

function validateRevisionAndActor(input: CheckedDeleteInput): void {
  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 1
  )
    invalid("expected_revision must be a positive integer");
  if (typeof input.actor !== "string" || !input.actor.trim())
    invalid("actor must be a non-empty string");
}

function headFor(logicalId: string): KnowledgeHead | null {
  return (
    (db()
      .query(
        `SELECT id, logical_id, version, project_id, cross_project, category,
                title, content, is_deleted
           FROM knowledge
          WHERE tenant_id = ? AND logical_id = ? AND is_current = 1
          LIMIT 1`,
      )
      .get(currentTenantId(), logicalId) as KnowledgeHead | undefined) ?? null
  );
}

function requireHead(
  logicalId: string,
  expectedRevision: number,
): KnowledgeHead {
  const head = headFor(logicalId);
  if (!head)
    throw new KnowledgeEditError(
      "not_found",
      `Knowledge entry not found: ${logicalId}`,
    );
  if (head.version !== expectedRevision) {
    throw new KnowledgeEditError(
      "stale_revision",
      `Knowledge entry changed from revision ${expectedRevision} to ${head.version}`,
      {
        expected_revision: expectedRevision,
        current_revision: head.version,
      },
    );
  }
  return head;
}

function assertOutsideTransaction(): void {
  if (databaseInTransaction(db()))
    invalid("knowledge edit operations must not run inside a transaction");
}

function scopeOf(
  head: Pick<KnowledgeHead, "project_id" | "cross_project">,
): "project" | "shared" {
  return head.project_id === null || head.cross_project === 1
    ? "shared"
    : "project";
}

function effectsFor(head: KnowledgeHead): KnowledgeEffects {
  const cfg = config();
  const path = head.project_id === null ? null : projectPath(head.project_id);
  const projectExists = path !== null && existsSync(path);
  const agentsEnabled = cfg.agentsFile.enabled;
  const loreEnabled = cfg.loreFile.enabled;
  return {
    scope: scopeOf(head),
    project_id: head.project_id,
    revision: head.version,
    is_deleted: head.is_deleted === 1,
    lore_file: {
      enabled: loreEnabled,
      path: projectExists && path ? resolve(path, ".lore.md") : null,
      affected:
        projectExists && head.project_id !== null && head.cross_project === 0,
    },
    agents_file: {
      enabled: agentsEnabled,
      mode: !agentsEnabled ? "off" : loreEnabled ? "pointer" : "inline",
      immediate: false,
    },
    sync: { enabled: syncData.isSyncEnabled() },
  };
}

/** Read the current scope and export consequences for a live or deleted entry. */
export function knowledgeEffects(id: string): KnowledgeEffects | null {
  const logicalId = ltm.logicalIdOf(id);
  const head = headFor(logicalId);
  return head ? effectsFor(head) : null;
}

function exportAfterCommit(projectId: string | null): boolean {
  if (projectId === null) return false;
  const path = projectPath(projectId);
  if (!path || !existsSync(path) || !config().loreFile.enabled) return false;
  try {
    agentsFile.exportLoreFile(path);
    return true;
  } catch (error) {
    log.warn("knowledge edit: .lore.md export failed:", error);
    return false;
  }
}

function resultAfterCommit(input: {
  logicalId: string;
  previousRevision: number;
  versionId: string;
  changed: string[];
  projectId: string | null;
  appended: boolean;
}): KnowledgeMutationResult {
  if (input.appended && embedding.isAvailable()) {
    const entry = ltm.getByLogical(input.logicalId);
    if (entry)
      embedding.embedKnowledgeEntry(entry.id, entry.title, entry.content);
  }
  if (input.changed.length > 0) {
    data.invalidateProjectsCache();
    data.invalidateGlobalStatsCache();
  }
  const regenerated =
    input.changed.length > 0 ? exportAfterCommit(input.projectId) : false;
  const head = headFor(input.logicalId);
  if (!head)
    throw new KnowledgeEditError(
      "not_found",
      `Knowledge entry not found: ${input.logicalId}`,
    );
  const effects = effectsFor(head);
  return {
    id: input.logicalId,
    revision: head.version,
    previous_revision: input.previousRevision,
    version_id: input.versionId,
    changed: input.changed,
    effects: {
      ...effects,
      lore_file: { ...effects.lore_file, regenerated },
    },
  };
}

/** Edit versioned knowledge fields and/or the confidence register. */
export function editKnowledge(
  id: string,
  input: EditKnowledgeInput,
): KnowledgeMutationResult {
  validateRevisionAndActor(input);
  const supplied = [
    input.title,
    input.content,
    input.category,
    input.confidence,
    input.scope,
  ].some((value) => value !== undefined);
  if (!supplied) invalid("at least one knowledge field is required");
  if (input.title !== undefined && !input.title.trim())
    invalid("title must not be blank");
  if (input.content !== undefined && !input.content.trim())
    invalid("content must not be blank");
  if (input.category !== undefined && !CATEGORIES.has(input.category))
    invalid("category is invalid");
  if (
    input.confidence !== undefined &&
    (!Number.isFinite(input.confidence) ||
      input.confidence < 0 ||
      input.confidence > 1)
  )
    invalid("confidence must be a finite number between 0 and 1");
  if (
    input.scope !== undefined &&
    input.scope !== "project" &&
    input.scope !== "shared"
  )
    invalid("scope must be project or shared");

  assertOutsideTransaction();
  const logicalId = ltm.logicalIdOf(id);
  const outcome = withTransaction(() => {
    const head = requireHead(logicalId, input.expectedRevision);
    if (head.is_deleted === 1)
      throw new KnowledgeEditError(
        "deleted",
        `Knowledge entry is deleted: ${logicalId}`,
        {
          expected_revision: input.expectedRevision,
          current_revision: head.version,
        },
      );
    if (input.scope === "project" && head.project_id === null)
      invalid(
        "a shared entry without a project cannot be changed to project scope",
      );

    const title = input.title ?? head.title;
    const content = input.content ?? head.content;
    const category = input.category ?? head.category;
    const nextScope = input.scope ?? scopeOf(head);
    const nextCrossProject = nextScope === "shared";
    const changed: string[] = [];
    if (title !== head.title) changed.push("title");
    if (content !== head.content) changed.push("content");
    if (category !== head.category) changed.push("category");
    if (scopeOf(head) !== nextScope) changed.push("scope");

    const current = ltm.getByLogical(logicalId);
    if (!current)
      throw new KnowledgeEditError(
        "deleted",
        `Knowledge entry is deleted: ${logicalId}`,
      );
    if (title !== head.title && ltm.titleCollides(logicalId, current, title))
      throw new KnowledgeEditError(
        "title_conflict",
        `Another live knowledge entry already uses the title "${title}"`,
        {
          expected_revision: input.expectedRevision,
          current_revision: head.version,
        },
      );

    const confidenceChanged =
      input.confidence !== undefined && input.confidence !== current.confidence;
    if (confidenceChanged) changed.push("confidence");
    const versionedChanged =
      title !== head.title ||
      content !== head.content ||
      category !== head.category ||
      scopeOf(head) !== nextScope;
    let versionId = head.id;
    if (versionedChanged) {
      const appended = ltm.appendVersion(logicalId, {
        ...(title !== head.title ? { title } : {}),
        ...(content !== head.content ? { content } : {}),
        ...(category !== head.category ? { category } : {}),
        ...(scopeOf(head) !== nextScope
          ? { crossProject: nextCrossProject }
          : {}),
      });
      if (!appended)
        throw new KnowledgeEditError(
          "not_found",
          `Knowledge entry not found: ${logicalId}`,
        );
      versionId = appended;
    }
    if (changed.length > 0) {
      ltm.update(logicalId, {
        ...(confidenceChanged ? { confidence: input.confidence } : {}),
        updatedBy: input.actor,
      });
    }
    const nextHead = headFor(logicalId);
    if (!nextHead)
      throw new KnowledgeEditError(
        "not_found",
        `Knowledge entry not found: ${logicalId}`,
      );
    return { versionId, changed, nextHead, appended: versionedChanged };
  });

  return resultAfterCommit({
    logicalId,
    previousRevision: input.expectedRevision,
    versionId: outcome.versionId,
    changed: outcome.changed,
    projectId: outcome.nextHead.project_id,
    appended: outcome.appended,
  });
}

/** Tombstone an entry only if the observed head revision is still current. */
export function deleteKnowledgeChecked(
  id: string,
  input: CheckedDeleteInput,
): KnowledgeMutationResult {
  validateRevisionAndActor(input);
  assertOutsideTransaction();
  const logicalId = ltm.logicalIdOf(id);
  const outcome = withTransaction(() => {
    const head = requireHead(logicalId, input.expectedRevision);
    if (head.is_deleted === 1)
      throw new KnowledgeEditError(
        "deleted",
        `Knowledge entry is deleted: ${logicalId}`,
        {
          expected_revision: input.expectedRevision,
          current_revision: head.version,
        },
      );
    ltm.remove(logicalId);
    const tombstone = headFor(logicalId);
    if (!tombstone || tombstone.is_deleted !== 1)
      throw new KnowledgeEditError(
        "not_found",
        `Knowledge entry not found: ${logicalId}`,
      );
    db()
      .query(
        "UPDATE knowledge SET updated_by = ? WHERE tenant_id = ? AND logical_id = ? AND is_current = 1",
      )
      .run(input.actor, currentTenantId(), logicalId);
    return { head, tombstone };
  });
  return resultAfterCommit({
    logicalId,
    previousRevision: input.expectedRevision,
    versionId: outcome.tombstone.id,
    changed: ["deleted"],
    projectId: outcome.head.project_id,
    appended: false,
  });
}

/** Restore a live historical version against the exact current head. */
export function restoreKnowledge(
  id: string,
  input: RestoreKnowledgeInput,
): KnowledgeRestoreResult {
  validateRevisionAndActor(input);
  if (input.versionId !== undefined && !input.versionId.trim())
    invalid("version_id must not be blank");
  assertOutsideTransaction();
  const logicalId = ltm.logicalIdOf(id);
  const outcome = withTransaction(() => {
    const head = requireHead(logicalId, input.expectedRevision);
    const target = input.versionId
      ? (db()
          .query(
            `SELECT id, logical_id, version, project_id, cross_project, category,
                    title, content, is_deleted
               FROM knowledge
              WHERE tenant_id = ? AND logical_id = ? AND id = ?
              LIMIT 1`,
          )
          .get(currentTenantId(), logicalId, input.versionId) as
          | KnowledgeHead
          | undefined)
      : (db()
          .query(
            `SELECT id, logical_id, version, project_id, cross_project, category,
                    title, content, is_deleted
               FROM knowledge
              WHERE tenant_id = ? AND logical_id = ? AND is_deleted = 0
              ORDER BY version DESC
              LIMIT 1`,
          )
          .get(currentTenantId(), logicalId) as KnowledgeHead | undefined);
    if (!target || target.is_deleted === 1)
      invalid("the requested restore version is unavailable");
    if (head.is_deleted === 0 && target.id === head.id)
      invalid("the requested version is already current");
    if (ltm.titleCollides(logicalId, target, target.title))
      throw new KnowledgeEditError(
        "title_conflict",
        `Another live knowledge entry already uses the title "${target.title}"`,
        {
          expected_revision: input.expectedRevision,
          current_revision: head.version,
        },
      );

    const versionId = ltm.appendVersion(logicalId, {
      title: target.title,
      content: target.content,
      category: target.category,
      crossProject: target.cross_project === 1,
      isDeleted: false,
    });
    if (!versionId)
      throw new KnowledgeEditError(
        "not_found",
        `Knowledge entry not found: ${logicalId}`,
      );
    db()
      .query(
        "UPDATE knowledge SET updated_by = ? WHERE tenant_id = ? AND logical_id = ? AND is_current = 1",
      )
      .run(input.actor, currentTenantId(), logicalId);
    return { head, target, versionId };
  });

  return {
    ...resultAfterCommit({
      logicalId,
      previousRevision: input.expectedRevision,
      versionId: outcome.versionId,
      changed: ["restored"],
      projectId: outcome.head.project_id,
      appended: true,
    }),
    restored_from: {
      version_id: outcome.target.id,
      version: outcome.target.version,
    },
  };
}
