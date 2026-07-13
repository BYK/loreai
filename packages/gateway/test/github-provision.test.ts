import { describe, expect, it } from "vitest";
import {
  buildProvisionPayload,
  fetchGitHubMemberships,
  fetchGitHubUser,
  type GitHubMemberships,
  isTokenOwnerBound,
  resolveJwtGithubId,
} from "../../../supabase/functions/github-provision/provision";

// A minimal URL-routed fetch mock (matches the first route whose key is a substring of the URL).
function mockFetch(
  routes: Record<string, { status?: number; body: unknown }>,
): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    for (const [key, resp] of Object.entries(routes)) {
      if (url.includes(key)) {
        const status = resp.status ?? 200;
        return {
          ok: status >= 200 && status < 300,
          status,
          json: async () => resp.body,
        } as Response;
      }
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  }) as typeof fetch;
}

describe("github-provision — fetch + mapping (E-5-a, #827)", () => {
  it("fetches active org memberships (with role) + teams; drops inactive orgs", async () => {
    const f = mockFetch({
      "/user/memberships/orgs": {
        body: [
          {
            state: "active",
            role: "admin",
            organization: { id: 1, login: "acme" },
          },
          {
            state: "active",
            role: "member",
            organization: { id: 2, login: "beta" },
          },
          {
            state: "pending",
            role: "member",
            organization: { id: 3, login: "nope" },
          },
        ],
      },
      "/user/teams": {
        body: [
          { id: 10, slug: "eng", name: "Engineering", organization: { id: 1 } },
          { id: 20, slug: "ops", name: "Ops", organization: { id: 2 } },
        ],
      },
    });
    const m = await fetchGitHubMemberships("tok", {
      apiUrl: "https://gh.test",
      fetchImpl: f,
    });
    expect(m.orgs).toEqual([
      { id: 1, login: "acme", role: "admin" },
      { id: 2, login: "beta", role: "member" }, // org 3 (pending) dropped
    ]);
    expect(m.teams).toEqual([
      { id: 10, slug: "eng", name: "Engineering", orgId: 1 },
      { id: 20, slug: "ops", name: "Ops", orgId: 2 },
    ]);
  });

  it("fetchGitHubUser returns the token owner's id/login (for identity binding)", async () => {
    const f = mockFetch({ "/user": { body: { id: 42, login: "octocat" } } });
    const u = await fetchGitHubUser("tok", {
      apiUrl: "https://gh.test",
      fetchImpl: f,
    });
    expect(u).toEqual({ id: 42, login: "octocat" });
  });

  it("fetchGitHubUser throws on a non-ok response / missing id (fail-closed)", async () => {
    // Body includes an id so this asserts the !ok path INDEPENDENTLY of the missing-id fallback.
    await expect(
      fetchGitHubUser("bad", {
        fetchImpl: mockFetch({ "/user": { status: 401, body: { id: 7 } } }),
      }),
    ).rejects.toThrow(/401/);
    await expect(
      fetchGitHubUser("weird", {
        fetchImpl: mockFetch({ "/user": { body: { login: "no-id" } } }),
      }),
    ).rejects.toThrow(/no id/);
  });

  it("resolveJwtGithubId reads the github identity, then user_metadata, else null", () => {
    expect(
      resolveJwtGithubId({
        identities: [{ provider: "github", id: "123" }],
        user_metadata: { provider_id: "999" },
      }),
    ).toBe("123"); // identity wins
    expect(
      resolveJwtGithubId({
        identities: [],
        user_metadata: { provider_id: 999 },
      }),
    ).toBe("999"); // fallback, coerced to string
    expect(
      resolveJwtGithubId({ identities: [{ provider: "google", id: "5" }] }),
    ).toBeNull(); // no github identity, no provider_id → fail-closed
    expect(resolveJwtGithubId({})).toBeNull();
  });

  it("isTokenOwnerBound matches across number/string and fails closed on null", () => {
    expect(isTokenOwnerBound(123, "123")).toBe(true); // number vs string
    expect(isTokenOwnerBound("123", "123")).toBe(true);
    expect(isTokenOwnerBound(123, "456")).toBe(false); // mismatch → reject
    expect(isTokenOwnerBound(123, null)).toBe(false); // no linked identity → fail-closed
  });

  it("throws on a non-ok GitHub response (fail-closed)", async () => {
    const f = mockFetch({
      "/user/memberships/orgs": { status: 401, body: {} },
    });
    await expect(
      fetchGitHubMemberships("bad", { fetchImpl: f }),
    ).rejects.toThrow(/401/);
  });

  it("maps org admin → manager + scope admin; member → member + editor", () => {
    const m: GitHubMemberships = {
      orgs: [
        { id: 1, login: "acme", role: "admin" },
        { id: 2, login: "beta", role: "member" },
      ],
      teams: [
        { id: 10, slug: "eng", name: "Eng", orgId: 1 },
        { id: 20, slug: "ops", name: "Ops", orgId: 2 },
      ],
    };
    const p = buildProvisionPayload(m);
    expect(p.orgs).toEqual([
      { github_org_id: 1, login: "acme", role: "manager" },
      { github_org_id: 2, login: "beta", role: "member" },
    ]);
    expect(p.teams).toEqual([
      {
        github_team_id: 10,
        github_org_id: 1,
        slug: "eng",
        name: "Eng",
        role: "admin",
      },
      {
        github_team_id: 20,
        github_org_id: 2,
        slug: "ops",
        name: "Ops",
        role: "editor",
      },
    ]);
  });

  it("drops a team whose org is not in the membership set (defensive)", () => {
    const p = buildProvisionPayload({
      orgs: [{ id: 1, login: "acme", role: "member" }],
      teams: [{ id: 99, slug: "x", name: "X", orgId: 404 }],
    });
    expect(p.teams).toEqual([]);
  });
});
