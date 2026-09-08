import { it, expect } from "vitest";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
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

/** Completed agentic turns, unlike an unbroken tool chain protected in full. */
function history(): GatewayMessage[] {
  const messages: GatewayMessage[] = [];
  for (let i = 0; i < 930; i++)
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
    const scope = {
      projectPath: "/test/source-window-benchmark",
      sessionID: "source-window-benchmark",
      noStore: false,
    };
    ensureProject(scope.projectPath);
    saveSessionTracking(scope.sessionID, {});
    const source = history();
    const largeWindow = process.env.LORE_FRONTIER_LARGE_WINDOW === "1";
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
    for (let sample = 0; sample < 5; sample++) {
      for (const mode of sample % 2
        ? ["restart", "warm", "full", "append", "full-append"]
        : ["full", "warm", "restart", "full-append", "append"]) {
        evictSession(scope.sessionID);
        if (mode === "restart") close();
        setBudget();
        const messages = mode.includes("append") ? appended : source;
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
        const start = performance.now();
        const prepared = await prepareSemanticMessages({
          ...scope,
          messages,
          timing,
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
        const hash = createHash("sha256")
          .update(
            JSON.stringify(
              loreMessagesToGateway(
                transformed.messages,
                prepared.provenanceByMessageId,
              ),
            ),
          )
          .digest("hex");
        const key = mode.includes("append") ? "append" : "same";
        if (expected.has(key)) expect(hash).toBe(expected.get(key));
        else expected.set(key, hash);
        if (!mode.startsWith("full"))
          expect(timing.observations.source_converted_messages).toBe(
            mode === "append" ? 2 : 0,
          );
        runs.push({
          sample,
          mode,
          sourceMessages: messages.length,
          preparationMs,
          transformMs,
          retainedMessages: prepared.loreMessages.length,
          modelMessages: transformed.messages.length,
          modelTokens: transformed.totalTokens,
          sqlCount,
          wireHash: hash,
          stages: timing.stages,
          observations: timing.observations,
        });
      }
    }
    const report = {
      node: process.version,
      fixture:
        "930 completed six-message turns, with unique read calls/results",
      largeWindow,
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
