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
import { syncData, getKV, setKV, log } from "@loreai/core";
import { getAuthedClient } from "./supabase";

const PAGE = 200;
const pushKey = (t: string) => `sync.push.${t}`;
const pullKey = (t: string) => `sync.pull.${t}`;

export interface SyncResult {
  pushed: number;
  pulled: number;
  conflicts: number;
  /** Tables whose upload was paused this cycle by a quota limit. */
  quotaHit?: { table: string; message: string };
  /** Set when not logged in / session invalid (caller should prompt login). */
  notAuthed?: boolean;
}

type PushErrorKind = "quota" | "poison" | "transient";

/**
 * Classify a PostgREST write error:
 *  - "quota"     : row-count limit (recoverable — a delete frees a slot). Pause
 *                  this table; keep the row pending.
 *  - "poison"    : a size/other CHECK violation (23514 that is NOT a quota
 *                  message). The row can NEVER fit, so pausing the table would
 *                  wedge it forever — instead drop the row past the cursor and
 *                  record it so the rest of the table keeps syncing.
 *  - "transient" : network/5xx/etc. — keep pending and retry next cycle.
 */
function classifyPushError(
  err: { code?: string; message?: string } | null,
): PushErrorKind {
  if (!err) return "transient";
  const quota = /quota exceeded/i.test(err.message ?? "");
  if (err.code === "23514") return quota ? "quota" : "poison";
  return "transient";
}

// ---------------------------------------------------------------------------
// Push (per table — independent cursor; advance only past confirmed rows)
// ---------------------------------------------------------------------------

/**
 * Push pending local changes for every synced table. Each table is drained
 * independently: a quota or transient failure on one table never advances its
 * cursor past the unpushed row and never blocks another table.
 */
export async function pushOnce(client: SupabaseClient): Promise<SyncResult> {
  const res: SyncResult = { pushed: 0, pulled: 0, conflicts: 0 };
  for (const meta of syncData.syncedTables("basic")) {
    // Pull-only tables (e.g. profiles) are server-authoritative: the client only
    // reads them. They have no outbox capture trigger, so this is belt-and-
    // suspenders, but it keeps the intent explicit and avoids a needless scan.
    if (meta.pullOnly) continue;
    await pushTable(client, meta.table, res);
  }
  // Reclaim outbox rows fully pushed across all tables THAT HAVE ENTRIES (seq <=
  // the lowest such cursor) — the outbox is otherwise append-only. A table with
  // no entries must NOT pin the floor at its cursor 0, which would block all
  // pruning forever (the common case: a project with knowledge but no relations).
  // Pull-only tables are never pushed, so their cursor never advances past 0 —
  // exclude them too (defense-in-depth: nothing should enqueue them, but if a
  // stray entry existed it must not wedge the prune floor at 0).
  const cursors = syncData
    .syncedTables("basic")
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
        const outcome = await pushEntry(client, e, res);
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
    if (stop || batch.length < PAGE) break;
  }
}

type PushOutcome = "ok" | "stop";

