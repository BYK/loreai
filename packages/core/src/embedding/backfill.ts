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
  invalidateTemporalEmbedding,
} from "../temporal-embedding-admission";
import { TEMPORAL_EMBEDDING_MIN_CONTENT_LENGTH } from "../embedding-units";

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
        log.info(
          `embedding config changed (${stored.value} → ${current}), cleared ${total} stale embeddings`,
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
      log.notice(
        `vec0 cutover skipped ${staleSkipped} stale-dimension embedding blob(s) (not ${dim}-dim / ${dim * 4} bytes); they will be re-embedded by the startup backfills`,
      );
    }
    log.info(`vec0 storage cutover complete (dim=${dim})`);
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
}

export async function runStartupBackfill(
  opts: BackfillOptions = {},
): Promise<BackfillStats> {
  if (!isAvailable()) {
    // Make the degraded state visible in the startup path — this early return
    // was previously silent, so a consumer who omitted the optional
    // local-embedding stack (#1026), or is on a remote provider without a key,
    // had no startup signal that backfill (and vector recall) is off. Gate on
    // `enabled` so a deliberate `search.embeddings.enabled: false` stays quiet.
    // `isAvailable()` already emits the local-broken FTS-only line once; this is
    // the startup-scoped, backfill-specific companion.
    if (config().search.embeddings.enabled !== false) {
      log.info(
        "startup embedding backfill skipped — embeddings unavailable " +
          "(recall will use FTS-only search)",
      );
    }
    const stats = emptyBackfillStats();
    // Durable temporal admission is provider-independent. Preserve recovery
    // progress even while vector recall is temporarily FTS-only.
    stats.temporalRechunked = await backfillTemporalEmbeddings({
      shouldPause: opts.shouldPause,
    });
    return stats;
  }

  // Handle an embedding-config change, then attempt the one-time blob→vec0
  // cutover (both no-ops in the steady state). Order matters: a config change
  // clears stale blobs BEFORE the cutover relocates the survivors, so the vec0
  // tables are never seeded with vectors from a since-changed model/dimension.
  checkConfigChange();
  maybeCutoverToVec0();

  const mode = readStorageMode(db());

  // A vec0-store DB on a runtime that cannot load sqlite-vec: the blob columns
  // are gone and the vec0 tables are unreadable. No backfill is possible — vector
  // recall degrades to empty (FTS still answers) and re-converges when the DB is
  // next opened on a capable runtime.
  if (resolveReadMode(mode, isVecAvailable()) === "degraded") {
    log.warn(
      "vec0 storage but sqlite-vec unavailable — skipping embedding backfill " +
        "(vector recall is FTS-only until reopened on a capable runtime)",
    );
    return emptyBackfillStats();
  }

  // Surface backlog up-front so a slow startup is self-explanatory in logs.
  // Counts use the same mode-aware predicates the backfill loops use, so the
  // two numbers always match what we're about to do. (In vec0 mode the blob
  // column is gone — "pending" means a base row absent from the vec0 index.)
  const pendingKnowledge = (
    db()
      .query(
        `SELECT COUNT(*) as n FROM knowledge_current WHERE ${missingEmbeddingSql("knowledge", mode)} AND confidence > 0.2`,
      )
      .get() as { n: number }
  ).n;
  const pendingDistillations = (
    db()
      .query(
        `SELECT COUNT(*) as n FROM distillations WHERE ${missingEmbeddingSql("distillations", mode)} AND archived = 0 AND observations != ''`,
      )
      .get() as { n: number }
  ).n;

  if (pendingKnowledge + pendingDistillations > 0) {
    log.info(
      `embedding backfill scheduled: ${pendingKnowledge} knowledge + ` +
        `${pendingDistillations} distillations pending — starting in ` +
        `${STARTUP_BACKFILL_DELAY_MS / 1000}s, batches yield between calls ` +
        `(host stays responsive)`,
    );
    await new Promise<void>((r) => setTimeout(r, STARTUP_BACKFILL_DELAY_MS));
  }

  const knowledgeEmbedded = await backfillEmbeddings();
  const distillationEmbedded = await backfillDistillationEmbeddings();
  const entityEmbedded = await backfillEntityEmbeddings();
  // Re-chunk pre-multi-vector temporal survivors into the vec0 layout. Resumable
  // + done-flagged, so this is the heavy walk only on the first vec0 run (and
  // again after a config change); a no-op in blob mode and once converged. Idle-
  // gated (opts.shouldPause) so it yields the shared embed pool to live traffic.
  const temporalConnection = db();
  const temporalRechunked = await backfillTemporalEmbeddings({
    shouldPause: opts.shouldPause,
  });
  // The walk may stop after shutdown. Do not reopen storage for GC or coverage
  // stats, or use a successor connection that belongs to a different startup.
  if (!isCurrentDatabase(temporalConnection)) {
    return {
      ...emptyBackfillStats(),
      pendingKnowledge,
      pendingDistillations,
      knowledgeEmbedded,
      distillationEmbedded,
      entityEmbedded,
      temporalRechunked,
    };
  }

  // Orphan discovery belongs to the host's idle read-worker maintenance.
  // Never scan the full vector corpus on the startup writer (#1681).

  // Coverage stats — always log to stderr so the problem is visible.
  const kTotal = (
    db()
      .query(
        "SELECT COUNT(*) as n FROM knowledge_current WHERE confidence > 0.2",
      )
      .get() as { n: number }
  ).n;
  const kWithEmb = (
    db()
      .query(
        `SELECT COUNT(*) as n FROM knowledge_current WHERE ${hasEmbeddingSql("knowledge", mode)} AND confidence > 0.2`,
      )
      .get() as { n: number }
  ).n;
  const dTotal = (
    db()
      .query(
        "SELECT COUNT(*) as n FROM distillations WHERE archived = 0 AND observations != ''",
      )
      .get() as { n: number }
  ).n;
  const dWithEmb = (
    db()
      .query(
        // Mirror dTotal's predicate (incl. observations != '') so the coverage
        // numerator is always a subset of the denominator (never reads "11/10").
        `SELECT COUNT(*) as n FROM distillations WHERE ${hasEmbeddingSql("distillations", mode)} AND archived = 0 AND observations != ''`,
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
    knowledgeEmbedded > 0 ||
    distillationEmbedded > 0 ||
    entityEmbedded > 0 ||
    temporalRechunked > 0
  ) {
    parts.push(
      `backfilled ${knowledgeEmbedded} knowledge + ${distillationEmbedded} distillations + ${entityEmbedded} entities + ${temporalRechunked} temporal re-chunked`,
    );
  }
  parts.push(
    `coverage: knowledge ${kWithEmb}/${kTotal}, distillations ${dWithEmb}/${dTotal}`,
  );
  log.info(`embedding startup: ${parts.join("; ")}`);

  return {
    pendingKnowledge,
    pendingDistillations,
    knowledgeEmbedded,
    distillationEmbedded,
    entityEmbedded,
    knowledgeTotal: kTotal,
    knowledgeWithEmbedding: kWithEmb,
    distillationTotal: dTotal,
    distillationWithEmbedding: dWithEmb,
    temporalRechunked,
  };
}

interface BackfillItem {
  id: string;
  text: string;
}

async function embedBackfill(
  items: BackfillItem[],
  table: "knowledge" | "distillations" | "entities",
  label: string,
  completeLabel: string,
  guard?: ReturnType<typeof createEmbeddingAbortGuard>,
  progressEvery?: number,
): Promise<number> {
  let embedded = 0;
  let nextProgress = progressEvery ?? Infinity;

  for (let i = 0; i < items.length;) {
    if (guard) throwIfEmbeddingAborted(guard);
    const batch = nextEmbeddingBatch(items, i);
    i += batch.length;

    try {
      const work = embed(
        batch.map(({ text }) => text),
        "document",
      );
      const vectors = guard
        ? await awaitEmbeddingOperation(work, guard)
        : await work;
      if (guard) throwIfEmbeddingAborted(guard);

      for (let j = 0; j < batch.length; j++) {
        storeEmbedding(db(), table, batch[j].id, vectors[j]);
        embedded++;
      }
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
        log.info(`${label} backfill stopped: ${reason}`);
        break;
      }
      log.error(
        `${label} backfill batch failed (${batch.length} items):`,
        error,
      );
    }

    if (embedded >= nextProgress) {
      log.info(`embedding ${completeLabel}: ${embedded}/${items.length}…`);
      nextProgress = embedded + (progressEvery ?? Infinity);
    }
  }

  if (embedded > 0) log.info(`embedded ${embedded} ${completeLabel}`);
  return embedded;
}

