/**
 * Integration tests for migration 0028 — enforce_row_quota membership guard + effective_tier
 * (E-4b, #827) against a real Postgres. Proves the two targeted changes:
 *  - GUARD: a team member's write to a SHARED scope (scope_id ≠ auth.uid()) is now METERED.
 *    Under the old `scope_id is distinct from auth.uid()` guard it was skipped (unmetered).
 *  - TIER READ: a team scope's caps come from its ORG's tier via effective_tier (not from a
 *    profiles lookup by the scope id, which for a team is null → 'free').
 *  - Behavior-preserving: a personal scope is metered exactly as before.
 *
 * Gated behind LORE_INTEGRATION=1 (needs Docker). Run:
 *   LORE_INTEGRATION=1 pnpm exec vitest run packages/gateway/test/sync-quota-membership.integration.test.ts
 */
import { execFileSync } from "node:child_process";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
let origFreeMetaCap: number;
beforeAll(async () => {
  if (SKIP) return;
  h = await startPgHarness();
  origFreeMetaCap = await h.client
    .query(
      "select max_rows from public.plan_limits where tier='free' and table_name='knowledge_meta'",
    )
    .then((r) => Number(r.rows[0].max_rows));
}, 180_000);
afterAll(async () => {
  if (h) await h.stop();
});
// Restore the mutated free cap so it never leaks across tests / files.
afterEach(async () => {
  if (!SKIP)
    await h.client.query(
      "update public.plan_limits set max_rows=$1 where tier='free' and table_name='knowledge_meta'",
      [origFreeMetaCap],
    );
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

// Manufacture a team org + team scope owned by `owner` at `tier` (service-role territory, so
// inserted via the superuser client). Returns the team scope id.
async function makeTeamScope(owner: string, tier: string): Promise<string> {
  const org = await h.client
    .query(
      "insert into public.orgs (kind, owner_user_id, tier) values ('team',$1,$2) returning id",
      [owner, tier],
    )
    .then((r) => r.rows[0].id as string);
  return h.client
    .query(
      "insert into public.scopes (org_id, kind) values ($1,'team') returning id",
      [org],
    )
    .then((r) => r.rows[0].id as string);
}
const addScopeMember = (scope: string, uid: string, role: string) =>
  h.client.query(
    "insert into public.scope_members (scope_id, user_id, role) values ($1,$2,$3)",
    [scope, uid, role],
  );
const setFreeMetaCap = (n: number) =>
  h.client.query(
    "update public.plan_limits set max_rows=$1 where tier='free' and table_name='knowledge_meta'",
    [n],
  );
// Insert a knowledge_meta row into `scope` AS `uid` (author defaults to auth.uid()).
const insMeta = (uid: string, scope: string, lid: string) =>
  h.asUser(uid, (c) =>
    c.query(
      "insert into public.knowledge_meta (logical_id, scope_id) values ($1,$2)",
      [lid, scope],
    ),
  );

describe.skipIf(gate())("0028 quota membership guard (E-4b, #827)", () => {
  it("meters a team member's write to a shared scope (was skipped under the self-guard)", async () => {
    const a = await h.createUser();
    const b = await h.createUser();
    const scope = await makeTeamScope(a, "free");
    await addScopeMember(scope, a, "admin");
    await addScopeMember(scope, b, "editor");
    await setFreeMetaCap(1);
    // First write fits under the cap.
    await insMeta(b, scope, "lm1");
    // Second write by the SAME team member is now METERED (is_member guard) → over cap → 23514.
    // Under the old `scope_id distinct from auth.uid()` guard this would have been skipped.
    const err = await expectError(() => insMeta(b, scope, "lm2"));
    expect(err.code).toBe("23514");
    expect(err.message).toMatch(/quota exceeded/i);
  });

  it("resolves a team scope's cap from its ORG tier via effective_tier (not a free default)", async () => {
    const a = await h.createUser();
    const b = await h.createUser();
    const scope = await makeTeamScope(a, "pro"); // org tier = pro
    await addScopeMember(scope, a, "admin");
    await addScopeMember(scope, b, "editor");
    await setFreeMetaCap(1); // tiny FREE cap — proves the free cap is NOT the one applied
    // effective_tier(scope) = 'pro' → the (large) pro cap applies, so both writes succeed.
    // Under the old profiles-by-scope-id read, tier would resolve null → 'free' → cap 1 → 23514.
    await insMeta(b, scope, "lp1");
    await insMeta(b, scope, "lp2");
    expect(
      await h.client
        .query(
          "select count(*)::int as n from public.knowledge_meta where scope_id=$1",
          [scope],
        )
        .then((r) => r.rows[0].n),
    ).toBe(2);
  });

  it("a non-member's forged write to a team scope is RLS-rejected and never counts against usage", async () => {
    const a = await h.createUser();
    const c = await h.createUser(); // NOT a member of the team scope
    const scope = await makeTeamScope(a, "free");
    await addScopeMember(scope, a, "admin");
    // C forges a write to A's team scope. The BEFORE-trigger guard skips the quota read (not a
    // member), then RLS WITH CHECK is_member rejects the row → 42501, never an actual write.
    const err = await expectError(() => insMeta(c, scope, "forge"));
    expect(err.code).toBe("42501");
    // The scope's usage counter is untouched (maintain_usage never fired — the row never landed).
    const usage = await h.client
      .query(
        "select row_count from public.user_table_usage where scope_id=$1 and table_name='knowledge_meta'",
        [scope],
      )
      .then((r) => r.rows);
    expect(usage).toHaveLength(0);
  });

  it("behavior-preserving: a personal scope is still metered (owner write over cap → 23514)", async () => {
    const a = await h.createUser(); // auto-provisioned personal scope (id = a), free tier
    await setFreeMetaCap(1);
    await insMeta(a, a, "lo1"); // own scope (scope_id defaults auth.uid() = a)
    const err = await expectError(() => insMeta(a, a, "lo2"));
    expect(err.code).toBe("23514");
  });
});
