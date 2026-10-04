/** Embedding configuration migration and startup backfills. */

import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  databaseInTransaction,
  db,
  getKV,
  isCurrentDatabase,
  setKV,
  withSavepoint,
  withTransaction,
} from "../db";
import { isVecAvailable } from "../db/vec";
import {
  clearAllEmbeddings,
  copyBlobsToVec0,
  dropEmbeddingColumn,
  type EmbeddingTable,
  embeddingColumnExists,
  ensureVec0Store,
  hasEmbeddingSql,
  missingEmbeddingSql,
  readStorageMode,
  resolveReadMode,
  setStorageMode,
  storeEmbedding,
} from "../db/vec-store";
import { config } from "../config";
import * as log from "../log";
import { nextEmbeddingBatch } from "./batching";
import {
  EmbeddingAbortError,
  EmbeddingQueueCapacityError,
  LocalProviderUnavailableError,
  awaitEmbeddingOperation,
  createEmbeddingAbortGuard,
  throwIfEmbeddingAborted,
  type EmbeddingOperationOptions,
} from "./contract";
import {
  embed,
  getProvider,
  isAvailable,
  recallEmbedsInFlight,
} from "./runtime";
import {
  enqueueTemporalEmbedding,
  MAX_TEMPORAL_EMBEDDING_SOURCE_BYTES,
  retireOversizedTemporalEmbedding,
} from "../temporal-embedding-admission";
import { currentTenantId, LOCAL_TENANT_ID, withTenant } from "../tenant";
import { TEMPORAL_EMBEDDING_MIN_CONTENT_LENGTH } from "../embedding-units";

/** Diagnostic sinks must never stop source admission or config recovery. */
function reportBackfillInfo(message: string): void {
  try {
    log.info(message);
  } catch {
    // A failed sink cannot discard the rest of the corpus walk.
  }
}

// ---------------------------------------------------------------------------
// Config change detection
// ---------------------------------------------------------------------------

function configFingerprint(): string {
  const cfg = config().search.embeddings;
  return `${cfg.provider}:${cfg.model}:${cfg.dimensions}`;
}

const EMBEDDING_CONFIG_KEY = "lore:embedding_config";

/** Check if embedding config has changed since the last backfill. */
export function checkConfigChange(): boolean {
  const current = configFingerprint();
  const readStored = (): { value: string } | null =>
    db()
      .query("SELECT value FROM kv_meta WHERE key = ?")
      .get(EMBEDDING_CONFIG_KEY) as { value: string } | null;
  const observed = readStored();

  if (observed?.value === current) return false;

  const reconcile = (): boolean => {
    // Re-check after BEGIN IMMEDIATE serializes competing processes. Without
    // this, a late reconciler can clear vectors another process just rebuilt.
    const stored = readStored();
    if (stored?.value === current) return false;

    const mode = readStorageMode(db());

    // A vec0-store DB whose extension didn't load (degraded) cannot manage its
    // embeddings — it can neither count/clear the unreadable vec0 tables nor
    // recreate them. Leave the stored fingerprint UNCHANGED so the change is
    // re-detected and handled the next time the DB opens on a capable runtime.
    if (mode === "vec0" && !isVecAvailable()) return false;

    // Config changed (or first run) — clear all embeddings in all tables
    if (stored) {
      const total =
        mode === "vec0" ? countVec0Embeddings() : countBlobEmbeddings();
      if (total > 0) {
        clearAllEmbeddings(db());
        // The stored fingerprint is data from disk, not a safe log field.
        reportBackfillInfo(
          `embedding config changed, cleared ${total} stale embeddings`,
        );
      }
      // A *dimension* change makes the fixed-width vec0 tables incompatible:
      // recreate them at the new dimension (clearAllEmbeddings emptied the old
      // rows; ensureVec0Store drops + recreates when the stored dim differs, and
      // is a no-op for a same-dimension model/provider swap).
      if (mode === "vec0") {
        ensureVec0Store(db(), config().search.embeddings.dimensions);
      }
      // The clear wiped temporal vectors too, and temporal has no dedicated
      // backfill loop above — re-arm the resumable re-chunk walk so it refills
      // the corpus under the new model/dimension on this same startup.
      resetTemporalRechunkProgress();
    }

    // Store new fingerprint
    db()
      .query(
        "INSERT INTO kv_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?",
      )
      .run(EMBEDDING_CONFIG_KEY, current, current);

    return true;
  };

  return databaseInTransaction(db())
    ? withSavepoint("embedding_config_reconcile", reconcile)
    : withTransaction(reconcile);
}

/** Count blob-layout embeddings across all four tables (config-change logging). */
function countBlobEmbeddings(): number {
  const n = (sql: string) => (db().query(sql).get() as { n: number }).n;
  return (
    n(
      "SELECT COUNT(*) as n FROM knowledge_current WHERE embedding IS NOT NULL",
    ) +
    n("SELECT COUNT(*) as n FROM distillations WHERE embedding IS NOT NULL") +
    n(
      "SELECT COUNT(*) as n FROM temporal_messages WHERE embedding IS NOT NULL",
    ) +
    n("SELECT COUNT(*) as n FROM entities WHERE embedding IS NOT NULL")
  );
}

function countVec0Embeddings(): number {
  const n = (sql: string) => (db().query(sql).get() as { n: number }).n;
  return (
    n("SELECT COUNT(*) as n FROM knowledge_vec") +
    n("SELECT COUNT(*) as n FROM distillation_vec") +
    n("SELECT COUNT(*) as n FROM temporal_vec") +
    n("SELECT COUNT(*) as n FROM entity_vec")
  );
}

/** The four embedding-bearing logical tables, in cutover order. */
const EMBEDDING_TABLES: readonly EmbeddingTable[] = [
  "knowledge",
  "entities",
  "distillations",
  "temporal",
];

