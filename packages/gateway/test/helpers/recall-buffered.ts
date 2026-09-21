// Shared fixtures for the recall buffered-transaction test files
// (split from recall-buffered-transaction.test.ts). Tests import these
// helpers; each file keeps its own vi.mock of core config + afterEach.
import { expect, vi } from "vitest";
import * as core from "@loreai/core";
import { ltm } from "@loreai/core";
import { loadConfig } from "../../src/config";
import { clearAllCosts } from "../../src/cost-tracker";
import {
  getActiveSessions,
  resetPipelineState,
  setRecallPersistenceCommitObserverForTest,
  setUpstreamInterceptor,
  streamingPostResponsePendingForTest,
} from "../../src/pipeline";
import type { GatewayRequest } from "../../src/translate/types";
import { _resetForTest as resetWorkerHealth } from "../../src/worker-health";

export const query =
  "transactional glacier orchard telescope cobalt lantern mercury compass velvet island";
let productiveRecallIds: string[] | undefined;

/**
 * Terminal-recall fixtures start with a search then use distinct detail reads,
 * so they remain productive. They use the minimum legal emergency cap to test
 * finalization without coupling the test runtime to the production default.
 */
export const TEST_RECALL_EXECUTION_CAP = 12;
export const FINAL_RECALL_CALL = TEST_RECALL_EXECUTION_CAP + 1;

export function prepareProductiveRecallSources(
  count = TEST_RECALL_EXECUTION_CAP - 1,
): void {
  const currentConfig = core.config();
  vi.spyOn(core, "config").mockReturnValue({
    ...currentConfig,
    search: {
      ...currentConfig.search,
      recall: {
        ...currentConfig.search.recall,
        chainMaxExecutions: TEST_RECALL_EXECUTION_CAP,
      },
    },
  });
  productiveRecallIds = Array.from({ length: count }, (_, index) =>
    // `ltm.create()` intentionally deduplicates same-title entries. Give every
    // detail round its own logical source while keeping the shared query terms
    // in its body for the initial search.
    knowledge(`${query} source ${index + 1}`),
  );
}

export type Protocol = "anthropic" | "openai" | "openai-responses";
export type Outcome = "recall" | "answer" | "mixed" | "invalid" | "bad-usage";

export function providerResponse(
  protocol: Protocol,
  round: number,
  outcome: Outcome,
  stream = false,
): Response {
  const recalling = outcome === "recall" || outcome === "mixed";
  const invalid = outcome === "invalid" || outcome === "bad-usage";
  const input = outcome === "bad-usage" ? -1000 : invalid ? 1000 : 3;
  const output = invalid ? 100 : 2;
  const recallInput = productiveRecallIds?.[round - 2]
    ? { id: `k:${productiveRecallIds[round - 2]}` }
    : { query };
  const tool = {
    type: "tool_use",
    id: `call_${round}`,
    name: "recall",
    input: recallInput,
  };
  const toolCalls = [
    tool,
    ...(outcome === "mixed" ? [{ ...tool, id: "read", name: "Read" }] : []),
  ];
  const content = recalling
    ? toolCalls
    : [{ type: "text", text: "Completed answer" }];
  if (protocol === "anthropic") {
    const response = {
      id: `msg_${round}`,
      model: "claude-test",
      type: "message",
      role: "assistant",
      content,
      stop_reason: invalid ? null : recalling ? "tool_use" : "end_turn",
      usage: { input_tokens: input, output_tokens: output },
    };
    return stream ? anthropicStream(response) : Response.json(response);
  }
  if (protocol === "openai") {
    return Response.json({
      id: `chatcmpl_${round}`,
      model: "gpt-test",
      choices: [
        {
          index: 0,
          finish_reason: invalid ? null : recalling ? "tool_calls" : "stop",
          message: {
            role: "assistant",
            content: recalling ? null : "Completed answer",
            ...(recalling
              ? {
                  tool_calls: toolCalls.map((block) => ({
                    id: block.id,
                    type: "function",
                    function: {
                      name: block.name,
                      arguments: JSON.stringify(recallInput),
                    },
                  })),
                }
              : {}),
          },
        },
      ],
      usage: {
        prompt_tokens: input,
        completion_tokens: output,
        total_tokens: input + output,
      },
    });
  }
  const items = recalling
    ? toolCalls.map((block) => ({
        type: "function_call" as const,
        id: `fc_${block.id}`,
        call_id: block.id,
        name: block.name,
        arguments: JSON.stringify(recallInput),
        status: "completed",
      }))
    : [
        {
          type: "message" as const,
          id: `msg_${round}`,
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Completed answer" }],
        },
      ];
  const response = {
    id: `resp_${round}`,
    model: "gpt-test",
    status: invalid ? (stream ? "failed" : "in_progress") : "completed",
    ...(invalid && stream
      ? { error: { type: "server_error", message: "did not complete" } }
      : {}),
    output: items,
    usage: { input_tokens: input, output_tokens: output },
  };
  if (!stream) return Response.json(response);
  return responsesStream(response);
}

