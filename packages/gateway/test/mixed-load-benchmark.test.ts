import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { parseOpenAIResponsesRequest } from "../src/translate/openai-responses";
import {
  MIXED_LOAD_PROFILES,
  MIXED_LOAD_SCENARIOS,
  REFERENCE_TARGETS,
  assertResponsesWorkloadParity,
  generateResponsesWorkload,
  summarizeBenchmarkSamples,
} from "../benchmark/mixed-load/workload";
import { runMixedLoadBenchmark } from "../benchmark/mixed-load/run";

describe("#1733 mixed-load benchmark contract", () => {
  test.each(MIXED_LOAD_PROFILES)(
    "builds a seeded $messageCount-message tool-heavy Responses window",
    (profile) => {
      const options = {
        ...profile,
        seed: 1_733,
        knowledgeEntries: 17,
        vectorEntries: 29,
        backlogEntries: 41,
      };
      const first = generateResponsesWorkload(options);
      const second = generateResponsesWorkload(options);
      const hash = (value: unknown) =>
        createHash("sha256").update(JSON.stringify(value)).digest("hex");

      expect(hash(first.body)).toBe(hash(second.body));
      expect(first.parameters).toMatchObject(options);
      expect(first.parameters.currentTurnToolPairs).toBeGreaterThan(0);
      expect(first.parameters.largeToolOutputBytes).toBeGreaterThan(1_024);
      expect(first.parameters).toMatchObject({
        knowledgeEntries: 17,
        vectorEntries: 29,
        backlogEntries: 41,
      });

      const parsed = parseOpenAIResponsesRequest(first.body, {});
      expect(parsed.messages).toHaveLength(profile.messageCount);
      expect(first.parameters).toMatchObject({
        sourceInputItems: first.body.input.length,
        sourceNormalizedMessages: profile.messageCount,
      });
      expect(
        parsed.messages.some((message) => message.provenanceContent?.length),
      ).toBe(true);
      expect(first.parameters).not.toHaveProperty("activeWindowTokens");
      expect(first.parameters.activeWindowTargetTokens).toBe(190_000);
      expect(first.parameters.activeWindowLowerBoundTokens).toBe(180_000);
      expect(first.parameters.activeWindowUpperBoundTokens).toBe(210_001);
      expect(first.parameters.sourceEstimatedTokens).toBeGreaterThan(
        first.parameters.activeWindowTargetTokens,
      );

      expect(() => assertResponsesWorkloadParity(first.body)).not.toThrow();
      const tail = first.body.input.slice(
        -first.parameters.currentTurnToolPairs * 2,
      );
      expect(
        tail
          .slice(0, first.parameters.currentTurnToolPairs)
          .every((item) => item.type === "function_call"),
      ).toBe(true);
      expect(
        tail
          .slice(first.parameters.currentTurnToolPairs)
          .every((item) => item.type === "function_call_output"),
      ).toBe(true);
    },
  );

  test("defines independent deterministic failure and concurrency scenarios", () => {
    expect(MIXED_LOAD_SCENARIOS).toEqual([
      "idle-backlog",
      "foreground-during-backlog",
      "embeddings-unavailable",
      "embeddings-hung",
      "read-workers-unavailable",
      "read-workers-slow",
      "cancellation",
      "concurrent-sessions",
    ]);
  });

  test("summarizes warm repeated samples without gating universal timings", () => {
    const summary = summarizeBenchmarkSamples([
      {
        decodeMs: 4,
        postDecodeToUpstreamMs: 30,
        healthMs: 3,
      },
      {
        decodeMs: 8,
        postDecodeToUpstreamMs: 10,
        healthMs: 1,
      },
      {
        decodeMs: 6,
        postDecodeToUpstreamMs: 20,
        healthMs: 2,
      },
    ]);

    expect(summary).toMatchObject({
      samples: 3,
      decodeMs: { p50: 6, p95: 8 },
      postDecodeToUpstreamMs: { p50: 20, p95: 30 },
      healthMs: { p50: 2, p95: 3 },
    });
    expect(REFERENCE_TARGETS).toEqual({
      postDecodeToUpstreamP95Ms: 2_000,
      healthP95Ms: 250,
    });
    expect(summary).not.toHaveProperty("passedTimingGate");
  });

  test("separates the CI contract from a measured reference report", () => {
    const contract = JSON.parse(
      readFileSync(
        new URL("../benchmark/mixed-load/contract.json", import.meta.url),
        "utf8",
      ),
    );
    const reference = JSON.parse(
      readFileSync(
        new URL(
          "../benchmark/mixed-load/reference-report.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect(contract.referenceTargets).toEqual(REFERENCE_TARGETS);
    expect(contract.ciGates.universalTimingThresholds).toBe(false);
    expect(contract.scenarios).toEqual(MIXED_LOAD_SCENARIOS);
    expect(reference.measurement).toMatchObject({
      kind: "measured-quick-reference",
      syntheticProvider: true,
      paidProvider: false,
    });
    expect(reference.buildIdentity).toMatch(/^[0-9a-f]{40}$/);
    expect(reference.runtime.node).toMatch(/^v\d+/);
    expect(reference.hardware.logicalCpus).toBeGreaterThan(0);
    expect(reference.parameters.profiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceNormalizedMessages: 5_580,
        }),
        expect.objectContaining({
          sourceNormalizedMessages: 7_228,
        }),
      ]),
    );
    expect(reference.scenarios).toHaveLength(MIXED_LOAD_SCENARIOS.length * 2);
  });

  test("runs every scenario through real gateway processes and an owned fixture DB", async () => {
    const report = await runMixedLoadBenchmark({
      profiles: [
        {
          name: "ci-contract",
          messageCount: 8,
          seed: 1_733,
          activeWindowTargetTokens: 190_000,
          currentTurnToolPairs: 1,
          largeToolOutputBytes: 1_024,
          knowledgeEntries: 1,
          vectorEntries: 1,
          backlogEntries: 12,
          enforceActiveWindow: false,
        },
      ],
      scenarios: MIXED_LOAD_SCENARIOS,
      warmups: 0,
      samples: 1,
    });

    expect(report.parameters).toMatchObject({
      requestedScenarios: MIXED_LOAD_SCENARIOS,
      completedScenarios: MIXED_LOAD_SCENARIOS,
      allAcceptanceScenariosCompleted: true,
    });
    expect(report.scenarios).toHaveLength(MIXED_LOAD_SCENARIOS.length);
    for (const scenario of report.scenarios as Array<{
      processIds: number[];
      invariants: Record<string, boolean>;
      processLifecycle: {
        seedPersistentState: boolean[];
        sameOwnedDatabase: boolean;
      };
      precondition: { reached: boolean; heldDuringForeground: boolean };
      release: {
        requested: boolean;
        settled: boolean;
        returnedToBaseline: boolean;
      };
      phases: {
        base: { accepted: boolean; checkpointPublished: boolean };
        warmAppend: { samples: unknown[] };
        restartAppend: { samples: unknown[]; observedPersistedBase: boolean };
      };
      health: Array<{
        status: number;
        statusField: string | null;
        schemaValid: boolean;
      }>;
      queuePeaks: {
        temporalDepth: number;
        temporalOldestAgeMs: number;
        readPendingCount: number;
      };
      memory: {
        label: string;
        explicitGc: boolean;
        quiescentDeltaBytes: number;
      };
      cpu: { scope: string };
      queries: {
        scope: string;
        excludesSeedingAndStats: boolean;
        workerThreadCoverage: string;
      };
      upstreamMeasurements: Array<{
        reportedProviderUsage: number;
        estimatedInputTokens: number;
        usageSource: string;
        normalizedMessages: number;
        toolSequenceHash: string;
        provenanceHash: string;
      }>;
      clientOutputHashes: string[];
    }>) {
      expect(new Set(scenario.processIds).size).toBe(2);
      expect(Object.values(scenario.invariants).every(Boolean)).toBe(true);
      expect(scenario.processLifecycle).toEqual({
        seedPersistentState: [true, false],
        sameOwnedDatabase: true,
      });
      expect(scenario.precondition.reached).toBe(true);
      expect(scenario.precondition.heldDuringForeground).toBe(true);
      expect(scenario.release).toEqual({
        requested: true,
        settled: true,
        returnedToBaseline: true,
      });
      expect(scenario.phases.base.accepted).toBe(true);
      expect(scenario.phases.base.checkpointPublished).toBe(true);
      expect(scenario.phases.warmAppend.samples).toHaveLength(1);
      expect(scenario.phases.restartAppend.samples).toHaveLength(1);
      expect(scenario.phases.restartAppend.observedPersistedBase).toBe(true);
      expect(
        scenario.health.every(
          (sample) =>
            sample.status === 200 &&
            sample.statusField === "ok" &&
            sample.schemaValid,
        ),
      ).toBe(true);
      expect(scenario.queuePeaks.temporalDepth).toBeGreaterThanOrEqual(0);
      expect(scenario.queuePeaks.temporalOldestAgeMs).toBeGreaterThanOrEqual(0);
      expect(scenario.queuePeaks.readPendingCount).toBeGreaterThanOrEqual(0);
      expect(scenario.memory.label).toMatch(/^quiescent-/);
      expect(typeof scenario.memory.explicitGc).toBe("boolean");
      expect(Number.isFinite(scenario.memory.quiescentDeltaBytes)).toBe(true);
      expect(scenario.cpu.scope).toBe("serving-process");
      expect(scenario.queries).toMatchObject({
        scope: "serving-process-main-thread",
        excludesSeedingAndStats: true,
        workerThreadCoverage: "not-observed",
      });
      expect(scenario.upstreamMeasurements.length).toBeGreaterThan(0);
      expect(
        scenario.upstreamMeasurements.every(
          (measurement) =>
            measurement.reportedProviderUsage ===
              measurement.estimatedInputTokens &&
            measurement.usageSource === "authoritative-local-estimate" &&
            measurement.normalizedMessages > 0 &&
            /^[0-9a-f]{64}$/.test(measurement.toolSequenceHash) &&
            /^[0-9a-f]{64}$/.test(measurement.provenanceHash),
        ),
      ).toBe(true);
      expect(
        scenario.clientOutputHashes.every((hash) =>
          /^[0-9a-f]{64}$/.test(hash),
        ),
      ).toBe(true);
    }
  }, 240_000);
});
