import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  db,
  ensureProject,
  getKV,
  setKV,
  deleteTeamConfig,
  reinstallSyncCapture,
} from "@loreai/core";
import { ltm, log, keystore, crypto, syncData } from "@loreai/core";

// --- Fake Supabase client ----------------------------------------------------
// In-memory per-table store with the PostgREST surface the engine uses, PLUS
// adversarial knobs the previous mock lacked: injected upsert errors, forced
// updated_at collisions, and per-table quota. These are what surface the
// data-loss bugs the first mock hid.
interface RemoteRow extends Record<string, unknown> {
  updated_at: string;
}
const remote = new Map<string, RemoteRow[]>();
let quotaTables = new Set<string>();
let upsertError: { code?: string; message: string } | null = null;
let updateError: { code?: string; message: string } | null = null;
const poisonIds = new Set<string>(); // ids the server rejects with a size CHECK (23514)
let fixedTs: string | null = null; // when set, every write stamps this exact ts
let clock = 1_000_000;

function tableRows(t: string): RemoteRow[] {
  let r = remote.get(t);
  if (!r) {
    r = [];
    remote.set(t, r);
  }
  return r;
}
function nextTs(): string {
  if (fixedTs) return fixedTs;
  clock += 1000;
  return new Date(clock).toISOString();
}
function idColumns(table: string): string[] {
  // sync_device_progress is a control table (not in SYNCED_TABLES); its PK is composite.
  if (table === "sync_device_progress")
    return ["scope_id", "device_id", "table_name"];
  return (
    syncData.syncedTables("basic").find((m) => m.table === table)
      ?.idColumns ?? ["id"]
  );
}

// Allowed columns per remote table (mirrors supabase/migrations/0002+). The
// join table deliberately has NO content_hash/revision — sending them is a
// PGRST204, which is exactly the bug this guards against.
const SYNC_COLS = [
  "content_hash",
  "revision",
  "is_deleted",
  "scope_id",
  "author_id",
];
const REMOTE_COLUMNS: Record<string, Set<string>> = {
  knowledge: new Set([
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
    ...SYNC_COLS,
  ]),
  entities: new Set([
    "id",
    "project_id",
    "entity_type",
    "canonical_name",
    "metadata",
    "cross_project",
    "sync_rank", // #1191b PR2b: synced ref-count for server-side eviction
    "created_at",
    "updated_at",
    ...SYNC_COLS,
  ]),
  knowledge_entity_refs: new Set([
    "scope_id",
    "author_id",
    "knowledge_id",
    "entity_id",
    "is_deleted",
    "created_at",
    "updated_at",
  ]),
  account_escrow: new Set([
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
    "created_at",
    "updated_at",
    ...SYNC_COLS,
  ]),
  scope_keys: new Set([
    "member_user_id",
    "wrapped_dek",
    "key_epoch",
    "created_at",
    "updated_at",
    ...SYNC_COLS,
  ]),
  // #1246 projects identity mapping — faithful to supabase/migrations/0022. path is
  // NEVER a remote column (device-local); a leaked path → PGRST204.
  projects: new Set([
    "id",
    "git_remote",
    "name",
    "created_at",
    ...SYNC_COLS, // versioned: content_hash/revision/is_deleted + scope_id/author_id
  ]),
  // D (#826) pro tables — faithful to supabase/migrations/0020.
  distillations: new Set([
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
    "updated_at",
    ...SYNC_COLS, // versioned + has is_deleted
  ]),
  // 🔴 temporal_messages is APPEND-ONLY: 0020 has NO is_deleted / content_hash /
  // revision column. Registering it faithfully means a leaked is_deleted → PGRST204.
  temporal_messages: new Set([
    "id",
    "project_id",
    "session_id",
    "role",
    "content",
    "tokens",
    "metadata",
    "created_at",
    "updated_at",
    "scope_id",
    "author_id",
  ]),
};

// The server defaults scope_id/author_id to auth.uid() — simulate a single fixed
// authed user so pulled rows carry a scope_id (applyRemoteScopeKey reads it). Faithful
// and harmless for existing tables (applyRemote strips scope_id before local apply).
const REMOTE_SCOPE = "00000000-0000-4000-8000-000000000001";

function makeClient() {
  return {
    from(table: string) {
      return {
        // supabase-js .upsert() accepts a single row OR an array — mirror both.
        upsert(payload: Record<string, unknown> | Record<string, unknown>[]) {
          const upsertOne = (
            one: Record<string, unknown>,
          ): { code: string; message: string } | null => {
            if (quotaTables.has(table))
              return { code: "23514", message: `quota exceeded for ${table}` };
            if (poisonIds.has(String(one.id)))
              return {
                code: "23514",
                message: `new row violates check constraint "${table}_size_ck"`,
              };
            if (upsertError)
              return upsertError as { code: string; message: string };
            // Faithful to the remote schema: an unknown column is a PGRST204 (the
            // join table has NO content_hash/revision columns).
            const allowed = REMOTE_COLUMNS[table];
            if (allowed) {
              for (const k of Object.keys(one)) {
                if (!allowed.has(k))
                  return {
                    code: "PGRST204",
                    message: `Could not find the '${k}' column of '${table}' in the schema cache`,
                  };
              }
            }
            // Faithful to timestamptz columns: a bare epoch-ms integer is rejected
            // (22008) the way real Postgres does — only ISO strings are accepted.
            for (const k of ["created_at", "updated_at"]) {
              if (k in one && typeof one[k] !== "string")
                return {
                  code: "22008",
                  message: `date/time field value out of range: "${one[k]}"`,
                };
            }
            const rows = tableRows(table);
            const idc = idColumns(table);
            const i = rows.findIndex((r) => idc.every((c) => r[c] === one[c]));
            const stamped = {
              scope_id: REMOTE_SCOPE,
              author_id: REMOTE_SCOPE,
              ...one,
              updated_at: nextTs(),
            } as RemoteRow;
            if (i >= 0) rows[i] = stamped;
            else rows.push(stamped);
            return null;
          };
          for (const one of Array.isArray(payload) ? payload : [payload]) {
            const error = upsertOne(one);
            if (error) return Promise.resolve({ error });
          }
          return Promise.resolve({ error: null });
        },
        update(patch: Record<string, unknown>) {
          return {
            match(filter: Record<string, string>) {
              if (updateError) return Promise.resolve({ error: updateError });
              for (const r of tableRows(table)) {
                if (Object.entries(filter).every(([k, v]) => r[k] === v)) {
                  Object.assign(r, patch, { updated_at: nextTs() });
                }
              }
              return Promise.resolve({ error: null });
            },
          };
        },
        select() {
          // Faithful-ish PostgREST builder: chainable filters/order/limit, and
          // thenable (await runs the query). Timestamps compare by VALUE
          // (Date.parse), like timestamptz — so Z vs +00:00 are equivalent and
          // paging is at the real PAGE boundary.
          const filters: Array<{ op: string; col: string; val: string }> = [];
          const orders: string[] = [];
          let lim = Infinity;
          const run = () => {
            let rows = tableRows(table).slice();
            for (const f of filters) {
              rows = rows.filter((r) => {
                const rv = r[f.col];
                if (f.col === "updated_at") {
                  const a = Date.parse(String(rv)) || 0;
                  const b2 = Date.parse(String(f.val)) || 0;
                  return f.op === "gte"
                    ? a >= b2
                    : f.op === "gt"
                      ? a > b2
                      : a === b2;
                }
                if (f.op === "eq") return rv === f.val;
                if (f.op === "gt") return String(rv) > String(f.val);
                return String(rv) >= String(f.val);
              });
            }
            rows.sort((a, c) => {
              for (const o of orders) {
                let cmp: number;
                if (o === "updated_at")
                  cmp =
                    (Date.parse(String(a[o])) || 0) -
                    (Date.parse(String(c[o])) || 0);
                else cmp = String(a[o]).localeCompare(String(c[o]));
                if (cmp) return cmp < 0 ? -1 : 1;
              }
              return 0;
            });
            return { data: rows.slice(0, lim), error: null };
          };
          const b: Record<string, unknown> = {
            gte(c: string, v: string) {
              filters.push({ op: "gte", col: c, val: v });
              return b;
            },
            gt(c: string, v: string) {
              filters.push({ op: "gt", col: c, val: v });
              return b;
            },
            eq(c: string, v: string) {
              filters.push({ op: "eq", col: c, val: v });
              return b;
            },
            order(c: string) {
              orders.push(c);
              return b;
            },
            limit(n: number) {
              lim = n;
              return b;
            },
            // Deliberate thenable — mirrors supabase-js's awaitable query builder.
            // biome-ignore lint/suspicious/noThenProperty: faithful PostgREST builder mock
            then(
              resolve: (v: unknown) => unknown,
              reject?: (e: unknown) => unknown,
            ) {
              return Promise.resolve(run()).then(resolve, reject);
            },
          };
          return b;
        },
      };
    },
  };
}

let authed = true;
// The authed user's id (auth.uid()) = the v1 encryption scope; matches the mock's
// server-injected scope_id (REMOTE_SCOPE) so push-side AAD == pull-side AAD (C-4).
// Overridable per-test (undefined ⇒ ctx() can't resolve ⇒ push fails closed).
let mockUserId: string | undefined = "00000000-0000-4000-8000-000000000001";
vi.mock("../src/supabase", () => ({
  getAuthedClient: () => Promise.resolve(authed ? makeClient() : null),
  getCurrentUser: () =>
    Promise.resolve({ github_login: "octocat", user_id: mockUserId }),
}));

import {
  __resetQuotaWarnedTables,
  classifyPushError,
  pushOnce,
  pullOnce,
  type SyncProgress,
  syncOnce,
} from "../src/sync";

const now = () => Date.now();
function insertKnowledge(id: string, content: string): void {
  const pid = ensureProject("/tmp/lore-sync-engine");
  db()
    .query(
      `INSERT INTO knowledge (id, project_id, category, title, content, created_at, updated_at)
       VALUES (?, ?, 'pattern', 'T', ?, ?, ?)`,
    )
    .run(id, pid, content, now(), now());
}

// Knowledge is append-only (A2): a pulled change appends a new version and a
// pulled delete appends a death-cert, so the CURRENT live content is in
// knowledge_current keyed by logical_id — not the base row addressed by getRowById.
function currentContent(logicalId: string): string | null {
  const r = db()
    .query(
      "SELECT content FROM knowledge_current WHERE COALESCE(logical_id, id) = ?",
    )
    .get(logicalId) as { content: string } | undefined;
  return r?.content ?? null;
}
function insertEntity(id: string): void {
  const pid = ensureProject("/tmp/lore-sync-engine");
  db()
    .query(
      `INSERT INTO entities (id, project_id, entity_type, canonical_name, created_at, updated_at)
       VALUES (?, ?, 'tool', 'X', ?, ?)`,
    )
    .run(id, pid, now(), now());
}