export async function backfillEmbeddings(
  options: EmbeddingOperationOptions = {},
): Promise<number> {
  const guard = createEmbeddingAbortGuard("knowledge-backfill", options);
  throwIfEmbeddingAborted(guard);
  checkConfigChange();
  throwIfEmbeddingAborted(guard);
  if (!getProvider()) return 0;

  const mode = readStorageMode(db());
  const rows = db()
    .query(
      `SELECT id, title, content FROM knowledge_current WHERE ${missingEmbeddingSql("knowledge", mode)} AND confidence > 0.2`,
    )
    .all() as Array<{ id: string; title: string; content: string }>;

  throwIfEmbeddingAborted(guard);
  return embedBackfill(
    rows.map(({ id, title, content }) => ({
      id,
      text: `${title}\n${content}`,
    })),
    "knowledge",
    "embedding",
    "knowledge entries",
    guard,
  );
}

export async function backfillDistillationEmbeddings(): Promise<number> {
  if (!getProvider()) return 0;
  const mode = readStorageMode(db());
  const rows = db()
    .query(
      `SELECT id, observations FROM distillations WHERE ${missingEmbeddingSql("distillations", mode)} AND archived = 0 AND observations != ''`,
    )
    .all() as Array<{ id: string; observations: string }>;

  return embedBackfill(
    rows.map(({ id, observations }) => ({ id, text: observations })),
    "distillations",
    "distillation embedding",
    "distillations",
    undefined,
    256,
  );
}

