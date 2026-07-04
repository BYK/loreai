/**
 * Integration tests for the sync MIGRATIONS against a real Postgres with RLS,
 * triggers, and CHECK constraints enforced — run AS a real `authenticated` user
 * (SET ROLE + JWT claims), exactly like PostgREST. These convert the security
 * pen-test findings into permanent, deterministic regressions; the hand-written
 * mock could never exercise RLS/triggers/quotas.
 *
 * Gated behind LORE_INTEGRATION=1 (needs Docker). Run:
 *   LORE_INTEGRATION=1 pnpm exec vitest run packages/gateway/test/sync-security.integration.test.ts
 */
import { execFileSync } from "node:child_process";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type PgHarness, startPgHarness } from "./helpers/pg-harness";

/** Free-tier defaults (mirror supabase/migrations/0003 + 0009) — restored after quota tests. */
const FREE_LIMITS: Record<string, number> = {
  knowledge: 500,
  entities: 30,
  entity_aliases: 300,
  entity_relations: 300,
  knowledge_entity_refs: 2000,
  knowledge_meta: 500,
  knowledge_meta_crdt: 5000,
  account_escrow: 2,
  scope_keys: 100,
};

// Mirrors the free-tier max_bytes seeded in 0007_scope_seam.sql + 0009 — used to
// restore byte caps in afterEach so setByteCap() mutations never leak across tests.
const FREE_BYTE_LIMITS: Record<string, number> = {
  knowledge: 8388608,
  entities: 1048576,
  entity_aliases: 2097152,
  entity_relations: 2097152,
  knowledge_entity_refs: 1048576,
  knowledge_meta: 524288,
  knowledge_meta_crdt: 1048576,
  account_escrow: 65536,
  scope_keys: 262144,
};

// Skip decision must be known at COLLECTION time (before beforeAll), so the
// Docker probe is synchronous here.
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

beforeAll(async () => {
  if (!SKIP) h = await startPgHarness();
}, 180_000);

afterAll(async () => {
  if (h) await h.stop();
});

const gate = () => SKIP;

/** Capture the Postgres error code/message of a failing query. */
async function expectError(fn: () => Promise<unknown>): Promise<{
  code?: string;
  message: string;
}> {
  try {
    await fn();
  } catch (e) {
    return {
      code: (e as { code?: string }).code,
      message: (e as Error).message,
    };
  }
  throw new Error("expected the query to fail, but it succeeded");
}

describe.skipIf(gate())(
  "sync migrations — multi-tenant isolation (RLS)",
  () => {
    it("a user cannot read another user's rows", async () => {
      const a = await h.createUser();
      const b = await h.createUser();
      await h.asUser(a, (c) =>
        c.query(
          "insert into public.knowledge (id, scope_id, category, title, content) values ('ka',$1,'p','T','secret-A')",
          [a],
        ),
      );
      const seen = await h.asUser(b, (c) =>
        c.query("select id from public.knowledge").then((r) => r.rows),
      );
      expect(seen).toHaveLength(0);
    });

    it("a user cannot forge scope_id on INSERT (WITH CHECK)", async () => {
      const a = await h.createUser();
      const victim = await h.createUser();
      const err = await expectError(() =>
        h.asUser(a, (c) =>
          c.query(
            "insert into public.knowledge (id, scope_id, category, title, content) values ('kf',$1,'p','T','C')",
            [victim],
          ),
        ),
      );
      expect(err.code).toBe("42501"); // RLS WITH CHECK
    });

    it("a user cannot re-parent a row to themselves (steal) or to a victim (donate)", async () => {
      const a = await h.createUser();
      const victim = await h.createUser();
      await h.asUser(victim, (c) =>
        c.query(
          "insert into public.knowledge (id, scope_id, category, title, content) values ('kv',$1,'p','T','C')",
          [victim],
        ),
      );
      // steal: victim's row is invisible to A, so the UPDATE matches 0 rows.
      const stolen = await h.asUser(a, (c) =>
        c.query("update public.knowledge set scope_id=$1 where id='kv'", [a]),
      );
      expect(stolen.rowCount).toBe(0);
      // donate: A's own row re-parented to victim → the scope-immutable guard
      // (BEFORE trigger) rejects with check_violation before RLS WITH CHECK runs.
      await h.asUser(a, (c) =>
        c.query(
          "insert into public.knowledge (id, scope_id, category, title, content) values ('ka2',$1,'p','T','C')",
          [a],
        ),
      );
      const err = await expectError(() =>
        h.asUser(a, (c) =>
          c.query("update public.knowledge set scope_id=$1 where id='ka2'", [
            victim,
          ]),
        ),
      );
      expect(err.code).toBe("23514");
    });

    it("anon has no access to synced tables", async () => {
      const err = await expectError(() =>
        h.asAnon((c) => c.query("select * from public.knowledge")),
      );
      expect(err.code).toBe("42501"); // no grant to anon
    });
  },
);

