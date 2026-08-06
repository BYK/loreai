import { afterEach, describe, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  calls: [] as Array<{
    positionals: string[];
    values: Record<string, unknown>;
  }>,
}));

vi.mock("../src/cli/recall-cmd", () => ({
  commandRecall: async (
    positionals: string[],
    values: Record<string, unknown>,
  ) => {
    state.calls.push({ positionals: [...positionals], values: { ...values } });
  },
}));

vi.mock("../src/cli/lib/version-check", () => ({
  shouldSuppressNotification: () => true,
  maybeCheckForUpdateInBackground: () => {},
  getUpdateNotification: () => null,
  abortPendingVersionCheck: () => {},
}));

const priorArgv = process.argv;

afterEach(() => {
  state.calls.length = 0;
  process.argv = priorArgv;
  process.exitCode = undefined;
});

describe("lore recall typed route", () => {
  test("routes a multiword query through Stricli", async () => {
    const { runCli } = await import("../src/cli/cli");
    process.argv = ["node", "lore", "recall", "error", "handling"];

    await runCli();

    expect(state.calls).toEqual([
      {
        positionals: ["error", "handling"],
        values: { json: false },
      },
    ]);
  });

  test("forwards every declared flag", async () => {
    const { runCli } = await import("../src/cli/cli");
    process.argv = [
      "node",
      "lore",
      "recall",
      "auth",
      "--project",
      "/project",
      "--scope",
      "session",
      "--session",
      "session-id",
      "--limit",
      "3",
      "--json",
    ];

    await runCli();

    expect(state.calls[0]).toEqual({
      positionals: ["auth"],
      values: {
        json: true,
        project: "/project",
        scope: "session",
        session: "session-id",
        limit: 3,
      },
    });
  });

  test.each([
    ["--scope", "bogus"],
    ["--limit", "0"],
    ["--limit", "-1"],
    ["--limit", "1.5"],
    ["--limit", "51"],
    ["--limit", "abc"],
  ])("rejects invalid recall input: %s %s", async (flag, value) => {
    const { runCli } = await import("../src/cli/cli");
    process.argv = ["node", "lore", "recall", "auth", flag, value];

    await runCli();

    expect(state.calls).toEqual([]);
    expect(process.exitCode).toBe(20);
  });

  test.each([
    [[], {}, "Please provide a search query."],
    [
      ["auth"],
      { scope: "session" },
      "--scope session requires --session <id>.",
    ],
  ])(
    "rejects semantic recall misuse before legacy handling",
    async (positionals, values, message) => {
      const { runCli } = await import("../src/cli/cli");
      const originalStderrWrite = process.stderr.write;
      const stderr: string[] = [];
      process.stderr.write = (chunk: unknown) => {
        stderr.push(String(chunk));
        return true;
      };
      process.argv = [
        "node",
        "lore",
        "recall",
        ...positionals,
        ...Object.entries(values).flatMap(([flag, value]) => [
          `--${flag}`,
          value,
        ]),
      ];

      try {
        await runCli();
      } finally {
        process.stderr.write = originalStderrWrite;
      }

      expect(state.calls).toEqual([]);
      expect(process.exitCode).toBe(20);
      expect(stderr.join("")).toContain(message);
    },
  );

  test("is no longer routed through the legacy dispatcher", async () => {
    const { LEGACY_ROUTES } = await import("../src/cli/app");
    expect(LEGACY_ROUTES.has("recall")).toBe(false);
  });
});
