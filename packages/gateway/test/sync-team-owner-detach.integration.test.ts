/**
 * Integration tests for migration 0047 — team-org ownership survives its provisioner's account
 * deletion (#1314 part 1, E-5-a durability). Against a real Postgres with FKs/triggers enforced.
 *
 * Proves:
 *  - Deleting a TEAM org's owner (the arbitrary provisioner) DETACHES the org (owner_user_id → NULL)
 *    and leaves the org + its scope + its content INTACT for the remaining members (the fix — under
 *    the old ON DELETE CASCADE this wiped the whole team).
 *  - Deleting a PERSONAL org's owner still hard-removes the personal org → scope → content (behavior
 *    preserved, now via the BEFORE DELETE trigger rather than the FK cascade).
 *
 * Gated behind LORE_INTEGRATION=1 (needs Docker). Run:
 *   LORE_INTEGRATION=1 pnpm exec vitest run packages/gateway/test/sync-team-owner-detach.integration.test.ts
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

describe.skipIf(gate())(
  "migration 0047 — team-org owner detach on account deletion (#1314)",
  () => {
    it("detaches a team org (owner→NULL) and preserves its scope + content when the owner is deleted", async () => {
      // Owner provisions a team; a second member joins and content lands in the team scope.
      const owner = await h.createUser("owner@acme.dev");
      const member = await h.createUser("member@acme.dev");
      const scope = await h.asUser(owner, (c) =>
        c
          .query("select public.create_team($1) s", ["Rockets"])
          .then((r) => r.rows[0].s),
      );
      await h.asUser(owner, (c) =>
        c.query("select public.add_scope_member($1,$2,'editor')", [
          scope,
          member,
        ]),
      );
      const orgId = (
        await h.client.query("select org_id from public.scopes where id=$1", [
          scope,
        ])
      ).rows[0].org_id;
      // Content in the TEAM scope (author = member, so it does not ride the owner's cascade path).
      await h.asUser(member, (c) =>
        c.query(
          "insert into public.knowledge (id, scope_id, category, title, content) values ('k-team',$1,'p','T','C')",
          [scope],
        ),
      );

      // Delete the org's owner/provisioner.
      await h.client.query("delete from auth.users where id=$1", [owner]);

      // The team org SURVIVES, now detached (owner_user_id → NULL).
      const org = (
        await h.client.query(
          "select owner_user_id, kind from public.orgs where id=$1",
          [orgId],
        )
      ).rows;
      expect(org).toHaveLength(1);
      expect(org[0].kind).toBe("team");
      expect(org[0].owner_user_id).toBeNull();
      // Its scope and content survive for the remaining member.
      expect(
        (
          await h.client.query("select 1 from public.scopes where id=$1", [
            scope,
          ])
        ).rowCount,
      ).toBe(1);
      expect(
        (
          await h.client.query(
            "select 1 from public.knowledge where id='k-team'",
          )
        ).rowCount,
      ).toBe(1);
      // The remaining member's own membership row is intact.
      expect(
        (
          await h.client.query(
            "select role from public.scope_members where scope_id=$1 and user_id=$2",
            [scope, member],
          )
        ).rows[0]?.role,
      ).toBe("editor");
    });

    it("still hard-removes a personal org → scope → content when its owner is deleted (behavior preserved)", async () => {
      const uid = await h.createUser("personal@acme.dev");
      // Personal scope id == user id (E-1). Insert content into it.
      await h.asUser(uid, (c) =>
        c.query(
          "insert into public.knowledge (id, category, title, content) values ('k-personal','p','T','C')",
        ),
      );
      await h.client.query("delete from auth.users where id=$1", [uid]);

      // The personal org, its scope, and its content are all gone (cascade via the BEFORE DELETE
      // trigger — same outcome as the old FK cascade).
      expect(
        (
          await h.client.query(
            "select 1 from public.orgs where owner_user_id=$1 and kind='personal'",
            [uid],
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (await h.client.query("select 1 from public.scopes where id=$1", [uid]))
          .rowCount,
      ).toBe(0);
      expect(
        (
          await h.client.query(
            "select 1 from public.knowledge where id='k-personal'",
          )
        ).rowCount,
      ).toBe(0);
    });
  },
);
