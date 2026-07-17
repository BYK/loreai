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
  ensureProject as ensureProjectCore,
  keystore,
  ltm,
  resolveProjectByRemoteOrPath,
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
import {
  publishIdentityPub,
  pullOnce,
  pushOnce,
  refreshRegistryMirror,
} from "../src/sync";
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
    "projects", // #1246: parent — after its content children above (local FK order)
    "profiles",
    "orgs", // E-5: registry mirrors (pull-only, no local FKs between them)
    "org_members",
    "scopes",
    "scope_members",
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
    "projects", // #1246: no remote content→projects FK, so order-independent here
  ]) {
    await h.client.query(`DELETE FROM public.${t}`);
  }
});

// Local sync invariants must hold after every real-engine round-trip too (#834).
afterEach(() => {
  if (!SKIP) syncData.assertSyncInvariants();
});

// P2a (#1246): content syncs only for REMOTE-BACKED projects. These engine tests exercise
// content that must reach the real server, so their project must have a git_remote. Stamp
// it under capture-suppression (raw UPDATE, not ensureProject → no reseed side-effect).
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
        "INSERT INTO entities (id, project_id, entity_type, canonical_name, cross_project, created_at, updated_at) VALUES ('e1',NULL,'tool','X',1,?,?)",
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
        "INSERT INTO entities (id, project_id, entity_type, canonical_name, cross_project, created_at, updated_at) VALUES ('e1',NULL,'tool','X',1,?,?)",
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
    ensureProject("/tmp/lore-engine-it"); // remote-backed → content passes the P2 gate
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

  it("mirrors the member's org/scope registry on refresh (E-5 foundation, #827)", async () => {
    // A team scope + the caller's admin membership, created server-side by the lifecycle RPC.
    const scopeId = await h.asUser(uid, (c) =>
      c
        .query("select public.create_team($1) as s", ["Rockets"])
        .then((r) => r.rows[0].s),
    );
    syncData.enableSync("basic");
    // #1294: the registry mirrors are refreshed by authoritative snapshot, not the keyset pull.
    await refreshRegistryMirror(clientFor(uid));

    // The new team scope + the caller's admin membership are mirrored locally.
    expect(
      (
        db().query("SELECT kind FROM scopes WHERE id=?").get(scopeId) as
          | { kind?: string }
          | undefined
      )?.kind,
    ).toBe("team");
    expect(
      (
        db()
          .query(
            "SELECT role FROM scope_members WHERE scope_id=? AND user_id=?",
          )
          .get(scopeId, uid) as { role?: string } | undefined
      )?.role,
    ).toBe("admin");
    // The WHOLE registry mirrors, not just the team: the personal scope (id == user id) too,
    // plus the org it belongs to — proving the refresh is not team-only.
    expect(
      (
        db().query("SELECT kind FROM scopes WHERE id=?").get(uid) as
          | { kind?: string }
          | undefined
      )?.kind,
    ).toBe("personal");
    expect(
      (db().query("SELECT COUNT(*) n FROM orgs").get() as { n: number }).n,
    ).toBeGreaterThan(0);
    // F3-1: the team-promotion policy column mirrors. create_team defaults it to 'manual'; a NULL
    // here would mean the column never synced (local schema has no default) — so this is
    // discriminating for promotion_policy being in the scopes pull columns.
    expect(
      (
        db()
          .query("SELECT promotion_policy FROM scopes WHERE id=?")
          .get(scopeId) as { promotion_policy?: string } | undefined
      )?.promotion_policy,
    ).toBe("manual");

    // The ISO timestamptz strings from PostgREST are normalized to epoch-ms INTEGERs locally
    // (via stripSyncCols, matching the keyset pull) — not stored as raw ISO text (#1294/#1372 review).
    const ts = db()
      .query("SELECT created_at, updated_at FROM scopes WHERE id=?")
      .get(scopeId) as { created_at?: unknown; updated_at?: unknown };
    expect(typeof ts.created_at).toBe("number");
    expect(typeof ts.updated_at).toBe("number");
    expect(ts.updated_at as number).toBeGreaterThan(1_000_000_000_000); // plausible epoch-ms

    // Idempotent + pull-only: a second refresh keeps the same rows, a push is a no-op.
    await refreshRegistryMirror(clientFor(uid));
    expect(
      (
        db()
          .query(
            "SELECT role FROM scope_members WHERE scope_id=? AND user_id=?",
          )
          .get(scopeId, uid) as { role?: string } | undefined
      )?.role,
    ).toBe("admin");
    expect((await pushOnce(clientFor(uid))).pushed).toBe(0);
  });

  it("propagates a remote membership removal to the local mirror on refresh (#1294)", async () => {
    // Admin (uid) creates a team and adds a second member (other); both mirror locally.
    const other = await h.createUser("removed-member@test.dev");
    const scopeId = await h.asUser(uid, (c) =>
      c
        .query("select public.create_team($1) as s", ["Comets"])
        .then((r) => r.rows[0].s),
    );
    await h.asUser(uid, (c) =>
      c.query("select public.add_scope_member($1,$2,'editor')", [
        scopeId,
        other,
      ]),
    );
    syncData.enableSync("basic");
    await refreshRegistryMirror(clientFor(uid));
    const memberCount = () =>
      (
        db()
          .query("SELECT COUNT(*) n FROM scope_members WHERE scope_id=?")
          .get(scopeId) as { n: number }
      ).n;
    expect(memberCount()).toBe(2); // admin + other

    // Admin removes `other` remotely (hard DELETE, no tombstone — the keyset pull could never see it).
    await h.asUser(uid, (c) =>
      c.query("select public.remove_scope_member($1,$2)", [scopeId, other]),
    );
    // The next authoritative refresh deletes the now-absent local row.
    await refreshRegistryMirror(clientFor(uid));
    expect(memberCount()).toBe(1); // only the admin remains
    expect(
      db()
        .query("SELECT 1 FROM scope_members WHERE scope_id=? AND user_id=?")
        .get(scopeId, other),
    ).toBeNull();
    // The admin's own membership survives (not wrongly reaped by the delete-absent pass).
    expect(
      db()
        .query("SELECT 1 FROM scope_members WHERE scope_id=? AND user_id=?")
        .get(scopeId, uid),
    ).toBeDefined();
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
      // #1246: projects (local + remote) are cleaned by the top-level beforeEach.
      keystore.lock();
      setKV("sync.identityPub", ""); // reset the identity-publish gate
      for (const t of ["account_escrow", "scope_keys", "identity_pub"]) {
        await h.client.query(`DELETE FROM public.${t}`);
      }
    });

    it("publishes this device's identity public key to the remote directory (E-3)", async () => {
      const client = clientFor(uid);
      keystore.setPassphrase("correct horse battery", { params: FAST }); // identity+escrow → "on"
      syncData.enableSync("basic");
      await publishIdentityPub(client);
      const expected = Buffer.from(
        keystore.getAccountIdentity().publicKey,
      ).toString("base64");
      const rows = await h.asUser(uid, (c) =>
        c
          .query("select user_id, public_key from public.identity_pub")
          .then((x) => x.rows),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].user_id).toBe(uid); // user_id filled by default auth.uid()
      expect(rows[0].public_key).toBe(expected); // base64 text (wire convention) == local pubkey
      // Idempotent: a second publish is a no-op (KV-hash gated) — no updated_at churn.
      const before = await h.asUser(uid, (c) =>
        c
          .query(
            "select updated_at from public.identity_pub where user_id=$1",
            [uid],
          )
          .then((x) => x.rows[0].updated_at),
      );
      await publishIdentityPub(client);
      const after = await h.asUser(uid, (c) =>
        c
          .query(
            "select updated_at from public.identity_pub where user_id=$1",
            [uid],
          )
          .then((x) => x.rows[0].updated_at),
      );
      expect(after).toStrictEqual(before);
    });

    it("publishIdentityPub is a no-op when encryption is off/locked (never auto-mints or publishes)", async () => {
      const client = clientFor(uid);
      syncData.enableSync("basic");
      setKV("sync.identityPub", "");
      // OFF (beforeEach wiped identity+escrow and locked): must NOT auto-mint an identity as a
      // side effect of getAccountIdentity (the keystore warns against escrow-less auto-mint), nor publish.
      expect(keystore.encryptionState()).toBe("off");
      await publishIdentityPub(client);
      expect(keystore.hasAccountIdentity()).toBe(false); // no identity minted
      expect(
        await h.asUser(uid, (c) =>
          c.query("select 1 from public.identity_pub").then((x) => x.rowCount),
        ),
      ).toBe(0);
      // LOCKED (escrow exists but identity not installed — a fresh device that pulled the
      // escrow but hasn't unlocked): still a no-op, and must not throw. Simulate by keeping the
      // escrow row but dropping the local identity (which is otherwise stored in the clear).
      keystore.setPassphrase("pw", { params: FAST });
      db().exec("DELETE FROM account_identity");
      keystore.lock();
      expect(keystore.encryptionState()).toBe("locked");
      await publishIdentityPub(client);
      expect(
        await h.asUser(uid, (c) =>
          c.query("select 1 from public.identity_pub").then((x) => x.rowCount),
        ),
      ).toBe(0);
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

    it("device-1 encrypts the entity graph → remote stores CIPHERTEXT → device-2 decrypts (C-4 entities)", async () => {
      const NAME = "MiniMax Corp";
      const META = JSON.stringify({ note: "a private description" });
      const ALIAS = "founder@example.com";
      const REL = "works_with";
      const client = clientFor(uid);
      const pid = ensureProject("/tmp/lore-engine-it");
      const now = Date.now();

      // --- Device 1: arm encryption, create an entity + alias + relation, push. ---
      keystore.setPassphrase("correct horse battery", { params: FAST });
      syncData.enableSync("basic");
      db()
        .query(
          `INSERT INTO entities (id, project_id, entity_type, canonical_name, metadata, created_at, updated_at)
           VALUES (?, ?, 'person', ?, ?, ?, ?)`,
        )
        .run("e1", pid, NAME, META, now, now);
      db()
        .query(
          `INSERT INTO entities (id, project_id, entity_type, canonical_name, created_at, updated_at)
           VALUES ('e2', ?, 'person', 'Other', ?, ?)`,
        )
        .run(pid, now, now);
      db()
        .query(
          `INSERT INTO entity_aliases (id, entity_id, alias_type, alias_value, source, created_at)
           VALUES ('a1', 'e1', 'email', ?, 'curator', ?)`,
        )
        .run(ALIAS, now);
      db()
        .query(
          `INSERT INTO entity_relations (id, entity_a, entity_b, relation, metadata, source, created_at, updated_at)
           VALUES ('r1', 'e1', 'e2', ?, ?, 'curator', ?, ?)`,
        )
        .run(REL, META, now, now);

      await pushOnce(client);
      await pushOnce(client); // flush the lazily-minted DEK (see knowledge test note)

      // The remote MUST hold ciphertext for the sealed columns and CLEARTEXT for
      // the structural ones (entity_type / alias_type / source).
      const ent = await h.asUser(uid, (c) =>
        c
          .query(
            "select entity_type, canonical_name, metadata from public.entities where id='e1'",
          )
          .then((x) => x.rows[0]),
      );
      expect(ent.entity_type).toBe("person"); // structural → cleartext
      expect(ent.canonical_name).not.toBe(NAME);
      expect(
        crypto.isEnvelope(Buffer.from(ent.canonical_name as string, "base64")),
      ).toBe(true);
      expect(
        crypto.isEnvelope(Buffer.from(ent.metadata as string, "base64")),
      ).toBe(true);

      const al = await h.asUser(uid, (c) =>
        c
          .query(
            "select alias_type, alias_value, source from public.entity_aliases where id='a1'",
          )
          .then((x) => x.rows[0]),
      );
      expect(al.alias_type).toBe("email"); // structural → cleartext
      expect(al.source).toBe("curator"); // provenance → cleartext
      expect(al.alias_value).not.toBe(ALIAS);
      expect(
        crypto.isEnvelope(Buffer.from(al.alias_value as string, "base64")),
      ).toBe(true);

      const rel = await h.asUser(uid, (c) =>
        c
          .query(
            "select relation, metadata, source from public.entity_relations where id='r1'",
          )
          .then((x) => x.rows[0]),
      );
      expect(rel.source).toBe("curator");
      expect(rel.relation).not.toBe(REL);
      expect(
        crypto.isEnvelope(Buffer.from(rel.relation as string, "base64")),
      ).toBe(true);
      expect(
        crypto.isEnvelope(Buffer.from(rel.metadata as string, "base64")),
      ).toBe(true);

      // --- Device 2: fresh device, same account. Wipe all local state. ---
      db().exec(
        "DELETE FROM account_identity; DELETE FROM account_escrow; DELETE FROM scope_keys; DELETE FROM entity_relations; DELETE FROM entity_aliases; DELETE FROM entities; DELETE FROM sync_state; DELETE FROM sync_outbox",
      );
      keystore.lock();
      for (const m of syncData.syncedTables("basic")) {
        setKV(
          `sync.pull.${m.table}`,
          m.pullOnly ? `${Date.now() + 31_536_000_000}|` : "0|",
        );
        setKV(`sync.push.${m.table}`, "0");
      }

      // First pull → escrow/scope_keys arrive first → "locked" → entity tables deferred.
      await pullOnce(client);
      expect(keystore.encryptionState()).toBe("locked");
      expect(syncData.getRowById("entities", "e1")).toBeNull();

      // Unlock → "on" → second pull decrypts the whole graph back to plaintext.
      expect(keystore.unlockWithPassphrase("correct horse battery")).toBe(true);
      await pullOnce(client);
      expect(syncData.getRowById("entities", "e1")?.canonical_name).toBe(NAME);
      expect(syncData.getRowById("entities", "e1")?.metadata).toBe(META);
      expect(syncData.getRowById("entity_aliases", "a1")?.alias_value).toBe(
        ALIAS,
      );
      expect(syncData.getRowById("entity_relations", "r1")?.relation).toBe(REL);
      expect(syncData.getRowById("entity_relations", "r1")?.metadata).toBe(
        META,
      );

      // No ping-pong: content_hash is over plaintext, pulled under capture-suppression.
      expect((await pushOnce(client)).pushed).toBe(0);
    });

    it("converges an encrypted alias UNIQUE collision across devices (#1234 under C-4)", async () => {
      // Two devices independently mint the SAME (alias_type, alias_value) under
      // different ids; both reach the remote sealed (different ciphertext, same
      // plaintext). On pull the second collides with the local UNIQUE(alias_type,
      // alias_value) — the resolver must see the DECRYPTED value to match the local
      // row and converge (lower id wins). Regression: it was fed the raw ciphertext,
      // so the local lookup never matched and devices stayed divergent.
      const VALUE = "shared@example.com";
      const client = clientFor(uid);
      const pid = ensureProject("/tmp/lore-engine-it");
      const now = Date.now();
      keystore.setPassphrase("correct horse battery", { params: FAST });
      syncData.enableSync("basic");
      db()
        .query(
          "INSERT INTO entities (id, project_id, entity_type, canonical_name, created_at, updated_at) VALUES ('e1', ?, 'person', 'E', ?, ?)",
        )
        .run(pid, now, now);

      // Push the HIGHER-id alias ("a-2") FIRST so it gets the earlier server
      // updated_at and is therefore PULLED first (applied cleanly). This forces the
      // resolver's delete-and-reapply path: the lower-id winner ("a-1") arrives
      // second, collides, and must DELETE the already-applied a-2 to converge. (If
      // the resolver were fed ciphertext, its local lookup would miss, it would skip
      // a-1, and the wrong row a-2 would survive — the discriminating case.)
      db()
        .query(
          "INSERT INTO entity_aliases (id, entity_id, alias_type, alias_value, created_at) VALUES ('a-2', 'e1', 'email', ?, ?)",
        )
        .run(VALUE, now);
      await pushOnce(client);
      await pushOnce(client); // flush the lazily-minted DEK

      // Swap in the LOWER-id row ("a-1") with the SAME (type,value); push it so BOTH
      // exist on the remote (distinct ciphertext) with a-1's updated_at LATER.
      syncData.withApplying(() =>
        db().query("DELETE FROM entity_aliases WHERE id='a-2'").run(),
      );
      db()
        .query(
          "INSERT INTO entity_aliases (id, entity_id, alias_type, alias_value, created_at) VALUES ('a-1', 'e1', 'email', ?, ?)",
        )
        .run(VALUE, now + 1);
      await pushOnce(client);
      const remoteCount = await h.asUser(uid, (c) =>
        c
          .query("select count(*)::int as n from public.entity_aliases")
          .then((x) => x.rows[0].n),
      );
      expect(remoteCount).toBe(2); // both a-lo and a-hi on the remote (sealed)

      // Fresh device: pull BOTH. Whichever applies first, the second hits the local
      // UNIQUE → resolver decrypts, matches on plaintext, converges to the lower id.
      db().exec(
        "DELETE FROM entity_aliases; DELETE FROM sync_state; DELETE FROM sync_outbox",
      );
      for (const m of syncData.syncedTables("basic")) {
        setKV(
          `sync.pull.${m.table}`,
          m.pullOnly ? `${now + 31_536_000_000}|` : "0|",
        );
        setKV(`sync.push.${m.table}`, "0");
      }
      await pullOnce(client);

      // Exactly ONE alias survives locally, and it's the lower id (a-1), decrypted.
      const local = db()
        .query("SELECT id, alias_value FROM entity_aliases ORDER BY id")
        .all() as Array<{ id: string; alias_value: string }>;
      expect(local).toHaveLength(1);
      expect(local[0].id).toBe("a-1");
      expect(local[0].alias_value).toBe(VALUE); // decrypted, not ciphertext
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

    it("device-2 decrypts each blob at its PINNED epoch after a rotation (epoch dispatch, not 'current') (E-4c-3b)", async () => {
      const client = clientFor(uid);
      const P0 = "body sealed at epoch zero";
      const P1 = "body sealed at epoch one";
      const scope = uid; // v1 encryption scope = auth.uid()

      // --- Device 1: arm encryption, push kr0 at epoch 0 (2nd push flushes the lazy DEK row). ---
      keystore.setPassphrase("rotate me", { params: FAST });
      syncData.enableSync("basic");
      insertKnowledge("kr0", P0);
      await pushOnce(client);
      await pushOnce(client);
      expect(keystore.currentScopeEpoch(scope)).toBe(0);

      // Rotate to epoch 1 (mint a fresh DEK, re-wrap to self) → new content seals at epoch 1.
      const self = keystore.getAccountIdentity();
      await keystore.rotateScopeKey(scope, 1, [
        { userId: scope, publicKey: self.publicKey },
      ]);
      expect(keystore.currentScopeEpoch(scope)).toBe(1);
      insertKnowledge("kr1", P1);
      await pushOnce(client); // kr1 (epoch 1) + the epoch-1 scope_keys row
      await pushOnce(client);

      // The remote blobs carry DISTINCT pinned epochs (kr1 sealed at CURRENT=1, kr0 stayed at 0).
      const rows = await h.asUser(uid, (c) =>
        c
          .query(
            "select id, content from public.knowledge where id in ('kr0','kr1') order by id",
          )
          .then((x) => x.rows),
      );
      const epochOf = (b64: string) =>
        crypto.parseHeader(Buffer.from(b64, "base64")).keyEpoch;
      expect(epochOf(rows[0].content)).toBe(0); // kr0
      expect(epochOf(rows[1].content)).toBe(1); // kr1 seals at the current epoch (kills the no-stamp mutant)
      // Both epoch wraps must be on the remote for a fresh device to decrypt both.
      expect(
        await h.asUser(uid, (c) =>
          c
            .query("select count(*)::int n from public.scope_keys")
            .then((x) => x.rows[0].n),
        ),
      ).toBe(2);

      // --- Device 2: fresh device, same account. Pull escrow + BOTH epoch wraps, unlock, then
      // pull knowledge: each blob MUST decrypt with ITS OWN epoch's DEK (kr0→epoch 0, kr1→epoch
      // 1). Decrypting kr0 with the "current" (epoch-1) DEK would fail the AEAD tag. ---
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
      await pullOnce(client); // escrow + both scope_keys epochs → locked
      expect(keystore.encryptionState()).toBe("locked");
      expect(keystore.unlockWithPassphrase("rotate me")).toBe(true);
      expect(keystore.scopeKeyEpochs(scope)).toEqual([0, 1]); // both wraps pulled
      const p = await pullOnce(client);
      expect(p.conflicts).toBe(0);
      expect(syncData.getRowById("knowledge", "kr0")?.content).toBe(P0);
      expect(syncData.getRowById("knowledge", "kr1")?.content).toBe(P1);
    });

    it("device-1 pushes a project + its content → device-2 restores under the seeded FK parent (P1, #1246)", async () => {
      const REMOTE_URL = "github.com/acme/secret-repo";
      const client = clientFor(uid);

      // --- Device 1: arm encryption, create a remote-backed project + knowledge under it. ---
      keystore.setPassphrase("correct horse battery", { params: FAST });
      syncData.enableSync("basic");
      db()
        .query(
          "INSERT INTO projects (id, path, name, git_remote, created_at) VALUES ('proj-A','/dev1/repo','secret-repo',?,?)",
        )
        .run(REMOTE_URL, Date.now());
      db()
        .query(
          `INSERT INTO knowledge (id, project_id, category, title, content, created_at, updated_at)
           VALUES ('kp','proj-A','pattern','T','secret body',?,?)`,
        )
        .run(Date.now(), Date.now());
      await pushOnce(client);
      await pushOnce(client); // flush the lazily-minted DEK (scope_keys), like the knowledge test

      // The remote projects row must hold CIPHERTEXT for git_remote — a repo URL is
      // identifying metadata and must never reach the server in the clear.
      const remoteProj = await h.asUser(uid, (c) =>
        c
          .query("select git_remote from public.projects where id='proj-A'")
          .then((x) => x.rows),
      );
      expect(remoteProj).toHaveLength(1);
      expect(remoteProj[0].git_remote).not.toBe(REMOTE_URL);
      expect(
        crypto.isEnvelope(
          Buffer.from(remoteProj[0].git_remote as string, "base64"),
        ),
      ).toBe(true);
      // scope_keys must have landed (flushed by the 2nd push) so device-2 can unlock.
      const rk = await h.asUser(uid, (c) =>
        c.query("select 1 from public.scope_keys").then((x) => x.rows),
      );
      expect(rk).toHaveLength(1);

      // --- Device 2: a fresh device on the SAME account. Wipe ALL local state incl. projects. ---
      db().exec(
        "DELETE FROM account_identity; DELETE FROM account_escrow; DELETE FROM scope_keys; DELETE FROM knowledge; DELETE FROM knowledge_meta; DELETE FROM knowledge_meta_crdt; DELETE FROM projects; DELETE FROM sync_state; DELETE FROM sync_outbox",
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

      // Pull #1: escrow + scope_keys arrive first → locked; the encrypted projects +
      // knowledge tables are deferred (cursor frozen), never stored as ciphertext.
      await pullOnce(client);
      expect(keystore.encryptionState()).toBe("locked");
      expect(
        db().query("SELECT id FROM projects WHERE id='proj-A'").get(),
      ).toBeNull();

      // Unlock → recovers device-1's identity → "on".
      expect(keystore.unlockWithPassphrase("correct horse battery")).toBe(true);

      // Pull #2: projects decrypts + seeds the FK parent (it is registered BEFORE knowledge
      // in the pull order), then the content applies under it.
      await pullOnce(client);

      // The FK parent exists with a synthetic (non-fs) path + the DECRYPTED git_remote.
      const localProj = db()
        .query("SELECT path, git_remote FROM projects WHERE id='proj-A'")
        .get() as { path: string; git_remote: string } | null;
      expect(localProj?.path).toBe("lore:project/proj-A"); // synthetic placeholder
      expect(localProj?.git_remote).toBe(REMOTE_URL); // decrypted on the wire

      // The content is restored under the seeded parent — WITHOUT P1's projects sync this
      // knowledge would reference a nonexistent local project and poison-skip on pull.
      expect(syncData.getRowById("knowledge", "kp")?.content).toBe(
        "secret body",
      );

      // A later local checkout of the SAME repo would ADOPT proj-A via the git-remote match.
      expect(resolveProjectByRemoteOrPath(REMOTE_URL)).toBe("proj-A");

      // No ping-pong: pulled rows applied under capture-suppression → nothing to push back.
      expect((await pushOnce(client)).pushed).toBe(0);
    });
  },
);
