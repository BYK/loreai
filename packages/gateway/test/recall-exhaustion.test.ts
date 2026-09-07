import { afterEach, describe, expect, test, vi } from "vitest";
import { db } from "@loreai/core";
import { loadConfig } from "../src/config";
import {
  handleRequest,
  resetPipelineState,
  setUpstreamInterceptor,
} from "../src/pipeline";
import { executeRecall } from "../src/recall";
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
  const tool = {
    type: "tool_use",
    id: `call_${round}`,
    name: kind === "tool" ? "Read" : "recall",
    input: { query: `query ${round}` },
  };
  const content =
    kind === "answer"
      ? [{ type: "text", text: "Finished the task." }]
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
  const items = content.map((block, index) =>
    block.type === "text"
      ? {
          type: "message",
          id: `msg_${round}`,
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: "Finished the task." }],
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
                  text: "Finished the task.",
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
  ["anthropic", false, false],
  ["openai-responses", false, false],
  ["openai-responses", true, false],
  ["openai-responses", false, true],
] as const)(
  "recall exhaustion: %s stream=%s codex=%s",
  (protocol, stream, codex) => {
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
      vi.mocked(executeRecall).mockResolvedValue({
        result: "real recall result",
        input: { query: "architecture" },
      });
      const config = loadConfig();
      config.remoteGateway = false;
      config.hostedMode = false;
      const session = `exhaustion-${crypto.randomUUID()}`;
      const req: GatewayRequest = {
        protocol,
        stream,
        codex,
        model: protocol === "anthropic" ? "claude-test" : "gpt-5.6-terra",
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
          ...(protocol === "anthropic"
            ? { "x-api-key": "test-key" }
            : { authorization: "Bearer test-key" }),
          "x-lore-session-id": session,
          "x-lore-agent": "coder",
          "x-lore-project": process.cwd(),
          "x-lore-provider": protocol === "anthropic" ? "anthropic" : "openai",
          "x-lore-upstream-url":
            protocol === "anthropic"
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
        expect(requestBody.tools).toEqual(firstBody.tools);
        expect(requestBody.tool_choice).toEqual(firstBody.tool_choice);
        if (calls === 11) {
          lastBody = requestBody;
          if (mode === "failed")
            return new Response("provider diagnostic must not leak", {
              status: 503,
            });
          return upstream(
            protocol,
            requestBody.stream === true,
            calls,
            mode === "parallel" ? "answer" : mode,
          );
        }
        return upstream(
          protocol,
          requestBody.stream === true,
          calls,
          mode === "parallel" ? "parallel" : "recall",
        );
      });
      const response = await handleRequest(req, config);
      const body = await response.text();
      if (mode === "parallel") {
        expect(vi.mocked(executeRecall)).not.toHaveBeenCalled();
        expect(calls).toBe(1);
      } else {
        expect(calls).toBe(11);
        expect(vi.mocked(executeRecall)).toHaveBeenCalledTimes(10);
        expect(lastBody?.tools).toEqual(firstBody?.tools);
        expect(lastBody?.tool_choice).toEqual(firstBody?.tool_choice);
        expect(JSON.stringify(lastBody)).toContain(
          "The recall budget for this turn has been used",
        );
      }
      if (mode === "answer" || mode === "tool" || mode === "refusal") {
        expect(response.status).toBe(200);
        expect(body).toContain(
          mode === "answer"
            ? "Finished the task."
            : mode === "refusal"
              ? "I cannot help with that."
              : '"Read"',
        );
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
        expect(body).not.toContain("Recall depth limit reached");
      } else {
        if (stream) {
          expect(body.match(/^event: response\.failed$/gm)).toHaveLength(1);
          expect(body).not.toContain("event: response.completed");
        } else expect(response.status).toBe(502);
        expect(body).not.toContain("provider diagnostic");
        expect(
          db()
            .query(
              "SELECT count(*) AS count FROM temporal_messages WHERE session_id = ? AND role = 'assistant'",
            )
            .get(session),
        ).toMatchObject({ count: 0 });
      }
    });
  },
);