describe.skipIf(gate())(
  "sync migrations — encryption key store (C-3, #825)",
  () => {
    const insEscrow = (user: string, scope: string, author?: string) =>
      h.asUser(user, (c) =>
        c.query(
          `insert into public.account_escrow
           (id, scope_id, author_id, wrapped_secret, kdf_salt, kdf_t, kdf_m, kdf_p)
         values (1, $1, $2, 'd2VyYXBwZWQ=', 'c2FsdA==', 3, 65536, 1)`,
          [scope, author ?? scope],
        ),
      );
    const insKey = (
      user: string,
      scope: string,
      member: string,
      author?: string,
    ) =>
      h.asUser(user, (c) =>
        c.query(
          `insert into public.scope_keys
           (member_user_id, scope_id, author_id, wrapped_dek)
         values ($1, $2, $3, 'd3JhcHBlZERFSw==')`,
          [member, scope, author ?? scope],
        ),
      );

    it("a user cannot read another user's escrow or scope keys (RLS)", async () => {
      const a = await h.createUser();
      const b = await h.createUser();
      await insEscrow(a, a);
      await insKey(a, a, a);
      const escrow = await h.asUser(b, (c) =>
        c.query("select id from public.account_escrow").then((r) => r.rows),
      );
      const keys = await h.asUser(b, (c) =>
        c
          .query("select member_user_id from public.scope_keys")
          .then((r) => r.rows),
      );
      expect(escrow).toHaveLength(0);
      expect(keys).toHaveLength(0);
    });

    it("a user cannot forge scope_id or author_id on the key tables (WITH CHECK)", async () => {
      const a = await h.createUser();
      const victim = await h.createUser();
      expect((await expectError(() => insEscrow(a, victim))).code).toBe(
        "42501",
      );
      expect((await expectError(() => insEscrow(a, a, victim))).code).toBe(
        "42501",
      );
      expect((await expectError(() => insKey(a, victim, a))).code).toBe(
        "42501",
      );
      expect((await expectError(() => insKey(a, a, a, victim))).code).toBe(
        "42501",
      );
    });

    it("scope_id is immutable on the key tables", async () => {
      const a = await h.createUser();
      const victim = await h.createUser();
      await insEscrow(a, a);
      const err = await expectError(() =>
        h.asUser(a, (c) =>
          c.query("update public.account_escrow set scope_id=$1 where id=1", [
            victim,
          ]),
        ),
      );
      expect(err.code).toBe("23514");
    });

    it("account_escrow is single-row per user (CHECK id=1)", async () => {
      const a = await h.createUser();
      await insEscrow(a, a);
      const err = await expectError(() =>
        h.asUser(a, (c) =>
          c.query(
            `insert into public.account_escrow (id, scope_id, wrapped_secret, kdf_salt, kdf_t, kdf_m, kdf_p)
           values (2, $1, 'eA==', 'eA==', 3, 65536, 1)`,
            [a],
          ),
        ),
      );
      expect(err.code).toBe("23514"); // account_escrow_size_ck (id = 1)
    });

    it("rejects an oversized wrapped blob (size CHECK bounds a direct client)", async () => {
      const a = await h.createUser();
      const huge = "A".repeat(5000); // > 4096 cap
      const err = await expectError(() =>
        h.asUser(a, (c) =>
          c.query(
            `insert into public.scope_keys (member_user_id, scope_id, wrapped_dek)
           values ($1, $2, $3)`,
            [a, a, huge],
          ),
        ),
      );
      expect(err.code).toBe("23514"); // scope_keys_size_ck
    });

    it("anon has no access to the key tables", async () => {
      expect(
        (
          await expectError(() =>
            h.asAnon((c) => c.query("select * from public.account_escrow")),
          )
        ).code,
      ).toBe("42501");
      expect(
        (
          await expectError(() =>
            h.asAnon((c) => c.query("select * from public.scope_keys")),
          )
        ).code,
      ).toBe("42501");
    });
  },
);

