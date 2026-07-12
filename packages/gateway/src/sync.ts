/**
 * Gateway sync engine — Basic-tier logical sync of knowledge + the entity graph
 * to Supabase (see supabase/migrations/0002-0004 and @loreai/core sync-data).
 *
 * Model:
 *  - Local SQLite is the source of truth. `syncOnce()` PUSHES local changes
 *    (the outbox) BEFORE it PULLS remote changes, so our own edits/deletes reach
 *    the server before we classify incoming rows (prevents resurrecting a
 *    locally-deleted row).
 *  - Conflicts (both sides changed since last sync) resolve last-writer-to-
 *    remote-wins; the discarded local row is preserved in `sync_conflicts`.
 *  - Writes go directly to PostgREST. RLS enforces per-row ownership; in-DB
 *    triggers/CHECKs enforce volume/size. A quota rejection (HTTP 400, code
 *    23514) pauses ONLY the affected table and is surfaced to the user — it is
 *    never an error to crash on, and never blocks other tables.
 *
 * Cursors are PER TABLE so one table's failure/quota can't stall the others:
 *  - sync.push.<table>   : last outbox seq fully pushed for that table.
 *  - sync.pull.<table>   : keyset cursor "<updated_at_ms>|<row_id>" of the last
 *                          remote row applied (tie-broken by row_id, so rows
 *                          sharing a timestamp across a page boundary are not
 *                          skipped).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { asString } from "@loreai/core";
import {
  syncData,
  getKV,
  setKV,
  log,
  keystore,
  crypto,
  reinstallSyncCapture,
  convergeProjectsByRemote,
} from "@loreai/core";
import { getAuthedClient, getCurrentUser } from "./supabase";

const PAGE = 200;
const pushKey = (t: string) => `sync.push.${t}`;
const pullKey = (t: string) => `sync.pull.${t}`;

export interface SyncResult {
  pushed: number;
  pulled: number;
  conflicts: number;
  /**
   * Pulled rows skipped because they violate a LOCAL constraint the FK-less
   * remote doesn't enforce (mostly orphan refs/aliases whose entity wasn't synced
   * under the plan cap). Recorded to `sync_conflicts`; surfaced in the CLI summary.
   */
  skipped: number;
  /** Tables whose upload was paused this cycle by a quota limit. */
  quotaHit?: { table: string; message: string };
  /** Set when not logged in / session invalid (caller should prompt login). */
  notAuthed?: boolean;
}

// Tables we've already emitted a quota-pause WARN for, so a paused table (retried every
// cycle) doesn't spam the identical message every interval. Cleared when the table next
// makes real progress (a slot freed / the cap lifted), so a later re-pause warns once more.
const quotaWarnedTables = new Set<string>();

/** Test-only: reset the quota-warning dedupe state between cases. */
export function __resetQuotaWarnedTables(): void {
  quotaWarnedTables.clear();
}

/** A live progress tick, emitted per table (on entry) and after each page. */
export interface SyncProgress {
  phase: "push" | "pull";
  table: string;
  /** Cumulative rows pushed/pulled so far this cycle. */
  pushed: number;
  pulled: number;
}
export type SyncProgressFn = (p: SyncProgress) => void;

type PushErrorKind = "quota" | "poison" | "transient";

/**
 * Classify a PostgREST write error:
 *  - "quota"     : row-count limit (recoverable — a delete frees a slot). Pause
 *                  this table; keep the row pending.
 *  - "poison"    : a permanent client↔schema mismatch the row can NEVER satisfy —
 *                  a size/other CHECK violation (23514 that is NOT a quota message),
 *                  or a PostgREST request-shape/schema-cache error (PGRST1xx parsing,
 *                  PGRST2xx schema/relationship/column, e.g. PGRST204 "column not
 *                  found"). Pausing would wedge the table forever, so drop the row
 *                  past the cursor and record it; the rest of the table keeps syncing.
 *  - "transient" : network/5xx, PostgREST connection (PGRST0xx) and JWT/auth (PGRST3xx),
 *                  etc. — keep pending and retry next cycle (never lose a write).
 */
export function classifyPushError(
  err: { code?: string; message?: string } | null,
): PushErrorKind {
  if (!err) return "transient";
  const quota = /quota exceeded/i.test(err.message ?? "");
  if (err.code === "23514") return quota ? "quota" : "poison";
  // PGRST1xx (request parsing) + PGRST2xx (schema cache: relationship/function/column)
  // are a permanent payload↔schema mismatch for a request WE generate — the row can
  // never upload as-is, so treat it as poison rather than retrying forever. PGRST0xx
  // (connection) and PGRST3xx (JWT/auth) stay transient.
  if (/^PGRST[12]\d\d$/.test(err.code ?? "")) return "poison";
  return "transient";
}

/**
 * A PULLED row can violate a LOCAL constraint the FK-less remote never enforces —
 * e.g. an `entity_aliases` / `knowledge_entity_refs` / `entity_relations` row whose
 * parent entity was never admitted under the entity cap (an orphan on the remote), so
 * the local `entity_id → entities` FK rejects it. SQLite surfaces these as either a
 * `SQLITE_CONSTRAINT_*` code (bun:sqlite) or `ERR_SQLITE_ERROR` with errstr/message
 * "constraint failed" (node:sqlite; FK is errcode 787). Such a row can
 * never apply as-is, so the puller skips it (poison) instead of aborting the whole sync.
 */
export function isSqliteConstraintError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const code = String((e as { code?: string }).code ?? "");
  const errstr = String((e as { errstr?: string }).errstr ?? "");
  return (
    code.startsWith("SQLITE_CONSTRAINT") ||
    (code === "ERR_SQLITE_ERROR" &&
      /constraint/i.test(`${errstr} ${e.message}`))
  );
}

/**
 * The FK subset of {@link isSqliteConstraintError}: an orphan whose parent row
 * wasn't synced (an entity beyond the free-tier cap). This is the EXPECTED,
 * high-volume skip on a fresh device — so it's counted + recorded to
 * `sync_conflicts` but NOT logged per row (a WARN-per-orphan flood would drown
 * the console and inflate the Sentry warning stream). node:sqlite reports FK as
 * errcode 787; bun:sqlite as `SQLITE_CONSTRAINT_FOREIGNKEY`. A rarer non-FK
 * constraint skip (UNIQUE/CHECK/NOT NULL) stays visible — see the callers.
 */
function isForeignKeyError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const code = String((e as { code?: string }).code ?? "");
  const errcode = (e as { errcode?: number }).errcode;
  return (
    code === "SQLITE_CONSTRAINT_FOREIGNKEY" ||
    errcode === 787 ||
    /FOREIGN KEY constraint failed/i.test(e.message)
  );
}

/**
 * A UNIQUE (or PK) constraint violation. Used to route a pulled `entity_aliases` row that
 * collides with a local row on `UNIQUE(alias_type, alias_value)` into the deterministic
 * convergence resolver (#1217) instead of the generic skip. node:sqlite reports UNIQUE as
 * errcode 2067; bun:sqlite as `SQLITE_CONSTRAINT_UNIQUE`.
 */
function isUniqueConstraintError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const code = String((e as { code?: string }).code ?? "");
  const errcode = (e as { errcode?: number }).errcode;
  return (
    code === "SQLITE_CONSTRAINT_UNIQUE" ||
    errcode === 2067 ||
    /UNIQUE constraint failed/i.test(e.message)
  );
}

// ---------------------------------------------------------------------------
// C-4 (#825): wire encryption of knowledge content/title
// ---------------------------------------------------------------------------

/** Thrown when a pulled row is ciphertext but no DEK is available (locked/off). */
class EncryptedContentUnavailable extends Error {}

