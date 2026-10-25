import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import {
  db,
  ensureProject,
  evictSession,
  installFetchInterceptor,
  log,
  saveSessionTracking,
  setMaxLayer0Tokens,
  setModelLimits,
  transform,
} from "@loreai/core";
import { invalidateProjectIdCache } from "../../core/src/db";
import {
  encodeContextBoundary,
  supportsContextBoundary,
} from "../src/context-boundary";
import { sourceCheckpointProtocol } from "../src/source-checkpoint";
import {
  PreparationTiming,
  prepareSemanticMessages,
} from "../src/semantic-preparation";
import { parseAnthropicRequestChunks } from "../src/translate/anthropic";
import { loreMessagesToGateway } from "../src/pipeline";
import { storeTurnTemporal } from "../src/turn-temporal";
import { clearSpeculativeSource } from "../src/speculative-source";

afterEach(() => vi.useRealTimers());

/** Includes the interceptor and production streaming parser, with no network/model. */
it.skipIf(process.env.LORE_BOUNDARY_BENCHMARK !== "1")(
  "measures direct-client parsing, preparation and projection",
  async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_790_000_000_000);
    const samples = Number(process.env.LORE_BOUNDARY_RUNS ?? 100);
    const warmups = Number(process.env.LORE_BOUNDARY_WARMUPS ?? 10);
    const turns = Number(process.env.LORE_BOUNDARY_TURNS ?? 930);
    for (const n of [samples, warmups, turns])
      if (!Number.isSafeInteger(n) || n < 0)
        throw new Error("Invalid benchmark size");
    if (!samples || !turns)
      throw new Error("Benchmark requires samples and turns");
    const large = process.env.LORE_BOUNDARY_LARGE === "1";
    const padding = large
      ? " The synthetic review verifies deterministic behavior, preserves completed work, and records all relevant context for the next independent task.".repeat(
          8,
        )
      : "";
    const messages: unknown[] = [];
    for (let i = 0; i < turns; i++)
      messages.push(
        {
          role: "user",
          content: `Inspect synthetic module ${i} and explain its exported function.${padding}`,
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
              tool_use_id: `read-${i}`,
              content: `export function synthetic${i}(value: number) { return value + ${i}; }${padding}`,
            },
          ],
        },
        {
          role: "assistant",
          content: `Module ${i} adds its constant to the supplied value.${padding}`,
        },
        {
          role: "user",
          content: `That completes review ${i}. Record it for the next independent task.${padding}`,
        },
        {
          role: "assistant",
          content: `Review ${i} completed. No outstanding tools or follow-ups.${padding}`,
        },
      );
    const body = (items: unknown[]) =>
      JSON.stringify({ model: "synthetic", max_tokens: 2000, messages: items });
    const scope = {
      projectPath: "/test/context-boundary-benchmark",
      sessionID: "boundary-benchmark",
      noStore: false,
    };
    const projectID = ensureProject(scope.projectPath);
    db()
      .query("UPDATE projects SET id = ? WHERE id = ?")
      .run("context-boundary-benchmark-project", projectID);
    invalidateProjectIdCache();
    saveSessionTracking(scope.sessionID, { projectPath: scope.projectPath });
    const setBudget = () => {
      setModelLimits({
        context: large ? 1_000_000 : 16_000,
        output: large ? 32_000 : 2000,
      });
      setMaxLayer0Tokens(large ? 500_000 : 8000);
    };
    log.registerSink({
      info() {},
      warn() {},
      error() {},
      captureException() {},
    });
    let seed = true;
    let offered: string | undefined;
    let last: {
      bytes: number;
      suffix: boolean;
      parserMs: number;
      preparationMs: number;
      transformMs: number;
      wireHash: string;
      modelTokens: number;
      modelMessages: number;
      stages: PreparationTiming["stages"];
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const headers = Object.fromEntries(new Headers(init?.headers));
        const bytes = Buffer.from(init!.body as string);
        async function* chunks() {
          for (let i = 0; i < bytes.length; i += 65536)
            yield bytes.subarray(i, i + 65536);
        }
        const parseStart = performance.now();
        const request = await parseAnthropicRequestChunks(chunks(), headers);
        const parserMs = performance.now() - parseStart;
        const timing = new PreparationTiming(request);
        const capable = supportsContextBoundary(headers);
        const preparationStart = performance.now();
        const prepared = await prepareSemanticMessages({
          ...scope,
          protocol: "anthropic",
          messages: request.messages,
          timing,
          checkpointProtocol: capable
            ? sourceCheckpointProtocol("anthropic")
            : "anthropic",
          checkpointBoundarySafe: request.sourceInput?.boundarySafe,
          sourcePrefix: request.sourceInput?.sourcePrefix
            ? {
                sourceCount: request.sourceInput.sourcePrefix.messageCount,
                sourceDigest: request.sourceInput.sourcePrefix.sourceDigest,
              }
            : undefined,
        });
        const preparationMs = performance.now() - preparationStart;
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
        last = {
          bytes: bytes.length,
          suffix: !!request.sourceInput?.sourcePrefix,
          parserMs,
          preparationMs,
          transformMs,
          wireHash: createHash("sha256").update(wire).digest("hex"),
          modelTokens: transformed.totalTokens,
          modelMessages: transformed.messages.length,
          stages: timing.stages,
        };
        if (seed) {
          prepared.checkpoint!.finish(transformed.messages);
          storeTurnTemporal({
            ...scope,
            temporalInput: prepared.temporalInput,
            assistantContentBlocks: [{ type: "text", text: "accepted" }],
            model: "synthetic",
            usage: { inputTokens: 2000, outputTokens: 10 },
          });
          if (capable)
            offered = encodeContextBoundary({
              v: 1,
              protocol: "anthropic",
              inputItems: request.sourceInput!.itemCount,
              inputDigest: request.sourceInput!.inputDigest,
              retainedItems: request.sourceInput!.retainedItems,
              sourceMessages: request.messages.length,
              sourceDigest: prepared.checkpoint!.digest,
            });
        }
        return new Response("ok", {
          headers: offered ? { "x-lore-context-boundary": offered } : {},
        });
      },
      originalFetch,
    );
    const cleanup = installFetchInterceptor({
      gatewayBase: "https://gateway.example",
      getHeaders: () => ({}),
    });
    const init = {
      method: "POST",
      headers: {
        "x-lore-session-id": scope.sessionID,
        "x-lore-project": scope.projectPath,
        originator: "pi",
      },
      body: body(messages),
    };
    const url = "https://gateway.example/v1/messages";
    try {
      setBudget();
      await (await fetch(url, init)).text();
      seed = false;
      const appended = [
        ...messages,
        { role: "assistant", content: "The preceding review is complete." },
        { role: "user", content: "Inspect the next independent file." },
      ];
      const fullBody = body(appended);
      const runs = [];
      for (let sample = -warmups; sample < samples; sample++) {
        evictSession(scope.sessionID);
        clearSpeculativeSource(scope.sessionID);
        setBudget();
        const cpu = process.cpuUsage();
        const started = performance.now();
        await (await fetch(url, { ...init, body: fullBody })).text();
        const totalMs = performance.now() - started;
        const delta = process.cpuUsage(cpu);
        if (sample >= 0)
          runs.push({
            sample,
            totalMs,
            cpuMs: (delta.user + delta.system) / 1000,
            ...last!,
          });
      }
      expect(new Set(runs.map((run) => run.wireHash)).size).toBe(1);
      const report = {
        node: process.version,
        samples,
        warmups,
        turns,
        large,
        sourceMessages: messages.length,
        fullBytes: Buffer.byteLength(fullBody),
        runs,
      };
      if (process.env.LORE_BOUNDARY_REPORT)
        writeFileSync(
          process.env.LORE_BOUNDARY_REPORT,
          JSON.stringify(report, null, 2),
        );
    } finally {
      cleanup();
      globalThis.fetch = originalFetch;
    }
  },
);