function insertRef(kid: string, eid: string): void {
  db()
    .query(
      `INSERT INTO knowledge_entity_refs (knowledge_id, entity_id) VALUES (?, ?)`,
    )
    .run(kid, eid);
}

beforeEach(() => {
  vi.restoreAllMocks(); // don't let a spy leaked by a failed assertion cascade
  deleteTeamConfig("sync.enabled");
  db().exec("DELETE FROM temp._sync_applying");
  db().exec("DELETE FROM knowledge");
  // The knowledge_meta register + CRDT counters are now synced tables (A2 3b-2)
  // and are NOT cascade-deleted by the hard `DELETE FROM knowledge` above (no FK
  // CASCADE; production deletes via append-only death-certs, not a hard delete).
  // Clear them too so orphaned register rows don't accumulate across tests and get
  // re-seeded into the outbox by enableSync.
  db().exec("DELETE FROM knowledge_meta");
  db().exec("DELETE FROM knowledge_meta_crdt");
  db().exec("DELETE FROM entities");
  db().exec("DELETE FROM profiles");
  // C-3 encryption key store (#825): clear the key tables + in-memory keystore
  // caches between tests.
  db().exec("DELETE FROM account_identity");
  db().exec("DELETE FROM account_escrow");
  db().exec("DELETE FROM scope_keys");
  db().exec("DELETE FROM distillations");
  db().exec("DELETE FROM temporal_messages");
  // #1246: the synced test projects (remote-backed /local/* + pulled lore:project/*).
  db().exec(
    "DELETE FROM projects WHERE path LIKE '/local/%' OR path LIKE 'lore:project/%'",
  );
  keystore.lock();
  db().exec("DELETE FROM sync_outbox");
  db().exec("DELETE FROM sync_state");
  db().exec("DELETE FROM sync_conflicts");
  for (const t of [
    "knowledge",
    "entities",
    "entity_aliases",
    "entity_relations",
    "knowledge_entity_refs",
    "profiles",
    "account_escrow",
    "scope_keys",
    "distillations",
    "temporal_messages",
    "projects",
  ]) {
    setKV(`sync.push.${t}`, "0");
    setKV(`sync.pull.${t}`, "0|");
  }
  // Reset change-capture to the free-tier baseline (drops any Pro fanout trigger a
  // prior test installed) so tier-gated capture doesn't leak across tests (#826/D).
  reinstallSyncCapture();
  remote.clear();
  quotaTables = new Set();
  __resetQuotaWarnedTables(); // module-level dedupe state persists across tests
  upsertError = null;
  updateError = null;
  poisonIds.clear();
  fixedTs = null;
  authed = true;
  mockUserId = "00000000-0000-4000-8000-000000000001";
  clock = 1_000_000;
});

afterEach(() => syncData.assertSyncInvariants()); // #834 — continuous invariant guard

describe("pushOnce — happy path", () => {
  test("uploads new rows and records sync_state", async () => {
    syncData.enableSync("basic");
    insertKnowledge("k1", "hello");
    const r = await pushOnce(makeClient() as never);
    expect(r.pushed).toBe(1);
    expect(tableRows("knowledge")).toHaveLength(1);
    expect(syncData.getSyncState("knowledge", "k1")?.content_hash).toBeTruthy();
  });

  test("uploads timestamps as ISO strings, not epoch-ms (timestamptz)", async () => {
    syncData.enableSync("basic");
    insertKnowledge("k1", "hello");
    await pushOnce(makeClient() as never);
    const row = tableRows("knowledge").find((x) => x.id === "k1");
    // Real Postgres rejects an integer for a timestamptz column (22008); the
    // mock now does too, so a successful upload proves ISO conversion ran.
    expect(typeof row?.created_at).toBe("string");
    expect(Number.isNaN(Date.parse(String(row?.created_at)))).toBe(false);
  });

  test("pushes a knowledge_entity_refs (join) row — no phantom hash/revision columns", async () => {
    insertKnowledge("k1", "hi");
    insertEntity("e1");
    syncData.enableSync("basic"); // enable AFTER the FK parents exist
    insertRef("k1", "e1"); // join table has NO content_hash/revision remotely
    await pushOnce(makeClient() as never);
    // The strict mock rejects unknown columns (PGRST204); a successful push
    // proves only valid columns were sent.
    const row = tableRows("knowledge_entity_refs").find(
      (x) => x.knowledge_id === "k1" && x.entity_id === "e1",
    );
    expect(row).toBeTruthy();
    expect("content_hash" in (row ?? {})).toBe(false);
    expect("revision" in (row ?? {})).toBe(false);
  });

  test("does not push local-only columns (e.g. knowledge.promoted_at)", async () => {
    syncData.enableSync("basic");
    insertKnowledge("k1", "hi");
    db().query("UPDATE knowledge SET promoted_at = 123 WHERE id='k1'").run();
    const r = await pushOnce(makeClient() as never); // strict mock → PGRST204 if leaked
    expect(r.pushed).toBe(1);
    const row = tableRows("knowledge").find((x) => x.id === "k1");
    expect("promoted_at" in (row ?? {})).toBe(false);
  });

  test("Pro backup: pushes a distillation + its referenced temporal subset; temporal carries NO is_deleted", async () => {
    // The strict mock is faithful to 0020: temporal_messages has NO is_deleted column,
    // so a leaked is_deleted:false → PGRST204 → poison. This test fails without the
    // appendOnly gate in pushEntry.
    db()
      .query(
        "INSERT OR REPLACE INTO profiles (id, tier, created_at, updated_at) VALUES (?, 'pro', ?, ?)",
      )
      .run(mockUserId, now(), now());
    reinstallSyncCapture(); // arm the tier-gated distillation-fanout trigger
    syncData.enableSync(); // pro tier → basic ∪ pro
    const pid = ensureProject("/tmp/lore-sync-engine");
    const insTemporal = (id: string) =>
      db()
        .query(
          "INSERT INTO temporal_messages (id, project_id, session_id, role, content, tokens, distilled, created_at, metadata) VALUES (?, ?, 's', 'user', 'hi', 1, 1, ?, '{}')",
        )
        .run(id, pid, now());
    insTemporal("t1");
    insTemporal("t2"); // unreferenced — must NEVER sync
    db()
      .query(
        "INSERT INTO distillations (id, project_id, session_id, narrative, facts, observations, source_ids, generation, token_count, created_at, archived) VALUES ('d1', ?, 's', 'n', 'f', 'o', ?, 0, 0, ?, 0)",
      )
      .run(pid, JSON.stringify(["t1"]), now()); // fanout enqueues d1 + t1 only

    const r = await pushOnce(makeClient() as never);

    expect(r.conflicts).toBe(0); // nothing poisoned
    const d = tableRows("distillations").find((x) => x.id === "d1");
    expect(d).toBeTruthy();
    expect("is_deleted" in (d ?? {})).toBe(true); // versioned → carries is_deleted
    const t = tableRows("temporal_messages").find((x) => x.id === "t1");
    expect(t).toBeTruthy();
    expect("is_deleted" in (t ?? {})).toBe(false); // append-only → NO is_deleted
    expect(
      tableRows("temporal_messages").find((x) => x.id === "t2"),
    ).toBeUndefined(); // undistilled never synced
  });

  test("prunes the outbox even when another synced table has no entries", async () => {
    syncData.enableSync("basic");
    insertKnowledge("k1", "hello"); // only knowledge has outbox entries
    await pushOnce(makeClient() as never);
    // entities/relations/refs have cursor 0 but NO entries — they must not pin
    // the prune floor at 0. The pushed knowledge entry should be reclaimed.
    const remaining = syncData
      .readOutbox(0, 1000)
      .filter((e) => e.table_name === "knowledge").length;
    expect(remaining).toBe(0);
  });

  test("a delete becomes a remote tombstone", async () => {
    syncData.enableSync("basic");
    insertKnowledge("k1", "hello");
    await pushOnce(makeClient() as never);
    db().query("DELETE FROM knowledge WHERE id='k1'").run();
    await pushOnce(makeClient() as never);
    const remote = tableRows("knowledge").find((r) => r.id === "k1");
    expect(remote?.is_deleted).toBe(true);
    // The tombstone must carry a NULL content_hash on the wire (the contract).
    expect(remote?.content_hash).toBeNull();
  });

  test("a row deleted then RE-CREATED while sync was OFF is re-synced on enable (not orphaned)", async () => {
    // While enabled, insert+delete leaves a coalesced delete in the outbox. Then
    // sync goes OFF and the row is re-created (no capture). On re-enable, reconcile
    // must re-enqueue the LIVE row — otherwise seedOutbox skips it (it still has the
    // stale pending delete), the coalesced delete pushes (a no-op on a row that was
    // never uploaded), and the re-created row is silently never synced.
    syncData.enableSync("basic");
    insertKnowledge("kr", "v1");
    db().query("DELETE FROM knowledge WHERE id='kr'").run(); // outbox: upsert, delete
    syncData.disableSync();
    insertKnowledge("kr", "v2"); // re-created while OFF — not captured
    syncData.enableSync("basic"); // reconcile must catch the live row
    const r = await pushOnce(makeClient() as never);
    expect(r.pushed).toBeGreaterThan(0);
    const remote = tableRows("knowledge").find((x) => x.id === "kr");
    expect(remote).toBeDefined(); // the re-created row reached the remote…
    expect(remote?.is_deleted).not.toBe(true); // …live, not tombstoned…
    expect(remote?.content).toBe("v2"); // …with the re-created content.
  });

  test("a delete still propagates when a STALE upsert outlived the row (reconcile tombstone)", async () => {
    // A row's upsert can survive pruning when the prune floor is pinned by a
    // lower-seq table (#828): minCursor = min push cursor across tables-with-
    // entries, so a higher-seq table's entry isn't reclaimed. If that row is then
    // deleted while sync is OFF, reconcile's delete-tombstone must STILL fire —
    // otherwise the stale upsert pushes as a no-op (row gone) and the delete never
    // reaches the remote. Symmetric to the live-row seedOutbox fix (#861).
    syncData.enableSync("basic");
    insertKnowledge("k1", "v1"); // outbox upsert@1 (knowledge)
    insertEntity("e1"); // outbox upsert@2 (entities)
    await pushOnce(makeClient() as never);
    // prune floor = min(knowledge=1, entities=2) = 1 → knowledge@1 reclaimed,
    // entities@2 survives as the stale upsert; both rows are now in sync_state.
    expect(
      syncData
        .readOutbox(0)
        .some((e) => e.table_name === "entities" && e.row_id === "e1"),
    ).toBe(true);
    syncData.disableSync();
    db().query("DELETE FROM entities WHERE id='e1'").run(); // deleted while OFF
    syncData.enableSync("basic"); // reconcile must tombstone e1 despite the stale upsert
    await pushOnce(makeClient() as never);
    const remoteE = tableRows("entities").find((r) => r.id === "e1");
    expect(remoteE?.is_deleted).toBe(true); // delete propagated to the remote
  });

  test("a content change still propagates when a STALE upsert outlived the prune floor (reconcile seed)", async () => {
    // The upsert mirror of the tombstone case above: a row's upsert can survive
    // pruning (floor pinned by a lower-seq table, #828). If the row is then
    // MODIFIED while sync is OFF, reconcile must re-seed it BY CONTENT — the stale
    // already-pushed upsert won't carry the new content and (being below the push
    // cursor) is never re-read, so a latest-op guard would skip it and lose the edit.
    syncData.enableSync("basic");
    insertKnowledge("k1", "v1"); // outbox upsert@1 (knowledge)
    insertEntity("e1"); // outbox upsert@2 (entities), canonical_name 'X'
    await pushOnce(makeClient() as never);
    // prune floor = min(knowledge=1, entities=2) = 1 → knowledge@1 reclaimed,
    // entities@2 survives as the stale (already-pushed) upsert.
    expect(
      syncData
        .readOutbox(0)
        .some((e) => e.table_name === "entities" && e.row_id === "e1"),
    ).toBe(true);
    syncData.disableSync();
    db()
      .query("UPDATE entities SET canonical_name='RENAMED' WHERE id='e1'")
      .run(); // modified while OFF
    syncData.enableSync("basic"); // reconcile must re-seed e1 by content
    await pushOnce(makeClient() as never);
    const remoteE = tableRows("entities").find((r) => r.id === "e1");
    expect(remoteE?.canonical_name).toBe("RENAMED"); // edit propagated to the remote
  });

  test("pushOnce resolves a table's synced columns once, not per row (no PRAGMA N+1)", async () => {
    // pushEntry hits syncedColumns 3x per row (getRowById + contentHash +
    // pickSyncColumns), each a `PRAGMA table_info`. Unmemoized that is an N+1 over
    // the whole push batch. Count the PRAGMAs the push actually executes (via the
    // DB-tracing seam, the only reliable interception — a db().query monkeypatch is
    // shadowed by the tracing Proxy).
    syncData.enableSync("basic");
    for (let i = 0; i < 20; i++) insertEntity(`e${i}`);
    let pragma = 0;
    let totalSpans = 0;
    const noop = () => {};
    const passthrough: log.LogSink = {
      info: noop,
      warn: noop,
      error: noop,
      captureException: noop,
    };
    log.registerSink({
      ...passthrough,
      withDbSpan<T>(sql: string, fn: () => T): T {
        totalSpans++;
        if (/PRAGMA table_info\(entities\)/.test(sql)) pragma++;
        return fn();
      },
    });
    try {
      await pushOnce(makeClient() as never);
    } finally {
      log.registerSink(passthrough); // restore pass-through (no withDbSpan)
    }
    expect(tableRows("entities")).toHaveLength(20); // sanity: rows really pushed
    // Non-vacuity guard: the tracing sink must actually fire — otherwise a future
    // break in withDbSpan would silently leave pragma at 0 and pass the bound below.
    expect(totalSpans).toBeGreaterThan(0);
    // 20 rows × 3 unmemoized PRAGMAs ≈ 60 before; O(1) per connection after
    // (here 0 — enableSync's seed already warmed the per-connection cache).
    expect(pragma).toBeLessThan(5);
  });
});

