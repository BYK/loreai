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

/** Free-tier defaults (mirror supabase/migrations/0003) — restored after quota tests. */
const FREE_LIMITS: Record<string, number> = {
  knowledge: 500,
  entities: 30,
  entity_aliases: 300,
  entity_relations: 300,
  knowledge_entity_refs: 2000,
};

// Mirrors the free-tier max_bytes seeded in 0007_scope_seam.sql — used to restore
// byte caps in afterEach so setByteCap() mutations never leak across tests.
const FREE_BYTE_LIMITS: Record<string, number> = {
  knowledge: 8388608,
  entities: 1048576,
  entity_aliases: 2097152,
  entity_relations: 2097152,
  knowledge_entity_refs: 1048576,
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
