/**
 * Structured-memory importer.
 *
 * Consumes a validated `LoreImportDoc` (produced by a source adapter such as
 * Engram/mem0, or supplied directly via `--file`) and writes each entry to the
 * knowledge store via `ltm.create()`.
 *
 * Unlike the conversation-import lane (`extract.ts`), this does NOT go through
 * the curator LLM — the source is already-curated structured memory, so we map
 * it directly. Semantics mirror `agents-file._importEntries()`:
 *   - resolve each distinct project path once,
 *   - exact-title then fuzzy-title dedup (update on content change, skip when identical),
 *   - never resurrect a tombstoned entry (by title),
 *   - enforce the 1200-char content cap ourselves (ltm.create does not),
 *   - clamp confidence, default 1.0,
 *   - never set worker attribution (these are user-authored).
 */
import * as ltm from "../ltm";
import { db, ensureProject } from "../db";
import { MAX_ENTRY_CONTENT_LENGTH } from "../curator";
import { parseImportDoc, type LoreImportDoc } from "./schema";

const TRUNCATION_SUFFIX = " [truncated — entry too long]";

export type StructuredImportOptions = {
  /** Fallback project path for entries without an explicit `project`. */
  defaultProjectPath: string;
  /** When true, import every entry as a global (cross-project) entry. */
  global?: boolean;
  /** When true, compute the outcome without writing to the DB. */
  dryRun?: boolean;
};

export type StructuredImportEntryResult = {
  title: string;
  category: string;
  /** "created" | "updated" | "skipped" */
  action: "created" | "updated" | "skipped";
  /** Reason for a skip (e.g. "tombstoned", "duplicate"). */
  reason?: string;
};

export type StructuredImportResult = {
  created: number;
  updated: number;
  skipped: number;
  entries: StructuredImportEntryResult[];
};

/** Truncate content to the knowledge-entry cap, appending a marker when cut. */
function capContent(content: string): string {
  if (content.length <= MAX_ENTRY_CONTENT_LENGTH) return content;
  // Reserve room for the suffix so the final string still fits the cap.
  const room = MAX_ENTRY_CONTENT_LENGTH - TRUNCATION_SUFFIX.length;
  return content.slice(0, Math.max(0, room)) + TRUNCATION_SUFFIX;
}

/** Synthesize a title from content when the source did not provide one. */
function synthesizeTitle(content: string): string {
  const firstLine = content.split("\n", 1)[0].trim();
  const base = firstLine.length > 0 ? firstLine : content.trim();
  if (base.length <= 60) return base;
  return base.slice(0, 57).trimEnd() + "...";
}

function clampConfidence(v: number | undefined): number {
  if (v == null || Number.isNaN(v)) return 1.0;
  return Math.min(1, Math.max(0, v));
}

/**
 * Find an existing entry with the same title (case-insensitive) visible to this
 * project — mirrors the exact-title dedup inside `ltm.create()`, but lets us
 * report created-vs-updated deterministically (create() can't). Checks the
 * project pool then the cross-project pool. Returns the resolved current-row id.
 */
function findExactTitle(title: string, pid: string | null): string | null {
  const inProject =
    pid !== null
      ? (db()
          .query(
            "SELECT id FROM knowledge_current WHERE project_id = ? AND LOWER(title) = LOWER(?) AND confidence > 0 LIMIT 1",
          )
          .get(pid, title) as { id: string } | null)
      : (db()
          .query(
            "SELECT id FROM knowledge_current WHERE project_id IS NULL AND LOWER(title) = LOWER(?) AND confidence > 0 LIMIT 1",
          )
          .get(title) as { id: string } | null);
  if (inProject) return inProject.id;

  const crossProject = db()
    .query(
      "SELECT id FROM knowledge_current WHERE cross_project = 1 AND LOWER(title) = LOWER(?) AND confidence > 0 LIMIT 1",
    )
    .get(title) as { id: string } | null;
  return crossProject?.id ?? null;
}

/**
 * Import a structured document into the knowledge store.
 *
 * The input is re-validated against `LoreImportDoc` defensively — callers should
 * already have parsed it, but this guarantees the trust boundary regardless of
 * entry point.
 */
export function importStructuredEntries(
  doc: LoreImportDoc,
  opts: StructuredImportOptions,
): StructuredImportResult {
  // Defensive re-validation: guarantees the DB never sees an unvalidated doc.
  const validated = parseImportDoc(doc);

  const result: StructuredImportResult = {
    created: 0,
    updated: 0,
    skipped: 0,
    entries: [],
  };

  // Resolve each distinct project path once (loop-invariant cache).
  const pidCache = new Map<string, string>();
  const resolvePid = (path: string): string => {
    const cached = pidCache.get(path);
    if (cached) return cached;
    const pid = ensureProject(path);
    pidCache.set(path, pid);
    return pid;
  };

  for (const entry of validated.entries) {
    const content = capContent(entry.content.trim());
    const title = entry.title?.trim() || synthesizeTitle(content);
    const category = entry.category ?? "pattern";
    const confidence = clampConfidence(entry.confidence);
    const projectPath = opts.global
      ? opts.defaultProjectPath
      : (entry.project ?? opts.defaultProjectPath);
    const crossProject = opts.global === true;
    // Global entries are stored with scope "global" (project_id null); project
    // entries resolve their own pid for the fuzzy-dedup scope check.
    const pid = crossProject ? null : resolvePid(projectPath);

    // Dedup: an exact title match (deterministic) OR a fuzzy near-title match
    // (same concept, different wording) means "already present": update on a
    // content change, otherwise skip. We do the exact check first so we can
    // report created-vs-updated deterministically; ltm.create() would silently
    // dedup on exact title and we couldn't tell the difference.
    const existingId =
      findExactTitle(title, pid) ??
      ltm.findFuzzyDuplicate({ title, projectId: pid })?.id ??
      null;
    if (existingId) {
      const existing = ltm.get(existingId);
      if (existing && existing.content !== content) {
        if (!opts.dryRun) ltm.update(existing.id, { content });
        result.updated++;
        result.entries.push({ title, category, action: "updated" });
      } else {
        result.skipped++;
        result.entries.push({
          title,
          category,
          action: "skipped",
          reason: "duplicate",
        });
      }
      continue;
    }

    // Resurrection guard: no live match, but a tombstoned (death-cert) entry with
    // this title exists in scope. A structured entry carries no logical_id, so we
    // match by title. Never resurrect a deleted entry — skip it (mirrors the
    // id-keyed guard in agents-file._importEntries and the create()/FTS behavior
    // that keeps tombstoned rows out of the dedup pools).
    if (ltm.findTombstonedByTitle({ title, projectId: pid })) {
      result.skipped++;
      result.entries.push({
        title,
        category,
        action: "skipped",
        reason: "tombstoned",
      });
      continue;
    }

    if (opts.dryRun) {
      result.created++;
      result.entries.push({ title, category, action: "created" });
      continue;
    }

    // No live match and not tombstoned — create a fresh entry. We mint a new
    // UUIDv7 (external_id is NOT a Lore logical_id). ltm.create() applies its
    // own exact-title dedup as a backstop against a concurrent duplicate; the
    // by-title resurrection guard above (findTombstonedByTitle) is what honors
    // the "never resurrect a tombstoned entry" invariant for this lane.
    ltm.create({
      projectPath: crossProject ? undefined : projectPath,
      category,
      title,
      content,
      scope: crossProject ? "global" : "project",
      crossProject,
      confidence,
      // Intentionally NO workerProviderID/workerModelID — user-authored import.
    });
    result.created++;
    result.entries.push({ title, category, action: "created" });
  }

  return result;
}
