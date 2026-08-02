/**
 * Phase 3A.3 — recall multiword fix + typed command regression.
 *
 * Pins the pre-3A.3 bug where `commandRecall` only read `positionals[0]`,
 * silently dropping every token after the first word of a multiword query.
 * The fix joins all positionals with a single space.
 *
 * The harness mocks `@loreai/core`'s `runRecall` so the test runs without
 * the database, embedding model, or Supabase connection. The point is to
 * assert the *query string* the command passes through to the search
 * engine, not the search itself.
 */
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";

vi.mock("../src/cli/lib/version-check", () => ({
  shouldSuppressNotification: () => true,
  maybeCheckForUpdateInBackground: () => {},
  getUpdateNotification: () => null,
  abortPendingVersionCheck: () => {},
}));

// Capture the query string that the legacy command hands to runRecall so we
// can assert positional joining. Hoisted so the mock factory can populate it.
let lastQuery: string | undefined;
let lastScope: string | undefined;
let lastSessionID: string | undefined;

vi.mock("@loreai/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@loreai/core")>();
  return {
    ...actual,
    runRecall: async (input: {
      query: string;
      scope: string;
      projectPath: string;
      sessionID?: string;
      searchConfig?: unknown;
      recordTransfers?: boolean;
    }) => {
      lastQuery = input.query;
      lastScope = input.scope;
      lastSessionID = input.sessionID;
      // No DB hit: return an empty RecallResult shape that the legacy
      // command will JSON.stringify without further IO.
      return {
        query: input.query,
        scope: input.scope,
        projectPath: input.projectPath,
        hits: [],
        formatters: { text: "" },
        result: "",
      } as never;
    },
    config: () => ({
      search: {
        // Anything here is echoed into lastSearchConfig.
        bm25: { k1: 0, b: 0 },
      },
    }),
  };
});

import { commandRecall } from "../src/cli/recall-cmd";

async function runRecall(
  positionals: string[],
  values: Record<string, unknown>,
): Promise<{ stdout: string; exitCode: number | null }> {
  const chunks: Buffer[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    return true;
  });
  const priorExitCode = process.exitCode;
  process.exitCode = 0;
  try {
    await commandRecall(positionals, values);
  } finally {
    spy.mockRestore();
  }
  const exitCode = process.exitCode;
  process.exitCode = priorExitCode;
  return { stdout: Buffer.concat(chunks).toString("utf8"), exitCode };
}

describe("Phase 3A.3 — recall multiword fix", () => {
  afterEach(() => {
    lastQuery = undefined;
    lastScope = undefined;
    lastSessionID = undefined;
  });

  afterAll(() => {});

  test("single word passes through unchanged", async () => {
    await runRecall(["auth"], {});
    expect(lastQuery).toBe("auth");
  });

  test("multiword query is joined with single spaces (the regression)", async () => {
    await runRecall(["error", "handling"], {});
    expect(lastQuery).toBe("error handling");
  });

  test("three-word query is joined (the documented limitation)", async () => {
    await runRecall(["how", "do", "I", "remember"], {});
    expect(lastQuery).toBe("how do I remember");
  });

  test("--scope session without --session returns UsageError-shape exitCode=1", async () => {
    const priorExitCode = process.exitCode;
    process.exitCode = 0;
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: number,
    ) => {
      throw new Error(`__exit:${code}`);
    }) as never);
    try {
      await expect(runRecall(["auth"], { scope: "session" })).rejects.toThrow(
        "__exit:1",
      );
    } finally {
      exitSpy.mockRestore();
      process.exitCode = priorExitCode;
    }
  });

  test("--scope session with --session reaches runRecall with both values", async () => {
    await runRecall(["auth"], { scope: "session", session: "session-abc" });
    expect(lastScope).toBe("session");
    expect(lastSessionID).toBe("session-abc");
  });
});