describe.skipIf(gate())("sync migrations — tier is server-only", () => {
  it("authenticated cannot set their own tier (column grant)", async () => {
    const a = await h.createUser();
    const err = await expectError(() =>
      h.asUser(a, (c) =>
        c.query("update public.profiles set tier='pro' where id=$1", [a]),
      ),
    );
    expect(err.code).toBe("42501"); // no UPDATE(tier) grant
  });

  it("authenticated CAN edit allowed profile columns (control)", async () => {
    const a = await h.createUser();
    const r = await h.asUser(a, (c) =>
      c.query("update public.profiles set display_name='me' where id=$1", [a]),
    );
    expect(r.rowCount).toBe(1);
  });

  it("service_role CAN upgrade tier (the legit payment path)", async () => {
    const a = await h.createUser();
    await h.asService((c) =>
      c.query("update public.profiles set tier='pro' where id=$1", [a]),
    );
    const tier = await h.asService((c) =>
      c
        .query("select tier from public.profiles where id=$1", [a])
        .then((r) => r.rows[0].tier),
    );
    expect(tier).toBe("pro");
  });
});

describe.skipIf(gate())("sync migrations — quota + anti-abuse", () => {
  // plan_limits is admin/migration-managed (no client role may write it), so
  // tune the cap via the raw admin connection. Restored after each test
  // (afterEach below) so cap mutations never leak across tests / test order.
  async function setCap(table: string, n: number) {
    await h.client.query(
      "update public.plan_limits set max_rows=$1 where tier='free' and table_name=$2",
      [n, table],
    );
  }
  async function setByteCap(table: string, n: number | null) {
    await h.client.query(
      "update public.plan_limits set max_bytes=$1 where tier='free' and table_name=$2",
      [n, table],
    );
  }
  // Read the maintained counter for a (scope, table).
  async function usage(scope: string, table: string) {
    const { rows } = await h.client.query(
      "select row_count, byte_count from public.user_table_usage where scope_id=$1 and table_name=$2",
      [scope, table],
    );
    return rows[0] ?? { row_count: 0, byte_count: 0 };
  }

  afterEach(async () => {
    if (gate()) return;
    for (const [table, n] of Object.entries(FREE_LIMITS)) {
      await h.client.query(
        "update public.plan_limits set max_rows=$1 where tier='free' and table_name=$2",
        [n, table],
      );
    }
    // Restore byte caps too — setByteCap mutations must not leak across tests.
    for (const [table, n] of Object.entries(FREE_BYTE_LIMITS)) {
      await h.client.query(
        "update public.plan_limits set max_bytes=$1 where tier='free' and table_name=$2",
        [n, table],
      );
    }
  });

  it("blocks inserts past the free-tier row cap", async () => {
    const a = await h.createUser();
    await setCap("entities", 2);
    const ins = (id: string) =>
      h.asUser(a, (c) =>
        c.query(
          "insert into public.entities (id, scope_id, entity_type, canonical_name) values ($1,$2,'tool','X')",
          [id, a],
        ),
      );
    await ins("e1");
    await ins("e2");
    const err = await expectError(() => ins("e3"));
    expect(err.code).toBe("23514"); // quota check_violation
    expect(err.message).toMatch(/quota exceeded/i);
  });

  it("soft-delete does NOT free a slot (physical footprint counting)", async () => {
    // Physical accounting closes the whole un-tombstone bypass class: soft-deleting
    // never frees quota (the row still physically exists), so there is no slot to
    // game by toggling is_deleted. Only a hard DELETE (reaper / A2 compaction) frees.
    const a = await h.createUser();
    await setCap("entities", 2);
    const ins = (id: string) =>
      h.asUser(a, (c) =>
        c.query(
          "insert into public.entities (id, scope_id, entity_type, canonical_name) values ($1,$2,'tool','X')",
          [id, a],
        ),
      );
    await ins("z1");
    await ins("z2"); // physical 2 = cap
    await h.asUser(a, (c) =>
      c.query("update public.entities set is_deleted=true where id='z1'", []),
    );
    // no slot was freed → a new insert is still blocked
    const err = await expectError(() => ins("z3"));
    expect(err.code).toBe("23514");
  });

  it("at-cap users can still UPDATE / soft-delete existing rows", async () => {
    const a = await h.createUser();
    await setCap("entities", 1);
    await h.asUser(a, (c) =>
      c.query(
        "insert into public.entities (id, scope_id, entity_type, canonical_name) values ('u1',$1,'tool','a')",
        [a],
      ),
    );
    // upsert-as-update on the existing row (at cap) must succeed
    const upd = await h.asUser(a, (c) =>
      c.query(
        `insert into public.entities (id, scope_id, entity_type, canonical_name)
         values ('u1',$1,'tool','UPDATED')
         on conflict (scope_id, id) do update set canonical_name=excluded.canonical_name`,
        [a],
      ),
    );
    expect(upd.rowCount).toBe(1);
    // soft-deleting an existing row at cap is an UPDATE (not growth) → allowed,
    // but it does NOT free a slot (physical accounting): a new insert stays blocked.
    const del = await h.asUser(a, (c) =>
      c.query("update public.entities set is_deleted=true where id='u1'", []),
    );
    expect(del.rowCount).toBe(1);
    const err = await expectError(() =>
      h.asUser(a, (c) =>
        c.query(
          "insert into public.entities (id, scope_id, entity_type, canonical_name) values ('u2',$1,'tool','b')",
          [a],
        ),
      ),
    );
    expect(err.code).toBe("23514");
  });

  it("caps oversized payloads on every user-controlled column", async () => {
    const a = await h.createUser();
    const big = "z".repeat(9000);
    // content (8192 cap)
    expect(
      (
        await expectError(() =>
          h.asUser(a, (c) =>
            c.query(
              "insert into public.knowledge (id, scope_id, category, title, content) values ('big',$1,'p','T',$2)",
              [a, big],
            ),
          ),
        )
      ).code,
    ).toBe("23514");
    // id (64 cap)
    expect(
      (
        await expectError(() =>
          h.asUser(a, (c) =>
            c.query(
              "insert into public.entities (id, scope_id, entity_type, canonical_name) values ($1,$2,'tool','X')",
              ["i".repeat(100), a],
            ),
          ),
        )
      ).code,
    ).toBe("23514");
  });

  it("authenticated cannot write plan_limits", async () => {
    const a = await h.createUser();
    const err = await expectError(() =>
      h.asUser(a, (c) =>
        c.query(
          "update public.plan_limits set max_rows=999999 where tier='free'",
        ),
      ),
    );
    expect(err.code).toBe("42501");
  });

  it("enforces the byte budget (max_bytes), not just row count", async () => {
    const a = await h.createUser();
    await setByteCap("knowledge", 2000); // tiny budget, generous row cap
    const ins = (id: string, content: string) =>
      h.asUser(a, (c) =>
        c.query(
          "insert into public.knowledge (id, scope_id, category, title, content) values ($1,$2,'p','T',$3)",
          [id, a, content],
        ),
      );
    await ins("b1", "z".repeat(1200)); // ~1200 bytes, under budget
    const err = await expectError(() => ins("b2", "z".repeat(1200))); // would exceed 2000
    expect(err.code).toBe("23514");
    expect(err.message).toMatch(/byte quota exceeded/i);
  });

  it("byte budget counts physical rows — soft-delete + churn can't flood it", async () => {
    // Regression for the tombstone-flood: under physical accounting every inserted
    // row's bytes count, so insert-then-soft-delete churn cannot accumulate
    // uncounted storage. Soft-deleting never frees the byte budget.
    const a = await h.createUser();
    await setByteCap("knowledge", 2000); // ~707 bytes/row → 2 fit, 3rd overflows
    const ins = (id: string, content: string) =>
      h.asUser(a, (c) =>
        c.query(
          "insert into public.knowledge (id, scope_id, category, title, content) values ($1,$2,'p','T',$3)",
          [id, a, content],
        ),
      );
    await ins("r1", "z".repeat(700));
    await ins("r2", "z".repeat(700)); // ~1414 physical bytes
    // soft-delete r1 — physical bytes are unchanged (the row still exists)
    await h.asUser(a, (c) =>
      c.query("update public.knowledge set is_deleted=true where id='r1'"),
    );
    // a 3rd row would push physical bytes ~2121 > 2000 → blocked, proving the
    // soft-delete did NOT free byte budget
    const err = await expectError(() => ins("r3", "z".repeat(700)));
    expect(err.code).toBe("23514");
    expect(err.message).toMatch(/byte quota exceeded/i);
  });

  it("user_table_usage tracks the PHYSICAL footprint (insert/edit/delete)", async () => {
    const a = await h.createUser();
    const ins = (id: string, content: string) =>
      h.asUser(a, (c) =>
        c.query(
          "insert into public.knowledge (id, scope_id, category, title, content) values ($1,$2,'p','T',$3)",
          [id, a, content],
        ),
      );
    await ins("c1", "z".repeat(100));
    await ins("c2", "z".repeat(100));
    let u = await usage(a, "knowledge");
    expect(Number(u.row_count)).toBe(2);
    expect(Number(u.byte_count)).toBeGreaterThanOrEqual(200);
    const afterTwo = Number(u.byte_count);

    // soft-delete is an UPDATE → physical footprint UNCHANGED (row stays, same bytes)
    await h.asUser(a, (c) =>
      c.query("update public.knowledge set is_deleted=true where id='c1'"),
    );
    u = await usage(a, "knowledge");
    expect(Number(u.row_count)).toBe(2);
    expect(Number(u.byte_count)).toBe(afterTwo);

    // content edit → byte delta tracked, row count unchanged
    await h.asUser(a, (c) =>
      c.query("update public.knowledge set content=$1 where id='c2'", [
        "z".repeat(300),
      ]),
    );
    u = await usage(a, "knowledge");
    expect(Number(u.row_count)).toBe(2);
    expect(Number(u.byte_count)).toBeGreaterThan(afterTwo);

    // hard delete → physical -1
    await h.asUser(a, (c) =>
      c.query("delete from public.knowledge where id='c1'"),
    );
    u = await usage(a, "knowledge");
    expect(Number(u.row_count)).toBe(1);

    // counter row_count == physical ground truth (ALL rows, incl. is_deleted)
    const phys = await h.asUser(a, (c) =>
      c
        .query("select count(*)::int n from public.knowledge")
        .then((r) => r.rows[0].n),
    );
    expect(Number(u.row_count)).toBe(phys);
  });

  it("authenticated cannot write user_table_usage (counter is trigger-only)", async () => {
    const a = await h.createUser();
    const err = await expectError(() =>
      h.asUser(a, (c) =>
        c.query(
          "update public.user_table_usage set row_count=0 where scope_id=$1",
          [a],
        ),
      ),
    );
    expect(err.code).toBe("42501");
  });

  // --- A2 3b-2 metric tables: prove the enforce_row_quota probe branches work
  // (0007's generic `id` probe would 42703 on the logical_id/replica_id keys). ---

  it("caps knowledge_meta inserts at the free-tier row cap (logical_id key probe)", async () => {
    const a = await h.createUser();
    await setCap("knowledge_meta", 2);
    const ins = (lid: string) =>
      h.asUser(a, (c) =>
        c.query(
          "insert into public.knowledge_meta (logical_id, scope_id, base_confidence) values ($1,$2,0.9)",
          [lid, a],
        ),
      );
    await ins("m1");
    await ins("m2");
    const err = await expectError(() => ins("m3"));
    expect(err.code).toBe("23514"); // quota, NOT 42703 (undefined_column)
    expect(err.message).toMatch(/quota exceeded/i);
  });

  it("caps knowledge_meta_crdt inserts at the free-tier row cap (composite key probe)", async () => {
    const a = await h.createUser();
    await setCap("knowledge_meta_crdt", 2);
    const ins = (lid: string, rep: string) =>
      h.asUser(a, (c) =>
        c.query(
          "insert into public.knowledge_meta_crdt (logical_id, replica_id, scope_id, pos, neg) values ($1,$2,$3,0.1,0)",
          [lid, rep, a],
        ),
      );
    await ins("k1", "rA");
    await ins("k1", "rB"); // same logical_id, different replica → distinct row
    const err = await expectError(() => ins("k2", "rA"));
    expect(err.code).toBe("23514");
    expect(err.message).toMatch(/quota exceeded/i);
  });

  it("re-upserting account_escrow is an UPDATE, not new growth (id::int key probe, C-3)", async () => {
    // account_escrow is single-row (id=1). At a row cap of 1, an ON CONFLICT upsert of
    // the SAME (scope,id) must be recognized by the id::int probe as existing and defer
    // to the UPDATE path (no new-row count) — NOT raise 42703/42883 (a broken/text id
    // probe) nor a false quota error.
    const a = await h.createUser();
    await setCap("account_escrow", 1);
    await h.asUser(a, (c) =>
      c.query(
        `insert into public.account_escrow (id, scope_id, wrapped_secret, kdf_salt, kdf_t, kdf_m, kdf_p)
         values (1, $1, 'dg==', 'cw==', 3, 65536, 1)`,
        [a],
      ),
    );
    const r = await h.asUser(a, (c) =>
      c.query(
        `insert into public.account_escrow (id, scope_id, wrapped_secret, kdf_salt, kdf_t, kdf_m, kdf_p)
         values (1, $1, 'dmVyMg==', 'cw==', 3, 65536, 1)
         on conflict (scope_id, id) do update set wrapped_secret = excluded.wrapped_secret`,
        [a],
      ),
    );
    expect(r.rowCount).toBe(1); // upsert resolved to UPDATE, quota not tripped
    const u = await usage(a, "account_escrow");
    expect(Number(u.row_count)).toBe(1); // still one physical row
  });

  it("caps scope_keys inserts at the free-tier row cap (member_user_id key probe, C-3)", async () => {
    const a = await h.createUser();
    await setCap("scope_keys", 2);
    const ins = (member: string) =>
      h.asUser(a, (c) =>
        c.query(
          "insert into public.scope_keys (member_user_id, scope_id, wrapped_dek) values ($1,$2,'d2s=')",
          [member, a],
        ),
      );
    await ins("m-1");
    await ins("m-2");
    const err = await expectError(() => ins("m-3"));
    expect(err.code).toBe("23514"); // quota, NOT 42703 (undefined_column)
    expect(err.message).toMatch(/quota exceeded/i);
  });

  it("re-pushing a knowledge_meta_crdt counter is an UPDATE, not new growth", async () => {
    // The client overwrites its OWN replica's counter as it grows. That upsert
    // resolves to UPDATE (PK exists) → not counted as a new physical row, so an
    // at-cap user can keep advancing their counter.
    const a = await h.createUser();
    await setCap("knowledge_meta_crdt", 1);
    const upsert = (pos: number) =>
      h.asUser(a, (c) =>
        c.query(
          `insert into public.knowledge_meta_crdt (logical_id, replica_id, scope_id, pos, neg)
           values ('g1','rA',$1,$2,0)
           on conflict (scope_id, logical_id, replica_id) do update set pos=excluded.pos`,
          [a, pos],
        ),
      );
    await upsert(0.1); // physical row 1 = cap
    const grown = await upsert(0.5); // UPDATE-in-disguise, must NOT be quota-blocked
    expect(grown.rowCount).toBe(1);
    const u = await usage(a, "knowledge_meta_crdt");
    expect(Number(u.row_count)).toBe(1); // still one physical row
  });

  it("a forged cross-scope write does NOT leak the victim's quota state (oracle closed)", async () => {
    // A BEFORE-trigger runs before RLS WITH CHECK, so an unguarded enforce_row_quota
    // would read the VICTIM's tier/usage and echo "N of M rows" for a forged
    // scope_id — an at-cap existence oracle. The guard short-circuits before that
    // read; RLS then rejects the (always-doomed) forged row generically.
    const victim = await h.createUser();
    const attacker = await h.createUser();
    await setCap("knowledge_meta", 1);
    await h.asUser(victim, (c) =>
      c.query(
        "insert into public.knowledge_meta (logical_id, scope_id, base_confidence) values ('v1',$1,0.9)",
        [victim],
      ),
    ); // victim now at cap
    const err = await expectError(() =>
      h.asUser(attacker, (c) =>
        c.query(
          "insert into public.knowledge_meta (logical_id, scope_id, base_confidence) values ('x',$1,0.9)",
          [victim],
        ),
      ),
    );
    expect(err.code).toBe("42501"); // RLS, NOT the 23514 numeric quota oracle
    expect(err.message).not.toMatch(/\d+ of \d+ rows/i); // no count leak
  });
});

