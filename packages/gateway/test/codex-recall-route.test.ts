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

function event(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

function recallResponse(inputTokens: number): string {
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
        model: "gpt-6-sol",
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
        model: "gpt-6-sol",
        status: "completed",
        output: [item],
        usage: { input_tokens: inputTokens, output_tokens: 10 },
      },
    })
  );
}

function finalResponse(inputTokens: number): string {
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
        model: "gpt-6-sol",
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
        model: "gpt-6-sol",
        status: "completed",
        output: [item],
        usage: { input_tokens: inputTokens, output_tokens: 10 },
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

  it.each([
    {
      route: "provider",
      principalTokens: 240_000,
      continuationTokens: 241_000,
    },
    {
      route: "interceptor",
      principalTokens: 70_000,
      continuationTokens: 90_000,
    },
  ])(
    "forwards both $route recall turns to Codex within its verified window",
    async ({ route, principalTokens, continuationTokens }) => {
      mock = new MockAgent();
      mock.disableNetConnect();
      setUpstreamDispatcherForTest(mock);
      projectPath = mkdtempSync(join(tmpdir(), "lore-codex-route-"));
      harness = await createHarness({ fixtures: [], projectPath });
      originalQueryExpansion = core.config().search.queryExpansion;
      core.config().search.queryExpansion = false;
      const modelEntry = {
        id: "gpt-6-sol",
        limit: { context: 1_050_000, output: 128_000 },
      };
      _setModelDataForTest(
        { "gpt-6-sol": modelEntry },
        { "openai/gpt-6-sol": modelEntry },
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
        recallResponse(principalTokens),
        finalResponse(continuationTokens),
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
          model: "gpt-6-sol",
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
      expect(output).toContain("answer after recall");
      expect(output).toContain("response.completed");
      expect(output).not.toContain("response.failed");
    },
  );
});
