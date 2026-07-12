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
  ensureProject as ensureProjectCore,
  ltm,
  setKV,
  syncData,
} from "@loreai/core";
import { describe, expect, test, vi } from "vitest";

// P2a (#1246): content syncs only for REMOTE-BACKED projects (git_remote set). This
// property test asserts the local live set converges with the remote, so its project
// must be remote-backed. Stamp a git_remote under capture-suppression (no stray entry).
function ensureProject(path: string, name?: string): string {
  const id = ensureProjectCore(path, name);
  syncData.withApplying(() =>
    db()
      .query(
        "UPDATE projects SET git_remote = 'test:remote' WHERE id = ? AND git_remote IS NULL",
      )
      .run(id),
  );
  return id;
}

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
          const stamped = { ...payload, updated_at: nextTs() };
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
            // oxlint-disable-next-line unicorn/no-thenable -- faithful PostgREST builder mock
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
// supabase module from loading; syncOnce()/getCurrentUser are unused here.
vi.mock("../src/supabase", () => ({
  getAuthedClient: () => Promise.resolve(makeClient()),
}));

import { pullOnce, pushOnce } from "../src/sync";

const client = () => makeClient() as never;

const PROJECT = "/tmp/lore-sync-property";
const IDS = ["k1", "k2", "k3"] as const;

// Auth/tier model: `profiles` is a pull-only, server-authoritative mirror scoped
// (by RLS) to the signed-in user. We serve exactly the current user's profile so a
// pull mirrors ONE row and currentTier() resolves their plan. Seeding it means the
// data properties also exercise the #828 pull-only guards (a mirrored profile gives
// reconcile a pull-only row to (not) enqueue, and assertSyncInvariants then checks
// "profiles <= 1" and "no pull-only outbox entry").
const USERS: Record<string, string> = { u1: "pro", u2: "free" };
let currentUser = "u1";
function seedCurrentProfile(): void {
  remote.set("profiles", [
    {
      id: currentUser,
      tier: USERS[currentUser],
      github_login: currentUser,
      display_name: currentUser,
      email: `${currentUser}@x.dev`,
      is_deleted: false,
      created_at: new Date(1000).toISOString(),
      updated_at: nextTs(),
    },
  ]);
}