type EncMode = "off" | "locked" | "on";
// Multi-epoch (E-4c-3): a scope has one DEK PER rotation epoch. `deks` holds every epoch this
// device can decrypt; `currentEpoch` is the highest — what new content seals at.
type EncCtx = {
  scope: string;
  currentEpoch: number;
  deks: Map<number, Uint8Array>;
} | null;
/** A per-table snapshot of the encryption state handed to the (sync) apply path. */
type EncSnapshot = { mode: EncMode; ctx: EncCtx };

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

/**
 * Per-cycle encryption resolver. `mode()` is re-read per encrypted table (cheap DB
 * check) so a just-pulled escrow is visible within the same cycle; `ctx()` resolves
 * `{scope, dek}` once (scope = auth.uid() = the v1 encryption scope; dek from the
 * keystore). Only meaningful when `mode() === "on"`.
 */
function makeEncryptionResolver() {
  // E-5-F3-3: DEKs are resolved PER SCOPE (personal + any team scope in play this cycle) and
  // cached. A team-scoped row seals with its team DEK; a personal row with the personal DEK.
  const byScope = new Map<string, EncCtx>();
  let self: string | null | undefined;
  async function personalScope(): Promise<string | null> {
    if (self === undefined) self = (await getCurrentUser())?.user_id ?? null;
    return self;
  }
  // NEVER throws: any resolution failure (no user_id, a corrupt scope_keys row, an HPKE unwrap
  // error, or a team scope this device holds no wrap for yet) returns null so callers degrade
  // gracefully — push fails closed ("stop"), pull defers the table — never crashing the cycle.
  async function ctxForScope(scope: string): Promise<EncCtx> {
    const hit = byScope.get(scope);
    if (hit !== undefined) return hit;
    let result: EncCtx = null;
    try {
      const me = await personalScope();
      if (me) {
        // Pre-resolve EVERY epoch's DEK once (few epochs; keystore-cached). Keeps encrypt/decrypt
        // SYNC. `mint` is true ONLY for the caller's OWN (personal) scope, which may originate its
        // DEK; a TEAM scope MUST use the existing wrap (mint:false) — minting a fresh team DEK
        // would diverge from the real key. A team scope with no wrap yet → ScopeKeyUnavailable →
        // null → defer.
        const mint = scope === me;
        const epochs = keystore.scopeKeyEpochs(scope);
        const currentEpoch = epochs.length ? epochs[epochs.length - 1] : 0;
        const deks = new Map<number, Uint8Array>();
        for (const e of epochs.length ? epochs : [currentEpoch]) {
          deks.set(
            e,
            await keystore.getScopeKey(scope, me, { epoch: e, mint }),
          );
        }
        result = { scope, currentEpoch, deks };
      }
    } catch (e) {
      log.notice(
        `sync: encryption key unavailable for ${scope}: ${(e as Error).message}`,
      );
      result = null;
    }
    byScope.set(scope, result);
    return result;
  }
  return {
    mode: (): EncMode => keystore.encryptionState(),
    personalScope,
    ctxForScope,
    // The personal-scope ctx (auth.uid()) — the v1 default scope for non-team rows.
    async ctx(): Promise<EncCtx> {
      const p = await personalScope();
      return p ? ctxForScope(p) : null;
    },
  };
}

/**
 * Encrypt a push payload's encryptedColumns IN PLACE (seal → base64). Only non-empty
 * strings are sealed (a tombstone scrub "" stays plaintext). AAD binds each ciphertext
 * to (scope, table, column, logicalId) so it cannot be transplanted to another
 * row/column/scope.
 */
function encryptColumns(
  table: string,
  logicalId: string,
  payload: Record<string, unknown>,
  ctx: NonNullable<EncCtx>,
): void {
  // Seal new content at the scope's CURRENT epoch (the envelope pins it, so decrypt dispatches
  // to the right DEK). ctx() guarantees the current-epoch DEK; its absence is a logic error —
  // fail CLOSED (throw) rather than push plaintext.
  const dek = ctx.deks.get(ctx.currentEpoch);
  if (!dek)
    throw new Error(
      `encrypt: no DEK for ${ctx.scope} epoch ${ctx.currentEpoch}`,
    );
  for (const col of tableMeta(table).encryptedColumns ?? []) {
    const v = payload[col];
    if (typeof v !== "string" || v.length === 0) continue;
    const aad = crypto.buildAad(ctx.scope, table, col, logicalId);
    payload[col] = Buffer.from(
      crypto.seal(dek, utf8.encode(v), aad, { keyEpoch: ctx.currentEpoch }),
    ).toString("base64");
  }
}

/**
 * Decrypt a pulled row's encryptedColumns IN PLACE. In "on" mode an envelope column is
 * opened to plaintext; a non-envelope (legacy plaintext) is left as-is. If a column IS
 * an envelope but no key is available (mode !== "on"), throws so the caller skips the
 * table this cycle — never storing ciphertext as local content.
 */
