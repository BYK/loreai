/**
 * Local primitives for the logical sync engine (Basic tier — knowledge + the
 * entity graph). Pure DB-side helpers with no Supabase/network coupling: the
 * gateway sync engine composes these with an HTTP client.
 *
 * Design (see plan §3):
 *  - A monotonic `sync_outbox` (populated by triggers, gated by `sync.enabled`)
 *    is the push queue; `seq` is the high-watermark cursor.
 *  - `content_hash` + `revision` are computed HERE in JS (SQLite has no hash
 *    function) — borrowed from `.lore.md`'s UUID-identity + content-hash model —
 *    and tracked per row in `sync_state`. The hash makes sync idempotent (skip
 *    byte-identical rows) and discriminates a real concurrent conflict from a
 *    no-op.
 *  - Applying pulled remote rows is wrapped in `withApplying()`, which sets the
 *    `sync.applying` flag so the outbox triggers don't re-enqueue them
 *    (prevents push<->pull echo).
 */
import { createHash } from "node:crypto";
import {
  db,
  deleteTeamConfig,
  getTeamConfig,
  setTeamConfig,
  withSyncApplying,
} from "./db";

/**
 * Run `fn` with this connection's sync capture suppressed (re-entrant,
 * connection-scoped). Re-exported from `db` so the apply helpers and the engine
 * share one mechanism.
 */
export const withApplying = withSyncApplying;

export type SyncTier = "basic" | "pro" | "max";

export interface SyncTableMeta {
  table: string;
  /** Primary-key columns. One for id-keyed tables; two for the join table. */
  idColumns: string[];
  /** FTS5 tables to rebuild locally after applying pulled rows. */
  ftsTables: string[];
  /**
   * Whether the REMOTE table carries `content_hash`/`revision` columns. The
   * join table (knowledge_entity_refs) does not — sending those columns to it
   * is a PostgREST schema error (PGRST204). Defaults to true.
   */
  versioned?: boolean;
  /**
   * The data columns that exist on the REMOTE table (supabase/migrations/0002),
   * which is a curated subset of the local schema. Push/hash use ONLY these —
   * sending a local-only column (e.g. knowledge.promoted_at, worker_model_id)
   * is a PostgREST PGRST204 and would break sync for the whole table. Sync-
   * management columns (owner_user_id/content_hash/revision/is_deleted) are
   * added separately and are NOT listed here.
   */
  syncColumns: string[];
}

/** ASCII Unit Separator — joins composite row ids (mirrors the SQL `char(31)`). */
const ROW_SEP = "\x1f";

/**
 * Volatile / local-only columns never sent over the wire: BLOB `embedding`
 * (re-derived on restore) and `last_accessed_at` (per-machine access tracking).
 */
const PAYLOAD_EXCLUDE = new Set(["embedding", "last_accessed_at"]);
/**
 * Columns excluded from the content hash: the non-synced ones above plus
 * `updated_at` (a fresh timestamp is not a semantic change). Intentionally a
 * denylist of volatile/local columns; if cross-tenant dedup is ever needed,
 * switch to an explicit per-table semantic allowlist.
 */
const HASH_EXCLUDE = new Set(["embedding", "last_accessed_at", "updated_at"]);

