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
import { uuidv7 } from "uuidv7";
import {
  db,
  deleteTeamConfig,
  getKV,
  getTeamConfig,
  setKV,
  setTeamConfig,
  withSyncApplying,
  withTransaction,
} from "./db";
import { putWrappedScopeKey } from "./crypto/keystore";
import { rematerializeConfidence } from "./ltm";

// The stable per-device id (also used by the confidence CRDT) doubles as the device id
// for sync's server-side reaper watermark (#909). Re-exported so the gateway can report
// this device's pull progress under `syncData.replicaId()`.
export { replicaId } from "./ltm";

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
   * Pull-only: the remote row is server-authoritative and the client may only
   * READ it (e.g. `profiles`, whose `tier` is billing-controlled via
   * service_role). Pull-only tables get NO local change-capture trigger (see
   * `installSyncCapture` in db.ts — its table list deliberately excludes them),
   * are never enqueued in the outbox, and `pushOnce` skips them; `pullOnce`
   * includes them. Defaults to false.
   */
  pullOnly?: boolean;
  /**
   * The data columns that exist on the REMOTE table (supabase/migrations/0002),
   * which is a curated subset of the local schema. Push/hash use ONLY these —
   * sending a local-only column (e.g. knowledge.promoted_at, worker_model_id)
   * is a PostgREST PGRST204 and would break sync for the whole table. Sync-
   * management columns (scope_id/author_id/content_hash/revision/is_deleted) are
   * server-derived or added separately and are NOT listed here.
   */
  syncColumns: string[];
  /**
   * Columns holding BLOB (Uint8Array) data locally that must be base64-encoded to
   * travel over the PostgREST/JSON wire (the remote stores them as `text`). Encoded
   * on push (toRemoteRow) and decoded back to a Buffer on apply (applyRemoteUpsert /
   * a custom handler). NULL passes through unchanged. Must be a subset of syncColumns.
   * (contentHash already base64s Uint8Array via serializeValue, so hashes are stable
   * across the encode/decode round-trip.)
   */
  blobColumns?: string[];
  /**
   * TEXT columns encrypted on the sync wire (C-4, #825): sealed to a per-scope DEK and
   * base64-encoded on push, decrypted on pull, so the server only ever stores
   * ciphertext. Local storage stays PLAINTEXT (FTS/embeddings unaffected). content_hash
   * is computed over the plaintext, so it stays cross-device stable. Active only when
   * `keystore.encryptionState() === "on"`; "off" leaves these plaintext (v1 default).
   */
  encryptedColumns?: string[];
  /**
   * How local change-capture is installed for this table (installSyncCapture, db.ts):
   *   "row" (default) — a standard per-row INSERT/UPDATE/DELETE outbox trigger.
   *   "distillation-fanout" — distillations only: on INSERT enqueue the distillation
   *     AND fan out one temporal_messages outbox row per id in `source_ids`
   *     (json_each); on UPDATE re-enqueue the distillation (the archived flip). Its
   *     referenced temporal subset is the ONLY temporal that ever syncs. Pro-tier
   *     gated (installed only when the plan tier is pro/max).
   *   "none" — no own trigger; captured INDIRECTLY (temporal_messages, enqueued by
   *     the distillation fanout). Distinct from pullOnly, which is never pushed.
   */
  captureStrategy?: "row" | "distillation-fanout" | "none";
  /**
   * Append-only table whose REMOTE schema has NO `is_deleted` column (temporal_messages,
   * supabase/migrations/0020 — "no is_deleted reaper"). The push payload must therefore
   * OMIT `is_deleted` (unlike every other table, where pushEntry sends `is_deleted:false`
   * on upsert / `true` on delete) — sending it is a PGRST204 that poisons every row. The
   * client also never deletes/tombstones it (reconcile skips it), so the delete branch is
   * unreachable; the pull side already treats an absent `is_deleted` as not-deleted.
   * Defaults to false. (Distinct from `versioned`: the join table is versioned:false yet
   * HAS is_deleted, so `versioned` is the wrong discriminator here.)
   */
  appendOnly?: boolean;
}

/** ASCII Unit Separator — joins composite row ids (mirrors the SQL `char(31)`). */
const ROW_SEP = "\x1f";

/**
 * Volatile / local-only columns never sent over the wire: BLOB `embedding`
 * (re-derived on restore), `last_accessed_at` and `last_reinforced_at`
 * (per-machine access / reinforcement clocks). These are still listed here as a
 * belt-and-suspenders denylist even though, post-A2-3b, they are no longer
 * `knowledge` columns at all (`confidence`/`last_reinforced_at` moved to the
 * `knowledge_meta` register, which syncs separately in 3b-2) — `syncedColumns()`
 * already intersects with the live schema, so they cannot leak regardless.
 */
const PAYLOAD_EXCLUDE = new Set([
  "embedding",
  "last_accessed_at",
  "last_reinforced_at",
]);
/**
 * Columns excluded from the content hash: the non-synced ones above plus
 * `updated_at` (a fresh timestamp is not a semantic change). Intentionally a
 * denylist of volatile/local columns; if cross-tenant dedup is ever needed,
 * switch to an explicit per-table semantic allowlist.
 */
const HASH_EXCLUDE = new Set([
  "embedding",
  "last_accessed_at",
  "last_reinforced_at",
  "updated_at",
]);