export function responsesStream(response: Record<string, unknown>): Response {
  const items = response.output as Array<Record<string, unknown>>;
  const event = (type: string, data: object) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  return new Response(
    event("response.created", {
      response: { id: response.id, model: response.model },
    }) +
      items
        .map(
          (item, index) =>
            event("response.output_item.added", {
              output_index: index,
              item:
                item.type === "function_call"
                  ? {
                      type: item.type,
                      id: item.id,
                      call_id: item.call_id,
                      name: item.name,
                      arguments: "",
                    }
                  : { type: item.type, id: item.id, role: "assistant" },
            }) +
            (item.type === "function_call"
              ? event("response.function_call_arguments.done", {
                  output_index: index,
                  item_id: item.id,
                  arguments: item.arguments,
                })
              : event("response.output_text.done", {
                  output_index: index,
                  item_id: item.id,
                  content_index: 0,
                  text: "Completed answer",
                })) +
            event("response.output_item.done", { output_index: index, item }),
        )
        .join("") +
      event(
        response.status === "failed" ? "response.failed" : "response.completed",
        { response },
      ),
    { headers: { "content-type": "text/event-stream" } },
  );
}

export function anthropicStream(json: Record<string, unknown>): Response {
  const event = (type: string, data: object) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const usage = json.usage as Record<string, unknown>;
  return new Response(
    event("message_start", {
      message: {
        ...json,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: usage.input_tokens, output_tokens: 0 },
      },
    }) +
      (json.content as Array<Record<string, unknown>>)
        .map(
          (block, index) =>
            event("content_block_start", {
              index,
              content_block:
                block.type === "tool_use"
                  ? { ...block, input: {} }
                  : { type: "text", text: "" },
            }) +
            event("content_block_delta", {
              index,
              delta:
                block.type === "tool_use"
                  ? {
                      type: "input_json_delta",
                      partial_json: JSON.stringify(block.input),
                    }
                  : { type: "text_delta", text: block.text },
            }) +
            event("content_block_stop", { index }),
        )
        .join("") +
      event("message_delta", {
        delta: { stop_reason: json.stop_reason, stop_sequence: null },
        usage: { output_tokens: usage.output_tokens },
      }) +
      event("message_stop", {}),
    { headers: { "content-type": "text/event-stream" } },
  );
}
export function request(
  protocol: Protocol | "gemini",
  alias: string,
  codex = false,
): GatewayRequest {
  return {
    protocol,
    codex,
    stream: false,
    model: protocol === "anthropic" ? "claude-test" : "gpt-test",
    system: "You are a coding agent.",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Use project memory to complete the task." },
        ],
      },
    ],
    tools: [
      {
        name: "Read",
        description: "Read a file",
        inputSchema: { type: "object", properties: {} },
      },
    ],
    maxTokens: 1024,
    metadata: {},
    rawHeaders: {
      ...(protocol === "anthropic"
        ? { "x-api-key": "test-key" }
        : { authorization: "Bearer test-key" }),
      "x-lore-session-id": alias,
      "x-lore-agent": "coder",
      "x-lore-project": "/test/buffered-recall-destination",
      "x-lore-provider":
        protocol === "anthropic"
          ? "anthropic"
          : protocol === "openai"
            ? "vllm"
            : "openai",
      "x-lore-upstream-url":
        protocol === "anthropic"
          ? "https://api.anthropic.com"
          : "https://api.openai.com/v1",
    },
  };
}

export function config() {
  const cfg = loadConfig();
  cfg.remoteGateway = false;
  cfg.hostedMode = false;
  return cfg;
}

const createdKnowledge = new Set<string>();

export function knowledge(title = query) {
  const id = ltm.create({
    projectPath: `/test/buffered-recall-origin/${crypto.randomUUID()}`,
    category: "gotcha",
    title,
    content: `${query}: preserve transaction boundaries.`,
    scope: "project",
    crossProject: true,
    // The fixture deliberately needs independently addressable records. The
    // production fuzzy-dedup guard otherwise merges these near-identical
    // test entries into one logical source.
    id: crypto.randomUUID(),
  });
  createdKnowledge.add(id);
  return id;
}

export function stateFor(alias: string) {
  const state = [...getActiveSessions().values()].find(
    (s) => s.headerSessionId === alias,
  );
  expect(state).toBeDefined();
  return state!;
}

export async function settled() {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await vi.waitFor(() => expect(streamingPostResponsePendingForTest()).toBe(0));
}

/**
 * Per-test cleanup shared by every recall-buffered file. Call from afterEach.
 */
export async function resetRecallBufferedForTest(): Promise<void> {
  setUpstreamInterceptor(undefined);
  setRecallPersistenceCommitObserverForTest(undefined);
  await resetPipelineState();
  clearAllCosts();
  for (const id of createdKnowledge) ltm.remove(id);
  createdKnowledge.clear();
  productiveRecallIds = undefined;
  vi.restoreAllMocks();
  resetWorkerHealth();
}
