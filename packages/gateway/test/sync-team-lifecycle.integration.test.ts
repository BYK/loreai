/**
 * Integration tests for migration 0029 — team lifecycle RPCs (E-4c, #827) against a real
 * Postgres. Proves the SECURITY DEFINER RPCs that create teams and manage membership:
 *  - create_team makes the caller org owner + scope admin;
 *  - a scope admin can add a member (who then READS the scope's content) and a non-member/editor
 *    cannot add/remove (role-gated);
 *  - removing a member revokes access and drops their DEK wrap;
 *  - the last admin cannot be removed or demoted (no orphaned scope);
 *  - invalid roles are rejected;
 *  - the shares_scope oracle is pinned to the caller (no probing arbitrary user pairs).
 *
 * Gated behind LORE_INTEGRATION=1 (needs Docker). Run:
 *   LORE_INTEGRATION=1 pnpm exec vitest run packages/gateway/test/sync-team-lifecycle.integration.test.ts
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

const createTeam = (uid: string, name: string) =>
  h.asUser(uid, (c) =>
    c
      .query("select public.create_team($1) as s", [name])
      .then((r) => r.rows[0].s as string),
  );
const addMember = (
  admin: string,
  scope: string,
  user: string,
  role = "editor",
) =>
  h.asUser(admin, (c) =>
    c.query("select public.add_scope_member($1,$2,$3)", [scope, user, role]),
  );
const removeMember = (admin: string, scope: string, user: string) =>
  h.asUser(admin, (c) =>
    c.query("select public.remove_scope_member($1,$2)", [scope, user]),
  );
const setRole = (admin: string, scope: string, user: string, role: string) =>
  h.asUser(admin, (c) =>
    c.query("select public.set_scope_role($1,$2,$3)", [scope, user, role]),
  );
const addKnowledge = (uid: string, scope: string, id: string) =>
  h.asUser(uid, (c) =>
    c.query(
      "insert into public.knowledge (id, scope_id, category, title, content) values ($1,$2,'p','T','C')",
      [id, scope],
    ),
  );
const seesKnowledge = (uid: string) =>
  h.asUser(uid, (c) =>
    c.query("select id from public.knowledge").then((r) => r.rowCount),
  );

describe.skipIf(gate())("0029 team lifecycle RPCs (E-4c, #827)", () => {
  it("create_team makes the caller org owner + scope admin", async () => {
    const a = await h.createUser();
    const scope = await createTeam(a, "Team A");
    const [s, sm, om] = await Promise.all([
      h.client
        .query("select kind, org_id from public.scopes where id=$1", [scope])
        .then((r) => r.rows[0]),
      h.client
        .query(
          "select role from public.scope_members where scope_id=$1 and user_id=$2",
          [scope, a],
        )
        .then((r) => r.rows[0]),
      h.client
        .query(
          "select o.kind, o.owner_user_id, m.role from public.orgs o join public.org_members m on m.org_id=o.id where o.id=(select org_id from public.scopes where id=$1) and m.user_id=$2",
          [scope, a],
        )
        .then((r) => r.rows[0]),
    ]);
    expect(s.kind).toBe("team");
    expect(sm.role).toBe("admin"); // creator is the scope admin
    expect(om.kind).toBe("team");
    expect(om.owner_user_id).toBe(a);
    expect(om.role).toBe("owner"); // creator is the org owner
  });

  it("an admin adds a member who can then read the scope's content; a non-member cannot", async () => {
    const a = await h.createUser();
    const b = await h.createUser();
    const c = await h.createUser();
    const scope = await createTeam(a, "Team B");
    await addKnowledge(a, scope, "k1");
    expect(await seesKnowledge(b)).toBe(0); // not a member yet
    await addMember(a, scope, b, "editor");
    expect(await seesKnowledge(b)).toBe(1); // membership grants FETCH (RLS is_member)
    expect(await seesKnowledge(c)).toBe(0); // an unrelated user still sees nothing
    // The new member is also an org member (plain 'member').
    expect(
      await h.client
        .query(
          "select role from public.org_members where org_id=(select org_id from public.scopes where id=$1) and user_id=$2",
          [scope, b],
        )
        .then((r) => r.rows[0].role),
    ).toBe("member");
  });

  it("only an admin can add or remove members", async () => {
    const a = await h.createUser();
    const b = await h.createUser();
    const d = await h.createUser();
    const scope = await createTeam(a, "Team C");
    await addMember(a, scope, b, "editor");
    // An editor cannot add or remove.
    expect((await expectError(() => addMember(b, scope, d))).code).toBe(
      "42501",
    );
    expect((await expectError(() => removeMember(b, scope, a))).code).toBe(
      "42501",
    );
    // A total non-member cannot either (scope_role → null → not 'admin').
    expect((await expectError(() => addMember(d, scope, b))).code).toBe(
      "42501",
    );
  });

  it("removing a member revokes access and drops their DEK wrap", async () => {
    const a = await h.createUser();
    const b = await h.createUser();
    const scope = await createTeam(a, "Team D");
    await addMember(a, scope, b, "editor");
    await addKnowledge(a, scope, "k1");
    // Admin group-wraps a DEK to B (cross-member insert, NO returning — the E-3a constraint).
    await h.asUser(a, (cl) =>
      cl.query(
        "insert into public.scope_keys (scope_id, member_user_id, wrapped_dek) values ($1,$2,'ZGVr')",
        [scope, b],
      ),
    );
    expect(await seesKnowledge(b)).toBe(1);
    await removeMember(a, scope, b);
    expect(await seesKnowledge(b)).toBe(0); // access revoked
    expect(
      await h.client
        .query(
          "select 1 from public.scope_keys where scope_id=$1 and member_user_id=$2",
          [scope, b],
        )
        .then((r) => r.rowCount),
    ).toBe(0); // wrap dropped
  });

  it("dropping a member from their only scope removes their org membership, but not while they remain in another scope of the org", async () => {
    const a = await h.createUser();
    const b = await h.createUser();
    const scope = await createTeam(a, "Team J");
    const org = await h.client
      .query("select org_id from public.scopes where id=$1", [scope])
      .then((r) => r.rows[0].org_id as string);
    // A second team scope under the SAME org (out-of-band via superuser), a=admin, b=editor.
    const scope2 = await h.client
      .query(
        "insert into public.scopes (org_id, kind, name) values ($1,'team','J2') returning id",
        [org],
      )
      .then((r) => r.rows[0].id as string);
    await h.client.query(
      "insert into public.scope_members (scope_id, user_id, role) values ($1,$2,'admin'),($1,$3,'editor')",
      [scope2, a, b],
    );
    await addMember(a, scope, b, "editor"); // also makes b an org member
    const orgRows = () =>
      h.client
        .query(
          "select 1 from public.org_members where org_id=$1 and user_id=$2",
          [org, b],
        )
        .then((r) => r.rowCount);
    // Removed from scope 1 but still in scope 2 → keeps org membership.
    await removeMember(a, scope, b);
    expect(await orgRows()).toBe(1);
    // Removed from the last remaining scope → org membership dropped.
    await removeMember(a, scope2, b);
    expect(await orgRows()).toBe(0);
  });

  it("cannot remove or demote the last admin of a scope", async () => {
    const a = await h.createUser();
    const scope = await createTeam(a, "Team E");
    expect((await expectError(() => removeMember(a, scope, a))).code).toBe(
      "23514",
    );
    expect((await expectError(() => setRole(a, scope, a, "editor"))).code).toBe(
      "23514",
    );
    // With a second admin, demoting the first is allowed.
    const b = await h.createUser();
    await addMember(a, scope, b, "admin");
    await setRole(a, scope, a, "editor"); // now b is the remaining admin
    expect(
      await h.client
        .query(
          "select role from public.scope_members where scope_id=$1 and user_id=$2",
          [scope, a],
        )
        .then((r) => r.rows[0].role),
    ).toBe("editor");
  });

  it("cannot demote the last admin via add_scope_member's re-role path (B1)", async () => {
    const a = await h.createUser();
    const scope = await createTeam(a, "Team H");
    // add_scope_member upserts an existing member's role — demoting the sole admin here must be
    // blocked exactly like set_scope_role, else the scope is left with 0 admins (unmanageable).
    expect(
      (await expectError(() => addMember(a, scope, a, "editor"))).code,
    ).toBe("23514");
  });

  it("add_scope_member defaults a new member to editor", async () => {
    const a = await h.createUser();
    const b = await h.createUser();
    const scope = await createTeam(a, "Team I");
    // Call the 2-arg form so the SQL default ('editor') is exercised (guards against drift).
    await h.asUser(a, (c) =>
      c.query("select public.add_scope_member($1,$2)", [scope, b]),
    );
    expect(
      await h.client
        .query(
          "select role from public.scope_members where scope_id=$1 and user_id=$2",
          [scope, b],
        )
        .then((r) => r.rows[0].role),
    ).toBe("editor");
  });

  it("rejects an invalid scope role", async () => {
    const a = await h.createUser();
    const b = await h.createUser();
    const scope = await createTeam(a, "Team F");
    expect(
      (await expectError(() => addMember(a, scope, b, "superuser"))).code,
    ).toBe("22023");
  });

  it("shares_scope is pinned to the caller (no probing arbitrary user pairs)", async () => {
    const a = await h.createUser();
    const b = await h.createUser();
    const x = await h.createUser();
    const scope = await createTeam(a, "Team G");
    await addMember(a, scope, b, "editor");
    // Self form (1-arg, p_uid defaults to auth.uid()) works for genuine co-members.
    expect(
      await h.asUser(b, (c) =>
        c
          .query("select public.shares_scope($1) as v", [a])
          .then((r) => r.rows[0].v),
      ),
    ).toBe(true);
    // An unrelated caller probing the a↔b pair (p_uid ≠ self) is pinned → false.
    expect(
      await h.asUser(x, (c) =>
        c
          .query("select public.shares_scope($1,$2) as v", [a, b])
          .then((r) => r.rows[0].v),
      ),
    ).toBe(false);
    // And a genuine non-co-member self query is honestly false.
    expect(
      await h.asUser(b, (c) =>
        c
          .query("select public.shares_scope($1) as v", [x])
          .then((r) => r.rows[0].v),
      ),
    ).toBe(false);
  });
});