export const SYNCED_TABLES: Record<SyncTier, SyncTableMeta[]> = {
  basic: [
    {
      // Encryption escrow (C-3, #825): the account secret wrapped by a passphrase
      // KEK (+ optional recovery), so a fresh device recovers the SAME account key.
      // Single-row locally (id=1); the remote is one row per user, keyed (scope_id,
      // id). All payload is ciphertext + KDF params — the server never sees plaintext.
      // Read-write (LWW: the latest passphrase-set wins). BLOB columns travel base64.
      //
      // ORDER (C-4): the key tables are pulled BEFORE `knowledge` so that on a fresh
      // device the escrow is already local by the time knowledge is applied — making
      // `encryptionState()` "locked" (skip) rather than "off" (which would passthrough
      // ciphertext as plaintext). See the pull path in sync.ts.
      table: "account_escrow",
      idColumns: ["id"],
      ftsTables: [],
      syncColumns: [
        "id",
        "wrapped_secret",
        "kdf_salt",
        "kdf_t",
        "kdf_m",
        "kdf_p",
        "recovery_wrapped",
        "recovery_salt",
        "recovery_kdf_t",
        "recovery_kdf_m",
        "recovery_kdf_p",
        "key_epoch",
        // created_at is NOT NULL locally with no default, so it must ride along for
        // the generic pull INSERT (applyRemoteUpsert). It is stable per row, so both
        // devices converge on the creator's value (no hash churn).
        "created_at",
        "updated_at",
      ],
      blobColumns: [
        "wrapped_secret",
        "kdf_salt",
        "recovery_wrapped",
        "recovery_salt",
      ],
    },
    {
      // Per-scope DEK wrapped (HPKE) to a member's account key (C-3, #825). v1
      // personal: local scope_id == member_user_id == auth.uid(), and the remote's
      // server-derived scope_id IS the encryption scope — so the local `scope_id`
      // column is NOT synced (idColumns is member_user_id only) and is reconstructed
      // from remote.scope_id by the custom applyRemoteScopeKey (the generic
      // stripSyncCols would drop it, leaving the NOT-NULL local column unfilled).
      // wrapped_dek is ciphertext → base64 on the wire. Pulled BEFORE knowledge (C-4).
      table: "scope_keys",
      idColumns: ["member_user_id"],
      ftsTables: [],
      syncColumns: ["member_user_id", "wrapped_dek", "key_epoch", "updated_at"],
      blobColumns: ["wrapped_dek"],
    },
    {
      table: "knowledge",
      idColumns: ["id"],
      ftsTables: ["knowledge_fts"],
      // C-4 (#825): the knowledge text is encrypted on the wire (server stores
      // ciphertext). content is NOT NULL and title is NOT NULL remotely, so a
      // tombstone scrub sets them to "" (empty, never sealed).
      encryptedColumns: ["content", "title"],
      syncColumns: [
        "id",
        "project_id",
        "category",
        "title",
        "content",
        "source_session",
        "cross_project",
        // confidence moved to the knowledge_meta register (A2 sub-PR 3b, #823) —
        // it is no longer a knowledge column, and syncs as its own convergent
        // table in 3b-2. (syncedColumns() also filters by the live schema, so a
        // stale entry here would be dropped — removing it keeps the registry honest.)
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
      // A2 sub-PR 3b-2 (#823): the per-entry metric register, keyed by the stable
      // logical_id. Only the IMMUTABLE base_confidence syncs (set once at create;
      // the materialized `confidence` is local-derived from base + the CRDT counters,
      // and last_reinforced_at is a local decay clock — neither is in syncColumns).
      // hash-LWW (versioned) is safe because base is immutable AFTER create: the
      // only divergence is a one-time seam where two devices backfill base from
      // their own pre-sync LWW confidence (v63 migration) — hash-LWW picks one
      // winner and, since the CRDT counters MAX-merge independently, both sides
      // still CONVERGE. Applied via applyRemoteMeta (upsert base + re-materialize).
      // (No created_at: the local knowledge_meta table has none — syncedColumns()
      // would silently drop it; listing it only mis-leads remote migration 0009.)
      table: "knowledge_meta",
      idColumns: ["logical_id"],
      ftsTables: [],
      syncColumns: ["logical_id", "base_confidence", "updated_at"],
    },
    {
      // A2 sub-PR 3b-2: the convergent PN-counter state. Grow-only per
      // (logical_id, replica_id); each row is SINGLE-OWNER (a device only ever
      // increments its OWN replica's counter via applyConfidenceDelta, and pulled
      // peer rows arrive under apply-suppression) — so the remote overwrite-upsert
      // is monotonic and the outbox only ever carries this device's rows. Merge on
      // the PULL side is per-key max (applyRemoteMetaCrdt), a join-semilattice.
      // versioned:false: no content_hash/revision remotely (the local sync_state
      // still hashes pos/neg to skip no-op pushes). Always-applied on pull (max-
      // merge is idempotent/monotonic — never a "conflict").
      table: "knowledge_meta_crdt",
      idColumns: ["logical_id", "replica_id"],
      ftsTables: [],
      versioned: false,
      syncColumns: ["logical_id", "replica_id", "pos", "neg"],
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
        "sync_rank", // synced ref-count → server value-ranks entities for eviction (#1191b)
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
    {
      // Pull-only mirror of the server-authoritative account row. The client
      // reads its plan `tier` (and profile fields) but never writes them — the
      // remote RLS is select/update-own and `tier` is service_role-locked
      // (supabase/migrations/0004). No content_hash/revision remotely, so
      // versioned:false (the pull path classifies by remote updated_at).
      table: "profiles",
      idColumns: ["id"],
      ftsTables: [],
      versioned: false,
      pullOnly: true,
      syncColumns: [
        "id",
        "tier",
        "github_login",
        "display_name",
        "email",
        "created_at",
        "updated_at",
      ],
    },
  ],
  pro: [
    {
      // D (#826): the compressed conversation-memory backup. Encrypted on the wire
      // (narrative/facts/observations sealed to the per-scope DEK). VERSIONED — the
      // `archived` flip is a real UPDATE that re-pushes (content_hash changes).
      // Captured via a distillation-fanout trigger that also enqueues the referenced
      // temporal_messages subset. source_ids stays cleartext (id refs, like FKs).
      table: "distillations",
      idColumns: ["id"],
      ftsTables: ["distillation_fts"],
      captureStrategy: "distillation-fanout",
      encryptedColumns: ["narrative", "facts", "observations"],
      syncColumns: [
        "id",
        "project_id",
        "session_id",
        "narrative",
        "facts",
        "observations",
        "source_ids",
        "generation",
        "token_count",
        "r_compression",
        "c_norm",
        "call_type",
        "worker_provider_id",
        "worker_model_id",
        "archived",
        "created_at",
        // No updated_at: the local table has none — the remote server-stamps it
        // (0020 default now() + BEFORE UPDATE trigger), which is the pull cursor.
      ],
    },
    {
      // D (#826): ONLY the distillation-REFERENCED subset ever syncs (id ∈ ⋃
      // distillations.source_ids) — enforced by the fanout capture + the subset-aware
      // seed/reconcile; an undistilled message never leaves the device. Append-only
      // (versioned:false); NO own capture trigger (captureStrategy "none" — enqueued
      // by the distillation fanout). The local `distilled` residency flag is NOT
      // synced (per-device cache state); a pulled row is marked distilled=1 on apply
      // so the next prune won't evict a just-restored message. content/metadata are
      // encrypted on the wire.
      table: "temporal_messages",
      idColumns: ["id"],
      ftsTables: ["temporal_fts"],
      versioned: false,
      // Remote 0020 has no is_deleted column — the push payload must omit it.
      appendOnly: true,
      captureStrategy: "none",
      encryptedColumns: ["content", "metadata"],
      syncColumns: [
        "id",
        "project_id",
        "session_id",
        "role",
        "content",
        "tokens",
        "metadata",
        "created_at",
      ],
    },
  ],
  max: [],
};

// Every registered table across ALL tiers — so meta()/metaFor() resolve a table
// regardless of the caller's current tier (a Pro table's shape is tier-independent;
// tier only gates whether it is SYNCED, not whether its meta exists).
const META_BY_TABLE = new Map<string, SyncTableMeta>();
for (const t of [
  ...SYNCED_TABLES.basic,
  ...SYNCED_TABLES.pro,
  ...SYNCED_TABLES.max,
])
  META_BY_TABLE.set(t.table, t);

/** The tables registered for exactly one SyncTier (non-cumulative). */
export function syncedTables(tier: SyncTier = "basic"): SyncTableMeta[] {
  return SYNCED_TABLES[tier];
}

/**
 * The CUMULATIVE synced table set at a SyncTier: basic ⊆ pro ⊆ max. This is what
 * the engine actually syncs — a Pro user gets the basic tables PLUS the pro ones.
 * (pro/max are empty until #826/D populates them, so this equals `basic` today.)
 */
export function syncedTablesFor(tier: SyncTier): SyncTableMeta[] {
  const out = [...SYNCED_TABLES.basic];
  if (tier === "pro" || tier === "max") out.push(...SYNCED_TABLES.pro);
  if (tier === "max") out.push(...SYNCED_TABLES.max);
  return out;
}

/**
 * Map the user's PLAN tier (currentTier(): 'free'|'pro'|'max') to the SyncTier
 * whose cumulative table set should sync. free → basic; pro → pro; max → max.
 */
export function currentSyncTier(): SyncTier {
  const plan = currentTier();
  if (plan === "max") return "max";
  if (plan === "pro") return "pro";
  return "basic";
}

/** Resolve a table's meta regardless of tier (throws if not registered). */
export function metaFor(table: string): SyncTableMeta {
  return meta(table);
}

/**
 * The user's PLAN tier (billing-controlled: 'free' | 'pro' | …) read from the
 * local pull-only `profiles` mirror. NOTE: this is distinct from `SyncTier`
 * (basic/pro/max — which table SET to sync); a future mapping turns a plan tier
 * into a SyncTier when Pro sync (issue #826/D) lands.
 *
 * Returns 'free' when no profile row has been pulled yet (unauthenticated or
 * pre-first-sync). Billing flips `tier` server-side via service_role; it
 * propagates here on the next pull (no bespoke "did I become pro?" path).
 */
export function currentTier(): string {
  // INVARIANT: the mirror holds AT MOST the currently-authenticated user's row.
  // `clearProfileMirror()` is called on logout and on account switch, so a stale
  // OR foreign account's tier can never linger here — making this unqualified
  // `LIMIT 1` deterministic and safe (RLS already guarantees a pull returns only
  // the caller's own profile, so the network path never adds a second row).
  const row = db().query("SELECT tier FROM profiles LIMIT 1").get() as
    | { tier?: string }
    | undefined;
  return row?.tier ?? "free";
}

/**
 * Drop the pulled `profiles` mirror (row + its sync_state + pull cursor). Called
 * when the authenticated identity changes — logout or account switch — so the
 * server-authoritative plan tier can never survive a sign-out or leak across
 * accounts (see `currentTier`'s single-row invariant). The next sync re-pulls
 * the current account's profile from scratch.
 */
export function clearProfileMirror(): void {
  db().exec("DELETE FROM profiles");
  db().query("DELETE FROM sync_state WHERE table_name = 'profiles'").run();
  // Reset the pull cursor so the (new) account's profile is re-pulled from the
  // start rather than skipped by a cursor inherited from the previous account.
  setKV("sync.pull.profiles", "0|");
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
// Memoize the synced-column list per DB connection. syncedColumns runs a
// `PRAGMA table_info`, and is reached once per row (via contentHash /
// pickSyncColumns / getRowById) on every push and pull — an N+1 over a batch. A
// table's columns are fixed once migrations finish (they run on the raw connection
// before it's ever returned by db(), so before any sync), making the result stable
// for a connection's lifetime. Keying on the db instance auto-invalidates when the
// connection is replaced (close()/tests). The cached array is frozen: it is shared,
// and all callers only read it (filter/iterate), so a stray mutation is a bug.
const syncedColumnsCache = new WeakMap<
  object,
  Map<string, readonly string[]>
>();

export function syncedColumns(table: string): readonly string[] {
  const conn = db();
  let perConn = syncedColumnsCache.get(conn);
  if (!perConn) {
    perConn = new Map();
    syncedColumnsCache.set(conn, perConn);
  }
  const cached = perConn.get(table);
  if (cached) return cached;
  const m = meta(table);
  const local = new Set(
    (
      conn.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    ).map((r) => r.name),
  );
  const result = Object.freeze(m.syncColumns.filter((c) => local.has(c)));
  perConn.set(table, result);
  return result;
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
function columns(table: string): readonly string[] {
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
  return hashRowColumns(columns(table), row);
}

/**
 * Core of {@link contentHash}, given a table's already-resolved synced columns.
 * Lets hot loops resolve the columns ONCE (the `PRAGMA table_info` in `columns`)
 * and hash many rows without re-querying per row.
 */
function hashRowColumns(
  cols: readonly string[],
  row: Record<string, unknown>,
): string {
  const hashCols = cols.filter((c) => !HASH_EXCLUDE.has(c)).sort();
  const canonical = hashCols
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

/**
 * Knowledge-aware pending check (A2, #823): the knowledge outbox is logical_id-
 * keyed (#909), so an unpushed edit to a logical entry is simply a row whose
 * `row_id` equals the logical_id. The pull path uses this so it never silently
 * lets a remote change win over an unpushed local edit (it logs a conflict).
 */
export function hasPendingKnowledgeChange(
  logicalId: string,
  sinceSeq: number,
): boolean {
  const row = db()
    .query(
      `SELECT 1 FROM sync_outbox
        WHERE table_name = 'knowledge' AND seq > ? AND row_id = ? LIMIT 1`,
    )
    .get(sinceSeq, logicalId);
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
 * Enqueue an `upsert` for every live row whose CURRENT content isn't already
 * correctly queued for the remote. Content-addressed, and aware of which outbox
 * entries the push hasn't consumed yet (seq > the table's push cursor), so for
 * each live row:
 *  - latest UNPUSHED op is an `upsert` → skip: it already carries the current
 *    content when pushed (getRowById), so re-enqueue would just pile up (this is
 *    what keeps reconcile idempotent);
 *  - latest UNPUSHED op is a `delete` → enqueue a trailing upsert: the row is live
 *    again (recreated across a disable/enable boundary), so the delete must lose;
 *  - no unpushed op → the remote reflects `sync_state`; enqueue only on a real
 *    content change (`contentHash != sync_state.content_hash`), skipping unchanged
 *    rows so reconcile doesn't churn.
 * The "unpushed" qualifier is load-bearing: a stale already-pushed upsert can
 * survive pruning (the prune floor was pinned by a lower-seq table, #828) and sits
 * below the push cursor where it is NEVER re-read. A latest-op guard would treat it
 * as "already queued" and silently drop a since-made edit; the content check sees
 * the divergence (current content != the hash that stale upsert synced) and
 * re-seeds it.
 */
/**
 * The seed SELECT for a non-knowledge table, VALUE-RANKED so a capped free tier keeps
 * the MOST USEFUL rows (mirrors the knowledge seed; the push drains the outbox in seq
 * order and the server rejects once the cap is hit, so seed order = what survives):
 *  - entities: most-referenced first (by knowledge_entity_refs count), then recency —
 *    a heavily-referenced entity is more useful than a one-off when the free cap bites.
 *  - entity_relations: recency (updated_at, then created_at).
 *  - entity_aliases: recency (created_at — the table has no updated_at).
 *  - knowledge_meta: LIVE entries only (JOIN knowledge_current), same value order as
 *    knowledge (confidence, then recency), so the surviving meta set matches the
 *    surviving knowledge set under their shared cap and deleted-entry meta isn't pushed.
 *  - any other table: unordered (no per-row value signal / high enough cap).
 * (knowledge is handled by its own logical_id-keyed branch in seedOutbox.)
 */
function seedSelect(table: string): string {
  switch (table) {
    // The trailing id is a stable tiebreak so re-seeds are fully deterministic when
    // the value keys are equal (order only affects cap survival, not cache stability).
    case "entities":
      return `SELECT e.* FROM entities e
                LEFT JOIN (
                  SELECT entity_id, COUNT(*) AS refs
                    FROM knowledge_entity_refs GROUP BY entity_id
                ) r ON r.entity_id = e.id
               ORDER BY COALESCE(r.refs, 0) DESC, e.updated_at DESC, e.created_at DESC, e.id`;
    case "entity_relations":
      return "SELECT * FROM entity_relations ORDER BY updated_at DESC, created_at DESC, id";
    case "entity_aliases":
      return "SELECT * FROM entity_aliases ORDER BY created_at DESC, id";
    // knowledge_meta shares knowledge's 500-row cap, so seed it in the SAME value order
    // (confidence, then recency) as the knowledge seed — otherwise the surviving meta set
    // wouldn't match the surviving knowledge set and synced entries would read as the
    // default confidence (1.0) on a peer. (Deleted entries are typically low-confidence —
    // pruneDeadEntries/consolidation — so they sort last and don't steal live slots.
    // knowledge_meta_crdt's 10x cap won't bind for a single device, so it stays default.)
    case "knowledge_meta":
      // Restrict to LIVE entries (mirrors knowledge_current) so the register aligns
      // 1:1 with the knowledge seed: a deleted entry's lingering meta (remove() keeps
      // the register row) can't steal a live entry's slot under the shared 500 cap, and
      // orphaned meta for deleted entries isn't pushed to the remote. Same value order
      // as the knowledge seed (confidence, then recency, then logical_id tiebreak).
      return `SELECT m.* FROM knowledge_meta m
                JOIN knowledge k
                  ON k.logical_id = m.logical_id
                 AND k.is_current = 1
                 AND k.is_deleted = 0
               ORDER BY m.confidence DESC,
                        COALESCE(m.last_reinforced_at, m.updated_at) DESC,
                        m.logical_id`;
    // D (#826): the compressed-memory backup. Recency order so the newest memory
    // survives the (generous, rarely-binding) pro cap.
    case "distillations":
      return "SELECT * FROM distillations ORDER BY created_at DESC, id";
    // D (#826): 🔴 ONLY the distillation-REFERENCED subset ever syncs — an
    // undistilled message must NEVER be enqueued. Restrict to ids present in some
    // distillation's source_ids (json_each), mirroring the fanout capture trigger.
    // Recency order for cap survival; id tiebreak for determinism.
    case "temporal_messages":
      // json_valid guard: a single corrupt source_ids must not throw and abort the
      // whole seed transaction (source_ids is always JSON.stringify'd, so this is
      // belt-and-suspenders; filter BEFORE json_each so the bad row is skipped).
      return `SELECT t.* FROM temporal_messages t
                WHERE t.id IN (
                  SELECT value FROM
                    (SELECT source_ids FROM distillations WHERE json_valid(source_ids)) d,
                    json_each(d.source_ids)
                )
               ORDER BY t.created_at DESC, t.id`;
    default:
      return `SELECT * FROM ${table}`;
  }
}

export function seedOutbox(tier: SyncTier = currentSyncTier()): void {
  const now = Date.now();
  const enqueue = db().query(
    `INSERT INTO sync_outbox (table_name, row_id, op, changed_at)
     VALUES (?, ?, 'upsert', ?)`,
  );
  // Latest pending op for a row among entries the push hasn't consumed yet. An
  // already-pushed (seq <= cursor) entry is stale — never re-read — so excluded.
  const latestUnpushed = db().query(
    `SELECT op FROM sync_outbox
      WHERE table_name = ? AND row_id = ? AND seq > ?
      ORDER BY seq DESC LIMIT 1`,
  );
  // One transaction for the whole seed: the per-row loop does N inserts, and
  // without it WAL + synchronous=FULL would fsync once PER ROW — a multi-second
  // stall on `lore sync enable` for a large knowledge base. (Safe: seedOutbox is
  // only ever reached via enableSync, never from within another transaction.)
  withTransaction(() => {
    for (const m of syncedTablesFor(tier)) {
      // Pull-only tables are never pushed — enqueuing them would create outbox
      // entries that pushOnce skips forever, pinning their push cursor at 0 and
      // (via the prune floor) permanently disabling outbox pruning for ALL tables.
      if (m.pullOnly) continue;
      const pushCursor = Number(getKV(`sync.push.${m.table}`) ?? "0");

      // Knowledge is remote-keyed by logical_id (A2 sub-PR 3, #823): seed ONE entry
      // per CURRENT live logical entry — NOT every physical version — keyed + hashed
      // by logical_id to match the push plan + sync_state. Iterating physical rows
      // and checking sync_state by version id would miss every v2+ entry (sync_state
      // is keyed by logical_id) and re-enqueue it (outbox bloat). Deleted entries
      // (no live current) are NOT seeded here — reconcile's tombstone pass emits the
      // delete (its liveness check is also knowledge_current-based).
      if (m.table === "knowledge") {
        const latestForLogical = db().query(
          `SELECT op FROM sync_outbox
            WHERE table_name = 'knowledge' AND seq > ? AND row_id = ?
            ORDER BY seq DESC LIMIT 1`,
        );
        // Value-ranked so a capped free tier syncs the MOST USEFUL entries first. The
        // push drains the outbox in seq order and the server rejects once the row cap is
        // hit, so seeding by value (confidence, then recency of use/update) means the
        // LOWEST-value entries — not arbitrary storage order — are the ones left behind.
        // knowledge_current is one row per logical_id, so no DISTINCT is needed.
        // (A meta-less current row reads as confidence 1.0 via the view's COALESCE — the
        // legacy full-confidence default — so it sorts high, matching that semantics.)
        const lids = db()
          .query(
            `SELECT COALESCE(logical_id, id) AS lid FROM knowledge_current
              ORDER BY confidence DESC,
                       COALESCE(last_reinforced_at, updated_at) DESC,
                       created_at DESC`,
          )
          .all() as { lid: string }[];
        for (const { lid } of lids) {
          const pending =
            (latestForLogical.get(pushCursor, lid) as { op: string } | null)
              ?.op ?? null;
          if (pending === "upsert") continue; // already queued
          if (pending === null) {
            const synced = getSyncState("knowledge", lid)?.content_hash ?? null;
            const row = currentKnowledgeRow(lid);
            if (row && contentHash("knowledge", row) === synced) continue;
          }
          enqueue.run("knowledge", lid, now);
        }
        continue;
      }

      // Resolve the synced columns ONCE per table (one PRAGMA table_info) — not
      // per row, which is what `contentHash` would do (an N+1 on large tables).
      const cols = columns(m.table);
      const rows = db().query(seedSelect(m.table)).all() as Record<
        string,
        unknown
      >[];
      for (const row of rows) {
        const rowId = rowIdOf(m.table, row);
        const pending =
          (
            latestUnpushed.get(m.table, rowId, pushCursor) as {
              op: string;
            } | null
          )?.op ?? null;
        if (pending === "upsert") continue; // unpushed upsert already carries it
        if (pending === null) {
          // No unpushed op — re-seed only when the content actually changed.
          const synced = getSyncState(m.table, rowId)?.content_hash ?? null;
          if (hashRowColumns(cols, row) === synced) continue;
        }
        enqueue.run(m.table, rowId, now);
      }
    }
  });
}

/**
 * Re-enqueue the full local delta for a tier — used on enable AND re-enable:
 *  - an upsert for every live row whose current content isn't already correctly
 *    queued (see seedOutbox), and
 *  - a `delete` tombstone for every row present in `sync_state` but no longer live
 *    whose latest pending op isn't already a `delete` (deleted while sync was OFF,
 *    which the capture triggers couldn't see). The "isn't already a delete" guard
 *    (rather than "has no pending entry") matters when a stale UPSERT outlived the
 *    row — e.g. it survived pruning because the prune floor was pinned by a lower-
 *    seq table (#828). Without the trailing delete, that upsert pushes as a no-op
 *    (row gone) and the delete would never reach the remote.
 * This is why enable does NOT just seed once: it reconciles, so changes made
 * while sync was disabled are not silently dropped from the push queue.
 */
export function reconcile(tier: SyncTier = currentSyncTier()): void {
  const now = Date.now();
  seedOutbox(tier);
  for (const m of syncedTablesFor(tier)) {
    // Pull-only tables are never pushed (see seedOutbox) — also skip the
    // delete-tombstone reconciliation so no `profiles` outbox entry is created.
    if (m.pullOnly) continue;
    // D (#826): 🔴 the Pro backup tables (distillations, temporal_messages — any
    // non-"row" capture strategy) are APPEND-ONLY and sync-invisible on local
    // deletion. A local prune / project cleanup / cache eviction must NEVER tombstone
    // the remote backup: the remote is permanent, bounded by the per-scope quota +
    // server reaper, NOT by local residency (epic #821 decision). They also have no
    // capture DELETE trigger, so the ONLY way they could tombstone is this pass —
    // skip it. (Remote lifecycle is the server reaper's job, not the client's.)
    if (m.captureStrategy && m.captureStrategy !== "row") continue;
    // Knowledge is keyed by logical_id and append-only: "live" means a CURRENT live
    // version exists (knowledge_current), NOT merely a physical row — a deleted
    // entry keeps its demoted/death-cert version rows, so an `id = logical_id`
    // existence check would never tombstone a delete made while sync was OFF (#823).
    const livenessNotExists =
      m.table === "knowledge"
        ? "NOT EXISTS (SELECT 1 FROM knowledge_current t WHERE COALESCE(t.logical_id, t.id) = s.row_id)"
        : `NOT EXISTS (SELECT 1 FROM ${m.table} t WHERE ${rowIdExpr(m)} = s.row_id)`;
    db()
      .query(
        `INSERT INTO sync_outbox (table_name, row_id, op, changed_at)
         SELECT s.table_name, s.row_id, 'delete', ?
           FROM sync_state s
          WHERE s.table_name = ?
            AND ${livenessNotExists}
            AND COALESCE(
              (SELECT o.op FROM sync_outbox o
                WHERE o.table_name = s.table_name AND o.row_id = s.row_id
                ORDER BY o.seq DESC LIMIT 1),
              'none'
            ) <> 'delete'`,
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
/**
 * Decode a table's base64 blobColumns (string→Buffer) in-place for a pulled row, so
 * they bind as SQLite BLOBs. NULL/absent pass through. Inverse of the push-side
 * base64 encode in toRemoteRow. No-op for tables without blobColumns.
 */
export function decodeBlobColumns(
  table: string,
  row: Record<string, unknown>,
): Record<string, unknown> {
  const blobs = meta(table).blobColumns;
  if (!blobs || blobs.length === 0) return row;
  for (const c of blobs) {
    const v = row[c];
    if (typeof v === "string") row[c] = Buffer.from(v, "base64");
  }
  return row;
}

export function applyRemoteUpsert(
  table: string,
  row: Record<string, unknown>,
): void {
  const m = meta(table);
  decodeBlobColumns(table, row);
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
  // NOTE: knowledge is NOT applied here — it routes through applyRemoteKnowledge
  // (append-only, version-aware). This generic upsert serves the entity graph
  // (entities / aliases / relations / refs), which are not versioned.
  withApplying(() => {
    db()
      .query(sql)
      .run(...cols.map((c) => row[c] as never));
  });
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

/**
 * Apply a pulled `knowledge_meta` base row (A2 sub-PR 3b-2). Upserts the IMMUTABLE
 * `base_confidence` (the only synced field) keyed by `logical_id`, then re-
 * materializes the local `confidence` cache from base + the PN-counters. The
 * materialized `confidence` and the local `last_reinforced_at` decay clock are
 * local-derived/local-only and are NEVER overwritten by the pull. Runs under
 * apply-suppression (the base write is not re-pushed). A NEW row seeds
 * `confidence = base`; re-materialize then folds in any counters already present.
 */
export function applyRemoteMeta(row: Record<string, unknown>): void {
  const logicalId = String(row.logical_id);
  const base = Number(row.base_confidence ?? 1.0);
  withApplying(() => {
    db()
      .query(
        `INSERT INTO knowledge_meta (logical_id, base_confidence, confidence, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(logical_id) DO UPDATE SET base_confidence = excluded.base_confidence`,
      )
      .run(logicalId, base, base, Number(row.updated_at ?? 0));
    rematerializeConfidence(logicalId, Date.now());
  });
}

/**
 * Apply a pulled `scope_keys` row (C-3, #825). The local table's NOT-NULL
 * `scope_id` is the encryption scope, which the generic `stripSyncCols` would drop —
 * so this custom handler reconstructs it from the remote's `scope_id` axis (v1: ==
 * the puller's own auth.uid()), base64-decodes the wrapped DEK, and upserts via the
 * keystore (which invalidates its in-memory DEK cache for the scope). Runs under
 * apply-suppression so the pulled row is not re-enqueued for push. Takes the FULL
 * remote row (not stripped) because it needs `scope_id`.
 */
export function applyRemoteScopeKey(remote: Record<string, unknown>): void {
  const scopeId = String(remote.scope_id);
  const memberUserId = String(remote.member_user_id);
  const wrapped =
    typeof remote.wrapped_dek === "string"
      ? new Uint8Array(Buffer.from(remote.wrapped_dek, "base64"))
      : new Uint8Array(remote.wrapped_dek as Uint8Array);
  const keyEpoch = Number(remote.key_epoch ?? 0);
  const updatedAt = Date.parse(String(remote.updated_at ?? "")) || Date.now();
  withApplying(() =>
    putWrappedScopeKey(scopeId, memberUserId, wrapped, keyEpoch, updatedAt),
  );
}

/**
 * Apply a pulled `knowledge_meta_crdt` counter row (A2 sub-PR 3b-2) via per-key
 * MAX merge (a grow-only join-semilattice), then re-materialize the entry's
 * confidence. ALWAYS safe to apply — idempotent and monotonic: a stale lower
 * counter never lowers the local value — so the engine applies it unconditionally
 * (no hash classify). Runs under apply-suppression so the merged PEER counter is
 * not re-pushed (this device only ever pushes its OWN replica's rows).
 */
export function applyRemoteMetaCrdt(row: Record<string, unknown>): void {
  const logicalId = String(row.logical_id);
  withApplying(() => {
    db()
      .query(
        `INSERT INTO knowledge_meta_crdt (logical_id, replica_id, pos, neg, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(logical_id, replica_id) DO UPDATE SET
           pos = MAX(pos, excluded.pos),
           neg = MAX(neg, excluded.neg),
           updated_at = MAX(updated_at, excluded.updated_at)`,
      )
      .run(
        logicalId,
        String(row.replica_id),
        Number(row.pos ?? 0),
        Number(row.neg ?? 0),
        Number(row.updated_at ?? 0),
      );
    rematerializeConfidence(logicalId, Number(row.updated_at ?? 0));
  });
}

/** Insert one knowledge version row from a synced-column source `src`. */
function insertKnowledgeVersion(
  src: Record<string, unknown>,
  syncCols: string[],
  ident: { id: string; logicalId: string; version: number; isDeleted: 0 | 1 },
): void {
  const vals: Record<string, unknown> = {};
  for (const c of syncCols) vals[c] = src[c];
  vals.id = ident.id;
  vals.logical_id = ident.logicalId;
  vals.version = ident.version;
  vals.is_current = 1;
  vals.is_deleted = ident.isDeleted;
  const cols = Object.keys(vals);
  db()
    .query(
      `INSERT INTO knowledge (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    )
    .run(...cols.map((c) => vals[c] as never));
  // Uphold the local model invariant (A2 3b): every logical entry has a
  // knowledge_meta register row, so subsequent local reinforce/decay/update —
  // which UPDATE knowledge_meta WHERE logical_id=… — affect a row instead of
  // silently no-op'ing. INSERT OR IGNORE never clobbers an existing (possibly
  // converged) register on re-pull/version-append.
  const hadMeta =
    db()
      .query("SELECT 1 FROM knowledge_meta WHERE logical_id = ?")
      .get(ident.logicalId) != null;
  // Seed last_reinforced_at to NOW (a local first-appearance touch), NOT NULL:
  // decayProject grace-checks COALESCE(last_reinforced_at, k.updated_at), and a
  // just-pulled entry's k.updated_at is the AUTHOR's (possibly old) content clock —
  // NULL would make it instantly decay-eligible on this device, and since decay now
  // records a CRDT counter, that local decay would sync back and spuriously lower the
  // entry for every replica. last_reinforced_at is local-only (not a syncColumn), so
  // this does not affect the placeholder base-guard hash below. updated_at stays 0
  // (the register's sync clock) until the real base arrives via applyRemoteMeta.
  db()
    .query(
      "INSERT OR IGNORE INTO knowledge_meta (logical_id, confidence, last_reinforced_at, updated_at) VALUES (?, 1.0, ?, 0)",
    )
    .run(ident.logicalId, Date.now());
  if (!hadMeta) {
    // The real base_confidence is whatever the entry's AUTHOR set; it only reaches
    // this device once knowledge_meta itself syncs (a separate per-table cursor, so
    // it can lag the knowledge pull arbitrarily). The 1.0 minted just above is a
    // PLACEHOLDER this device did NOT author. Record its sync_state so a later
    // disable→enable's seedOutbox treats it as already-in-sync and NEVER pushes the
    // fabricated default — which would otherwise overwrite the author's real base on
    // the (scope_id, logical_id)-keyed remote and permanently clobber it for every
    // replica (base is immutable, so no one re-corrects it). When the real base
    // arrives, applyRemoteMeta overwrites it and re-records sync_state from it.
    const minted = getRowById("knowledge_meta", ident.logicalId);
    if (minted)
      setSyncState("knowledge_meta", ident.logicalId, {
        content_hash: contentHash("knowledge_meta", minted),
        revision: 0,
        remote_updated_at: "",
      });
  }
}

/**
 * Apply a pulled knowledge row (keyed by `logical_id` = `row.id`) into the local
 * APPEND-ONLY model (A2, #823). The remote is a current-only mirror, so a content
 * change is "the same concern, new value" arriving from another device → append a
 * new current version (mirrors a local update()); a metadata-only change converges
 * in place; a brand-new entry inserts v1. Idempotency: re-pulling our own pushed
 * content matches the current version → no new version. Runs under apply-
 * suppression (no re-push) and a transaction (single-current invariant: demote
 * before insert). NOTE: superseded/death-cert version history stays LOCAL — only
 * current content converges across devices.
 */
export function applyRemoteKnowledge(row: Record<string, unknown>): void {
  const logicalId = String(row.id);
  const syncCols = columns("knowledge").filter(
    (c) => !PAYLOAD_EXCLUDE.has(c) && c in row,
  );
  withApplying(() =>
    withTransaction(() => {
      const agg = db()
        .query(
          "SELECT MAX(version) AS maxV, COUNT(*) AS n FROM knowledge WHERE COALESCE(logical_id, id) = ?",
        )
        .get(logicalId) as { maxV: number | null; n: number };
      const cur = db()
        .query(
          "SELECT content FROM knowledge_current WHERE COALESCE(logical_id, id) = ?",
        )
        .get(logicalId) as { content: string } | undefined;

      if (agg.n === 0) {
        // Brand-new entry: v1 carries the remote id AS the logical_id (id == logical_id).
        insertKnowledgeVersion(row, syncCols, {
          id: logicalId,
          logicalId,
          version: 1,
          isDeleted: 0,
        });
        return;
      }
      if (cur && cur.content === row.content) {
        // Content already converged — update the other (hashed) synced fields on the
        // current version in place so the local hash matches the remote (no re-push),
        // without minting a new version. content/identity/version cols are excluded.
        const skip = new Set([
          "id",
          "logical_id",
          "version",
          "is_current",
          "is_deleted",
          "content",
        ]);
        const setCols = syncCols.filter((c) => !skip.has(c));
        if (setCols.length > 0) {
          db()
            .query(
              `UPDATE knowledge SET ${setCols.map((c) => `${c} = ?`).join(", ")} WHERE COALESCE(logical_id, id) = ? AND is_current = 1`,
            )
            .run(...setCols.map((c) => row[c] as never), logicalId);
        }
        return;
      }
      // Content differs (or no live current → revive) → append a new current version.
      db()
        .query(
          "UPDATE knowledge SET is_current = 0 WHERE COALESCE(logical_id, id) = ? AND is_current = 1",
        )
        .run(logicalId);
      insertKnowledgeVersion(row, syncCols, {
        id: uuidv7(),
        logicalId,
        version: (agg.maxV ?? 0) + 1,
        isDeleted: 0,
      });
    }),
  );
}

/**
 * Apply a pulled knowledge DELETE (remote soft-delete of `logicalId`) into the
 * local append-only model: append a death-certificate version (preserving the
 * current content) if a live current exists; otherwise a no-op. Apply-suppressed
 * + transactional (single-current invariant).
 */
export function applyRemoteKnowledgeDelete(logicalId: string): void {
  withApplying(() =>
    withTransaction(() => {
      const cur = db()
        .query(
          "SELECT * FROM knowledge_current WHERE COALESCE(logical_id, id) = ?",
        )
        .get(logicalId) as Record<string, unknown> | undefined;
      if (!cur) return; // already no live current — nothing to delete
      const maxV = (
        db()
          .query(
            "SELECT MAX(version) AS m FROM knowledge WHERE COALESCE(logical_id, id) = ?",
          )
          .get(logicalId) as { m: number }
      ).m;
      db()
        .query(
          "UPDATE knowledge SET is_current = 0 WHERE COALESCE(logical_id, id) = ? AND is_current = 1",
        )
        .run(logicalId);
      const syncCols = columns("knowledge").filter(
        (c) => !PAYLOAD_EXCLUDE.has(c) && c in cur,
      );
      insertKnowledgeVersion(cur, syncCols, {
        id: uuidv7(),
        logicalId,
        version: maxV + 1,
        isDeleted: 1,
      });
    }),
  );
}

export type KnowledgePushPlan =
  | { op: "delete"; logicalId: string }
  | { op: "upsert"; logicalId: string; row: Record<string, unknown> };

/**
 * Plan the remote push for a knowledge outbox row under the append-only model
 * (A2, #823). The remote is a CURRENT-only mirror keyed by `logical_id` — exactly
 * ONE row per logical entry:
 *   - live current version → upsert the current content under `id = logical_id`.
 *     Every version's outbox row for the same entry coalesces to this single
 *     upsert; the content_hash dedup makes the redundant ones no-ops.
 *   - no live current (every version superseded or a death-cert) → soft-delete
 *     `id = logical_id` (propagates deletions + removes stale/redacted content).
 *   - logical entry physically gone → skip.
 *
 * The returned `row` carries the synced columns of the CURRENT version with `id`
 * overridden to `logical_id` (the remote row key). This coalesces all versions to
 * one remote row and converges `id`↔`logical_id` across devices.
 */
/**
 * The CURRENT live version's synced columns for a logical entry, re-keyed
 * `id = logical_id` — i.e. the exact remote-row shape that {@link knowledgePushPlan}
 * pushes (and {@link contentHash} hashes). Null if the entry has no live current.
 * Use this (not getRowById, which addresses the physical/demoted row) whenever the
 * remote is keyed by logical_id — push, conflict classification, conflict snapshot.
 * COALESCE(logical_id, id): production always sets logical_id; be robust to a
 * legacy/unmigrated NULL (a v1 row IS its own logical entity).
 */
export function currentKnowledgeRow(
  logicalId: string,
): Record<string, unknown> | null {
  const cols = columns("knowledge").filter((c) => !PAYLOAD_EXCLUDE.has(c));
  const row = db()
    .query(
      `SELECT ${cols.join(", ")} FROM knowledge_current WHERE COALESCE(logical_id, id) = ?`,
    )
    .get(logicalId) as Record<string, unknown> | undefined;
  if (!row) return null;
  row.id = logicalId; // re-key on the stable logical_id (the remote row key)
  return row;
}

export function knowledgePushPlan(outboxRowId: string): KnowledgePushPlan {
  // The knowledge outbox is logical_id-keyed for every op (#909 capture triggers),
  // so the row_id IS the logical_id — resolve the current row directly, with no
  // join back to a physical version row (survives compaction of the v1 anchor).
  const logicalId = outboxRowId;
  const row = currentKnowledgeRow(logicalId);
  if (!row) return { op: "delete", logicalId }; // no live current → soft-delete
  return { op: "upsert", logicalId, row };
}

/** Rebuild an external-content FTS5 index after a batch of pulled changes. */
export function rebuildFts(ftsTable: string): void {
  if (ftsTable === "knowledge_fts") {
    // knowledge_fts is a PARTIAL mirror — only current, non-deleted versions are
    // indexed (A2, #823). FTS5 'rebuild' re-indexes EVERY physical row (incl.
    // superseded/deleted versions), which would resurface dead rows in search.
    // Rebuild manually from the current+live set instead.
    db().exec("INSERT INTO knowledge_fts(knowledge_fts) VALUES('delete-all')");
    db().exec(
      `INSERT INTO knowledge_fts(rowid, title, content, category)
       SELECT rowid, title, content, category FROM knowledge
        WHERE is_current = 1 AND is_deleted = 0`,
    );
    return;
  }
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
  // Knowledge is append-only and remote-keyed by logical_id: the local CURRENT
  // content lives in knowledge_current (a fresh version row), NOT the physical row
  // addressed by getRowById(id=logical_id) — which is the demoted v1 after any
  // update. Reading the demoted row here mis-hashes every versioned entry, turning
  // clean fast-forwards/echoes into false conflicts (Seer + review, #823).
  const local =
    table === "knowledge"
      ? currentKnowledgeRow(rowId)
      : getRowById(table, rowId);
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

/**
 * Deterministic convergence for a pulled `entity_aliases` row that violates the local
 * `UNIQUE(alias_type, alias_value)` the FK-less remote doesn't enforce (#1217). Two
 * devices can independently mint an alias for the same (type, value) with DIFFERENT ids;
 * without a rule each device keeps the OTHER's copy and they never converge. The tiebreak
 * is symmetric — the LOWER alias id wins on EVERY device — so the outcome is identical
 * regardless of pull order.
 *
 * `reapply` re-applies the winning remote row; it's invoked ONLY when the remote wins,
 * after the losing local row is dropped so the collision is cleared. Returns true when
 * the conflict is resolved (the caller advances the cursor + counts it), or false to fall
 * back to the generic constraint skip — either because there is no local (type, value)
 * collision, or because the remote alias is an FK orphan (its entity isn't admitted under
 * the cap), in which case the valid local alias must stay.
 *
 * The losing local row is deleted WITHOUT sync-suppression, so its removal propagates via
 * the outbox and the duplicate is cleaned off the remote too (then reaped, #909). The
 * discarded row is recorded to `sync_conflicts`.
 */
export function resolveAliasUniqueConflict(
  remote: Record<string, unknown>,
  reapply: () => void,
): boolean {
  const at = remote.alias_type;
  const av = remote.alias_value;
  const remoteId = remote.id;
  if (
    typeof at !== "string" ||
    typeof av !== "string" ||
    typeof remoteId !== "string"
  )
    return false;
  const local = db()
    .query(
      "SELECT id, entity_id, alias_type, alias_value FROM entity_aliases WHERE alias_type = ? AND alias_value = ?",
    )
    .get(at, av) as
    | { id: string; entity_id: string; alias_type: string; alias_value: string }
    | undefined;
  // No local collision, or the very same row (an ordinary update, not a conflict) →
  // let the caller apply/skip it normally.
  if (!local || local.id === remoteId) return false;

  if (remoteId < local.id) {
    // Remote alias has the lower id → it wins. But only proceed if it can actually
    // apply: its entity must be admitted locally, else it's an FK orphan and the valid
    // local alias must stay (the caller skips the orphan remote row).
    const entityId = remote.entity_id;
    if (
      typeof entityId !== "string" ||
      !db().query("SELECT 1 FROM entities WHERE id = ?").get(entityId)
    )
      return false;
    recordConflict(
      "entity_aliases",
      local.id,
      "alias_unique_superseded",
      local,
    );
    db().query("DELETE FROM entity_aliases WHERE id = ?").run(local.id);
    reapply();
    return true;
  }

  // Local alias has the lower id → it wins; discard the remote loser (recorded).
  recordConflict("entity_aliases", remoteId, "alias_unique_superseded", remote);
  return true;
}

/**
 * #1217, mirror of resolveAliasUniqueConflict for entity_relations' local-only
 * UNIQUE(entity_a, entity_b, relation): the FK-less remote keys only on `id`, so two
 * devices can push the SAME relation triple under different ids. On pull, the second one
 * violates the local triple UNIQUE and was skipped (→ divergence). Resolve it the same
 * way: the lower `id` wins on EVERY device, so both converge regardless of pull order.
 *
 * Unlike aliases, NO FK-orphan guard is needed: the collision matches on entity_a AND
 * entity_b, so the remote's endpoints are identical to the colliding local row's — which
 * exist locally (that row's own FK) — so the winner can always apply. (And even if the
 * reapply threw, the local loser is already gone, so the next pull re-applies cleanly.)
 */
export function resolveRelationUniqueConflict(
  remote: Record<string, unknown>,
  reapply: () => void,
): boolean {
  const ea = remote.entity_a;
  const eb = remote.entity_b;
  const rel = remote.relation;
  const remoteId = remote.id;
  if (
    typeof ea !== "string" ||
    typeof eb !== "string" ||
    typeof rel !== "string" ||
    typeof remoteId !== "string"
  )
    return false;
  const local = db()
    .query(
      "SELECT id, entity_a, entity_b, relation FROM entity_relations WHERE entity_a = ? AND entity_b = ? AND relation = ?",
    )
    .get(ea, eb, rel) as
    | { id: string; entity_a: string; entity_b: string; relation: string }
    | undefined;
  // No local collision, or the very same row (an ordinary update) → apply/skip normally.
  if (!local || local.id === remoteId) return false;

  if (remoteId < local.id) {
    // Remote relation has the lower id → it wins: drop the local loser (recorded, and its
    // unsuppressed delete propagates so the remote duplicate is cleaned up too) then apply.
    recordConflict(
      "entity_relations",
      local.id,
      "relation_unique_superseded",
      local,
    );
    db().query("DELETE FROM entity_relations WHERE id = ?").run(local.id);
    reapply();
    return true;
  }

  // Local relation has the lower id → it wins; discard the remote loser (recorded).
  recordConflict(
    "entity_relations",
    remoteId,
    "relation_unique_superseded",
    remote,
  );
  return true;
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
 * made while sync was OFF) are captured. Idempotent — `reconcile` only adds an
 * upsert for a live row whose latest pending entry isn't already an upsert (so a
 * row recreated after a pending delete still gets a trailing upsert; see
 * `seedOutbox`).
 */
export function enableSync(tier: SyncTier = currentSyncTier()): void {
  setTeamConfig(ENABLED_KEY, "1");
  reconcile(tier);
}

/** Disable change-capture. Leaves the outbox/state intact for re-enable. */
export function disableSync(): void {
  deleteTeamConfig(ENABLED_KEY);
}

// ---------------------------------------------------------------------------
// Invariant self-check
// ---------------------------------------------------------------------------

/**
 * Assert the sync engine's local invariants hold; throws an Error listing every
 * violation. These are the load-bearing rules the #828 bugs broke — encoding
 * them here (and calling this in tests' `afterEach`) turns every test that
 * touches sync state into a continuous regression check, instead of trusting a
 * comment. Pure, cheap COUNT/DISTINCT queries — safe to run after each test, and
 * usable as a runtime diagnostic (e.g. a future `lore data check`).
 */
export function assertSyncInvariants(): void {
  const violations: string[] = [];
  const tables = syncedTablesFor(currentSyncTier());

  // 1. Pull-only tables are server-authoritative and never pushed, so an outbox
  //    entry for one can NEVER advance its push cursor — it pins the prune floor
  //    at 0 and disables outbox pruning for ALL tables (bug #828). Must be empty.
  for (const m of tables) {
    if (!m.pullOnly) continue;
    const n = (
      db()
        .query("SELECT COUNT(*) AS n FROM sync_outbox WHERE table_name = ?")
        .get(m.table) as { n: number }
    ).n;
    if (n > 0) {
      violations.push(
        `pull-only table "${m.table}" has ${n} sync_outbox entr${n === 1 ? "y" : "ies"} — prune-floor wedge (#828)`,
      );
    }
  }

  // 2. The profiles mirror holds AT MOST the current account's row, so
  //    currentTier()'s unqualified LIMIT 1 is deterministic and a logged-out or
  //    foreign account's tier can't linger (#828). clearProfileMirror() enforces
  //    this on logout/account-switch.
  const profileRows = (
    db().query("SELECT COUNT(*) AS n FROM profiles").get() as { n: number }
  ).n;
  if (profileRows > 1) {
    violations.push(
      `profiles mirror holds ${profileRows} rows — must be <= 1 (currentTier single-row invariant, #828)`,
    );
  }

  // 3. Every outbox / sync_state row references a registered synced table — a
  //    typo or registry drift would silently strand rows the engine can't route.
  //    Use ALL registered tables (every tier), NOT the current tier's set: a
  //    downgraded ex-pro (or a Pro user before the tier mirror loads) legitimately
  //    holds sync_state/outbox rows for a Pro table while currentSyncTier() is
  //    basic — that is registry-KNOWN, not drift (#826/D).
  const known = new Set(
    [...SYNCED_TABLES.basic, ...SYNCED_TABLES.pro, ...SYNCED_TABLES.max].map(
      (m) => m.table,
    ),
  );
  for (const tbl of ["sync_outbox", "sync_state"] as const) {
    const names = db()
      .query(`SELECT DISTINCT table_name FROM ${tbl}`)
      .all() as Array<{ table_name: string }>;
    for (const { table_name } of names) {
      if (!known.has(table_name)) {
        violations.push(`${tbl} references unregistered table "${table_name}"`);
      }
    }
  }

  if (violations.length > 0) {
    throw new Error(
      `sync invariant violation(s):\n  - ${violations.join("\n  - ")}`,
    );
  }
}
