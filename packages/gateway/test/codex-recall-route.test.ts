import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockAgent } from "undici";
import * as core from "@loreai/core";
import type { Harness } from "./helpers/harness";
import { createHarness } from "./helpers/harness";
import { setUpstreamDispatcherForTest } from "../src/fetch";
import { setUpstreamInterceptor } from "../src/pipeline";
import { _setModelDataForTest, clearModelDataCache } from "../src/worker-model";

type RecallRouteCase = {
  route: "provider" | "interceptor";
  model: string;
  principalTokens: number;
  continuationTokens: number;
  contextTokens?: number;
  qualified?: boolean;
  succeeds?: boolean;
  continuationModel?: string;
  continuationUsage?: "complete" | "missing" | "input-only";
};

function event(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

function recallResponse(inputTokens: number, model = "gpt-6-sol"): string {
  const item = {
    type: "function_call",
    id: "fc_codex_principal",
    call_id: "call_codex_principal",
    name: "recall",
    arguments: JSON.stringify({
      query:
        "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron",
    }),
    status: "completed",
  };
  return (
    event("response.created", {
      response: {
        id: "resp_codex_principal",
        model,
        status: "in_progress",
      },
    }) +
    event("response.output_item.added", {
      output_index: 0,
      item: { ...item, arguments: "", status: "in_progress" },
    }) +
    event("response.function_call_arguments.done", {
      output_index: 0,
      item_id: item.id,
      arguments: item.arguments,
    }) +
    event("response.output_item.done", { output_index: 0, item }) +
    event("response.completed", {
      response: {
        id: "resp_codex_principal",
        model,
        status: "completed",
        output: [item],
        usage: { input_tokens: inputTokens, output_tokens: 10 },
      },
    })
  );
}

function finalResponse(
  inputTokens: number,
  model = "gpt-6-sol",
  usage: "complete" | "missing" | "input-only" = "complete",
): string {
  const item = {
    type: "message",
    id: "msg_codex_answer",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "answer after recall" }],
  };
  return (
    event("response.created", {
      response: {
        id: "resp_codex_answer",
        model,
        status: "in_progress",
      },
    }) +
    event("response.output_item.added", {
      output_index: 0,
      item: {
        type: "message",
        id: item.id,
        role: "assistant",
        status: "in_progress",
      },
    }) +
    event("response.output_text.delta", {
      output_index: 0,
      item_id: item.id,
      content_index: 0,
      delta: "answer after recall",
    }) +
    event("response.output_text.done", {
      output_index: 0,
      item_id: item.id,
      content_index: 0,
      text: "answer after recall",
    }) +
    event("response.output_item.done", { output_index: 0, item }) +
    event("response.completed", {
      response: {
        id: "resp_codex_answer",
        model,
        status: "completed",
        output: [item],
        ...(usage === "missing"
          ? {}
          : {
              usage: {
                input_tokens: inputTokens,
                ...(usage === "complete" ? { output_tokens: 10 } : {}),
              },
            }),
      },
    })
  );
}

