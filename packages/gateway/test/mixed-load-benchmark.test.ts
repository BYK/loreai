import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { parseOpenAICodexRequest } from "../src/translate/openai-responses";
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
      expect(first.body.input).toHaveLength(profile.messageCount);
      expect(first.parameters).toMatchObject(options);
      expect(first.parameters.currentTurnToolPairs).toBeGreaterThan(0);
      expect(first.parameters.largeToolOutputBytes).toBeGreaterThan(1_024);
      expect(first.parameters).toMatchObject({
        knowledgeEntries: 17,
        vectorEntries: 29,
        backlogEntries: 41,
      });

      const parsed = parseOpenAICodexRequest(first.body, {});
      expect(parsed.messages.length).toBeGreaterThan(1_000);
      expect(
        parsed.messages.some((message) => message.provenanceContent?.length),
      ).toBe(true);
      expect(first.parameters.activeWindowTokens).toBeGreaterThanOrEqual(
        180_000,
      );
      expect(first.parameters.activeWindowTokens).toBeLessThanOrEqual(200_000);

      expect(() => assertResponsesWorkloadParity(first.body)).not.toThrow();
      const tail = first.body.input.slice(
        -first.parameters.currentTurnToolPairs * 2,
      );
      expect(tail.every((item) => item.type.includes("function_call"))).toBe(
        true,
      );
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
        processCpuMs: 20,
        retainedBytes: 100,
      },
      {
        decodeMs: 8,
        postDecodeToUpstreamMs: 10,
        healthMs: 1,
        processCpuMs: 5,
        retainedBytes: 200,
      },
      {
        decodeMs: 6,
        postDecodeToUpstreamMs: 20,
        healthMs: 2,
        processCpuMs: 10,
        retainedBytes: 150,
      },
    ]);

    expect(summary).toMatchObject({
      samples: 3,
      decodeMs: { p50: 6, p95: 8 },
      postDecodeToUpstreamMs: { p50: 20, p95: 30 },
      healthMs: { p50: 2, p95: 3 },
      processCpuMs: { p50: 10, p95: 20 },
      retainedBytes: { p50: 150, p95: 200 },
    });
    expect(REFERENCE_TARGETS).toEqual({
      postDecodeToUpstreamP95Ms: 2_000,
      healthP95Ms: 250,
    });
    expect(summary).not.toHaveProperty("passedTimingGate");
  });

  test("commits a machine-readable invariant baseline", () => {
    const baseline = JSON.parse(
      readFileSync(
        new URL("../benchmark/mixed-load/baseline.json", import.meta.url),
        "utf8",
      ),
    );
    expect(baseline.referenceTargets).toEqual(REFERENCE_TARGETS);
    expect(baseline.ciGates.universalTimingThresholds).toBe(false);
    expect(baseline.scenarios).toEqual(MIXED_LOAD_SCENARIOS);
  });

  test("runs every scenario through real gateway processes and an owned fixture DB", async () => {
    const report = await runMixedLoadBenchmark({
      profiles: [
        {
          name: "ci-contract",
          messageCount: 20,
          seed: 1_733,
          activeWindowTargetTokens: 190_000,
          currentTurnToolPairs: 2,
          largeToolOutputBytes: 2_048,
          knowledgeEntries: 2,
          vectorEntries: 3,
          backlogEntries: 4,
        },
      ],
      scenarios: MIXED_LOAD_SCENARIOS,
      warmups: 0,
      samples: 1,
    });

    expect(report.scenarios).toHaveLength(MIXED_LOAD_SCENARIOS.length);
    for (const scenario of report.scenarios as Array<{
      processIds: number[];
      invariants: Record<string, boolean>;
    }>) {
      expect(new Set(scenario.processIds).size).toBe(2);
      expect(Object.values(scenario.invariants).every(Boolean)).toBe(true);
    }
  }, 180_000);
});
