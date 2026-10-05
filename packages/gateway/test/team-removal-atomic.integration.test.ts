/**
 * Integration coverage for migration 0054's atomic member removal and key rotation.
 * Gated behind LORE_INTEGRATION=1 (needs Docker).
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

const setRole = (admin: string, scope: string, user: string, role: string) =>
  h.asUser(admin, (client) =>
    client.query("select public.set_scope_role($1, $2, $3)", [
      scope,
      user,
      role,
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
  const [membership, epoch, keyCount, inviteCount] = await Promise.all([
    h.client
      .query(
        "select role from public.scope_members where scope_id=$1 and user_id=$2",
        [scope, target],
      )
      .then((result) => result.rows[0]?.role ?? null),
    h.client
      .query("select key_epoch from public.scopes where id=$1", [scope])
      .then((result) => result.rows[0]?.key_epoch ?? null),
    h.client
      .query(
        "select count(*)::int as count from public.scope_keys where scope_id=$1",
        [scope],
      )
      .then((result) => result.rows[0].count as number),
    h.client
      .query(
        "select count(*)::int as count from public.pending_invites where scope_id=$1",
        [scope],
      )
      .then((result) => result.rows[0].count as number),
  ]);
  return { membership, epoch, keyCount, inviteCount };
}

async function remove(
  caller: string,
  scope: string,
  target: string,
  expectedEpoch: number,
  wraps: unknown,
) {
  return h.asUser(caller, (client) =>
    client.query(
      "select public.remove_scope_member_rotating($1, $2, $3, $4::jsonb) as epoch",
      [scope, target, expectedEpoch, JSON.stringify(wraps)],
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

describe.skipIf(SKIP)(
  "0054 atomic scope-member removal and key rotation",
  () => {
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
        remove(fixture.owner, fixture.scope, fixture.target, 99, [
          wrap(fixture.owner),
          wrap(fixture.secondAdmin),
        ]),
      );
      expect(error.code).toBe("40001");
      expect(error.message).toContain("team key changed concurrently; retry");
      expect(await snapshot(fixture.scope, fixture.target)).toEqual(before);
    });

    it("protects last-admin self-removal and demotion with the specified messages", async () => {
      const admin = await h.createUser();
      const scope = await createTeam(admin);
      const before = await snapshot(scope, admin);
      const removalError = await expectPgError(() =>
        remove(admin, scope, admin, 0, []),
      );
      expect(removalError.code).toBe("23514");
      expect(removalError.message).toContain(
        "cannot remove the last admin; promote another member to admin first",
      );

      const demotionError = await expectPgError(() =>
        setRole(admin, scope, admin, "editor"),
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

      const result = await remove(leaver, scope, leaver, 0, [
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

    it("returns 42501 for a non-admin and P0002 for a missing target", async () => {
      const owner = await h.createUser();
      const editor = await h.createUser();
      const scope = await createTeam(owner);
      await addMember(owner, scope, editor, "editor");
      await addInvite(owner, scope);
      const missing = await h.createUser();

      const ownerBefore = await snapshot(scope, owner);
      const nonAdminError = await expectPgError(() =>
        remove(editor, scope, owner, 0, [wrap(editor)]),
      );
      expect(nonAdminError.code).toBe("42501");
      expect(await snapshot(scope, owner)).toEqual(ownerBefore);

      const missingBefore = await snapshot(scope, missing);
      const missingError = await expectPgError(() =>
        remove(owner, scope, missing, 0, [wrap(owner)]),
      );
      expect(missingError.code).toBe("P0002");
      expect(await snapshot(scope, missing)).toEqual(missingBefore);
    });
  },
);
