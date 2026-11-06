/**
 * Real-Postgres tests for GitHub discovery and invite-recipient lookup. Proves:
 *  - returns exactly the subset of input github ids that have a Lore account (matched on
 *    server-owned auth.identities with provider = 'github');
 *  - never returns user_ids/emails — only github ids;
 *  - is SERVICE-ROLE-ONLY (authenticated + anon cannot call it → not an enumeration oracle);
 *  - editable metadata and foreign-provider identities never establish ownership.
 *
 * Gated behind LORE_INTEGRATION=1 (needs Docker). Run:
 *   LORE_INTEGRATION=1 pnpm exec vitest run packages/gateway/test/sync-github-discover.integration.test.ts
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

/** Simulate GoTrue's linked GitHub identity, separately from editable metadata. */
async function createGitHubUser(providerId: string | null): Promise<string> {
  const meta =
    providerId === null ? "{}" : JSON.stringify({ provider_id: providerId });
  const { rows } = await h.client.query(
    "insert into auth.users (email, raw_user_meta_data) values ($1, $2::jsonb) returning id",
    [`u${Math.random().toString(16).slice(2)}@test.dev`, meta],
  );
  const uid = rows[0].id as string;
  if (providerId !== null) {
    await h.client.query(
      "insert into auth.identities (provider_id, user_id, provider) values ($1, $2, 'github')",
      [providerId, uid],
    );
  }
  return uid;
}

const lookup = (ids: number[]) =>
  h.asService((c) =>
    c.query(
      "select github_id from public.lore_users_for_github_ids($1::bigint[])",
      [ids],
    ),
  );

const lookupEmails = (ids: number[]) =>
  h.asService((c) =>
    c.query(
      "select github_id, email from public.lore_emails_for_github_ids($1::bigint[])",
      [ids],
    ),
  );

