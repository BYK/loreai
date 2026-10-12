/**
 * Integration coverage for atomic team-role updates, member removal, and key rotation.
 * Gated behind LORE_INTEGRATION=1 (needs Docker).
 */
import { execFileSync } from "node:child_process";
import type { Client } from "pg";
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

async function expectPgError(
  fn: () => Promise<unknown>,
): Promise<{ code?: string; message: string }> {
  try {
    await fn();
  } catch (error) {
    return {
      code: (error as { code?: string }).code,
      message: (error as Error).message,
    };
  }
  throw new Error("expected the query to fail");
}

const createTeam = async (admin: string) =>
  h.asUser(admin, (client) =>
    client
      .query("select public.create_team($1) as scope", ["Atomic removal"])
      .then((result) => result.rows[0].scope as string),
  );

const addMember = (admin: string, scope: string, user: string, role: string) =>
  h.asUser(admin, (client) =>
    client.query("select public.add_scope_member($1, $2, $3)", [
      scope,
      user,
      role,
    ]),
  );

const setRole = (
  admin: string,
  scope: string,
  user: string,
  role: string,
  expectedRole: string,
) =>
  h.asUser(admin, (client) =>
    client.query("select public.set_scope_role($1, $2, $3, $4)", [
      scope,
      user,
      role,
      expectedRole,
    ]),
  );

const publishKey = (user: string) =>
  h.asUser(user, (client) =>
    client.query("insert into public.identity_pub (public_key) values ($1)", [
      Buffer.alloc(32, 1),
    ]),
  );

const addInvite = (admin: string, scope: string) =>
  h.asUser(admin, (client) =>
    client.query("select public.create_scope_invite($1, 'editor')", [scope]),
  );

async function seedScopeKeys(
  scope: string,
  admin: string,
  members: string[],
): Promise<void> {
  await h.asUser(admin, async (client) => {
    for (const user of members) {
      await client.query(
        `insert into public.scope_keys
           (scope_id, author_id, member_user_id, wrapped_dek, key_epoch)
         values ($1, $2, $3, 'prior-wrap', 0)`,
        [scope, admin, user],
      );
    }
  });
}

async function snapshot(scope: string, target: string) {
  const { rows } = await h.client.query(
    `select
       (select role from public.scope_members where scope_id = $1 and user_id = $2) as membership,
       (select key_epoch from public.scopes where id = $1) as epoch,
       (select count(*)::int from public.scope_keys where scope_id = $1) as key_count,
       (select count(*)::int from public.pending_invites where scope_id = $1) as invite_count`,
    [scope, target],
  );
  const row = rows[0] as {
    membership: string | null;
    epoch: number | null;
    key_count: number;
    invite_count: number;
  };
  return {
    membership: row.membership,
    epoch: row.epoch,
    keyCount: row.key_count,
    inviteCount: row.invite_count,
  };
}

async function remove(
  caller: string,
  scope: string,
  target: string,
  expectedEpoch: number,
  expectedRole: "admin" | "editor" | "viewer",
  wraps: unknown,
) {
  return h.asUser(caller, (client) =>
    client.query(
      "select public.remove_scope_member_rotating($1, $2, $3, $4, $5::jsonb) as epoch",
      [scope, target, expectedEpoch, expectedRole, JSON.stringify(wraps)],
    ),
  );
}

async function makeRemovalFixture() {
  const owner = await h.createUser();
  const secondAdmin = await h.createUser();
  const target = await h.createUser();
  const scope = await createTeam(owner);
  await addMember(owner, scope, secondAdmin, "admin");
  await addMember(owner, scope, target, "viewer");
  await publishKey(owner);
  await publishKey(secondAdmin);
  await publishKey(target);
  await seedScopeKeys(scope, owner, [owner, secondAdmin, target]);
  await addInvite(owner, scope);
  return { owner, secondAdmin, target, scope };
}

const wrap = (memberUserId: string, wrappedDek = "next-wrap") => ({
  member_user_id: memberUserId,
  wrapped_dek: wrappedDek,
});