describe("BLOCKER regressions", () => {
  // (1) A non-quota upsert error must NOT advance the cursor past the row.
  test("transient push error keeps the row pending (no lost write)", async () => {
    syncData.enableSync("basic");
    insertKnowledge("k1", "hello");
    upsertError = { code: "08006", message: "network" };
    const r1 = await pushOnce(makeClient() as never);
    expect(r1.pushed).toBe(0);
    expect(tableRows("knowledge")).toHaveLength(0);
    expect(Number(getKV("sync.push.knowledge"))).toBe(0); // cursor did NOT advance

    // Recover: next push succeeds and uploads the row.
    upsertError = null;
    const r2 = await pushOnce(makeClient() as never);
    expect(r2.pushed).toBe(1);
    expect(tableRows("knowledge").find((x) => x.id === "k1")).toBeTruthy();
  });

  // (3) An over-quota table must not block a different under-quota table.
  test("quota on one table does not starve another", async () => {
    syncData.enableSync("basic");
    insertKnowledge("k1", "hello"); // seq 1, will be quota-paused
    insertEntity("e1"); // seq 2, under quota
    quotaTables = new Set(["knowledge"]);
    const r = await pushOnce(makeClient() as never);
    expect(r.quotaHit?.table).toBe("knowledge");
    expect(tableRows("knowledge")).toHaveLength(0); // paused
    expect(tableRows("entities").find((x) => x.id === "e1")).toBeTruthy(); // synced!
    expect(Number(getKV("sync.push.knowledge"))).toBe(0); // knowledge cursor held
    expect(Number(getKV("sync.push.entities"))).toBeGreaterThan(0); // entities advanced
  });

  test("pushOnce emits progress per table (phase/table + cumulative counts)", async () => {
    syncData.enableSync("basic");
    insertKnowledge("k1", "hello");
    const events: SyncProgress[] = [];
    await pushOnce(makeClient() as never, (p) => events.push(p));
    expect(events.every((e) => e.phase === "push")).toBe(true);
    const kn = events.filter((e) => e.table === "knowledge");
    expect(kn.length).toBeGreaterThanOrEqual(1);
    expect(Math.max(...kn.map((e) => e.pushed))).toBeGreaterThanOrEqual(1);
  });

  test("pullOnce emits a progress event for every synced table (before skip guards)", async () => {
    syncData.enableSync("basic");
    const events: SyncProgress[] = [];
    await pullOnce(makeClient() as never, (p) => events.push(p));
    const tables = new Set(
      events.filter((e) => e.phase === "pull").map((e) => e.table),
    );
    expect(tables.size).toBe(syncData.syncedTables("basic").length);
  });

  test("pullOnce still emits for a table SKIPPED while locked (emit precedes the skip guard)", async () => {
    syncData.enableSync("basic");
    keystore.setPassphrase("pw", { params: { t: 1, m: 256, p: 1 } });
    db().exec("DELETE FROM account_identity"); // escrow remains → "locked"
    keystore.lock();
    expect(keystore.encryptionState()).toBe("locked");
    const events: SyncProgress[] = [];
    await pullOnce(makeClient() as never, (p) => events.push(p));
    // knowledge is an encrypted table that is skipped while locked, yet its progress
    // event must still fire — the emit is placed BEFORE the locked `continue` guard so
    // a skipped table still advances the bar. (Moving the emit after the guard fails this.)
    expect(
      events.some((e) => e.phase === "pull" && e.table === "knowledge"),
    ).toBe(true);
  });

  test("a persistent quota pause warns ONCE, not every cycle (log de-spam)", async () => {
    syncData.enableSync("basic");
    insertKnowledge("k1", "hello");
    quotaTables = new Set(["knowledge"]);
    const notice = vi.spyOn(log, "notice").mockImplementation(() => {});
    await pushOnce(makeClient() as never); // cycle 1 — warns once
    await pushOnce(makeClient() as never); // cycle 2 — same pause, must stay silent
    await pushOnce(makeClient() as never); // cycle 3 — still silent
    const quotaLogs = notice.mock.calls.filter(([m]) =>
      String(m).includes("quota on knowledge —"),
    );
    expect(quotaLogs).toHaveLength(1);
    notice.mockRestore();
  });

  test("quota re-warns once after the table makes progress then re-hits the cap", async () => {
    syncData.enableSync("basic");
    insertKnowledge("k1", "hello");
    quotaTables = new Set(["knowledge"]);
    const notice = vi.spyOn(log, "notice").mockImplementation(() => {});
    await pushOnce(makeClient() as never); // warns (1)
    await pushOnce(makeClient() as never); // silent
    quotaTables = new Set(); // cap lifts → k1 pushes, clearing the warned flag
    await pushOnce(makeClient() as never);
    insertKnowledge("k2", "world");
    quotaTables = new Set(["knowledge"]); // re-hit the cap
    await pushOnce(makeClient() as never); // warns again (2)
    const quotaLogs = notice.mock.calls.filter(([m]) =>
      String(m).includes("quota on knowledge —"),
    );
    expect(quotaLogs).toHaveLength(2);
    notice.mockRestore();
  });

  test("classifyPushError: PGRST schema/parsing → poison; conn/auth/quota → their own kinds", () => {
    expect(classifyPushError({ code: "PGRST204", message: "col" })).toBe(
      "poison",
    ); // schema cache
    expect(classifyPushError({ code: "PGRST200", message: "rel" })).toBe(
      "poison",
    ); // relationship
    expect(classifyPushError({ code: "PGRST100", message: "parse" })).toBe(
      "poison",
    ); // request parsing
    expect(classifyPushError({ code: "PGRST301", message: "jwt" })).toBe(
      "transient",
    ); // auth
    expect(classifyPushError({ code: "PGRST000", message: "conn" })).toBe(
      "transient",
    ); // connection
    expect(
      classifyPushError({ code: "23514", message: "quota exceeded for x" }),
    ).toBe("quota");
    expect(
      classifyPushError({ code: "23514", message: 'violates "x_size_ck"' }),
    ).toBe("poison");
    expect(classifyPushError({ code: "08006", message: "conn" })).toBe(
      "transient",
    );
    expect(classifyPushError(null)).toBe("transient");
  });

  test("a delete hitting a permanent schema error (PGRST204) is dropped + advanced, not wedged", async () => {
    syncData.enableSync("basic");
    insertKnowledge("k1", "hello");
    insertEntity("e1");
    db()
      .query(
        "INSERT INTO knowledge_entity_refs (knowledge_id, entity_id) VALUES ('k1','e1')",
      )
      .run();
    await pushOnce(makeClient() as never); // upsert the ref
    const before = Number(getKV("sync.push.knowledge_entity_refs"));
    db()
      .query(
        "DELETE FROM knowledge_entity_refs WHERE knowledge_id='k1' AND entity_id='e1'",
      )
      .run();
    updateError = {
      code: "PGRST204",
      message:
        "Could not find the 'x' column of 'knowledge_entity_refs' in the schema cache",
    };
    await pushOnce(makeClient() as never);
    const n = (
      db()
        .query(
          "SELECT COUNT(*) n FROM sync_conflicts WHERE table_name='knowledge_entity_refs' AND resolution='rejected_unsyncable'",
        )
        .get() as { n: number }
    ).n;
    expect(n).toBe(1); // recorded, not silently lost
    expect(Number(getKV("sync.push.knowledge_entity_refs"))).toBeGreaterThan(
      before,
    ); // advanced past the poison delete (not wedged)
  });

  test("a delete hitting a transient error stays pending (cursor held, retried; never dropped)", async () => {
    syncData.enableSync("basic");
    insertKnowledge("k1", "hello");
    insertEntity("e1");
    db()
      .query(
        "INSERT INTO knowledge_entity_refs (knowledge_id, entity_id) VALUES ('k1','e1')",
      )
      .run();
    await pushOnce(makeClient() as never);
    const before = Number(getKV("sync.push.knowledge_entity_refs"));
    db()
      .query(
        "DELETE FROM knowledge_entity_refs WHERE knowledge_id='k1' AND entity_id='e1'",
      )
      .run();
    updateError = { code: "08006", message: "connection failure" };
    await pushOnce(makeClient() as never);
    const n = (
      db()
        .query(
          "SELECT COUNT(*) n FROM sync_conflicts WHERE resolution='rejected_unsyncable'",
        )
        .get() as { n: number }
    ).n;
    expect(n).toBe(0); // a transient error must NOT drop the delete
    expect(Number(getKV("sync.push.knowledge_entity_refs"))).toBe(before); // held → retried
  });

  test("an UPSERT hitting a permanent schema error (PGRST204) is also dropped + advanced (shared classifier)", async () => {
    syncData.enableSync("basic");
    insertKnowledge("k1", "hello");
    const before = Number(getKV("sync.push.knowledge"));
    upsertError = {
      code: "PGRST204",
      message:
        "Could not find the 'x' column of 'knowledge' in the schema cache",
    };
    await pushOnce(makeClient() as never);
    const n = (
      db()
        .query(
          "SELECT COUNT(*) n FROM sync_conflicts WHERE table_name='knowledge' AND resolution='rejected_unsyncable'",
        )
        .get() as { n: number }
    ).n;
    expect(n).toBe(1); // classifier change applies symmetrically to the upsert path
    expect(Number(getKV("sync.push.knowledge"))).toBeGreaterThan(before); // not wedged
  });

  // (2) MORE than PAGE rows sharing one updated_at must ALL be pulled (the
  // intra-millisecond drain). 250 > PAGE(200) — the old keyset dropped 50.
  test("250 rows sharing one updated_at are all pulled (>PAGE)", async () => {
    syncData.enableSync("basic");
    const pid = ensureProject("/tmp/lore-sync-engine");
    const ts = new Date(5_000_000).toISOString();
    for (let i = 0; i < 250; i++) {
      const id = `k${String(i).padStart(4, "0")}`;
      tableRows("knowledge").push({
        id,
        project_id: pid,
        category: "pattern",
        title: "T",
        content: id,
        content_hash: `h-${id}`,
        revision: 1,
        is_deleted: false,
        created_at: ts,
        updated_at: ts,
      });
    }
    await pullOnce(makeClient() as never);
    const applied = (
      db().query("SELECT COUNT(*) n FROM knowledge").get() as { n: number }
    ).n;
    expect(applied).toBe(250);
  });

  // (poison) A non-quota 23514 (size CHECK) must NOT pause the table forever —
  // the row is dropped past the cursor + recorded; the rest of the table syncs.
  test("an unsyncable (size-CHECK) row is dropped, not wedged", async () => {
    syncData.enableSync("basic");
    insertKnowledge("kbad", "too big"); // seq 1 — rejected as poison
    insertKnowledge("kgood", "fine"); // seq 2 — must still sync, same push
    poisonIds.add("kbad");
    await pushOnce(makeClient() as never);
    expect(tableRows("knowledge").find((x) => x.id === "kgood")).toBeTruthy();
    expect(tableRows("knowledge").find((x) => x.id === "kbad")).toBeFalsy();
    const recorded = db()
      .query(
        "SELECT COUNT(*) n FROM sync_conflicts WHERE row_id='kbad' AND resolution='rejected_unsyncable'",
      )
      .get() as { n: number };
    expect(recorded.n).toBe(1);
  });

  // (starvation) A table with many lower-seq entries from OTHER tables must
  // still drain — readOutbox filters per table in SQL.
  test("a table is not starved by >PAGE*4 other-table outbox entries", async () => {
    syncData.enableSync("basic");
    for (let i = 0; i < 850; i++) insertEntity(`e${i}`); // seqs 1..850
    insertKnowledge("kfar", "behind 850 entities"); // seq 851
    await pushOnce(makeClient() as never);
    expect(tableRows("knowledge").find((x) => x.id === "kfar")).toBeTruthy();
    expect(tableRows("entities").length).toBe(850);
  });
});

