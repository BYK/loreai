/**
 * Unit tests for the github-discover Edge Function's pure core (E-5-d, #630) — repo/contributor
 * fetch + parsing + Lore-membership annotation. Mirrors github-provision.test.ts: imports the
 * Deno-free `discover.ts` and drives it with a URL-routed fetch mock.
 */
import { describe, expect, it } from "vitest";
import {
  annotateOnLore,
  collectGithubIds,
  fetchRepoContributors,
  fetchUserRepos,
  parseRepoRef,
  type RepoContributors,
} from "../../../supabase/functions/github-discover/discover";

function mockFetch(
  routes: Record<string, { status?: number; body: unknown; link?: string }>,
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
          headers: new Map(
            resp.link ? [["link", resp.link]] : [],
          ) as unknown as Headers,
          json: async () => resp.body,
        } as Response;
      }
    }
    return {
      ok: false,
      status: 404,
      headers: new Map() as unknown as Headers,
      json: async () => ({}),
    } as Response;
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

describe("fetchRepoContributors", () => {
  it("returns contributors excluding the caller (by github id)", async () => {
    const f = mockFetch({
      "/contributors": {
        body: [
          { login: "alice", id: 1 },
          { login: "self", id: 99 }, // the caller — excluded
          { login: "bob", id: 2 },
        ],
      },
    });
    const cols = await fetchRepoContributors(
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
  it("asks for anon contributors and per_page=100 (cheap pagination window)", async () => {
    let seen = "";
    const f = (async (input: string | URL | Request) => {
      const url =
        typeof input === "string" ? input : ((input as URL).href ?? "");
      seen = url;
      return {
        ok: true,
        status: 200,
        headers: new Map() as unknown as Headers,
        json: async () => [{ login: "alice", id: 1 }],
      } as Response;
    }) as typeof fetch;
    await fetchRepoContributors("tok", { owner: "o", name: "r" }, 99, {
      fetchImpl: f,
    });
    expect(seen).toMatch(/anon=true/);
    expect(seen).toMatch(/per_page=100/);
  });
  it("returns null (skip, not throw) on 403 / 404 — inaccessible repo", async () => {
    for (const status of [403, 404]) {
      const f = mockFetch({ "/contributors": { status, body: {} } });
      const cols = await fetchRepoContributors(
        "tok",
        { owner: "o", name: "r" },
        99,
        { fetchImpl: f },
      );
      expect(cols).toBeNull();
    }
  });
  it("returns [] (empty roster, NOT skip) on 202 — stats still computing", async () => {
    const f = mockFetch({ "/contributors": { status: 202, body: "" } });
    const cols = await fetchRepoContributors(
      "tok",
      { owner: "o", name: "r" },
      99,
      { fetchImpl: f },
    );
    expect(cols).toEqual([]);
  });
  it("returns [] (empty roster, NOT skip) on 204 — empty repo body", async () => {
    // Regression for Seer review of PR #1527 (comment 3676072445, finding 15565416/0):
    // without an explicit 204 branch, `resp.ok === true` and `resp.json()` parses the
    // empty body as `undefined`, throwing SyntaxError on platforms where JSON.parse("")
    // fails — the outer try/catch would silently skip the repo as if it were
    // inaccessible. Documented behavior (discover.ts docstring) says 204 returns [].
    const f = mockFetch({ "/contributors": { status: 204, body: "" } });
    const cols = await fetchRepoContributors(
      "tok",
      { owner: "o", name: "r" },
      99,
      { fetchImpl: f },
    );
    expect(cols).toEqual([]);
  });
  it("follows Link: rel='next' up to MAX_PAGES and dedupes cross-page via Set<id>", async () => {
    const page2Link =
      '<https://api.github.com/repos/o/r/contributors?page=2&anon=true&per_page=100>; rel="next"';
    const page1Body = [
      { login: "alice", id: 1 },
      { login: "bob", id: 2 },
    ];
    const page2Body = [
      { login: "bob", id: 2 }, // cross-page dup — must dedupe (first wins)
      { login: "carol", id: 3 },
    ];
    const calls: string[] = [];
    const f = (async (input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      calls.push(url);
      const isPage2 = url.includes("page=2");
      return {
        ok: true,
        status: 200,
        headers: new Map(
          isPage2 ? [] : [["link", page2Link]],
        ) as unknown as Headers,
        json: async () => (isPage2 ? page2Body : page1Body),
      } as Response;
    }) as typeof fetch;
    const cols = await fetchRepoContributors(
      "tok",
      { owner: "o", name: "r" },
      99,
      { fetchImpl: f },
    );
    expect(calls.length).toBe(2);
    expect(cols).toEqual([
      { login: "alice", github_id: 1 },
      { login: "bob", github_id: 2 },
      { login: "carol", github_id: 3 },
    ]);
  });

  it("stops at MAX_PAGES even when the server keeps sending rel='next'", async () => {
    const link =
      '<https://api.github.com/repos/o/r/contributors?page=N&anon=true&per_page=100>; rel="next"';
    let calls = 0;
    const f = (async (_input: string | URL | Request) => {
      calls++;
      return {
        ok: true,
        status: 200,
        headers: new Map([["link", link]]) as unknown as Headers,
        json: async () => [{ login: `u${calls}`, id: calls }],
      } as Response;
    }) as typeof fetch;
    const cols = await fetchRepoContributors(
      "tok",
      { owner: "o", name: "r" },
      999_999, // self id that won't match anything
      { fetchImpl: f },
    );
    // MAX_PAGES is set to 5 in discover.ts — exactly 5 calls regardless of the next-link loop.
    expect(calls).toBe(5);
    expect(cols?.length).toBe(5);
  });

  it("rewrites a non-apiUrl Link next href onto apiUrl (defense against leaked host)", async () => {
    // Some test proxies / misconfigs may inject a different host into the next URL. We rewrite
    // anything that doesn't match apiUrl's origin back onto apiUrl.
    const leakLink =
      '<https://attacker.example.com/repos/o/r/contributors?page=2>; rel="next"';
    let seen = "";
    const f = (async (input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      seen = url;
      return {
        ok: true,
        status: 200,
        headers: new Map([["link", leakLink]]) as unknown as Headers,
        json: async () => [{ login: "alice", id: 1 }],
      } as Response;
    }) as typeof fetch;
    await fetchRepoContributors("tok", { owner: "o", name: "r" }, 99, {
      fetchImpl: f,
      apiUrl: "https://api.github.com",
    });
    expect(seen.startsWith("https://api.github.com/")).toBe(true);
    expect(seen).not.toContain("attacker.example.com");
  });
  it("throws on other non-ok statuses (e.g. 500)", async () => {
    const f = mockFetch({ "/contributors": { status: 500, body: {} } });
    await expect(
      fetchRepoContributors("tok", { owner: "o", name: "r" }, 99, {
        fetchImpl: f,
      }),
    ).rejects.toThrow(/contributors: 500/);
  });
  it("drops rows with a missing id or login (including anonymous contributors)", async () => {
    const f = mockFetch({
      "/contributors": {
        body: [
          { login: "alice", id: 1 },
          { login: "noid" }, // no id → dropped (can't link to Lore)
          { id: 3 }, // no login → dropped (anonymous contributor)
          { login: "", id: 4 }, // empty login → dropped
          { login: null, id: 5 }, // null login → dropped
        ],
      },
    });
    const cols = await fetchRepoContributors(
      "tok",
      { owner: "o", name: "r" },
      99,
      { fetchImpl: f },
    );
    expect(cols).toEqual([{ login: "alice", github_id: 1 }]);
  });
});

describe("collectGithubIds + annotateOnLore", () => {
  const rosters: RepoContributors[] = [
    {
      repo: "o/r1",
      contributors: [
        { login: "alice", github_id: 1 },
        { login: "bob", github_id: 2 },
      ],
    },
    {
      repo: "o/r2",
      contributors: [
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
    expect(out[0].contributors).toEqual([
      { login: "alice", github_id: 1, on_lore: false },
      { login: "bob", github_id: 2, on_lore: true },
    ]);
    expect(out[1].contributors).toEqual([
      { login: "bob", github_id: 2, on_lore: true },
      { login: "carol", github_id: 3, on_lore: true },
    ]);
  });

  it("annotates all false when no ids are on Lore", () => {
    const out = annotateOnLore(rosters, new Set());
    expect(out.every((r) => r.contributors.every((c) => !c.on_lore))).toBe(
      true,
    );
  });
});
