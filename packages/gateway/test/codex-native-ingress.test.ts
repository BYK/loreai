import { afterEach, describe, expect, test, vi } from "vitest";
import { MockAgent } from "undici";
import { createHarness, type Harness } from "./helpers/harness";
import { setUpstreamDispatcherForTest } from "../src/fetch";
import {
  getActiveSessions,
  setPostResponseStartObserverForTest,
  setUpstreamInterceptor,
} from "../src/pipeline";
import { RECALL_TOOL_NAME } from "../src/recall";

function stream(items: Array<Record<string, unknown>>, id: string): string {
  const frame = (type: string, body: Record<string, unknown>) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`;
  let out = frame("response.created", {
    response: { id, model: "gpt-6-sol", status: "in_progress" },
  });
  for (const [output_index, item] of items.entries()) {
    out += frame("response.output_item.added", {
      output_index,
      item: {
        ...item,
        status: "in_progress",
        ...(item.type === "custom_tool_call"
          ? { input: "" }
          : item.type === "function_call"
            ? { arguments: "" }
            : { content: [] }),
      },
    });
    if (item.type === "function_call")
      out += frame("response.function_call_arguments.done", {
        output_index,
        item_id: item.id,
        arguments: item.arguments,
      });
    out += frame("response.output_item.done", { output_index, item });
  }
  return (
    out +
    frame("response.completed", {
      response: {
        id,
        model: "gpt-6-sol",
        status: "completed",
        output: items,
        usage: { input_tokens: 100, output_tokens: 10 },
      },
    })
  );
}

describe("current Codex through real gateway ingress", () => {
  let harness: Harness | undefined;
  let mock: MockAgent | undefined;
  afterEach(async () => {
    await harness?.teardown();
    harness = undefined;
    setUpstreamInterceptor(undefined);
    setPostResponseStartObserverForTest(undefined);
    setUpstreamDispatcherForTest(null);
    await mock?.close();
    mock = undefined;
  });

  test("does not retain native metadata from an instruction-only request after finalization", async () => {
    harness = await createHarness({ fixtures: [] });
    let finalized = 0;
    setPostResponseStartObserverForTest(() => finalized++);
    setUpstreamInterceptor(
      async () =>
        new Response(
          stream(
            [
              {
                type: "message",
                id: "answer",
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: "Done" }],
              },
            ],
            "resp_instruction_only",
          ),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const response = await harness.request("/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer synthetic-token",
        "chatgpt-account-id": "synthetic-account",
        "x-lore-agent": "coder",
      },
      body: JSON.stringify({
        model: "gpt-6-sol",
        stream: true,
        input: [
          {
            type: "message",
            role: "developer",
            content: "Rule",
            internal_chat_message_metadata_passthrough: {
              PRIVATE_NATIVE_KEY: "never-retain",
            },
          },
        ],
      }),
    });
    const body = await response.text();
    expect(response.status, body).toBe(200);
    expect(body).toContain("response.completed");
    await vi.waitFor(() => expect(finalized).toBe(1));
    const sessions = [...getActiveSessions().values()];
    expect(sessions).toHaveLength(1);
    expect(sessions[0].cacheAnalytics.lastRequestBody).toBeNull();
    expect(sessions[0].cacheAnalytics.lastNormalizedBody).toBeNull();
  });

  test.each(
    ["function", "custom"].flatMap((kind) =>
      ["calls", "results"].map((seam) => ({ kind, seam })),
    ),
  )(
    "preserves inline context between parallel $kind $seam through ingress",
    async ({ kind, seam }) => {
      harness = await createHarness({ fixtures: [] });
      let captured: Record<string, unknown> | undefined;
      setUpstreamInterceptor(async (body) => {
        captured = body as Record<string, unknown>;
        return new Response(
          stream(
            [
              {
                type: "message",
                id: "answer",
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: "Done" }],
              },
            ],
            "resp_parallel_context",
          ),
          { headers: { "content-type": "text/event-stream" } },
        );
      });
      const call = (id: string) => ({
        type: kind === "custom" ? "custom_tool_call" : "function_call",
        id: `call_${id}`,
        call_id: id,
        name: "exec",
        ...(kind === "custom" ? { input: `echo ${id}` } : { arguments: "{}" }),
        status: "completed",
      });
      const result = (id: string) => ({
        type:
          kind === "custom"
            ? "custom_tool_call_output"
            : "function_call_output",
        id: `output_${id}`,
        call_id: id,
        output: id,
      });
      const inline = {
        type: "message",
        id: "inline",
        role: "developer",
        content: "Updated rule",
      };
      const input = [
        {
          type: "additional_tools",
          id: "tools",
          role: "developer",
          tools: [
            {
              type: kind,
              name: "exec",
              ...(kind === "custom"
                ? { format: { type: "text" } }
                : { parameters: { type: "object", properties: {} } }),
            },
          ],
        },
        { type: "message", id: "u", role: "user", content: "Run commands" },
        call("a"),
        ...(seam === "calls" ? [inline] : []),
        call("b"),
        result("a"),
        ...(seam === "results" ? [inline] : []),
        result("b"),
        { type: "message", id: "latest", role: "user", content: "Continue" },
      ];
      const response = await harness.request("/v1/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer synthetic-token",
          "chatgpt-account-id": "synthetic-account",
          "x-lore-agent": "coder",
        },
        body: JSON.stringify({
          model: "gpt-6-sol",
          stream: true,
          parallel_tool_calls: true,
          input,
        }),
      });
      const body = await response.text();
      expect(response.status, body).toBe(200);
      const forwarded = captured!.input as Array<Record<string, unknown>>;
      expect(
        forwarded.filter((item) =>
          input.some((original) => original.id === item.id),
        ),
      ).toEqual(input);
    },
  );

  test("routes ChatGPT, preserves native tool loops and inline context across restart", async () => {
    mock = new MockAgent();
    mock.disableNetConnect();
    setUpstreamDispatcherForTest(mock);
    harness = await createHarness({
      fixtures: [],
      configOverrides: { upstreamOpenAI: "https://api.openai.com" },
    });
    setUpstreamInterceptor((_body, _model, _stream, makeReal) => makeReal());
    const captured: Array<Record<string, unknown>> = [];
    const call = {
      type: "custom_tool_call",
      id: "ct_ingress",
      call_id: "call_ingress",
      name: "exec",
      input: "echo hello",
      status: "completed",
    };
    const answer = {
      type: "message",
      id: "msg_ingress",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Done" }],
    };
    for (const [index, output] of [[call], [answer]].entries())
      mock
        .get("https://chatgpt.com")
        .intercept({ path: "/backend-api/codex/responses", method: "POST" })
        .reply((opts) => {
          captured.push(
            JSON.parse(
              typeof opts.body === "string"
                ? opts.body
                : JSON.stringify(opts.body),
            ),
          );
          return {
            statusCode: 200,
            data: stream(output, `resp_ingress_${index}`),
            responseOptions: {
              headers: { "content-type": "text/event-stream" },
            },
          };
        });
    const meta = { native_private_sentinel: "never-store" };
    const input = [
      {
        type: "additional_tools",
        id: "tools",
        role: "developer",
        tools: [
          {
            type: "namespace",
            name: "functions",
            tools: [{ type: "custom", name: "exec", format: { type: "text" } }],
          },
        ],
      },
      {
        type: "message",
        id: "dev",
        role: "developer",
        content: [{ type: "input_text", text: "Be precise" }],
        internal_chat_message_metadata_passthrough: meta,
      },
      {
        type: "message",
        id: "u",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "Please run the command and report its output",
          },
        ],
        internal_chat_message_metadata_passthrough: meta,
      },
    ];
    const send = (items: unknown[]) =>
      harness!.request("/v1/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer synthetic-token",
          "chatgpt-account-id": "synthetic-account",
          "x-lore-session-id": "native-ingress-loop",
          "x-lore-agent": "coder",
        },
        body: JSON.stringify({
          model: "gpt-6-sol",
          stream: true,
          input: items,
          store: false,
          include: ["reasoning.encrypted_content"],
          prompt_cache_key: "native-loop",
        }),
      });
    const first = await send(input);
    const firstText = await first.text();
    expect(first.status, firstText).toBe(200);
    expect(firstText).toContain("custom_tool_call");
    await harness.restartPipeline();
    expect(
      harness.queryDB(
        "SELECT payload FROM source_windows WHERE payload IS NOT NULL",
      ),
    ).toHaveLength(0);
    setUpstreamInterceptor((_body, _model, _stream, makeReal) => makeReal());
    const inline = {
      type: "message",
      id: "dev2",
      role: "developer",
      content: [{ type: "input_text", text: "Explain briefly" }],
      internal_chat_message_metadata_passthrough: meta,
    };
    const result = {
      type: "custom_tool_call_output",
      id: "out",
      call_id: call.call_id,
      output: "hello",
      internal_chat_message_metadata_passthrough: meta,
    };
    const secondInput = [
      ...input,
      call,
      result,
      inline,
      {
        type: "message",
        id: "u2",
        role: "user",
        content: [{ type: "input_text", text: "Continue" }],
        internal_chat_message_metadata_passthrough: meta,
      },
    ];
    const second = await send(secondInput);
    const text = await second.text();
    expect(second.status, text).toBe(200);
    expect(text).toContain("Done");
    expect(mock.pendingInterceptors()).toEqual([]);
    for (const request of captured) {
      expect(request.store).toBe(false);
      expect(request.max_output_tokens).toBeUndefined();
      expect(request.include).toEqual(["reasoning.encrypted_content"]);
      expect(request.prompt_cache_key).toBe("native-loop");
    }
    const forwarded = captured[1].input as Array<Record<string, unknown>>;
    expect(
      forwarded.filter((item) =>
        secondInput.some((original) => original.id === item.id),
      ),
    ).toEqual(secondInput);
    expect(
      JSON.stringify(harness.queryDB("SELECT content FROM temporal_messages")),
    ).not.toContain("native_private_sentinel");
  });

  test("rejects native-only tools before foreign upstream dispatch", async () => {
    mock = new MockAgent();
    mock.disableNetConnect();
    setUpstreamDispatcherForTest(mock);
    harness = await createHarness({ fixtures: [] });
    const response = await harness.request("/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
        "x-lore-provider": "anthropic",
      },
      body: JSON.stringify({
        model: "claude-test",
        input: [{ role: "user", content: "Hello" }],
        tools: [{ type: "custom", name: "exec", format: { type: "text" } }],
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { message: "Unsupported cross-provider request" },
    });
  });
  test("does not intercept a namespaced client recall tool", async () => {
    mock = new MockAgent();
    mock.disableNetConnect();
    setUpstreamDispatcherForTest(mock);
    harness = await createHarness({ fixtures: [] });
    let injected = false;
    setUpstreamInterceptor((body, _model, _stream, makeReal) => {
      injected =
        (body as { tools?: Array<{ name?: string }> }).tools?.some(
          (tool) => tool.name === RECALL_TOOL_NAME,
        ) === true;
      return makeReal();
    });
    const call = {
      type: "function_call",
      id: "fc_client",
      call_id: "call_client",
      namespace: "functions",
      name: "recall",
      arguments: '{"query":"client memory"}',
      status: "completed",
    };
    mock
      .get("https://chatgpt.com")
      .intercept({ path: "/backend-api/codex/responses", method: "POST" })
      .reply(200, stream([call], "resp_client"), {
        headers: { "content-type": "text/event-stream" },
      });
    const response = await harness.request("/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer synthetic-token",
        "chatgpt-account-id": "synthetic-account",
        "x-lore-agent": "coder",
      },
      body: JSON.stringify({
        model: "gpt-6-sol",
        stream: true,
        input: [
          {
            type: "additional_tools",
            id: "tools",
            role: "developer",
            tools: [
              {
                type: "namespace",
                name: "functions",
                tools: [
                  {
                    type: "function",
                    name: "recall",
                    parameters: {
                      type: "object",
                      properties: { query: { type: "string" } },
                    },
                  },
                ],
              },
            ],
          },
          {
            type: "message",
            id: "u",
            role: "user",
            content: [{ type: "input_text", text: "Use my recall tool" }],
          },
        ],
      }),
    });
    const text = await response.text();
    expect(injected).toBe(true);
    expect(response.status, text).toBe(200);
    expect(text).toContain('"namespace":"functions"');
    expect(text).toContain('"call_id":"call_client"');
    expect(text).toContain("response.completed");
    expect(mock.pendingInterceptors()).toEqual([]);
  });
  test("returns a custom client call alongside Lore recall without issuing a continuation", async () => {
    mock = new MockAgent();
    mock.disableNetConnect();
    setUpstreamDispatcherForTest(mock);
    harness = await createHarness({ fixtures: [] });
    setUpstreamInterceptor((_body, _model, _stream, makeReal) => makeReal());
    const recall = {
      type: "function_call",
      id: "fc_lore",
      call_id: "call_lore",
      name: RECALL_TOOL_NAME,
      arguments:
        '{"query":"alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron"}',
      status: "completed",
    };
    const custom = {
      type: "custom_tool_call",
      id: "ct_mixed",
      call_id: "call_mixed",
      name: "exec",
      input: "echo hello",
      status: "completed",
    };
    let injected = false;
    mock
      .get("https://chatgpt.com")
      .intercept({ path: "/backend-api/codex/responses", method: "POST" })
      .reply((opts) => {
        const request = JSON.parse(
          typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body),
        ) as { tools?: Array<{ name?: string }> };
        injected =
          request.tools?.some((tool) => tool.name === RECALL_TOOL_NAME) ===
          true;
        return {
          statusCode: 200,
          data: stream([recall, custom], "resp_mixed"),
          responseOptions: { headers: { "content-type": "text/event-stream" } },
        };
      });
    const response = await harness.request("/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer synthetic-token",
        "chatgpt-account-id": "synthetic-account",
        "x-lore-agent": "coder",
      },
      body: JSON.stringify({
        model: "gpt-6-sol",
        stream: true,
        input: [
          {
            type: "additional_tools",
            id: "tools",
            role: "developer",
            tools: [{ type: "custom", name: "exec", format: { type: "text" } }],
          },
          {
            type: "message",
            id: "u",
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Recall the decision and run the command",
              },
            ],
          },
        ],
      }),
    });
    const text = await response.text();
    expect(injected).toBe(true);
    expect(text).toContain('"call_id":"call_mixed"');
    expect(text).toContain("response.completed");
    expect(text).not.toContain("response.failed");
    expect(mock.pendingInterceptors()).toEqual([]);
  });
});
