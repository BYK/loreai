/**
 * END-TO-END integration of the REAL sync engine against a REAL Postgres +
 * PostgREST stack (no mock). Drives the actual `pushOnce`/`pullOnce` from
 * `@loreai/gateway` over supabase-js → PostgREST → Postgres, with the real
 * migrations, RLS, triggers, and type coercion in play.
 *
 * This is the layer that would have caught — without an adversarial reviewer —
 * the timestamp (22008), phantom-column (PGRST204), and same-millisecond
 * keyset BLOCKERs that the hand-written mock hid.
 *
 * Gated behind LORE_INTEGRATION=1 (needs Docker). Run:
 *   LORE_INTEGRATION=1 pnpm exec vitest run packages/gateway/test/sync-engine.integration.test.ts
 */
import { execFileSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { db, ensureProject, setKV, syncData } from "@loreai/core";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { pullOnce, pushOnce } from "../src/sync";
import { type PgHarness, startPgHarness } from "./helpers/pg-harness";

function dockerReady(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

const RUN = process.env.LORE_INTEGRATION === "1";
const SKIP = !RUN
  ? "LORE_INTEGRATION!=1"
  : !dockerReady()
    ? "docker unavailable"
    : false;

let h: PgHarness;
let uid: string;

/**
 * A supabase-js client authenticated as `uid` against the local PostgREST.
 * supabase-js targets `${url}/rest/v1/<table>`, but a bare PostgREST serves
 * tables at the root (`/<table>`) — Supabase's edge normally strips `/rest/v1`.
 * A rewriting fetch reproduces that so the engine's supabase-js calls work
 * unchanged.
 */
function clientFor(uid: string): SupabaseClient {
  const jwt = h.userJwt(uid);
  const rewriteFetch = (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    return fetch(url.replace("/rest/v1", ""), init);
  };
  return createClient(h.restUrl as string, jwt, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: { Authorization: `Bearer ${jwt}` },
      // Cast: supabase-js types `fetch` as the full `typeof fetch` (incl.
      // `preconnect`), which our minimal rewrite wrapper doesn't implement.
      fetch: rewriteFetch as unknown as typeof fetch,
    },
  });
}

beforeAll(async () => {
  if (SKIP) return;
  h = await startPgHarness({ postgrest: true });
  uid = await h.createUser("engine@test.dev");
}, 240_000);

afterAll(async () => {
  if (h) await h.stop();
});

beforeEach(async () => {
  if (SKIP) return;
  // Fresh local state each test (the local SQLite DB is the test temp DB).
  for (const t of [
    "knowledge_entity_refs",
    "knowledge",
    "entity_aliases",
    "entity_relations",
    "entities",
    "profiles",
    "sync_outbox",
    "sync_state",
    "sync_conflicts",
  ]) {
    db().exec(`DELETE FROM ${t}`);
  }
  db().exec("DELETE FROM temp._sync_applying");
  for (const m of syncData.syncedTables("basic")) {
    setKV(`sync.push.${m.table}`, "0");
    // Pull-only tables (profiles) always have an ambient remote row (auto-created
    // for the test user). Park their pull cursor far ahead so unrelated tests
    // don't pull the unchanged profile into their r.pulled total; the dedicated
    // profile tests reset this to "0|" to opt in.
    setKV(
      `sync.pull.${m.table}`,
      m.pullOnly ? `${Date.now() + 31_536_000_000}|` : "0|",
    );
  }
  // Fresh REMOTE state too. This uses the raw admin connection (superuser,
  // bypasses RLS) intentionally — it's test teardown, not a client path; the
  // transactional asUser()/runAs() helpers still SET ROLE for the actual tests.
  // Otherwise rows accumulate across tests and the cursor-reset pulls re-fetch
  // all of them.
  for (const t of [
    "knowledge_entity_refs",
    "knowledge",
    "entities",
    "entity_aliases",
    "entity_relations",
  ]) {
    await h.client.query(`DELETE FROM public.${t}`);
  }
});

// Local sync invariants must hold after every real-engine round-trip too (#834).
afterEach(() => {
  if (!SKIP) syncData.assertSyncInvariants();
});

function insertKnowledge(id: string, content: string): void {
  const pid = ensureProject("/tmp/lore-engine-it");
  db()
    .query(
      `INSERT INTO knowledge (id, project_id, category, title, content, created_at, updated_at, promoted_at)
       VALUES (?, ?, 'pattern', 'T', ?, ?, ?, ?)`,
    )
    .run(id, pid, content, Date.now(), Date.now(), 999); // promoted_at is local-only
}