// The sync scheduler runs IN-PROCESS inside the Pi/OpenCode plugins, which own
// a full-screen TUI. Its background error notices used to be raw `console.error`
// — any byte of which corrupts the render (the class of bug that broke Pi on
// Windows). They now route through `@loreai/core`'s `log`, so the host's
// `silenceStderr()` switch suppresses them. This drives a REAL migrated site (a
// transient push-upsert error → `log.notice("sync: push upsert …")`).
describe("sync — in-process TUI safety", () => {
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    stderr.mockRestore();
    // Never leak silenced state into other files sharing this worker.
    log.silenceStderr(false);
  });

  async function pushWithTransientError(): Promise<void> {
    syncData.enableSync("basic");
    insertKnowledge("k1", "hello");
    // Non-quota, non-poison → falls through to the transient `log.notice`.
    upsertError = { code: "08006", message: "network" };
    await pushOnce(makeClient() as never);
  }

  test("a sync error is visible on a standalone CLI (the leak we guard)", async () => {
    log.silenceStderr(false);
    await pushWithTransientError();
    const wrote = stderr.mock.calls.some((args: unknown[]) =>
      args.join(" ").includes("sync: push upsert"),
    );
    expect(wrote).toBe(true);
  });

  test("silenceStderr() suppresses sync's stderr writes (in-process/TUI mode)", async () => {
    log.silenceStderr(true);
    await pushWithTransientError();
    // Raw `console.error` would ignore the switch and still corrupt the TUI;
    // routing through `log` is what makes this silence-able.
    expect(stderr).not.toHaveBeenCalled();
  });
});

