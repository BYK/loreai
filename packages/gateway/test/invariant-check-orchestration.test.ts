import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock("@loreai/core");
  vi.doUnmock("node:fs");
  vi.doUnmock("../src/llm-adapter");
  vi.doUnmock("../src/cli/start");
  vi.resetModules();
});

describe("runSemanticLint cancellation", () => {
  it("proves embedding readiness before importing invariant fan-out", async () => {
    const events: string[] = [];
    const range = { base: "base", head: "head", source: "test" };
    let releaseReadiness: (() => void) | undefined;
    const readiness = new Promise<void>((resolve) => {
      releaseReadiness = resolve;
    });
    const ensureEmbeddingReady = vi.fn(async () => {
      events.push("readiness-start");
      await readiness;
      events.push("readiness-complete");
    });
    const importLoreFile = vi.fn(() => events.push("import"));
    const settleDocumentEmbeds = vi.fn(async () => events.push("settle"));
    const backfillEmbeddings = vi.fn(async () => {
      events.push("backfill");
      return 1;
    });
    const checkInvariants = vi.fn(async () => {
      events.push("check");
      return {
        range,
        status: "complete",
        health: {
          diff: { status: "healthy", hunks: 1 },
          invariantVectors: {
            status: "healthy",
            expected: 1,
            available: 1,
            missing: 0,
          },
          hunkVectors: {
            status: "healthy",
            expected: 1,
            available: 1,
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
    vi.doMock("node:fs", () => ({ existsSync: () => true }));
    vi.doMock("@loreai/core", () => ({
      config: () => ({
        model: undefined,
        invariantCheck: { effort: "off" },
      }),
      embedding: {
        ensureEmbeddingReady,
        settleDocumentEmbeds,
        backfillEmbeddings,
      },
      importLoreFile,
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
      startGateway: async () => {
        events.push("gateway");
        return {
          owned: true,
          config: {
            workerApiKey: undefined,
            upstreamAnthropic: "http://anthropic.test",
            upstreamOpenAI: "http://openai.test",
          },
          shutdown: async () => events.push("cleanup"),
        };
      },
    }));

    const { runSemanticLint } = await import("../src/cli/invariant-check");
    const pending = runSemanticLint({
      project: ".",
      gate: false,
      importLoreMd: true,
      deadlineMs: 1_000,
      candidateTimeoutMs: 100,
    });
    await vi.waitFor(() => expect(ensureEmbeddingReady).toHaveBeenCalledOnce());
    expect(events).toEqual(["gateway", "readiness-start"]);
    expect(importLoreFile).not.toHaveBeenCalled();

    releaseReadiness?.();
    await expect(pending).resolves.toMatchObject({ status: "complete" });
    expect(events).toEqual([
      "gateway",
      "readiness-start",
      "readiness-complete",
      "import",
      "settle",
      "backfill",
      "check",
      "cleanup",
    ]);
  });

  it("completes zero-hunk work without gateway, import, or embeddings", async () => {
    const range = { base: "base", head: "head", source: "test" };
    const ensureEmbeddingReady = vi.fn(async () => {
      throw new Error("provider unavailable");
    });
    const importLoreFile = vi.fn();
    const startGateway = vi.fn();
    const checkInvariants = vi.fn(async () => ({
      range,
      status: "complete",
      health: {
        diff: { status: "healthy", hunks: 0 },
        invariantVectors: {
          status: "healthy",
          expected: 0,
          available: 0,
          missing: 0,
        },
        hunkVectors: {
          status: "healthy",
          expected: 0,
          available: 0,
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
      hunks: 0,
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
    vi.doMock("node:fs", () => ({ existsSync: () => false }));
    vi.doMock("@loreai/core", () => ({
      config: () => ({
        model: undefined,
        invariantCheck: { effort: "off" },
      }),
      embedding: { ensureEmbeddingReady },
      importLoreFile,
      invariantCheck: {
        resolveRange: () => range,
        parseDiffResult: () => ({ kind: "success", hunks: [] }),
        checkInvariants,
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
      createGatewayLLMClient: vi.fn(),
      createGatewayInvariantJudge: vi.fn(),
    }));
    vi.doMock("../src/cli/start", () => ({ startGateway }));

    const { runSemanticLint } = await import("../src/cli/invariant-check");
    const report = await runSemanticLint({
      project: ".",
      gate: false,
      importLoreMd: true,
      deadlineMs: 1_000,
      candidateTimeoutMs: 100,
    });

    expect(report.status).toBe("complete");
    expect(checkInvariants).toHaveBeenCalledOnce();
    expect(startGateway).not.toHaveBeenCalled();
    expect(importLoreFile).not.toHaveBeenCalled();
    expect(ensureEmbeddingReady).not.toHaveBeenCalled();
  });

  it("reports readiness failure before import and cleanup", async () => {
    const events: string[] = [];
    const range = { base: "base", head: "head", source: "test" };
    const importLoreFile = vi.fn();
    const ensureEmbeddingReady = vi.fn(async () => {
      throw new Error("provider did not recover");
    });
    vi.doMock("@loreai/core", () => ({
      config: () => ({
        model: undefined,
        invariantCheck: { effort: "off" },
      }),
      embedding: { ensureEmbeddingReady },
      importLoreFile,
      invariantCheck: {
        resolveRange: () => range,
        parseDiffResult: () => ({ kind: "success", hunks: [{}] }),
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
        shutdown: async () => events.push("cleanup"),
      }),
    }));

    const { runSemanticLint } = await import("../src/cli/invariant-check");
    const report = await runSemanticLint({
      project: ".",
      gate: false,
      importLoreMd: true,
      deadlineMs: 1_000,
      candidateTimeoutMs: 100,
      publishReport: () => {
        events.push("publish");
      },
    });

    expect(report.health.invariantSource).toMatchObject({
      status: "failed",
      failure: {
        code: "embedding-provider-readiness-failed",
        message: "provider did not recover",
      },
    });
    expect(importLoreFile).not.toHaveBeenCalled();
    expect(events).toEqual(["publish", "cleanup"]);
  });

  it("reports a missing invariant source before gateway or embedding startup", async () => {
    const range = { base: "base", head: "head", source: "test" };
    const ensureEmbeddingReady = vi.fn();
    const startGateway = vi.fn();
    vi.doMock("node:fs", () => ({ existsSync: () => false }));
    vi.doMock("@loreai/core", () => ({
      config: () => ({
        model: undefined,
        invariantCheck: { effort: "off" },
      }),
      embedding: { ensureEmbeddingReady },
      importLoreFile: vi.fn(),
      invariantCheck: {
        resolveRange: () => range,
        parseDiffResult: () => ({ kind: "success", hunks: [{}] }),
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
      importLoreMd: true,
      deadlineMs: 1_000,
      candidateTimeoutMs: 100,
    });

    expect(report.health.invariantSource).toMatchObject({
      status: "failed",
      failure: {
        code: "invariant-source-import-failed",
        message: "Requested invariant source .lore.md does not exist",
      },
    });
    expect(startGateway).not.toHaveBeenCalled();
    expect(ensureEmbeddingReady).not.toHaveBeenCalled();
  });

  it("preserves typed diff limit failures in the published report", async () => {
    const range = { base: "base", head: "head", source: "test" };
    const startGateway = vi.fn();
    vi.doMock("@loreai/core", () => ({
      config: () => ({
        model: undefined,
        invariantCheck: { effort: "off" },
      }),
      embedding: { ensureEmbeddingReady: vi.fn(async () => {}) },
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
      embedding: { ensureEmbeddingReady: vi.fn(async () => {}) },
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
    const ensureEmbeddingReady = vi.fn(async () => {});
    const collectCommitMessages = vi.fn(() => []);
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
      embedding: { ensureEmbeddingReady },
      importLoreFile: vi.fn(),
      invariantCheck: {
        resolveRange: () => range,
        parseDiffResult: () => ({ kind: "success", hunks: [{}] }),
        checkInvariants,
        collectCommitMessages,
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
    expect(report.health.hunkVectors.failure?.code).toBe(
      "hunk-vector-embedding-failed",
    );
    expect(ensureEmbeddingReady).not.toHaveBeenCalled();
    expect(collectCommitMessages).not.toHaveBeenCalled();
    expect(events).toEqual(["publish", "cleanup"]);
  });

  it.each([{ name: "zero enforceable invariants", hunks: [{}] }])(
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
        embedding: { ensureEmbeddingReady: vi.fn(async () => {}) },
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
