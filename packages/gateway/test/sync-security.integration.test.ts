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
  entities: 300, // 0017: proportionate to knowledge=500 (was 30 — crippled the graph)
  entity_aliases: 3000, // 0017: ~10x entities (was 300)
  entity_relations: 1500, // 0017 (was 300)
  knowledge_entity_refs: 5000, // 0017: ~10 refs/entity (was 2000)
  knowledge_meta: 5000, // 0016: headroom above knowledge so metas never bottleneck independently
  knowledge_meta_crdt: 5000,
  account_escrow: 2,
  scope_keys: 100,
};

// Mirrors the free-tier max_bytes seeded in 0007_scope_seam.sql + 0009 — used to
// restore byte caps in afterEach so setByteCap() mutations never leak across tests.
const FREE_BYTE_LIMITS: Record<string, number> = {
  knowledge: 12582912, // 12 MB — widened for wire-encryption overhead (0011, C-4)
  entities: 1048576,
  entity_aliases: 2097152,
  entity_relations: 2097152,
  knowledge_entity_refs: 1048576,
  knowledge_meta: 4194304, // 0016: 4 MB, raised with the row headroom
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

describe.skipIf(gate())(
  "sync migrations — scope_keys DEK immutability (0012, #825)",
  () => {
    // v1 personal: member_user_id == scope_id == author_id == the user. Bind $1 (text,
    // member_user_id) and $2 (uuid, scope_id/author_id) both from `user`.
    const insKey = (user: string, dek = "d3JhcHBlZERFSw==") =>
      h.asUser(user, (c) =>
        c.query(
          `insert into public.scope_keys (member_user_id, scope_id, author_id, wrapped_dek)
           values ($1, $2, $2, $3)`,
          [user, user, dek],
        ),
      );
    const updKey = (user: string, sql: string) =>
      h.asUser(user, (c) =>
        c.query(
          `update public.scope_keys set ${sql}
             where scope_id = $1 and member_user_id = $2`,
          [user, user], // $1 uuid (scope_id), $2 text (member_user_id)
        ),
      );

    it("allows a metadata-only update that keeps wrapped_dek", async () => {
      const a = await h.createUser();
      await insKey(a);
      const r = await updKey(a, "content_hash='abc123'");
      expect(r.rowCount).toBe(1);
    });

    it("rejects changing wrapped_dek at the same key_epoch (first-write-wins)", async () => {
      const a = await h.createUser();
      await insKey(a, "T1JJR0lOQUw="); // "ORIGINAL"
      const err = await expectError(() =>
        updKey(a, "wrapped_dek='Q0xPQkJFUg=='"),
      );
      expect(err.code).toBe("23514");
      // the original DEK survives the rejected clobber
      const { rows } = await h.asUser(a, (c) =>
        c.query(
          "select wrapped_dek from public.scope_keys where scope_id=$1::uuid",
          [a],
        ),
      );
      expect(rows[0].wrapped_dek).toBe("T1JJR0lOQUw=");
    });

    it("allows changing wrapped_dek at a HIGHER key_epoch (rotation)", async () => {
      const a = await h.createUser();
      await insKey(a, "ZXBvY2gw"); // "epoch0"
      const r = await updKey(a, "wrapped_dek='ZXBvY2gx', key_epoch=1");
      expect(r.rowCount).toBe(1);
    });

    it("allows an idempotent upsert of the SAME wrapped_dek (production convergence)", async () => {
      const a = await h.createUser();
      await insKey(a, "U0FNRQ=="); // "SAME"
      const r = await h.asUser(a, (c) =>
        c.query(
          `insert into public.scope_keys (member_user_id, scope_id, author_id, wrapped_dek)
           values ($1, $2, $2, 'U0FNRQ==')
           on conflict (scope_id, member_user_id)
             do update set wrapped_dek = excluded.wrapped_dek, updated_at = now()`,
          [a, a],
        ),
      );
      expect(r.rowCount).toBe(1);
    });

    it("rejects a LOWER-epoch wrapped_dek change too (<=, not just ==)", async () => {
      const a = await h.createUser();
      await insKey(a, "ZXBvY2gw");
      await updKey(a, "key_epoch=5"); // bump epoch (dek unchanged) — allowed
      const err = await expectError(() =>
        updKey(a, "wrapped_dek='TE9XRVI=', key_epoch=2"),
      );
      expect(err.code).toBe("23514");
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
    const big = "z".repeat(13000);
    // content (12288 cap, widened for ciphertext in 0011)
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

  it("widens the free knowledge byte cap to 12 MB for ciphertext overhead (0011, C-4)", async () => {
    const { rows } = await h.client.query(
      "select max_bytes from public.plan_limits where tier='free' and table_name='knowledge'",
    );
    expect(Number(rows[0].max_bytes)).toBe(12582912);
  });

  it("widens the per-row knowledge content/title CHECK for ciphertext (0011, C-4)", async () => {
    // A ciphertext content between the old 8192 and new 12288 cap must now be ACCEPTED
    // (0004 would have rejected it as a check_violation → silent poison-drop).
    const a = await h.createUser();
    const r = await h.asUser(a, (c) =>
      c.query(
        "insert into public.knowledge (id, scope_id, category, title, content) values ('kc',$1,'p',$2,$3)",
        [a, "T".repeat(900), "C".repeat(11000)],
      ),
    );
    expect(r.rowCount).toBe(1);
    // ...but a value past the new cap still fails cleanly (check_violation, not 54000).
    const err = await expectError(() =>
      h.asUser(a, (c) =>
        c.query(
          "insert into public.knowledge (id, scope_id, category, title, content) values ('kc2',$1,'p','T',$2)",
          [a, "C".repeat(12289)],
        ),
      ),
    );
    expect(err.code).toBe("23514");
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

describe.skipIf(gate())("sync migrations — knowledge eviction (#1191b)", () => {
  // Insert a knowledge entry + its meta register (base_confidence = value) as one txn.
  const insK = (uid: string, id: string, conf: number) =>
    h.asUser(uid, async (c) => {
      await c.query(
        "insert into public.knowledge (id, scope_id, category, title, content) values ($1,$2,'p','T','c')",
        [id, uid],
      );
      await c.query(
        "insert into public.knowledge_meta (scope_id, logical_id, base_confidence) values ($1,$2,$3)",
        [uid, id, conf],
      );
    });
  // Eviction cap is admin/migration-managed (sync_config, RLS-locked) — a client
  // cannot raise its own budget. Tests tune it via the raw admin connection.
  const setEvictionBudget = (n: number) =>
    h.client.query(
      "update public.sync_config set value=$1 where key='eviction_budget_per_hour'",
      [n],
    );
  const liveKnowledge = async (uid: string) => {
    const { rows } = await h.client.query(
      "select id from public.knowledge where scope_id=$1 and is_deleted=false order by id",
      [uid],
    );
    return rows.map((r) => r.id as string);
  };
  const metaIds = async (uid: string) => {
    const { rows } = await h.client.query(
      "select logical_id from public.knowledge_meta where scope_id=$1 order by logical_id",
      [uid],
    );
    return rows.map((r) => r.logical_id as string);
  };
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
  afterEach(async () => {
    if (gate()) return;
    await setCap("knowledge", FREE_LIMITS.knowledge);
    await setCap("entities", FREE_LIMITS.entities);
    await setCap("entity_aliases", FREE_LIMITS.entity_aliases);
    await setCap("entity_relations", FREE_LIMITS.entity_relations);
    await setByteCap("knowledge", 12582912);
    await setEvictionBudget(200); // restore default so the low-budget test can't leak
  });

  it("evicts the LOWEST-confidence entry (+ cascades its meta) when a knowledge INSERT exceeds the row cap", async () => {
    const a = await h.createUser();
    await setCap("knowledge", 3);
    await insK(a, "k1", 0.9);
    await insK(a, "k2", 0.2); // lowest value
    await insK(a, "k3", 0.7);
    // 4th insert exceeds the cap → evicts k2 (lowest), admits k4; count stays at 3.
    await insK(a, "k4", 0.8);
    expect(await liveKnowledge(a)).toEqual(["k1", "k3", "k4"]); // k2 evicted, not k4
    expect(await metaIds(a)).toEqual(["k1", "k3", "k4"]); // meta cascaded with the row
    const { rows } = await h.client.query(
      "select row_count from public.user_table_usage where scope_id=$1 and table_name='knowledge'",
      [a],
    );
    expect(Number(rows[0].row_count)).toBe(3); // net stayed at the cap
  });

  it("also cascade-deletes the evicted entry's knowledge_meta_crdt row", async () => {
    const a = await h.createUser();
    await setCap("knowledge", 1);
    await insK(a, "lo", 0.1);
    await h.asUser(a, (c) =>
      c.query(
        "insert into public.knowledge_meta_crdt (scope_id, logical_id, replica_id, pos, neg) values ($1,'lo','r1',0,0)",
        [a],
      ),
    );
    await insK(a, "hi", 0.9); // evicts "lo"
    const crdt = await h.client.query(
      "select logical_id from public.knowledge_meta_crdt where scope_id=$1",
      [a],
    );
    expect(crdt.rows.map((r) => r.logical_id)).not.toContain("lo");
    expect(await liveKnowledge(a)).toEqual(["hi"]);
  });

  it("stops evicting once the per-scope hourly budget is spent (circuit breaker → pause)", async () => {
    const a = await h.createUser();
    await setCap("knowledge", 2);
    await setEvictionBudget(1); // one eviction per hour, then pause
    await insK(a, "k1", 0.5);
    await insK(a, "k2", 0.5);
    await insK(a, "k3", 0.9); // over cap → evicts one (count→1), admits k3
    const err = await expectError(() => insK(a, "k4", 0.9)); // count 1 ≥ 1 → raise
    expect(err.code).toBe("23514"); // breaker tripped → normal quota pause
    expect(err.message).toMatch(/quota exceeded/i);
  });

  it("entities with TIED sync_rank pause at the cap (guard is strict >, no churn for no gain)", async () => {
    const a = await h.createUser();
    await setCap("entities", 2);
    // No sync_rank given → all default to 0, so floor == incoming (0). The strict-`>`
    // guard means a rank-0 newcomer must NOT displace a rank-0 incumbent — it pauses.
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
    expect(err.code).toBe("23514"); // 0 > 0 is false → guard blocks eviction → pause
  });

  it("evicts the OLDEST entity_relations row by recency (not id) when over the row cap", async () => {
    const a = await h.createUser();
    await setCap("entity_relations", 2);
    // Oldest row gets a HIGHER id so the test isolates updated_at ordering from id order.
    const insRel = (id: string, ts: string) =>
      h.asUser(a, (c) =>
        c.query(
          "insert into public.entity_relations (id, scope_id, entity_a, entity_b, relation, updated_at) values ($1,$2,'ea','eb','rel',$3)",
          [id, a, ts],
        ),
      );
    await insRel("r-z", "2020-01-01T00:00:00Z"); // OLDEST, but higher id
    await insRel("r-a", "2025-01-01T00:00:00Z"); // newer, lower id
    await insRel("r-new", "2026-01-01T00:00:00Z"); // over cap → evicts r-z (recency), admits
    const { rows } = await h.client.query(
      "select id from public.entity_relations where scope_id=$1 order by id",
      [a],
    );
    expect(rows.map((r) => r.id)).toEqual(["r-a", "r-new"]); // r-z evicted, NOT r-a (lowest id)
  });

  it("evicts the OLDEST entity_aliases row by recency when over the row cap", async () => {
    const a = await h.createUser();
    await setCap("entity_aliases", 1);
    const insAlias = (id: string, ts: string) =>
      h.asUser(a, (c) =>
        c.query(
          "insert into public.entity_aliases (id, scope_id, entity_id, alias_type, alias_value, updated_at) values ($1,$2,'e1','name','v',$3)",
          [id, a, ts],
        ),
      );
    await insAlias("al-old", "2020-01-01T00:00:00Z");
    await insAlias("al-new", "2026-01-01T00:00:00Z"); // over cap → evicts al-old, admits al-new
    const { rows } = await h.client.query(
      "select id from public.entity_aliases where scope_id=$1",
      [a],
    );
    expect(rows.map((r) => r.id)).toEqual(["al-new"]); // old evicted
  });

  it("evicts the LOWEST-sync_rank entity (+ cascades its aliases/refs/relations) when a higher-rank entity exceeds the cap", async () => {
    const a = await h.createUser();
    await setCap("entities", 2);
    const insE = (id: string, rank: number) =>
      h.asUser(a, (c) =>
        c.query(
          "insert into public.entities (id, scope_id, entity_type, canonical_name, sync_rank) values ($1,$2,'tool','n',$3)",
          [id, a, rank],
        ),
      );
    await insE("e-hi", 5);
    await insE("e-lo", 1); // lowest rank → the victim
    // Graph edges on the victim, to verify the cascade.
    await h.asUser(a, (c) =>
      c.query(
        "insert into public.entity_aliases (id, scope_id, entity_id, alias_type, alias_value) values ('al1',$1,'e-lo','name','v')",
        [a],
      ),
    );
    await h.asUser(a, (c) =>
      c.query(
        "insert into public.knowledge_entity_refs (scope_id, knowledge_id, entity_id) values ($1,'k1','e-lo')",
        [a],
      ),
    );
    await h.asUser(a, (c) =>
      c.query(
        "insert into public.entity_relations (id, scope_id, entity_a, entity_b, relation) values ('rel1',$1,'e-lo','e-hi','rel')",
        [a],
      ),
    );
    // incoming rank 3 > floor (e-lo=1) → evict e-lo, admit e-new.
    await insE("e-new", 3);
    const ents = await h.client.query(
      "select id from public.entities where scope_id=$1 order by id",
      [a],
    );
    expect(ents.rows.map((r) => r.id)).toEqual(["e-hi", "e-new"]); // e-lo evicted
    // Single-entity edges (alias, ref) belong to the victim → cascade-deleted.
    for (const [tbl, col, val] of [
      ["entity_aliases", "id", "al1"],
      ["knowledge_entity_refs", "entity_id", "e-lo"],
    ] as const) {
      const r = await h.client.query(
        `select 1 from public.${tbl} where scope_id=$1 and ${col}=$2`,
        [a, val],
      );
      expect(r.rowCount).toBe(0);
    }
    // rel1 (e-lo↔e-hi) is KEPT: its other endpoint e-hi survives, so it's e-hi's edge —
    // deleting it would be permanent (client never re-pushes). FIX 2 (#1191b, migration 0016).
    const rel = await h.client.query(
      "select 1 from public.entity_relations where scope_id=$1 and id='rel1'",
      [a],
    );
    expect(rel.rowCount).toBe(1);
  });

  it("cascade-deletes a relation only when BOTH endpoints are gone (0016 FIX 2)", async () => {
    const a = await h.createUser();
    await setCap("entities", 2);
    const insE = (id: string, rank: number) =>
      h.asUser(a, (c) =>
        c.query(
          "insert into public.entities (id, scope_id, entity_type, canonical_name, sync_rank) values ($1,$2,'tool','n',$3)",
          [id, a, rank],
        ),
      );
    await insE("e-hi", 5);
    await insE("e-lo", 1); // victim
    const insRel = (id: string, other: string) =>
      h.asUser(a, (c) =>
        c.query(
          "insert into public.entity_relations (id, scope_id, entity_a, entity_b, relation) values ($1,$2,'e-lo',$3,'r')",
          [id, a, other],
        ),
      );
    await insRel("r-keep", "e-hi"); // other endpoint survives → keep
    await insRel("r-drop", "e-ghost"); // other endpoint never synced → both gone → drop
    await insE("e-new", 3); // evicts e-lo
    const rows = await h.client.query(
      "select id from public.entity_relations where scope_id=$1 order by id",
      [a],
    );
    // r-keep survives (e-hi is a live synced entity); r-drop is deleted (e-ghost absent).
    // Under the old OR-cascade, r-keep would ALSO be deleted — this discriminates the fix.
    expect(rows.rows.map((r) => r.id)).toEqual(["r-keep"]);
  });

  it("a self-relation on the victim is deleted (both endpoints ARE the victim)", async () => {
    const a = await h.createUser();
    await setCap("entities", 2);
    const insE = (id: string, rank: number) =>
      h.asUser(a, (c) =>
        c.query(
          "insert into public.entities (id, scope_id, entity_type, canonical_name, sync_rank) values ($1,$2,'tool','n',$3)",
          [id, a, rank],
        ),
      );
    await insE("e-hi", 5);
    await insE("e-lo", 1); // victim
    // A self-relation (client normally guards against this — defense-in-depth for direct writers).
    await h.asUser(a, (c) =>
      c.query(
        "insert into public.entity_relations (id, scope_id, entity_a, entity_b, relation) values ('r-self',$1,'e-lo','e-lo','r')",
        [a],
      ),
    );
    await insE("e-new", 3); // evicts e-lo
    const rows = await h.client.query(
      "select 1 from public.entity_relations where scope_id=$1 and id='r-self'",
      [a],
    );
    expect(rows.rowCount).toBe(0); // the victim is its own only endpoint → both gone → deleted
  });

  it("free knowledge_meta cap has headroom above knowledge (0016 FIX 1)", async () => {
    // 5000 (10× the knowledge cap) so metas never bottleneck independently of knowledge —
    // the overflow's metas fitting is what makes the "knowledge_meta limit" message go away.
    const r = await h.client.query(
      "select max_rows from public.plan_limits where tier='free' and table_name='knowledge_meta'",
    );
    expect(Number(r.rows[0].max_rows)).toBe(5000);
  });

  it("does NOT evict an entity when the incoming does not outrank the floor (value guard → pause)", async () => {
    const a = await h.createUser();
    await setCap("entities", 2);
    const insE = (id: string, rank: number) =>
      h.asUser(a, (c) =>
        c.query(
          "insert into public.entities (id, scope_id, entity_type, canonical_name, sync_rank) values ($1,$2,'tool','n',$3)",
          [id, a, rank],
        ),
      );
    await insE("e-a", 5);
    await insE("e-b", 3); // floor = 3
    // incoming rank 2 ≤ floor(3) → a 0/low-ref newcomer must NOT displace a ranked entity.
    const err = await expectError(() => insE("e-c", 2));
    expect(err.code).toBe("23514");
    const ents = await h.client.query(
      "select id from public.entities where scope_id=$1 order by id",
      [a],
    );
    expect(ents.rows.map((r) => r.id)).toEqual(["e-a", "e-b"]); // nothing evicted
  });

  it("does NOT evict for a PRO tier — a capped pro pauses (eviction is the free-tier valve)", async () => {
    const a = await h.createUser();
    // tier is server-only (guard_profile_tier) → set it via service_role.
    await h.asService((c) =>
      c.query("update public.profiles set tier='pro' where id=$1", [a]),
    );
    // give pro a reachable knowledge row cap for the test, then restore.
    await h.client.query(
      "update public.plan_limits set max_rows=2 where tier='pro' and table_name='knowledge'",
    );
    try {
      await insK(a, "p1", 0.1);
      await insK(a, "p2", 0.1);
      const err = await expectError(() => insK(a, "p3", 0.9)); // pro → raise, NOT evict
      expect(err.code).toBe("23514");
      expect(await liveKnowledge(a)).toEqual(["p1", "p2"]); // nothing evicted
    } finally {
      await h.client.query(
        "update public.plan_limits set max_rows=50000 where tier='pro' and table_name='knowledge'",
      );
    }
  });

  it("the eviction budget (sync_config) is NOT client-readable or -writable — the breaker can't be bypassed", async () => {
    const a = await h.createUser();
    // No GRANT to authenticated → any access is 42501 (a client cannot raise its own
    // budget the way a session GUC would allow).
    expect(
      (
        await expectError(() =>
          h.asUser(a, (c) => c.query("select value from public.sync_config")),
        )
      ).code,
    ).toBe("42501");
    expect(
      (
        await expectError(() =>
          h.asUser(a, (c) =>
            c.query("update public.sync_config set value=999999999"),
          ),
        )
      ).code,
    ).toBe("42501");
  });

  it("does NOT evict for a BYTE-cap overflow — still raises (row eviction only)", async () => {
    const a = await h.createUser();
    await setByteCap("knowledge", 2000); // tiny byte budget, generous row cap
    await h.asUser(a, (c) =>
      c.query(
        "insert into public.knowledge (id, scope_id, category, title, content) values ('b1',$1,'p','T',$2)",
        [a, "z".repeat(1200)],
      ),
    );
    const err = await expectError(() =>
      h.asUser(a, (c) =>
        c.query(
          "insert into public.knowledge (id, scope_id, category, title, content) values ('b2',$1,'p','T',$2)",
          [a, "z".repeat(1200)],
        ),
      ),
    );
    expect(err.code).toBe("23514");
    expect(err.message).toMatch(/byte quota exceeded/i);
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

describe.skipIf(gate())("sync migrations — tombstone reaper (#909)", () => {
  async function usageRow(scope: string, table: string) {
    const { rows } = await h.client.query(
      "select coalesce(row_count,0)::int as rows, coalesce(byte_count,0)::int as bytes from public.user_table_usage where scope_id=$1 and table_name=$2",
      [scope, table],
    );
    return rows[0] ?? { rows: 0, bytes: 0 };
  }

  // Ancient (well past any window) vs recent (inside the 90-day window).
  const ANCIENT = "2020-01-01T00:00:00Z";
  const recentTs = () => new Date(Date.now() - 5 * 86_400_000).toISOString();

  const insK = (scope: string, id: string, deleted: boolean, ts: string) =>
    h.asUser(scope, (c) =>
      c.query(
        "insert into public.knowledge (id, scope_id, category, title, content, is_deleted, updated_at) values ($1,$2,'pattern','t','c',$3,$4)",
        [id, scope, deleted, ts],
      ),
    );

  it("reaps tombstones older than the window, keeps live + recent, decrements usage, across scopes", async () => {
    const a = await h.createUser();
    const b = await h.createUser();

    await insK(a, "k-live", false, ANCIENT); // live → never reaped even though ancient
    await insK(a, "k-old", true, ANCIENT); // tombstone past the window → reaped
    await insK(a, "k-recent", true, recentTs()); // tombstone inside the window → kept
    await h.asUser(a, (c) =>
      c.query(
        "insert into public.entity_aliases (id, scope_id, entity_id, alias_type, alias_value, is_deleted, updated_at) values ('al-old',$1,'e1','name','v',true,$2)",
        [a, ANCIENT],
      ),
    );
    await insK(b, "k-b-old", true, ANCIENT); // other scope → reaped too (global task)

    const before = await usageRow(a, "knowledge");
    expect(before.rows).toBe(3);

    const { rows: rr } = await h.client.query(
      "select public.reap_tombstones(90) as n",
    );
    expect(Number(rr[0].n)).toBeGreaterThanOrEqual(3); // >= our 3 (reap is global)

    // scope a knowledge: ancient tombstone gone; live + recent kept
    const { rows: ka } = await h.client.query(
      "select id from public.knowledge where scope_id=$1 order by id",
      [a],
    );
    expect(ka.map((r) => r.id)).toEqual(["k-live", "k-recent"]);
    // leaf-table tombstone reaped
    const { rows: al } = await h.client.query(
      "select id from public.entity_aliases where scope_id=$1",
      [a],
    );
    expect(al).toHaveLength(0);
    // cross-scope tombstone reaped
    const { rows: kb } = await h.client.query(
      "select id from public.knowledge where scope_id=$1",
      [b],
    );
    expect(kb).toHaveLength(0);
    // usage counters decremented by the one reaped knowledge row (3 -> 2, fewer bytes)
    const after = await usageRow(a, "knowledge");
    expect(after.rows).toBe(2);
    expect(after.bytes).toBeLessThan(before.bytes);
  });

  it("is not executable by a normal (authenticated) user — system task only", async () => {
    const a = await h.createUser();
    await expect(
      h.asUser(a, (c) => c.query("select public.reap_tombstones(90)")),
    ).rejects.toThrow(/permission denied/i);
  });

  it("retention_days=0 reaps every tombstone but never a live row", async () => {
    const a = await h.createUser();
    await insK(a, "k2-live", false, recentTs());
    await insK(a, "k2-dead", true, recentTs()); // recent, but window 0 → reaped
    await h.client.query("select public.reap_tombstones(0)");
    const { rows } = await h.client.query(
      "select id from public.knowledge where scope_id=$1",
      [a],
    );
    expect(rows.map((r) => r.id)).toEqual(["k2-live"]);
  });
});

describe.skipIf(gate())("sync migrations — reaper watermark (#909)", () => {
  const nowIso = () => new Date().toISOString();
  // Relative dates keep the tests robust to wall-clock. The cutoff is
  // LEAST(watermark, now()-retention); using cursors OLDER than the 90d floor makes the
  // WATERMARK the governing bound (so these tests exercise the watermark, not the floor).
  const daysAgo = (n: number) =>
    new Date(Date.now() - n * 86_400_000).toISOString();

  const insK = (scope: string, id: string, deleted: boolean, ts: string) =>
    h.asUser(scope, (c) =>
      c.query(
        "insert into public.knowledge (id, scope_id, category, title, content, is_deleted, updated_at) values ($1,$2,'pattern','t','c',$3,$4)",
        [id, scope, deleted, ts],
      ),
    );

  // `last_seen` is server-stamped by a trigger, so a test that needs to backdate a
  // device's activity bypasses user triggers via session_replication_role (superuser).
  async function insProgress(
    scope: string,
    device: string,
    table: string,
    pulledThrough: string,
    lastSeen: string,
  ) {
    await h.client.query("set session_replication_role = replica");
    try {
      await h.client.query(
        `insert into public.sync_device_progress (scope_id, device_id, table_name, pulled_through, last_seen)
         values ($1,$2,$3,$4,$5)
         on conflict (scope_id, device_id, table_name)
         do update set pulled_through = excluded.pulled_through, last_seen = excluded.last_seen`,
        [scope, device, table, pulledThrough, lastSeen],
      );
    } finally {
      await h.client.query("set session_replication_role = default");
    }
  }

  const kIds = async (scope: string) =>
    (
      await h.client.query(
        "select id from public.knowledge where scope_id=$1 order by id",
        [scope],
      )
    ).rows.map((r) => r.id);

  it("reaps a tombstone only once the SLOWEST active device has pulled past it", async () => {
    const a = await h.createUser();
    // Both cursors are older than the 90d floor, so the WATERMARK (min = tSlow) governs.
    const tSlow = daysAgo(200);
    const tFast = daysAgo(150);
    await insProgress(a, "dev-slow", "knowledge", tSlow, nowIso());
    await insProgress(a, "dev-fast", "knowledge", tFast, nowIso());
    await insK(a, "k-below", true, daysAgo(220)); // < watermark(tSlow) → reaped
    await insK(a, "k-between", true, daysAgo(175)); // > tSlow → slow device hasn't seen it → kept
    await h.client.query("select public.reap_tombstones(90, 90)");
    // k-between is >90d old, so a floor-only reaper would drop it; the watermark keeps it.
    expect(await kIds(a)).toEqual(["k-between"]);
  });

  it("does NOT reap a tombstone at exactly a device's cursor ms (strict <, keyset boundary)", async () => {
    const a = await h.createUser();
    const boundary = daysAgo(200);
    await insProgress(a, "dev-slow", "knowledge", boundary, nowIso());
    await insProgress(a, "dev-fast", "knowledge", daysAgo(150), nowIso());
    // A row AT exactly the slow device's cursor ms (a higher-id row at that ms may not
    // have been pulled) must NOT be reaped — the guard is strict `<`, not `<=`.
    await insK(a, "k-at-boundary", true, boundary);
    await h.client.query("select public.reap_tombstones(90, 90)");
    expect(await kIds(a)).toEqual(["k-at-boundary"]);
  });

  it("excludes an ABANDONED device (stale last_seen) so it can't hold back reaping", async () => {
    const a = await h.createUser();
    await insProgress(a, "dev-active", "knowledge", daysAgo(150), nowIso());
    // Ancient cursor AND ancient last_seen → excluded from the watermark.
    await insProgress(a, "dev-gone", "knowledge", daysAgo(500), daysAgo(500));
    // Newer than the abandoned cursor but older than the active one → reaped (only the
    // active device counts, and it has pulled past this tombstone). If the abandoned
    // device were counted, the watermark would drop to daysAgo(500) and k-x would survive.
    await insK(a, "k-x", true, daysAgo(300));
    await h.client.query("select public.reap_tombstones(90, 90)");
    expect(await kIds(a)).toEqual([]);
  });

  it("falls back to the retention floor for a scope whose only device is abandoned", async () => {
    const a = await h.createUser();
    // Abandoned device (excluded) → watermark null → LEAST falls back to now()-retention.
    await insProgress(a, "dev-gone", "knowledge", daysAgo(150), daysAgo(500));
    await insK(a, "k-old", true, daysAgo(200)); // > retention → reaped by the floor
    await insK(a, "k-recent", true, daysAgo(10)); // < retention → kept
    await h.client.query("select public.reap_tombstones(90, 90)");
    expect(await kIds(a)).toEqual(["k-recent"]);
  });

  it("holds a tombstone forever while an active device sits behind it (no false reap)", async () => {
    const a = await h.createUser();
    // Active device stuck at an old cursor: even a tombstone older than the retention
    // floor must NOT be reaped — the watermark, not the floor, governs.
    await insProgress(a, "dev-behind", "knowledge", daysAgo(400), nowIso());
    await insK(a, "k-ancient", true, daysAgo(300)); // >90d old, but AFTER the device cursor
    await h.client.query("select public.reap_tombstones(90, 90)");
    expect(await kIds(a)).toEqual(["k-ancient"]); // NOT reaped despite being > retention old
  });

  it("cleans up progress rows for devices abandoned beyond 2x the active window", async () => {
    const a = await h.createUser();
    await insProgress(
      a,
      "dev-ancient",
      "knowledge",
      daysAgo(300),
      daysAgo(300),
    ); // > 180d
    await insProgress(a, "dev-fresh", "knowledge", daysAgo(300), nowIso());
    await h.client.query("select public.reap_tombstones(90, 90)");
    const { rows } = await h.client.query(
      "select device_id from public.sync_device_progress where scope_id=$1 order by device_id",
      [a],
    );
    expect(rows.map((r) => r.device_id)).toEqual(["dev-fresh"]);
  });

  it("server-stamps last_seen on write (a client can't fake activity)", async () => {
    const a = await h.createUser();
    await h.asUser(a, (c) =>
      c.query(
        "insert into public.sync_device_progress (scope_id, device_id, table_name, pulled_through, last_seen) values ($1,'d','knowledge', now(), '2000-01-01T00:00:00Z')",
        [a],
      ),
    );
    const { rows } = await h.client.query(
      "select last_seen from public.sync_device_progress where scope_id=$1",
      [a],
    );
    // Trigger overwrote the client's bogus 2000 value with ~now().
    expect(new Date(rows[0].last_seen).getTime()).toBeGreaterThan(
      Date.parse("2020-01-01T00:00:00Z"),
    );
  });

  it("RLS: a device cannot read or write another scope's progress", async () => {
    const a = await h.createUser();
    const b = await h.createUser();
    await insProgress(
      b,
      "dev-b",
      "knowledge",
      "2026-01-01T00:00:00Z",
      nowIso(),
    );
    const seen = await h.asUser(a, (c) =>
      c.query(
        "select count(*)::int as n from public.sync_device_progress where scope_id=$1",
        [b],
      ),
    );
    expect(seen.rows[0].n).toBe(0); // RLS hides b's rows from a
    await expect(
      h.asUser(a, (c) =>
        c.query(
          "insert into public.sync_device_progress (scope_id, device_id, table_name, pulled_through) values ($1,'x','knowledge', now())",
          [b],
        ),
      ),
    ).rejects.toThrow(); // WITH CHECK (scope_id = auth.uid()) blocks forging b's scope
  });

  it("cap trigger allows re-reporting an existing device (the update path never trips it)", async () => {
    const a = await h.createUser();
    const reReport = () =>
      h.asUser(a, (c) =>
        c.query(
          `insert into public.sync_device_progress (scope_id, device_id, table_name, pulled_through)
           values ($1,'d1','knowledge', now())
           on conflict (scope_id, device_id, table_name) do update set pulled_through = excluded.pulled_through`,
          [a],
        ),
      );
    await reReport(); // INSERT (well under cap) — allowed
    await expect(reReport()).resolves.toBeDefined(); // UPDATE via upsert — must NOT raise
    const { rows } = await h.client.query(
      "select count(*)::int as n from public.sync_device_progress where scope_id=$1",
      [a],
    );
    expect(rows[0].n).toBe(1); // upsert updated in place, did not duplicate
  });
});

describe.skipIf(gate())(
  "sync migrations — pro tier gate + quota (D, #826)",
  () => {
    // Pro-tier plan_limits defaults (0020) — restored after each test so cap
    // mutations never leak. These tables have NO 'free' row (free is RLS-denied),
    // so the shared quota suite's FREE_LIMITS afterEach never touches them.
    const PRO_ROW_CAP: Record<string, number> = {
      distillations: 200000,
      temporal_messages: 1000000,
    };
    const PRO_BYTE_CAP: Record<string, number> = {
      distillations: 268435456,
      temporal_messages: 536870912,
    };

    const makePro = (uid: string) =>
      h.asService((c) =>
        c.query("update public.profiles set tier='pro' where id=$1", [uid]),
      );
    const setFree = (uid: string) =>
      h.asService((c) =>
        c.query("update public.profiles set tier='free' where id=$1", [uid]),
      );
    const setProRowCap = (table: string, n: number) =>
      h.client.query(
        "update public.plan_limits set max_rows=$1 where tier='pro' and table_name=$2",
        [n, table],
      );
    const setProByteCap = (table: string, n: number) =>
      h.client.query(
        "update public.plan_limits set max_bytes=$1 where tier='pro' and table_name=$2",
        [n, table],
      );

    afterEach(async () => {
      if (gate()) return;
      for (const [t, n] of Object.entries(PRO_ROW_CAP))
        await setProRowCap(t, n);
      for (const [t, n] of Object.entries(PRO_BYTE_CAP))
        await setProByteCap(t, n);
    });

    it("current_tier() reflects the profiles mirror", async () => {
      const a = await h.createUser();
      const free = await h.asUser(a, (c) =>
        c.query("select public.current_tier() as t"),
      );
      expect(free.rows[0].t).toBe("free");
      await makePro(a);
      const pro = await h.asUser(a, (c) =>
        c.query("select public.current_tier() as t"),
      );
      expect(pro.rows[0].t).toBe("pro");
    });

    it("seeds pro plan_limits for both pro tables and NO free row (free is RLS-denied)", async () => {
      const { rows } = await h.client.query(
        "select table_name, max_rows, max_bytes from public.plan_limits where tier='pro' and table_name in ('distillations','temporal_messages') order by table_name",
      );
      expect(rows.map((r) => r.table_name)).toEqual([
        "distillations",
        "temporal_messages",
      ]);
      expect(Number(rows[0].max_rows)).toBe(200000);
      expect(Number(rows[0].max_bytes)).toBe(268435456);
      expect(Number(rows[1].max_rows)).toBe(1000000);
      expect(Number(rows[1].max_bytes)).toBe(536870912);
      const free = await h.client.query(
        "select count(*)::int as n from public.plan_limits where tier='free' and table_name in ('distillations','temporal_messages')",
      );
      expect(free.rows[0].n).toBe(0);
    });

    it("a FREE user cannot write pro tables (RLS tier gate → 42501)", async () => {
      const a = await h.createUser(); // tier defaults to 'free'
      const d = await expectError(() =>
        h.asUser(a, (c) =>
          c.query(
            "insert into public.distillations (id, scope_id) values ('d1',$1)",
            [a],
          ),
        ),
      );
      expect(d.code).toBe("42501");
      const t = await expectError(() =>
        h.asUser(a, (c) =>
          c.query(
            "insert into public.temporal_messages (id, scope_id) values ('t1',$1)",
            [a],
          ),
        ),
      );
      expect(t.code).toBe("42501");
    });

    it("a PRO user can write; a downgraded ex-pro can still READ but not write", async () => {
      const a = await h.createUser();
      await makePro(a);
      await h.asUser(a, (c) =>
        c.query(
          "insert into public.distillations (id, scope_id, narrative) values ('d1',$1,'sealed')",
          [a],
        ),
      );
      // Downgrade: reads stay open (USING scope_id=auth.uid()), writes blocked.
      await setFree(a);
      const seen = await h.asUser(a, (c) =>
        c.query("select id from public.distillations where scope_id=$1", [a]),
      );
      expect(seen.rows.map((r) => r.id)).toEqual(["d1"]);
      const err = await expectError(() =>
        h.asUser(a, (c) =>
          c.query(
            "insert into public.distillations (id, scope_id) values ('d2',$1)",
            [a],
          ),
        ),
      );
      expect(err.code).toBe("42501");
    });

    it("rejects a forged author_id on pro tables (WITH CHECK → 42501)", async () => {
      const a = await h.createUser();
      const b = await h.createUser();
      await makePro(a);
      const err = await expectError(() =>
        h.asUser(a, (c) =>
          c.query(
            "insert into public.distillations (id, scope_id, author_id) values ('d1',$1,$2)",
            [a, b],
          ),
        ),
      );
      expect(err.code).toBe("42501");
    });

    it("rejects a forged scope_id on pro tables (WITH CHECK → 42501)", async () => {
      const a = await h.createUser();
      const b = await h.createUser();
      await makePro(a);
      await makePro(b);
      // a (pro) tries to write a row OWNED by b's scope → WITH CHECK scope_id=auth.uid() fails.
      const err = await expectError(() =>
        h.asUser(a, (c) =>
          c.query(
            "insert into public.temporal_messages (id, scope_id) values ('t1',$1)",
            [b],
          ),
        ),
      );
      expect(err.code).toBe("42501");
    });

    it("scope_id is immutable on pro tables (→ 23514)", async () => {
      const a = await h.createUser();
      const b = await h.createUser();
      await makePro(a);
      await h.asUser(a, (c) =>
        c.query(
          "insert into public.distillations (id, scope_id) values ('d1',$1)",
          [a],
        ),
      );
      const err = await expectError(() =>
        h.asUser(a, (c) =>
          c.query(
            "update public.distillations set scope_id=$2 where id='d1' and scope_id=$1",
            [a, b],
          ),
        ),
      );
      expect(err.code).toBe("23514"); // enforce_row_quota immutability guard (BEFORE RLS)
    });

    it("isolates pro rows across scopes (RLS USING)", async () => {
      const a = await h.createUser();
      const b = await h.createUser();
      await makePro(b);
      await h.asUser(b, (c) =>
        c.query(
          "insert into public.temporal_messages (id, scope_id) values ('tb',$1)",
          [b],
        ),
      );
      const seen = await h.asUser(a, (c) =>
        c.query(
          "select count(*)::int as n from public.temporal_messages where scope_id=$1",
          [b],
        ),
      );
      expect(seen.rows[0].n).toBe(0); // RLS hides b's rows from a
    });

    it("caps distillations inserts at the pro row cap (generic id-key probe → 23514)", async () => {
      const a = await h.createUser();
      await makePro(a);
      await setProRowCap("distillations", 2);
      const ins = (id: string) =>
        h.asUser(a, (c) =>
          c.query(
            "insert into public.distillations (id, scope_id) values ($1,$2)",
            [id, a],
          ),
        );
      await ins("d1");
      await ins("d2");
      const err = await expectError(() => ins("d3"));
      expect(err.code).toBe("23514"); // quota, NOT 42703 (undefined_column)
      expect(err.message).toMatch(/quota exceeded/i);
    });

    it("caps temporal_messages inserts at the pro byte cap (→ 23514)", async () => {
      const a = await h.createUser();
      await makePro(a);
      await setProByteCap("temporal_messages", 2000); // tiny budget, generous rows
      const ins = (id: string) =>
        h.asUser(a, (c) =>
          c.query(
            "insert into public.temporal_messages (id, scope_id, content) values ($1,$2,$3)",
            [id, a, "x".repeat(1200)],
          ),
        );
      await ins("t1"); // ~1.2 KB → fits under 2 KB
      const err = await expectError(() => ins("t2")); // ~2.4 KB → overflows
      expect(err.code).toBe("23514");
      expect(err.message).toMatch(/byte quota exceeded/i);
    });

    it("enforces the encrypted-column size CHECK on distillations (→ 23514)", async () => {
      const a = await h.createUser();
      await makePro(a);
      const err = await expectError(() =>
        h.asUser(a, (c) =>
          c.query(
            "insert into public.distillations (id, scope_id, content_hash) values ('d1',$1,$2)",
            [a, "x".repeat(65)], // > 64 → distillations_size_ck
          ),
        ),
      );
      expect(err.code).toBe("23514");
    });
  },
);