describe("pullOnce", () => {
  test("applies a new remote row and a tombstone", async () => {
    syncData.enableSync("basic");
    const pid = ensureProject("/tmp/lore-sync-engine");
    tableRows("knowledge").push({
      id: "kr",
      project_id: pid,
      category: "pattern",
      title: "T",
      content: "from server",
      content_hash: "abc",
      revision: 2,
      is_deleted: false,
      created_at: new Date(2_000_000).toISOString(),
      updated_at: new Date(2_000_000).toISOString(),
    });
    await pullOnce(makeClient() as never);
    expect(currentContent("kr")).toBe("from server");

    syncData.withApplying(() => insertKnowledge("kd", "x"));
    tableRows("knowledge").push({
      id: "kd",
      is_deleted: true,
      content_hash: null,
      revision: 5,
      updated_at: new Date(3_000_000).toISOString(),
    } as never);
    await pullOnce(makeClient() as never);
    expect(currentContent("kd")).toBeNull(); // death-cert applied → no live current
  });

  test("pull skips an orphan entity_alias (absent FK parent) instead of aborting the whole sync", async () => {
    syncData.enableSync("basic");
    // A real local entity so its alias applies; a SECOND alias points at an entity that
    // was never admitted under the entity cap (an orphan the FK-less remote happily kept).
    const entId = "11111111-1111-4111-8111-111111111111";
    syncData.withApplying(() =>
      db()
        .query(
          "INSERT INTO entities (id, entity_type, canonical_name, created_at, updated_at) VALUES (?, 'tool', 'Widget', 1, 1)",
        )
        .run(entId),
    );
    tableRows("entity_aliases").push({
      id: "al-ok",
      entity_id: entId,
      alias_type: "name",
      alias_value: "Widget",
      source: null,
      created_at: 1,
      updated_at: new Date(2_000_000).toISOString(),
    } as never);
    tableRows("entity_aliases").push({
      id: "al-orphan",
      entity_id: "22222222-2222-4222-8222-222222222222", // no such entity → local FK 787
      alias_type: "name",
      alias_value: "Ghost",
      source: null,
      created_at: 1,
      updated_at: new Date(2_000_001).toISOString(),
    } as never);

    // Must NOT throw — one FK-failing row can't abort the whole multi-table sync.
    const noticeSpy = vi.spyOn(log, "notice");
    const r = await pullOnce(makeClient() as never);

    // FK orphans are EXPECTED (parent beyond the plan cap) + high-volume on a fresh
    // device → they must NOT be logged per row (a WARN-per-orphan flood drowns the
    // console + inflates the Sentry warning stream). Counted + recorded instead.
    expect(noticeSpy.mock.calls.flat().join(" ")).not.toMatch(/skipped a row/);

    // Valid alias applied; orphan skipped (its FK parent is absent).
    expect(
      db().query("SELECT 1 FROM entity_aliases WHERE id = ?").get("al-ok"),
    ).not.toBeNull();
    expect(
      db().query("SELECT 1 FROM entity_aliases WHERE id = ?").get("al-orphan"),
    ).toBeNull();
    // The skip is recorded as a conflict, not a crash — recoverable + diagnosable.
    expect(r.skipped).toBeGreaterThanOrEqual(1);
    expect(
      db()
        .query(
          "SELECT 1 FROM sync_conflicts WHERE table_name = 'entity_aliases' AND row_id = 'al-orphan'",
        )
        .get(),
    ).not.toBeNull();
  });

  test("resolves a pulled entity_alias UNIQUE collision deterministically — local (lower id) wins, not skipped (#1217)", async () => {
    syncData.enableSync("basic");
    const entId = "55555555-5555-4555-8555-555555555555";
    syncData.withApplying(() => {
      db()
        .query(
          "INSERT INTO entities (id, entity_type, canonical_name, created_at, updated_at) VALUES (?, 'tool', 'U', 1, 1)",
        )
        .run(entId);
      // Local alias with the LOWER id occupies UNIQUE(alias_type='name', alias_value='Dup').
      db()
        .query(
          "INSERT INTO entity_aliases (id, entity_id, alias_type, alias_value, source, created_at) VALUES ('al-local', ?, 'name', 'Dup', NULL, 1)",
        )
        .run(entId);
    });
    // Remote alias: HIGHER id, entity present (FK ok), SAME (alias_type, alias_value) →
    // local UNIQUE collision. Deterministic tiebreak 'al-local' < 'al-remote' → LOCAL wins.
    tableRows("entity_aliases").push({
      id: "al-remote",
      entity_id: entId,
      alias_type: "name",
      alias_value: "Dup",
      source: null,
      created_at: 1,
      updated_at: new Date(2_000_000).toISOString(),
    } as never);

    const noticeSpy = vi.spyOn(log, "notice");
    const r = await pullOnce(makeClient() as never);

    // Converged, NOT skipped: no "skipped a row" notice; counted as a conflict.
    expect(noticeSpy.mock.calls.flat().join(" ")).not.toMatch(/skipped a row/);
    expect(r.conflicts).toBeGreaterThanOrEqual(1);
    // Local (lower id) kept; remote loser discarded + recorded.
    expect(
      db().query("SELECT 1 FROM entity_aliases WHERE id = 'al-local'").get(),
    ).not.toBeNull();
    expect(
      db().query("SELECT 1 FROM entity_aliases WHERE id = 'al-remote'").get(),
    ).toBeNull();
    expect(
      db()
        .query(
          "SELECT 1 FROM sync_conflicts WHERE table_name='entity_aliases' AND row_id='al-remote' AND resolution='alias_unique_superseded'",
        )
        .get(),
    ).not.toBeNull();
  });

  test("resolves a pulled entity_alias UNIQUE collision by applying the remote when it has the lower id (#1217)", async () => {
    syncData.enableSync("basic");
    const entId = "66666666-6666-4666-8666-666666666666";
    syncData.withApplying(() => {
      db()
        .query(
          "INSERT INTO entities (id, entity_type, canonical_name, created_at, updated_at) VALUES (?, 'tool', 'U2', 1, 1)",
        )
        .run(entId);
      // Local alias with the HIGHER id occupies UNIQUE(name, 'Dup2').
      db()
        .query(
          "INSERT INTO entity_aliases (id, entity_id, alias_type, alias_value, source, created_at) VALUES ('al-zzz', ?, 'name', 'Dup2', NULL, 1)",
        )
        .run(entId);
    });
    // Remote alias with the LOWER id → remote wins → local dropped, remote applied.
    tableRows("entity_aliases").push({
      id: "al-aaa",
      entity_id: entId,
      alias_type: "name",
      alias_value: "Dup2",
      source: null,
      created_at: 1,
      updated_at: new Date(2_000_000).toISOString(),
    } as never);

    const r = await pullOnce(makeClient() as never);

    expect(r.conflicts).toBeGreaterThanOrEqual(1);
    expect(
      db().query("SELECT 1 FROM entity_aliases WHERE id = 'al-zzz'").get(),
    ).toBeNull(); // local loser dropped
    expect(
      db().query("SELECT 1 FROM entity_aliases WHERE id = 'al-aaa'").get(),
    ).not.toBeNull(); // remote winner applied
    expect(
      db()
        .query(
          "SELECT 1 FROM sync_conflicts WHERE table_name='entity_aliases' AND row_id='al-zzz' AND resolution='alias_unique_superseded'",
        )
        .get(),
    ).not.toBeNull();
  });

  test("resolves a pulled entity_relations UNIQUE(a,b,relation) collision — local (lower id) wins (#1217)", async () => {
    syncData.enableSync("basic");
    const ea = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const eb = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    syncData.withApplying(() => {
      for (const [id, n] of [
        [ea, "A"],
        [eb, "B"],
      ] as const)
        db()
          .query(
            "INSERT INTO entities (id, entity_type, canonical_name, created_at, updated_at) VALUES (?, 'tool', ?, 1, 1)",
          )
          .run(id, n);
      // Local relation with the LOWER id occupies UNIQUE(entity_a, entity_b, 'knows').
      db()
        .query(
          "INSERT INTO entity_relations (id, entity_a, entity_b, relation, created_at, updated_at) VALUES ('rl-local', ?, ?, 'knows', 1, 1)",
        )
        .run(ea, eb);
    });
    // Remote relation: HIGHER id, same triple → local UNIQUE collision → local wins.
    tableRows("entity_relations").push({
      id: "rl-remote",
      entity_a: ea,
      entity_b: eb,
      relation: "knows",
      source: null,
      created_at: 1,
      updated_at: new Date(2_000_000).toISOString(),
    } as never);

    const noticeSpy = vi.spyOn(log, "notice");
    const r = await pullOnce(makeClient() as never);

    expect(noticeSpy.mock.calls.flat().join(" ")).not.toMatch(/skipped a row/);
    expect(r.conflicts).toBeGreaterThanOrEqual(1);
    expect(
      db().query("SELECT 1 FROM entity_relations WHERE id = 'rl-local'").get(),
    ).not.toBeNull();
    expect(
      db().query("SELECT 1 FROM entity_relations WHERE id = 'rl-remote'").get(),
    ).toBeNull();
    expect(
      db()
        .query(
          "SELECT 1 FROM sync_conflicts WHERE table_name='entity_relations' AND row_id='rl-remote' AND resolution='relation_unique_superseded'",
        )
        .get(),
    ).not.toBeNull();
  });

  test("resolves a pulled entity_relations UNIQUE collision by applying the remote when it has the lower id (#1217)", async () => {
    syncData.enableSync("basic");
    const ea = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const eb = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    syncData.withApplying(() => {
      for (const [id, n] of [
        [ea, "C"],
        [eb, "D"],
      ] as const)
        db()
          .query(
            "INSERT INTO entities (id, entity_type, canonical_name, created_at, updated_at) VALUES (?, 'tool', ?, 1, 1)",
          )
          .run(id, n);
      // Local relation with the HIGHER id.
      db()
        .query(
          "INSERT INTO entity_relations (id, entity_a, entity_b, relation, created_at, updated_at) VALUES ('rl-zzz', ?, ?, 'knows', 1, 1)",
        )
        .run(ea, eb);
    });
    // Remote relation with the LOWER id → remote wins → local dropped, remote applied.
    tableRows("entity_relations").push({
      id: "rl-aaa",
      entity_a: ea,
      entity_b: eb,
      relation: "knows",
      source: null,
      created_at: 1,
      updated_at: new Date(2_000_000).toISOString(),
    } as never);

    const r = await pullOnce(makeClient() as never);

    expect(r.conflicts).toBeGreaterThanOrEqual(1);
    expect(
      db().query("SELECT 1 FROM entity_relations WHERE id = 'rl-zzz'").get(),
    ).toBeNull(); // local loser dropped
    expect(
      db().query("SELECT 1 FROM entity_relations WHERE id = 'rl-aaa'").get(),
    ).not.toBeNull(); // remote winner applied
    expect(
      db()
        .query(
          "SELECT 1 FROM sync_conflicts WHERE table_name='entity_relations' AND row_id='rl-zzz' AND resolution='relation_unique_superseded'",
        )
        .get(),
    ).not.toBeNull();
  });

  test("drainTimestamp also skips an orphan row sharing one timestamp (does not abort the sync)", async () => {
    // > PAGE (200) rows on ONE exact updated_at force the primary page to stall and hand
    // off to drainTimestamp — guarding that the orphan-skip works on the drain path too.
    syncData.enableSync("basic");
    const entId = "33333333-3333-4333-8333-333333333333";
    syncData.withApplying(() =>
      db()
        .query(
          "INSERT INTO entities (id, entity_type, canonical_name, created_at, updated_at) VALUES (?, 'tool', 'Bulk', 1, 1)",
        )
        .run(entId),
    );
    const ts = new Date(2_000_000).toISOString(); // one exact ms for every row
    for (let i = 0; i < 205; i++) {
      tableRows("entity_aliases").push({
        id: `alias-${String(i).padStart(4, "0")}`,
        entity_id: entId,
        alias_type: "name",
        alias_value: `bulk-${i}`,
        source: null,
        created_at: 1,
        updated_at: ts,
      } as never);
    }
    // Sorts LAST (so it lands in the DRAIN batch, not the first page) and its entity is absent.
    tableRows("entity_aliases").push({
      id: "alias-zzzz-orphan",
      entity_id: "44444444-4444-4444-8444-444444444444",
      alias_type: "name",
      alias_value: "bulk-orphan",
      source: null,
      created_at: 1,
      updated_at: ts,
    } as never);

    const r = await pullOnce(makeClient() as never); // must NOT throw (drain path)

    expect(
      db()
        .query("SELECT COUNT(*) AS c FROM entity_aliases WHERE entity_id = ?")
        .get(entId),
    ).toEqual({ c: 205 });
    expect(
      db()
        .query("SELECT 1 FROM entity_aliases WHERE id = 'alias-zzzz-orphan'")
        .get(),
    ).toBeNull();
    expect(r.skipped).toBeGreaterThanOrEqual(1);
    expect(
      db()
        .query(
          "SELECT 1 FROM sync_conflicts WHERE row_id = 'alias-zzzz-orphan'",
        )
        .get(),
    ).not.toBeNull();
  });

  test("drainTimestamp also converges an alias UNIQUE collision (not just the primary loop) (#1217)", async () => {
    // The alias convergence must hold on the DRAIN path too (>PAGE rows sharing one ms),
    // else the guarantee has a gap. Force the drain, land a collider in it, assert it
    // resolves (converges) rather than skipping.
    syncData.enableSync("basic");
    const entId = "77777777-7777-4777-8777-777777777777";
    syncData.withApplying(() => {
      db()
        .query(
          "INSERT INTO entities (id, entity_type, canonical_name, created_at, updated_at) VALUES (?, 'tool', 'Bulk2', 1, 1)",
        )
        .run(entId);
      // Local alias with a HIGH id occupies UNIQUE(name, 'collide-val').
      db()
        .query(
          "INSERT INTO entity_aliases (id, entity_id, alias_type, alias_value, source, created_at) VALUES ('zzzzzzzz-local', ?, 'name', 'collide-val', NULL, 1)",
        )
        .run(entId);
    });
    const ts = new Date(2_000_000).toISOString(); // one exact ms for every remote row
    for (let i = 0; i < 205; i++) {
      tableRows("entity_aliases").push({
        id: `alias-${String(i).padStart(4, "0")}`,
        entity_id: entId,
        alias_type: "name",
        alias_value: `bulk-${i}`,
        source: null,
        created_at: 1,
        updated_at: ts,
      } as never);
    }
    // The collider sorts LAST (→ lands in the DRAIN batch) and has a LOWER id than the
    // local alias ('alias-…' < 'zzzzzzzz-local') → remote wins, dropping the local loser.
    tableRows("entity_aliases").push({
      id: "alias-zzzz-collide",
      entity_id: entId,
      alias_type: "name",
      alias_value: "collide-val",
      source: null,
      created_at: 1,
      updated_at: ts,
    } as never);

    const r = await pullOnce(makeClient() as never); // must NOT throw (drain path)

    expect(r.conflicts).toBeGreaterThanOrEqual(1);
    // Remote (lower id) winner applied; local (higher id) loser dropped + recorded.
    expect(
      db()
        .query("SELECT 1 FROM entity_aliases WHERE id = 'alias-zzzz-collide'")
        .get(),
    ).not.toBeNull();
    expect(
      db()
        .query("SELECT 1 FROM entity_aliases WHERE id = 'zzzzzzzz-local'")
        .get(),
    ).toBeNull();
    expect(
      db()
        .query(
          "SELECT 1 FROM sync_conflicts WHERE row_id = 'zzzzzzzz-local' AND resolution = 'alias_unique_superseded'",
        )
        .get(),
    ).not.toBeNull();
  });

  test("a remote tombstone that RETAINED its content_hash still deletes a content-identical local row", async () => {
    // pushEntry soft-deletes by setting is_deleted=true but leaves the remote
    // content_hash intact (it nulls only the LOCAL sync_state). A client pulling
    // that tombstone must STILL apply the delete even though the hash matches its
    // local content — otherwise classifyRemoteRow mis-classifies it "skip" and a
    // cross-client / post-conflict delete is silently dropped (divergence).
    syncData.enableSync("basic");
    insertKnowledge("kt", "same");
    await pushOnce(makeClient() as never); // remote kt: live, content_hash set
    // Another client soft-deletes kt but the remote row KEEPS its content_hash —
    // exactly the wire shape pushEntry produces.
    const remoteRow = tableRows("knowledge").find(
      (r) => r.id === "kt",
    ) as Record<string, unknown>;
    remoteRow.is_deleted = true;
    remoteRow.updated_at = new Date(9_000_000).toISOString(); // past the pull cursor
    expect(typeof remoteRow.content_hash).toBe("string"); // hash intact (the trap)
    const r = await pullOnce(makeClient() as never);
    expect(currentContent("kt")).toBeNull(); // delete propagated (death-cert)
    expect(r.pulled).toBe(1); // a clean apply…
    expect(r.conflicts).toBe(0); // …not a conflict
  });

  test("conflict resolves remote-wins AND preserves the discarded local row", async () => {
    syncData.enableSync("basic");
    insertKnowledge("kc", "local-edit"); // unpushed → pending local change
    const pid = ensureProject("/tmp/lore-sync-engine");
    tableRows("knowledge").push({
      id: "kc",
      project_id: pid,
      category: "pattern",
      title: "T",
      content: "remote-edit",
      content_hash: "remotehash",
      revision: 9,
      is_deleted: false,
      created_at: new Date(4_000_000).toISOString(),
      updated_at: new Date(4_000_000).toISOString(),
    });
    const r = await pullOnce(makeClient() as never);
    expect(r.conflicts).toBe(1);
    expect(currentContent("kc")).toBe("remote-edit"); // remote wins → new current version
    // The discarded local edit is recoverable from sync_conflicts.local_content.
    const row = db()
      .query("SELECT local_content FROM sync_conflicts WHERE row_id='kc'")
      .get() as { local_content: string };
    expect(JSON.parse(row.local_content).content).toBe("local-edit");
  });

  test("a versioned (v2+) entry echo-pulls as skip — NO false conflict (#823, Seer)", async () => {
    // BLOCKER regression: classifyRemoteRow must hash the CURRENT version
    // (knowledge_current, keyed by logical_id), not the demoted v1 base row that
    // getRowById(id=logical_id) returns. Reverting that fix makes this fail with
    // conflicts=1 / pulled=1 and a stale (v1) sync_conflicts.local_content.
    syncData.enableSync("basic");
    const id = ltm.create({
      projectPath: "/tmp/lore-sync-engine",
      scope: "project",
      category: "pattern",
      title: "V",
      content: "v1",
    });
    ltm.update(id, { content: "v2" }); // append v2 → current row id ≠ logical_id (id)
    await pushOnce(makeClient() as never);
    // Pulling our OWN just-pushed current content must classify skip, not conflict.
    const r = await pullOnce(makeClient() as never);
    expect(r.conflicts).toBe(0);
    expect(r.pulled).toBe(0);
    expect(currentContent(id)).toBe("v2");
    expect(
      (
        db()
          .query("SELECT COUNT(*) AS n FROM sync_conflicts WHERE row_id = ?")
          .get(id) as { n: number }
      ).n,
    ).toBe(0); // no false conflict recorded
  });

  test("conflict on a versioned (v2) entry snapshots the CURRENT version, not stale v1 (#823)", async () => {
    // Guards the conflict-snapshot half of the classify fix: localBefore must read
    // knowledge_current (current version), not getRowById (the demoted v1 row), so
    // the discarded edit recoverable from sync_conflicts.local_content is the real
    // superseded content. Reverting that branch to getRowById makes this fail.
    syncData.enableSync("basic");
    const id = ltm.create({
      projectPath: "/tmp/lore-sync-engine",
      scope: "project",
      category: "pattern",
      title: "VC",
      content: "v1",
    });
    await pushOnce(makeClient() as never); // remote synced at v1
    ltm.update(id, { content: "local-v2" }); // append v2, UNPUSHED → pending local change
    // A divergent remote edit on the same logical_id (remote is keyed by id=logical_id).
    const remoteRow = tableRows("knowledge").find((r) => r.id === id) as Record<
      string,
      unknown
    >;
    remoteRow.content = "remote-v2";
    remoteRow.content_hash = "remotehash-v2";
    remoteRow.updated_at = new Date(9_000_000).toISOString();
    const r = await pullOnce(makeClient() as never);
    expect(r.conflicts).toBe(1);
    expect(currentContent(id)).toBe("remote-v2"); // LWW: remote wins
    const row = db()
      .query("SELECT local_content FROM sync_conflicts WHERE row_id = ?")
      .get(id) as { local_content: string };
    expect(JSON.parse(row.local_content).content).toBe("local-v2"); // current v2, not v1
  });

  test("a physical delete of a non-v1 version propagates to the remote by logical_id (#823, Seer)", async () => {
    // The DELETE capture trigger must record the logical_id, not the version id —
    // otherwise a delete of a version whose id ≠ logical_id targets a remote row
    // that doesn't exist (remote is keyed by logical_id) and silently no-ops.
    syncData.enableSync("basic");
    const id = ltm.create({
      projectPath: "/tmp/lore-sync-engine",
      scope: "project",
      category: "pattern",
      title: "PD",
      content: "v1",
    });
    ltm.update(id, { content: "v2" }); // current version's id is a fresh uuid ≠ id
    const currentId = (
      db()
        .query(
          "SELECT id FROM knowledge_current WHERE COALESCE(logical_id, id) = ?",
        )
        .get(id) as { id: string }
    ).id;
    expect(currentId).not.toBe(id);
    await pushOnce(makeClient() as never); // remote row keyed by logical_id (= id)
    // Physically delete the current version by its (non-logical) id.
    db().query("DELETE FROM knowledge WHERE id = ?").run(currentId);
    await pushOnce(makeClient() as never);
    const remote = tableRows("knowledge").find((r) => r.id === id) as
      | Record<string, unknown>
      | undefined;
    expect(remote?.is_deleted).toBe(true); // delete propagated via logical_id
  });

  test("a versioned entry deleted while sync is OFF tombstones on re-enable (#823)", async () => {
    // reconcile() must tombstone by knowledge_current liveness, not physical-row
    // existence — a deleted entry keeps its demoted/death-cert version rows, so an
    // id=logical_id existence check would never reconcile a delete made while OFF.
    syncData.enableSync("basic");
    const id = ltm.create({
      projectPath: "/tmp/lore-sync-engine",
      scope: "project",
      category: "pattern",
      title: "DW",
      content: "v1",
    });
    ltm.update(id, { content: "v2" }); // versioned
    await pushOnce(makeClient() as never); // remote live
    expect(
      (
        tableRows("knowledge").find((r) => r.id === id) as Record<
          string,
          unknown
        >
      )?.is_deleted,
    ).toBeFalsy();
    syncData.disableSync();
    ltm.remove(id); // death-cert while OFF → capture trigger doesn't fire
    syncData.enableSync("basic"); // reconcile enqueues the missed delete
    await pushOnce(makeClient() as never);
    expect(
      (
        tableRows("knowledge").find((r) => r.id === id) as Record<
          string,
          unknown
        >
      )?.is_deleted,
    ).toBe(true);
  });

  test("physically deleting a SUPERSEDED version of a live entry does NOT delete the remote (#823, sub-PR 4 guard)", async () => {
    // A physical delete of a non-current version fires op=delete keyed by logical_id.
    // The push delete branch must re-validate liveness: the entry still has a live
    // current version, so this is NOT a deletion — re-push current, don't tombstone.
    syncData.enableSync("basic");
    const id = ltm.create({
      projectPath: "/tmp/lore-sync-engine",
      scope: "project",
      category: "pattern",
      title: "SV",
      content: "v1",
    });
    ltm.update(id, { content: "v2" }); // v2 current; v1 (id=id) demoted
    await pushOnce(makeClient() as never); // remote live, content v2
    // Physically delete only the SUPERSEDED v1 row — the entry lives on at v2.
    db().query("DELETE FROM knowledge WHERE id = ? AND is_current = 0").run(id);
    await pushOnce(makeClient() as never);
    const remote = tableRows("knowledge").find((r) => r.id === id) as
      | Record<string, unknown>
      | undefined;
    expect(remote?.is_deleted).toBeFalsy(); // still live → NOT deleted
    expect(remote?.content).toBe("v2"); // current content retained
  });
});

