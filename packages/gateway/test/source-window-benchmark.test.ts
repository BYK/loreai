import { it, expect, vi, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { Tokenizer } from "ai-tokenizer";
import {
  close,
  db,
  ensureProject,
  saveSessionTracking,
  transform,
  evictSession,
  setModelLimits,
  setMaxLayer0Tokens,
  estimateMessages,
  log,
} from "@loreai/core";
import {
  prepareSemanticMessages,
  PreparationTiming,
} from "../src/semantic-preparation";
import { storeTurnTemporal } from "../src/turn-temporal";
import { loreMessagesToGateway } from "../src/pipeline";
import type { GatewayMessage } from "../src/translate/types";
import { sourceCheckpointProtocol } from "../src/source-checkpoint";
import { clearSpeculativeSource } from "../src/speculative-source";
import { invalidateProjectIdCache } from "../../core/src/db";

afterEach(() => vi.useRealTimers());

/** Completed agentic turns, unlike an unbroken tool chain protected in full. */
function history(): GatewayMessage[] {
  const messages: GatewayMessage[] = [];
  for (let i = 0; i < Number(process.env.LORE_FRONTIER_TURNS ?? 930); i++)
    messages.push(
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Inspect synthetic module ${i} and explain the behavior of its exported function.`,
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: `read-${i}`,
            name: "read_file",
            input: { path: `synthetic-${i}.ts` },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: `read-${i}`,
            content: [
              {
                type: "text",
                text: `export function synthetic${i}(value: number) { return value + ${i}; } // deterministic fixture`,
              },
            ],
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: `Module ${i} adds its constant to the supplied value. The function is deterministic.`,
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `That completes review ${i}. Record the behavior for the next independent task.`,
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: `Review ${i} completed. This task has no outstanding tool calls or follow-up actions.`,
          },
        ],
      },
    );
  return messages;
}

