/**
 * Integration tests for migration 0035 — GitHub Teams provisioning (E-5-a, #827) against a real
 * Postgres. Proves the SERVICE-ROLE-ONLY provisioning RPC that mirrors a user's GitHub org/team
 * memberships into Lore orgs/scopes:
 *  - creates the org + scope keyed by GitHub numeric id, with the mapped roles;
 *  - is idempotent (re-running produces no duplicates);
 *  - converges by GitHub id (two users → one shared scope);
 *  - is additive + NEVER-demote (a re-sync as a lower role leaves an existing admin untouched);
 *  - is SERVICE-ROLE-ONLY (an authenticated client cannot call it → cannot forge memberships);
 *  - skips a team whose org was not provisioned (defensive).
 *
 * Gated behind LORE_INTEGRATION=1 (needs Docker). Run:
 *   LORE_INTEGRATION=1 pnpm exec vitest run packages/gateway/test/sync-github-provision.integration.test.ts
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

type OrgIn = {
  github_org_id: number;
  login: string;
  role: "manager" | "member";
};
type TeamIn = {
  github_team_id: number;
  github_org_id: number;
  slug: string;
  name: string;
  role: "admin" | "editor";
};

const provision = (uid: string, orgs: OrgIn[], teams: TeamIn[]) =>
  h.asService((c) =>
    c.query(
      "select public.provision_github_membership($1, $2::jsonb, $3::jsonb)",
      [uid, JSON.stringify(orgs), JSON.stringify(teams)],
    ),
  );

const orgRow = (gid: number) =>
  h.client
    .query(
      "select id, kind, owner_user_id, name from public.orgs where github_org_id=$1",
      [gid],
    )
    .then((r) => r.rows[0]);
const scopeRow = (gid: number) =>
  h.client
    .query(
      "select id, org_id, kind, name from public.scopes where github_team_id=$1",
      [gid],
    )
    .then((r) => r.rows[0]);
const orgRole = (org: string, uid: string) =>
  h.client
    .query(
      "select role from public.org_members where org_id=$1 and user_id=$2",
      [org, uid],
    )
    .then((r) => r.rows[0]?.role as string | undefined);
const scopeRole = (scope: string, uid: string) =>
  h.client
    .query(
      "select role from public.scope_members where scope_id=$1 and user_id=$2",
      [scope, uid],
    )
    .then((r) => r.rows[0]?.role as string | undefined);

describe.skipIf(gate())("0035 GitHub provisioning (E-5-a, #827)", () => {
  it("provisions an org + scope keyed by GitHub id, with the mapped roles", async () => {
    const a = await h.createUser();
    await provision(
      a,
      [{ github_org_id: 100, login: "acme", role: "manager" }],
      [
        {
          github_team_id: 200,
          github_org_id: 100,
          slug: "eng",
          name: "Engineering",
          role: "admin",
        },
      ],
    );
    const org = await orgRow(100);
    expect(org.kind).toBe("team");
    expect(org.owner_user_id).toBe(a);
    expect(org.name).toBe("acme");
    const scope = await scopeRow(200);
    expect(scope.org_id).toBe(org.id);
    expect(scope.name).toBe("Engineering");
    expect(await orgRole(org.id, a)).toBe("manager");
    expect(await scopeRole(scope.id, a)).toBe("admin");
  });

  it("is idempotent — re-running produces no duplicate orgs/scopes/memberships", async () => {
    const a = await h.createUser();
    const orgs: OrgIn[] = [
      { github_org_id: 101, login: "beta", role: "member" },
    ];
    const teams: TeamIn[] = [
      {
        github_team_id: 201,
        github_org_id: 101,
        slug: "ops",
        name: "Ops",
        role: "editor",
      },
    ];
    await provision(a, orgs, teams);
    await provision(a, orgs, teams);
    const orgs2 = await h.client.query(
      "select id from public.orgs where github_org_id=101",
    );
    const scopes2 = await h.client.query(
      "select id from public.scopes where github_team_id=201",
    );
    expect(orgs2.rowCount).toBe(1);
    expect(scopes2.rowCount).toBe(1);
    const scope = await scopeRow(201);
    const members = await h.client.query(
      "select count(*)::int n from public.scope_members where scope_id=$1 and user_id=$2",
      [scope.id, a],
    );
    expect(members.rows[0].n).toBe(1);
  });

  it("converges by GitHub id — two users map to ONE shared scope", async () => {
    const a = await h.createUser();
    const b = await h.createUser();
    await provision(
      a,
      [{ github_org_id: 102, login: "gamma", role: "manager" }],
      [
        {
          github_team_id: 202,
          github_org_id: 102,
          slug: "core",
          name: "Core",
          role: "admin",
        },
      ],
    );
    await provision(
      b,
      [{ github_org_id: 102, login: "gamma", role: "member" }],
      [
        {
          github_team_id: 202,
          github_org_id: 102,
          slug: "core",
          name: "Core",
          role: "editor",
        },
      ],
    );
    const orgs = await h.client.query(
      "select id from public.orgs where github_org_id=102",
    );
    const scopes = await h.client.query(
      "select id from public.scopes where github_team_id=202",
    );
    expect(orgs.rowCount).toBe(1); // one org
    expect(scopes.rowCount).toBe(1); // one scope, shared
    const scope = await scopeRow(202);
    expect(await scopeRole(scope.id, a)).toBe("admin");
    expect(await scopeRole(scope.id, b)).toBe("editor");
  });

  it("is additive + never-demote — a re-sync as a lower role leaves an admin untouched", async () => {
    const a = await h.createUser();
    await provision(
      a,
      [{ github_org_id: 103, login: "delta", role: "manager" }],
      [
        {
          github_team_id: 203,
          github_org_id: 103,
          slug: "sec",
          name: "Sec",
          role: "admin",
        },
      ],
    );
    // A subsequent sync reports the user as only a plain member/editor — must NOT demote.
    await provision(
      a,
      [{ github_org_id: 103, login: "delta", role: "member" }],
      [
        {
          github_team_id: 203,
          github_org_id: 103,
          slug: "sec",
          name: "Sec",
          role: "editor",
        },
      ],
    );
    const org = await orgRow(103);
    const scope = await scopeRow(203);
    expect(await orgRole(org.id, a)).toBe("manager"); // unchanged
    expect(await scopeRole(scope.id, a)).toBe("admin"); // unchanged
  });

  it("is SERVICE-ROLE-ONLY — an authenticated client cannot call it (no forging)", async () => {
    const a = await h.createUser();
    const err = await expectError(() =>
      h.asUser(a, (c) =>
        c.query(
          "select public.provision_github_membership($1, '[]'::jsonb, '[]'::jsonb)",
          [a],
        ),
      ),
    );
    // permission denied for function (execute revoked from authenticated)
    expect(err.code).toBe("42501");
  });

  it("skips a team whose org was not provisioned (defensive)", async () => {
    const a = await h.createUser();
    await provision(
      a,
      [], // no orgs provided
      [
        {
          github_team_id: 204,
          github_org_id: 104,
          slug: "x",
          name: "X",
          role: "editor",
        },
      ],
    );
    const scopes = await h.client.query(
      "select id from public.scopes where github_team_id=204",
    );
    expect(scopes.rowCount).toBe(0); // scope not created without its org
  });
});
