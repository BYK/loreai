import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  db,
  ensureProject,
  getKV,
  setKV,
  deleteTeamConfig,
} from "@loreai/core";
import { syncData } from "@loreai/core";

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
};

function makeClient() {
  return {
    from(table: string) {
      return {
        upsert(payload: Record<string, unknown>) {
          if (quotaTables.has(table)) {
            return Promise.resolve({
              error: { code: "23514", message: `quota exceeded for ${table}` },
            });
          }
          if (poisonIds.has(String(payload.id)))
            return Promise.resolve({
              error: {
                code: "23514",
                message: `new row violates check constraint "${table}_size_ck"`,
              },
            });
          if (upsertError) return Promise.resolve({ error: upsertError });
          // Faithful to the remote schema: an unknown column is a PGRST204 (the
          // join table has NO content_hash/revision columns).
          const allowed = REMOTE_COLUMNS[table];
          if (allowed) {
            for (const k of Object.keys(payload)) {
              if (!allowed.has(k)) {
                return Promise.resolve({
                  error: {
                    code: "PGRST204",
                    message: `Could not find the '${k}' column of '${table}' in the schema cache`,
                  },
                });
              }
            }
          }
          // Faithful to timestamptz columns: a bare epoch-ms integer is rejected
          // (22008) the way real Postgres does — only ISO strings are accepted.
          for (const k of ["created_at", "updated_at"]) {
            if (k in payload && typeof payload[k] !== "string") {
              return Promise.resolve({
                error: {
                  code: "22008",
                  message: `date/time field value out of range: "${payload[k]}"`,
                },
              });
            }
          }
          const rows = tableRows(table);
          const idc = idColumns(table);
          const i = rows.findIndex((r) =>
            idc.every((c) => r[c] === payload[c]),
          );
          const stamped = { ...payload, updated_at: nextTs() } as RemoteRow;
          if (i >= 0) rows[i] = stamped;
          else rows.push(stamped);
          return Promise.resolve({ error: null });
        },
        update(patch: Record<string, unknown>) {
          return {
            match(filter: Record<string, string>) {
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
vi.mock("../src/supabase", () => ({
  getAuthedClient: () => Promise.resolve(authed ? makeClient() : null),
  getCurrentUser: () => Promise.resolve({ github_login: "octocat" }),
}));

import { pushOnce, pullOnce, syncOnce } from "../src/sync";

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
  deleteTeamConfig("sync.enabled");
  db().exec("DELETE FROM temp._sync_applying");
  db().exec("DELETE FROM knowledge");
  db().exec("DELETE FROM entities");
  db().exec("DELETE FROM profiles");
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
  ]) {
    setKV(`sync.push.${t}`, "0");
    setKV(`sync.pull.${t}`, "0|");
  }
  remote.clear();
  quotaTables = new Set();
  upsertError = null;
  poisonIds.clear();
  fixedTs = null;
  authed = true;
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
    expect(tableRows("knowledge").find((r) => r.id === "k1")?.is_deleted).toBe(
      true,
    );
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
    expect(syncData.getRowById("knowledge", "kr")?.content).toBe("from server");

    syncData.withApplying(() => insertKnowledge("kd", "x"));
    tableRows("knowledge").push({
      id: "kd",
      is_deleted: true,
      content_hash: null,
      revision: 5,
      updated_at: new Date(3_000_000).toISOString(),
    } as never);
    await pullOnce(makeClient() as never);
    expect(syncData.getRowById("knowledge", "kd")).toBeNull();
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
    expect(syncData.getRowById("knowledge", "kc")?.content).toBe("remote-edit");
    // The discarded local edit is recoverable from sync_conflicts.local_content.
    const row = db()
      .query("SELECT local_content FROM sync_conflicts WHERE row_id='kc'")
      .get() as { local_content: string };
    expect(JSON.parse(row.local_content).content).toBe("local-edit");
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
    expect(await syncOnce()).toEqual({ pushed: 0, pulled: 0, conflicts: 0 });
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
});
