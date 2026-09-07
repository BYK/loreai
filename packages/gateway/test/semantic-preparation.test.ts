import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  db,
  ensureProject,
  isToolPart,
  log,
  temporal,
  saveSessionTracking,
} from "@loreai/core";
import * as tokenize from "../../core/src/tokenize";
import * as Sentry from "@sentry/bun";
import * as adapter from "../src/temporal-adapter";
import {
  PreparationTiming,
  prepareSemanticMessages,
  responsesProvenanceByMessageId,
} from "../src/semantic-preparation";
import {
  captureTurnTemporalInput,
  storeTurnTemporal,
} from "../src/turn-temporal";
import { loreMessagesToGateway } from "../src/pipeline";
import { semanticHistory } from "./fixtures/semantic-history";

vi.mock("@sentry/bun", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sentry/bun")>();
  return {
    ...actual,
    isInitialized: vi.fn(actual.isInitialized),
    metrics: { ...actual.metrics, distribution: vi.fn() },
  };
});

const projectPath = "/test/semantic-preparation";
const sessionID = "semantic-session";
const sink = { info() {}, warn() {}, error() {}, captureException() {} };
beforeEach(() =>
  db().exec("DELETE FROM temporal_messages; DELETE FROM semantic_token_cache"),
);
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  log.registerSink(sink);
});
const storage = {
  projectPath,
  sessionID,
  noStore: false,
  model: "fixture",
  usage: { inputTokens: 10, outputTokens: 5 },
  assistantContentBlocks: [{ type: "text" as const, text: "done" }],
};

function seed(request: ReturnType<typeof semanticHistory>, restored = false) {
  const pid = ensureProject(projectPath);
  const messages = adapter.gatewayMessagesToLore(request.messages, sessionID);
  const insert = db().query(`INSERT INTO temporal_messages
    (id, source_id, project_id, session_id, role, content, tokens, distilled, created_at, metadata)
    VALUES (?, ?, ?, ?, ?, 'fixture', 1, 0, 1, '{}')`);
  const ids = temporal.storedMessageIds({
    projectPath,
    sessionID,
    messages: messages.map((m) => ({ sourceID: m.info.id })),
  });
  db().exec("SAVEPOINT seed_semantic");
  for (const [i, m] of messages.entries())
    insert.run(
      !restored && i % 10 === 0 ? m.legacySourceID! : ids.get(m.info.id)!,
      restored
        ? null
        : i % 10 === 0
          ? m.legacySourceID!
          : i % 10 === 1
            ? null
            : m.info.id,
      pid,
      sessionID,
      m.info.role,
    );
  db().exec("RELEASE seed_semantic");
}