describe("Codex recall through the real ingress and forwarding path", () => {
  let harness: Harness | undefined;
  let mock: MockAgent | undefined;
  let projectPath: string | undefined;
  let originalQueryExpansion: boolean | undefined;

  afterEach(async () => {
    if (originalQueryExpansion !== undefined) {
      core.config().search.queryExpansion = originalQueryExpansion;
      originalQueryExpansion = undefined;
    }
    await harness?.teardown();
    harness = undefined;
    if (projectPath) rmSync(projectPath, { recursive: true, force: true });
    projectPath = undefined;
    setUpstreamInterceptor(undefined);
    setUpstreamDispatcherForTest(null);
    await mock?.close();
    mock = undefined;
    clearModelDataCache();
  });

  it.each<RecallRouteCase>([
    {
      route: "provider",
      model: "gpt-6-sol",
      principalTokens: 240_000,
      continuationTokens: 241_000,
    },
    {
      route: "interceptor",
      model: "gpt-6-sol",
      principalTokens: 70_000,
      continuationTokens: 90_000,
    },
    {
      route: "provider",
      model: "gpt-6.1-terra",
      principalTokens: 83_000,
      continuationTokens: 84_000,
    },
    {
      route: "interceptor",
      model: "gpt-6.1-terra",
      principalTokens: 83_000,
      continuationTokens: 84_000,
    },
    {
      route: "provider",
      model: "gpt-6.1-terra",
      principalTokens: 83_000,
      continuationTokens: 129_000,
      succeeds: false,
    },
    {
      route: "interceptor",
      model: "gpt-6.1-terra",
      principalTokens: 70_000,
      continuationTokens: 90_000,
      contextTokens: 80_000,
      succeeds: false,
    },
    {
      route: "provider",
      model: "gpt-6.1-terra",
      principalTokens: 83_000,
      continuationTokens: 84_000,
      qualified: false,
      succeeds: false,
    },
    ...(["provider", "interceptor"] as const).flatMap((route) => [
      {
        route,
        model: "gpt-6.1-terra",
        principalTokens: 30_000,
        continuationTokens: 110_000,
        contextTokens: 80_000,
        succeeds: false,
      },
      {
        route,
        model: "gpt-6.1-terra",
        principalTokens: 30_000,
        continuationTokens: 31_000,
        continuationModel: "gpt-6.1-sol",
        succeeds: false,
      },
      ...(["missing", "input-only"] as const).map((continuationUsage) => ({
        route,
        model: "gpt-6.1-terra",
        principalTokens: 30_000,
        continuationTokens: 31_000,
        continuationUsage,
        succeeds: false,
      })),
      {
        route,
        model: "gpt-6.1-terra",
        principalTokens: 30_000,
        continuationTokens: 31_000,
        contextTokens: 80_000,
      },
    ]),
  ])(
    "bounds $route $model recall with $continuationTokens continuation tokens (qualified=$qualified, context=$contextTokens, model=$continuationModel, usage=$continuationUsage, succeeds=$succeeds)",
    async ({
      route,
      model,
      principalTokens,
      continuationTokens,
      contextTokens = 1_050_000,
      qualified = true,
      succeeds = true,
      continuationModel = model,
      continuationUsage = "complete",
    }) => {
      mock = new MockAgent();
      mock.disableNetConnect();
      setUpstreamDispatcherForTest(mock);
      projectPath = mkdtempSync(join(tmpdir(), "lore-codex-route-"));
      harness = await createHarness({ fixtures: [], projectPath });
      originalQueryExpansion = core.config().search.queryExpansion;
      core.config().search.queryExpansion = false;
      const modelEntry = {
        id: model,
        limit: { context: contextTokens, output: 128_000 },
      };
      _setModelDataForTest(
        { [model]: modelEntry },
        qualified ? { [`openai/${model}`]: modelEntry } : {},
      );
      const gatewayInputTypes: string[][] = [];
      setUpstreamInterceptor((body, _model, _stream, makeReal) => {
        const request = body as { input?: Array<{ type?: string }> };
        gatewayInputTypes.push(
          request.input?.map((item) => item.type ?? "unknown") ?? [],
        );
        return makeReal();
      });

      const codex = mock.get("https://chatgpt.com");
      const forwardedInputTypes: string[][] = [];
      for (const body of [
        recallResponse(principalTokens, model),
        finalResponse(continuationTokens, continuationModel, continuationUsage),
      ]) {
        codex
          .intercept({ path: "/backend-api/codex/responses", method: "POST" })
          .reply((opts) => {
            const request = JSON.parse(
              typeof opts.body === "string"
                ? opts.body
                : (JSON.stringify(opts.body) ?? ""),
            ) as { input?: Array<{ type?: string }> };
            forwardedInputTypes.push(
              request.input?.map((item) => item.type ?? "unknown") ?? [],
            );
            return {
              statusCode: 200,
              data: body,
              responseOptions: {
                headers: { "content-type": "text/event-stream" },
              },
            };
          });
      }

      const response = await harness.request("/v1/codex/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-key",
          "x-lore-agent": "coder",
          "x-lore-project": projectPath,
          "x-lore-session-id": `codex-ingress-${route}`,
          "x-lore-no-store": "true",
          "x-lore-provider": route === "provider" ? "openai-codex" : "openai",
          ...(route === "interceptor"
            ? {
                "x-lore-upstream-url": "https://chatgpt.com/backend-api",
                "x-lore-upstream-path": "/backend-api/codex/responses",
              }
            : {}),
        },
        body: JSON.stringify({
          model,
          stream: true,
          store: false,
          input: [
            {
              role: "user",
              content: [{ type: "input_text", text: "continue" }],
            },
          ],
          tools: [
            {
              type: "function",
              name: "read",
              description: "Read a file",
              parameters: { type: "object", properties: {} },
            },
          ],
        }),
      });
      const output = await response.text();
      expect(response.status).toBe(200);
      expect(mock.pendingInterceptors()).toEqual([]);
      // The client supplied a shorthand user item with no `type`; replay
      // keeps that native envelope through both recall turns.
      expect(gatewayInputTypes).toEqual([
        ["unknown"],
        ["unknown", "function_call", "function_call_output"],
      ]);
      expect(forwardedInputTypes).toEqual([
        ["unknown"],
        ["unknown", "function_call", "function_call_output"],
      ]);
      if (succeeds) {
        expect(output).toContain("answer after recall");
        expect(output).toContain("response.completed");
        expect(output).not.toContain("response.failed");
      } else {
        expect(output).toContain("response.failed");
        expect(output).not.toContain("answer after recall");
      }
    },
  );
});