function decryptColumns(
  table: string,
  logicalId: string,
  row: Record<string, unknown>,
  enc: EncSnapshot,
): void {
  for (const col of tableMeta(table).encryptedColumns ?? []) {
    const v = row[col];
    if (typeof v !== "string" || v.length === 0) continue;
    const bytes = Buffer.from(v, "base64");
    // Treat as ciphertext only if it's a real envelope AND canonical base64 (re-encodes
    // to the same string). This rejects plaintext that leniently base64-decodes to bytes
    // that merely LOOK like an envelope header — a natural-text false positive that in
    // "off" mode would otherwise wrongly abort the table. (The full fix, an explicit
    // per-row scheme flag instead of content-sniffing, is tracked for C-4b.)
    if (!crypto.isEnvelope(bytes) || bytes.toString("base64") !== v) continue;
    if (enc.mode !== "on" || !enc.ctx) {
      throw new EncryptedContentUnavailable(`${table}: no key (locked/off)`);
    }
    // Dispatch on the blob's PINNED epoch (E-4c-3): open with THAT epoch's DEK, not "current".
    // A blob sealed under an epoch we hold no wrap for (a rotation we haven't received yet, or
    // one we were removed before) defers the table until the wrap arrives — never stored as
    // ciphertext, never crashes the cycle.
    const blobEpoch = crypto.parseHeader(bytes).keyEpoch;
    const dek = enc.ctx.deks.get(blobEpoch);
    if (!dek) {
      throw new EncryptedContentUnavailable(
        `${table}: no key for epoch ${blobEpoch}`,
      );
    }
    const aad = crypto.buildAad(enc.ctx.scope, table, col, logicalId);
    try {
      row[col] = fromUtf8.decode(crypto.open(dek, bytes, aad));
    } catch (e) {
      // A valid envelope we hold a key for but still can't open (wrong key / tampered /
      // AAD mismatch) is an integrity failure. NEVER store the ciphertext and NEVER let
      // a raw AEAD error crash the whole (multi-table) sync cycle — surface it as an
      // EncryptedContentUnavailable so the caller defers just this table (cursor frozen).
      throw new EncryptedContentUnavailable(
        `${table}.${col}: decrypt failed: ${(e as Error).message}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Push (per table — independent cursor; advance only past confirmed rows)
// ---------------------------------------------------------------------------

/**
 * Push pending local changes for every synced table. Each table is drained
 * independently: a quota or transient failure on one table never advances its
 * cursor past the unpushed row and never blocks another table.
 */
export async function pushOnce(
  client: SupabaseClient,
  onProgress?: SyncProgressFn,
): Promise<SyncResult> {
  const res: SyncResult = { pushed: 0, pulled: 0, conflicts: 0, skipped: 0 };
  const enc = makeEncryptionResolver();
  for (const meta of syncData.syncedTablesFor(syncData.currentSyncTier())) {
    // Pull-only tables (e.g. profiles) are server-authoritative: the client only
    // reads them. They have no outbox capture trigger, so this is belt-and-
    // suspenders, but it keeps the intent explicit and avoids a needless scan.
    if (meta.pullOnly) continue;
    onProgress?.({
      phase: "push",
      table: meta.table,
      pushed: res.pushed,
      pulled: res.pulled,
    });
    await pushTable(client, meta.table, res, enc, onProgress);
  }
  // Reclaim outbox rows fully pushed across all tables THAT HAVE ENTRIES (seq <=
  // the lowest such cursor) — the outbox is otherwise append-only. A table with
  // no entries must NOT pin the floor at its cursor 0, which would block all
  // pruning forever (the common case: a project with knowledge but no relations).
  // Pull-only tables are never pushed, so their cursor never advances past 0 —
  // exclude them too (defense-in-depth: nothing should enqueue them, but if a
  // stray entry existed it must not wedge the prune floor at 0).
  const cursors = syncData
    .syncedTablesFor(syncData.currentSyncTier())
    .filter((m) => !m.pullOnly && syncData.hasOutboxEntries(m.table))
    .map((m) => Number(getKV(pushKey(m.table)) ?? "0"));
  if (cursors.length > 0) {
    const minCursor = Math.min(...cursors);
    if (Number.isFinite(minCursor)) syncData.pruneOutbox(minCursor);
  }
  return res;
}

async function pushTable(
  client: SupabaseClient,
  table: string,
  res: SyncResult,
  enc: ReturnType<typeof makeEncryptionResolver>,
  onProgress?: SyncProgressFn,
): Promise<void> {
  let cursor = Number(getKV(pushKey(table)) ?? "0");

  for (;;) {
    // Pull a page of THIS table's outbox entries in seq order (SQL-filtered, so
    // other tables' entries can never starve this one).
    const batch = syncData.readOutbox(cursor, PAGE, table);
    if (batch.length === 0) break;

    // Coalesce to the latest op per row, but REMEMBER the highest seq each row
    // occupies so we can advance the cursor safely.
    const latestByRow = new Map<string, syncData.OutboxEntry>();
    for (const e of batch) latestByRow.set(e.row_id, e);

    // Walk entries in seq order; advance `cursor` only across a contiguous
    // prefix of rows that are confirmed pushed (or no-ops). Stop advancing at
    // the first row that failed or was quota-paused, leaving it pending.
    let safeCursor = cursor;
    let stop = false;
    for (const e of batch) {
      // Only act on the coalesced (latest) entry for a row; earlier duplicates
      // are covered by it. But every entry still gates cursor advancement.
      if (latestByRow.get(e.row_id) === e) {
        const outcome = await pushEntry(client, e, res, enc);
        if (outcome === "stop") {
          stop = true;
          break; // do NOT advance past this seq — retry next cycle
        }
        // "ok" → fall through and advance
      }
      safeCursor = e.seq;
    }

    cursor = safeCursor;
    setKV(pushKey(table), String(cursor));
    onProgress?.({
      phase: "push",
      table,
      pushed: res.pushed,
      pulled: res.pulled,
    });
    if (stop || batch.length < PAGE) break;
  }
}

type PushOutcome = "ok" | "stop";

/** Push one coalesced outbox entry. "stop" => leave it pending (quota/error). */
async function pushEntry(
  client: SupabaseClient,
  e: syncData.OutboxEntry,
  res: SyncResult,
  enc: ReturnType<typeof makeEncryptionResolver>,
): Promise<PushOutcome> {
  const { table_name: table, row_id: rowId } = e;
  let op = e.op;
  // The remote row key. For knowledge the outbox is logical_id-keyed (#909) and the
  // remote is a CURRENT-only mirror keyed by logical_id, so the outbox rowId already
  // IS the remote key — sync_state + the upsert/delete operate on it directly. For
  // every other table this also stays the outbox rowId.
  let effectiveId = rowId;
  // For a knowledge upsert, the row to push is the CURRENT version's content
  // (re-keyed id=logical_id) — resolved by the push plan.
  let knowledgeRow: Record<string, unknown> | undefined;

  // A2 (#823): knowledge is append-only — update()/remove() append immutable
  // versions and remove() emits no physical-delete op. The plan coalesces all of an
  // entry's versions to ONE remote row keyed by logical_id: a live current → upsert
  // that content; no live current (every version superseded/deleted) → soft-delete.
  if (table === "knowledge") {
    if (op === "upsert") {
      // rowId is the logical_id (the outbox is logical_id-keyed, #909): a live
      // current → upsert that content; no live current → delete.
      const plan = syncData.knowledgePushPlan(rowId);
      effectiveId = plan.logicalId;
      op = plan.op;
      if (plan.op === "upsert") knowledgeRow = plan.row;
    } else {
      // op === "delete" (a physical-delete capture, keyed by logical_id). Re-validate
      // liveness: if the entry STILL has a live current version — i.e. a SUPERSEDED
      // version was physically deleted while the entry lives on — this is NOT a
      // deletion; re-push the current content instead. Only a genuinely dead entry
      // (no live current) propagates as a remote delete. Guards a future compaction
      // (sub-PR 4) that prunes superseded versions from falsely deleting a live remote
      // entry. (We re-validate directly rather than reusing the upsert plan to keep
      // the delete-vs-revive decision explicit on this branch.)
      const live = syncData.currentKnowledgeRow(rowId);
      if (live) {
        op = "upsert";
        knowledgeRow = live;
      }
      // effectiveId stays rowId (= logical_id, the remote key) for both branches.
    }
  }

  if (op === "delete") {
    // Append-only tables (temporal_messages) never enqueue a delete — reconcile skips
    // them and they have no capture DELETE trigger — so this branch is unreachable for
    // them; guard defensively anyway (their remote has no is_deleted column).
    const tombstone: Record<string, unknown> = {};
    if (!tableMeta(table).appendOnly) tombstone.is_deleted = true;
    // Only versioned tables have a content_hash column remotely; the join table
    // (knowledge_entity_refs) does not, so sending it is a PGRST204 schema error. This
    // gate prevents that; and even a stray schema error is now classified as poison
    // (dropped, not an infinite-retry wedge) by the error handling below.
    // Mirror the upsert path's `meta.versioned` gate. Nulling it honors the tombstone's
    // "remoteHash is null" contract on the wire (the pull side already treats is_deleted
    // rows as hash-null, but this also protects un-upgraded readers during a rollout).
    if (tableMeta(table).versioned !== false) {
      tombstone.content_hash = null;
    }
    // Erasure completeness (#823): scrub the deleted knowledge content-bearing
    // columns from the remote tombstone so the bytes don't linger server-side until
    // the sub-PR 4 reaper. The LOCAL death-cert preserves them, and
    // applyRemoteKnowledgeDelete rebuilds a peer's death-cert from its OWN current
    // row, so peers are unaffected. (Remote content/title are NOT NULL → ''; metadata
    // is nullable → null.)
    if (table === "knowledge") {
      tombstone.content = "";
      tombstone.title = "";
      tombstone.metadata = null;
    }
    const { error } = await client
      .from(table)
      .update(tombstone)
      .match(decomposeId(table, effectiveId));
    if (error) {
      const kind = classifyPushError(error);
      if (kind === "poison") {
        // A permanent schema/payload mismatch on the tombstone (e.g. PGRST204) can NEVER
        // upload — record it and advance PAST it rather than wedging the table on infinite
        // transient retries. Mirrors the upsert poison path (no res.pushed++, no re-warn).
        log.notice(
          `sync: dropping unsyncable delete ${table}/${effectiveId}: ${error.message}`,
        );
        syncData.recordConflict(
          table,
          effectiveId,
          "rejected_unsyncable",
          tombstone,
        );
        const prev = syncData.getSyncState(table, effectiveId);
        syncData.setSyncState(table, effectiveId, {
          content_hash: null,
          revision: (prev?.revision ?? 0) + 1,
          remote_updated_at: prev?.remote_updated_at ?? null,
          scope_id: prev?.scope_id ?? null,
        });
        return "ok"; // advance past the poison delete
      }
      // quota (degenerate for a soft-delete) or transient — keep pending and retry so the
      // delete is never lost.
      log.notice(`sync: push delete ${table}/${effectiveId}: ${error.message}`);
      return "stop";
    }
    const prev = syncData.getSyncState(table, effectiveId);
    syncData.setSyncState(table, effectiveId, {
      content_hash: null,
      revision: (prev?.revision ?? 0) + 1,
      remote_updated_at: prev?.remote_updated_at ?? null,
      scope_id: prev?.scope_id ?? null,
    });
    quotaWarnedTables.delete(table); // real progress → a future re-pause may warn again
    res.pushed++;
    return "ok";
  }

  // upsert — for knowledge, `knowledgeRow` is the CURRENT version keyed by logical_id.
  const row = knowledgeRow ?? syncData.getRowById(table, rowId);
  if (!row) return "ok"; // row gone; a later delete entry (if any) handles it
  const hash = syncData.contentHash(table, row);
  const state = syncData.getSyncState(table, effectiveId);
  // E-5-F3-3: which scope this row must live in — a team scope iff it's approved+bound (knowledge)
  // or linked into a team (entity graph), else null (personal). A scope CHANGE (e.g. approval into
  // a team) is invisible to content_hash, so we detect it via the last-pushed scope in sync_state
  // and MIGRATE — otherwise the hash short-circuit below would skip it and the promotion would
  // never reach the team.
  const teamScope = syncData.teamScopeForContent(table, effectiveId);
  const priorScope = state?.scope_id ?? null;
  const scopeChanged = teamScope !== priorScope;
  if (state?.content_hash === hash && !scopeChanged) {
    res.pushed++; // already in sync (same content AND scope) — no-op
    return "ok";
  }
  // Only injected/migrated when a team scope is involved (now or previously) — pure-personal rows
  // keep relying on the remote `auth.uid()` default, so their behavior is unchanged.
  const teamInvolved = teamScope !== null || priorScope !== null;
  // Resolve the personal scope (auth.uid()) ONLY when actually needed — a team is involved, or the
  // row is encrypted AND encryption is on (the DEK path). This avoids a getCurrentUser() call on the
  // pure-personal-plaintext push path (matching the pre-F3-3 behavior, where getCurrentUser ran only
  // when encryption was on).
  const encOn =
    (tableMeta(table).encryptedColumns?.length ?? 0) > 0 && enc.mode() === "on";
  const personal = teamInvolved || encOn ? await enc.personalScope() : null;
  // The scope_id this push targets on the wire (team if promoted, else the personal scope).
  const targetScope = teamScope ?? personal;
  // C-4 (#825) + F3-3: resolve the TARGET scope's encryption context (DEK) BEFORE any migration
  // delete, so a fail-closed pause never happens AFTER we've already deleted the old-scope copy
  // (which would leave a transient remote gap). "locked" (escrow present, device not unlocked) or an
  // unresolvable DEK (e.g. a team wrap not on this device yet) → pause the table (keep pending),
  // never leak plaintext. content_hash is over the PLAINTEXT row, so it stays cross-device stable.
  let encCtx: NonNullable<EncCtx> | null = null;
  if (tableMeta(table).encryptedColumns?.length) {
    const mode = enc.mode();
    if (mode === "locked") return "stop";
    if (mode === "on") {
      if (!targetScope) return "stop";
      const ctx = await enc.ctxForScope(targetScope);
      if (!ctx) return "stop";
      encCtx = ctx;
    }
  }
  // Scope migration: the row moved scopes → hard-delete it from the OLD scope on the remote before
  // pushing under the new one (its old-scope copy is now obsolete — this is a move, not a delete).
  // Best-effort; only when the row was previously pushed (state exists). Runs AFTER the DEK check
  // above so we never delete the old copy and then fail to push the new one.
  if (scopeChanged && state) {
    const oldScopeId = priorScope ?? personal;
    if (oldScopeId) {
      const { error: delErr } = await client
        .from(table)
        .delete()
        .match({ scope_id: oldScopeId, ...decomposeId(table, effectiveId) });
      if (delErr) {
        // Don't block the new-scope push on a stale-copy cleanup failure; a later reconcile/reaper
        // collects it. Keep the row pending only on a transient error.
        if (classifyPushError(delErr) === "transient") {
          log.notice(
            `sync: scope-migrate delete ${table}/${effectiveId} from ${oldScopeId}: ${delErr.message}`,
          );
          return "stop";
        }
      }
    }
  }

  const revision = (state?.revision ?? 0) + 1;
  // Only the synced data columns (the remote 0002 contract) — never local-only
  // columns like knowledge.promoted_at, which the remote rejects (PGRST204).
  const payload: Record<string, unknown> = {
    ...toRemoteRow(table, syncData.pickSyncColumns(table, row)),
  };
  // Every table carries is_deleted EXCEPT append-only ones (temporal_messages), whose
  // remote 0020 schema has no such column — sending it is a PGRST204 that poisons the
  // whole table (#826/D). versioned is the wrong gate (the join table is versioned:false
  // yet HAS is_deleted).
  if (!tableMeta(table).appendOnly) payload.is_deleted = false;
  // E-5-F3-3: for a team-involved row, set scope_id EXPLICITLY (team scope, or the personal scope
  // on a migrate-back) rather than relying on the remote auth.uid() default. Pure-personal rows
  // omit it and keep the default — no behavior change.
  if (teamInvolved && targetScope) payload.scope_id = targetScope;
  // Seal the content columns with the TARGET scope's DEK (resolved above, before the migration).
  if (encCtx) encryptColumns(table, effectiveId, payload, encCtx);
  // Only versioned tables have content_hash/revision columns remotely; sending
  // them to the join table is a PGRST204 schema error (and would never sync it).
  if (tableMeta(table).versioned !== false) {
    payload.content_hash = hash;
    payload.revision = revision;
  }
  // insertOnly tables (scope_keys) push via a plain INSERT — a wrap is immutable per
  // (scope, member, epoch), and UPSERT's internal RETURNING can't pass scope_keys_read for a
  // co-member wrap (own-wrap-only), so an admin group-wrapping would get 42501. Every other
  // table UPSERTs: the REMOTE PK is composite (scope_id, <idColumns>), so the ON CONFLICT target
  // includes scope_id; scope_id is filled by the column's auth.uid() default (v1: scope = user).
  const insertOnly = tableMeta(table).insertOnly === true;
  const { error } = insertOnly
    ? await client.from(table).insert(payload)
    : await client.from(table).upsert(payload, {
        onConflict: ["scope_id", ...idColumns(table)].join(","),
      });

  if (error) {
    // insertOnly re-push: the immutable row already exists (unique_violation) → already synced,
    // so advance rather than retry forever. (An immutable wrap can't legitimately differ.)
    if (insertOnly && error.code === "23505") {
      syncData.setSyncState(table, effectiveId, {
        content_hash: hash,
        revision,
        remote_updated_at: state?.remote_updated_at ?? null,
        scope_id: teamScope,
      });
      res.pushed++;
      return "ok";
    }
    const kind = classifyPushError(error);
    if (kind === "quota") {
      if (!res.quotaHit) res.quotaHit = { table, message: error.message };
      // Warn ONCE per pause — the row stays pending and is retried every cycle, so
      // logging unconditionally spams the same message at the sync interval forever.
      if (!quotaWarnedTables.has(table)) {
        log.notice(`sync: quota on ${table} — ${error.message}`);
        quotaWarnedTables.add(table);
      }
      return "stop"; // pause THIS table; keep the row pending (a delete frees it)
    }
    if (kind === "poison") {
      // The row violates a size/other CHECK and can NEVER be uploaded. Do NOT
      // pause the table (that would wedge it forever) — record it and advance
      // past it so the rest of the table keeps syncing.
      log.notice(
        `sync: dropping unsyncable ${table}/${effectiveId}: ${error.message}`,
      );
      syncData.recordConflict(table, effectiveId, "rejected_unsyncable", row);
      // Mark as "synced" to this hash so we don't retry the same poison row.
      syncData.setSyncState(table, effectiveId, {
        content_hash: hash,
        revision,
        remote_updated_at: state?.remote_updated_at ?? null,
        scope_id: teamScope,
      });
      return "ok";
    }
    log.notice(`sync: push upsert ${table}/${effectiveId}: ${error.message}`);
    return "stop"; // transient — keep pending so we retry (never lose a write)
  }

  syncData.setSyncState(table, effectiveId, {
    content_hash: hash,
    revision,
    remote_updated_at: state?.remote_updated_at ?? null,
    scope_id: teamScope, // record the scope we pushed under (null = personal) for future migration
  });
  quotaWarnedTables.delete(table); // real progress → a future re-pause may warn again
  res.pushed++;
  return "ok";
}

// ---------------------------------------------------------------------------
// Pull (per table — keyset cursor on (updated_at, row_id))
// ---------------------------------------------------------------------------

interface KeysetCursor {
  ms: number;
  id: string;
}

function parseCursor(raw: string | null): KeysetCursor {
  if (!raw) return { ms: 0, id: "" };
  const sep = raw.lastIndexOf("|");
  if (sep < 0) return { ms: Date.parse(raw) || 0, id: "" };
  return { ms: Number(raw.slice(0, sep)) || 0, id: raw.slice(sep + 1) };
}

function formatCursor(c: KeysetCursor): string {
  return `${c.ms}|${c.id}`;
}

/**
 * Pull remote rows changed since each table's keyset cursor and apply them
 * locally under suppression. The cursor is `(updated_at_ms, row_id)`: we page by
 * `updated_at >= cursor.ms` and skip rows we've already applied (<= cursor in
 * keyset order), so rows that share a timestamp across a page boundary are never
 * dropped. Timestamps are compared as parsed instants, not lexical ISO strings.
 */
export async function pullOnce(
  client: SupabaseClient,
  onProgress?: SyncProgressFn,
): Promise<SyncResult> {
  const res: SyncResult = { pushed: 0, pulled: 0, conflicts: 0, skipped: 0 };
  const encResolver = makeEncryptionResolver();

  for (const meta of syncData.syncedTablesFor(syncData.currentSyncTier())) {
    // Emit BEFORE the locked/skip guards so a skipped table still advances the bar.
    onProgress?.({
      phase: "pull",
      table: meta.table,
      pushed: res.pushed,
      pulled: res.pulled,
    });
    const touchedFts = new Set<string>();
    let cursor = parseCursor(getKV(pullKey(meta.table)));

    // C-4 (#825): resolve the encryption snapshot for an encrypted table. "locked"
    // (escrow present, not unlocked) → skip the table entirely, leaving its cursor
    // frozen so it re-pulls after unlock (never storing ciphertext as content). The
    // key tables are ordered BEFORE knowledge, so on a fresh device the escrow is
    // already local here → "locked", never a plaintext-passthrough "off".
    let enc: EncSnapshot = { mode: "off", ctx: null };
    if (meta.encryptedColumns?.length) {
      const mode = encResolver.mode();
      if (mode === "locked") continue;
      if (mode === "on") {
        const ctx = await encResolver.ctx(); // never throws (returns null on failure)
        if (!ctx) continue; // can't resolve the key → defer the table this cycle
        enc = { mode, ctx };
      }
    }

    const skippedBefore = res.skipped;
    try {
      for (;;) {
        const sinceIso = new Date(cursor.ms).toISOString();
        // Page by (updated_at, id). `gte` includes cursor.ms; the in-memory keyset
        // skip drops rows already applied. (timestamptz is compared by VALUE, so
        // Z vs +00:00 / fractional formats are equivalent.)
        // Order by (updated_at, <FULL composite id>) — every id column, not just the first.
        // The in-memory keyset skip (below) compares the FULL composite rowIdOf; if the page
        // were ordered by only idColumns[0], two rows sharing (updated_at, idColumns[0]) but
        // differing in a later id column could arrive in reverse-keyset order, and the one
        // sorting earlier in the full keyset would be wrongly skipped (never applied) after the
        // cursor advanced past the other. For scope_keys that means a member's lower-epoch wrap
        // could be dropped when it shares updated_at with a higher epoch (E-4c-3). Matches
        // drainTimestamp, which already keysets on the full composite.
        let q = client
          .from(meta.table)
          .select("*")
          .order("updated_at", { ascending: true });
        for (const c of meta.idColumns) q = q.order(c, { ascending: true });
        q = q.limit(PAGE).gte("updated_at", sinceIso);
        const { data, error } = await q;
        if (error) {
          log.notice(`sync: pull ${meta.table}: ${error.message}`);
          break;
        }
        const rows = (data ?? []) as Array<Record<string, unknown>>;
        if (rows.length === 0) break;

        let advanced = false;
        for (const remote of rows) {
          const ms = Date.parse(asString(remote.updated_at)) || 0;
          const rid = syncData.rowIdOf(meta.table, remote);
          if (ms < cursor.ms || (ms === cursor.ms && rid <= cursor.id))
            continue;
          try {
            applyRemote(meta, remote, res, touchedFts, enc);
          } catch (e) {
            // A ciphertext row we can't decrypt defers the WHOLE table (outer catch,
            // no cursor advance) so it re-pulls once the key is available. Everything
            // else (constraint) is resolved-or-skipped by the shared handler, then the
            // cursor advances below so ONE poison row can't wedge the sync.
            handlePulledRowConstraint(
              meta,
              remote,
              rid,
              e,
              res,
              touchedFts,
              enc,
            );
          }
          cursor = { ms, id: rid };
          advanced = true;
        }
        setKV(pullKey(meta.table), formatCursor(cursor));
        onProgress?.({
          phase: "pull",
          table: meta.table,
          pushed: res.pushed,
          pulled: res.pulled,
        });

        if (rows.length < PAGE) break; // last page

        if (!advanced) {
          // A FULL page with no NEW rows ⇒ >PAGE rows share cursor.ms and `gte`
          // keeps returning the same first PAGE. Drain the REST of this exact
          // millisecond by id keyset (eq + id>cursor) before resuming — this never
          // skips a row (we only advance past ids we've actually applied).
          const drained = await drainTimestamp(
            client,
            meta,
            sinceIso,
            cursor,
            res,
            touchedFts,
            enc,
          );
          cursor = drained;
          setKV(pullKey(meta.table), formatCursor(cursor));
        }
      }
    } catch (err) {
      if (!(err instanceof EncryptedContentUnavailable)) throw err;
      // A ciphertext row we can't decrypt (no key this cycle, or an integrity failure):
      // abort THIS table WITHOUT persisting a further cursor advance, so it re-pulls
      // next cycle — never crashing the whole (multi-table) sync. (applyRemote decrypts
      // BEFORE any side effect, so no partial row was applied.)
      log.notice(`sync: pull ${meta.table} deferred — ${err.message}`);
    }

    // One debug-gated summary per table for the (mostly FK-orphan) skips — the
    // per-row detail is intentionally silent, so this is the diagnosable trace.
    const skippedHere = res.skipped - skippedBefore;
    if (skippedHere > 0)
      log.info(
        `sync: pull ${meta.table} skipped ${skippedHere} row(s) failing a local constraint (mostly orphans whose parent wasn't synced under the plan cap)`,
      );

    for (const fts of touchedFts) syncData.rebuildFts(fts);
  }
  return res;
}

/**
 * Drain rows that share exactly `iso` (one millisecond) beyond `cursor.id`,
 * paging by id keyset (`updated_at == iso AND id > lastId`). Used when >PAGE
 * rows collide on one timestamp so the primary `gte` page can't advance.
 *
 * Keysets by the FULL primary key, in id-column order: `(c1 > v1) OR (c1 = v1
 * AND c2 > v2) ...`. We page one id-column boundary at a time using only simple
 * `.gt`/`.eq` filters (no fragile `.or()` timestamp encoding): advance the last
 * id column with `.gt`, and when it's exhausted step the preceding column.
 */
async function drainTimestamp(
  client: SupabaseClient,
  meta: syncData.SyncTableMeta,
  iso: string,
  cursor: KeysetCursor,
  res: SyncResult,
  touchedFts: Set<string>,
  enc: EncSnapshot,
): Promise<KeysetCursor> {
  const cols = meta.idColumns;
  // Per-id-column "last applied" values; seed from the cursor's composite id.
  const last = cursor.id ? cursor.id.split("\x1f") : cols.map(() => "");
  for (;;) {
    // Fetch rows at this ms strictly after `last` in composite-key order. We
    // filter on the LAST id column with `.gt(last)` and pin the preceding
    // columns with `.eq(last)`; when a prefix is exhausted we widen below.
    let q = client.from(meta.table).select("*").eq("updated_at", iso);
    for (let i = 0; i < cols.length - 1; i++) q = q.eq(cols[i], last[i]);
    q = q.gt(cols[cols.length - 1], last[cols.length - 1]);
    for (const c of cols) q = q.order(c, { ascending: true });
    const { data, error } = await q.limit(PAGE);
    if (error) {
      log.notice(`sync: pull drain ${meta.table}: ${error.message}`);
      break;
    }
    let rows = (data ?? []) as Array<Record<string, unknown>>;

    if (rows.length === 0) {
      // No more rows under the current prefix. For a single-id table that means
      // we're done. For a composite key, step the FIRST id column past `last[0]`
      // and reset the rest, to cover other groups at this same ms.
      if (cols.length === 1) break;
      const { data: next, error: nextErr } = await client
        .from(meta.table)
        .select("*")
        .eq("updated_at", iso)
        .gt(cols[0], last[0])
        .order(cols[0], { ascending: true })
        .order(cols[1], { ascending: true })
        .limit(PAGE);
      if (nextErr) {
        log.notice(`sync: pull drain ${meta.table}: ${nextErr.message}`);
        break;
      }
      rows = (next ?? []) as Array<Record<string, unknown>>;
      if (rows.length === 0) break;
    }

    for (const remote of rows) {
      const rid = syncData.rowIdOf(meta.table, remote);
      try {
        applyRemote(meta, remote, res, touchedFts, enc);
      } catch (e) {
        // Same resolve-or-skip as the primary loop (incl. #1217 alias convergence) so
        // the drain path — used when >PAGE rows share one exact ms — can't diverge or
        // wedge; `last`/`cursor` still advance below.
        handlePulledRowConstraint(meta, remote, rid, e, res, touchedFts, enc);
      }
      cols.forEach((c, i) => {
        last[i] = String(remote[c]);
      });
      cursor = { ms: cursor.ms, id: rid };
    }
  }
  // Past this millisecond entirely; the next primary page resumes at ms+1.
  return { ms: cursor.ms + 1, id: "" };
}

/**
 * Handle a constraint error thrown while applying a pulled row — shared by the primary
 * pull loop and the `drainTimestamp` path so both converge identically. Rethrows
 * encryption + non-constraint errors (the caller aborts the table). Otherwise: an
 * entity_aliases UNIQUE(alias_type, alias_value) collision is resolved deterministically
 * (#1217, the lower alias id wins on every device); anything else (FK orphan / CHECK /
 * NOT NULL) is skipped so one poison row can't abort the whole multi-table sync or wedge
 * the cursor. The caller advances the cursor after this returns.
 */
function handlePulledRowConstraint(
  meta: syncData.SyncTableMeta,
  remote: Record<string, unknown>,
  rid: string,
  e: unknown,
  res: SyncResult,
  touchedFts: Set<string>,
  enc: EncSnapshot,
): void {
  if (e instanceof EncryptedContentUnavailable) throw e;
  if (!isSqliteConstraintError(e)) throw e;
  // Deterministic convergence for a local-only secondary UNIQUE the FK-less remote
  // doesn't enforce (entity_aliases (type,value); entity_relations (a,b,relation)): the
  // lower id wins on every device, so pull order can't leave devices divergent (#1217).
  // Falls through to the generic skip when there's no local collision / it's an orphan.
  if (isUniqueConstraintError(e)) {
    const reapply = () => applyRemote(meta, remote, res, touchedFts, enc);
    if (
      (meta.table === "entity_aliases" &&
        syncData.resolveAliasUniqueConflict(remote, reapply)) ||
      (meta.table === "entity_relations" &&
        syncData.resolveRelationUniqueConflict(remote, reapply))
    ) {
      res.conflicts++;
      return;
    }
  }
  res.skipped++;
  syncData.recordConflict(meta.table, rid, "pull_constraint_skip", remote);
  // FK orphans (parent beyond the plan cap) are EXPECTED + high-volume on a fresh device
  // — count them (surfaced in the CLI summary + recorded to sync_conflicts) but DON'T log
  // per row, or a WARN-per-orphan flood drowns the console and inflates the Sentry
  // warning stream. A rarer non-FK skip (CHECK/NOT NULL) is unexpected → keep it visible.
  if (!isForeignKeyError(e))
    log.notice(
      `sync: pull ${meta.table} skipped a row (${rid}): ${(e as Error).message}`,
    );
}

function applyRemote(
  meta: syncData.SyncTableMeta,
  remote: Record<string, unknown>,
  res: SyncResult,
  touchedFts: Set<string>,
  enc: EncSnapshot,
): void {
  const rowId = syncData.rowIdOf(meta.table, remote);

  // A2 sub-PR 3b-2: the CRDT counter table is a grow-only join-semilattice — its
  // per-key MAX merge is idempotent + monotonic, so a remote row is ALWAYS safe to
  // apply (a stale lower counter never lowers the local value). Apply unconditionally
  // (no hash classify, never a skip/conflict). Track sync_state from the MERGED LOCAL
  // row so the push side sees the post-merge value as in-sync and never re-pushes a
  // peer's counter (this device only pushes its OWN replica's rows).
  if (meta.table === "knowledge_meta_crdt") {
    syncData.applyRemoteMetaCrdt(stripSyncCols(remote));
    const localRow = syncData.getRowById(meta.table, rowId);
    syncData.setSyncState(meta.table, rowId, {
      content_hash: localRow
        ? syncData.contentHash(meta.table, localRow)
        : null,
      revision: 0,
      remote_updated_at: asString(remote.updated_at),
    });
    res.pulled++;
    return;
  }

  const isDeleted = remote.is_deleted === true || remote.is_deleted === 1;

  // classifyRemoteRow's contract: "remoteHash is null for a tombstone". A delete
  // has no content to compare, so a tombstone is NEVER a content-match "skip".
  // Honor that here regardless of the row's stored content_hash — pushEntry nulls
  // only the LOCAL sync_state on delete, so a remote tombstone keeps its hash on
  // the wire; without this, a cross-client / post-conflict delete whose hash still
  // matches local content is mis-classified "skip" and silently dropped.
  const remoteHash =
    !isDeleted && typeof remote.content_hash === "string"
      ? remote.content_hash
      : null;

  // Unpushed local intent for this row (push runs first, but a quota-paused or
  // failed push can leave one pending) → never fast-forward over it.
  const pushCursor = Number(getKV(pushKey(meta.table)) ?? "0");
  // Knowledge is keyed by logical_id everywhere (remote + outbox, #909), so the
  // pending check matches the remote rowId (= logical_id) directly (A2, #823).
  const pendingLocalChange =
    meta.table === "knowledge"
      ? syncData.hasPendingKnowledgeChange(rowId, pushCursor)
      : syncData.hasPendingChange(meta.table, rowId, pushCursor);
  // Pull-only tables are server-authoritative — the client never writes them, so
  // local divergence (a "conflict") is impossible by construction. classifyRemoteRow
  // would otherwise flag every change as a conflict: these tables carry no remote
  // content_hash (remoteHash === null), so its identical-content "skip" can never
  // fire and a re-pulled row (e.g. a billing-driven tier flip) would look diverged.
  // Always take the remote. The pull cursor already skips unchanged rows.
  const cls: syncData.RemoteClass = meta.pullOnly
    ? "apply"
    : syncData.classifyRemoteRow(meta.table, rowId, remoteHash, {
        pendingLocalChange,
      });

  if (cls === "skip") return;

  // C-4/E-5-F3-3: decrypt the content columns AFTER the skip check but BEFORE any conflict side
  // effect (recordConflict) or apply — so (a) a clean ECHO of our OWN push (a team-scoped row comes
  // back sealed with the TEAM DEK) is skipped without needing that scope's key here, and (b) a
  // non-decryptable ciphertext still throws and aborts the table cleanly with nothing applied.
  // (Consumer-side multi-scope pull decrypt of OTHER members' team rows is F2.)
  let decrypted: Record<string, unknown> | undefined;
  if (meta.encryptedColumns?.length && !isDeleted) {
    decrypted = stripSyncCols(remote);
    decryptColumns(meta.table, rowId, decrypted, enc);
  }

  if (cls === "conflict") {
    res.conflicts++;
    // Preserve the local row we're about to overwrite (LWW = remote wins). For
    // knowledge, snapshot the CURRENT version (keyed by logical_id) — not the
    // demoted physical row getRowById would return — so the discarded edit is
    // actually recoverable from sync_conflicts.local_content (#823).
    const localBefore =
      meta.table === "knowledge"
        ? syncData.currentKnowledgeRow(rowId)
        : syncData.getRowById(meta.table, rowId);
    syncData.recordConflict(
      meta.table,
      rowId,
      isDeleted ? "remote_delete_wins" : "remote_upsert_wins",
      localBefore,
    );
  }

  if (isDeleted) {
    // Knowledge applies a remote delete as a death-cert version (append-only),
    // not a physical row delete (A2, #823).
    if (meta.table === "knowledge") {
      syncData.applyRemoteKnowledgeDelete(rowId);
    } else {
      syncData.applyRemoteDelete(meta.table, rowId);
    }
    syncData.clearSyncState(meta.table, rowId);
    for (const fts of meta.ftsTables) touchedFts.add(fts);
  } else {
    // Knowledge applies a remote content change as a new version (append-only),
    // never an in-place upsert of an immutable version (A2, #823).
    if (meta.table === "knowledge") {
      // `decrypted` is the stripped row with content/title decrypted (C-4).
      syncData.applyRemoteKnowledge(decrypted ?? stripSyncCols(remote));
    } else if (meta.table === "knowledge_meta") {
      // A2 3b-2: upsert the immutable base_confidence + re-materialize confidence
      // (the materialized value & local decay clock are never overwritten by pull).
      syncData.applyRemoteMeta(stripSyncCols(remote));
    } else if (meta.table === "scope_keys") {
      // C-3 (#825): pass the FULL remote row — the handler reconstructs the local
      // NOT-NULL scope_id from remote.scope_id (stripSyncCols would drop it).
      syncData.applyRemoteScopeKey(remote);
    } else if (meta.table === "temporal_messages") {
      // D (#826): mark the restored message distilled=1 (archival, never re-distill)
      // and stamp restored_at so the prune keys off local residency, not origin
      // created_at (B3). `decrypted` carries the plaintext content/metadata (C-4).
      syncData.applyRemoteTemporal(decrypted ?? stripSyncCols(remote));
    } else if (meta.table === "projects") {
      // #1246: seed a synthetic-path FK parent / backfill identity. `decrypted` carries
      // the plaintext git_remote/name (C-4). Same-remote dupes are merged post-pull by
      // convergeProjectsByRemote (see syncOnce).
      syncData.applyRemoteProject(decrypted ?? stripSyncCols(remote));
    } else if (meta.table === "scope_members") {
      // E-5 (#827): scope_members.scope_id is REAL data (half the PK), not the remote-only
      // tenant column stripSyncCols drops — keep it so the local upsert has a non-null PK.
      syncData.applyRemoteUpsert(
        "scope_members",
        stripSyncCols(remote, SCOPE_MEMBER_KEEP),
      );
    } else {
      syncData.applyRemoteUpsert(meta.table, stripSyncCols(remote));
    }
    syncData.setSyncState(meta.table, rowId, {
      content_hash: remoteHash,
      revision: typeof remote.revision === "number" ? remote.revision : 0,
      remote_updated_at: asString(remote.updated_at),
    });
    for (const fts of meta.ftsTables) touchedFts.add(fts);
  }
  res.pulled++;
}

// ---------------------------------------------------------------------------
// syncOnce — push then pull
// ---------------------------------------------------------------------------

/**
 * Report this device's per-table pull progress so the server-side reaper only reaps a
 * tombstone once EVERY active device in the scope has pulled past it (#909 watermark) —
 * no client reconcile-by-absence needed, which the eviction model forbids. Best-effort:
 * a failure never breaks sync. `last_seen` is server-stamped (a client can't fake
 * activity); `pulled_through` is this device's keyset cursor timestamp per table.
 */
async function reportDeviceProgress(client: SupabaseClient): Promise<void> {
  try {
    const user = await getCurrentUser();
    if (!user?.user_id) return;
    const deviceId = syncData.replicaId();
    const rows: Array<Record<string, unknown>> = [];
    for (const meta of syncData.syncedTablesFor(syncData.currentSyncTier())) {
      if (meta.pullOnly) continue; // pull-only tables (e.g. profiles) are never reaped
      const ms = parseCursor(getKV(pullKey(meta.table))).ms;
      rows.push({
        scope_id: user.user_id,
        device_id: deviceId,
        table_name: meta.table,
        pulled_through: new Date(ms).toISOString(),
      });
    }
    if (rows.length === 0) return;
    const { error } = await client
      .from("sync_device_progress")
      .upsert(rows, { onConflict: "scope_id,device_id,table_name" });
    if (error)
      log.info(`sync: device-progress report skipped: ${error.message}`);
  } catch (e) {
    log.info(`sync: device-progress report skipped: ${(e as Error).message}`);
  }
}

const IDENTITY_PUB_KV = "sync.identityPub"; // base64 of the last-published public key

/**
 * Publish this device's account identity PUBLIC key to the remote `identity_pub` directory
 * (E-3, #827) so a scope admin can later HPKE-wrap the per-scope DEK to this member (E-4).
 * The PRIVATE key never leaves the device. Best-effort: any failure is logged at info and
 * never breaks sync. Only runs when encryption is "on" (an identity exists + is unlocked).
 *
 * `user_id` is filled by the remote column's `default auth.uid()` (like scope_id elsewhere),
 * so the payload carries only the key. Gated on a KV hash of the published key so we upsert
 * ONLY when it changes — re-publishing every cycle would bump the remote `updated_at` and
 * churn co-members' pull cursors for no reason. The key is base64 (the wire convention for
 * all key material — matches scope_keys.wrapped_dek so E-4 decodes it identically).
 */
export async function publishIdentityPub(
  client: SupabaseClient,
): Promise<void> {
  try {
    if (keystore.encryptionState() !== "on") return; // no unlocked identity to publish
    const pub = Buffer.from(keystore.getAccountIdentity().publicKey).toString(
      "base64",
    );
    if (getKV(IDENTITY_PUB_KV) === pub) return; // already published this exact key
    const { error } = await client
      .from("identity_pub")
      .upsert({ public_key: pub }, { onConflict: "user_id" });
    if (error) {
      log.info(`sync: identity_pub publish skipped: ${error.message}`);
      return;
    }
    setKV(IDENTITY_PUB_KV, pub);
  } catch (e) {
    log.info(`sync: identity_pub publish skipped: ${(e as Error).message}`);
  }
}

export async function syncOnce(
  onProgress?: SyncProgressFn,
): Promise<SyncResult> {
  if (!syncData.isSyncEnabled()) {
    return { pushed: 0, pulled: 0, conflicts: 0, skipped: 0 };
  }
  const client = await getAuthedClient();
  if (!client)
    return { pushed: 0, pulled: 0, conflicts: 0, skipped: 0, notAuthed: true };

  // A profile pull can flip the plan tier (e.g. free→pro after a Stripe upgrade,
  // or the very first pull on a fresh Pro device). Snapshot before/after so we can
  // arm/disarm the Pro capture + seed the newly-synced tier (#826/D).
  const tierBefore = syncData.currentSyncTier();
  const push = await pushOnce(client, onProgress);
  const pull = await pullOnce(client, onProgress);
  // #1246: after content is applied, merge any projects that a peer's pulled identity
  // row revealed to share a git_remote (min-id winner, deterministic → no ping-pong).
  // Post-content so the re-key finds the applied rows; the re-keyed content re-pushes
  // next cycle. No-op (a cheap GROUP BY) when there are no same-remote duplicates.
  // Defensive: a transient merge failure must not abort the whole cycle — retried next tick.
  try {
    convergeProjectsByRemote();
  } catch (e) {
    log.notice(
      `sync: project convergence deferred — ${(e as Error).message ?? e}`,
    );
  }
  const tierAfter = syncData.currentSyncTier();
  if (tierAfter !== tierBefore) {
    // Reconcile the change-capture trigger set to the new tier (installs the Pro
    // distillation-fanout on upgrade; drops it on downgrade), then reconcile the
    // outbox so the newly-synced tier's PRE-EXISTING rows (distillations created
    // before the upgrade) are seeded — capture only sees writes from now on. They
    // push on the next cycle. reconcile is idempotent for the already-synced tables.
    reinstallSyncCapture();
    syncData.reconcile(tierAfter);
  }
  // Report AFTER the pull so pulled_through reflects the freshly-advanced cursors.
  await reportDeviceProgress(client);
  // Publish this device's identity public key so admins can wrap the DEK to it (E-3, #827).
  await publishIdentityPub(client);
  return {
    pushed: push.pushed,
    pulled: pull.pulled,
    conflicts: push.conflicts + pull.conflicts,
    skipped: push.skipped + pull.skipped,
    quotaHit: push.quotaHit,
  };
}

// ---------------------------------------------------------------------------
// Background scheduler (startup pull + periodic + shutdown push)
// ---------------------------------------------------------------------------

const DEFAULT_SYNC_INTERVAL_MS = 60_000;

/**
 * Start periodic background sync. Self-contained (owns its interval). Runs one
 * cycle ~5s after startup, then every `intervalMs`. Best-effort. The returned
 * stop function AWAITS any in-flight cycle before doing a final flush, so the
 * shutdown push never races a periodic push (which would corrupt cursors).
 */
export function startSyncScheduler(
  intervalMs = DEFAULT_SYNC_INTERVAL_MS,
): () => Promise<void> {
  let inflight: Promise<unknown> | null = null;

  const tick = () => {
    if (inflight || !syncData.isSyncEnabled()) return;
    inflight = syncOnce()
      // A quota pause is already reported once per table by pushEntry (deduped) — no
      // per-cycle scheduler summary, which would re-spam the same state every interval.
      .catch((e) =>
        log.error(`sync: background cycle failed: ${(e as Error).message}`),
      )
      .finally(() => {
        inflight = null;
      });
  };

  const startupTimer = setTimeout(tick, 5_000);
  startupTimer.unref?.();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();

  return async () => {
    clearTimeout(startupTimer);
    clearInterval(timer);
    if (inflight) await inflight.catch(() => {}); // don't race the in-flight cycle
    if (!syncData.isSyncEnabled()) return;
    try {
      const client = await getAuthedClient();
      if (client) await pushOnce(client); // final best-effort flush
    } catch {
      // shutdown flush is best-effort
    }
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Synced columns that live only on the remote — stripped before local apply. */
const REMOTE_ONLY_COLS = new Set([
  "scope_id",
  "author_id",
  "content_hash",
  "revision",
  "is_deleted",
]);

const TS_COLS = new Set(["created_at", "updated_at"]);
// scope_members keys on scope_id locally (half its PK), so it must survive stripSyncCols
// even though scope_id is a remote-only tenant column on every content table.
const SCOPE_MEMBER_KEEP = new Set(["scope_id"]);

function stripSyncCols(
  remote: Record<string, unknown>,
  keep?: Set<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(remote)) {
    // `keep` retains columns that are REAL local data despite sharing a name with a
    // remote-only sync column — e.g. scope_members.scope_id is half the PK, not the tenant
    // column stripped on content tables (cf. scope_keys' dedicated applyRemoteScopeKey).
    if (REMOTE_ONLY_COLS.has(k) && !keep?.has(k)) continue;
    // Remote timestamps are ISO strings; the local schema stores epoch ms.
    if (TS_COLS.has(k) && typeof v === "string") {
      // Distinguish a real parse failure from a valid epoch 0 (Date.parse → 0
      // is falsy; `|| Date.now()` would corrupt created_at, which IS hashed).
      const parsed = Date.parse(v);
      out[k] = Number.isNaN(parsed) ? Date.now() : parsed;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Convert a local row for upload: the local schema stores timestamps as epoch
 * ms integers, but the remote columns are `timestamptz` — sending a bare ms int
 * raises 22008 (out of range) and would fail every upsert. Symmetric inverse of
 * stripSyncCols.
 */
function toRemoteRow(
  table: string,
  row: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row };
  for (const k of TS_COLS) {
    if (typeof out[k] === "number") {
      out[k] = new Date(out[k]).toISOString();
    }
  }
  // Base64-encode BLOB columns for the PostgREST/JSON wire (remote stores `text`).
  // A Buffer/Uint8Array becomes a base64 string; NULL/absent pass through.
  for (const c of tableMeta(table).blobColumns ?? []) {
    const v = out[c];
    if (v instanceof Uint8Array) out[c] = Buffer.from(v).toString("base64");
  }
  return out;
}

function tableMeta(table: string): syncData.SyncTableMeta {
  // Tier-independent: a table's meta exists regardless of the current tier (tier
  // only gates whether it's synced). Resolving via the registry avoids a
  // tier-timing edge where a pro table is processed before the mirror flips.
  return syncData.metaFor(table);
}

function idColumns(table: string): string[] {
  return tableMeta(table).idColumns;
}

/** Decompose a row_id back into a PostgREST `.match()` filter object. */
function decomposeId(table: string, rowId: string): Record<string, string> {
  const cols = idColumns(table);
  const parts = rowId.split("\x1f");
  const out: Record<string, string> = {};
  cols.forEach((c, i) => {
    out[c] = parts[i];
  });
  return out;
}
