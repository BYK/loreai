// Property-based / sequence tests for the sync engine state machine (#833).
//
// Both #828 bugs lived in OPERATION SEQUENCES (disable->enable with residual
// state; lost writes through reconcile) that single-shot example tests never
// hit. Here we generate random sequences of sync ops with fast-check and assert
// STANDING INVARIANTS after every step, plus convergence after a push+pull —
// exactly the class of bug example tests miss. Failing sequences shrink to a
// minimal repro automatically.
//
// Runs against a faithful in-memory Supabase mock (trimmed from sync.test.ts:
// the adversarial knobs — quota/poison/forced-collision — live there; this file
// wants a clean, fast oracle for many runs).
import fc from "fast-check";
import {
  db,
  deleteTeamConfig,
  ensureProject,
  setKV,
  syncData,
} from "@loreai/core";
import { beforeEach, describe, expect, test, vi } from "vitest";

// --- Faithful in-memory Supabase (PostgREST surface the engine uses) ---------
interface RemoteRow extends Record<string, unknown> {
  updated_at: string;
}
const remote = new Map<string, RemoteRow[]>();
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
  clock += 1000;
  return new Date(clock).toISOString();
}
function idColumns(table: string): string[] {
  return (
    syncData.syncedTables("basic").find((m) => m.table === table)
      ?.idColumns ?? ["id"]
  );
}

