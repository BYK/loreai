/**
 * Integration tests for migration 0050 — the Lore-membership lookup for GitHub repo-collaborator
 * discovery (E-5-d, #630) against a real Postgres. Proves `lore_users_for_github_ids`:
 *  - returns exactly the subset of input github ids that have a Lore account (matched on
 *    auth.users.raw_user_meta_data->>'provider_id');
 *  - never returns user_ids/emails — only github ids;
 *  - is SERVICE-ROLE-ONLY (authenticated + anon cannot call it → not an enumeration oracle);
 *  - ignores users with no/invalid provider_id.
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

/** Create an auth.users row with a GitHub provider_id in raw_user_meta_data (as superuser). */
async function createGitHubUser(providerId: string | null): Promise<string> {
  const meta =
    providerId === null ? "{}" : JSON.stringify({ provider_id: providerId });
  const { rows } = await h.client.query(
    "insert into auth.users (email, raw_user_meta_data) values ($1, $2::jsonb) returning id",
    [`u${Math.random().toString(16).slice(2)}@test.dev`, meta],
  );
  return rows[0].id as string;
}

const lookup = (ids: number[]) =>
  h.asService((c) =>
    c.query(
      "select github_id from public.lore_users_for_github_ids($1::bigint[])",
      [ids],
    ),
  );

describe.skipIf(gate())(
  "migration 0050 — github-discover lookup (E-5-d, #630)",
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
  },
);
