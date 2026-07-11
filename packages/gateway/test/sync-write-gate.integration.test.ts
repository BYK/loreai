/**
 * Integration tests for migration 0027 — per-verb write-gate (E-4a, #827) against a real
 * Postgres. Proves scope_role now gates writes while membership still gates reads:
 *  - a `viewer` can READ a scope's content but cannot INSERT/UPDATE/DELETE it;
 *  - an `editor` can write AND delete content in a scope they belong to;
 *  - DELETE is role-gated in its USING clause — a viewer cannot delete another member's row
 *    (the Seer HIGH on #1257: a `for all` policy let any member delete any member's rows);
 *  - behavior-preserving for a personal scope (owner = admin → full read/write/delete);
 *  - sync_device_progress swaps to is_member (any member, incl. viewer, records its cursor).
 *
 * Gated behind LORE_INTEGRATION=1 (needs Docker). Run:
 *   LORE_INTEGRATION=1 pnpm exec vitest run packages/gateway/test/sync-write-gate.integration.test.ts
 */
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
beforeAll(async () => {
  if (!SKIP) h = await startPgHarness();
}, 180_000);
afterAll(async () => {
  if (h) await h.stop();
});
const gate = () => SKIP;

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

// Seed a knowledge row owned+authored by `owner` — inserted AS the owner (an admin of their
// own scope), not via the superuser client: a bare-superuser INSERT fires enforce_row_quota,
// whose auth.uid() would parse an empty request.jwt.claims GUC and 22P02 (harness quirk).
const seedKnowledge = (owner: string, id: string) =>
  h.asUser(owner, (c) =>
    c.query(
      "insert into public.knowledge (id, category, title, content) values ($1,'p','T','C')",
      [id],
    ),
  );
const addMember = (scope: string, user: string, role: string) =>
  h.client.query(
    "insert into public.scope_members (scope_id, user_id, role) values ($1,$2,$3)",
    [scope, user, role],
  );
const countKnowledge = (uid: string) =>
  h.asUser(uid, (c) =>
    c.query("select id from public.knowledge").then((r) => r.rowCount),
  );

describe.skipIf(gate())("0027 per-verb write-gate (E-4a, #827)", () => {
  it("a viewer can READ but cannot INSERT/UPDATE/DELETE content", async () => {
    const a = await h.createUser();
    const b = await h.createUser();
    await addMember(a, b, "viewer");
    await seedKnowledge(a, "kv");
    // READ: the viewer sees the scope's content.
    expect(await countKnowledge(b)).toBe(1);
    // INSERT: rejected by WITH CHECK (scope_role = 'viewer' ∉ {editor,admin}).
    const ins = await expectError(() =>
      h.asUser(b, (c) =>
        c.query(
          "insert into public.knowledge (id, scope_id, category, title, content) values ('kv2',$1,'p','T','C')",
          [a],
        ),
      ),
    );
    expect(ins.code).toBe("42501");
    // UPDATE: no row satisfies the viewer's USING → 0 rows changed (no error), content intact.
    const upd = await h.asUser(b, (c) =>
      c.query("update public.knowledge set content='HACKED' where id='kv'"),
    );
    expect(upd.rowCount).toBe(0); // role-gated USING excludes the row (not a silent mutate)
    // DELETE: likewise a no-op under the role-gated USING → the row survives (Seer #1257 fix).
    const del = await h.asUser(b, (c) =>
      c.query("delete from public.knowledge where id='kv'"),
    );
    expect(del.rowCount).toBe(0); // the core #1257 fix: DELETE USING is role-gated
    const row = await h.client
      .query("select content from public.knowledge where id='kv'")
      .then((r) => r.rows);
    expect(row).toHaveLength(1); // not deleted
    expect(row[0].content).toBe("C"); // not updated
  });

  it("an editor can WRITE and DELETE content in a scope they belong to", async () => {
    const a = await h.createUser();
    const b = await h.createUser();
    await addMember(a, b, "editor");
    // INSERT into A's scope, authored by B (editor).
    await h.asUser(b, (c) =>
      c.query(
        "insert into public.knowledge (id, scope_id, category, title, content) values ('ke',$1,'p','T','C')",
        [a],
      ),
    );
    expect(await countKnowledge(a)).toBe(1); // owner sees the editor's contribution
    // DELETE a row authored by the OWNER (editors manage the scope's content).
    await seedKnowledge(a, "ko");
    await h.asUser(b, (c) =>
      c.query("delete from public.knowledge where id='ko'"),
    );
    expect(
      await h.client
        .query("select 1 from public.knowledge where id='ko'")
        .then((r) => r.rowCount),
    ).toBe(0);
  });

  it("behavior-preserving: a personal-scope owner (admin) reads, writes, and deletes own", async () => {
    const a = await h.createUser();
    await h.asUser(a, (c) =>
      c.query(
        "insert into public.knowledge (id, category, title, content) values ('ka','p','T','C')",
      ),
    );
    await h.asUser(a, (c) =>
      c.query("update public.knowledge set content='C2' where id='ka'"),
    );
    expect(await countKnowledge(a)).toBe(1);
    await h.asUser(a, (c) =>
      c.query("delete from public.knowledge where id='ka'"),
    );
    expect(await countKnowledge(a)).toBe(0);
  });

  it("an editor at FREE tier cannot INSERT a pro distillation (tier gate fires independent of role)", async () => {
    // Discriminates the effective_tier='pro' gate from the scope_role gate: B passes the role
    // gate (editor) but the scope is free tier, so only the tier gate can reject.
    const a = await h.createUser(); // free tier (default)
    const b = await h.createUser();
    await addMember(a, b, "editor");
    const err = await expectError(() =>
      h.asUser(b, (c) =>
        c.query(
          "insert into public.distillations (id, scope_id) values ('df',$1)",
          [a],
        ),
      ),
    );
    expect(err.code).toBe("42501");
  });

  it("a viewer cannot INSERT a pro distillation (scope_role gate fires before tier)", async () => {
    const a = await h.createUser();
    const b = await h.createUser();
    await h.asService((c) =>
      c.query("update public.profiles set tier='pro' where id=$1", [a]),
    );
    await addMember(a, b, "viewer");
    const err = await expectError(() =>
      h.asUser(b, (c) =>
        c.query(
          "insert into public.distillations (id, scope_id) values ('dv',$1)",
          [a],
        ),
      ),
    );
    expect(err.code).toBe("42501");
  });

  it("sync_device_progress: a member (even a viewer) records progress; a non-member cannot", async () => {
    const a = await h.createUser();
    const b = await h.createUser();
    const c = await h.createUser();
    await addMember(a, b, "viewer");
    // viewer B may record a pull cursor for A's scope (is_member, no role gate).
    await h.asUser(b, (cl) =>
      cl.query(
        "insert into public.sync_device_progress (scope_id, device_id, table_name, pulled_through) values ($1,'devB','knowledge', now())",
        [a],
      ),
    );
    // non-member C cannot.
    const err = await expectError(() =>
      h.asUser(c, (cl) =>
        cl.query(
          "insert into public.sync_device_progress (scope_id, device_id, table_name, pulled_through) values ($1,'devC','knowledge', now())",
          [a],
        ),
      ),
    );
    expect(err.code).toBe("42501");
  });
});
