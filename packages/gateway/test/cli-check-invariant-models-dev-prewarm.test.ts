import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";

// ---- Mocks (hoisted) -------------------------------------------------------
// Capture the order in which the lint CLI awaits fetchModelData vs. fires the
// judge (checkInvariants). The race the fix closes: pipeline init kicks off
// `fetchModelData()` fire-and-forget (pipeline.ts:2836), so the first batch of
// judge calls runs against an empty models.dev cache. With an empty cache
// `getModelEntrySync("gpt-5-mini")` returns the FALLBACK entry (no
// reasoning_options), `workerModelReasons` returns false (the
// `isAnthropicClaudeModel` fallback misses non-Claude reasoning models), and
// the worker's reasoning-headroom floor is 0 → judge budget stays at the
// caller's tiny `judgeMaxTokens(off) = 256` → `gpt-5-mini` burns the entire
// budget on hidden reasoning (`reasoning_tokens: 256`) and emits no visible
// text → `parseInvariantVerdict` returns null → "20/20 unparseable".
//
// Without the fix: `checkInvariants` fires before `fetchModelData` resolves →
// cache still empty → budget stays at 256 → bug reproduces.
// With the fix: the CLI awaits `fetchModelData` before invoking the judge →
// cache populated by the time the first judge call dispatches → floor applies
// → budget = 24576 → model returns parseable JSON.

const { events, fetchModelDataMock, startGatewayMock } = vi.hoisted(() => {
  const events: string[] = [];
  return {
    events,
    fetchModelDataMock: vi.fn(async () => {
      events.push("fetchModelData:start");
      await new Promise((r) => setTimeout(r, 30));
      events.push("fetchModelData:resolve");
      return new Map();
    }),
    startGatewayMock: vi.fn(async () => {
      // Simulates the bug surface: pipeline init kicks off the pre-warm
      // fire-and-forget. Real `startGateway` does the same (pipeline.ts:2836).
      void fetchModelDataMock();
      events.push("startGateway:resolve");
      return {
        config: {
          upstreamAnthropic: "https://api.anthropic.com",
          upstreamOpenAI: "https://api.openai.com",
          workerApiKey: undefined,
        },
        owned: true,
        shutdown: async () => {},
      };
    }),
  };
});

vi.mock("../src/worker-model", () => ({
  fetchModelData: fetchModelDataMock,
  getModelEntrySync: () => ({}),
}));

vi.mock("../src/cli/start", () => ({
  startGateway: startGatewayMock,
}));

vi.mock("@loreai/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@loreai/core")>();
  return {
    ...actual,
    invariantCheck: {
      ...actual.invariantCheck,
      checkInvariants: vi.fn(async () => {
        events.push("checkInvariants:called");
        return {
          base: "x",
          head: "y",
          findings: [],
          judgeCalls: 0,
          unparseable: 0,
          candidates: 0,
          costUsd: 0,
        } as unknown as Awaited<
          ReturnType<typeof actual.invariantCheck.checkInvariants>
        >;
      }),
      parseDiff: () => [],
      parseOverrides: () => [],
      resolveRange: () => ({ base: "x", head: "y", source: "test" }),
    },
  };
});

vi.mock("../src/llm-adapter", () => ({
  createGatewayLLMClient: () => ({
    prompt: async () => "",
  }),
}));

vi.mock("../src/cli/exit", () => ({
  safeExit: vi.fn(),
}));

import { _cli } from "../src/cli/main";

describe("lore lint CLI: pre-warm race for models.dev", () => {
  const origArgv = process.argv;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    events.length = 0;
    fetchModelDataMock.mockClear();
    startGatewayMock.mockClear();
    process.env.LORE_WORKER_API_KEY = "test-key";
    process.argv = [
      "node",
      "lore",
      "lint",
      "--base",
      "x",
      "--head",
      "y",
      "--model",
      "github-copilot/gpt-5-mini",
    ];
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__exit:${code}`);
    }) as never);
  });

  afterEach(() => {
    delete process.env.LORE_WORKER_API_KEY;
    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  afterAll(() => {
    process.argv = origArgv;
  });

  test("fetchModelData is awaited BEFORE checkInvariants fires (closes the pre-warm race)", async () => {
    try {
      await _cli();
    } catch {
      // _cli may exit non-zero on tooling errors; we only care about timing.
    }

    const fetchResolveIdx = events.indexOf("fetchModelData:resolve");
    const checkInvariantsIdx = events.indexOf("checkInvariants:called");

    // The CLI must explicitly await fetchModelData (the fix). Without it,
    // the pre-warm is fire-and-forget from `startGateway` and the
    // `fetchModelData:resolve` event never fires before the test ends.
    expect(fetchResolveIdx).toBeGreaterThanOrEqual(0);
    expect(checkInvariantsIdx).toBeGreaterThanOrEqual(0);
    expect(checkInvariantsIdx).toBeGreaterThan(fetchResolveIdx);
  });
});