/** Push one coalesced outbox entry. "stop" => leave it pending (quota/error). */
async function pushEntry(
  client: SupabaseClient,
  e: syncData.OutboxEntry,
  res: SyncResult,
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
    // Null the remote content_hash too, so the tombstone honors the
    // "remoteHash is null for a tombstone" contract on the wire. The pull side
    // (applyRemote) already treats is_deleted rows as hash-null, but this also
    // protects un-upgraded readers during a rollout.
    // Null the remote content_hash too (tombstone "remoteHash is null" contract).
    const tombstone: Record<string, unknown> = {
      is_deleted: true,
      content_hash: null,
    };
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
      log.notice(`sync: push delete ${table}/${effectiveId}: ${error.message}`);
      return "stop"; // transient; keep pending so the delete isn't lost
    }
    const prev = syncData.getSyncState(table, effectiveId);
    syncData.setSyncState(table, effectiveId, {
      content_hash: null,
      revision: (prev?.revision ?? 0) + 1,
      remote_updated_at: prev?.remote_updated_at ?? null,
    });
    res.pushed++;
    return "ok";
  }

  // upsert — for knowledge, `knowledgeRow` is the CURRENT version keyed by logical_id.
  const row = knowledgeRow ?? syncData.getRowById(table, rowId);
  if (!row) return "ok"; // row gone; a later delete entry (if any) handles it
  const hash = syncData.contentHash(table, row);
  const state = syncData.getSyncState(table, effectiveId);
  if (state?.content_hash === hash) {
    res.pushed++; // already in sync — no-op
    return "ok";
  }

  const revision = (state?.revision ?? 0) + 1;
  // Only the synced data columns (the remote 0002 contract) — never local-only
  // columns like knowledge.promoted_at, which the remote rejects (PGRST204).
  const payload: Record<string, unknown> = {
    ...toRemoteRow(syncData.pickSyncColumns(table, row)),
    is_deleted: false,
  };
  // Only versioned tables have content_hash/revision columns remotely; sending
  // them to the join table is a PGRST204 schema error (and would never sync it).
  if (tableMeta(table).versioned !== false) {
    payload.content_hash = hash;
    payload.revision = revision;
  }
  // The REMOTE primary key is composite — (scope_id, <idColumns>) — so the
  // ON CONFLICT target must include scope_id (the local PK is just idColumns).
  // scope_id is filled by the column's auth.uid() default (v1: scope = user).
  const { error } = await client.from(table).upsert(payload, {
    onConflict: ["scope_id", ...idColumns(table)].join(","),
  });

  if (error) {
    const kind = classifyPushError(error);
    if (kind === "quota") {
      if (!res.quotaHit) res.quotaHit = { table, message: error.message };
      log.notice(`sync: quota on ${table} — ${error.message}`);
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
  });
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
export async function pullOnce(client: SupabaseClient): Promise<SyncResult> {
  const res: SyncResult = { pushed: 0, pulled: 0, conflicts: 0 };

  for (const meta of syncData.syncedTables("basic")) {
    const touchedFts = new Set<string>();
    let cursor = parseCursor(getKV(pullKey(meta.table)));

    const idc = meta.idColumns[0];
    for (;;) {
      const sinceIso = new Date(cursor.ms).toISOString();
      // Page by (updated_at, id). `gte` includes cursor.ms; the in-memory keyset
      // skip drops rows already applied. (timestamptz is compared by VALUE, so
      // Z vs +00:00 / fractional formats are equivalent.)
      let q = client
        .from(meta.table)
        .select("*")
        .order("updated_at", { ascending: true })
        .order(idc, { ascending: true })
        .limit(PAGE);
      q = q.gte("updated_at", sinceIso);
      const { data, error } = await q;
      if (error) {
        log.notice(`sync: pull ${meta.table}: ${error.message}`);
        break;
      }
      const rows = (data ?? []) as Array<Record<string, unknown>>;
      if (rows.length === 0) break;

      let advanced = false;
      for (const remote of rows) {
        const ms = Date.parse(String(remote.updated_at ?? "")) || 0;
        const rid = syncData.rowIdOf(meta.table, remote);
        if (ms < cursor.ms || (ms === cursor.ms && rid <= cursor.id)) continue;
        applyRemote(meta, remote, res, touchedFts);
        cursor = { ms, id: rid };
        advanced = true;
      }
      setKV(pullKey(meta.table), formatCursor(cursor));

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
        );
        cursor = drained;
        setKV(pullKey(meta.table), formatCursor(cursor));
      }
    }

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
      applyRemote(meta, remote, res, touchedFts);
      cols.forEach((c, i) => {
        last[i] = String(remote[c]);
      });
      cursor = { ms: cursor.ms, id: syncData.rowIdOf(meta.table, remote) };
    }
  }
  // Past this millisecond entirely; the next primary page resumes at ms+1.
  return { ms: cursor.ms + 1, id: "" };
}

function applyRemote(
  meta: syncData.SyncTableMeta,
  remote: Record<string, unknown>,
  res: SyncResult,
  touchedFts: Set<string>,
): void {
  const rowId = syncData.rowIdOf(meta.table, remote);
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
      syncData.applyRemoteKnowledge(stripSyncCols(remote));
    } else {
      syncData.applyRemoteUpsert(meta.table, stripSyncCols(remote));
    }
    syncData.setSyncState(meta.table, rowId, {
      content_hash: remoteHash,
      revision: typeof remote.revision === "number" ? remote.revision : 0,
      remote_updated_at: String(remote.updated_at ?? ""),
    });
    for (const fts of meta.ftsTables) touchedFts.add(fts);
  }
  res.pulled++;
}

// ---------------------------------------------------------------------------
// syncOnce — push then pull
// ---------------------------------------------------------------------------

export async function syncOnce(): Promise<SyncResult> {
  if (!syncData.isSyncEnabled()) {
    return { pushed: 0, pulled: 0, conflicts: 0 };
  }
  const client = await getAuthedClient();
  if (!client) return { pushed: 0, pulled: 0, conflicts: 0, notAuthed: true };

  const push = await pushOnce(client);
  const pull = await pullOnce(client);
  return {
    pushed: push.pushed,
    pulled: pull.pulled,
    conflicts: push.conflicts + pull.conflicts,
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
      .then((r) => {
        if (r.quotaHit) {
          log.notice(
            `sync: quota reached on ${r.quotaHit.table}; that table paused until next change`,
          );
        }
      })
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

function stripSyncCols(
  remote: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(remote)) {
    if (REMOTE_ONLY_COLS.has(k)) continue;
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
function toRemoteRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row };
  for (const k of TS_COLS) {
    if (typeof out[k] === "number") {
      out[k] = new Date(out[k] as number).toISOString();
    }
  }
  return out;
}

function tableMeta(table: string): syncData.SyncTableMeta {
  const meta = syncData.syncedTables("basic").find((m) => m.table === table);
  if (!meta) throw new Error(`not a synced table: ${table}`);
  return meta;
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
