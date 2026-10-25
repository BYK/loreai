import { afterEach, describe, expect, test, vi } from "vitest";
import {
  fetchReleaseNotes,
  formatReleaseNotes,
} from "../src/cli/lib/release-notes";

const stable = {
  channel: "stable" as const,
  fromVersion: "0.40.0",
  toVersion: "0.42.0",
};
const fromSha = "a".repeat(40);
const toSha = "b".repeat(40);
const nightly = {
  channel: "nightly" as const,
  fromVersion: "1.0.0-dev.1700000000",
  toVersion: "1.0.0-dev.1700001000",
};
function release(tag: string, body: string, extra = {}) {
  return { tag_name: tag, body, draft: false, prerelease: false, ...extra };
}
function commit(message: string) {
  return { commit: { message } };
}
function nightlyFetch(
  messages = [
    "feat(ui): Add project picker (#123)",
    "fix: Retain reader position (#124)",
  ],
) {
  return vi.fn(async (input: string | URL) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/commits")) {
      const target =
        url.searchParams.get("until") === "2023-11-14T22:30:00.000Z";
      return Response.json([
        {
          sha: target ? toSha : fromSha,
          commit: {
            committer: {
              date: target ? "2023-11-14T22:30:00Z" : "2023-11-14T22:13:20Z",
            },
          },
        },
      ]);
    }
    expect(url.pathname).toBe(
      `/repos/BYK/loreai/compare/${fromSha}...${toSha}`,
    );
    return Response.json({
      status: "ahead",
      total_commits: messages.length,
      commits: messages.map(commit),
    });
  });
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("upgrade release notes", () => {
  test("includes only stable releases crossed, ignoring drafts, prereleases and internal sections", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json([
          release("0.43.0", "### New Features ✨\n- Future feature"),
          release(
            "v0.42.0",
            "### New Features ✨\n#### UI\n- Project picker by @author in [#123](https://github.com/BYK/loreai/pull/123)\n### Internal Changes 🔧\n- Private refactor",
          ),
          release(
            "0.41.0",
            "### Bug Fixes 🐛\n- Reader position\n### Performance ⚡\n- Faster loading",
          ),
          release("0.40.0", "### New Features ✨\n- Already installed"),
          release("0.41.1", "### New Features ✨\n- Draft", { draft: true }),
          release("0.42.0-dev.1", "### New Features ✨\n- Prerelease", {
            prerelease: true,
          }),
        ]),
      ),
    );
    const output = formatReleaseNotes((await fetchReleaseNotes(stable))!);
    expect(output).toContain("Project picker");
    expect(output).toContain("#123");
    expect(output).toContain("Reader position");
    expect(output).toContain("Faster loading");
    for (const hidden of [
      "Future feature",
      "Private refactor",
      "Already installed",
      "Draft",
      "Prerelease",
    ])
      expect(output).not.toContain(hidden);
  });

  test("preserves literal identifiers and glob patterns in release titles", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json([
            release(
              "0.42.0",
              "### Bug Fixes\n- Preserve `user_name` and `src/*` paths",
            ),
          ]),
        ),
    );
    const output = formatReleaseNotes((await fetchReleaseNotes(stable))!);
    expect(output).toContain("user_name");
    expect(output).toContain("src/*");
  });

  test("paginates stable releases instead of omitting older patches", async () => {
    const fetcher = vi.fn(async (input: string | URL) =>
      Response.json(
        new URL(input).searchParams.get("page") === "1"
          ? Array.from({ length: 100 }, () => release("0.50.0", ""))
          : [release("0.41.0", "### Bug Fixes 🐛\n- An older patch fix")],
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    expect(formatReleaseNotes((await fetchReleaseNotes(stable))!)).toContain(
      "An older patch fix",
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test("uses exact nightly commit bounds and conventional feature/fix/performance titles", async () => {
    vi.stubGlobal(
      "fetch",
      nightlyFetch([
        "feat(ui)!: Add project picker (#123)\n\nLong body",
        "fix: Retain position (#124)",
        "perf(core): Speed up recall",
        "docs: Internal instructions",
        "chore: Build nightly",
        "feat: hidden #skip-changelog",
      ]),
    );
    const notes = (await fetchReleaseNotes(nightly))!;
    const output = formatReleaseNotes(notes);
    expect(notes.url).toBe(
      `https://github.com/BYK/loreai/compare/${fromSha}...${toSha}`,
    );
    for (const title of [
      "Add project picker (#123)",
      "Retain position (#124)",
      "Speed up recall",
    ])
      expect(output).toContain(title);
    for (const hidden of [
      "Long body",
      "Internal instructions",
      "Build nightly",
      "hidden",
    ])
      expect(output).not.toContain(hidden);
  });

  test("resolves nightlies exactly when another main commit lands one second later", async () => {
    const adjacent = "c".repeat(40);
    const commits: Record<string, { sha: string; date: string }> = {
      "2023-11-14T22:13:20.000Z": {
        sha: fromSha,
        date: "2023-11-14T22:13:20Z",
      },
      "2023-11-14T22:13:21.000Z": {
        sha: adjacent,
        date: "2023-11-14T22:13:21Z",
      },
      "2023-11-14T22:30:00.000Z": { sha: toSha, date: "2023-11-14T22:30:00Z" },
      "2023-11-14T22:30:01.000Z": {
        sha: adjacent,
        date: "2023-11-14T22:30:01Z",
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = new URL(input);
        if (url.pathname.endsWith("/commits")) {
          const commit = commits[url.searchParams.get("until")!];
          if (!commit) throw new Error("Unexpected commit cutoff");
          return Response.json([
            { sha: commit.sha, commit: { committer: { date: commit.date } } },
          ]);
        }
        expect(url.pathname).toBe(
          `/repos/BYK/loreai/compare/${fromSha}...${toSha}`,
        );
        return Response.json({
          status: "ahead",
          total_commits: 1,
          commits: [commit("fix: Include the actual nightly change")],
        });
      }),
    );
    const notes = (await fetchReleaseNotes(nightly))!;
    expect(formatReleaseNotes(notes)).toContain(
      "Include the actual nightly change",
    );
    expect(notes.url).toBe(
      `https://github.com/BYK/loreai/compare/${fromSha}...${toSha}`,
    );
  });

  test("does not guess a nightly revision when two commits share its timestamp", async () => {
    const resolve = nightlyFetch();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = new URL(input);
        if (
          url.pathname.endsWith("/commits") &&
          url.searchParams.get("until") === "2023-11-14T22:13:20.000Z"
        ) {
          const commits = [
            {
              sha: fromSha,
              commit: { committer: { date: "2023-11-14T22:13:20Z" } },
            },
            {
              sha: "c".repeat(40),
              commit: { committer: { date: "2023-11-14T22:13:20Z" } },
            },
          ];
          return Response.json(
            url.searchParams.get("per_page") === "2"
              ? commits
              : commits.slice(0, 1),
          );
        }
        return resolve(input);
      }),
    );
    const notes = (await fetchReleaseNotes(nightly))!;
    expect(notes.entries).toEqual([]);
    expect(notes.url).toBe("https://github.com/BYK/loreai/commits/main");
  });

  test("accepts a unique nightly timestamp when the preceding commit is older", async () => {
    const resolve = nightlyFetch();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const response = await resolve(input);
        const url = new URL(input);
        if (!url.pathname.endsWith("/commits")) return response;
        const commits = await response.json();
        const target =
          url.searchParams.get("until") === "2023-11-14T22:30:00.000Z";
        return Response.json([
          ...commits,
          {
            sha: "c".repeat(40),
            commit: {
              committer: {
                date: target ? "2023-11-14T22:29:59Z" : "2023-11-14T22:13:19Z",
              },
            },
          },
        ]);
      }),
    );
    expect(formatReleaseNotes((await fetchReleaseNotes(nightly))!)).toContain(
      "Add project picker (#123)",
    );
  });

  test("paginates the exact nightly comparison", async () => {
    const resolve = nightlyFetch();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = new URL(input);
        if (!url.pathname.includes("/compare/")) return resolve(input);
        return Response.json({
          status: "ahead",
          total_commits: 101,
          commits:
            url.searchParams.get("page") === "1"
              ? Array.from({ length: 100 }, () => commit("chore: Build"))
              : [commit("fix: Last page repair")],
        });
      }),
    );
    expect(formatReleaseNotes((await fetchReleaseNotes(nightly))!)).toContain(
      "Last page repair",
    );
  });

  test("nightly to stable shows the exact commit delta instead of replaying the whole stable release", async () => {
    const resolve = nightlyFetch(["feat: Newly added feature"]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = new URL(input);
        if (url.pathname.endsWith("/commits/1.0.0"))
          return Response.json({ sha: toSha });
        if (url.pathname.endsWith("/releases"))
          return Response.json([
            release(
              "1.0.0",
              "### New Features\n- Already in nightly\n- Newly added feature",
            ),
          ]);
        return resolve(input);
      }),
    );
    const output = formatReleaseNotes(
      (await fetchReleaseNotes({
        channel: "stable",
        fromVersion: nightly.fromVersion,
        toVersion: "1.0.0",
      }))!,
    );
    expect(output).toContain("Newly added feature");
    expect(output).not.toContain("Already in nightly");
  });

  test("prioritizes the newest nightly pages within its request budget", async () => {
    const resolve = nightlyFetch();
    const pages: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = new URL(input);
        if (!url.pathname.includes("/compare/")) return resolve(input);
        const page = url.searchParams.get("page")!;
        pages.push(page);
        return Response.json({
          status: "ahead",
          total_commits: 401,
          commits:
            page === "5"
              ? [commit("feat: Latest release feature")]
              : Array.from({ length: 100 }, (_, i) =>
                  commit(
                    page === "4"
                      ? `fix: Recent repair ${i}`
                      : `feat: Old change ${i}`,
                  ),
                ),
        });
      }),
    );
    const output = formatReleaseNotes((await fetchReleaseNotes(nightly))!);
    expect(output).toContain("Latest release feature");
    expect(output).toContain("Recent repair 99");
    expect(output).not.toContain("Old change");
    expect(pages).toEqual(["1", "5", "4"]);
  });

  test("does not attribute an unresolvable nightly timestamp to a nearby commit", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      Response.json([
        {
          sha: fromSha,
          commit: { committer: { date: "2023-11-14T22:13:19Z" } },
        },
      ]),
    );
    vi.stubGlobal("fetch", fetcher);
    const notes = (await fetchReleaseNotes(nightly))!;
    expect(notes.entries).toEqual([]);
    expect(
      fetcher.mock.calls.every(([url]) => !String(url).includes("/compare/")),
    ).toBe(true);
  });

  test("resolves a stable base when switching to nightly", async () => {
    const resolve = nightlyFetch();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) =>
        new URL(input).pathname.endsWith("/commits/0.40.0")
          ? Response.json({ sha: fromSha })
          : resolve(input),
      ),
    );
    expect(
      formatReleaseNotes(
        (await fetchReleaseNotes({ ...nightly, fromVersion: "0.40.0" }))!,
      ),
    ).toContain("Add project picker");
  });

  test.each(["same", "downgrade", "invalid"])(
    "skips notes for %s versions",
    async (which) => {
      const fetcher = vi.fn();
      vi.stubGlobal("fetch", fetcher);
      const toVersion =
        which === "same"
          ? "0.40.0"
          : which === "downgrade"
            ? "0.39.0"
            : "not-a-version";
      expect(await fetchReleaseNotes({ ...stable, toVersion })).toBeNull();
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  test.each(["network", "rate limit", "malformed", "oversized"])(
    "returns a link rather than failing on %s",
    async (kind) => {
      const fetcher =
        kind === "network"
          ? vi.fn().mockRejectedValue(new Error("network"))
          : vi
              .fn()
              .mockResolvedValue(
                kind === "rate limit"
                  ? new Response("rate limited", { status: 403 })
                  : kind === "oversized"
                    ? new Response("x".repeat(3_000_000))
                    : Response.json({ invalid: true }),
              );
      vi.stubGlobal("fetch", fetcher);
      const notes = (await fetchReleaseNotes(stable))!;
      expect(notes.entries).toEqual([]);
      expect(formatReleaseNotes(notes)).toContain(
        "https://github.com/BYK/loreai/releases/tag/0.42.0",
      );
    },
  );

  test("hostile unmatched markdown does not block the notes deadline", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json([
            release("0.42.0", "### Bug Fixes\n- " + "[x".repeat(100_000)),
          ]),
        ),
    );
    const started = performance.now();
    const notes = await fetchReleaseNotes(stable);
    expect(performance.now() - started).toBeLessThan(2500);
    expect(notes?.entries[0].title.length).toBeLessThanOrEqual(240);
  });

  test.each([false, true])(
    "many malformed titles stay within the deadline (duplicates=%s)",
    async (duplicates) => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockImplementation(() =>
            Response.json(
              Array.from({ length: 100 }, (_, i) =>
                release(
                  `0.41.${i}`,
                  "### Bug Fixes\n" +
                    Array.from(
                      { length: 5 },
                      (_, j) =>
                        `- ${duplicates ? "Same" : `Entry ${i}-${j}`} ${"[x".repeat(1900)}`,
                    ).join("\n"),
                ),
              ),
            ),
          ),
      );
      const started = performance.now();
      const notes = await fetchReleaseNotes(stable);
      expect(performance.now() - started).toBeLessThan(2500);
      expect(notes?.entries.length).toBe(duplicates ? 1 : 15);
    },
  );

  test("a pinned nightly uses commit notes even when the saved channel is stable", async () => {
    const resolve = nightlyFetch();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) =>
        new URL(input).pathname.endsWith("/commits/0.40.0")
          ? Response.json({ sha: fromSha })
          : resolve(input),
      ),
    );
    const notes = (await fetchReleaseNotes({
      ...nightly,
      channel: "stable",
      fromVersion: "0.40.0",
    }))!;
    expect(formatReleaseNotes(notes)).toContain("Add project picker");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const fallback = (await fetchReleaseNotes({
      ...nightly,
      channel: "stable",
      fromVersion: "0.40.0",
    }))!;
    expect(fallback.url).toBe("https://github.com/BYK/loreai/commits/main");
  });

  test("bounds the complete notes request even if fetch ignores cancellation", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    const pending = fetchReleaseNotes(stable);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await pending)?.entries).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("limits duplicate and long terminal output, ignores fenced fake sections and strips control characters", async () => {
    const body =
      "```md\n### New Features\n- Fake fenced feature\n```\n### New Features ✨\n- Safe\u001b[31m title\u001b[0m\u202e\n- Safe title\n" +
      Array.from(
        { length: 30 },
        (_, i) => `- Feature ${i} ${"x".repeat(600)}`,
      ).join("\n");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json([release("0.42.0", body)])),
    );
    const notes = (await fetchReleaseNotes(stable))!;
    const output = formatReleaseNotes(notes);
    expect(output).not.toContain("Fake fenced feature");
    expect(output).not.toContain(String.fromCharCode(27));
    expect(output).not.toContain("\u202e");
    expect(output.match(/Safe title/g)).toHaveLength(1);
    expect(notes.entries.length).toBeLessThanOrEqual(15);
    expect(output.length).toBeLessThan(5000);
    expect(output).toContain("Full changes:");
  });
});