it.skipIf(process.env.LORE_FRONTIER_BENCHMARK !== "1")(
  "measures full, warm, reopened and appended source preparation",
  async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_790_000_000_000);
    const samples = Number(process.env.LORE_FRONTIER_RUNS ?? 5);
    const warmups = Number(process.env.LORE_FRONTIER_WARMUPS ?? 0);
    for (const n of [samples, warmups])
      if (!Number.isSafeInteger(n) || n < 0)
        throw new Error("Benchmark counts must be nonnegative integers");
    if (samples < 1) throw new Error("Benchmark requires measured samples");
    const scope = {
      projectPath: "/test/source-window-benchmark",
      sessionID: "source-window-benchmark",
      noStore: false,
    };
    const pid = ensureProject(scope.projectPath);
    db()
      .query("UPDATE projects SET id = ? WHERE id = ?")
      .run("source-benchmark-project", pid);
    invalidateProjectIdCache();
    saveSessionTracking(scope.sessionID, { projectPath: scope.projectPath });
    const source = history();
    const largeWindow = process.env.LORE_FRONTIER_LARGE_WINDOW === "1";
    const contextBoundary = process.env.LORE_FRONTIER_CONTEXT_BOUNDARY === "1";
    const checkpointOptions = contextBoundary
      ? {
          checkpointProtocol: sourceCheckpointProtocol("anthropic"),
          checkpointBoundarySafe: true,
        }
      : {};
    if (largeWindow) {
      const padding =
        " The synthetic review verifies deterministic behavior, preserves completed work, and records all relevant context for the next independent task.".repeat(
          8,
        );
      for (const message of source)
        for (const block of message.content) {
          if (block.type === "text") block.text += padding;
          if (block.type === "tool_result")
            for (const output of block.content)
              if (output.type === "text") output.text += padding;
        }
    }
    const appended: GatewayMessage[] = [
      ...source,
      {
        role: "user",
        content: [{ type: "text", text: "Inspect the final synthetic file." }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "final-read",
            name: "read_file",
            input: { path: "final.ts" },
          },
        ],
      },
    ];
    const setBudget = () => {
      setModelLimits({
        context: largeWindow ? 1_000_000 : 16_000,
        output: largeWindow ? 32_000 : 2_000,
      });
      setMaxLayer0Tokens(largeWindow ? 500_000 : 8_000);
    };
    setBudget();
    const populate = await prepareSemanticMessages({
      ...scope,
      ...checkpointOptions,
      protocol: "anthropic",
      messages: source,
      timing: new PreparationTiming({ protocol: "anthropic", stream: false }),
    });
    const sourceTokens = estimateMessages(populate.loreMessages);
    const result = transform({ ...scope, messages: populate.loreMessages });
    populate.checkpoint?.finish(result.messages);
    storeTurnTemporal({
      ...scope,
      temporalInput: populate.temporalInput,
      assistantContentBlocks: [{ type: "text", text: "accepted" }],
      model: "synthetic",
      usage: { inputTokens: 2000, outputTokens: 10 },
    });
    const runs: unknown[] = [];
    const expected = new Map<string, string>();
    for (let sample = -warmups; sample < samples; sample++) {
      const modes =
        sample % 2
          ? ["restart", "warm", "full", "append", "full-append"]
          : ["full", "warm", "restart", "full-append", "append"];
      if (contextBoundary) modes.push("delta", "delta-append");
      for (const mode of modes) {
        evictSession(scope.sessionID);
        // A restart must not retain the same-process speculative source cache.
        if (mode === "restart") {
          clearSpeculativeSource(scope.sessionID);
          close();
        }
        setBudget();
        const messages = mode.startsWith("delta")
          ? mode.includes("append")
            ? appended.slice(source.length)
            : []
          : mode.includes("append")
            ? appended
            : source;
        const timing = new PreparationTiming({
          protocol: "anthropic",
          stream: false,
        });
        let sqlCount = 0;
        log.registerSink({
          info() {},
          warn() {},
          error() {},
          captureException() {},
          withDbSpan(_sql, fn) {
            sqlCount++;
            return fn();
          },
        });
        const originalCount = Tokenizer.prototype.count;
        const profile = process.env.LORE_FRONTIER_BPE_PROFILE === "1";
        let bpeCalls = 0,
          bpeBytes = 0,
          uniqueBytes = 0,
          bpeMs = 0;
        const unique = new Set<string>();
        if (profile)
          Tokenizer.prototype.count = function (...args) {
            const [text] = args;
            const bytes = Buffer.byteLength(text);
            const key = createHash("sha256")
              .update(text, "utf16le")
              .digest("hex");
            bpeCalls++;
            bpeBytes += bytes;
            if (!unique.has(key)) {
              unique.add(key);
              uniqueBytes += bytes;
            }
            const began = performance.now();
            try {
              return originalCount.apply(this, args);
            } finally {
              bpeMs += performance.now() - began;
            }
          };
        const cpu = process.cpuUsage();
        const start = performance.now();
        try {
          const prepared = await prepareSemanticMessages({
            ...scope,
            messages,
            timing,
            ...checkpointOptions,
            ...(mode.startsWith("delta")
              ? {
                  sourcePrefix: {
                    sourceCount: source.length,
                    sourceDigest: populate.checkpoint!.digest,
                  },
                }
              : {}),
            ...(mode.startsWith("full") ? {} : { protocol: "anthropic" }),
          });
          const preparationMs = performance.now() - start;
          const transformStart = performance.now();
          const transformed = transform({
            ...scope,
            messages: prepared.loreMessages,
            sourceWindow: prepared.sourceWindow,
          });
          const transformMs = performance.now() - transformStart;
          const wire = JSON.stringify(
            loreMessagesToGateway(
              transformed.messages,
              prepared.provenanceByMessageId,
            ),
          );
          const totalMs = performance.now() - start;
          const cpuDelta = process.cpuUsage(cpu);
          const hash = createHash("sha256").update(wire).digest("hex");
          const key = mode.includes("append") ? "append" : "same";
          if (expected.has(key)) expect(hash).toBe(expected.get(key));
          else expected.set(key, hash);
          if (!mode.startsWith("full"))
            expect(timing.observations.source_converted_messages).toBe(
              mode.includes("append") ? 2 : 0,
            );
          if (sample >= 0)
            runs.push({
              sample,
              mode,
              sourceMessages: messages.length,
              preparationMs,
              transformMs,
              totalMs,
              cpuMs: (cpuDelta.user + cpuDelta.system) / 1000,
              bpeCalls: profile ? bpeCalls : undefined,
              bpeBytes: profile ? bpeBytes : undefined,
              bpeUniqueBytes: profile ? uniqueBytes : undefined,
              bpeMs: profile ? bpeMs : undefined,
              retainedMessages: prepared.loreMessages.length,
              modelMessages: transformed.messages.length,
              modelTokens: transformed.totalTokens,
              sqlCount,
              wireHash: hash,
              stages: timing.stages,
              observations: timing.observations,
            });
        } finally {
          Tokenizer.prototype.count = originalCount;
        }
      }
    }
    const report = {
      node: process.version,
      fixture:
        "930 completed six-message turns, with unique read calls/results",
      largeWindow,
      samples,
      warmups,
      contextBoundary,
      sourceMessages: source.length,
      sourceTokens,
      checkpointBytes: (
        db()
          .query(
            "SELECT length(payload) AS bytes FROM source_windows WHERE session_id = ?",
          )
          .get(scope.sessionID) as { bytes: number }
      ).bytes,
      runs,
    };
    if (process.env.LORE_FRONTIER_REPORT)
      writeFileSync(
        process.env.LORE_FRONTIER_REPORT,
        JSON.stringify(report, null, 2) + "\n",
      );
    if (process.env.LORE_FRONTIER_CACHE_PAYLOAD) {
      const row = db()
        .query("SELECT payload FROM semantic_token_cache WHERE session_id = ?")
        .get(scope.sessionID) as { payload: string } | null;
      if (!row) throw new Error("No count-cache payload to inspect");
      writeFileSync(process.env.LORE_FRONTIER_CACHE_PAYLOAD, row.payload);
    }
    process.stdout.write(
      JSON.stringify({
        sourceMessages: report.sourceMessages,
        sourceTokens: report.sourceTokens,
        checkpointBytes: report.checkpointBytes,
        samples: runs.length,
      }) + "\n",
    );
  },
);