describe.skipIf(gate())(
  "GitHub discovery uses verified linked identities",
  () => {
    it("returns exactly the input github ids that have a Lore account", async () => {
      await createGitHubUser("111");
      await createGitHubUser("222");
      // 333 is NOT a Lore user.
      const { rows } = await lookup([111, 222, 333]);
      const found = rows.map((r) => Number(r.github_id)).sort((a, b) => a - b);
      expect(found).toEqual([111, 222]);
    });

    it("returns empty when none of the ids are on Lore", async () => {
      const { rows } = await lookup([999999001, 999999002]);
      expect(rows).toEqual([]);
    });

    it("ignores users with no/invalid provider_id", async () => {
      await createGitHubUser(null); // email-only user, no provider_id
      await createGitHubUser("not-a-number"); // malformed
      await createGitHubUser("444"); // valid
      const { rows } = await lookup([444]);
      expect(rows.map((r) => Number(r.github_id))).toEqual([444]);
    });

    it("exposes only github_id — no user_id / email columns", async () => {
      await createGitHubUser("555");
      const { fields } = await lookup([555]);
      expect(fields.map((f) => f.name)).toEqual(["github_id"]);
    });

    it("is service-role-only: authenticated cannot call it (no enumeration oracle)", async () => {
      const uid = await createGitHubUser("666");
      const err = await expectError(() =>
        h.asUser(uid, (c) =>
          c.query("select public.lore_users_for_github_ids($1::bigint[])", [
            [666],
          ]),
        ),
      );
      expect(err.code).toBe("42501"); // permission denied for function
    });

    it("is service-role-only: anon cannot call it", async () => {
      const err = await expectError(() =>
        h.asAnon((c) =>
          c.query("select public.lore_users_for_github_ids($1::bigint[])", [
            [777],
          ]),
        ),
      );
      expect(err.code).toBe("42501");
    });

    it.each(["membership", "email"])(
      "editable provider metadata never establishes %s lookup membership",
      async (kind) => {
        const id = kind === "membership" ? 700001 : 700002;
        const uid = await createGitHubUser(null);
        await h.client.query(
          "update auth.users set raw_user_meta_data = $1::jsonb where id = $2",
          [JSON.stringify({ provider_id: String(id) }), uid],
        );
        const result = await (kind === "membership"
          ? lookup([id])
          : lookupEmails([id]));
        expect(result.rows).toEqual([]);
      },
    );

    it.each(["membership", "email"])(
      "a foreign linked identity cannot forge GitHub %s lookup membership",
      async (kind) => {
        const id = kind === "membership" ? 700003 : 700004;
        const uid = await createGitHubUser(null);
        await h.client.query(
          "insert into auth.identities (provider_id, user_id, provider) values ($1, $2, 'google')",
          [String(id), uid],
        );
        await h.client.query(
          "update auth.users set raw_user_meta_data = $1::jsonb where id = $2",
          [JSON.stringify({ provider_id: String(id) }), uid],
        );
        const result = await (kind === "membership"
          ? lookup([id])
          : lookupEmails([id]));
        expect(result.rows).toEqual([]);
      },
    );

    it("invite email lookup chooses the linked GitHub owner despite forged or missing metadata", async () => {
      const owner = await createGitHubUser("700005");
      const attacker = await createGitHubUser("700006");
      await h.client.query(
        "update auth.users set raw_user_meta_data = '{}'::jsonb where id = $1",
        [owner],
      );
      await h.client.query(
        'update auth.users set raw_user_meta_data = \'{"provider_id":"700005"}\'::jsonb where id = $1',
        [attacker],
      );
      const { rows: owners } = await h.client.query(
        "select email from auth.users where id = $1",
        [owner],
      );
      const result = await lookupEmails([700005, 700005]);
      expect(result.fields.map((field) => field.name)).toEqual([
        "github_id",
        "email",
      ]);
      expect(result.rows).toEqual([
        { github_id: "700005", email: owners[0].email },
      ]);
      expect((await lookup([700005, 700005])).rows).toEqual([
        { github_id: "700005" },
      ]);
    });

    it.each(["authenticated", "anon"])(
      "invite email lookup never exposes emails to %s",
      async (role) => {
        const uid = await createGitHubUser(null);
        const run = (c: import("pg").Client) =>
          c.query(
            "select * from public.lore_emails_for_github_ids($1::bigint[])",
            [[700005]],
          );
        const error = await expectError(() =>
          role === "authenticated" ? h.asUser(uid, run) : h.asAnon(run),
        );
        expect(error.code).toBe("42501");
      },
    );

    it("malformed or oversized identity strings never break or enter numeric lookup results", async () => {
      await createGitHubUser("999999999999999999999999999999999999999");
      await createGitHubUser("../700005");
      expect((await lookup([700005])).rows).toEqual([{ github_id: "700005" }]);
      expect((await lookupEmails([700005])).rows).toHaveLength(1);
    });

    it.each(["membership", "email"])(
      "ambiguous linked identities fail closed for %s lookup",
      async (kind) => {
        const id = kind === "membership" ? 700007 : 700008;
        await createGitHubUser(String(id));
        const duplicate = await createGitHubUser(null);
        // GoTrue normally prevents this state. Exercise the lookup's own guard
        // against legacy or corrupt mappings, then restore the schema constraint.
        await h.client.query(
          "alter table auth.identities drop constraint identities_provider_id_provider_key",
        );
        try {
          await h.client.query(
            "insert into auth.identities (provider_id, user_id, provider) values ($1, $2, 'github')",
            [String(id), duplicate],
          );
          const result = await (kind === "membership"
            ? lookup([id])
            : lookupEmails([id]));
          expect(result.rows).toEqual([]);
        } finally {
          await h.client.query(
            "delete from auth.identities where user_id = $1",
            [duplicate],
          );
          await h.client.query(
            "alter table auth.identities add constraint identities_provider_id_provider_key unique (provider_id, provider)",
          );
        }
      },
    );
  },
);