function makeClient() {
  return {
    from(table: string) {
      return {
        upsert(payload: Record<string, unknown>) {
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
                const cmp =
                  o === "updated_at"
                    ? (Date.parse(String(a[o])) || 0) -
                      (Date.parse(String(c[o])) || 0)
                    : String(a[o]).localeCompare(String(c[o]));
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

// pushOnce/pullOnce take the client as an argument (we pass a fresh makeClient()
// each call — all share the module-level `remote`). The mock only keeps the real
// supabase module from loading; syncOnce() (which uses getAuthedClient) is unused.
vi.mock("../src/supabase", () => ({
  getAuthedClient: () => Promise.resolve(makeClient()),
  getCurrentUser: () => Promise.resolve({ github_login: "octocat" }),
}));

import { pullOnce, pushOnce } from "../src/sync";

const client = () => makeClient() as never;

const PROJECT = "/tmp/lore-sync-property";
const IDS = ["k1", "k2", "k3"] as const;

function resetAll(): void {
  deleteTeamConfig("sync.enabled");
  db().exec("DELETE FROM temp._sync_applying");
  db().exec("DELETE FROM knowledge_entity_refs");
  db().exec("DELETE FROM knowledge");
  db().exec("DELETE FROM entities");
  db().exec("DELETE FROM profiles");
  db().exec("DELETE FROM sync_outbox");
  db().exec("DELETE FROM sync_state");
  db().exec("DELETE FROM sync_conflicts");
  for (const m of syncData.syncedTables("basic")) {
    setKV(`sync.push.${m.table}`, "0");
    setKV(`sync.pull.${m.table}`, "0|");
  }
  remote.clear();
  clock = 1_000_000;
}

function exists(id: string): boolean {
  // NB: this driver's .get() returns null (not undefined) for a no-row result,
  // so a count is the only unambiguous existence check.
  return (
    (
      db()
        .query("SELECT count(*) AS n FROM knowledge WHERE id = ?")
        .get(id) as { n: number }
    ).n > 0
  );
}

// --- Op model ----------------------------------------------------------------
type Op =
  | { t: "insert"; id: string; content: string }
  | { t: "update"; id: string; content: string }
  | { t: "delete"; id: string }
  | { t: "enable" }
  | { t: "disable" }
  | { t: "push" }
  | { t: "pull" };

async function apply(op: Op): Promise<void> {
  const pid = ensureProject(PROJECT);
  switch (op.t) {
    case "insert":
      if (!exists(op.id)) {
        db()
          .query(
            `INSERT INTO knowledge (id, project_id, category, title, content, created_at, updated_at)
             VALUES (?, ?, 'pattern', 'T', ?, ?, ?)`,
          )
          .run(op.id, pid, op.content, Date.now(), Date.now());
      }
      break;
    case "update":
      if (exists(op.id)) {
        db()
          .query(
            "UPDATE knowledge SET content = ?, updated_at = ? WHERE id = ?",
          )
          .run(op.content, Date.now(), op.id);
      }
      break;
    case "delete":
      if (exists(op.id)) {
        db().query("DELETE FROM knowledge WHERE id = ?").run(op.id);
      }
      break;
    case "enable":
      syncData.enableSync("basic");
      break;
    case "disable":
      syncData.disableSync();
      break;
    case "push":
      await pushOnce(client());
      break;
    case "pull":
      await pullOnce(client());
      break;
  }
}

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    t: fc.constant("insert" as const),
    id: fc.constantFrom(...IDS),
    content: fc.string({ minLength: 1, maxLength: 8 }),
  }),
  fc.record({
    t: fc.constant("update" as const),
    id: fc.constantFrom(...IDS),
    content: fc.string({ minLength: 1, maxLength: 8 }),
  }),
  fc.record({ t: fc.constant("delete" as const), id: fc.constantFrom(...IDS) }),
  fc.record({ t: fc.constant("enable" as const) }),
  fc.record({ t: fc.constant("disable" as const) }),
  fc.record({ t: fc.constant("push" as const) }),
  fc.record({ t: fc.constant("pull" as const) }),
);
const seqArb = fc.array(opArb, { minLength: 1, maxLength: 14 });

function localIds(): Set<string> {
  return new Set(
    (db().query("SELECT id FROM knowledge").all() as Array<{ id: string }>).map(
      (r) => r.id,
    ),
  );
}
function remoteLiveIds(): Set<string> {
  return new Set(
    tableRows("knowledge")
      .filter((r) => r.is_deleted !== true)
      .map((r) => String(r.id)),
  );
}

describe("sync engine — property/sequence tests (#833)", () => {
  beforeEach(() => resetAll());

  test("standing invariants hold after EVERY op in a random sequence", async () => {
    await fc.assert(
      fc.asyncProperty(seqArb, async (ops) => {
        resetAll();
        for (const op of ops) {
          await apply(op);
          // The load-bearing invariants (#834): no pull-only outbox entry,
          // profiles mirror <= 1, every outbox/state row references a registered
          // table. Throws (fails the property) on any violation.
          syncData.assertSyncInvariants();
        }
      }),
      { numRuns: 60 },
    );
  });

  test("the outbox fully drains after a push (the prune floor never wedges)", async () => {
    await fc.assert(
      fc.asyncProperty(seqArb, async (ops) => {
        resetAll();
        syncData.enableSync("basic");
        for (const op of ops) await apply(op);
        await pushOnce(client());
        // pushOnce prunes seq <= min push cursor across tables-with-entries. Only
        // `knowledge` is ever mutated here, so after a (mock: always-succeeds)
        // push, EVERY entry is fully pushed and pruned -> the outbox is empty.
        // A wedged prune floor (e.g. min cursor pinned at 0 by an empty/pull-only
        // table — the #828 bug) would leave pushed entries stranded here.
        const remaining = (
          db().query("SELECT COUNT(*) AS n FROM sync_outbox").get() as {
            n: number;
          }
        ).n;
        expect(remaining).toBe(0);
      }),
      { numRuns: 60 },
    );
  });

  test("convergence: after enable+push+pull, local live set == remote live set (no lost writes)", async () => {
    await fc.assert(
      fc.asyncProperty(seqArb, async (ops) => {
        resetAll();
        syncData.enableSync("basic");
        for (const op of ops) await apply(op);
        // A final enable RECONCILES anything changed while sync was OFF (the #828
        // data-loss fix). The engine is eventually-consistent (multi-master with
        // remote-wins conflict resolution that can take a few exchanges to
        // settle — e.g. a local delete that lost a conflict still drains), so we
        // drain to a FIXPOINT: push+pull until neither side moves anything. No
        // write may be lost; oscillation that never settles would blow the cap.
        syncData.enableSync("basic");
        for (let i = 0; i < 8; i++) {
          const rp = await pushOnce(client());
          const rl = await pullOnce(client());
          if (rp.pushed === 0 && rl.pulled === 0) break;
        }
        expect([...localIds()].sort()).toEqual([...remoteLiveIds()].sort());
      }),
      { numRuns: 60 },
    );
  });

  test("no ping-pong: a second pull right after push+pull applies nothing new", async () => {
    await fc.assert(
      fc.asyncProperty(seqArb, async (ops) => {
        resetAll();
        syncData.enableSync("basic");
        for (const op of ops) await apply(op);
        syncData.enableSync("basic"); // reconcile + push so there ARE pushed rows
        await pushOnce(client());
        await pullOnce(client());
        // A second pull of our OWN just-pushed rows must apply nothing (they
        // classify as skip), and a re-push of unchanged rows must upload nothing.
        const r2 = await pullOnce(client());
        expect(r2.pulled).toBe(0);
        const r3 = await pushOnce(client());
        expect(r3.pushed).toBe(0);
      }),
      { numRuns: 40 },
    );
  });
});
