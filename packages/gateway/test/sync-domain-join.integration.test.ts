/**
 * END-TO-END integration for domain auto-join (E-5-b, Model B, #827) against a REAL Postgres +
 * PostgREST. An org admin CLAIMS a domain (proving control via their own verified email at that
 * domain, freemail rejected); a user with a matching VERIFIED email REQUESTS to join; an admin
 * APPROVES (additive, never demote). No silent absorption, no public-domain hijack.
 *
 * Gated behind LORE_INTEGRATION=1 (needs Docker). Run:
 *   LORE_INTEGRATION=1 pnpm exec vitest run packages/gateway/test/sync-domain-join.integration.test.ts
 */
import { execFileSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  approveDomainJoin,
  claimOrgDomain,
  createTeam,
  listDomainJoinRequests,
  rejectDomainJoin,
  requestDomainJoin,
} from "../src/team";
import { type PgHarness, startPgHarness } from "./helpers/pg-harness";

// team.ts's selfUserId() calls getCurrentUser(); createTeam needs it to resolve the caller. Mock it
// to whichever uid the current step acts as (set before each createTeam call).
let mockUid = "";
vi.mock("../src/supabase", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/supabase")>()),
  getCurrentUser: () => Promise.resolve(mockUid ? { user_id: mockUid } : null),
}));

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
let admin: string; // @acme.dev verified — org owner + domain claimant
let coworker: string; // @acme.dev verified — eligible to request
let outsider: string; // @other.dev verified — NOT eligible
let unverified: string; // @acme.dev but email NOT confirmed — NOT eligible
let freemailAdmin: string; // @gmail.com verified — cannot claim gmail.com

function clientFor(uid: string): SupabaseClient {
  const jwt = h.userJwt(uid);
  const rewriteFetch = (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    return fetch(url.replace("/rest/v1", ""), init);
  };
  return createClient(h.restUrl as string, jwt, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: { Authorization: `Bearer ${jwt}` },
      fetch: rewriteFetch as unknown as typeof fetch,
    },
  });
}

/** admin creates a team org and returns { scope, org }. */
async function freshOrg(name: string): Promise<{ scope: string; org: string }> {
  mockUid = admin; // createTeam resolves the caller via getCurrentUser (mocked)
  const scope = await createTeam(clientFor(admin), name);
  const org = await h.client
    .query("select org_id from public.scopes where id=$1", [scope])
    .then((r) => r.rows[0].org_id as string);
  return { scope, org };
}
async function orgRole(org: string, uid: string): Promise<string | undefined> {
  return h.client
    .query(
      "select role from public.org_members where org_id=$1 and user_id=$2",
      [org, uid],
    )
    .then((r) => (r.rows[0]?.role as string) ?? undefined);
}

beforeAll(async () => {
  if (SKIP) return;
  h = await startPgHarness({ postgrest: true });
  admin = await h.createUser("boss@acme.dev");
  coworker = await h.createUser("dev@acme.dev");
  outsider = await h.createUser("stranger@other.dev");
  unverified = await h.createUser("ghost@acme.dev", false); // email NOT confirmed
  freemailAdmin = await h.createUser("someone@gmail.com");
}, 240_000);

afterAll(async () => {
  if (!SKIP) await h.stop();
});

beforeEach(async () => {
  if (SKIP) return;
  // Clean org state between tests (FK order: members/requests/domains → scopes → orgs).
  await h.client.query(
    "delete from public.domain_join_requests; delete from public.org_domains;" +
      " delete from public.scope_members; delete from public.org_members where role<>'owner';" +
      " delete from public.scopes where kind='team'; delete from public.orgs where kind='team'",
  );
});