describe("profiles (pull-only mirror)", () => {
  function seedRemoteProfile(tier: string, atMs: number): void {
    // Remote profiles has NO content_hash/revision/owner column — it is
    // server-authoritative and unversioned (mirrors supabase 0001 + tier 0003).
    tableRows("profiles").push({
      id: "u1",
      tier,
      github_login: "octocat",
      display_name: "Octo Cat",
      email: "octo@cat.dev",
      created_at: new Date(atMs).toISOString(),
      updated_at: new Date(atMs).toISOString(),
    } as never);
  }

  test("pushOnce never uploads profiles (pull-only, no capture)", async () => {
    syncData.enableSync("basic");
    // Even a direct local write can't be pushed: there's no capture trigger and
    // pushOnce skips pull-only tables.
    db()
      .query(
        "INSERT INTO profiles (id, tier, created_at, updated_at) VALUES ('u1','pro',?,?)",
      )
      .run(now(), now());
    const r = await pushOnce(makeClient() as never);
    expect(r.pushed).toBe(0);
    expect(tableRows("profiles")).toHaveLength(0);
    expect(
      syncData.readOutbox(0).some((e) => e.table_name === "profiles"),
    ).toBe(false);
  });

  test("a local profiles row does NOT wedge the outbox prune floor at 0", async () => {
    // Pre-populate the mirror, THEN enable: reconcile/seedOutbox must not enqueue
    // profiles. If they did, pushOnce would skip the (never-advancing) profiles
    // entry, pinning minCursor=0 and permanently disabling outbox pruning for ALL
    // tables. Pushing knowledge must still reclaim its outbox rows.
    db()
      .query(
        "INSERT INTO profiles (id, tier, created_at, updated_at) VALUES ('u1','pro',?,?)",
      )
      .run(now(), now());
    syncData.enableSync("basic");
    insertKnowledge("k1", "hello");
    await pushOnce(makeClient() as never);
    expect(
      syncData.readOutbox(0, 1000).filter((e) => e.table_name === "knowledge")
        .length,
    ).toBe(0); // pruned — not wedged by a profiles entry
    expect(
      syncData.readOutbox(0).some((e) => e.table_name === "profiles"),
    ).toBe(false);
  });

  test("pullOnce mirrors the remote row and resolves the plan tier", async () => {
    syncData.enableSync("basic");
    seedRemoteProfile("pro", 2_000_000);
    const r = await pullOnce(makeClient() as never);
    expect(r.pulled).toBe(1);
    expect(syncData.currentTier()).toBe("pro");
    expect(syncData.getRowById("profiles", "u1")?.github_login).toBe("octocat");
  });

  test("a billing-driven tier flip propagates on the next pull WITHOUT a conflict", async () => {
    syncData.enableSync("basic");
    seedRemoteProfile("free", 2_000_000);
    await pullOnce(makeClient() as never);
    expect(syncData.currentTier()).toBe("free");

    // service_role flips tier → updated_at bumps. Re-pull must take it cleanly:
    // a pull-only row can never be a "conflict" (the client never writes it).
    const rows = tableRows("profiles");
    rows[0].tier = "pro";
    rows[0].updated_at = new Date(3_000_000).toISOString();
    const r = await pullOnce(makeClient() as never);
    expect(syncData.currentTier()).toBe("pro");
    expect(r.conflicts).toBe(0);
    expect(
      db().query("SELECT COUNT(*) n FROM sync_conflicts").get() as {
        n: number;
      },
    ).toEqual({ n: 0 });
  });
});

