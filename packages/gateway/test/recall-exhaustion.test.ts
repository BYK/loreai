import { afterEach, describe, expect, test, vi } from "vitest";
import { loadSessionTracking } from "@loreai/core";
import { loadConfig } from "../src/config";
import {
  getActiveSessions,
  handleRequest,
  RECALL_FAILURE_WARNING,
  resetPipelineState,
  setUpstreamInterceptor,
  streamingPostResponsePendingForTest,
} from "../src/pipeline";
import { executeRecall } from "../src/recall";
import { MAX_CONSECUTIVE_RECALL_NO_PROGRESS } from "../src/recall-budget";
import type { GatewayRequest } from "../src/translate/types";

vi.mock("../src/recall", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/recall")>();
  return { ...actual, executeRecall: vi.fn() };
});

afterEach(async () => {
  setUpstreamInterceptor(undefined);
  vi.mocked(executeRecall).mockReset();
  await resetPipelineState();
});

function event(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`;
}

const SAFE_PRE_FAILURE_OUTPUT = "Safe output before recall failure.";
const RECALLS_BEFORE_FINAL_SYNTHESIS = MAX_CONSECUTIVE_RECALL_NO_PROGRESS + 1;
const FINAL_SYNTHESIS_CALL = RECALLS_BEFORE_FINAL_SYNTHESIS + 1;

function completedSseResponse(body: string): Record<string, unknown> {
  const matches = [
    ...body.matchAll(/^event: response\.completed\ndata: (.+)$/gm),
  ];
  expect(matches).toHaveLength(1);
  const payload = JSON.parse(matches[0][1]) as Record<string, unknown>;
  expect(payload).toMatchObject({
    type: "response.completed",
    response: { status: "completed" },
  });
  return payload.response as Record<string, unknown>;
}

function responseText(
  body: string,
  protocol: "anthropic" | "openai" | "openai-responses",
  stream: boolean,
): string {
  const response = (
    stream ? completedSseResponse(body) : JSON.parse(body)
  ) as Record<string, unknown>;
  if (protocol === "anthropic")
    return (response.content as Array<Record<string, unknown>>)
      .filter((block: Record<string, unknown>) => block.type === "text")
      .map((block: Record<string, unknown>) => block.text)
      .join("");
  if (protocol === "openai") {
    const choice = (response.choices as Array<Record<string, unknown>>)[0];
    const message = choice.message as Record<string, unknown>;
    return typeof message.content === "string" ? message.content : "";
  }
  return (response.output as Array<Record<string, unknown>>)
    .flatMap((item) =>
      Array.isArray(item.content)
        ? (item.content as Array<Record<string, unknown>>)
        : [],
    )
    .filter((part) => part.type === "output_text")
    .map((part) => part.text)
    .join("");
}

function activeSession(headerSessionId: string) {
  const state = [...getActiveSessions().values()].find(
    (candidate) => candidate.headerSessionId === headerSessionId,
  );
  if (!state) throw new Error("expected an active test session");
  return state;
}

async function settlePostResponse(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await vi.waitFor(() => expect(streamingPostResponsePendingForTest()).toBe(0));
}

function upstream(
  protocol: string,
  streaming: boolean,
  round: number,
  kind:
    | "recall"
    | "answer"
    | "tool"
    | "parallel"
    | "reasoning"
    | "refusal"
    | "safe-recall"
    | "unfinished",
): Response {
  if (kind === "unfinished") {
    if (protocol === "anthropic")
      return Response.json({
        id: `msg_${round}`,
        type: "message",
        role: "assistant",
        model: "claude-test",
        content: [{ type: "text", text: "partial answer" }],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 3, output_tokens: 2 },
      });
    return Response.json({
      id: `resp_${round}`,
      model: "gpt-5.6-terra",
      status: "in_progress",
      output: [
        {
          type: "message",
          id: `msg_${round}`,
          status: "in_progress",
          role: "assistant",
          content: [{ type: "output_text", text: "partial answer" }],
        },
      ],
      usage: { input_tokens: 3, output_tokens: 2 },
    });
  }
  if (kind === "reasoning" || kind === "refusal") {
    if (protocol === "anthropic")
      return Response.json({
        id: `msg_${round}`,
        type: "message",
        role: "assistant",
        model: "claude-test",
        content:
          kind === "refusal"
            ? [{ type: "text", text: "I cannot help with that." }]
            : [{ type: "thinking", thinking: "private", signature: "signed" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 3, output_tokens: 2 },
      });
    const item =
      kind === "refusal"
        ? {
            type: "message",
            id: `msg_${round}`,
            status: "completed",
            role: "assistant",
            content: [{ type: "refusal", refusal: "I cannot help with that." }],
          }
        : {
            type: "reasoning",
            id: `rs_${round}`,
            summary: [],
            encrypted_content: "opaque",
          };
    const response = {
      id: `resp_${round}`,
      model: "gpt-5.6-terra",
      status: "completed",
      output: [item],
      usage: { input_tokens: 3, output_tokens: 2 },
    };
    return streaming
      ? new Response(
          event("response.created", {
            response: { id: response.id, model: response.model },
          }) +
            event("response.output_item.added", {
              output_index: 0,
              item:
                kind === "refusal"
                  ? { type: item.type, id: item.id, role: "assistant" }
                  : item,
            }) +
            event("response.output_item.done", { output_index: 0, item }) +
            event("response.completed", { response }),
          { headers: { "content-type": "text/event-stream" } },
        )
      : Response.json(response);
  }
  const tool: {
    type: "tool_use";
    id: string;
    name: string;
    input: { query: string };
  } = {
    type: "tool_use",
    id: `call_${round}`,
    name: kind === "tool" ? "Read" : "recall",
    input: { query: `query ${round}` },
  };
  const content: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: { query: string } }
  > =
    kind === "answer"
      ? [{ type: "text", text: "Finished the task." }]
      : kind === "safe-recall"
        ? [{ type: "text", text: SAFE_PRE_FAILURE_OUTPUT }, tool]
        : kind === "parallel"
          ? [tool, { ...tool, id: `call_other_${round}` }]
          : [tool];
  if (protocol === "anthropic")
    return Response.json({
      id: `msg_${round}`,
      type: "message",
      role: "assistant",
      model: "claude-test",
      content,
      stop_reason: kind === "answer" ? "end_turn" : "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 3, output_tokens: 2 },
    });
  const items: Array<
    | {
        type: "message";
        id: string;
        status: string;
        role: string;
        content: Array<{ type: "output_text"; text: string }>;
      }
    | {
        type: "function_call";
        id: string;
        call_id: string;
        name: string;
        arguments: string;
        status: string;
      }
  > = content.map((block, index) =>
    block.type === "text"
      ? {
          type: "message",
          id: `msg_${round}`,
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: block.text }],
        }
      : {
          type: "function_call",
          id: `fc_${round}_${index}`,
          call_id: index ? `call_other_${round}` : `call_${round}`,
          name: kind === "tool" ? "Read" : "recall",
          arguments: JSON.stringify({ query: `query ${round}` }),
          status: "completed",
        },
  );
  const response = {
    id: `resp_${round}`,
    model: "gpt-5.6-terra",
    status: "completed",
    output: items,
    usage: { input_tokens: 3, output_tokens: 2 },
  };
  if (!streaming) return Response.json(response);
  return new Response(
    event("response.created", {
      response: { id: response.id, model: response.model },
    }) +
      items
        .map((item, index) => {
          const added =
            item.type === "function_call"
              ? {
                  type: item.type,
                  id: item.id,
                  call_id: item.call_id,
                  name: item.name,
                }
              : { type: item.type, id: item.id, role: "assistant" };
          return (
            event("response.output_item.added", {
              output_index: index,
              item: added,
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
                  text: item.content[0].text,
                })) +
            event("response.output_item.done", { output_index: index, item })
          );
        })
        .join("") +
      event("response.completed", { response }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

describe.each([
  ["anthropic", false, false, "anthropic"],
  ["openai-responses", false, false, "openai-responses"],
  ["openai-responses", true, false, "openai-responses"],
  ["openai-responses", false, true, "openai-responses"],
  ["anthropic", false, false, "openai-responses"],
  ["openai", false, false, "openai-responses"],
] as const)(
  "recall no-progress finalization: %s stream=%s codex=%s upstream=%s",
  (protocol, stream, codex, upstreamProtocol) => {
    test.each([
      "answer",
      "tool",
      "recall",
      "failed",
      "parallel",
      "reasoning",
      "refusal",
      "unfinished",
    ] as const)("final result %s", async (mode) => {
      vi.mocked(executeRecall).mockImplementation(async () => {
        return {
          result: "real recall result",
          input: { query: "architecture" },
          coverage: [],
        };
      });
      const config = loadConfig();
      config.remoteGateway = false;
      config.hostedMode = false;
      const session = `exhaustion-${crypto.randomUUID()}`;
      const req: GatewayRequest = {
        protocol,
        stream,
        codex,
        model:
          upstreamProtocol === "anthropic" ? "claude-test" : "gpt-5.6-terra",
        system: "You are a coding agent.",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Finish the task using project memory." },
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
        metadata:
          protocol === "anthropic"
            ? { tool_choice: { type: "tool", name: "recall" } }
            : {},
        extras:
          protocol === "openai-responses"
            ? { tool_choice: { type: "function", name: "recall" } }
            : {},
        rawHeaders: {
          ...(upstreamProtocol === "anthropic"
            ? { "x-api-key": "test-key" }
            : { authorization: "Bearer test-key" }),
          "x-lore-session-id": session,
          "x-lore-agent": "coder",
          "x-lore-project": process.cwd(),
          "x-lore-provider":
            upstreamProtocol === "anthropic" ? "anthropic" : "openai",
          "x-lore-upstream-url":
            upstreamProtocol === "anthropic"
              ? "https://api.anthropic.com"
              : "https://api.openai.com/v1",
        },
      };
      let calls = 0;
      let lastBody: Record<string, unknown> | undefined;
      let firstBody: Record<string, unknown> | undefined;
      setUpstreamInterceptor(async (body) => {
        calls++;
        const requestBody = body as Record<string, unknown>;
        firstBody ??= structuredClone(requestBody);
        if (calls === 1) {
          expect(requestBody.tools).toEqual(firstBody.tools);
          expect(requestBody.tool_choice).toEqual(firstBody.tool_choice);
        }
        if (calls === FINAL_SYNTHESIS_CALL) {
          lastBody = requestBody;
          if (mode === "failed")
            return new Response("provider diagnostic must not leak", {
              status: 503,
            });
          return upstream(
            upstreamProtocol,
            requestBody.stream === true,
            calls,
            mode,
          );
        }
        if (calls > FINAL_SYNTHESIS_CALL)
          throw new Error("unexpected provider call after final synthesis");
        return upstream(
          upstreamProtocol,
          requestBody.stream === true,
          calls,
          calls === 1 ? "safe-recall" : "recall",
        );
      });
      const response = await handleRequest(req, config);
      const body = await response.text();
      expect(calls).toBe(FINAL_SYNTHESIS_CALL);
      expect(vi.mocked(executeRecall)).toHaveBeenCalledTimes(
        RECALLS_BEFORE_FINAL_SYNTHESIS,
      );
      const finalTools = lastBody?.tools as
        | Array<{
            name?: string;
            function?: { name?: string };
          }>
        | undefined;
      const finalToolNames = finalTools?.map(
        (tool) => tool.name ?? tool.function?.name,
      );
      if (upstreamProtocol === "anthropic" || codex) {
        expect(finalToolNames).toContain("Read");
        expect(finalToolNames).not.toContain("recall");
        expect(lastBody?.tool_choice).not.toEqual(
          expect.objectContaining({ name: "recall" }),
        );
      } else {
        expect(lastBody?.tools).toEqual(firstBody?.tools);
        expect(lastBody?.tool_choice).toEqual({
          type: "allowed_tools",
          mode: "auto",
          tools: [{ type: "function", name: "Read" }],
        });
      }
      expect(JSON.stringify(lastBody)).toContain("Recall must stop now");
      if (mode === "answer" || mode === "tool" || mode === "refusal") {
        expect(response.status).toBe(200);
        expect(body).toContain(
          mode === "answer"
            ? "Finished the task."
            : mode === "refusal"
              ? "I cannot help with that."
              : '"Read"',
        );
        expect(body).not.toContain("Lore could not retrieve more memory");
        if (mode === "refusal" && protocol === "openai-responses") {
          if (stream) {
            expect(body.match(/^event: response\.completed$/gm)).toHaveLength(
              1,
            );
            expect(body).not.toContain("event: response.failed");
          } else {
            expect(JSON.parse(body)).toMatchObject({
              status: "completed",
              output: [
                {
                  type: "message",
                  content: [
                    { type: "refusal", refusal: "I cannot help with that." },
                  ],
                },
              ],
            });
          }
        }
        if (mode === "refusal" && protocol === "anthropic") {
          expect(JSON.parse(body).content).toEqual([
            { type: "text", text: "I cannot help with that." },
          ]);
        }
        if (mode === "refusal" && protocol === "openai") {
          expect(JSON.parse(body).choices[0].message.content).toBe(
            "I cannot help with that.",
          );
        }
      } else {
        expect(response.status).toBe(200);
        if (stream) {
          completedSseResponse(body);
          expect(body).not.toContain("event: response.failed");
        }
        const text = responseText(body, protocol, stream);
        expect(text.split(RECALL_FAILURE_WARNING)).toHaveLength(2);
        expect(text.endsWith(RECALL_FAILURE_WARNING)).toBe(true);
        expect(text).toContain(SAFE_PRE_FAILURE_OUTPUT);
        expect(body).not.toContain("response.failed");
        expect(body).not.toContain('"status":"failed"');
        expect(body).not.toContain("provider diagnostic must not leak");
        expect(body).not.toContain("real recall result");
        expect(body).not.toContain("architecture");
        expect(body).not.toContain("Recall must stop now");
        expect(body).not.toContain("📚 Searching");
        expect(body).not.toContain("📚 Fetching");
        expect(body).not.toContain("lore-recall:");
        expect(body).not.toContain('"name":"recall"');
        expect(body).not.toContain("depth_exhausted");
        expect(body).not.toContain("follow_up_");
        for (let round = 1; round <= FINAL_SYNTHESIS_CALL; round++) {
          expect(body).not.toContain(`query ${round}`);
          expect(body).not.toContain(`call_${round}`);
          expect(body).not.toContain(`fc_${round}_`);
        }
        await settlePostResponse();
        const state = activeSession(session);
        expect(state.recallStore.size).toBe(0);
        const durableRecallStore = loadSessionTracking(
          state.sessionID,
        )?.recallStore;
        expect(
          durableRecallStore === null || durableRecallStore === undefined
            ? []
            : JSON.parse(durableRecallStore),
        ).toEqual([]);
      }
    });
  },
);

test("continues through 25 productive recall calls before the final answer", async () => {
  const config = loadConfig();
  config.remoteGateway = false;
  config.hostedMode = false;
  const session = `productive-recalls-${crypto.randomUUID()}`;
  const productiveRecallRounds = 25;
  const req: GatewayRequest = {
    protocol: "openai-responses",
    stream: true,
    codex: false,
    model: "gpt-5.6-terra",
    system: "You are a coding agent.",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Finish the task using project memory." },
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
    extras: { tool_choice: { type: "function", name: "recall" } },
    rawHeaders: {
      authorization: "Bearer test-key",
      "x-lore-session-id": session,
      "x-lore-agent": "coder",
      "x-lore-project": process.cwd(),
      "x-lore-provider": "openai",
      "x-lore-upstream-url": "https://api.openai.com/v1",
    },
  };
  let recallCalls = 0;
  vi.mocked(executeRecall).mockImplementation(async () => {
    recallCalls++;
    return {
      result: `source ${recallCalls}`,
      input: { query: `query ${recallCalls}` },
      coverage: [
        {
          identity: `k:source-${recallCalls}`,
          revision: "revision-1",
          offset: 0,
          length: 1,
          complete: false,
          kind: "detail",
        },
      ],
    };
  });
  const requestBodies: Array<Record<string, unknown>> = [];
  setUpstreamInterceptor(async (body) => {
    const requestBody = body as Record<string, unknown>;
    requestBodies.push(structuredClone(requestBody));
    const round = requestBodies.length;
    return upstream(
      "openai-responses",
      requestBody.stream === true,
      round,
      round <= productiveRecallRounds ? "recall" : "answer",
    );
  });

  const response = await handleRequest(req, config);
  const body = await response.text();

  expect(requestBodies).toHaveLength(productiveRecallRounds + 1);
  expect(response.status).toBe(200);
  expect(recallCalls).toBe(productiveRecallRounds);
  for (const requestBody of requestBodies) {
    const toolNames = (
      requestBody.tools as Array<{
        name?: string;
        function?: { name?: string };
      }>
    ).map((tool) => tool.name ?? tool.function?.name);
    expect(toolNames).toContain("recall");
    expect(requestBody.tool_choice).not.toEqual(
      expect.objectContaining({ type: "allowed_tools" }),
    );
  }
  expect(body).toContain("Finished the task.");
  expect(body).not.toContain(RECALL_FAILURE_WARNING);
  expect(body).not.toContain("source 1");
  expect(body).not.toContain("source 25");
  expect(body.match(/^event: response.completed$/gm)).toHaveLength(1);
  await settlePostResponse();
  expect(activeSession(session).recallStore.size).toBe(productiveRecallRounds);
});
