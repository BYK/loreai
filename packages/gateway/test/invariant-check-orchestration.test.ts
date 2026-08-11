import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock("@loreai/core");
  vi.doUnmock("../src/llm-adapter");
  vi.doUnmock("../src/cli/start");
  vi.resetModules();
});

describe("runSemanticLint cancellation", () => {
  it("preserves typed diff limit failures in the published report", async () => {
    const range = { base: "base", head: "head", source: "test" };
    const startGateway = vi.fn();
    vi.doMock("@loreai/core", () => ({
      config: () => ({
        model: undefined,
        invariantCheck: { effort: "off" },
      }),
      embedding: {},
      importLoreFile: vi.fn(),
      invariantCheck: {
        resolveRange: () => range,
        parseDiffResult: () => ({
          kind: "failure",
          failure: {
            code: "diff-too-large",
            message: "too many hunks",
          },
        }),
      },
      parseReasoningEffort: vi.fn(),
    }));
    vi.doMock("../src/llm-adapter", () => ({
      createGatewayLLMClient: () => ({}),
      createGatewayInvariantJudge: () => ({}),
    }));
    vi.doMock("../src/cli/start", () => ({ startGateway }));

    const { runSemanticLint } = await import("../src/cli/invariant-check");
    const report = await runSemanticLint({
      project: ".",
      gate: false,
      importLoreMd: false,
      deadlineMs: 1_000,
      candidateTimeoutMs: 100,
    });

    expect(report.health.diff).toMatchObject({
      status: "failed",
      failure: { code: "diff-too-large", message: "too many hunks" },
    });
    expect(startGateway).not.toHaveBeenCalled();
  });

  it("attributes expiry after range resolution to the diff phase", async () => {
    let now = 0;
    const range = { base: "base", head: "head", source: "test" };
    const parseDiffResult = vi.fn();
    const startGateway = vi.fn();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.doMock("@loreai/core", () => ({
      config: () => ({
        model: undefined,
        invariantCheck: { effort: "off" },
      }),
      embedding: {},
      importLoreFile: vi.fn(),
      invariantCheck: {
        resolveRange: () => {
          now = 10;
          return range;
        },
        parseDiffResult,
      },
      parseReasoningEffort: vi.fn(),
    }));
    vi.doMock("../src/llm-adapter", () => ({
      createGatewayLLMClient: () => ({}),
      createGatewayInvariantJudge: () => ({}),
    }));
    vi.doMock("../src/cli/start", () => ({ startGateway }));

    const published: unknown[] = [];
    const { runSemanticLint } = await import("../src/cli/invariant-check");
    const report = await runSemanticLint({
      project: ".",
      gate: false,
      importLoreMd: false,
      deadlineMs: 5,
      candidateTimeoutMs: 100,
      publishReport: (value) => {
        published.push(value);
      },
    });

    expect(report.range).toEqual(range);
    expect(report.health.range.status).toBe("healthy");
    expect(report.health.diff.failure?.code).toBe("deadline-exceeded");
    expect(published).toEqual([report]);
    expect(parseDiffResult).not.toHaveBeenCalled();
    expect(startGateway).not.toHaveBeenCalled();
  });

  it("threads its deadline into core and publishes a failed report before cleanup", async () => {
    const events: string[] = [];
    const range = { base: "base", head: "head", source: "test" };
    const checkInvariants = vi.fn(async (input: Record<string, unknown>) => {
      const signal = input.signal as AbortSignal;
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(input.deadlineMs).toEqual(expect.any(Number));
      expect(input.deadlineMs).toBeGreaterThanOrEqual(0);
      if (!signal.aborted) {
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      }
      return {
        range,
        status: "failed",
        health: {
          diff: { status: "healthy", hunks: 1 },
          invariantVectors: {
            status: "healthy",
            expected: 1,
            available: 1,
            missing: 0,
          },
          hunkVectors: {
            status: "failed",
            expected: 1,
            available: 0,
            missing: 1,
            failure: {
              code: "hunk-vector-embedding-failed",
              message: "Hunk embedding deadline exceeded",
            },
          },
          judge: {
            status: "not-run",
            selected: 0,
            resolved: 0,
            unresolved: 0,
            notAttempted: 0,
          },
        },
        hunks: 1,
        invariants: 1,
        candidates: 0,
        attempted: 0,
        resolved: 0,
        unresolved: 0,
        notAttempted: 0,
        semanticCalls: 0,
        transportAttempts: 0,
        candidateOutcomes: [],
        findings: [],
      };
    });
    vi.doMock("@loreai/core", () => ({
      config: () => ({
        model: undefined,
        invariantCheck: { effort: "off" },
      }),
      embedding: {},
      importLoreFile: vi.fn(),
      invariantCheck: {
        resolveRange: () => range,
        parseDiffResult: () => ({ kind: "success", hunks: [{}] }),
        checkInvariants,
        collectCommitMessages: () => [],
        parseOverrides: () => [],
        gateDecision: () => ({
          mode: "advisory",
          exitCode: 0,
          blocking: [],
          overridden: [],
          advisory: [],
        }),
      },
      parseReasoningEffort: vi.fn(),
    }));
    vi.doMock("../src/llm-adapter", () => ({
      createGatewayLLMClient: () => ({}),
      createGatewayInvariantJudge: () => ({}),
    }));
    vi.doMock("../src/cli/start", () => ({
      startGateway: async () => ({
        owned: true,
        config: {
          workerApiKey: undefined,
          upstreamAnthropic: "http://anthropic.test",
          upstreamOpenAI: "http://openai.test",
        },
        shutdown: async () => {
          events.push("cleanup");
        },
      }),
    }));

    const { runSemanticLint } = await import("../src/cli/invariant-check");
    const report = await runSemanticLint({
      project: ".",
      gate: false,
      importLoreMd: false,
      deadlineMs: 20,
      candidateTimeoutMs: 100,
      publishReport: (published) => {
        events.push("publish");
        expect(published.status).toBe("failed");
      },
    });

    expect(checkInvariants).toHaveBeenCalledOnce();
    expect(report.status).toBe("failed");
    expect(events).toEqual(["publish", "cleanup"]);
  });

  it.each([
    { name: "zero hunks", hunks: [] },
    { name: "zero enforceable invariants", hunks: [{}] },
  ])(
    "publishes deadline failure before cleanup when expiry precedes core with $name",
    async ({ hunks }) => {
      const events: string[] = [];
      const range = { base: "base", head: "head", source: "test" };
      const checkInvariants = vi.fn(async () => ({
        range,
        status: "complete",
        health: {
          diff: { status: "healthy", hunks: hunks.length },
          invariantVectors: {
            status: "healthy",
            expected: 0,
            available: 0,
            missing: 0,
          },
          hunkVectors: {
            status: "healthy",
            expected: hunks.length,
            available: hunks.length,
            missing: 0,
          },
          judge: {
            status: "healthy",
            selected: 0,
            resolved: 0,
            unresolved: 0,
            notAttempted: 0,
          },
        },
        hunks: hunks.length,
        invariants: 0,
        candidates: 0,
        attempted: 0,
        resolved: 0,
        unresolved: 0,
        notAttempted: 0,
        semanticCalls: 0,
        transportAttempts: 0,
        candidateOutcomes: [],
        findings: [],
      }));
      vi.doMock("@loreai/core", () => ({
        config: () => ({
          model: undefined,
          invariantCheck: { effort: "off" },
        }),
        embedding: {},
        importLoreFile: vi.fn(),
        invariantCheck: {
          resolveRange: () => range,
          parseDiffResult: () => ({ kind: "success", hunks }),
          checkInvariants,
          collectCommitMessages: () => [],
          parseOverrides: () => [],
          gateDecision: () => ({
            mode: "advisory",
            exitCode: 0,
            blocking: [],
            overridden: [],
            advisory: [],
          }),
        },
        parseReasoningEffort: vi.fn(),
      }));
      vi.doMock("../src/llm-adapter", () => ({
        createGatewayLLMClient: () => ({}),
        createGatewayInvariantJudge: () => ({}),
      }));
      vi.doMock("../src/cli/start", () => ({
        startGateway: async () => {
          await new Promise((resolve) => setTimeout(resolve, 25));
          return {
            owned: true,
            config: {
              workerApiKey: undefined,
              upstreamAnthropic: "http://anthropic.test",
              upstreamOpenAI: "http://openai.test",
            },
            shutdown: async () => {
              events.push("cleanup");
            },
          };
        },
      }));

      const { runSemanticLint } = await import("../src/cli/invariant-check");
      const report = await runSemanticLint({
        project: ".",
        gate: false,
        importLoreMd: false,
        deadlineMs: 5,
        candidateTimeoutMs: 100,
        publishReport: (published) => {
          events.push("publish");
          expect(published.status).toBe("failed");
          expect(published.health.invariantSource.failure?.code).toBe(
            "deadline-exceeded",
          );
        },
      });

      expect(checkInvariants).not.toHaveBeenCalled();
      expect(report.status).toBe("failed");
      expect(report.health.invariantSource.failure?.code).toBe(
        "deadline-exceeded",
      );
      expect(events).toEqual(["publish", "cleanup"]);
    },
  );
});