describe.skipIf(gate())("sync migrations — scope seam", () => {
  it("author_id defaults to the writer; scope_id = author_id in v1", async () => {
    const a = await h.createUser();
    await h.asUser(a, (c) =>
      c.query(
        "insert into public.knowledge (id, scope_id, category, title, content) values ('s1',$1,'p','T','C')",
        [a],
      ),
    );
    const row = await h.asUser(a, (c) =>
      c
        .query("select scope_id, author_id from public.knowledge where id='s1'")
        .then((r) => r.rows[0]),
    );
    expect(row.scope_id).toBe(a);
    expect(row.author_id).toBe(a); // defaulted to auth.uid()
  });

  it("a client cannot forge author_id on its own scope (WITH CHECK pins it)", async () => {
    const a = await h.createUser();
    const other = await h.createUser();
    // own scope, but author_id forged to someone else → blocked by
    // WITH CHECK (author_id = auth.uid()). This is the same-scope spoof the
    // v1 invariant must prevent.
    const err = await expectError(() =>
      h.asUser(a, (c) =>
        c.query(
          "insert into public.knowledge (id, scope_id, author_id, category, title, content) values ('s2',$1,$2,'p','T','C')",
          [a, other],
        ),
      ),
    );
    expect(err.code).toBe("42501");
  });

  it("scope_id is immutable in v1 (re-parent rejected)", async () => {
    const a = await h.createUser();
    const other = await h.createUser();
    await h.asUser(a, (c) =>
      c.query(
        "insert into public.knowledge (id, scope_id, category, title, content) values ('im',$1,'p','T','C')",
        [a],
      ),
    );
    // re-parenting to another scope: the BEFORE-trigger guard fires first
    // (check_violation) before RLS WITH CHECK would also reject it.
    const err = await expectError(() =>
      h.asUser(a, (c) =>
        c.query("update public.knowledge set scope_id=$1 where id='im'", [
          other,
        ]),
      ),
    );
    expect(err.code).toBe("23514");
  });
});