async function configureGithubTeam(scope: string) {
  const githubOrgId = Number.parseInt(
    scope.replaceAll("-", "").slice(0, 8),
    16,
  );
  const githubTeamId = githubOrgId + 1;
  const githubLogin = `atomic-${githubOrgId}`;
  const githubTeamSlug = `atomic-${githubTeamId}`;
  await h.client.query(
    `update public.orgs
        set github_org_id = $2, github_login = $3
      where id = (select org_id from public.scopes where id = $1)`,
    [scope, githubOrgId, githubLogin],
  );
  await h.client.query(
    `update public.scopes
        set github_team_id = $2, github_team_slug = $3
      where id = $1`,
    [scope, githubTeamId, githubTeamSlug],
  );
  return { githubOrgId, githubTeamId, githubLogin, githubTeamSlug };
}

async function raceGithubAdminPromotion(
  fixture: Awaited<ReturnType<typeof makeRemovalFixture>>,
  github: Awaited<ReturnType<typeof configureGithubTeam>>,
  mutation: (client: Client) => Promise<unknown>,
): Promise<{ code?: string; message: string }> {
  const [serviceClient, userClient] = await Promise.all([
    h.connect(),
    h.connect(),
  ]);
  try {
    await serviceClient.query("begin");
    await serviceClient.query("set local role service_role");
    await serviceClient.query(
      "select set_config('request.jwt.claims', $1, true)",
      [JSON.stringify({ role: "service_role" })],
    );
    await serviceClient.query(
      "select public.provision_github_membership($1, $2::jsonb, $3::jsonb)",
      [
        fixture.target,
        JSON.stringify([
          {
            github_org_id: github.githubOrgId,
            login: github.githubLogin,
            role: "manager",
          },
        ]),
        JSON.stringify([
          {
            github_org_id: github.githubOrgId,
            github_team_id: github.githubTeamId,
            slug: github.githubTeamSlug,
            name: "Atomic removal",
            role: "admin",
          },
        ]),
      ],
    );

    await userClient.query("begin");
    await userClient.query("set local role authenticated");
    await userClient.query(
      "select set_config('request.jwt.claims', $1, true)",
      [JSON.stringify({ sub: fixture.owner, role: "authenticated" })],
    );
    const { rows } = await userClient.query("select pg_backend_pid() as pid");
    const pendingMutation = expectPgError(() => mutation(userClient)).then(
      (error) => ({ error }),
      (cause: unknown) => ({ cause }),
    );

    try {
      await expect
        .poll(
          async () => {
            const result = await h.client.query(
              "select wait_event_type from pg_stat_activity where pid = $1",
              [rows[0].pid],
            );
            return result.rows[0]?.wait_event_type ?? null;
          },
          { timeout: 5_000 },
        )
        .toBe("Lock");
      await serviceClient.query("commit");
      const outcome = await pendingMutation;
      if ("cause" in outcome) throw outcome.cause;
      return outcome.error;
    } finally {
      await serviceClient.query("rollback").catch(() => undefined);
      await pendingMutation;
      await userClient.query("rollback").catch(() => undefined);
    }
  } finally {
    await Promise.all([serviceClient.end(), userClient.end()]);
  }
}

type WrapFactory = (
  owner: string,
  secondAdmin: string,
  target: string,
) => unknown;

const invalidWraps: [string, WrapFactory][] = [
  ["malformed wrap arrays", () => ({ not: "an array" })],
  ["wraps missing required fields", (owner) => [{ member_user_id: owner }]],
  [
    "duplicate wrap targets",
    (owner, secondAdmin) => [
      wrap(owner),
      wrap(owner, "duplicate"),
      wrap(secondAdmin),
    ],
  ],
  [
    "disallowed wrap targets",
    (owner, secondAdmin, target) => [
      wrap(owner),
      wrap(secondAdmin),
      wrap(target),
    ],
  ],
  ["incomplete identity-key coverage", (owner) => [wrap(owner)]],
  [
    "invalid wrapped-DEK lengths",
    (owner, secondAdmin) => [wrap(owner), wrap(secondAdmin, "")],
  ],
  [
    "overlong wrapped-DEK lengths",
    (owner, secondAdmin) => [wrap(owner), wrap(secondAdmin, "x".repeat(4097))],
  ],
];