describe.skipIf(SKIP)("domain auto-join (E-5-b, Model B)", () => {
  it("an admin claims their own verified domain; a coworker requests and is approved (additive)", async () => {
    const { org } = await freshOrg("Acme");
    await claimOrgDomain(clientFor(admin), org, "acme.dev", "member");

    // Coworker (verified @acme.dev) requests → pending.
    const reqId = await requestDomainJoin(clientFor(coworker), org, "acme.dev");
    expect(reqId).toBeTruthy();
    const pending = await listDomainJoinRequests(clientFor(admin), org);
    expect(pending.map((r) => r.userId)).toContain(coworker);

    // Admin approves → coworker becomes an org member at the claim's join_role.
    await approveDomainJoin(clientFor(admin), reqId);
    expect(await orgRole(org, coworker)).toBe("member");
    // Request is decided (no longer pending).
    expect((await listDomainJoinRequests(clientFor(admin), org)).length).toBe(
      0,
    );
  });

  it("a non-admin cannot claim a domain (42501)", async () => {
    const { org } = await freshOrg("Acme");
    await expect(
      claimOrgDomain(clientFor(coworker), org, "acme.dev"),
    ).rejects.toThrow(/only an org owner\/manager/i);
  });

  it("a freemail domain cannot be claimed (22023)", async () => {
    // freemailAdmin makes their own org and tries to claim gmail.com.
    mockUid = freemailAdmin;
    const scope = await createTeam(clientFor(freemailAdmin), "Gmailers");
    const org = await h.client
      .query("select org_id from public.scopes where id=$1", [scope])
      .then((r) => r.rows[0].org_id as string);
    await expect(
      claimOrgDomain(clientFor(freemailAdmin), org, "gmail.com"),
    ).rejects.toThrow(/freemail|public/i);
  });

  it("an admin cannot claim a domain that is not their own verified email domain (42501)", async () => {
    const { org } = await freshOrg("Acme");
    // admin's verified email is @acme.dev, not @other.dev → cannot prove control.
    await expect(
      claimOrgDomain(clientFor(admin), org, "other.dev"),
    ).rejects.toThrow(/verified email must be at the claimed domain/i);
  });

  it("an outsider whose email is at a DIFFERENT domain cannot request (no oracle)", async () => {
    const { org } = await freshOrg("Acme");
    await claimOrgDomain(clientFor(admin), org, "acme.dev");
    await expect(
      requestDomainJoin(clientFor(outsider), org, "acme.dev"),
    ).rejects.toThrow(/no matching claimed domain/i);
  });

  it("an UNVERIFIED email cannot request even at a claimed domain", async () => {
    const { org } = await freshOrg("Acme");
    await claimOrgDomain(clientFor(admin), org, "acme.dev");
    // `unverified` has ghost@acme.dev but email_confirmed_at IS NULL → email_domain() returns NULL.
    await expect(
      requestDomainJoin(clientFor(unverified), org, "acme.dev"),
    ).rejects.toThrow(/no matching claimed domain/i);
  });

  it("requesting when no domain is claimed fails with the same error as a domain mismatch", async () => {
    const { org } = await freshOrg("Acme");
    // No claim exists → identical error to the mismatch case (no claimed-domain enumeration).
    await expect(
      requestDomainJoin(clientFor(coworker), org, "acme.dev"),
    ).rejects.toThrow(/no matching claimed domain/i);
  });

  it("approve is admin-only; a non-admin cannot approve (42501)", async () => {
    const { org } = await freshOrg("Acme");
    await claimOrgDomain(clientFor(admin), org, "acme.dev");
    const reqId = await requestDomainJoin(clientFor(coworker), org, "acme.dev");
    // coworker (not yet a member, certainly not admin) tries to approve their own request.
    await expect(approveDomainJoin(clientFor(coworker), reqId)).rejects.toThrow(
      /only an org owner\/manager|no such request/i,
    );
    expect(await orgRole(org, coworker)).toBeUndefined();
  });

  it("approve is additive — a coworker who is already a higher role is not demoted", async () => {
    const { org } = await freshOrg("Acme");
    await claimOrgDomain(clientFor(admin), org, "acme.dev", "member");
    // Make coworker an org MANAGER first (directly, as the fixture).
    await h.client.query(
      "insert into public.org_members (org_id, user_id, role) values ($1,$2,'manager')",
      [org, coworker],
    );
    // A stale pending request approved later must NOT downgrade manager → member.
    await h.client.query(
      "insert into public.domain_join_requests (org_id, domain, user_id) values ($1,'acme.dev',$2)",
      [org, coworker],
    );
    const reqId = await h.client
      .query(
        "select id from public.domain_join_requests where org_id=$1 and user_id=$2",
        [org, coworker],
      )
      .then((r) => r.rows[0].id as string);
    await approveDomainJoin(clientFor(admin), reqId);
    expect(await orgRole(org, coworker)).toBe("manager"); // NOT demoted
  });

  it("reject marks the request rejected and grants no membership", async () => {
    const { org } = await freshOrg("Acme");
    await claimOrgDomain(clientFor(admin), org, "acme.dev");
    const reqId = await requestDomainJoin(clientFor(coworker), org, "acme.dev");
    await rejectDomainJoin(clientFor(admin), reqId);
    expect(await orgRole(org, coworker)).toBeUndefined();
    const status = await h.client
      .query("select status from public.domain_join_requests where id=$1", [
        reqId,
      ])
      .then((r) => r.rows[0]?.status as string);
    expect(status).toBe("rejected");
  });

  it("verified_email_domain is NOT client-callable (no cross-user email-domain oracle)", async () => {
    // The unguarded helper must be RPC-internal only. A direct authenticated call must be denied.
    const { error } = await clientFor(coworker).rpc("verified_email_domain", {
      p_uid: admin,
    });
    expect(error).toBeTruthy(); // permission denied / not exposed
    // The guarded email_domain IS callable but pins a cross-user probe to null.
    const { data } = await clientFor(coworker).rpc("email_domain", {
      p_uid: admin, // asking about a DIFFERENT user
    });
    expect(data ?? null).toBeNull();
  });
});
