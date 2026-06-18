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
          "insert into public.knowledge (id, owner_user_id, category, title, content) values ('ka',$1,'p','T','secret-A')",
          [a],
        ),
      );
      const seen = await h.asUser(b, (c) =>
        c.query("select id from public.knowledge").then((r) => r.rows),
      );
      expect(seen).toHaveLength(0);
    });

    it("a user cannot forge owner_user_id on INSERT (WITH CHECK)", async () => {
      const a = await h.createUser();
      const victim = await h.createUser();
      const err = await expectError(() =>
        h.asUser(a, (c) =>
          c.query(
            "insert into public.knowledge (id, owner_user_id, category, title, content) values ('kf',$1,'p','T','C')",
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
          "insert into public.knowledge (id, owner_user_id, category, title, content) values ('kv',$1,'p','T','C')",
          [victim],
        ),
      );
      // steal: victim's row is invisible to A, so the UPDATE matches 0 rows.
      const stolen = await h.asUser(a, (c) =>
        c.query("update public.knowledge set owner_user_id=$1 where id='kv'", [
          a,
        ]),
      );
      expect(stolen.rowCount).toBe(0);
      // donate: A's own row re-parented to victim → WITH CHECK rejects.
      await h.asUser(a, (c) =>
        c.query(
          "insert into public.knowledge (id, owner_user_id, category, title, content) values ('ka2',$1,'p','T','C')",
          [a],
        ),
      );
      const err = await expectError(() =>
        h.asUser(a, (c) =>
          c.query(
            "update public.knowledge set owner_user_id=$1 where id='ka2'",
            [victim],
          ),
        ),
      );
      expect(err.code).toBe("42501");
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

  afterEach(async () => {
    if (gate()) return;
    for (const [table, n] of Object.entries(FREE_LIMITS)) {
      await h.client.query(
        "update public.plan_limits set max_rows=$1 where tier='free' and table_name=$2",
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
          "insert into public.entities (id, owner_user_id, entity_type, canonical_name) values ($1,$2,'tool','X')",
          [id, a],
        ),
      );
    await ins("e1");
    await ins("e2");
    const err = await expectError(() => ins("e3"));
    expect(err.code).toBe("23514"); // quota check_violation
    expect(err.message).toMatch(/quota exceeded/i);
  });

  it("blocks the un-tombstone bypass (revive past cap via UPDATE)", async () => {
    const a = await h.createUser();
    await setCap("entities", 2);
    const ins = (id: string) =>
      h.asUser(a, (c) =>
        c.query(
          "insert into public.entities (id, owner_user_id, entity_type, canonical_name) values ($1,$2,'tool','X')",
          [id, a],
        ),
      );
    await ins("z1");
    await ins("z2");
    await h.asUser(a, (c) =>
      c.query("update public.entities set is_deleted=true where id='z1'", []),
    );
    await ins("z3"); // fills the freed slot → 2 live
    const err = await expectError(() =>
      h.asUser(a, (c) =>
        c.query(
          "update public.entities set is_deleted=false where id='z1'",
          [],
        ),
      ),
    ); // reviving z1 → would be 3 live
    expect(err.code).toBe("23514");
    const live = await h.asUser(a, (c) =>
      c
        .query(
          "select count(*)::int n from public.entities where is_deleted=false",
        )
        .then((r) => r.rows[0].n),
    );
    expect(live).toBe(2);
  });

  it("at-cap users can still UPDATE / soft-delete existing rows", async () => {
    const a = await h.createUser();
    await setCap("entities", 1);
    await h.asUser(a, (c) =>
      c.query(
        "insert into public.entities (id, owner_user_id, entity_type, canonical_name) values ('u1',$1,'tool','a')",
        [a],
      ),
    );
    // upsert-as-update on the existing row (at cap) must succeed
    const upd = await h.asUser(a, (c) =>
      c.query(
        `insert into public.entities (id, owner_user_id, entity_type, canonical_name)
         values ('u1',$1,'tool','UPDATED')
         on conflict (owner_user_id, id) do update set canonical_name=excluded.canonical_name`,
        [a],
      ),
    );
    expect(upd.rowCount).toBe(1);
    // soft-delete frees the slot → a new insert is allowed
    await h.asUser(a, (c) =>
      c.query("update public.entities set is_deleted=true where id='u1'", []),
    );
    const ok = await h.asUser(a, (c) =>
      c.query(
        "insert into public.entities (id, owner_user_id, entity_type, canonical_name) values ('u2',$1,'tool','b')",
        [a],
      ),
    );
    expect(ok.rowCount).toBe(1);
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
              "insert into public.knowledge (id, owner_user_id, category, title, content) values ('big',$1,'p','T',$2)",
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
              "insert into public.entities (id, owner_user_id, entity_type, canonical_name) values ($1,$2,'tool','X')",
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
});