export async function backfillEntityEmbeddings(): Promise<number> {
  if (!getProvider()) return 0;
  const mode = readStorageMode(db());
  const rows = db()
    .query(
      `SELECT e.id AS id, e.canonical_name AS canonical_name,
              (SELECT GROUP_CONCAT(da.alias_value, ' ')
               FROM (SELECT DISTINCT alias_value FROM entity_aliases WHERE entity_id = e.id) da
              ) AS aliases
       FROM entities e
       WHERE ${missingEmbeddingSql("entities", mode, "e")}`,
    )
    .all() as Array<{
    id: string;
    canonical_name: string;
    aliases: string | null;
  }>;

  return embedBackfill(
    rows.map(({ id, canonical_name, aliases }) => ({
      id,
      text: `${canonical_name} ${aliases ?? ""}`.trim(),
    })),
    "entities",
    "entity embedding",
    "entities",
  );
}
const TEMPORAL_RECHUNK_CURSOR_KEY = "lore:temporal_rechunk.cursor";
const TEMPORAL_RECHUNK_DONE_KEY = "lore:temporal_rechunk.done";
const TEMPORAL_RECHUNK_PAGE = 256;
const TEMPORAL_RECHUNK_YIELD_ROWS = 32;
const TEMPORAL_RECHUNK_YIELD_MS = 8;
const TEMPORAL_RECHUNK_ELIGIBLE_SQL = `length(CAST(content AS BLOB)) >= ${TEMPORAL_EMBEDDING_MIN_CONTENT_LENGTH}`;
const TEMPORAL_RECHUNK_ATTEMPTS_KEY = "lore:temporal_rechunk.attempts";
const TEMPORAL_RECHUNK_INFLIGHT_KEY = "lore:temporal_rechunk.inflight";
const TEMPORAL_RECHUNK_ROW_ATTEMPTS_KEY = "lore:temporal_rechunk.row_attempts";
const TEMPORAL_RECHUNK_SKIP_KEY = "lore:temporal_rechunk.skip";
const TEMPORAL_RECHUNK_MAX_ROWID_KEY = "lore:temporal_rechunk.max_rowid";
/** Fence active walks across config resets, including resets by other processes. */
const TEMPORAL_RECHUNK_EPOCH_KEY = "lore:temporal_rechunk.epoch";
const TEMPORAL_RECHUNK_PAUSE_POLL_MS = 250;