describe("semantic preparation", () => {
  it("does not retokenize unchanged provenance on a subsequent request", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-07T18:14:04Z"));
    const request = semanticHistory(6);
    ensureProject(projectPath);
    saveSessionTracking(sessionID, {});
    const count = vi.spyOn(tokenize, "estimateTokens");
    const first = await prepareSemanticMessages({
      messages: request.messages,
      projectPath,
      sessionID,
      noStore: false,
      timing: new PreparationTiming(request),
    });
    expect(count.mock.calls.length).toBeGreaterThan(0);
    count.mockClear();
    vi.setSystemTime(new Date("2026-09-07T18:15:04Z"));
    const next = await prepareSemanticMessages({
      messages: structuredClone(request.messages),
      projectPath,
      sessionID,
      noStore: false,
      timing: new PreparationTiming(request),
    });
    expect(count).not.toHaveBeenCalled();
    expect(
      next.loreMessages[0].info.time.created -
        first.loreMessages[0].info.time.created,
    ).toBe(60_000);
    expect(next.loreMessages.map((m) => m.hiddenInputTokens)).toEqual(
      first.loreMessages.map((m) => m.hiddenInputTokens),
    );
    expect(
      loreMessagesToGateway(
        next.loreMessages,
        next.provenanceByMessageId,
        true,
      ),
    ).toEqual(
      loreMessagesToGateway(
        first.loreMessages,
        first.provenanceByMessageId,
        true,
      ),
    );
  });

  it.each(["edit", "rewind"])(
    "preserves authoritative source after a warm historical %s",
    async (mode) => {
      const request = semanticHistory(6);
      ensureProject(projectPath);
      saveSessionTracking(sessionID, {});
      const prepare = (noStore: boolean) =>
        prepareSemanticMessages({
          messages: request.messages,
          projectPath,
          sessionID,
          noStore,
          timing: new PreparationTiming(request),
        });
      await prepare(false);
      if (mode === "edit") {
        // Change hidden historical bytes while leaving the visible projection,
        // source positions, and final message unchanged.
        const historical = request.messages.find((m) =>
          JSON.stringify(m.provenanceContent)?.includes(
            "synthetic-encrypted-state-",
          ),
        )!;
        historical.provenanceContent = JSON.parse(
          JSON.stringify(historical.provenanceContent).replace(
            "synthetic-encrypted-state-",
            "different-encrypted-state-",
          ),
        );
      } else request.messages.splice(2, 2);
      const count = vi.spyOn(tokenize, "estimateTokens");
      const warm = await prepare(false);
      expect(count.mock.calls.length).toBe(mode === "edit" ? 2 : 0);
      const cold = await prepare(true);
      expect(warm.loreMessages.map((m) => m.hiddenInputTokens)).toEqual(
        cold.loreMessages.map((m) => m.hiddenInputTokens),
      );
      expect(warm.temporalInput.assistantIndex).toBe(request.messages.length);
      expect(warm.loreMessages.map((m) => m.info.id)).toEqual(
        cold.loreMessages.map((m) => m.info.id),
      );
      expect(
        loreMessagesToGateway(
          warm.loreMessages,
          warm.provenanceByMessageId,
          true,
        ),
      ).toEqual(
        loreMessagesToGateway(
          cold.loreMessages,
          cold.provenanceByMessageId,
          true,
        ),
      );
    },
  );

  it("preserves numeric stage timings through the real log sink", () => {
    const lines: string[] = [];
    log.registerSink({ ...sink, info: (message) => lines.push(message) });
    const timing = new PreparationTiming(semanticHistory(2));
    timing.counts.messages = 5741;
    timing.record("conversion", { wallMs: 83199, cpuMs: 83000 });
    timing.upstreamStart();
    const line = lines.find((message) =>
      message.startsWith("semantic-preparation "),
    )!;
    expect(line).not.toContain("[object Object]");
    const payload = JSON.parse(line.slice("semantic-preparation ".length));
    expect(payload.messages).toBe(5741);
    expect(payload.stages.conversion).toEqual({ wallMs: 83199, cpuMs: 83000 });
    expect(payload.stages.turn_to_upstream.wallMs).toEqual(expect.any(Number));
    expect(payload.stages.turn_to_upstream.cpuMs).toEqual(expect.any(Number));
    expect(line).not.toContain(projectPath);
    expect(line).not.toContain(sessionID);
  });

  it("preserves wire/provenance and recall IDs on a resumed 5,580-message Codex transcript", async () => {
    const request = semanticHistory();
    expect(request.messages).toHaveLength(5580);
    seed(request);
    const original = adapter.gatewayMessagesToLore(request.messages, sessionID);
    const provenance = responsesProvenanceByMessageId(
      request.messages,
      original,
    );
    adapter.resolveToolResults(original, (m) =>
      temporal.storedMessageId({
        projectPath,
        sessionID,
        sourceID: m.info.id,
        legacySourceID: m.legacySourceID,
      }),
    );
    let reads = 0;
    log.registerSink({
      ...sink,
      withDbSpan(sql, fn) {
        if (sql.includes("temporal_messages")) reads++;
        return fn();
      },
    });
    const timing = new PreparationTiming(request);
    const prepared = await prepareSemanticMessages({
      messages: request.messages,
      projectPath,
      sessionID,
      noStore: false,
      timing,
    });
    expect(reads).toBe(Math.ceil(2789 / 100));
    expect(timing.counts).toEqual({
      messages: 5580,
      parts: 11158,
      toolUses: 5578,
      toolResults: 5578,
      placeholders: 2789,
    });
    expect(
      loreMessagesToGateway(
        prepared.loreMessages,
        prepared.provenanceByMessageId,
        true,
      ),
    ).toEqual(loreMessagesToGateway(original, provenance, true));
    expect(prepared.provenanceByMessageId).toEqual(provenance);
    const snapshot = prepared.temporalInput;
    expect(snapshot.assistantIndex).toBe(5580);
    expect(Object.keys(snapshot)).toEqual(["latestUser", "assistantIndex"]);
    const user = snapshot.latestUser!;
    expect(user.parts.every((p) => isToolPart(p) && p.tool === "result")).toBe(
      true,
    );
    // Mutation of both graphs after preparation cannot corrupt the snapshot.
    request.messages.at(-1)!.content.length = 0;
    prepared.loreMessages.at(-1)!.parts.length = 0;
    const conversion = vi.spyOn(adapter, "gatewayMessagesToLore");
    const resolver = vi.spyOn(adapter, "resolveToolResults");
    storeTurnTemporal({ ...storage, temporalInput: snapshot });
    expect(conversion.mock.calls.map((call) => call[0].length)).toEqual([1]);
    expect(resolver).not.toHaveBeenCalled();
    expect(
      temporal
        .bySession(projectPath, sessionID)
        .find((m) => m.source_id === user.info.id)?.content,
    ).toContain("Synthetic output 2788/0");
  });

  it("keeps errors/parallel results identical and rolls back partial storage for an idempotent retry", async () => {
    const request = semanticHistory(4);
    const result = request.messages.at(-1)!.content[1];
    if (result.type === "tool_result") result.isError = true;
    const baseline = adapter.gatewayMessagesToLore(request.messages, sessionID);
    adapter.resolveToolResults(baseline, (m) =>
      temporal.storedMessageId({
        projectPath,
        sessionID,
        sourceID: m.info.id,
        legacySourceID: m.legacySourceID,
      }),
    );
    const prepared = await prepareSemanticMessages({
      messages: request.messages,
      projectPath,
      sessionID,
      noStore: false,
      timing: new PreparationTiming(request),
    });
    expect(loreMessagesToGateway(prepared.loreMessages)).toEqual(
      loreMessagesToGateway(baseline),
    );
    const record = vi
      .spyOn(temporal, "recordToolCalls")
      .mockImplementationOnce(() => {
        throw new Error("injected storage failure");
      });
    expect(() =>
      storeTurnTemporal({ ...storage, temporalInput: prepared.temporalInput }),
    ).toThrow("injected storage failure");
    expect(temporal.bySession(projectPath, sessionID)).toEqual([]);
    record.mockRestore();
    storeTurnTemporal({ ...storage, temporalInput: prepared.temporalInput });
    storeTurnTemporal({ ...storage, temporalInput: prepared.temporalInput });
    expect(temporal.bySession(projectPath, sessionID)).toHaveLength(2);
  });

  it("does not create a project or write anything for a no-store request", async () => {
    const request = semanticHistory(4);
    const path = "/test/semantic-no-store";
    const before = db().query("SELECT total_changes() AS changes").get();
    const prepared = await prepareSemanticMessages({
      messages: request.messages,
      projectPath: path,
      sessionID,
      noStore: true,
      timing: new PreparationTiming(request),
    });
    storeTurnTemporal({
      ...storage,
      projectPath: path,
      noStore: true,
      temporalInput: prepared.temporalInput,
    });
    expect(db().query("SELECT total_changes() AS changes").get()).toEqual(
      before,
    );
  });

  it("keeps telemetry numeric with bounded labels, and telemetry failures do not fail preparation", async () => {
    const request = semanticHistory(4);
    vi.spyOn(Sentry, "isInitialized").mockReturnValue(true);
    const emit = vi
      .spyOn(Sentry.metrics, "distribution")
      .mockImplementation(() => {});
    const timing = new PreparationTiming(request);
    await prepareSemanticMessages({
      messages: request.messages,
      projectPath,
      sessionID,
      noStore: true,
      timing,
    });
    timing.upstreamStart();
    expect(emit.mock.calls.length).toBeGreaterThan(10);
    for (const [name, value, options] of emit.mock.calls) {
      expect(name).toMatch(/^lore\.preparation\./);
      expect(Number.isFinite(value)).toBe(true);
      expect(Object.keys(options?.attributes ?? {}).sort()).toEqual(
        name.endsWith("wall_ms") || name.endsWith("cpu_ms")
          ? ["codex", "protocol", "stage", "streaming"]
          : ["codex", "protocol", "streaming"],
      );
      expect(JSON.stringify(options)).not.toContain(sessionID);
      expect(JSON.stringify(options)).not.toContain(projectPath);
    }
    emit.mockImplementation(() => {
      throw new Error("telemetry unavailable");
    });
    await expect(
      prepareSemanticMessages({
        messages: request.messages,
        projectPath,
        sessionID,
        noStore: true,
        timing,
      }),
    ).resolves.toBeDefined();
  });
});

