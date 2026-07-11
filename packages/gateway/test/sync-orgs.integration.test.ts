/**
 * Integration tests for migration 0023 — Org → Scope registry (E-1, #827) against a real
 * Postgres with RLS/triggers/FKs enforced. Proves the registry is provisioned correctly and,
 * critically, that E-1 is BEHAVIOR-PRESERVING: every user gets a personal org/scope whose id
 * equals their user id (zero re-key), content stays isolated, and the auth.users-delete →
 * content cascade still reaches the same rows (now via orgs→scopes→content).
 *
 * Verification/setup uses h.client (the raw superuser connection, like the other integration
 * suites); RLS behavior uses asUser (a real `authenticated` role); the tier guard is exercised
 * by controlling the request.jwt.claims role (service_role bypasses it, others don't).
 *
 * Gated behind LORE_INTEGRATION=1 (needs Docker). Run:
 *   LORE_INTEGRATION=1 pnpm exec vitest run packages/gateway/test/sync-orgs.integration.test.ts
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

// knowledge NOT NULL cols without defaults: category/title/content. Inserted via the superuser
// connection. Content inserts go through asUser (a JWT context) so the quota trigger's
// auth.uid() resolves; the FK relax itself is asserted by catalog introspection.
const scopeFkRefs = (t: string) =>
  h.client
    .query(
      `select ccu.table_name as ref
         from information_schema.table_constraints tc
         join information_schema.key_column_usage kcu
           on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
         join information_schema.constraint_column_usage ccu
           on ccu.constraint_name = tc.constraint_name and ccu.table_schema = tc.table_schema
        where tc.table_schema = 'public' and tc.table_name = $1
          and tc.constraint_type = 'FOREIGN KEY' and kcu.column_name = 'scope_id'`,
      [t],
    )
    .then((r) => r.rows.map((x) => x.ref as string));

describe.skipIf(gate())(
  "0023 orgs registry — provisioning + FK relax (E-1, #827)",
  () => {
    it("auto-provisions exactly one personal org/scope + owner/admin memberships per user", async () => {
      const uid = await h.createUser();
      const orgs = (
        await h.client.query(
          "select id, kind, owner_user_id from public.orgs where owner_user_id=$1",
          [uid],
        )
      ).rows;
      const scopes = (
        await h.client.query(
          "select id, kind, org_id from public.scopes where id=$1",
          [uid],
        )
      ).rows;
      const om = (
        await h.client.query(
          "select role from public.org_members where user_id=$1",
          [uid],
        )
      ).rows;
      const sm = (
        await h.client.query(
          "select role from public.scope_members where scope_id=$1 and user_id=$1",
          [uid],
        )
      ).rows;
      expect(orgs).toHaveLength(1);
      expect(orgs[0].kind).toBe("personal");
      expect(scopes).toHaveLength(1);
      expect(scopes[0].kind).toBe("personal");
      expect(scopes[0].org_id).toBe(orgs[0].id); // scope hangs off the personal org
      expect(om).toEqual([{ role: "owner" }]);
      expect(sm).toEqual([{ role: "admin" }]);
    });

    it("provisioning is idempotent (re-running makes no duplicates)", async () => {
      const uid = await h.createUser();
      await h.client.query("select public.provision_personal_scope($1)", [uid]);
      await h.client.query("select public.provision_personal_scope($1)", [uid]);
      const n = {
        orgs: (
          await h.client.query(
            "select 1 from public.orgs where owner_user_id=$1",
            [uid],
          )
        ).rowCount,
        scopes: (
          await h.client.query("select 1 from public.scopes where id=$1", [uid])
        ).rowCount,
        om: (
          await h.client.query(
            "select 1 from public.org_members where user_id=$1",
            [uid],
          )
        ).rowCount,
        sm: (
          await h.client.query(
            "select 1 from public.scope_members where scope_id=$1",
            [uid],
          )
        ).rowCount,
      };
      expect(n).toEqual({ orgs: 1, scopes: 1, om: 1, sm: 1 });
    });

    it("effective_tier reads a personal scope's tier from profiles (dual-read, unchanged billing path)", async () => {
      const uid = await h.createUser();
      const before = (
        await h.client.query("select public.effective_tier($1) as t", [uid])
      ).rows[0].t;
      expect(before).toBe("free");
      // profiles.tier is service-role-only (guard_profile_tier, 0006) — set as service_role.
      await h.asService((c) =>
        c.query("update public.profiles set tier='pro' where id=$1", [uid]),
      );
      const after = (
        await h.client.query("select public.effective_tier($1) as t", [uid])
      ).rows[0].t;
      expect(after).toBe("pro");
    });

    it("is_member/scope_role/org_role resolve the owner and reject non-members", async () => {
      const a = await h.createUser();
      const b = await h.createUser();
      const selfMember = (
        await h.client.query("select public.is_member($1,$1) as x", [a])
      ).rows[0].x;
      const otherMember = (
        await h.client.query("select public.is_member($1,$2) as x", [a, b])
      ).rows[0].x;
      const scopeRole = (
        await h.client.query("select public.scope_role($1,$1) as x", [a])
      ).rows[0].x;
      const orgRole = (
        await h.client.query(
          "select public.org_role((select id from public.orgs where owner_user_id=$1),$1) as x",
          [a],
        )
      ).rows[0].x;
      expect(selfMember).toBe(true);
      expect(otherMember).toBe(false);
      expect(scopeRole).toBe("admin");
      expect(orgRole).toBe("owner");
    });

    it("content scope_id now references the scopes registry, not auth.users (the FK relax)", async () => {
      // Every scope_id-keyed table the relax touches (content across 0002/0009/0010/0020/0022
      // + the eviction/reaper infra 0013/0019).
      for (const t of [
        "knowledge",
        "entities",
        "entity_aliases",
        "entity_relations",
        "knowledge_entity_refs",
        "knowledge_meta",
        "knowledge_meta_crdt",
        "account_escrow",
        "scope_keys",
        "distillations",
        "temporal_messages",
        "projects",
        "sync_eviction_budget",
        "sync_device_progress",
      ]) {
        const refs = await scopeFkRefs(t);
        expect(refs).toContain("scopes"); // relaxed target
        expect(refs).not.toContain("users"); // old auth.users FK is gone
      }
    });

    it("auth.users delete still cascades to content (via orgs→scopes→content) — behavior preserved", async () => {
      const uid = await h.createUser();
      // Insert as the user (valid JWT context so the quota trigger's auth.uid() resolves).
      await h.asUser(uid, (c) =>
        c.query(
          "insert into public.knowledge (id, category, title, content) values ('k-casc','p','T','C')",
        ),
      );
      await h.client.query("delete from auth.users where id=$1", [uid]);
      const left = {
        k: (
          await h.client.query(
            "select 1 from public.knowledge where scope_id=$1",
            [uid],
          )
        ).rowCount,
        orgs: (
          await h.client.query(
            "select 1 from public.orgs where owner_user_id=$1",
            [uid],
          )
        ).rowCount,
        scopes: (
          await h.client.query("select 1 from public.scopes where id=$1", [uid])
        ).rowCount,
      };
      expect(left).toEqual({ k: 0, orgs: 0, scopes: 0 });
    });

    it("orgs.tier: service_role may set it, a non-service caller is rejected by guard_org_tier, a client has no write grant", async () => {
      const uid = await h.createUser();
      const org = (
        await h.client.query(
          "select id from public.orgs where owner_user_id=$1",
          [uid],
        )
      ).rows[0].id;
      // ALLOW path: with the service_role JWT claim, the guard permits the tier change.
      await h.client.query("begin");
      await h.client.query(
        "select set_config('request.jwt.claims','{\"role\":\"service_role\"}',true)",
      );
      await h.client.query("update public.orgs set tier='pro' where id=$1", [
        org,
      ]);
      await h.client.query("commit");
      const t = (
        await h.client.query("select tier from public.orgs where id=$1", [org])
      ).rows[0].tier;
      expect(t).toBe("pro");
      // REJECT path: a non-service (authenticated) claim → guard raises. (A valid claim is
      // required so auth.role() parses; an empty claims GUC would 22P02 in json cast first.)
      await h.client.query("begin");
      await h.client.query(
        "select set_config('request.jwt.claims','{\"role\":\"authenticated\"}',true)",
      );
      const guarded = await expectError(() =>
        h.client.query("update public.orgs set tier='free' where id=$1", [org]),
      );
      await h.client.query("rollback");
      expect(guarded.code).toBe("23514"); // check_violation
      expect(guarded.message).toMatch(/service-role-only/i);
      // CLIENT path: authenticated has no write grant at all (belt over the guard).
      const denied = await expectError(() =>
        h.asUser(uid, (c) =>
          c.query("update public.orgs set tier='free' where id=$1", [org]),
        ),
      );
      expect(denied.code).toBe("42501"); // insufficient_privilege
    });

    it("registry RLS isolates: a user sees only their own org/scope, never another's", async () => {
      const a = await h.createUser();
      await h.createUser(); // b exists but must be invisible to a
      const seenByA = await h.asUser(a, async (c) => ({
        orgs: (await c.query("select owner_user_id from public.orgs")).rows.map(
          (r) => r.owner_user_id,
        ),
        scopes: (await c.query("select id from public.scopes")).rows.map(
          (r) => r.id,
        ),
      }));
      expect(seenByA.orgs).toEqual([a]);
      expect(seenByA.scopes).toEqual([a]);
    });

    it("content isolation unchanged: user B cannot see user A's knowledge (E-1 did not touch content RLS)", async () => {
      const a = await h.createUser();
      const b = await h.createUser();
      await h.asUser(a, (c) =>
        c.query(
          "insert into public.knowledge (id, category, title, content) values ('k-iso','p','T','secret-A')",
        ),
      );
      const seenByB = await h.asUser(b, (c) =>
        c.query("select id from public.knowledge").then((r) => r.rowCount),
      );
      expect(seenByB).toBe(0);
    });
  },
);