async function awaitBackfillIdle(
  shouldPause: (() => boolean) | undefined,
  isCurrent: () => boolean,
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
      log.info("temporal re-chunk parked — deferring to live traffic");
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, TEMPORAL_RECHUNK_PAUSE_POLL_MS);
      // Don't let a parked walk hold the process open on its own; the host's
      // server keeps it alive, and if it doesn't, resuming next start is fine.
      (t as { unref?: () => void }).unref?.();
    });
  }
  if (parked) log.info("temporal re-chunk resumed");
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
    setKV(TEMPORAL_RECHUNK_MAX_ROWID_KEY, "0");
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
  opts: { shouldPause?: () => boolean } = {},
): Promise<number> {
  // Multi-vector chunking only exists in vec0 mode. Skip WITHOUT latching done
  // so a later cutover to vec0 still triggers the walk.
  //
  // 🔴 Ordering invariant: this vec0-mode guard MUST come BEFORE the done-flag
  // check below. Because the flag can therefore only ever be latched from inside
  // a vec0-mode run, a blob-mode run can never set it — which is what guarantees
  // the first walk after a blob->vec0 cutover is always armed and re-embeds the
  // rows that cutover skipped. (maybeCutoverToVec0 also explicitly re-arms the
  // walk on cutover as belt-and-suspenders.) Do not reorder these two lines.
  const connection = db();
  const snapshot = withSavepoint("start_temporal_rechunk", () => {
    if (readStorageMode(connection) !== "vec0") return null;
    if (getKV(TEMPORAL_RECHUNK_DONE_KEY) === "1") return null;
    const cursor = getKV(TEMPORAL_RECHUNK_CURSOR_KEY) ?? "";
    const epoch = getKV(TEMPORAL_RECHUNK_EPOCH_KEY);
    let maxRowid = Number(getKV(TEMPORAL_RECHUNK_MAX_ROWID_KEY) ?? "0");
    if (!Number.isSafeInteger(maxRowid) || maxRowid <= 0) {
      maxRowid = (
        connection
          .query(
            `SELECT COALESCE(MAX(rowid), 0) AS n FROM temporal_messages WHERE ${TEMPORAL_RECHUNK_ELIGIBLE_SQL}`,
          )
          .get() as { n: number }
      ).n;
      setKV(TEMPORAL_RECHUNK_MAX_ROWID_KEY, String(maxRowid));
    }
    return { cursor, epoch, maxRowid };
  });
  if (!snapshot) return 0;
  let { cursor } = snapshot;
  const { maxRowid, epoch } = snapshot;
  // Identity must be checked first: getKV/db() would reopen storage after close.
  const isCurrent = () =>
    isCurrentDatabase(connection) &&
    getKV(TEMPORAL_RECHUNK_EPOCH_KEY) === epoch;
  // Core owns the shared embed-pool signal; hosts only contribute their own
  // pause policy. This keeps recall-priority admission true for every host.
  const shouldPause = () =>
    recallEmbedsInFlight() > 0 || opts.shouldPause?.() === true;
  let scheduled = 0;
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
         WHERE id > ? AND rowid <= ? AND ${TEMPORAL_RECHUNK_ELIGIBLE_SQL}`,
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
          `SELECT COUNT(*) AS n FROM temporal_messages WHERE rowid <= ? AND ${TEMPORAL_RECHUNK_ELIGIBLE_SQL}`,
        )
        .get(maxRowid) as { n: number }
    ).n;
    baseDone = Math.max(0, total - backlog);
    const basePct = total > 0 ? Math.round((baseDone / total) * 1000) / 10 : 0;
    log.info(
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
    const rows = db()
      .query(
        `SELECT id FROM temporal_messages
         WHERE id > ? AND rowid <= ? AND ${TEMPORAL_RECHUNK_ELIGIBLE_SQL}
         ORDER BY id ASC LIMIT ?`,
      )
      .all(cursor, maxRowid, TEMPORAL_RECHUNK_PAGE) as Array<{ id: string }>;

    if (!rows.length) {
      withSavepoint("finish_temporal_rechunk", () => {
        if (!isCurrent()) return;
        setKV(TEMPORAL_RECHUNK_DONE_KEY, "1");
        setKV(TEMPORAL_RECHUNK_ATTEMPTS_KEY, "0");
        setKV(TEMPORAL_RECHUNK_INFLIGHT_KEY, "");
        setKV(TEMPORAL_RECHUNK_ROW_ATTEMPTS_KEY, "0");
        setKV(TEMPORAL_RECHUNK_SKIP_KEY, "");
      });
      break;
    }

    for (const row of rows) {
      await awaitBackfillIdle(shouldPause, isCurrent);
      if (!isCurrentDatabase(connection)) return scheduled;
      const admitted = withSavepoint("schedule_temporal_rechunk", () => {
        if (!isCurrent()) return false;
        const current = db()
          .query(
            "SELECT content FROM temporal_messages WHERE id = ? AND rowid <= ?",
          )
          .get(row.id, maxRowid) as { content: string } | null;
        if (current) {
          const enqueued = enqueueTemporalEmbedding(row.id, current.content);
          if (enqueued) {
            invalidateTemporalEmbedding(row.id);
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
        log.info(
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
    log.info(
      formatTemporalRechunkProgress(baseDone + scanned, total, scheduled),
    );
  }
  return scheduled;
}