describe.skipIf(SKIP)("sync engine ↔ real Postgres/PostgREST", () => {
  it("pushes a knowledge row (ISO timestamps, no local-only columns)", async () => {
    syncData.enableSync("basic");
    insertKnowledge("k1", "hello-real");
    const client = clientFor(uid);
    const r = await pushOnce(client);
    expect(r.pushed).toBe(1);
    // The row really landed in Postgres with the right owner + content.
    const remote = await h.asUser(uid, (c) =>
      c
        .query("select content, created_at from public.knowledge where id='k1'")
        .then((x) => x.rows),
    );
    expect(remote).toHaveLength(1);
    expect(remote[0].content).toBe("hello-real");
    expect(remote[0].created_at).toBeInstanceOf(Date); // timestamptz, not int
    // No phantom columns / local-only columns leaked (the push would have
    // 22008/PGRST204'd otherwise — proven by r.pushed===1 above).
  });

  it("pushes a join-table row (no content_hash/revision columns)", async () => {
    insertKnowledge("k1", "x");
    db()
      .query(
        "INSERT INTO entities (id, project_id, entity_type, canonical_name, created_at, updated_at) VALUES ('e1','p','tool','X',?,?)",
      )
      .run(Date.now(), Date.now());
    syncData.enableSync("basic");
    db()
      .query(
        "INSERT INTO knowledge_entity_refs (knowledge_id, entity_id) VALUES ('k1','e1')",
      )
      .run();
    const r = await pushOnce(clientFor(uid));
    expect(r.pushed).toBeGreaterThanOrEqual(1);
    const ref = await h.asUser(uid, (c) =>
      c
        .query(
          "select 1 from public.knowledge_entity_refs where knowledge_id='k1' and entity_id='e1'",
        )
        .then((x) => x.rows),
    );
    expect(ref).toHaveLength(1);
  });

  it("round-trips push → pull with a stable content hash (no ping-pong)", async () => {
    syncData.enableSync("basic");
    insertKnowledge("k1", "round-trip");
    const client = clientFor(uid);
    await pushOnce(client);
    // Pull back our own row: it must hash-equal (skip), not re-apply.
    const r = await pullOnce(client);
    expect(r.pulled).toBe(0); // echo is a no-op
    expect(syncData.getRowById("knowledge", "k1")?.content).toBe("round-trip");
  });

  it("pulls a row written by another device (same account)", async () => {
    // Simulate device B writing directly to the account's remote rows (a real
    // pushed row carries the locally-NOT-NULL columns like sensitivity).
    await h.asUser(uid, (c) =>
      c.query(
        `insert into public.knowledge (id, scope_id, category, title, content, sensitivity, content_hash, revision)
         values ('kb',$1,'pattern','T','from-device-B','normal','h',1)`,
        [uid],
      ),
    );
    syncData.enableSync("basic");
    const r = await pullOnce(clientFor(uid));
    expect(r.pulled).toBe(1);
    expect(syncData.getRowById("knowledge", "kb")?.content).toBe(
      "from-device-B",
    );
  });

  it("pulls the account profile (exactly one row, RLS-scoped) and resolves tier", async () => {
    // handle_new_user auto-created the profile at tier 'free'. Normalize in case
    // a prior test flipped it (tests share one uid/profile).
    await h.asService((c) =>
      c.query("update public.profiles set tier='free' where id=$1", [uid]),
    );
    setKV("sync.pull.profiles", "0|"); // opt in to pulling the profile
    syncData.enableSync("basic");
    const r = await pullOnce(clientFor(uid));
    // RLS is select-where-id=auth.uid() → exactly the caller's single row.
    const n = (
      db().query("SELECT COUNT(*) n FROM profiles").get() as { n: number }
    ).n;
    expect(n).toBe(1);
    expect(r.conflicts).toBe(0);
    expect(syncData.currentTier()).toBe("free");
  });

  it("propagates a service_role tier flip on the next pull (no conflict, never pushed)", async () => {
    await h.asService((c) =>
      c.query("update public.profiles set tier='free' where id=$1", [uid]),
    );
    setKV("sync.pull.profiles", "0|"); // opt in to pulling the profile
    syncData.enableSync("basic");
    await pullOnce(clientFor(uid));
    expect(syncData.currentTier()).toBe("free");

    // Billing flips tier (only service_role may — guard_profile_tier, 0004);
    // the updated_at trigger bumps the pull cursor.
    await h.asService((c) =>
      c.query("update public.profiles set tier='pro' where id=$1", [uid]),
    );
    const r = await pullOnce(clientFor(uid));
    expect(syncData.currentTier()).toBe("pro");
    expect(r.conflicts).toBe(0);

    // And it was never pushed back (pull-only): a push is a no-op.
    expect((await pushOnce(clientFor(uid))).pushed).toBe(0);
  });

  it("pulls ALL rows when many share one updated_at (>page is internal; correctness here)", async () => {
    // Insert 5 rows at one server timestamp; all must arrive (keyset).
    await h.asUser(uid, (c) =>
      c.query(
        `insert into public.knowledge (id, scope_id, category, title, content, sensitivity, content_hash, revision, updated_at)
         select 'm'||g, $1, 'pattern','T','c'||g, 'normal', 'h'||g, 1, now()
         from generate_series(0,4) g`,
        [uid],
      ),
    );
    syncData.enableSync("basic");
    const r = await pullOnce(clientFor(uid));
    expect(r.pulled).toBe(5);
    const n = (
      db().query("SELECT COUNT(*) n FROM knowledge").get() as { n: number }
    ).n;
    expect(n).toBe(5);
  });
});