describe.skipIf(SKIP)("atomic scope-member removal and key rotation", () => {
  it.each(invalidWraps)(
    "rejects %s without mutating removal state",
    async (_name, makeWraps) => {
      const fixture = await makeRemovalFixture();
      const before = await snapshot(fixture.scope, fixture.target);
      const error = await expectPgError(() =>
        remove(
          fixture.owner,
          fixture.scope,
          fixture.target,
          0,
          "viewer",
          makeWraps(fixture.owner, fixture.secondAdmin, fixture.target),
        ),
      );
      expect(error.code).toBe("22023");
      expect(await snapshot(fixture.scope, fixture.target)).toEqual(before);
    },
  );

  it("rejects a stale epoch without changing membership, epoch, wraps, or invites", async () => {
    const fixture = await makeRemovalFixture();
    const before = await snapshot(fixture.scope, fixture.target);
    const error = await expectPgError(() =>
      remove(fixture.owner, fixture.scope, fixture.target, 99, "viewer", [
        wrap(fixture.owner),
        wrap(fixture.secondAdmin),
      ]),
    );
    expect(error.code).toBe("40001");
    expect(error.message).toContain("team key changed concurrently; retry");
    expect(await snapshot(fixture.scope, fixture.target)).toEqual(before);
  });

  it("rejects a non-admin's direct self-removal without changing team state", async () => {
    const fixture = await makeRemovalFixture();
    const before = await snapshot(fixture.scope, fixture.target);
    const error = await expectPgError(() =>
      remove(fixture.target, fixture.scope, fixture.target, 0, "viewer", [
        wrap(fixture.owner),
        wrap(fixture.secondAdmin),
      ]),
    );

    expect(error.code).toBe("42501");
    expect(await snapshot(fixture.scope, fixture.target)).toEqual(before);
  });

  it("rejects a stale expected role after a concurrent promotion", async () => {
    const fixture = await makeRemovalFixture();
    await setRole(
      fixture.owner,
      fixture.scope,
      fixture.target,
      "editor",
      "viewer",
    );
    const before = await snapshot(fixture.scope, fixture.target);
    const error = await expectPgError(() =>
      h.asUser(fixture.owner, (client) =>
        client.query(
          "select public.remove_scope_member_rotating($1, $2, $3, $4, $5::jsonb)",
          [
            fixture.scope,
            fixture.target,
            0,
            "viewer",
            JSON.stringify([wrap(fixture.owner), wrap(fixture.secondAdmin)]),
          ],
        ),
      ),
    );

    expect(error.code).toBe("P0001");
    expect(await snapshot(fixture.scope, fixture.target)).toEqual(before);
  });

  it("rejects a role update whose expected role changed after its read", async () => {
    const fixture = await makeRemovalFixture();

    // The first request reads this role before it pauses. A competing request then promotes the
    // target, so the first request's stale expected role must fail inside the role-update RPC.
    const observedRole = await h.client
      .query(
        "select role from public.scope_members where scope_id=$1 and user_id=$2",
        [fixture.scope, fixture.target],
      )
      .then((result) => result.rows[0].role as string);
    expect(observedRole).toBe("viewer");

    await setRole(
      fixture.owner,
      fixture.scope,
      fixture.target,
      "admin",
      observedRole,
    );
    const staleError = await expectPgError(() =>
      setRole(
        fixture.owner,
        fixture.scope,
        fixture.target,
        "viewer",
        observedRole,
      ),
    );

    expect(staleError.code).toBe("P0001");
    expect(await snapshot(fixture.scope, fixture.target)).toMatchObject({
      membership: "admin",
    });
  });

  it("serializes role updates against GitHub admin promotion", async () => {
    const fixture = await makeRemovalFixture();
    const github = await configureGithubTeam(fixture.scope);
    const error = await raceGithubAdminPromotion(fixture, github, (client) =>
      client.query("select public.set_scope_role($1, $2, 'editor', 'viewer')", [
        fixture.scope,
        fixture.target,
      ]),
    );

    expect(error.code).toBe("P0001");
    expect(error.message).toContain(
      "team member role changed; reload the team",
    );
    expect(await snapshot(fixture.scope, fixture.target)).toEqual({
      membership: "admin",
      epoch: 0,
      keyCount: 3,
      inviteCount: 1,
    });
  });

  it("serializes member removal against GitHub admin promotion", async () => {
    const fixture = await makeRemovalFixture();
    const github = await configureGithubTeam(fixture.scope);
    const error = await raceGithubAdminPromotion(fixture, github, (client) =>
      client.query(
        "select public.remove_scope_member_rotating($1, $2, 0, 'viewer', $3::jsonb)",
        [
          fixture.scope,
          fixture.target,
          JSON.stringify([wrap(fixture.owner), wrap(fixture.secondAdmin)]),
        ],
      ),
    );

    expect(error.code).toBe("P0001");
    expect(error.message).toContain(
      "team member role changed; reload the team",
    );
    expect(await snapshot(fixture.scope, fixture.target)).toEqual({
      membership: "admin",
      epoch: 0,
      keyCount: 3,
      inviteCount: 1,
    });
  });

  it("rejects role changes through the retired three-argument RPC", async () => {
    const fixture = await makeRemovalFixture();
    const error = await expectPgError(() =>
      h.asUser(fixture.owner, (client) =>
        client.query("select public.set_scope_role($1, $2, $3)", [
          fixture.scope,
          fixture.target,
          "admin",
        ]),
      ),
    );

    expect(error.code).toBe("42883");
    expect(await snapshot(fixture.scope, fixture.target)).toMatchObject({
      membership: "viewer",
    });
  });

  it("protects last-admin self-removal and demotion with the specified messages", async () => {
    const admin = await h.createUser();
    const scope = await createTeam(admin);
    const before = await snapshot(scope, admin);
    const removalError = await expectPgError(() =>
      remove(admin, scope, admin, 0, "admin", []),
    );
    expect(removalError.code).toBe("23514");
    expect(removalError.message).toContain(
      "cannot remove the last admin; promote another member to admin first",
    );

    const demotionError = await expectPgError(() =>
      setRole(admin, scope, admin, "editor", "admin"),
    );
    expect(demotionError.code).toBe("23514");
    expect(demotionError.message).toContain(
      "cannot demote the last admin; promote another member to admin first",
    );
    expect(await snapshot(scope, admin)).toEqual(before);
  });

  it("lets a non-owner admin leave atomically and removes their access and wraps", async () => {
    const owner = await h.createUser();
    const leaver = await h.createUser();
    const editor = await h.createUser();
    const scope = await createTeam(owner);
    await addMember(owner, scope, leaver, "admin");
    await addMember(owner, scope, editor, "editor");
    await publishKey(owner);
    await publishKey(leaver);
    await publishKey(editor);
    await seedScopeKeys(scope, owner, [owner, leaver, editor]);
    await addInvite(owner, scope);

    const result = await remove(leaver, scope, leaver, 0, "admin", [
      wrap(owner),
      wrap(editor),
    ]);
    expect(result.rows[0].epoch).toBe(1);
    const newWraps = await h.client
      .query(
        "select member_user_id, author_id, wrapped_dek from public.scope_keys where scope_id=$1 and key_epoch=1",
        [scope],
      )
      .then((response) => response.rows);
    expect(newWraps).toEqual(
      [editor, owner].sort().map((memberUserId) => ({
        member_user_id: memberUserId,
        author_id: leaver,
        wrapped_dek: "next-wrap",
      })),
    );
    expect(
      await h.client
        .query(
          "select count(*)::int as count from public.scope_keys where scope_id=$1 and member_user_id=$2",
          [scope, leaver],
        )
        .then((response) => response.rows[0].count),
    ).toBe(0);
    expect(
      await h.client
        .query(
          "select role from public.scope_members where scope_id=$1 and user_id=$2",
          [scope, leaver],
        )
        .then((response) => response.rows[0]?.role ?? null),
    ).toBeNull();
    expect(
      await h.client
        .query(
          "select count(*)::int as count from public.pending_invites where scope_id=$1",
          [scope],
        )
        .then((response) => response.rows[0].count),
    ).toBe(0);
    expect(
      await h.client
        .query(
          "select count(*)::int as count from public.org_members where org_id=(select org_id from public.scopes where id=$1) and user_id=$2",
          [scope, leaver],
        )
        .then((response) => response.rows[0].count),
    ).toBe(0);
    expect(
      await h.asUser(leaver, (client) =>
        client
          .query("select id from public.scopes where id=$1", [scope])
          .then((response) => response.rowCount),
      ),
    ).toBe(0);
  });

  it("rejects an editor attempting self-removal without changing team state", async () => {
    const owner = await h.createUser();
    const editor = await h.createUser();
    const viewer = await h.createUser();
    const scope = await createTeam(owner);
    await addMember(owner, scope, editor, "editor");
    await addMember(owner, scope, viewer, "viewer");
    await publishKey(owner);
    await publishKey(editor);
    await publishKey(viewer);
    await seedScopeKeys(scope, owner, [owner, editor, viewer]);

    const visibleMembers = await h.asUser(editor, (client) =>
      client.query(
        "select user_id from public.scope_members where scope_id=$1",
        [scope],
      ),
    );
    expect(
      visibleMembers.rows
        .map((row) => row.user_id)
        .sort((a, b) => a.localeCompare(b)),
    ).toEqual([owner, editor, viewer].sort((a, b) => a.localeCompare(b)));
    const visibleKey = await h.asUser(editor, (client) =>
      client.query(
        "select user_id, public_key from public.identity_pub where user_id=$1",
        [owner],
      ),
    );
    expect(visibleKey.rows).toHaveLength(1);
    expect(visibleKey.rows[0].user_id).toBe(owner);

    const before = await snapshot(scope, editor);
    const error = await expectPgError(() =>
      remove(editor, scope, editor, 0, "editor", [wrap(owner), wrap(viewer)]),
    );
    expect(error.code).toBe("42501");
    expect(await snapshot(scope, editor)).toEqual(before);
    expect(
      await h.client
        .query("select key_epoch from public.scopes where id=$1", [scope])
        .then((response) => response.rows[0].key_epoch),
    ).toBe(0);
  });

  it("rejects a viewer attempting self-removal without changing team state", async () => {
    const owner = await h.createUser();
    const viewer = await h.createUser();
    const editor = await h.createUser();
    const scope = await createTeam(owner);
    await addMember(owner, scope, viewer, "viewer");
    await addMember(owner, scope, editor, "editor");
    await publishKey(owner);
    await publishKey(viewer);
    await publishKey(editor);
    await seedScopeKeys(scope, owner, [owner, viewer, editor]);

    const before = await snapshot(scope, viewer);
    const error = await expectPgError(() =>
      remove(viewer, scope, viewer, 0, "viewer", [wrap(owner), wrap(editor)]),
    );
    expect(error.code).toBe("42501");
    expect(await snapshot(scope, viewer)).toEqual(before);
  });

  it("revokes direct execution of the old removal RPC", async () => {
    const admin = await h.createUser();
    const target = await h.createUser();
    const scope = await createTeam(admin);
    await addMember(admin, scope, target, "viewer");
    const error = await expectPgError(() =>
      h.asUser(admin, (client) =>
        client.query("select public.remove_scope_member($1, $2)", [
          scope,
          target,
        ]),
      ),
    );
    expect(error.code).toBe("42501");
  });

  it("returns 42501 when an editor removes someone else and P0002 for a missing target", async () => {
    const owner = await h.createUser();
    const editor = await h.createUser();
    const scope = await createTeam(owner);
    await addMember(owner, scope, editor, "editor");
    await addInvite(owner, scope);
    const missing = await h.createUser();

    const ownerBefore = await snapshot(scope, owner);
    const nonAdminError = await expectPgError(() =>
      remove(editor, scope, owner, 0, "admin", [wrap(editor)]),
    );
    expect(nonAdminError.code).toBe("42501");
    expect(await snapshot(scope, owner)).toEqual(ownerBefore);

    const missingBefore = await snapshot(scope, missing);
    const missingError = await expectPgError(() =>
      remove(owner, scope, missing, 0, "viewer", [wrap(owner)]),
    );
    expect(missingError.code).toBe("P0002");
    expect(await snapshot(scope, missing)).toEqual(missingBefore);
  });
});