describe("syncOnce", () => {
  test("no-op when disabled; notAuthed when logged out", async () => {
    expect(await syncOnce()).toEqual({
      pushed: 0,
      pulled: 0,
      conflicts: 0,
      skipped: 0,
    });
    syncData.enableSync("basic");
    authed = false;
    expect((await syncOnce()).notAuthed).toBe(true);
  });

  test("push-then-pull; our own pushed row echo-pulls as skip (no ping-pong)", async () => {
    syncData.enableSync("basic");
    insertKnowledge("k1", "hello");
    const r = await syncOnce();
    expect(r.pushed).toBe(1);
    // Echo-pull of our own row is a no-op (hash matches) — pulled stays 0.
    expect(r.pulled).toBe(0);
    expect(tableRows("knowledge").find((x) => x.id === "k1")).toBeTruthy();
  });

  test("reports per-table device pull progress for the reaper watermark (#909)", async () => {
    syncData.enableSync("basic");
    insertKnowledge("k1", "hello");
    await syncOnce();
    const prog = tableRows("sync_device_progress");
    const deviceId = syncData.replicaId();
    // We report every non-pull-only synced table (a superset of the reaper's tables; the
    // extra rows are inert — the reaper only queries its own table_names).
    const reported = syncData
      .syncedTables("basic")
      .filter((m) => !m.pullOnly)
      .map((m) => m.table);
    expect(prog.length).toBe(reported.length);
    expect(prog.every((r) => r.device_id === deviceId)).toBe(true);
    expect(new Set(prog.map((r) => r.table_name))).toEqual(new Set(reported));
    // pulled_through is the device's keyset cursor as an ISO string, never null.
    expect(prog.every((r) => typeof r.pulled_through === "string")).toBe(true);
  });
});

describe("knowledge_meta register sync (A2 3b-2)", () => {
  test("pushOnce uploads the base register row AND the CRDT counters", async () => {
    syncData.enableSync("basic");
    // Capture triggers fire on these local writes (sync enabled) → outbox.
    db()
      .query(
        "INSERT INTO knowledge_meta (logical_id, confidence, base_confidence, updated_at) VALUES ('k1', 0.6, 0.6, ?)",
      )
      .run(now());
    db()
      .query(
        "INSERT INTO knowledge_meta_crdt (logical_id, replica_id, pos, neg, updated_at) VALUES ('k1', 'rA', 0.1, 0, ?)",
      )
      .run(now());
    await pushOnce(makeClient() as never);
    // Base: the IMMUTABLE base_confidence is uploaded (NOT the local-derived confidence).
    const baseRow = tableRows("knowledge_meta").find(
      (x) => x.logical_id === "k1",
    );
    expect(baseRow?.base_confidence).toBeCloseTo(0.6, 6);
    expect("confidence" in (baseRow ?? {})).toBe(false); // local-derived, never synced
    // Counters: the local replica's grow-only row is uploaded.
    const crdtRow = tableRows("knowledge_meta_crdt").find(
      (x) => x.logical_id === "k1" && x.replica_id === "rA",
    );
    expect(crdtRow?.pos).toBeCloseTo(0.1, 6);
    expect(crdtRow?.neg).toBe(0);
  });

  test("the per-op confidence re-materialization does NOT churn the base outbox", () => {
    syncData.enableSync("basic");
    db()
      .query(
        "INSERT INTO knowledge_meta (logical_id, confidence, base_confidence, updated_at) VALUES ('k1', 0.6, 0.6, ?)",
      )
      .run(now());
    db().exec("DELETE FROM sync_outbox"); // ignore the INSERT capture
    // A materialization-style write (confidence/updated_at only, base unchanged)
    // must NOT enqueue a knowledge_meta push (the UPDATE trigger is base-gated).
    db()
      .query(
        "UPDATE knowledge_meta SET confidence = 0.55, updated_at = ? WHERE logical_id = 'k1'",
      )
      .run(now() + 1);
    expect(
      syncData.readOutbox(0).filter((e) => e.table_name === "knowledge_meta")
        .length,
    ).toBe(0);
  });
});

describe("encryption key store — C-3 (#825)", () => {
  // v1 invariant: the local encryption scope IS the user, so getScopeKey is called
  // with the user id (== the server-derived scope_id). Use REMOTE_SCOPE as that id so
  // a pulled scope_keys row reconstructs a scope_id matching the local getScopeKey arg.
  const SCOPE = REMOTE_SCOPE;

  test("push base64-encodes BLOB columns for the wire (never a raw Buffer)", async () => {
    syncData.enableSync("basic");
    keystore.setPassphrase("pw", { params: { t: 1, m: 256, p: 1 } });
    await keystore.getScopeKey(SCOPE, SCOPE);
    await pushOnce(makeClient() as never);

    const escrow = tableRows("account_escrow")[0];
    expect(typeof escrow.wrapped_secret).toBe("string"); // base64, not a Buffer/object
    expect(typeof escrow.kdf_salt).toBe("string");
    expect(escrow.scope_id).toBe(REMOTE_SCOPE); // server-derived
    const sk = tableRows("scope_keys")[0];
    expect(typeof sk.wrapped_dek).toBe("string");
    expect(sk.member_user_id).toBe(SCOPE);
  });

  test("a fresh device pulls escrow + scope_keys, unlocks, and unwraps the SAME DEK", async () => {
    syncData.enableSync("basic");
    // device 1
    const id1 = keystore.getAccountIdentity();
    const dek1 = await keystore.getScopeKey(SCOPE, SCOPE);
    keystore.setPassphrase("hunter2", { params: { t: 1, m: 256, p: 1 } });
    await pushOnce(makeClient() as never);

    // simulate a fresh device 2 that shares the remote: wipe all local key state +
    // sync_state, reset the pull cursors, then pull.
    db().exec("DELETE FROM account_identity");
    db().exec("DELETE FROM account_escrow");
    db().exec("DELETE FROM scope_keys");
    db().exec("DELETE FROM sync_state");
    keystore.lock();
    for (const t of ["account_escrow", "scope_keys"])
      setKV(`sync.pull.${t}`, "0|");

    await pullOnce(makeClient() as never);

    // locked (escrow present, no identity) → unlock → recovers the SAME identity + DEK
    expect(keystore.hasAccountIdentity()).toBe(false);
    expect(keystore.unlockWithPassphrase("hunter2")).toBe(true);
    expect(
      Buffer.from(keystore.getAccountIdentity().secretKey).equals(
        Buffer.from(id1.secretKey),
      ),
    ).toBe(true);
    const dek2 = await keystore.getScopeKey(SCOPE, SCOPE);
    expect(Buffer.from(dek2).equals(Buffer.from(dek1))).toBe(true);
  });

  test("account_escrow / scope_keys advance their push cursors (never wedge the prune floor)", async () => {
    syncData.enableSync("basic");
    keystore.setPassphrase("pw", { params: { t: 1, m: 256, p: 1 } });
    await keystore.getScopeKey(SCOPE, SCOPE);
    const r = await pushOnce(makeClient() as never);
    expect(r.pushed).toBeGreaterThan(0);
    // The push consumed both tables' outbox entries by advancing their per-table
    // cursors (entries are pruned later against the min cursor). A non-advancing
    // cursor is the #828 prune-floor wedge — assert both moved off 0.
    expect(Number(getKV("sync.push.account_escrow") ?? "0")).toBeGreaterThan(0);
    expect(Number(getKV("sync.push.scope_keys") ?? "0")).toBeGreaterThan(0);
  });
});

