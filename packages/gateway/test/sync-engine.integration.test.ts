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
import {
  crypto,
  db,
  ensureProject,
  keystore,
  ltm,
  setKV,
  syncData,
} from "@loreai/core";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { pullOnce, pushOnce } from "../src/sync";
import { type PgHarness, startPgHarness } from "./helpers/pg-harness";

// The engine drives real supabase-js clients we pass in explicitly, but the encryption
// resolver derives the scope from the LOCAL session via getCurrentUser(). These tests
// aren't locally logged in (they auth via a JWT client), so pin getCurrentUser to the
// test user so the scope matches the JWT's auth.uid(). All other real exports are kept.
let mockUid = "";
vi.mock("../src/supabase", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/supabase")>()),
  getCurrentUser: () => Promise.resolve(mockUid ? { user_id: mockUid } : null),
}));

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
  mockUid = uid; // the encryption scope = this user (matches the JWT's auth.uid())
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
    "knowledge_meta_crdt",
    "knowledge_meta",
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
    "knowledge_meta_crdt",
    "knowledge_meta",
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

  it("pushes a DELETE for a join-table ref without a phantom content_hash (PGRST204 regression)", async () => {
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
    await pushOnce(clientFor(uid)); // ref upserted (is_deleted=false)

    // Delete the ref locally → capture a delete op → push the tombstone. The join
    // table is versioned:false (no content_hash column), so the delete payload must
    // NOT include content_hash, or PostgREST rejects it (PGRST204) and — since that's
    // not a 23514 — the table wedges on infinite transient retries.
    db()
      .query(
        "DELETE FROM knowledge_entity_refs WHERE knowledge_id='k1' AND entity_id='e1'",
      )
      .run();
    const r = await pushOnce(clientFor(uid));
    expect(r.pushed).toBe(1); // exactly the ref delete pushed (no PGRST204 wedge)

    // Remote ref is soft-deleted, not errored.
    const ref = await h.asUser(uid, (c) =>
      c
        .query(
          "select is_deleted from public.knowledge_entity_refs where knowledge_id='k1' and entity_id='e1'",
        )
        .then((x) => x.rows),
    );
    expect(ref).toHaveLength(1);
    expect(ref[0].is_deleted).toBe(true);
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

  it("round-trips the confidence register (knowledge_meta + knowledge_meta_crdt) through the real engine", async () => {
    // The core of the migration: a real create() writes a base register row, and a
    // reinforce() records a PN-counter delta. Both must push cleanly through
    // supabase-js → PostgREST → Postgres (no 22008 timestamp / PGRST204 phantom-
    // column errors the docstring warns about), landing with the right values.
    syncData.enableSync("basic");
    const id = ltm.create({
      projectPath: "/tmp/lore-engine-it",
      scope: "project",
      category: "decision",
      title: "Register RT",
      content: "register round-trip",
      confidence: 0.6,
    });
    ltm.reinforce(id, 0.05); // → one knowledge_meta_crdt (pos=0.05) on this replica
    const r = await pushOnce(clientFor(uid));
    expect(r.pushed).toBeGreaterThanOrEqual(2); // knowledge + meta (+ crdt)

    // base_confidence landed immutably at the create-time value (NOT the
    // materialized 0.65) on knowledge_meta.
    const meta = await h.asUser(uid, (c) =>
      c
        .query(
          "select base_confidence from public.knowledge_meta where logical_id=$1",
          [id],
        )
        .then((x) => x.rows),
    );
    expect(meta).toHaveLength(1);
    expect(Number(meta[0].base_confidence)).toBeCloseTo(0.6, 6);

    // The PN-counter row carries the positive delta on this device's replica.
    const crdt = await h.asUser(uid, (c) =>
      c
        .query(
          "select pos, neg from public.knowledge_meta_crdt where logical_id=$1",
          [id],
        )
        .then((x) => x.rows),
    );
    expect(crdt).toHaveLength(1);
    expect(Number(crdt[0].pos)).toBeCloseTo(0.05, 6);
    expect(Number(crdt[0].neg)).toBe(0);

    // Re-push is a no-op (content hash stable → no ping-pong).
    expect((await pushOnce(clientFor(uid))).pushed).toBe(0);
  });

  it("merges a peer's confidence counter on pull (per-key MAX convergence)", async () => {
    // Device A creates + reinforces an entry, pushes it.
    syncData.enableSync("basic");
    const id = ltm.create({
      projectPath: "/tmp/lore-engine-it",
      scope: "project",
      category: "decision",
      title: "Converge",
      content: "converge body",
      confidence: 0.5,
    });
    ltm.reinforce(id, 0.1); // local replica pos=0.1
    await pushOnce(clientFor(uid));

    // Simulate a SECOND device's counter for the same logical entry landing on the
    // remote (a different replica_id). On pull it must MAX-merge in, not clobber.
    await h.asUser(uid, (c) =>
      c.query(
        `insert into public.knowledge_meta_crdt (logical_id, replica_id, scope_id, pos, neg)
         values ($1,'replica-B',$2,0.2,0)`,
        [id, uid],
      ),
    );
    setKV("sync.pull.knowledge_meta_crdt", "0|"); // re-pull from the start
    await pullOnce(clientFor(uid));

    // Both replicas' counters now present locally; materialized confidence folds
    // in both: base 0.5 + local 0.1 + peer 0.2 = 0.8.
    const rows = db()
      .query(
        "SELECT replica_id, pos FROM knowledge_meta_crdt WHERE logical_id = ? ORDER BY replica_id",
      )
      .all(id) as Array<{ replica_id: string; pos: number }>;
    expect(rows.length).toBe(2);
    const conf = (
      db()
        .query("SELECT confidence FROM knowledge_meta WHERE logical_id = ?")
        .get(id) as { confidence: number }
    ).confidence;
    expect(conf).toBeCloseTo(0.8, 6);
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

describe.skipIf(SKIP)(
  "encrypted knowledge round-trip (C-1..C-4b, real engine)",
  () => {
    const FAST = { t: 1, m: 256, p: 1 }; // light Argon2id for escrow (test-only)

    // The top-level beforeEach clears knowledge etc. but NOT the local/remote key
    // tables — wipe those so each encryption test starts from a truly fresh account.
    beforeEach(async () => {
      if (SKIP) return;
      db().exec(
        "DELETE FROM account_identity; DELETE FROM account_escrow; DELETE FROM scope_keys",
      );
      keystore.lock();
      for (const t of ["account_escrow", "scope_keys"]) {
        await h.client.query(`DELETE FROM public.${t}`);
      }
    });

    it("device-1 encrypts → remote stores CIPHERTEXT → device-2 unlocks + pulls plaintext", async () => {
      const PLAIN = "top secret knowledge body";
      const client = clientFor(uid);

      // --- Device 1: arm encryption, create knowledge, push. ---
      keystore.setPassphrase("correct horse battery", { params: FAST }); // identity + escrow
      syncData.enableSync("basic");
      insertKnowledge("ke", PLAIN);
      const push = await pushOnce(client);
      expect(push.pushed).toBeGreaterThanOrEqual(1);
      // NOTE: the DEK row is minted lazily INSIDE the first push (getScopeKey during
      // encrypt), so its capture lands too late for that cycle. The real CLI path avoids
      // this by eager-minting at `lore sync enable` (cmdEnable, #1182) so scope_keys ships
      // with the first push; this engine-level test bypasses cmdEnable, so it flushes the
      // DEK deterministically with a second push.
      await pushOnce(client);
      const rk = await h.asUser(uid, (c) =>
        c.query("select 1 from public.scope_keys").then((x) => x.rows),
      );
      expect(rk).toHaveLength(1);

      // The remote MUST hold ciphertext, never the plaintext — content AND title are
      // sealed (C-4), and each is a real envelope over the wire.
      const remote = await h.asUser(uid, (c) =>
        c
          .query("select content, title from public.knowledge where id='ke'")
          .then((x) => x.rows),
      );
      expect(remote).toHaveLength(1);
      expect(remote[0].content).not.toBe(PLAIN);
      expect(remote[0].title).not.toBe("T");
      expect(
        crypto.isEnvelope(Buffer.from(remote[0].content as string, "base64")),
      ).toBe(true);
      expect(
        crypto.isEnvelope(Buffer.from(remote[0].title as string, "base64")),
      ).toBe(true);

      // --- Device 2: a fresh device on the SAME account. Wipe ALL local state,
      // including sync_state AND sync_outbox, so pulls take the clean-apply path a real
      // fresh device sees (no stale synced-hash, no pending-local-change from the wipe). ---
      db().exec(
        "DELETE FROM account_identity; DELETE FROM account_escrow; DELETE FROM scope_keys; DELETE FROM knowledge; DELETE FROM knowledge_meta; DELETE FROM knowledge_meta_crdt; DELETE FROM sync_state; DELETE FROM sync_outbox",
      );
      keystore.lock();
      for (const m of syncData.syncedTables("basic")) {
        setKV(
          `sync.pull.${m.table}`,
          m.pullOnly ? `${Date.now() + 31_536_000_000}|` : "0|",
        );
        setKV(`sync.push.${m.table}`, "0");
      }
      expect(keystore.encryptionState()).toBe("off"); // nothing local yet

      // First pull brings escrow + scope_keys FIRST → the device is "locked", so the
      // encrypted knowledge table is skipped (cursor frozen) — never stored as ciphertext.
      const p1 = await pullOnce(client);
      expect(p1.conflicts).toBe(0); // fresh device → clean apply, never a conflict
      expect(keystore.encryptionState()).toBe("locked");
      expect(syncData.getRowById("knowledge", "ke")).toBeNull();

      // Unlock with the passphrase → recovers device-1's identity → "on".
      expect(keystore.unlockWithPassphrase("correct horse battery")).toBe(true);
      expect(keystore.encryptionState()).toBe("on");

      // Second pull now unwraps the DEK and decrypts the knowledge back to plaintext.
      const p2 = await pullOnce(client);
      expect(p2.conflicts).toBe(0);
      expect(syncData.getRowById("knowledge", "ke")?.content).toBe(PLAIN);
      expect(syncData.getRowById("knowledge", "ke")?.title).toBe("T");

      // No ping-pong: content_hash is over PLAINTEXT, and the pulled rows applied under
      // capture-suppression (no outbox), so the decrypted device has nothing to push back.
      expect((await pushOnce(client)).pushed).toBe(0);
    });

    it("a wrong passphrase does NOT unlock, and knowledge stays deferred", async () => {
      const client = clientFor(uid);
      keystore.setPassphrase("the-right-one", { params: FAST });
      syncData.enableSync("basic");
      insertKnowledge("kw", "still secret");
      await pushOnce(client);

      // Fresh device again.
      db().exec(
        "DELETE FROM account_identity; DELETE FROM account_escrow; DELETE FROM scope_keys; DELETE FROM knowledge; DELETE FROM knowledge_meta; DELETE FROM knowledge_meta_crdt; DELETE FROM sync_state; DELETE FROM sync_outbox",
      );
      keystore.lock();
      for (const m of syncData.syncedTables("basic")) {
        setKV(
          `sync.pull.${m.table}`,
          m.pullOnly ? `${Date.now() + 31_536_000_000}|` : "0|",
        );
      }

      await pullOnce(client); // escrow arrives → locked
      expect(keystore.encryptionState()).toBe("locked");
      expect(keystore.unlockWithPassphrase("WRONG")).toBe(false);
      expect(keystore.encryptionState()).toBe("locked"); // still locked
      await pullOnce(client);
      expect(syncData.getRowById("knowledge", "kw")).toBeNull(); // never decrypted
    });
  },
);