// Run explicitly: LORE_BENCHMARK=1 pnpm exec vitest run packages/gateway/test/semantic-preparation.test.ts
it.skipIf(process.env.LORE_BENCHMARK !== "1")(
  "reports before/after preparation, post-response and memory stages",
  async () => {
    for (const count of [20, 5580]) {
      for (const restored of count === 5580 ? [false, true] : [false]) {
        // Clear the prior comparison's rows; warm the same database for both paths.
        db().exec("DELETE FROM temporal_messages");
        const request = semanticHistory(count);
        seed(request, restored);
        for (let sample = 0; sample < 3; sample++) {
          for (const mode of sample % 2
            ? (["after", "before"] as const)
            : (["before", "after"] as const)) {
            globalThis.gc?.();
            const memory = process.memoryUsage();
            let sqlCount = 0;
            let sqlMs = 0;
            log.registerSink({
              ...sink,
              withDbSpan(sql, fn) {
                if (!sql.includes("temporal_messages")) return fn();
                const start = performance.now();
                sqlCount++;
                try {
                  return fn();
                } finally {
                  sqlMs += performance.now() - start;
                }
              },
            });
            const timing = new PreparationTiming(request);
            let temporalInput;
            let fullHistory;
            if (mode === "before") {
              const loopStart = performance.now();
              const loop = new Promise<number>((resolve) =>
                setImmediate(() => resolve(performance.now() - loopStart)),
              );
              const messages = (fullHistory = timing.measure("conversion", () =>
                adapter.gatewayMessagesToLore(request.messages, sessionID),
              ));
              timing.measure("provenance", () =>
                responsesProvenanceByMessageId(request.messages, messages),
              );
              timing.measure("resolve_tools", () =>
                adapter.resolveToolResults(messages, (m) =>
                  temporal.storedMessageId({
                    projectPath,
                    sessionID,
                    sourceID: m.info.id,
                    legacySourceID: m.legacySourceID,
                  }),
                ),
              );
              timing.metric("event_loop_delay_ms", await loop);
            } else {
              const prepared = await prepareSemanticMessages({
                messages: request.messages,
                projectPath,
                sessionID,
                noStore: false,
                timing,
              });
              fullHistory = prepared.loreMessages;
              temporalInput = prepared.temporalInput;
            }
            timing.upstreamStart();
            const preparation = { ...timing.stages, sqlCount, sqlMs };
            const retainedMessages = fullHistory.length;
            const retained = process.memoryUsage();
            fullHistory = undefined;
            await new Promise<void>((resolve) => setImmediate(resolve));
            globalThis.gc?.();
            const released = process.memoryUsage();
            const postStart = performance.now();
            const postCpu = process.cpuUsage();
            const postQueries = sqlCount;
            if (mode === "before") {
              const messages = adapter.gatewayMessagesToLore(
                request.messages,
                sessionID,
              );
              temporalInput = captureTurnTemporalInput(messages);
              adapter.resolveToolResults(messages, (m) =>
                temporal.storedMessageId({
                  projectPath,
                  sessionID,
                  sourceID: m.info.id,
                  legacySourceID: m.legacySourceID,
                }),
              );
            }
            if (!temporalInput)
              throw new Error("benchmark did not capture turn input");
            storeTurnTemporal({ ...storage, temporalInput });
            const cpu = process.cpuUsage(postCpu);
            process.stdout.write(
              JSON.stringify({
                count,
                cohort: restored ? "restored" : "mixed",
                mode,
                sample,
                gcAvailable: typeof globalThis.gc === "function",
                retainedMessages,
                observations: timing.observations,
                preparation,
                postResponse: {
                  wallMs: performance.now() - postStart,
                  cpuMs: (cpu.user + cpu.system) / 1000,
                  sqlCount: sqlCount - postQueries,
                },
                memory: {
                  rssDelta: retained.rss - memory.rss,
                  heapDelta: retained.heapUsed - memory.heapUsed,
                  heapAfterHistoryRelease: released.heapUsed - memory.heapUsed,
                  snapshotBytes: Buffer.byteLength(
                    JSON.stringify(temporalInput),
                  ),
                },
              }) + "\n",
            );
          }
        }
      }
    }
  },
);