describe("knowledge wire encryption — C-4 (#825)", () => {
  const SCOPE = REMOTE_SCOPE; // == getCurrentUser().user_id in the mock
  const FAST = { t: 1, m: 256, p: 1 };

  async function enableEncryption() {
    keystore.setPassphrase("pw", { params: FAST });
    await keystore.getScopeKey(SCOPE, SCOPE);
  }

  // Wipe local knowledge (+ derived) and reset its pull cursor to simulate a device
  // that must re-pull knowledge from the remote.
  function resetLocalKnowledge() {
    db().exec("DELETE FROM knowledge");
    db().exec("DELETE FROM knowledge_meta");
    db().exec("DELETE FROM knowledge_meta_crdt");
    db().exec("DELETE FROM sync_state WHERE table_name='knowledge'");
    // The wipe above fires the capture trigger (sync enabled) → a DELETE outbox
    // entry; a genuinely fresh device has none. Drop it + reset cursors so the pull
    // sees a clean slate (no phantom pendingLocalChange → no spurious conflict).
    db().exec("DELETE FROM sync_outbox WHERE table_name='knowledge'");
    setKV("sync.push.knowledge", "0");
    setKV("sync.pull.knowledge", "0|");
  }

  test("push seals content + title; the server only ever sees ciphertext", async () => {
    syncData.enableSync("basic");
    await enableEncryption();
    insertKnowledge("k1", "top secret content");
    await pushOnce(makeClient() as never);

    const row = tableRows("knowledge").find((r) => r.id === "k1") as RemoteRow;
    expect(row.content).not.toBe("top secret content");
    expect(crypto.isEnvelope(Buffer.from(String(row.content), "base64"))).toBe(
      true,
    );
    expect(crypto.isEnvelope(Buffer.from(String(row.title), "base64"))).toBe(
      true,
    );
    // content_hash is over the PLAINTEXT local row (not the ciphertext), so it equals
    // the local hash — the property that keeps it cross-device stable.
    const local = syncData.getRowById("knowledge", "k1") as Record<
      string,
      unknown
    >;
    expect(row.content_hash).toBe(syncData.contentHash("knowledge", local));
  });

  test("pull decrypts back to plaintext, no conflict", async () => {
    syncData.enableSync("basic");
    await enableEncryption();
    insertKnowledge("k1", "top secret content");
    await pushOnce(makeClient() as never);

    resetLocalKnowledge(); // device-2 (same unlocked keystore) re-pulls
    const r = await pullOnce(makeClient() as never);
    expect(currentContent("k1")).toBe("top secret content");
    expect(r.conflicts).toBe(0);
  });

  test("encryption OFF (no escrow) pushes content as plaintext", async () => {
    syncData.enableSync("basic");
    insertKnowledge("k1", "not a secret");
    await pushOnce(makeClient() as never);
    const row = tableRows("knowledge").find((r) => r.id === "k1") as RemoteRow;
    expect(row.content).toBe("not a secret");
    expect(crypto.isEnvelope(Buffer.from(String(row.content), "base64"))).toBe(
      false,
    );
  });

  test("a LOCKED device does not push knowledge (can't encrypt) — table paused", async () => {
    syncData.enableSync("basic");
    await enableEncryption();
    insertKnowledge("k1", "secret");
    db().exec("DELETE FROM account_identity"); // escrow present, identity gone
    keystore.lock();
    expect(keystore.encryptionState()).toBe("locked");

    await pushOnce(makeClient() as never);
    expect(tableRows("knowledge")).toHaveLength(0); // nothing pushed
    expect(Number(getKV("sync.push.knowledge") ?? "0")).toBe(0); // cursor frozen
  });

  test("a LOCKED device does not pull knowledge (can't decrypt) — cursor frozen", async () => {
    syncData.enableSync("basic");
    await enableEncryption();
    insertKnowledge("k1", "secret");
    await pushOnce(makeClient() as never); // remote now holds ciphertext

    resetLocalKnowledge();
    db().exec("DELETE FROM account_identity");
    keystore.lock();
    expect(keystore.encryptionState()).toBe("locked");

    await pullOnce(makeClient() as never);
    expect(currentContent("k1")).toBeNull(); // knowledge skipped
    expect(getKV("sync.pull.knowledge")).toBe("0|"); // cursor frozen
  });

  test("push fails CLOSED: encryption on but unresolvable scope pauses (never leaks plaintext)", async () => {
    syncData.enableSync("basic");
    await enableEncryption();
    expect(keystore.encryptionState()).toBe("on");
    insertKnowledge("k1", "top secret content");
    mockUserId = undefined; // scope can't resolve → ctx() is null

    await pushOnce(makeClient() as never);
    expect(tableRows("knowledge")).toHaveLength(0); // NOT pushed as plaintext
    expect(Number(getKV("sync.push.knowledge") ?? "0")).toBe(0); // cursor frozen
  });

  test("round-trips multibyte UTF-8 content through seal/open", async () => {
    syncData.enableSync("basic");
    await enableEncryption();
    const text = "héllo 世界 — naïve façade ☃ 🔐 emoji";
    insertKnowledge("k1", text);
    await pushOnce(makeClient() as never);
    const row = tableRows("knowledge").find((r) => r.id === "k1") as RemoteRow;
    expect(crypto.isEnvelope(Buffer.from(String(row.content), "base64"))).toBe(
      true,
    );

    resetLocalKnowledge();
    await pullOnce(makeClient() as never);
    expect(currentContent("k1")).toBe(text);
  });

  test("a decrypt failure (wrong key / tampered) defers the table, never crashes the cycle", async () => {
    syncData.enableSync("basic");
    await enableEncryption();
    insertKnowledge("k1", "real content");
    await pushOnce(makeClient() as never);
    // Tamper: replace the remote ciphertext with an envelope sealed under a DIFFERENT
    // DEK — a valid envelope this device holds a (wrong) key for → open() throws.
    const otherDek = new Uint8Array(32).fill(9);
    const env = crypto.seal(
      otherDek,
      new TextEncoder().encode("evil"),
      crypto.buildAad(SCOPE, "knowledge", "content", "k1"),
    );
    const rr = tableRows("knowledge").find((r) => r.id === "k1") as RemoteRow;
    rr.content = Buffer.from(env).toString("base64");

    resetLocalKnowledge();
    expect(keystore.encryptionState()).toBe("on");
    // Must NOT throw (a raw AEAD error would crash the whole cycle).
    await expect(pullOnce(makeClient() as never)).resolves.toBeDefined();
    expect(currentContent("k1")).toBeNull(); // not applied
    expect(getKV("sync.pull.knowledge")).toBe("0|"); // cursor frozen
  });

  test("a key-resolution failure (corrupt wrapped DEK) defers the table, never crashes", async () => {
    syncData.enableSync("basic");
    await enableEncryption();
    insertKnowledge("k1", "secret");
    await pushOnce(makeClient() as never); // remote ciphertext under the real DEK

    // Corrupt the wrapped DEK so the next getScopeKey unwrap throws (+ invalidates the
    // cache). encryptionState stays "on" (identity present). Also clear the REMOTE
    // scope_keys so the reorder's scope_keys pull can't self-heal it back.
    keystore.putWrappedScopeKey(
      SCOPE,
      SCOPE,
      new Uint8Array(80).fill(3),
      0,
      now(),
    );
    tableRows("scope_keys").length = 0;
    resetLocalKnowledge();
    expect(keystore.encryptionState()).toBe("on");

    await expect(pullOnce(makeClient() as never)).resolves.toBeDefined(); // no crash
    expect(currentContent("k1")).toBeNull(); // table deferred
    expect(getKV("sync.pull.knowledge")).toBe("0|"); // cursor frozen
  });

  test("OFF-mode plaintext that base64-decodes to look like an envelope is not misread", async () => {
    // "TEUB…" base64-decodes to bytes starting 0x4C 0x45 0x01 (the envelope magic +
    // scheme). Without the canonical-base64 guard, decryptColumns would treat this
    // ordinary plaintext as ciphertext and halt the table in OFF mode.
    syncData.enableSync("basic");
    const prose =
      "TEUB this is ordinary plaintext knowledge that merely starts with base64-looking characters and is long enough to exceed the envelope header length";
    insertKnowledge("k1", prose);
    await pushOnce(makeClient() as never);
    resetLocalKnowledge();
    expect(keystore.encryptionState()).toBe("off");

    await expect(pullOnce(makeClient() as never)).resolves.toBeDefined();
    expect(currentContent("k1")).toBe(prose); // synced as plaintext, not aborted
  });

  test("backstop: an OFF device never stores remote ciphertext as content", async () => {
    syncData.enableSync("basic");
    insertKnowledge("k1", "x");
    await pushOnce(makeClient() as never); // remote k1 (plaintext)
    // Craft a remote ciphertext row (sealed with a throwaway DEK + the C-4 AAD scheme).
    const dek = new Uint8Array(32).fill(7);
    const env = crypto.seal(
      dek,
      new TextEncoder().encode("ciphertext-only"),
      crypto.buildAad(SCOPE, "knowledge", "content", "k1"),
    );
    const rr = tableRows("knowledge").find((r) => r.id === "k1") as RemoteRow;
    rr.content = Buffer.from(env).toString("base64");

    resetLocalKnowledge();
    expect(keystore.encryptionState()).toBe("off"); // never set a passphrase

    await pullOnce(makeClient() as never);
    expect(currentContent("k1")).toBeNull(); // aborted — NOT corrupted with ciphertext
    expect(getKV("sync.pull.knowledge")).toBe("0|"); // cursor frozen
  });
});

describe("projects identity sync — #1246", () => {
  const SCOPE = REMOTE_SCOPE; // == getCurrentUser().user_id in the mock
  const FAST = { t: 1, m: 256, p: 1 };
  async function enableEncryption() {
    keystore.setPassphrase("pw", { params: FAST });
    await keystore.getScopeKey(SCOPE, SCOPE);
  }
  function insertProjectRow(id: string, gitRemote: string | null) {
    db()
      .query(
        "INSERT INTO projects (id, path, name, git_remote, created_at) VALUES (?, ?, 'repo', ?, ?)",
      )
      .run(id, `/local/${id}`, gitRemote, Date.now());
  }

  test("push seals git_remote + name; path (device-local) is never sent", async () => {
    syncData.enableSync("basic");
    await enableEncryption();
    insertProjectRow("pj1", "github.com/o/secret-repo");
    await pushOnce(makeClient() as never); // strict mock → PGRST204 if path leaks

    const row = tableRows("projects").find((r) => r.id === "pj1") as RemoteRow;
    expect(row).toBeTruthy();
    expect(row.git_remote).not.toBe("github.com/o/secret-repo"); // sealed
    expect(
      crypto.isEnvelope(Buffer.from(String(row.git_remote), "base64")),
    ).toBe(true);
    expect(crypto.isEnvelope(Buffer.from(String(row.name), "base64"))).toBe(
      true,
    );
    expect("path" in row).toBe(false); // never synced
  });

  test("a remote-less project is never pushed (git_remote gate)", async () => {
    syncData.enableSync("basic");
    await enableEncryption();
    insertProjectRow("pj-none", null);
    await pushOnce(makeClient() as never);
    expect(
      tableRows("projects").find((x) => x.id === "pj-none"),
    ).toBeUndefined();
  });

  test("pull seeds a synthetic-path row with the DECRYPTED git_remote", async () => {
    syncData.enableSync("basic");
    await enableEncryption();
    insertProjectRow("pj2", "github.com/o/r2");
    await pushOnce(makeClient() as never); // remote now holds ciphertext

    // device-2 (same unlocked keystore): drop the local row, re-pull it.
    db().query("DELETE FROM projects WHERE id = 'pj2'").run();
    db().exec("DELETE FROM sync_state");
    setKV("sync.pull.projects", "0|");
    await pullOnce(makeClient() as never);

    const p = db()
      .query("SELECT path, git_remote FROM projects WHERE id = 'pj2'")
      .get() as { path: string; git_remote: string } | null;
    expect(p?.path).toBe("lore:project/pj2"); // synthetic placeholder
    expect(p?.git_remote).toBe("github.com/o/r2"); // decrypted on the wire
  });
});