/** One-time blob→vec0 cutover. */
export function maybeCutoverToVec0(): void {
  if (!isVecAvailable()) return;

  if (readStorageMode(db()) === "blob") {
    const dim = config().search.embeddings.dimensions;
    ensureVec0Store(db(), dim);
    // Relocate every existing blob into vec0 BEFORE flipping the mode. The copy
    // is idempotent (INSERT OR REPLACE) and does NOT drop anything, so a crash
    // here leaves mode="blob" with the base columns still INTACT — the copy
    // simply re-runs next startup. 🔴 INVARIANT: columns are dropped only AFTER
    // the flip below, so mode==="blob" always implies the embedding columns
    // still exist; no blob-mode query can ever read a half-dropped column (the
    // v55 boot-loop hazard).
    let staleSkipped = 0;
    for (const table of EMBEDDING_TABLES) {
      if (embeddingColumnExists(db(), table))
        staleSkipped += copyBlobsToVec0(db(), table, dim);
    }
    // Flip once vec0 is fully populated and authoritative.
    setStorageMode(db(), "vec0");
    // Arm the temporal re-chunk walk so backfillTemporalEmbeddings definitely
    // runs this startup and re-embeds every row skipped above (plus every legacy
    // single-vector row) at the correct dimension. This is a no-op today — the
    // done flag can only be latched from INSIDE a vec0-mode run of that walk, so
    // a machine transitioning from blob mode never has it set — but calling it at
    // the exact blob->vec0 transition hard-guards that invariant against future
    // refactors and self-documents that the walk is (re)armed here.
    resetTemporalRechunkProgress();
    if (staleSkipped > 0) {
      // Rare corpus corruption (blobs written under a different dimension). The
      // rows were skipped from the copy and will be re-embedded at `dim` by the
      // backfills below; surface it so an operator can see it happened.
      try {
        log.notice(
          `vec0 cutover skipped ${staleSkipped} stale-dimension embedding blob(s) (not ${dim}-dim / ${dim * 4} bytes); they will be re-embedded by the startup backfills`,
        );
      } catch {
        // Cutover progress does not depend on a diagnostic sink.
      }
    }
    reportBackfillInfo(`vec0 storage cutover complete (dim=${dim})`);
  }

  // Reclaim: drop any leftover base embedding columns. Runs STRICTLY in vec0
  // mode (mode never reverts to blob), so no blob-mode reader can observe a
  // half-dropped column. Presence-aware + idempotent → resumable across a crash
  // mid-drop (the next startup finishes the remaining columns).
  if (readStorageMode(db()) === "vec0") {
    let droppedAny = false;
    for (const table of EMBEDDING_TABLES) {
      if (embeddingColumnExists(db(), table)) {
        dropEmbeddingColumn(db(), table);
        droppedAny = true;
      }
    }
    if (droppedAny) {
      try {
        // Best-effort: return the freed pages (notably ~320MB of temporal
        // vectors) to the OS. No-op unless auto_vacuum is on.
        db().query("PRAGMA incremental_vacuum").run();
      } catch {
        // ignore — space is already reclaimed within the DB file by DROP COLUMN.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Startup backfill — single entry point for all hosts
// ---------------------------------------------------------------------------

const STARTUP_BACKFILL_DELAY_MS = 2_000;

/**
 * Outcome of a startup backfill pass, returned for host-side instrumentation (the gateway wraps the call
 * in a Sentry span).
 */
export interface BackfillStats {
  pendingKnowledge: number;
  pendingDistillations: number;
  knowledgeEmbedded: number;
  distillationEmbedded: number;
  entityEmbedded: number;
  knowledgeTotal: number;
  knowledgeWithEmbedding: number;
  distillationTotal: number;
  distillationWithEmbedding: number;
  temporalRechunked: number;
}

function emptyBackfillStats(): BackfillStats {
  return {
    pendingKnowledge: 0,
    pendingDistillations: 0,
    knowledgeEmbedded: 0,
    distillationEmbedded: 0,
    entityEmbedded: 0,
    knowledgeTotal: 0,
    knowledgeWithEmbedding: 0,
    distillationTotal: 0,
    distillationWithEmbedding: 0,
    temporalRechunked: 0,
  };
}

/** Host-supplied knobs for {@link runStartupBackfill}. */
export interface BackfillOptions {
  shouldPause?: () => boolean;
  signal?: AbortSignal;
}

export async function runStartupBackfill(
  opts: BackfillOptions = {},
): Promise<BackfillStats> {
  // One process-wide walk owns the durable cursors. Request tenants never
  // launch a startup scan over another owner's corpus.
  if (currentTenantId() !== LOCAL_TENANT_ID) return emptyBackfillStats();
  const connection = db();
  const isActive = () => isCurrentDatabase(connection) && !opts.signal?.aborted;
  // Temporal admission remains active during a provider outage. Reconcile the
  // generation first so old vectors cannot be mixed with newly queued work
  // if the provider becomes available again in this process.
  checkConfigChange();
  if (!isAvailable()) {
    // Make the degraded state visible in the startup path — this early return
    // was previously silent, so a consumer who omitted the optional
    // local-embedding stack (#1026), or is on a remote provider without a key,
    // had no startup signal that backfill (and vector recall) is off. Gate on
    // `enabled` so a deliberate `search.embeddings.enabled: false` stays quiet.
    // `isAvailable()` already emits the local-broken FTS-only line once; this is
    // the startup-scoped, backfill-specific companion.
    if (config().search.embeddings.enabled !== false) {
      reportBackfillInfo(
        "startup embedding backfill skipped — embeddings unavailable " +
          "(recall will use FTS-only search)",
      );
    }
    const stats = emptyBackfillStats();
    // Durable temporal admission is provider-independent. Preserve recovery
    // progress even while vector recall is temporarily FTS-only.
    stats.temporalRechunked = await backfillTemporalEmbeddings({
      shouldPause: opts.shouldPause,
      signal: opts.signal,
    });
    return stats;
  }

  // Handle an embedding-config change, then attempt the one-time blob→vec0
  // cutover (both no-ops in the steady state). Order matters: a config change
  // clears stale blobs BEFORE the cutover relocates the survivors, so the vec0
  // tables are never seeded with vectors from a since-changed model/dimension.
  maybeCutoverToVec0();

  const mode = readStorageMode(db());

  // A vec0-store DB on a runtime that cannot load sqlite-vec: the blob columns
  // are gone and the vec0 tables are unreadable. No backfill is possible — vector
  // recall degrades to empty (FTS still answers) and re-converges when the DB is
  // next opened on a capable runtime.
  if (resolveReadMode(mode, isVecAvailable()) === "degraded") {
    try {
      log.warn(
        "vec0 storage but sqlite-vec unavailable — skipping embedding backfill " +
          "(vector recall is FTS-only until reopened on a capable runtime)",
      );
    } catch {
      // Vector availability is independent of a diagnostic sink.
    }
    return emptyBackfillStats();
  }

  // Surface backlog up-front so a slow startup is self-explanatory in logs.
  // Counts use the same mode-aware predicates the backfill loops use, so the
  // two numbers always match what we're about to do. (In vec0 mode the blob
  // column is gone — "pending" means a base row absent from the vec0 index.)
  const pendingKnowledge = (
    db()
      .query(
        `SELECT COUNT(*) as n FROM knowledge_current k
         LEFT JOIN projects p ON p.id = k.project_id
         WHERE ${missingEmbeddingSql("knowledge", mode, "k")}
           AND k.confidence > 0.2
           AND (k.project_id IS NULL OR p.tenant_id = k.tenant_id)`,
      )
      .get() as { n: number }
  ).n;
  const pendingDistillations = (
    db()
      .query(
        `SELECT COUNT(*) as n FROM distillations d
         JOIN projects p ON p.id = d.project_id
         WHERE ${missingEmbeddingSql("distillations", mode, "d")}
           AND d.archived = 0 AND d.observations != ''`,
      )
      .get() as { n: number }
  ).n;

  const stats: BackfillStats = {
    ...emptyBackfillStats(),
    pendingKnowledge,
    pendingDistillations,
  };
  if (pendingKnowledge + pendingDistillations > 0) {
    reportBackfillInfo(
      `embedding backfill scheduled: ${pendingKnowledge} knowledge + ` +
        `${pendingDistillations} distillations pending — starting in ` +
        `${STARTUP_BACKFILL_DELAY_MS / 1000}s, batches yield between calls ` +
        `(host stays responsive)`,
    );
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, STARTUP_BACKFILL_DELAY_MS);
      opts.signal?.addEventListener("abort", done, { once: true });
      if (opts.signal?.aborted) done();
    });
  }

  if (!isActive()) return stats;
  try {
    stats.knowledgeEmbedded = await backfillEmbeddings({ signal: opts.signal });
  } catch (error) {
    if (opts.signal?.aborted && error instanceof EmbeddingAbortError)
      return stats;
    throw error;
  }
  if (!isActive()) return stats;
  try {
    stats.distillationEmbedded = await backfillDistillationEmbeddings({
      signal: opts.signal,
    });
  } catch (error) {
    if (opts.signal?.aborted && error instanceof EmbeddingAbortError)
      return stats;
    throw error;
  }
  if (!isActive()) return stats;
  try {
    stats.entityEmbedded = await backfillEntityEmbeddings({
      signal: opts.signal,
    });
  } catch (error) {
    if (opts.signal?.aborted && error instanceof EmbeddingAbortError)
      return stats;
    throw error;
  }
  if (!isActive()) return stats;
  // Re-chunk pre-multi-vector temporal survivors into the vec0 layout. Resumable
  // + done-flagged, so this is the heavy walk only on the first vec0 run (and
  // again after a config change); a no-op in blob mode and once converged. Idle-
  // gated (opts.shouldPause) so it yields the shared embed pool to live traffic.
  stats.temporalRechunked = await backfillTemporalEmbeddings({
    shouldPause: opts.shouldPause,
    signal: opts.signal,
  });
  // The walk may stop after shutdown. Do not reopen storage for GC or coverage
  // stats, or use a successor connection that belongs to a different startup.
  if (!isActive()) return stats;

  // Orphan discovery belongs to the host's idle read-worker maintenance.
  // Never scan the full vector corpus on the startup writer (#1681).

  // Coverage stats — always log to stderr so the problem is visible.
  const kTotal = (
    db()
      .query(
        `SELECT COUNT(*) as n FROM knowledge_current k
         LEFT JOIN projects p ON p.id = k.project_id
         WHERE k.confidence > 0.2
           AND (k.project_id IS NULL OR p.tenant_id = k.tenant_id)`,
      )
      .get() as { n: number }
  ).n;
  const kWithEmb = (
    db()
      .query(
        `SELECT COUNT(*) as n FROM knowledge_current k
         LEFT JOIN projects p ON p.id = k.project_id
         WHERE ${hasEmbeddingSql("knowledge", mode, "k")}
           AND k.confidence > 0.2
           AND (k.project_id IS NULL OR p.tenant_id = k.tenant_id)`,
      )
      .get() as { n: number }
  ).n;
  const dTotal = (
    db()
      .query(
        `SELECT COUNT(*) as n FROM distillations d
         JOIN projects p ON p.id = d.project_id
         WHERE d.archived = 0 AND d.observations != ''`,
      )
      .get() as { n: number }
  ).n;
  const dWithEmb = (
    db()
      .query(
        // Mirror dTotal's predicate (incl. observations != '') so the coverage
        // numerator is always a subset of the denominator (never reads "11/10").
        `SELECT COUNT(*) as n FROM distillations d
         JOIN projects p ON p.id = d.project_id
         WHERE ${hasEmbeddingSql("distillations", mode, "d")}
           AND d.archived = 0 AND d.observations != ''`,
      )
      .get() as { n: number }
  ).n;

  const parts: string[] = [];
  // Lead with the storage mode + native availability so silent degradation is
  // visible at a glance: `storage_mode=vec0 vec=off` means this DB cut over to
  // vec0-only storage but sqlite-vec did not load here, so vector recall is
  // FTS-only until reopened on a capable runtime.
  parts.push(`storage_mode=${mode} vec=${isVecAvailable() ? "on" : "off"}`);
  if (
    stats.knowledgeEmbedded > 0 ||
    stats.distillationEmbedded > 0 ||
    stats.entityEmbedded > 0 ||
    stats.temporalRechunked > 0
  ) {
    parts.push(
      `backfilled ${stats.knowledgeEmbedded} knowledge + ${stats.distillationEmbedded} distillations + ${stats.entityEmbedded} entities + ${stats.temporalRechunked} temporal re-chunked`,
    );
  }
  parts.push(
    `coverage: knowledge ${kWithEmb}/${kTotal}, distillations ${dWithEmb}/${dTotal}`,
  );
  const coverageSummary = `embedding startup: ${parts.join("; ")}`;
  // Coverage must remain visible even when debug logging is disabled or a
  // diagnostic sink fails. This line contains only fixed labels and counts.
  try {
    console.error(`[lore] ${coverageSummary}`);
  } catch {
    // Stderr is best-effort; it never controls the backfill outcome.
  }
  reportBackfillInfo(coverageSummary);

  return {
    ...stats,
    knowledgeTotal: kTotal,
    knowledgeWithEmbedding: kWithEmb,
    distillationTotal: dTotal,
    distillationWithEmbedding: dWithEmb,
  };
}

interface BackfillItem {
  id: string;
  text: string;
  tenantId: string;
  projectId: string | null;
  scopeKey?: string;
}

const BACKFILL_SOURCE_PAGE = 128;
const BACKFILL_TEXT_BATCH = 8;
// Startup backfill is best-effort: enormous sources remain in FTS until they
// can be handled without materializing unbounded text in the gateway.
const MAX_BACKFILL_SOURCE_BYTES = 256 * 1024;

type ContextIndexSource = "knowledge" | "distillations";
const contextIndexBackfills = new Map<
  ContextIndexSource,
  Map<
    string,
    {
      revision: number;
      liveRevision: number;
      depth: number;
      connection: ReturnType<typeof db>;
    }
  >
>();

/** Freeze only the scopes whose missing vectors this backfill is rebuilding. */
export function backfillIndexRevision(
  table: ContextIndexSource,
  scopeKey: string,
  current: number,
  live: number,
): number {
  const snapshot = contextIndexBackfills.get(table)?.get(scopeKey);
  return snapshot && isCurrentDatabase(snapshot.connection)
    ? snapshot.revision + live - snapshot.liveRevision
    : current;
}

function beginContextIndexBackfill(
  items: BackfillItem[],
  table: EmbeddingTable,
): () => void {
  if (table !== "knowledge" && table !== "distillations") return () => {};
  const connection = db();
  const scopes = new Set(items.flatMap((item) => item.scopeKey ?? []));
  if (!scopes.size) return () => {};
  const snapshots = contextIndexBackfills.get(table) ?? new Map();
  contextIndexBackfills.set(table, snapshots);
  const revisions = new Map<
    string,
    { revision: number; liveRevision: number }
  >();
  // Only read the affected scopes; hosted databases may contain many tenants.
  const keys = [...scopes];
  for (let i = 0; i < keys.length; i += 200) {
    const batch = keys.slice(i, i + 200);
    if (table === "knowledge") {
      const pairs = batch.map((key) => {
        const separator = key.indexOf("\0");
        return [key.slice(0, separator), key.slice(separator + 1)];
      });
      const rows = connection
        .query(`SELECT tenant_id, scope_id, embedding_revision, live_embedding_revision
          FROM context_ltm_revision
          WHERE (tenant_id, scope_id) IN (${pairs.map(() => "(?, ?)").join(", ")})`)
        .all(...pairs.flat()) as Array<{
        tenant_id: string;
        scope_id: string;
        embedding_revision: number;
        live_embedding_revision: number;
      }>;
      for (const row of rows)
        revisions.set(`${row.tenant_id}\0${row.scope_id}`, {
          revision: row.embedding_revision,
          liveRevision: row.live_embedding_revision,
        });
    } else {
      const rows = connection
        .query(`SELECT project_id, distillation_embeddings, live_distillation_embeddings
          FROM context_ltm_source_mutations
          WHERE project_id IN (${batch.map(() => "?").join(", ")})`)
        .all(...batch) as Array<{
        project_id: string;
        distillation_embeddings: number;
        live_distillation_embeddings: number;
      }>;
      for (const row of rows)
        revisions.set(row.project_id, {
          revision: row.distillation_embeddings,
          liveRevision: row.live_distillation_embeddings,
        });
    }
  }
  for (const key of scopes) {
    const previous = snapshots.get(key);
    if (previous && previous.connection === connection) previous.depth++;
    else
      snapshots.set(key, {
        ...(revisions.get(key) ?? { revision: 0, liveRevision: 0 }),
        depth: 1,
        connection,
      });
  }
  return () => {
    for (const key of scopes) {
      const snapshot = snapshots.get(key);
      if (snapshot?.connection !== connection) continue;
      if (--snapshot.depth === 0) snapshots.delete(key);
    }
  };
}

function backfillCurrentText(
  table: "knowledge" | "distillations" | "entities",
  item: BackfillItem,
): string | null {
  const mode = readStorageMode(db());
  if (table === "distillations") {
    const row = db()
      .query(
        `SELECT d.observations, d.project_id FROM distillations d
         JOIN projects p ON p.id = d.project_id
          WHERE d.id = ? AND p.tenant_id = ? AND d.archived = 0
            AND length(CAST(d.observations AS BLOB)) <= ?
            AND ${missingEmbeddingSql("distillations", mode, "d")}`,
      )
      .get(item.id, item.tenantId, MAX_BACKFILL_SOURCE_BYTES) as {
      observations: string;
      project_id: string;
    } | null;
    return row?.project_id === item.projectId ? row.observations : null;
  }
  if (table === "knowledge") {
    const row = db()
      .query(
        `SELECT k.title, k.content, k.project_id FROM knowledge_current k
         LEFT JOIN projects p ON p.id = k.project_id
          WHERE k.id = ? AND k.tenant_id = ? AND k.confidence > 0.2
            AND (k.project_id IS NULL OR p.tenant_id = k.tenant_id)
            AND length(CAST(k.title AS BLOB)) + length(CAST(k.content AS BLOB)) + 1 <= ?
            AND ${missingEmbeddingSql("knowledge", mode, "k")}`,
      )
      .get(item.id, item.tenantId, MAX_BACKFILL_SOURCE_BYTES) as {
      title: string;
      content: string;
      project_id: string | null;
    } | null;
    return row?.project_id === item.projectId
      ? `${row.title}\n${row.content}`
      : null;
  }
  const row = db()
    .query(
      `SELECT e.canonical_name, e.project_id,
         (SELECT GROUP_CONCAT(da.alias_value, ' ')
          FROM (SELECT DISTINCT alias_value FROM entity_aliases WHERE entity_id = e.id) da
         ) AS aliases
       FROM entities e LEFT JOIN projects p ON p.id = e.project_id
        WHERE e.id = ? AND e.tenant_id = ?
          AND (e.project_id IS NULL OR p.tenant_id = e.tenant_id)
          AND length(CAST(e.canonical_name AS BLOB)) + COALESCE(
            (SELECT SUM(length(CAST(da.alias_value AS BLOB)) + 1)
             FROM (SELECT DISTINCT alias_value FROM entity_aliases WHERE entity_id = e.id) da), 0
          ) <= ?
          AND ${missingEmbeddingSql("entities", mode, "e")}`,
    )
    .get(item.id, item.tenantId, MAX_BACKFILL_SOURCE_BYTES) as {
    canonical_name: string;
    aliases: string | null;
    project_id: string | null;
  } | null;
  return row?.project_id === item.projectId
    ? `${row.canonical_name} ${row.aliases ?? ""}`.trim()
    : null;
}

function backfillRowStillCurrent(
  table: "knowledge" | "distillations" | "entities",
  item: BackfillItem,
): boolean {
  return backfillCurrentText(table, item) === item.text;
}

async function embedBackfill(
  items: BackfillItem[],
  table: "knowledge" | "distillations" | "entities",
  label: string,
  completeLabel: string,
  isActive: () => boolean,
  guard?: ReturnType<typeof createEmbeddingAbortGuard>,
  progressEvery?: number,
): Promise<{ embedded: number; stopped: boolean }> {
  let embedded = 0;
  let stopped = false;
  let nextProgress = progressEvery ?? Infinity;

  for (let i = 0; i < items.length;) {
    if (guard) throwIfEmbeddingAborted(guard);
    if (!isActive()) return { embedded, stopped: true };
    const candidates = nextEmbeddingBatch(items, i);
    const tenantId = candidates[0].tenantId;
    // Provider requests never combine text from different tenants, even
    // when their IDs are adjacent in the corpus scan.
    const firstForeign = candidates.findIndex(
      (item) => item.tenantId !== tenantId,
    );
    const batch = candidates.slice(
      0,
      firstForeign === -1 ? candidates.length : firstForeign,
    );
    i += batch.length;

    try {
      embedded += await withTenant(tenantId, async () => {
        if (!isActive()) return 0;
        // A later item in a fetched page may have moved while an earlier
        // provider batch was in flight. Validate immediately before sending
        // any text across the provider boundary.
        const currentBatch = batch.filter((item) =>
          backfillRowStillCurrent(table, item),
        );
        if (!currentBatch.length) return 0;
        const work = embed(
          currentBatch.map(({ text }) => text),
          "document",
        );
        const vectors = guard
          ? await awaitEmbeddingOperation(work, guard)
          : await work;
        if (guard) throwIfEmbeddingAborted(guard);
        // close() may replace the writer during inference. Never let the
        // continuation's db() calls reopen or write the successor database.
        if (!isActive()) return 0;

        // A project or tenant can change while the provider is running.
        // Hold the writer lock only for this short, synchronous commit and
        // check the source's current owner before each vector is written.
        const commit = () => {
          let stored = 0;
          for (let j = 0; j < currentBatch.length; j++) {
            if (!backfillRowStillCurrent(table, currentBatch[j])) continue;
            storeEmbedding(db(), table, currentBatch[j].id, vectors[j], {
              backfill: true,
            });
            stored++;
          }
          return stored;
        };
        return databaseInTransaction(db())
          ? withSavepoint("commit_embedding_backfill", commit)
          : withTransaction(commit);
      });
      if (!isActive()) return { embedded, stopped: true };
    } catch (error) {
      if (error instanceof EmbeddingAbortError) throw error;
      if (
        error instanceof EmbeddingQueueCapacityError ||
        error instanceof LocalProviderUnavailableError
      ) {
        const reason =
          error instanceof EmbeddingQueueCapacityError
            ? "queue saturated"
            : "provider unavailable";
        try {
          reportBackfillInfo(`${label} backfill stopped: ${reason}`);
        } catch {
          // A diagnostic sink cannot change durable backfill state.
        }
        stopped = true;
        break;
      }
      // Provider/storage errors can contain private text. Diagnostics are
      // fixed and may never leak an exception or part of its message.
      try {
        log.error(`${label} backfill batch failed`);
      } catch {
        // Failed logging must not replace the provider/storage failure.
      }
    }

    if (embedded >= nextProgress) {
      reportBackfillInfo(
        `embedding ${completeLabel}: ${embedded}/${items.length}…`,
      );
      nextProgress = embedded + (progressEvery ?? Infinity);
    }
  }

  if (embedded > 0) reportBackfillInfo(`embedded ${embedded} ${completeLabel}`);
  return { embedded, stopped };
}

/** Read a bounded page, then release its text before fetching the next one. */
async function embedBackfillPages(
  selectPage: (after: string) => BackfillItem[],
  table: "knowledge" | "distillations" | "entities",
  label: string,
  completeLabel: string,
  isActive: () => boolean,
  guard?: ReturnType<typeof createEmbeddingAbortGuard>,
  progressEvery?: number,
): Promise<number> {
  const progress = { after: "", total: 0 };
  while (true) {
    if (guard) throwIfEmbeddingAborted(guard);
    if (!isActive()) return progress.total;
    const candidates = selectPage(progress.after);
    if (candidates.length === 0) return progress.total;
    // A process-wide page contains only IDs and owner metadata. Fetch private
    // text only after entering its authoritative tenant, then recheck it again
    // before provider submission and after inference.
    // Retain the revision snapshot over the whole metadata page, even though
    // only one bounded text sub-batch is in memory at a time.
    const endIndexBackfill = beginContextIndexBackfill(candidates, table);
    try {
      for (
        let offset = 0;
        offset < candidates.length;
        offset += BACKFILL_TEXT_BATCH
      ) {
        if (!isActive()) return progress.total;
        const page = candidates
          .slice(offset, offset + BACKFILL_TEXT_BATCH)
          .flatMap((item) =>
            withTenant(item.tenantId, (): BackfillItem[] => {
              const text = backfillCurrentText(table, item);
              return text === null ? [] : [{ ...item, text }];
            }),
          );
        if (page.length === 0) continue;
        const result = await embedBackfill(
          page,
          table,
          label,
          completeLabel,
          isActive,
          guard,
          progressEvery,
        );
        progress.total += result.embedded;
        if (result.stopped) return progress.total;
      }
    } finally {
      endIndexBackfill();
    }
    progress.after = candidates[candidates.length - 1].id;
  }
}

export async function backfillEmbeddings(
  options: EmbeddingOperationOptions = {},
): Promise<number> {
  const guard = createEmbeddingAbortGuard("knowledge-backfill", options);
  throwIfEmbeddingAborted(guard);
  const connection = db();
  checkConfigChange();
  throwIfEmbeddingAborted(guard);
  if (!getProvider()) return 0;

  const mode = readStorageMode(db());
  return embedBackfillPages(
    (after) => {
      const rows = db()
        .query(
          `SELECT k.id, k.tenant_id, k.project_id, k.cross_project
           FROM knowledge_current k
           LEFT JOIN projects p ON p.id = k.project_id
           WHERE ${missingEmbeddingSql("knowledge", mode, "k")}
             AND k.confidence > 0.2 AND k.id > ?
             AND (k.project_id IS NULL OR p.tenant_id = k.tenant_id)
           ORDER BY k.id LIMIT ?`,
        )
        .all(after, BACKFILL_SOURCE_PAGE) as Array<{
        id: string;
        tenant_id: string;
        project_id: string | null;
        cross_project: number;
      }>;
      return rows.map(({ id, tenant_id, project_id, cross_project }) => ({
        id,
        text: "",
        tenantId: tenant_id,
        projectId: project_id,
        scopeKey: `${tenant_id}\0${project_id === null || cross_project ? "" : project_id}`,
      }));
    },
    "knowledge",
    "embedding",
    "knowledge entries",
    () => isCurrentDatabase(connection) && !options.signal?.aborted,
    guard,
  );
}

export async function backfillDistillationEmbeddings(
  options: EmbeddingOperationOptions = {},
): Promise<number> {
  const guard = createEmbeddingAbortGuard("distillation-backfill", options);
  throwIfEmbeddingAborted(guard);
  if (!getProvider()) return 0;
  const connection = db();
  const mode = readStorageMode(connection);
  return embedBackfillPages(
    (after) => {
      const rows = db()
        .query(
          `SELECT d.id, d.project_id, p.tenant_id
           FROM distillations d JOIN projects p ON p.id = d.project_id
           WHERE ${missingEmbeddingSql("distillations", mode, "d")}
             AND d.archived = 0 AND d.observations != '' AND d.id > ?
           ORDER BY d.id LIMIT ?`,
        )
        .all(after, BACKFILL_SOURCE_PAGE) as Array<{
        id: string;
        project_id: string;
        tenant_id: string;
      }>;
      return rows.map(({ id, project_id, tenant_id }) => ({
        id,
        text: "",
        tenantId: tenant_id,
        projectId: project_id,
        scopeKey: project_id,
      }));
    },
    "distillations",
    "distillation embedding",
    "distillations",
    () => isCurrentDatabase(connection) && !options.signal?.aborted,
    guard,
    256,
  );
}

export async function backfillEntityEmbeddings(
  options: EmbeddingOperationOptions = {},
): Promise<number> {
  const guard = createEmbeddingAbortGuard("entity-backfill", options);
  throwIfEmbeddingAborted(guard);
  if (!getProvider()) return 0;
  const connection = db();
  const mode = readStorageMode(connection);
  return embedBackfillPages(
    (after) => {
      const rows = db()
        .query(
          `SELECT e.id, e.tenant_id, e.project_id
           FROM entities e LEFT JOIN projects p ON p.id = e.project_id
           WHERE ${missingEmbeddingSql("entities", mode, "e")}
             AND e.id > ? AND (e.project_id IS NULL OR p.tenant_id = e.tenant_id)
           ORDER BY e.id LIMIT ?`,
        )
        .all(after, BACKFILL_SOURCE_PAGE) as Array<{
        id: string;
        tenant_id: string;
        project_id: string | null;
      }>;
      return rows.map(({ id, tenant_id, project_id }) => ({
        id,
        text: "",
        tenantId: tenant_id,
        projectId: project_id,
      }));
    },
    "entities",
    "entity embedding",
    "entities",
    () => isCurrentDatabase(connection) && !options.signal?.aborted,
    guard,
  );
}
const TEMPORAL_RECHUNK_CURSOR_KEY = "lore:temporal_rechunk.cursor";
const TEMPORAL_RECHUNK_DONE_KEY = "lore:temporal_rechunk.done";
const TEMPORAL_RECHUNK_PAGE = 256;
const TEMPORAL_RECHUNK_YIELD_ROWS = 32;
const TEMPORAL_RECHUNK_YIELD_MS = 8;
const TEMPORAL_SOURCE_CAP_CURSOR_KEY =
  "lore:temporal_embedding.source_cap_cursor";
const TEMPORAL_RECHUNK_ELIGIBLE_SQL = `length(CAST(content AS BLOB)) BETWEEN ${TEMPORAL_EMBEDDING_MIN_CONTENT_LENGTH} AND ${MAX_TEMPORAL_EMBEDDING_SOURCE_BYTES}`;
const TEMPORAL_RECHUNK_ATTEMPTS_KEY = "lore:temporal_rechunk.attempts";
const TEMPORAL_RECHUNK_INFLIGHT_KEY = "lore:temporal_rechunk.inflight";
const TEMPORAL_RECHUNK_ROW_ATTEMPTS_KEY = "lore:temporal_rechunk.row_attempts";
const TEMPORAL_RECHUNK_SKIP_KEY = "lore:temporal_rechunk.skip";
const TEMPORAL_RECHUNK_FAIR_CURSOR_PREFIX = "lore:temporal_rechunk.fair:";
const TEMPORAL_RECHUNK_FAIR_SCAN_PREFIX = "lore:temporal_rechunk.fair_scan:";
const TEMPORAL_RECHUNK_PARK_NEXT_KEY = "lore:temporal_rechunk.park_next";
const TEMPORAL_RECHUNK_PARK_RETRY_KEY = "lore:temporal_rechunk.park_retry";
const TEMPORAL_RECHUNK_PARK_MESSAGE_KEY = "lore:temporal_rechunk.park_message";
const TEMPORAL_RECHUNK_QUEUE_RECOVERY_KEY =
  "lore:temporal_rechunk.queue_recovery_pending";
const TEMPORAL_RECHUNK_MAX_ROWID_KEY = "lore:temporal_rechunk.max_rowid";
/** Fence active walks across config resets, including resets by other processes. */
const TEMPORAL_RECHUNK_EPOCH_KEY = "lore:temporal_rechunk.epoch";
const TEMPORAL_RECHUNK_PAUSE_POLL_MS = 250;
// The durable queue can already contain more than this on upgrade. Do not
// discard it: park the walk and let the scheduler reduce historical debt.
// Live arrivals never consume the historical admission window.
const TEMPORAL_RECHUNK_PENDING_WINDOW = 512;
const TEMPORAL_RECHUNK_FAIR_PROBE_MS = 1_000;
const TEMPORAL_RECHUNK_FAIR_PROJECT_PAGE = 16;
const TEMPORAL_RECHUNK_FAIR_MESSAGE_PAGE = 32;
const TEMPORAL_RECHUNK_FAIR_EXTRA_SLOTS = 16;

/** Retire legacy vectors above the source cap, even after re-chunking finished. */
async function retireOversizedTemporalVectors(
  connection: ReturnType<typeof db>,
  isActive: () => boolean,
): Promise<void> {
  const saved = Number(getKV(TEMPORAL_SOURCE_CAP_CURSOR_KEY) ?? "0");
  let after = Number.isSafeInteger(saved) && saved >= 0 ? saved : 0;
  let checkpoint = after;
  let blocked = false;
  while (isActive()) {
    // Read only metadata. Loading or hashing a legacy 128 MiB source here
    // would block the event loop before the scheduler has even started.
    const rows = connection
      .query(
        `SELECT t.rowid AS source_rowid, t.id, t.project_id, p.tenant_id,
                length(CAST(t.content AS BLOB)) AS bytes
           FROM temporal_messages t JOIN projects p ON p.id = t.project_id
          WHERE t.rowid > ? ORDER BY t.rowid LIMIT ?`,
      )
      .all(after, TEMPORAL_RECHUNK_YIELD_ROWS) as Array<{
      source_rowid: number;
      id: string;
      project_id: string;
      tenant_id: string;
      bytes: number;
    }>;
    if (!rows.length) return;
    for (const row of rows) {
      if (!isActive()) return;
      if (row.bytes > MAX_TEMPORAL_EMBEDDING_SOURCE_BYTES) {
        let retired = withTenant(row.tenant_id, () =>
          retireOversizedTemporalEmbedding(row.id, row.project_id),
        );
        for (let attempt = 0; !retired && attempt < 3; attempt++) {
          if (!isActive()) return;
          // The source may have moved between page selection and retirement.
          // Re-read its owner, never its text, before trying again.
          const current = connection
            .query(
              `SELECT t.id, t.project_id, p.tenant_id,
                      length(CAST(t.content AS BLOB)) AS bytes
                 FROM temporal_messages t JOIN projects p ON p.id = t.project_id
                WHERE t.rowid = ?`,
            )
            .get(row.source_rowid) as {
            id: string;
            project_id: string;
            tenant_id: string;
            bytes: number;
          } | null;
          if (
            !current ||
            current.bytes <= MAX_TEMPORAL_EMBEDDING_SOURCE_BYTES
          ) {
            retired = true;
            break;
          }
          retired = withTenant(current.tenant_id, () =>
            retireOversizedTemporalEmbedding(current.id, current.project_id),
          );
          if (!retired && attempt < 2)
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
        if (!retired) blocked = true;
      }
      after = row.source_rowid;
      // Later rows can still be retired after a repeatedly moving source, but
      // its rowid remains the next run's starting point until it is resolved.
      if (!blocked) checkpoint = after;
    }
    if (!isActive()) return;
    withSavepoint("checkpoint_temporal_source_cap", () => {
      const recorded = Number(getKV(TEMPORAL_SOURCE_CAP_CURSOR_KEY) ?? "0");
      if (!Number.isSafeInteger(recorded) || recorded < checkpoint)
        setKV(TEMPORAL_SOURCE_CAP_CURSOR_KEY, String(checkpoint));
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** Wake parked startup work on cancellation without holding the process open. */
async function waitForTemporalRetry(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, TEMPORAL_RECHUNK_PAUSE_POLL_MS);
    timer.unref?.();
    signal?.addEventListener("abort", done, { once: true });
    if (signal?.aborted) done();
  });
}

async function awaitBackfillIdle(
  shouldPause: (() => boolean) | undefined,
  isCurrent: () => boolean,
  signal?: AbortSignal,
): Promise<void> {
  if (!shouldPause) return;
  // Edge-triggered logging: because this call blocks until the host is idle,
  // one busy stretch (however many rows it spans) yields exactly one park/resume
  // pair — so a long park is visible in the logs instead of looking like a wedge.
  let parked = false;
  for (;;) {
    if (!isCurrent()) return;
    let paused = false;
    try {
      paused = shouldPause();
    } catch {
      break; // never let a throwing gate brick the walk
    }
    if (!paused) break;
    if (!parked) {
      parked = true;
      reportBackfillInfo(
        "temporal re-chunk parked — deferring to live traffic",
      );
    }
    await waitForTemporalRetry(signal);
  }
  if (parked) reportBackfillInfo("temporal re-chunk resumed");
}

/** Reset durable scheduling progress so the next startup walks the corpus again. */
export function resetTemporalRechunkProgress(): void {
  withSavepoint("reset_temporal_rechunk", () => {
    setKV(TEMPORAL_RECHUNK_EPOCH_KEY, randomUUID());
    setKV(TEMPORAL_RECHUNK_DONE_KEY, "0");
    setKV(TEMPORAL_RECHUNK_CURSOR_KEY, "");
    setKV(TEMPORAL_RECHUNK_ATTEMPTS_KEY, "0");
    setKV(TEMPORAL_RECHUNK_INFLIGHT_KEY, "");
    setKV(TEMPORAL_RECHUNK_ROW_ATTEMPTS_KEY, "0");
    setKV(TEMPORAL_RECHUNK_SKIP_KEY, "");
    setKV(TEMPORAL_RECHUNK_PARK_NEXT_KEY, "0");
    setKV(TEMPORAL_RECHUNK_PARK_RETRY_KEY, "0");
    setKV(TEMPORAL_RECHUNK_PARK_MESSAGE_KEY, "");
    setKV(TEMPORAL_RECHUNK_MAX_ROWID_KEY, "0");
    db()
      .query("DELETE FROM kv_meta WHERE key LIKE ?")
      .run(`${TEMPORAL_RECHUNK_FAIR_CURSOR_PREFIX}%`);
    db()
      .query("DELETE FROM kv_meta WHERE key LIKE ?")
      .run(`${TEMPORAL_RECHUNK_FAIR_SCAN_PREFIX}%`);
    // Fair slots live on queued rows, so a reset cannot mint new slots while
    // pending work is still durable. Preserve queue-recovery mode until its
    // admission walk has completed, including across a config change.
  });
}

/**
 * Cumulative-progress line for the temporal re-chunk walk. `done`/`total` count embeddable (>=50 char)
 * messages across ALL runs, so the percentage keeps climbing over restarts — unlike the per-process
 * counters, which reset to zero on every boot. `thisRun` is what the current invocation scheduled.
 */
export function formatTemporalRechunkProgress(
  done: number,
  total: number,
  thisRun: number,
): string {
  const pct =
    total > 0 ? Math.min(100, Math.round((done / total) * 1000) / 10) : 100;
  return `temporal re-chunk: ${pct}% complete (${done}/${total} messages) · +${thisRun} scheduled this run`;
}

/** Durably schedule existing temporal messages for the multi-vector vec0 layout. */
export async function backfillTemporalEmbeddings(
  opts: { shouldPause?: () => boolean; signal?: AbortSignal } = {},
): Promise<number> {
  // There is one durable corpus cursor for the whole database. A request-bound
  // tenant must never drive that shared cursor or read another tenant's text.
  // The server-owned startup walk re-enters each source tenant on admission.
  if (currentTenantId() !== LOCAL_TENANT_ID) return 0;
  // Multi-vector chunking only exists in vec0 mode. Skip WITHOUT latching done
  // so a later cutover to vec0 still triggers the walk.
  //
  // 🔴 Ordering invariant: this vec0-mode guard MUST come BEFORE the done-flag
  // check below. Because the flag can therefore only ever be latched from inside
  // a vec0-mode run, a blob-mode run can never set it — which is what guarantees
  // the first walk after a blob->vec0 cutover is always armed and re-embeds the
  // rows that cutover skipped. (maybeCutoverToVec0 also explicitly re-arms the
  // walk on cutover as belt-and-suspenders.) Do not reorder these two lines.
  if (opts.signal?.aborted) return 0;
  const connection = db();
  const isActive = () => isCurrentDatabase(connection) && !opts.signal?.aborted;
  const snapshot = withSavepoint("start_temporal_rechunk", () => {
    const recovering = getKV(TEMPORAL_RECHUNK_QUEUE_RECOVERY_KEY) === "1";
    if (readStorageMode(connection) !== "vec0" && !recovering) return null;
    if (getKV(TEMPORAL_RECHUNK_DONE_KEY) === "1") return null;
    const cursor = getKV(TEMPORAL_RECHUNK_CURSOR_KEY) ?? "";
    const epoch = getKV(TEMPORAL_RECHUNK_EPOCH_KEY);
    let maxRowid = Number(getKV(TEMPORAL_RECHUNK_MAX_ROWID_KEY) ?? "0");
    if (!Number.isSafeInteger(maxRowid) || maxRowid <= 0) {
      maxRowid = (
        connection
          .query("SELECT COALESCE(MAX(rowid), 0) AS n FROM temporal_messages")
          .get() as { n: number }
      ).n;
      setKV(TEMPORAL_RECHUNK_MAX_ROWID_KEY, String(maxRowid));
    }
    return { cursor, epoch, maxRowid, recovering };
  });
  if (readStorageMode(connection) !== "vec0" || isVecAvailable()) {
    await retireOversizedTemporalVectors(connection, isActive);
  }
  if (!isActive()) return 0;
  if (!snapshot) return 0;
  if (getKV(TEMPORAL_RECHUNK_EPOCH_KEY) !== snapshot.epoch) return 0;
  let { cursor } = snapshot;
  const { maxRowid, epoch, recovering } = snapshot;
  // The lost queue may have held short/empty updates that remove stale vectors.
  // Re-admit every source row after queue loss; normal re-chunking still selects
  // only text with enough semantic content to produce a vector.
  const eligibleSql = recovering
    ? `length(CAST(content AS BLOB)) <= ${MAX_TEMPORAL_EMBEDDING_SOURCE_BYTES}`
    : TEMPORAL_RECHUNK_ELIGIBLE_SQL;
  // Identity must be checked first: getKV/db() would reopen storage after close.
  const isCurrent = () =>
    isActive() && getKV(TEMPORAL_RECHUNK_EPOCH_KEY) === epoch;
  let scheduled = 0;
  let lastFairProbeAt = -Infinity;
  // A legacy queue can already exceed the normal window. This bounded index
  // probe counts only active extra claims, not the source-backed retry parks.
  const fairSlotsFull = () =>
    connection
      .query(
        `SELECT 1 FROM temporal_embedding_queue INDEXED BY idx_temporal_embedding_queue_fair_ahead
         WHERE priority = 0 AND fair_ahead = 1 LIMIT 1 OFFSET ?`,
      )
      .get(TEMPORAL_RECHUNK_FAIR_EXTRA_SLOTS - 1) !== null;
  const fairClaimPending = () =>
    connection
      .query(
        `SELECT 1 FROM temporal_embedding_queue INDEXED BY idx_temporal_embedding_queue_fair_ahead
         WHERE priority = 0 AND fair_ahead = 1 LIMIT 1`,
      )
      .get() !== null;
  const promoteParked = (lastOwner: string): boolean => {
    if (fairSlotsFull()) return false;
    // A bounded page prevents a large failed owner's park from forcing a
    // full-table probe. Persist a keyset cursor so pages owned by full projects
    // cannot hide a healthy later owner indefinitely, including after restart.
    const recordedRetry = Number(getKV(TEMPORAL_RECHUNK_PARK_RETRY_KEY) ?? "0");
    const afterRetry =
      Number.isSafeInteger(recordedRetry) && recordedRetry >= 0
        ? recordedRetry
        : 0;
    const afterMessage = getKV(TEMPORAL_RECHUNK_PARK_MESSAGE_KEY) ?? "";
    const due = connection
      .query(
        `SELECT d.message_id, d.retry_at, t.project_id, p.tenant_id
            FROM temporal_embedding_parked d INDEXED BY idx_temporal_embedding_parked_retry
            JOIN temporal_messages t ON t.id = d.message_id
            JOIN projects p ON p.id = t.project_id
           WHERE d.retry_at <= ? AND t.rowid <= ?
             AND (d.retry_at > ? OR (d.retry_at = ? AND d.message_id > ?))
           ORDER BY d.retry_at, d.message_id LIMIT ?`,
      )
      .all(
        Date.now(),
        maxRowid,
        afterRetry,
        afterRetry,
        afterMessage,
        TEMPORAL_RECHUNK_FAIR_PROJECT_PAGE,
      ) as Array<{
      message_id: string;
      retry_at: number;
      project_id: string;
      tenant_id: string;
    }>;
    if (!due.length) {
      if (afterRetry || afterMessage) {
        setKV(TEMPORAL_RECHUNK_PARK_RETRY_KEY, "0");
        setKV(TEMPORAL_RECHUNK_PARK_MESSAGE_KEY, "");
      }
      return false;
    }
    // A due owner may have refilled its 512-row window while the retry was
    // parked. Rotate past it instead of either granting a 513th row or hiding
    // another due owner's work behind the first park.
    const candidates = [
      ...due.filter((row) => row.project_id !== lastOwner),
      ...due.filter((row) => row.project_id === lastOwner),
    ];
    for (const parked of candidates) {
      const promoted = withSavepoint(
        "promote_parked_temporal_embedding",
        () => {
          if (!isCurrent() || fairSlotsFull()) return false;
          const alreadyQueued =
            connection
              .query(
                "SELECT 1 FROM temporal_embedding_queue WHERE message_id = ?",
              )
              .get(parked.message_id) !== null;
          if (
            !alreadyQueued &&
            connection
              .query(
                `SELECT 1 FROM temporal_embedding_queue INDEXED BY idx_temporal_embedding_queue_owner
               WHERE priority = 0 AND project_id = ? LIMIT 1 OFFSET ?`,
              )
              .get(parked.project_id, TEMPORAL_RECHUNK_PENDING_WINDOW - 1) !==
              null
          )
            return false;
          const source = withTenant(
            parked.tenant_id,
            () =>
              connection
                .query(
                  `SELECT t.content FROM temporal_messages t
              JOIN projects p ON p.id = t.project_id
              WHERE t.id = ? AND t.project_id = ? AND p.tenant_id = ?
                   AND t.rowid <= ?
                   AND length(CAST(t.content AS BLOB)) <= ${MAX_TEMPORAL_EMBEDDING_SOURCE_BYTES}`,
                )
                .get(
                  parked.message_id,
                  parked.project_id,
                  parked.tenant_id,
                  maxRowid,
                ) as { content: string } | null,
          );
          if (!source)
            return withTenant(parked.tenant_id, () =>
              retireOversizedTemporalEmbedding(
                parked.message_id,
                parked.project_id,
              ),
            );
          const admitted = withTenant(parked.tenant_id, () =>
            enqueueTemporalEmbedding(
              parked.message_id,
              source.content,
              "backfill",
            ),
          );
          if (!admitted && !alreadyQueued) return false;
          if (!alreadyQueued) {
            connection
              .query(
                `UPDATE temporal_embedding_queue SET fair_ahead = 1
               WHERE message_id = ? AND project_id = ? AND priority = 0`,
              )
              .run(parked.message_id, parked.project_id);
            scheduled++;
          }
          connection
            .query("DELETE FROM temporal_embedding_parked WHERE message_id = ?")
            .run(parked.message_id);
          setKV(TEMPORAL_RECHUNK_SKIP_KEY, parked.project_id);
          return true;
        },
      );
      if (promoted) return true;
    }
    const last = due[due.length - 1];
    setKV(TEMPORAL_RECHUNK_PARK_RETRY_KEY, String(last.retry_at));
    setKV(TEMPORAL_RECHUNK_PARK_MESSAGE_KEY, last.message_id);
    return false;
  };
  const admitFairOwner = (): void => {
    const now = performance.now();
    if (now - lastFairProbeAt < TEMPORAL_RECHUNK_FAIR_PROBE_MS) return;
    lastFairProbeAt = now;
    if (fairSlotsFull()) return;
    const lastOwner = getKV(TEMPORAL_RECHUNK_SKIP_KEY) ?? "";
    if (getKV(TEMPORAL_RECHUNK_PARK_NEXT_KEY) === "1") {
      if (promoteParked(lastOwner)) {
        setKV(TEMPORAL_RECHUNK_PARK_NEXT_KEY, "0");
        setKV(TEMPORAL_RECHUNK_PARK_RETRY_KEY, "0");
        setKV(TEMPORAL_RECHUNK_PARK_MESSAGE_KEY, "");
        return;
      }
    }
    const nextPage = connection.query(
      "SELECT id, tenant_id FROM projects WHERE id > ? ORDER BY id LIMIT ?",
    );
    const projects = nextPage.all(
      lastOwner,
      TEMPORAL_RECHUNK_FAIR_PROJECT_PAGE,
    ) as Array<{ id: string; tenant_id: string }>;
    const page = projects.length
      ? projects
      : (nextPage.all("", TEMPORAL_RECHUNK_FAIR_PROJECT_PAGE) as Array<{
          id: string;
          tenant_id: string;
        }>);
    for (const project of page) {
      if (!isCurrent()) return;
      const fairKey = `${TEMPORAL_RECHUNK_FAIR_CURSOR_PREFIX}${project.id}`;
      const scanKey = `${TEMPORAL_RECHUNK_FAIR_SCAN_PREFIX}${project.id}`;
      const after = [cursor, getKV(fairKey) ?? "", getKV(scanKey) ?? ""].reduce(
        (latest, id) => (id > latest ? id : latest),
        "",
      );
      // Scan raw IDs, not an unbounded eligible suffix. Include post-snapshot
      // IDs in the short page, then reject them by rowid; filtering them in
      // SQL would still walk an unbounded suffix before LIMIT applies. Fetch
      // full text only for an admitted candidate.
      const candidates = connection
        .query(
          `SELECT id, rowid AS source_rowid, length(CAST(content AS BLOB)) AS bytes
           FROM temporal_messages INDEXED BY idx_temporal_project_message_id
             WHERE project_id = ? AND id > ?
             ORDER BY id LIMIT ?`,
        )
        .all(project.id, after, TEMPORAL_RECHUNK_FAIR_MESSAGE_PAGE) as Array<{
        id: string;
        source_rowid: number;
        bytes: number;
      }>;
      const candidate = candidates.find(
        ({ bytes, source_rowid }) =>
          source_rowid <= maxRowid &&
          bytes <= MAX_TEMPORAL_EMBEDDING_SOURCE_BYTES &&
          (recovering || bytes >= TEMPORAL_EMBEDDING_MIN_CONTENT_LENGTH),
      );
      if (!candidate) {
        const lastScanned = candidates.at(-1);
        if (lastScanned) {
          withSavepoint("scan_fair_temporal_rechunk", () => {
            if (!isCurrent()) return;
            const current = getKV(scanKey) ?? "";
            if (lastScanned.id > current) setKV(scanKey, lastScanned.id);
            setKV(TEMPORAL_RECHUNK_SKIP_KEY, project.id);
          });
          return;
        }
        continue;
      }
      const admitted = withSavepoint("admit_fair_temporal_rechunk", () => {
        if (!isCurrent()) return false;
        if (fairSlotsFull()) return false;
        // Count actual queued work for this owner, not a sampled owner from
        // the queue. One failed owner must not exclude a different owner, and
        // a mixed queue must never give the full owner a 513th row.
        if (
          connection
            .query(
              `SELECT 1 FROM temporal_embedding_queue INDEXED BY idx_temporal_embedding_queue_owner
               WHERE priority = 0 AND project_id = ?
               LIMIT 1 OFFSET ?`,
            )
            .get(project.id, TEMPORAL_RECHUNK_PENDING_WINDOW - 1) !== null
        )
          return false;
        const currentFairCursor = getKV(fairKey) ?? "";
        if (currentFairCursor >= candidate.id) return false;
        const current = withTenant(
          project.tenant_id,
          () =>
            connection
              .query(
                `SELECT t.content FROM temporal_messages t
               JOIN projects p ON p.id = t.project_id
               WHERE t.id = ? AND t.project_id = ? AND p.tenant_id = ? AND t.rowid <= ?
                   AND ${eligibleSql}`,
              )
              .get(candidate.id, project.id, project.tenant_id, maxRowid) as {
              content: string;
            } | null,
        );
        if (!current) return false;
        const newClaim =
          connection
            .query(
              "SELECT 1 FROM temporal_embedding_queue WHERE message_id = ?",
            )
            .get(candidate.id) === null;
        if (
          withTenant(project.tenant_id, () =>
            enqueueTemporalEmbedding(candidate.id, current.content, "backfill"),
          )
        ) {
          scheduled++;
        }
        if (newClaim) {
          connection
            .query(
              "UPDATE temporal_embedding_queue SET fair_ahead = 1 WHERE message_id = ? AND priority = 0",
            )
            .run(candidate.id);
        }
        setKV(fairKey, candidate.id);
        setKV(TEMPORAL_RECHUNK_SKIP_KEY, project.id);
        return true;
      });
      if (admitted) {
        setKV(TEMPORAL_RECHUNK_PARK_NEXT_KEY, "1");
        return;
      }
      // A full owner can be first on the project page. Advance the fair
      // rotation instead of permanently blocking a healthy owner behind it.
      if (isCurrent()) setKV(TEMPORAL_RECHUNK_SKIP_KEY, project.id);
    }
    if (page.length && isCurrent()) {
      setKV(TEMPORAL_RECHUNK_SKIP_KEY, page[page.length - 1].id);
    }
    if (promoteParked(lastOwner)) setKV(TEMPORAL_RECHUNK_PARK_NEXT_KEY, "0");
  };
  // Core owns the shared embed-pool signal; hosts only contribute their own
  // pause policy. This keeps recall-priority admission true for every host.
  const shouldPause = () => {
    if (!isActive() || recallEmbedsInFlight() > 0) return true;
    try {
      if (
        connection
          .query(
            "SELECT 1 FROM temporal_embedding_queue WHERE priority = 0 LIMIT 1 OFFSET ?",
          )
          .get(TEMPORAL_RECHUNK_PENDING_WINDOW - 1) !== null
      ) {
        // Provider failure can fill the historical window forever. Keep a
        // bounded path for another project's work while the primary cursor
        // remains parked on the failed owner.
        try {
          const hostPaused = (() => {
            try {
              return opts.shouldPause?.() === true;
            } catch {
              // A throwing host gate cannot brick the core-owned rescue path.
              return false;
            }
          })();
          if (!hostPaused) admitFairOwner();
        } catch {
          // An auxiliary fairness probe never authorizes unbounded admission.
        }
        return true;
      }
    } catch {
      // A failed capacity probe cannot authorize unlimited admission.
      return true;
    }
    // A throwing host gate remains best-effort, but it cannot bypass the
    // core-owned durable queue limit checked above.
    return opts.shouldPause?.() === true;
  };
  let scanned = 0;

  // Up-front backlog so a long walk is explainable from the logs. The corpus is
  // 100k+ rows and, under embed-pool contention, converges at single-digit
  // rows/min — without this line a multi-hour (or, across restarts, multi-day)
  // walk is completely invisible. Counts rows still to scan from the resume
  // cursor; runs once per process (the walk is one-shot per config).
  const backlog = (
    db()
      .query(
        `SELECT COUNT(*) AS n FROM temporal_messages
          WHERE id > ? AND rowid <= ? AND ${eligibleSql}`,
      )
      .get(cursor, maxRowid) as { n: number }
  ).n;
  // Denominator for cumulative progress: ALL embeddable messages, not just the
  // remaining backlog, so the heartbeat shows a percentage that keeps climbing
  // across restarts instead of the per-process tally that resets to zero on every
  // boot. `baseDone` is what prior runs already covered (rows at/below the resume
  // cursor); the walk's SELECT uses the same byte-length eligibility predicate,
  // so `scanned`
  // counts embeddable rows and `baseDone + scanned` reaches exactly `total` on a
  // clean pass (→ 100%). Gated on `backlog > 0`: when nothing remains the loop
  // latches done without iterating, so `total`/`baseDone` are never read — no
  // point paying for a second full-table COUNT on that path.
  let total = 0;
  let baseDone = 0;
  if (backlog > 0) {
    total = (
      db()
        .query(
          `SELECT COUNT(*) AS n FROM temporal_messages WHERE rowid <= ? AND ${eligibleSql}`,
        )
        .get(maxRowid) as { n: number }
    ).n;
    baseDone = Math.max(0, total - backlog);
    const basePct = total > 0 ? Math.round((baseDone / total) * 1000) / 10 : 0;
    reportBackfillInfo(
      `temporal re-chunk: ${backlog} messages to scan (${baseDone}/${total} already done, ${basePct}%)${cursor ? ", resuming" : ""}`,
    );
  }

  // Wall-clock heartbeat rather than a per-N-rows milestone: at the observed
  // throughput a 1000-row milestone can be hours away, so a time cadence keeps
  // the walk visible regardless of speed.
  const PROGRESS_INTERVAL_MS = 30_000;
  let lastProgressAt = Date.now();
  let sliceStarted = performance.now();

  for (;;) {
    if (!isCurrent()) return scheduled;
    // Keep the legacy walk aligned with scheduler eligibility.
    const rows = connection
      .query(
        `SELECT id FROM temporal_messages
          WHERE id > ? AND rowid <= ? AND ${eligibleSql}
          ORDER BY id ASC LIMIT ?`,
      )
      .all(cursor, maxRowid, TEMPORAL_RECHUNK_PAGE) as Array<{ id: string }>;

    if (!rows.length) {
      const parked = connection
        .query("SELECT 1 FROM temporal_embedding_parked LIMIT 1")
        .get();
      if (parked) {
        await awaitBackfillIdle(shouldPause, isCurrent, opts.signal);
        if (!isCurrent()) return scheduled;
        // The normal window may drain while the last source page is in flight.
        // Restore due retries before latching completion; otherwise a restart
        // would permanently hide source-backed parked work behind done=1.
        if (
          parked &&
          connection
            .query(
              "SELECT 1 FROM temporal_embedding_queue WHERE priority = 0 LIMIT 1 OFFSET ?",
            )
            .get(TEMPORAL_RECHUNK_PENDING_WINDOW - 1) === null
        )
          promoteParked("");
        await waitForTemporalRetry(opts.signal);
        continue;
      }
      const finished = withSavepoint("finish_temporal_rechunk", () => {
        if (!isCurrent()) return false;
        // Recheck under the completion write unit: a concurrent drain can
        // park a fair claim between the first probe and this latch.
        if (
          connection
            .query("SELECT 1 FROM temporal_embedding_parked LIMIT 1")
            .get() ||
          fairClaimPending()
        )
          return false;
        // Blob mode has no multi-vector completion latch. This one-time walk
        // only restores local queue metadata lost when the table disappeared.
        if (readStorageMode(connection) === "vec0")
          setKV(TEMPORAL_RECHUNK_DONE_KEY, "1");
        if (recovering) setKV(TEMPORAL_RECHUNK_QUEUE_RECOVERY_KEY, "0");
        setKV(TEMPORAL_RECHUNK_ATTEMPTS_KEY, "0");
        setKV(TEMPORAL_RECHUNK_INFLIGHT_KEY, "");
        setKV(TEMPORAL_RECHUNK_ROW_ATTEMPTS_KEY, "0");
        setKV(TEMPORAL_RECHUNK_SKIP_KEY, "");
        setKV(TEMPORAL_RECHUNK_PARK_NEXT_KEY, "0");
        connection
          .query("DELETE FROM kv_meta WHERE key LIKE ?")
          .run(`${TEMPORAL_RECHUNK_FAIR_CURSOR_PREFIX}%`);
        connection
          .query("DELETE FROM kv_meta WHERE key LIKE ?")
          .run(`${TEMPORAL_RECHUNK_FAIR_SCAN_PREFIX}%`);
        return true;
      });
      if (!finished) {
        // A fair claim can fail after the source cursor reaches EOF. Keep the
        // walk alive until it settles so a late park is not hidden by done=1.
        await waitForTemporalRetry(opts.signal);
        continue;
      }
      break;
    }

    for (const row of rows) {
      await awaitBackfillIdle(shouldPause, isCurrent, opts.signal);
      if (!isActive()) return scheduled;
      const admitted = withSavepoint("schedule_temporal_rechunk", () => {
        if (!isCurrent()) return false;
        const current = db()
          .query(
            `SELECT t.project_id, p.tenant_id
             FROM temporal_messages t JOIN projects p ON p.id = t.project_id
             WHERE t.id = ? AND t.rowid <= ?`,
          )
          .get(row.id, maxRowid) as {
          project_id: string;
          tenant_id: string;
        } | null;
        if (current) {
          // Fair-ahead work has already been admitted under this epoch. The
          // normal cursor catches up without re-enqueuing a completed vector.
          // Ownership may have moved while awaitBackfillIdle() held this page;
          // never use the earlier project's fair cursor or tenant for this row.
          const fairCursor = getKV(
            `${TEMPORAL_RECHUNK_FAIR_CURSOR_PREFIX}${current.project_id}`,
          );
          const enqueued = withTenant(current.tenant_id, () => {
            if (fairCursor && row.id <= fairCursor) return false;
            const source = db()
              .query(
                `SELECT t.content FROM temporal_messages t
                 JOIN projects p ON p.id = t.project_id
                  WHERE t.id = ? AND t.project_id = ? AND p.tenant_id = ? AND t.rowid <= ?
                    AND length(CAST(t.content AS BLOB)) <= ${MAX_TEMPORAL_EMBEDDING_SOURCE_BYTES}`,
              )
              .get(row.id, current.project_id, current.tenant_id, maxRowid) as {
              content: string;
            } | null;
            return source
              ? enqueueTemporalEmbedding(row.id, source.content, "backfill")
              : false;
          });
          if (enqueued) {
            // Existing vectors for unchanged content stay searchable until the
            // complete replacement is installed atomically by the drain.
            scheduled++;
          }
        }
        cursor = row.id;
        scanned++;
        setKV(TEMPORAL_RECHUNK_CURSOR_KEY, cursor);
        return true;
      });
      if (!admitted) return scheduled;

      if (Date.now() - lastProgressAt >= PROGRESS_INTERVAL_MS) {
        reportBackfillInfo(
          formatTemporalRechunkProgress(baseDone + scanned, total, scheduled),
        );
        lastProgressAt = Date.now();
      }

      // awaitBackfillIdle resolves immediately when the gate is clear. Awaiting
      // it only yields to microtasks, starving HTTP/timers for the entire walk.
      // Yield after SCANNED rows (including already-queued/deleted rows), with
      // every queue/vector/cursor savepoint committed before other work runs.
      if (
        scanned % TEMPORAL_RECHUNK_YIELD_ROWS === 0 ||
        performance.now() - sliceStarted >= TEMPORAL_RECHUNK_YIELD_MS
      ) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (!isCurrent()) return scheduled;
        sliceStarted = performance.now();
      }
    }
  }

  if (scheduled > 0) {
    reportBackfillInfo(
      formatTemporalRechunkProgress(baseDone + scanned, total, scheduled),
    );
  }
  return scheduled;
}