export const SYNCED_TABLES: Record<SyncTier, SyncTableMeta[]> = {
  basic: [
    {
      table: "knowledge",
      idColumns: ["id"],
      ftsTables: ["knowledge_fts"],
      syncColumns: [
        "id",
        "project_id",
        "category",
        "title",
        "content",
        "source_session",
        "cross_project",
        "confidence",
        "metadata",
        "created_by",
        "updated_by",
        "sensitivity",
        "promotion_status",
        "created_at",
        "updated_at",
      ],
    },
    {
      table: "entities",
      idColumns: ["id"],
      ftsTables: ["entities_fts"],
      syncColumns: [
        "id",
        "project_id",
        "entity_type",
        "canonical_name",
        "metadata",
        "cross_project",
        "created_at",
        "updated_at",
      ],
    },
    {
      table: "entity_aliases",
      idColumns: ["id"],
      ftsTables: ["entity_aliases_fts"],
      syncColumns: [
        "id",
        "entity_id",
        "alias_type",
        "alias_value",
        "source",
        "created_at",
      ],
    },
    {
      table: "entity_relations",
      idColumns: ["id"],
      ftsTables: [],
      syncColumns: [
        "id",
        "entity_a",
        "entity_b",
        "relation",
        "metadata",
        "source",
        "created_at",
        "updated_at",
      ],
    },
    {
      table: "knowledge_entity_refs",
      idColumns: ["knowledge_id", "entity_id"],
      ftsTables: [],
      versioned: false, // join table has no content_hash/revision columns
      syncColumns: ["knowledge_id", "entity_id"],
    },
  ],
  pro: [],
  max: [],
};

const META_BY_TABLE = new Map<string, SyncTableMeta>();
for (const t of SYNCED_TABLES.basic) META_BY_TABLE.set(t.table, t);

/** The synced table set for a tier (only `basic` is populated today). */
export function syncedTables(tier: SyncTier = "basic"): SyncTableMeta[] {
  return SYNCED_TABLES[tier];
}

function meta(table: string): SyncTableMeta {
  const m = META_BY_TABLE.get(table);
  if (!m) throw new Error(`not a synced table: ${table}`);
  return m;
}

/**
 * The synced data columns of a table: the registry allowlist (matching the
 * remote 0002 schema) intersected with the columns that actually exist locally.
 * Push, hashing, and apply all use this — never the raw local column set, which
 * has local-only columns the remote rejects (PGRST204).
 */
export function syncedColumns(table: string): string[] {
  const m = meta(table);
  const local = new Set(
    (
      db().query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    ).map((r) => r.name),
  );
  return m.syncColumns.filter((c) => local.has(c));
}

/** Pick only the synced data columns from a row (for the push payload). */
export function pickSyncColumns(
  table: string,
  row: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of syncedColumns(table)) {
    if (c in row) out[c] = row[c];
  }
  return out;
}

/** Local column names of a synced table (validated against the registry). */
function columns(table: string): string[] {
  return syncedColumns(table);
}

// ---------------------------------------------------------------------------
// Row identity + content hashing
// ---------------------------------------------------------------------------

/** Build the outbox/sync_state `row_id` for a row (composite for the join table). */
export function rowIdOf(table: string, row: Record<string, unknown>): string {
  return meta(table)
    .idColumns.map((c) => String(row[c]))
    .join(ROW_SEP);
}

function splitRowId(rowId: string): string[] {
  return rowId.split(ROW_SEP);
}

function serializeValue(v: unknown): string {
  if (v === null || v === undefined) return "\x00";
  if (v instanceof Uint8Array) return Buffer.from(v).toString("base64");
  return String(v);
}

/**
 * Stable 64-bit content hash of a row's semantic columns (sorted for
 * determinism; `updated_at`/`embedding` excluded). Two rows with identical
 * meaningful content hash equal regardless of column order or timestamp churn.
 */