describe.skipIf(gate())(
  "sync migrations — knowledge_meta convergent register (A2 3b-2, 0009)",
  () => {
    it("RLS: a user cannot read another user's knowledge_meta rows", async () => {
      const a = await h.createUser();
      const b = await h.createUser();
      await h.asUser(a, (c) =>
        c.query(
          "insert into public.knowledge_meta (logical_id, scope_id, base_confidence) values ('r1',$1,0.7)",
          [a],
        ),
      );
      const seen = await h.asUser(b, (c) =>
        c
          .query("select logical_id from public.knowledge_meta")
          .then((r) => r.rowCount),
      );
      expect(seen).toBe(0);
    });

    it("RLS: a user cannot read another user's knowledge_meta_crdt rows", async () => {
      const a = await h.createUser();
      const b = await h.createUser();
      await h.asUser(a, (c) =>
        c.query(
          "insert into public.knowledge_meta_crdt (logical_id, replica_id, scope_id, pos, neg) values ('r1','rA',$1,0.2,0)",
          [a],
        ),
      );
      const seen = await h.asUser(b, (c) =>
        c
          .query("select logical_id from public.knowledge_meta_crdt")
          .then((r) => r.rowCount),
      );
      expect(seen).toBe(0);
    });

    it("RLS: a user cannot write into another user's scope", async () => {
      const a = await h.createUser();
      const b = await h.createUser();
      // b tries to insert a row owned by a (scope_id = a) → WITH CHECK rejects.
      const err = await expectError(() =>
        h.asUser(b, (c) =>
          c.query(
            "insert into public.knowledge_meta (logical_id, scope_id, base_confidence) values ('x',$1,0.5)",
            [a],
          ),
        ),
      );
      expect(err.code).toBe("42501");
    });

    it("author_id defaults to the writer; forging it is rejected (WITH CHECK)", async () => {
      const a = await h.createUser();
      const other = await h.createUser();
      // default path: author_id = auth.uid()
      await h.asUser(a, (c) =>
        c.query(
          "insert into public.knowledge_meta (logical_id, scope_id, base_confidence) values ('ok',$1,0.9)",
          [a],
        ),
      );
      const row = await h.asUser(a, (c) =>
        c
          .query(
            "select author_id from public.knowledge_meta where logical_id='ok'",
          )
          .then((r) => r.rows[0]),
      );
      expect(row.author_id).toBe(a);
      // forged author_id on own scope → 42501
      const err = await expectError(() =>
        h.asUser(a, (c) =>
          c.query(
            "insert into public.knowledge_meta (logical_id, scope_id, author_id, base_confidence) values ('forge',$1,$2,0.9)",
            [a, other],
          ),
        ),
      );
      expect(err.code).toBe("42501");
    });

    it("scope_id is immutable on knowledge_meta_crdt (re-parent rejected)", async () => {
      const a = await h.createUser();
      const other = await h.createUser();
      await h.asUser(a, (c) =>
        c.query(
          "insert into public.knowledge_meta_crdt (logical_id, replica_id, scope_id, pos, neg) values ('im','rA',$1,0.1,0)",
          [a],
        ),
      );
      const err = await expectError(() =>
        h.asUser(a, (c) =>
          c.query(
            "update public.knowledge_meta_crdt set scope_id=$1 where logical_id='im'",
            [other],
          ),
        ),
      );
      expect(err.code).toBe("23514");
    });

    it("rejects a poisoned base_confidence (NaN / out-of-range) — protects the peer sum", async () => {
      const a = await h.createUser();
      for (const bad of ["NaN", "2.0", "-0.5"]) {
        const err = await expectError(() =>
          h.asUser(a, (c) =>
            c.query(
              "insert into public.knowledge_meta (logical_id, scope_id, base_confidence) values ($1,$2,$3)",
              [`b_${bad}`, a, bad],
            ),
          ),
        );
        expect(err.code).toBe("23514"); // size/numeric check_violation
      }
    });

    it("rejects poisoned CRDT counters (negative / NaN / Infinity)", async () => {
      const a = await h.createUser();
      // pos poisoned
      for (const bad of ["-1", "NaN", "Infinity"]) {
        const err = await expectError(() =>
          h.asUser(a, (c) =>
            c.query(
              "insert into public.knowledge_meta_crdt (logical_id, replica_id, scope_id, pos, neg) values ($1,'rA',$2,$3,0)",
              [`p_${bad}`, a, bad],
            ),
          ),
        );
        expect(err.code).toBe("23514");
      }
      // neg poisoned
      const err = await expectError(() =>
        h.asUser(a, (c) =>
          c.query(
            "insert into public.knowledge_meta_crdt (logical_id, replica_id, scope_id, pos, neg) values ('n1','rA',$1,0,'Infinity')",
            [a],
          ),
        ),
      );
      expect(err.code).toBe("23514");
    });

    it("usage counter tracks the physical footprint of the metric tables", async () => {
      const a = await h.createUser();
      await h.asUser(a, (c) =>
        c.query(
          "insert into public.knowledge_meta_crdt (logical_id, replica_id, scope_id, pos, neg) values ('u1','rA',$1,0.1,0)",
          [a],
        ),
      );
      const { rows } = await h.client.query(
        "select row_count from public.user_table_usage where scope_id=$1 and table_name='knowledge_meta_crdt'",
        [a],
      );
      expect(Number(rows[0].row_count)).toBe(1);
      // hard delete → physical -1
      await h.asUser(a, (c) =>
        c.query(
          "delete from public.knowledge_meta_crdt where logical_id='u1' and replica_id='rA'",
        ),
      );
      const after = await h.client.query(
        "select row_count from public.user_table_usage where scope_id=$1 and table_name='knowledge_meta_crdt'",
        [a],
      );
      expect(Number(after.rows[0].row_count)).toBe(0);
    });
  },
);