function resetAll(): void {
  deleteTeamConfig("sync.enabled");
  db().exec("DELETE FROM temp._sync_applying");
  db().exec("DELETE FROM knowledge_entity_refs");
  db().exec("DELETE FROM knowledge");
  // The knowledge_meta register + CRDT counters (A2 3b-2) are synced tables but are
  // NOT cascade-deleted by the hard `DELETE FROM knowledge` (no FK CASCADE). A
  // pulled entry mints a register row (insertKnowledgeVersion), so without clearing
  // them an orphan row survives resetAll, gets re-seeded at a low outbox seq, and
  // transiently pins the prune floor below this run's knowledge entries.
  db().exec("DELETE FROM knowledge_meta");
  db().exec("DELETE FROM knowledge_meta_crdt");
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
  currentUser = "u1";
  seedCurrentProfile(); // a pull mirrors the signed-in user's (pull-only) profile
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
    // Drive local knowledge through the REAL append-only ops (ltm), so the engine
    // is exercised against versioned (v2+) entries — the case sub-PR 3 exists to
    // handle. A raw in-place UPDATE / physical DELETE would only ever produce v1
    // (id == logical_id) rows and silently skip the append-only code paths.
    case "insert":
      if (!exists(op.id)) {
        // Unique title per id so create()'s fuzzy-dedup can't merge entries.
        db()
          .query(
            `INSERT INTO knowledge (id, logical_id, project_id, category, title, content, created_at, updated_at)
             VALUES (?, ?, ?, 'pattern', ?, ?, ?, ?)`,
          )
          .run(op.id, op.id, pid, op.id, op.content, Date.now(), Date.now());
      }
      break;
    case "update":
      if (exists(op.id)) ltm.update(op.id, { content: op.content }); // appends a version
      break;
    case "delete":
      if (exists(op.id)) ltm.remove(op.id); // appends a death-cert (no physical delete)
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
  // Append-only (A2, #823): the live set is the CURRENT live versions, identified
  // by the synced logical_id. Superseded + death-cert versions are local-only
  // history and must not count toward convergence with the remote (which mirrors
  // one row per logical entry).
  return new Set(
    (
      db()
        .query(
          "SELECT COALESCE(logical_id, id) AS id FROM knowledge WHERE is_current = 1 AND is_deleted = 0",
        )
        .all() as Array<{ id: string }>
    ).map((r) => r.id),
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
  // NB: every property predicate calls resetAll() itself (fast-check runs the
  // predicate many times per test), so no beforeEach is needed.
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

  test("the outbox fully drains after repeated pushes (the prune floor never wedges)", async () => {
    await fc.assert(
      fc.asyncProperty(seqArb, async (ops) => {
        resetAll();
        syncData.enableSync("basic");
        for (const op of ops) await apply(op);
        // pushOnce prunes seq <= the MIN push cursor across tables-with-entries
        // (the #828 safety floor). When several synced tables interleave in the
        // global outbox seq — e.g. a knowledge entry AND its knowledge_meta register
        // row (minted on pull, re-seeded on enable, A2 3b-2) — a single push prunes
        // only up to the lowest cursor; the higher-seq entries of another table are
        // PUSHED but reclaimed on a later pass. So full draining is EVENTUAL, not
        // single-shot. A real wedge (#828: a cursor permanently pinned at 0 by an
        // empty/pull-only table) would never drain no matter how many passes.
        let remaining = Number.POSITIVE_INFINITY;
        const maxPasses = syncData.syncedTables("basic").length + 1;
        for (let pass = 0; pass < maxPasses; pass++) {
          await pushOnce(client());
          remaining = (
            db().query("SELECT COUNT(*) AS n FROM sync_outbox").get() as {
              n: number;
            }
          ).n;
          if (remaining === 0) break;
        }
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
        // Pulling our OWN just-pushed rows must never self-conflict — even for
        // versioned (v2+) entries, whose current content lives in a fresh version
        // row keyed by logical_id (#823, Seer): a stale by-id hash here would
        // mis-classify every echo as a conflict.
        const r1 = await pullOnce(client());
        expect(r1.conflicts).toBe(0);
        // A second pull of our OWN just-pushed rows must apply nothing (they
        // classify as skip), and a re-push of unchanged rows must upload nothing.
        const r2 = await pullOnce(client());
        expect(r2.pulled).toBe(0);
        expect(r2.conflicts).toBe(0);
        const r3 = await pushOnce(client());
        expect(r3.pushed).toBe(0);
      }),
      { numRuns: 40 },
    );
  });

  // The other #828 bug class: account switch / logout must leave currentTier()
  // reflecting exactly the last-authenticated user, with no cross-account residue
  // in the pull-only profiles mirror (tier-residue / "two rows" bugs, #828).
  test("currentTier reflects the last-authenticated user across switch/logout", async () => {
    const authOp = fc.oneof(
      fc.record({
        t: fc.constant("switch" as const),
        user: fc.constantFrom(...Object.keys(USERS)),
      }),
      fc.record({ t: fc.constant("logout" as const) }),
    );
    await fc.assert(
      fc.asyncProperty(
        fc.array(authOp, { minLength: 1, maxLength: 8 }),
        async (ops) => {
          resetAll();
          let expected = "free"; // nothing mirrored yet → default tier
          for (const op of ops) {
            if (op.t === "switch") {
              // Sign in as `user`: wipe the previous mirror (+ reset its pull
              // cursor) then pull this user's single server profile.
              currentUser = op.user;
              syncData.clearPullOnlyMirrors();
              seedCurrentProfile();
              await pullOnce(client());
              expected = USERS[op.user];
            } else {
              syncData.clearPullOnlyMirrors(); // logout wipes the mirror
              expected = "free";
            }
            expect(syncData.currentTier()).toBe(expected);
            // No residue: profiles mirror holds at most the current account's row.
            syncData.assertSyncInvariants();
          }
        },
      ),
      { numRuns: 40 },
    );
  });
});