export function contentHash(
  table: string,
  row: Record<string, unknown>,
): string {
  const cols = columns(table)
    .filter((c) => !HASH_EXCLUDE.has(c))
    .sort();
  const canonical = cols
    .map((c) => `${c}=${serializeValue(row[c])}`)
    .join(ROW_SEP);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/** Read a synced row by its `row_id` (payload columns only). Null if absent. */
export function getRowById(
  table: string,
  rowId: string,
): Record<string, unknown> | null {
  const m = meta(table);
  const where = m.idColumns.map((c) => `${c} = ?`).join(" AND ");
  const cols = columns(table).filter((c) => !PAYLOAD_EXCLUDE.has(c));
  const row = db()
    .query(`SELECT ${cols.join(", ")} FROM ${table} WHERE ${where}`)
    .get(...splitRowId(rowId)) as Record<string, unknown> | undefined;
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Outbox (push queue)
// ---------------------------------------------------------------------------

export interface OutboxEntry {
  seq: number;
  table_name: string;
  row_id: string;
  op: "upsert" | "delete";
  changed_at: number;
}

/**
 * Read outbox entries with `seq > sinceSeq`, in seq order. When `table` is
 * given, filters in SQL (uses idx_sync_outbox_table_seq) so a table is never
 * starved by a window full of OTHER tables' entries.
 */
export function readOutbox(
  sinceSeq: number,
  limit = 500,
  table?: string,
): OutboxEntry[] {
  if (table) {
    return db()
      .query(
        `SELECT seq, table_name, row_id, op, changed_at
           FROM sync_outbox WHERE table_name = ? AND seq > ?
           ORDER BY seq LIMIT ?`,
      )
      .all(table, sinceSeq, limit) as unknown as OutboxEntry[];
  }
  return db()
    .query(
      `SELECT seq, table_name, row_id, op, changed_at
         FROM sync_outbox WHERE seq > ? ORDER BY seq LIMIT ?`,
    )
    .all(sinceSeq, limit) as unknown as OutboxEntry[];
}

/**
 * Prune fully-pushed outbox entries (seq <= the minimum push cursor across all
 * synced tables). The outbox is otherwise append-only and would grow forever.
 * `minCursor` is the lowest per-table push cursor the engine has persisted.
 */
export function pruneOutbox(minCursor: number): number {
  if (minCursor <= 0) return 0;
  return db().query(`DELETE FROM sync_outbox WHERE seq <= ?`).run(minCursor)
    .changes;
}

/**
 * True when the outbox holds an entry for this row with seq > `sinceSeq` (i.e. an
 * unpushed local change). Indexed existence check via idx_sync_outbox_table_row —
 * O(log n), not a full scan.
 */
export function hasPendingChange(
  table: string,
  rowId: string,
  sinceSeq: number,
): boolean {
  const row = db()
    .query(
      `SELECT 1 FROM sync_outbox
        WHERE table_name = ? AND row_id = ? AND seq > ? LIMIT 1`,
    )
    .get(table, rowId, sinceSeq);
  return row != null;
}

/** True when the outbox has at least one entry for `table`. */
export function hasOutboxEntries(table: string): boolean {
  return (
    db()
      .query(`SELECT 1 FROM sync_outbox WHERE table_name = ? LIMIT 1`)
      .get(table) != null
  );
}

/** Highest outbox `seq` currently present (0 when empty). */
export function maxOutboxSeq(): number {
  return (
    db().query(`SELECT COALESCE(MAX(seq), 0) AS m FROM sync_outbox`).get() as {
      m: number;
    }
  ).m;
}

/** Build the SQL expression for a table's row_id, qualified by alias `t`. */
function rowIdExpr(m: SyncTableMeta): string {
  return m.idColumns.length === 1
    ? `t.${m.idColumns[0]}`
    : m.idColumns.map((c) => `t.${c}`).join(" || char(31) || ");
}

/**
 * Enqueue an `upsert` for every live row of the synced tables. Idempotent — a
 * row that already has a pending outbox entry is skipped, so repeated calls
 * (e.g. re-enable) don't pile up duplicates. The push path further skips rows
 * whose `content_hash` is unchanged, so a redundant upsert costs nothing.
 */
export function seedOutbox(tier: SyncTier = "basic"): void {
  const now = Date.now();
  for (const m of syncedTables(tier)) {
    const idExpr = rowIdExpr(m);
    db()
      .query(
        `INSERT INTO sync_outbox (table_name, row_id, op, changed_at)
         SELECT ?, ${idExpr}, 'upsert', ? FROM ${m.table} t
         WHERE NOT EXISTS (
           SELECT 1 FROM sync_outbox o WHERE o.table_name = ? AND o.row_id = ${idExpr}
         )`,
      )
      .run(m.table, now, m.table);
  }
}

/**
 * Re-enqueue the full local delta for a tier — used on enable AND re-enable:
 *  - upserts for every live row (idempotent seed; push skips unchanged ones), and
 *  - `delete` tombstones for rows present in `sync_state` but no longer live
 *    (deleted while sync was OFF, which the capture triggers couldn't see).
 * This is why enable does NOT just seed once: it reconciles, so changes made
 * while sync was disabled are not silently dropped from the push queue.
 */
export function reconcile(tier: SyncTier = "basic"): void {
  const now = Date.now();
  seedOutbox(tier);
  for (const m of syncedTables(tier)) {
    const idExpr = rowIdExpr(m);
    db()
      .query(
        `INSERT INTO sync_outbox (table_name, row_id, op, changed_at)
         SELECT s.table_name, s.row_id, 'delete', ?
           FROM sync_state s
          WHERE s.table_name = ?
            AND NOT EXISTS (SELECT 1 FROM ${m.table} t WHERE ${idExpr} = s.row_id)
            AND NOT EXISTS (
              SELECT 1 FROM sync_outbox o
               WHERE o.table_name = s.table_name AND o.row_id = s.row_id
            )`,
      )
      .run(now, m.table);
  }
}

// ---------------------------------------------------------------------------
// Per-row sync state
// ---------------------------------------------------------------------------

export interface SyncRowState {
  content_hash: string | null;
  revision: number;
  remote_updated_at: string | null;
}

export function getSyncState(
  table: string,
  rowId: string,
): SyncRowState | null {
  meta(table);
  const row = db()
    .query(
      `SELECT content_hash, revision, remote_updated_at
         FROM sync_state WHERE table_name = ? AND row_id = ?`,
    )
    .get(table, rowId) as unknown as SyncRowState | undefined;
  return row ?? null;
}

export function setSyncState(
  table: string,
  rowId: string,
  state: SyncRowState,
): void {
  meta(table);
  db()
    .query(
      `INSERT INTO sync_state (table_name, row_id, content_hash, revision, remote_updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(table_name, row_id) DO UPDATE SET
         content_hash = excluded.content_hash,
         revision = excluded.revision,
         remote_updated_at = excluded.remote_updated_at`,
    )
    .run(
      table,
      rowId,
      state.content_hash,
      state.revision,
      state.remote_updated_at,
    );
}

export function clearSyncState(table: string, rowId: string): void {
  meta(table);
  db()
    .query(`DELETE FROM sync_state WHERE table_name = ? AND row_id = ?`)
    .run(table, rowId);
}

// ---------------------------------------------------------------------------
// Applying pulled remote rows (suppress outbox capture)
// ---------------------------------------------------------------------------

/**
 * Upsert a pulled remote row into the local table (under apply-suppression).
 *
 * Uses `INSERT … ON CONFLICT(<pk>) DO UPDATE` (NOT `INSERT OR REPLACE`) so the
 * existing row is updated IN PLACE — the rowid stays stable, which keeps the
 * external-content FTS5 indexes (`content_rowid=rowid`) consistent (a delete+
 * insert would churn rowids and leave stale FTS postings). A secondary UNIQUE
 * collision on a DIFFERENT id (e.g. entity_aliases(alias_type, alias_value))
 * raises a constraint error rather than silently deleting the other row — the
 * engine catches it and records a conflict.
 */
export function applyRemoteUpsert(
  table: string,
  row: Record<string, unknown>,
): void {
  const m = meta(table);
  const cols = columns(table).filter(
    (c) => !PAYLOAD_EXCLUDE.has(c) && c in row,
  );
  const placeholders = cols.map(() => "?").join(", ");
  const conflict = m.idColumns.join(", ");
  const nonPk = cols.filter((c) => !m.idColumns.includes(c));
  const onConflict =
    nonPk.length > 0
      ? `DO UPDATE SET ${nonPk.map((c) => `${c}=excluded.${c}`).join(", ")}`
      : "DO NOTHING";
  const sql = `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders}) ON CONFLICT(${conflict}) ${onConflict}`;
  withApplying(() =>
    db()
      .query(sql)
      .run(...cols.map((c) => row[c] as never)),
  );
}

/** Delete a pulled-as-removed row locally (under apply-suppression). */
export function applyRemoteDelete(table: string, rowId: string): void {
  const m = meta(table);
  const where = m.idColumns.map((c) => `${c} = ?`).join(" AND ");
  withApplying(() =>
    db()
      .query(`DELETE FROM ${table} WHERE ${where}`)
      .run(...splitRowId(rowId)),
  );
}

/** Rebuild an external-content FTS5 index after a batch of pulled changes. */
export function rebuildFts(ftsTable: string): void {
  db().exec(`INSERT INTO ${ftsTable}(${ftsTable}) VALUES('rebuild')`);
}

// ---------------------------------------------------------------------------
// Conflict classification
// ---------------------------------------------------------------------------

export type RemoteClass = "skip" | "apply" | "conflict";

/**
 * Classify a remote row against local state (see plan §3):
 *  - `skip`     — remote content equals the local row (nothing to do).
 *  - `apply`    — local is unchanged since our last sync (fast-forward).
 *  - `conflict` — local also diverged since our last sync; the engine resolves
 *    by last-writer-to-remote-wins and logs to `sync_conflicts`.
 *
 * `remoteHash` is the remote row's `content_hash` (null for a tombstone/delete).
 *
 * INVARIANT: `syncOnce()` pushes local changes BEFORE pulling, so by the time a
 * remote row is classified our own pending edits/deletes are already on the
 * remote. The engine still passes `pendingLocalChange` when its outbox cursor
 * shows an unpushed change for this row (e.g. a local delete that hasn't been
 * pushed) — in that case we never fast-forward over it, which prevents a
 * concurrent remote upsert from silently resurrecting a locally-deleted row.
 */
export function classifyRemoteRow(
  table: string,
  rowId: string,
  remoteHash: string | null,
  opts: { pendingLocalChange?: boolean } = {},
): RemoteClass {
  const local = getRowById(table, rowId);
  const localHash = local ? contentHash(table, local) : null;
  if (remoteHash !== null && localHash === remoteHash) return "skip";

  // Unpushed local intent (edit or delete) — do not fast-forward over it.
  if (opts.pendingLocalChange) return "conflict";

  const syncedHash = getSyncState(table, rowId)?.content_hash ?? null;
  // Local matches what we last synced → no unpushed local change → fast-forward.
  if (localHash === syncedHash) return "apply";
  // Otherwise local also moved since last sync → genuine concurrent conflict.
  return "conflict";
}

/**
 * Record a resolved conflict. `localContent` is the discarded local row (we
 * resolve last-writer-to-remote-wins), serialized so the lost edit is
 * recoverable rather than silently destroyed.
 */
export function recordConflict(
  table: string,
  rowId: string,
  resolution: string,
  localContent?: Record<string, unknown> | null,
): void {
  meta(table);
  db()
    .query(
      `INSERT INTO sync_conflicts (table_name, row_id, detected_at, resolution, local_content)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      table,
      rowId,
      Date.now(),
      resolution,
      localContent ? JSON.stringify(localContent) : null,
    );
}

// ---------------------------------------------------------------------------
// Enable / disable
// ---------------------------------------------------------------------------

const ENABLED_KEY = "sync.enabled";

/** True when local change-capture is active. */
export function isSyncEnabled(): boolean {
  return getTeamConfig(ENABLED_KEY) === "1";
}

/**
 * Enable change-capture and reconcile the outbox against current state, so both
 * first-enable (uploads pre-existing rows) and re-enable (catches edits/deletes
 * made while sync was OFF) are captured. Idempotent — `reconcile` skips rows
 * that already have a pending outbox entry.
 */
export function enableSync(tier: SyncTier = "basic"): void {
  setTeamConfig(ENABLED_KEY, "1");
  reconcile(tier);
}

/** Disable change-capture. Leaves the outbox/state intact for re-enable. */
export function disableSync(): void {
  deleteTeamConfig(ENABLED_KEY);
}
