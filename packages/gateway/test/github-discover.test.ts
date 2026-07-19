/**
 * Unit tests for the github-discover Edge Function's pure core (E-5-d, #630) — repo/collaborator
 * fetch + parsing + Lore-membership annotation. Mirrors github-provision.test.ts: imports the
 * Deno-free `discover.ts` and drives it with a URL-routed fetch mock.
 */
import { describe, expect, it } from "vitest";
import {
  annotateOnLore,
  collectGithubIds,
  fetchRepoCollaborators,
  fetchUserRepos,
  parseRepoRef,
  type RepoCollaborators,
} from "../../../supabase/functions/github-discover/discover";

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

describe("parseRepoRef", () => {
  it("parses a bare owner/name slug", () => {
    expect(parseRepoRef("BYK/loreai")).toEqual({
      owner: "BYK",
      name: "loreai",
    });
  });
  it("strips a full GitHub URL and trailing .git", () => {
    expect(parseRepoRef("https://github.com/BYK/loreai.git")).toEqual({
      owner: "BYK",
      name: "loreai",
    });
    expect(parseRepoRef("github.com/BYK/loreai/")).toEqual({
      owner: "BYK",
      name: "loreai",
    });
  });
  it("rejects malformed / traversal-y input", () => {
    expect(parseRepoRef("just-one")).toBeNull();
    expect(parseRepoRef("a/b/c")).toBeNull();
    expect(parseRepoRef("../etc/passwd")).toBeNull();
    expect(parseRepoRef("owner/")).toBeNull();
    expect(parseRepoRef("owner/na me")).toBeNull();
    expect(parseRepoRef("")).toBeNull();
  });
  it("rejects bare . / .. path segments (URL-collapse defense)", () => {
    expect(parseRepoRef("owner/..")).toBeNull();
    expect(parseRepoRef("../x")).toBeNull();
    expect(parseRepoRef("owner/.")).toBeNull();
    expect(parseRepoRef("./x")).toBeNull();
    expect(parseRepoRef("../..")).toBeNull();
  });
});

describe("fetchUserRepos", () => {
  it("lists the caller's repos as refs, dropping malformed full_names", async () => {
    const f = mockFetch({
      "/user/repos": {
        body: [
          { full_name: "BYK/loreai" },
          { full_name: "acme/web" },
          { full_name: "bad" }, // dropped (not owner/name)
          { notafullname: true }, // dropped
        ],
      },
    });
    const repos = await fetchUserRepos("tok", { fetchImpl: f });
    expect(repos).toEqual([
      { owner: "BYK", name: "loreai" },
      { owner: "acme", name: "web" },
    ]);
  });
  it("throws on a non-ok response", async () => {
    const f = mockFetch({ "/user/repos": { status: 401, body: {} } });
    await expect(fetchUserRepos("tok", { fetchImpl: f })).rejects.toThrow(
      /user\/repos: 401/,
    );
  });
});

describe("fetchRepoCollaborators", () => {
  it("returns collaborators excluding the caller (by github id)", async () => {
    const f = mockFetch({
      "/collaborators": {
        body: [
          { login: "alice", id: 1 },
          { login: "self", id: 99 }, // the caller — excluded
          { login: "bob", id: 2 },
        ],
      },
    });
    const cols = await fetchRepoCollaborators(
      "tok",
      { owner: "o", name: "r" },
      99,
      { fetchImpl: f },
    );
    expect(cols).toEqual([
      { login: "alice", github_id: 1 },
      { login: "bob", github_id: 2 },
    ]);
  });
  it("returns null (skip, not throw) on 403 / 404 — inaccessible repo", async () => {
    for (const status of [403, 404]) {
      const f = mockFetch({ "/collaborators": { status, body: {} } });
      const cols = await fetchRepoCollaborators(
        "tok",
        { owner: "o", name: "r" },
        99,
        { fetchImpl: f },
      );
      expect(cols).toBeNull();
    }
  });
  it("throws on other non-ok statuses (e.g. 500)", async () => {
    const f = mockFetch({ "/collaborators": { status: 500, body: {} } });
    await expect(
      fetchRepoCollaborators("tok", { owner: "o", name: "r" }, 99, {
        fetchImpl: f,
      }),
    ).rejects.toThrow(/collaborators: 500/);
  });
  it("drops rows with a missing id or login", async () => {
    const f = mockFetch({
      "/collaborators": {
        body: [
          { login: "alice", id: 1 },
          { login: "noid" }, // no id → dropped
          { id: 3 }, // no login → dropped
          { login: "", id: 4 }, // empty login → dropped
        ],
      },
    });
    const cols = await fetchRepoCollaborators(
      "tok",
      { owner: "o", name: "r" },
      99,
      { fetchImpl: f },
    );
    expect(cols).toEqual([{ login: "alice", github_id: 1 }]);
  });
});

describe("collectGithubIds + annotateOnLore", () => {
  const rosters: RepoCollaborators[] = [
    {
      repo: "o/r1",
      collaborators: [
        { login: "alice", github_id: 1 },
        { login: "bob", github_id: 2 },
      ],
    },
    {
      repo: "o/r2",
      collaborators: [
        { login: "bob", github_id: 2 }, // duplicate across repos
        { login: "carol", github_id: 3 },
      ],
    },
  ];

  it("collects the distinct set of github ids", () => {
    expect(collectGithubIds(rosters).sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it("annotates on_lore from the known-Lore id set", () => {
    const out = annotateOnLore(rosters, new Set([2, 3]));
    expect(out[0].collaborators).toEqual([
      { login: "alice", github_id: 1, on_lore: false },
      { login: "bob", github_id: 2, on_lore: true },
    ]);
    expect(out[1].collaborators).toEqual([
      { login: "bob", github_id: 2, on_lore: true },
      { login: "carol", github_id: 3, on_lore: true },
    ]);
  });

  it("annotates all false when no ids are on Lore", () => {
    const out = annotateOnLore(rosters, new Set());
    expect(out.every((r) => r.collaborators.every((c) => !c.on_lore))).toBe(
      true,
    );
  });
});
