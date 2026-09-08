import { afterEach, describe, expect, test, vi } from "vitest";
import { db, ltm, loadSessionTracking, temporal } from "@loreai/core";
import * as core from "@loreai/core";
import { loadConfig } from "../src/config";
import { clearAllCosts, getSessionCosts } from "../src/cost-tracker";
import {
  accumulateNonStreamResponse,
  buildStreamingResponse,
  getActiveSessions,
  handleRequest,
  resetPipelineState,
  setRecallPersistenceCommitObserverForTest,
  setUpstreamInterceptor,
  streamingPostResponsePendingForTest,
} from "../src/pipeline";
import type { GatewayRequest } from "../src/translate/types";
import { parseAnthropicResponseJSON } from "../src/translate/anthropic";
import {
  _resetForTest as resetWorkerHealth,
  _setNowForTest as setWorkerHealthTime,
  getDegradationWarning,
  recordWorkerFailure,
} from "../src/worker-health";
import {
  buildRecallAnchor,
  recallAnchorContext,
  MAX_RECALL_STORE_ENTRIES,
} from "../src/recall";

afterEach(async () => {
  setUpstreamInterceptor(undefined);
  setRecallPersistenceCommitObserverForTest(undefined);
  await resetPipelineState();
  clearAllCosts();
  for (const id of createdKnowledge) ltm.remove(id);
  createdKnowledge.clear();
  vi.restoreAllMocks();
  resetWorkerHealth();
});

test.each(["absent", "different-bucket"] as const)(
  "buffered Codex recall retains prior quota when continuation metadata is %s",
  async (continuationQuota) => {
    knowledge();
    const alias = crypto.randomUUID();
    const req = request("openai-responses", alias, true);
    setUpstreamInterceptor(async () =>
      providerResponse("openai-responses", 1, "answer"),
    );
    await (await handleRequest(req, config())).text();
    await settled();
    const state = stateFor(alias);

    // A real sustained worker failure causes response warning injection,
    // selecting the buffered Codex path instead of live recall streaming.
    let now = 1000000;
    setWorkerHealthTime(() => now);
    recordWorkerFailure(state.sessionID, "lore-distill", "rate-limit");
    now += 31 * 60 * 1000;
    recordWorkerFailure(state.sessionID, "lore-distill", "rate-limit");
    expect(getDegradationWarning(state.sessionID)).not.toBeNull();

    const firstQuota = {
      type: "codex.rate_limits",
      rate_limits: {
        primary: {
          used_percent: 25,
          window_minutes: 300,
          reset_at: 2000000000,
        },
      },
    };
    const nextQuota = { ...firstQuota, metered_limit_name: "codex_spark" };
    let calls = 0;
    setUpstreamInterceptor(async () => {
      calls++;
      const response = providerResponse(
        "openai-responses",
        calls,
        calls === 1 ? "recall" : "answer",
        true,
      );
      const quota =
        calls === 1
          ? firstQuota
          : continuationQuota === "different-bucket"
            ? nextQuota
            : undefined;
      return new Response(
        (quota
          ? `event: codex.rate_limits\ndata: ${JSON.stringify(quota)}\n\n`
          : "") + (await response.text()),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    req.stream = true;
    const response = await handleRequest(req, config());
    const body = await response.text();
    await settled();
    expect(response.status, body).toBe(200);
    expect(calls).toBe(2);
    expect(body).toContain("Unrecovered background-worker failures");
    expect(body).toContain("Completed answer");
    const events = body
      .split("\n\n")
      .filter((frame) => frame.startsWith("event: codex.rate_limits\n"))
      .map((frame) => JSON.parse(frame.split("\ndata: ")[1]));
    expect(events).toEqual(
      continuationQuota === "absent" ? [firstQuota] : [firstQuota, nextQuota],
    );
  },
);

describe.each(["anthropic", "openai", "openai-responses"] as const)(
  "malformed buffered %s content",
  (protocol) => {
    test.each([
      "valid",
      "negative",
      "overflow",
      "cache",
      "missing",
      "json",
    ] as const)("retains only validated usage: %s", async (usageKind) => {
      const alias = crypto.randomUUID();
      let calls = 0;
      setUpstreamInterceptor(async () => {
        calls++;
        if (calls < 11) return providerResponse(protocol, calls, "recall");
        if (usageKind === "json")
          return new Response('{"usage":', {
            headers: { "content-type": "application/json" },
          });
        const json = await providerResponse(protocol, calls, "invalid").json();
        // Duplicate identities force the content parser to reject before it
        // reaches usage validation, even with a claimed successful terminal.
        if (protocol === "anthropic") {
          const call = {
            type: "tool_use",
            id: "duplicate",
            name: "Read",
            input: {},
          };
          json.content = [call, call];
          json.stop_reason = "tool_use";
        } else if (protocol === "openai") {
          json.choices[0].finish_reason = "stop";
          json.choices.push(json.choices[0]);
        } else {
          json.status = "completed";
          json.output.push(json.output[0]);
        }
        const inputKey =
          protocol === "openai" ? "prompt_tokens" : "input_tokens";
        const outputKey =
          protocol === "openai" ? "completion_tokens" : "output_tokens";
        if (usageKind === "negative") json.usage[inputKey] = -1;
        if (usageKind === "overflow")
          json.usage[outputKey] = Number.MAX_SAFE_INTEGER;
        if (usageKind === "cache") {
          if (protocol === "anthropic") json.usage.cache_read_input_tokens = -1;
          else
            json.usage[
              protocol === "openai"
                ? "prompt_tokens_details"
                : "input_tokens_details"
            ] = { cached_tokens: 1001 };
        }
        if (usageKind === "missing") delete json.usage;
        return Response.json(json);
      });
      const response = await handleRequest(request(protocol, alias), config());
      expect(response.status).toBe(502);
      await response.text();
      await settled();
      const state = stateFor(alias);
      expect(calls).toBe(11);
      expect(state.recallStore.size).toBe(0);
      expect(getSessionCosts(state.sessionID)?.conversation).toMatchObject({
        inputTokens: usageKind === "valid" ? 1030 : 30,
        outputTokens: usageKind === "valid" ? 120 : 20,
        turns: 1,
      });
    });
  },
);

test.each(["valid", "negative", "overflow"] as const)(
  "malformed Gemini content carries only validated %s usage",
  async (usageKind) => {
    const call = { functionCall: { id: "duplicate", name: "Read", args: {} } };
    const json = {
      candidates: [{ content: { parts: [call, call] }, finishReason: "STOP" }],
      usageMetadata: {
        promptTokenCount: usageKind === "negative" ? -1 : 1000,
        candidatesTokenCount:
          usageKind === "overflow" ? Number.MAX_SAFE_INTEGER : 100,
        thoughtsTokenCount: 20,
        cachedContentTokenCount: 50,
      },
    };
    const error = await accumulateNonStreamResponse(
      Response.json(json),
      "gemini",
      false,
      undefined,
      true,
    ).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    if (usageKind === "valid") {
      expect(error).toMatchObject({
        response: {
          content: [],
          usage: {
            inputTokens: 950,
            outputTokens: 120,
            cacheReadInputTokens: 50,
          },
        },
      });
    } else expect(error).not.toHaveProperty("response");
  },
);

test("a cancelled in-flight continuation discards staged recall effects", async () => {
  const id = knowledge();
  const alias = crypto.randomUUID();
  const caller = new AbortController();
  const req = request("anthropic", alias);
  req.signal = caller.signal;
  let calls = 0;
  setUpstreamInterceptor(async () => {
    calls++;
    if (calls === 2)
      caller.abort(new DOMException("client cancelled", "AbortError"));
    return providerResponse(
      "anthropic",
      calls,
      calls === 1 ? "recall" : "answer",
    );
  });
  const response = await handleRequest(req, config());
  expect(response.status).toBe(502);
  await response.text();
  await settled();
  const state = stateFor(alias);
  expect(state.recallStore.size).toBe(0);
  expect(loadSessionTracking(state.sessionID)?.recallStore ?? null).toBeNull();
  expect(ltm.transferCount(id)).toBe(0);
});

test.each(
  (["failure", "commit", "capacity", "late-capacity"] as const).flatMap(
    (mode) => [false, true].map((stream) => ({ mode, stream })),
  ),
)(
  "preserves existing replay anchors after $mode (stream=$stream)",
  async ({ mode, stream }) => {
    knowledge();
    const alias = crypto.randomUUID();
    const req = request("anthropic", alias);
    setUpstreamInterceptor(async () =>
      providerResponse("anthropic", 1, "mixed"),
    );
    const first = await handleRequest(req, config());
    const firstContent = parseAnthropicResponseJSON(await first.json()).content;
    await settled();
    const state = stateFor(alias);
    expect(state.recallStore.size).toBe(1);
    const existing = new Map(state.recallStore);
    const existingTracking = loadSessionTracking(state.sessionID)?.recallStore;
    req.stream = stream;
    let transfersBefore: unknown;
    req.messages.push(
      { role: "assistant", content: firstContent },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "read",
            content: [{ type: "text", text: "file contents" }],
          },
        ],
      },
    );
    const fillCapacity = () => {
      const [key, value] = [...existing][0];
      // Existing valid state was produced by a real mixed handoff. Fill the
      // bounded map before the next request to exercise admission at capacity.
      for (let i = 1; i < MAX_RECALL_STORE_ENTRIES; i++) {
        const anchorId = crypto.randomUUID();
        state.recallStore.set(`anchor:${anchorId}`, {
          ...value,
          anchorId,
          anchorContextId: recallAnchorContext(
            req.messages,
            1,
            req.messages[1].content,
          ),
        });
        req.messages[1].content.push({
          type: "text",
          text: buildRecallAnchor(anchorId),
        });
      }
      expect(state.recallStore.has(key)).toBe(true);
    };
    if (mode === "capacity") fillCapacity();
    let mapBefore = new Map(state.recallStore);
    if (mode === "commit")
      setRecallPersistenceCommitObserverForTest(() => {
        throw new Error("commit failed");
      });
    let calls = 0;
    setUpstreamInterceptor(async () => {
      // Preparation may legitimately record LTM transfers. Snapshot after it,
      // before this request executes any recall.
      if (calls === 0)
        transfersBefore = db()
          .query("SELECT SUM(hit_count) AS count FROM knowledge_transfers")
          .get();
      if (mode === "late-capacity" && calls === 1) {
        fillCapacity();
        mapBefore = new Map(state.recallStore);
      }
      return providerResponse(
        "anthropic",
        100 + ++calls,
        mode === "failure" || calls === 1 ? "recall" : "answer",
        stream,
      );
    });
    if (stream) {
      const response = await handleRequest(req, config());
      expect(response.status).toBe(200);
      if (mode === "commit" || mode === "late-capacity") await response.text();
      else await expect(response.text()).rejects.toBeInstanceOf(Error);
    } else if (mode === "capacity") {
      const response = await handleRequest(req, config());
      expect(response.status).toBe(502);
      await response.text();
    } else {
      const response = await handleRequest(req, config());
      expect(response.status).toBe(mode === "failure" ? 502 : 200);
      await response.text();
    }
    await settled();
    expect(state.recallStore).toEqual(mapBefore);
    expect(loadSessionTracking(state.sessionID)?.recallStore).toBe(
      existingTracking,
    );
    expect(
      db()
        .query("SELECT SUM(hit_count) AS count FROM knowledge_transfers")
        .get(),
    ).toEqual(transfersBefore);
  },
);

test.each(["answer", "invalid"] as const)(
  "buffers Responses upstream for a streaming Chat client: %s",
  async (outcome) => {
    const id = knowledge();
    const alias = crypto.randomUUID();
    const req = request("openai", alias);
    req.stream = true;
    req.rawHeaders["x-lore-provider"] = "openai";
    let calls = 0;
    setUpstreamInterceptor(async (body) =>
      providerResponse(
        "openai-responses",
        ++calls,
        calls === 11 ? outcome : "recall",
        (body as Record<string, unknown>).stream === true,
      ),
    );
    const response = await handleRequest(req, config());
    expect(response.status).toBe(outcome === "answer" ? 200 : 502);
    expect(stateFor(alias).recallStore.size).toBe(0);
    expect(ltm.transferCount(id)).toBe(0);
    await response.text();
    await settled();
    expect(stateFor(alias).recallStore.size).toBe(
      outcome === "answer" ? 10 : 0,
    );
    expect(ltm.transferCount(id)).toBe(outcome === "answer" ? 1 : 0);
  },
);

test("live Responses no-store recall does not record transfers", async () => {
  const id = knowledge();
  const alias = crypto.randomUUID();
  const req = request("openai-responses", alias);
  req.stream = true;
  req.rawHeaders["x-lore-no-store"] = "true";
  let calls = 0;
  setUpstreamInterceptor(async (body) =>
    providerResponse(
      "openai-responses",
      ++calls,
      calls === 2 ? "answer" : "recall",
      (body as Record<string, unknown>).stream === true,
    ),
  );
  const response = await handleRequest(req, config());
  expect(await response.text()).toContain("Completed answer");
  await settled();
  expect(stateFor(alias).recallStore.size).toBe(0);
  expect(ltm.transferCount(id)).toBe(0);
});

const query =
  "transactional glacier orchard telescope cobalt lantern mercury compass velvet island";
type Protocol = "anthropic" | "openai" | "openai-responses";
type Outcome = "recall" | "answer" | "mixed" | "invalid" | "bad-usage";

function providerResponse(
  protocol: Protocol,
  round: number,
  outcome: Outcome,
  stream = false,
): Response {
  const recalling = outcome === "recall" || outcome === "mixed";
  const invalid = outcome === "invalid" || outcome === "bad-usage";
  const input = outcome === "bad-usage" ? -1000 : invalid ? 1000 : 3;
  const output = invalid ? 100 : 2;
  const tool = {
    type: "tool_use",
    id: `call_${round}`,
    name: "recall",
    input: { query },
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
                      arguments: JSON.stringify({ query }),
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
        arguments: JSON.stringify({ query }),
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

function responsesStream(response: Record<string, unknown>): Response {
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

function anthropicStream(json: Record<string, unknown>): Response {
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

describe.each(["anthropic", "openai", "openai-responses", "gemini"] as const)(
  "Anthropic streaming transfer retention for %s client",
  (client) => {
    test.each([true, false])("no-store=%s", async (noStore) => {
      const id = knowledge();
      const alias = crypto.randomUUID();
      const req = request(client, alias);
      req.stream = true;
      req.rawHeaders["x-lore-provider"] = "anthropic";
      req.rawHeaders["x-lore-upstream-url"] = "https://api.anthropic.com";
      req.rawHeaders["x-api-key"] = "test-key";
      delete req.rawHeaders.authorization;
      if (noStore) req.rawHeaders["x-lore-no-store"] = "true";
      let calls = 0;
      setUpstreamInterceptor(async () =>
        providerResponse(
          "anthropic",
          ++calls,
          calls === 1 ? "recall" : "answer",
          true,
        ),
      );
      const response = await handleRequest(req, config());
      expect(await response.text()).toContain("Completed answer");
      await settled();
      expect(calls).toBe(2);
      expect(ltm.transferCount(id)).toBe(noStore ? 0 : 1);
      expect(stateFor(alias).recallStore.size).toBe(noStore ? 0 : 1);
    });
  },
);

describe.each([
  ["anthropic", false, "anthropic"],
  ["openai", false, "openai"],
  ["openai-responses", false, "openai-responses"],
  ["anthropic", true, "anthropic"],
  ["openai", true, "anthropic"],
  ["openai-responses", true, "anthropic"],
  ["gemini", true, "anthropic"],
  ["openai-responses", true, "openai-responses"],
] as const)(
  "blank final tool name: %s stream=%s upstream=%s",
  (client, stream, upstreamProtocol) => {
    test.each(["", " \t\n"])(
      "rejects name %j alone or with valid text",
      async (name) => {
        for (const withText of [false, true]) {
          const alias = crypto.randomUUID();
          const req = request(client, alias);
          req.stream = stream;
          if (upstreamProtocol === "anthropic") {
            req.rawHeaders["x-lore-provider"] = "anthropic";
            req.rawHeaders["x-lore-upstream-url"] = "https://api.anthropic.com";
            req.rawHeaders["x-api-key"] = "test-key";
            delete req.rawHeaders.authorization;
          }
          let calls = 0;
          setUpstreamInterceptor(async (body) => {
            calls++;
            const upstreamStream =
              (body as Record<string, unknown>).stream === true;
            if (calls < 11)
              return providerResponse(
                upstreamProtocol,
                calls,
                "recall",
                upstreamStream,
              );
            const json = await providerResponse(
              upstreamProtocol,
              calls,
              "mixed",
            ).json();
            if (upstreamProtocol === "anthropic") {
              json.content = [
                { ...json.content[0], name },
                ...(withText
                  ? [{ type: "text", text: "Completed answer" }]
                  : []),
              ];
            } else if (upstreamProtocol === "openai") {
              const message = json.choices[0].message;
              message.tool_calls = [
                {
                  ...message.tool_calls[0],
                  function: { ...message.tool_calls[0].function, name },
                },
              ];
              message.content = withText ? "Completed answer" : null;
            } else {
              json.output = [
                { ...json.output[0], name },
                ...(withText
                  ? [
                      {
                        type: "message",
                        id: "msg_final_text",
                        role: "assistant",
                        status: "completed",
                        content: [
                          { type: "output_text", text: "Completed answer" },
                        ],
                      },
                    ]
                  : []),
              ];
            }
            return upstreamStream
              ? upstreamProtocol === "anthropic"
                ? anthropicStream(json)
                : responsesStream(json)
              : Response.json(json);
          });
          const response = await handleRequest(req, config());
          if (stream) {
            const reader = response.body!.getReader();
            let received = "";
            let failure: unknown;
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                received += new TextDecoder().decode(value);
              }
            } catch (error) {
              failure = error;
            } finally {
              reader.releaseLock();
            }
            // Responses may represent failure on the wire; neither failure
            // form may deliver a successful terminal to an incremental reader.
            if (
              client === "openai-responses" &&
              received.includes("event: response.failed")
            ) {
              expect(received.match(/^event: response.failed$/gm)).toHaveLength(
                1,
              );
            } else expect(failure).toBeInstanceOf(Error);
            if (client === "anthropic") {
              expect(received.match(/^event: message_stop$/gm)).toHaveLength(
                20,
              );
            } else {
              expect(received).not.toContain("data: [DONE]");
              expect(received).not.toContain("event: response.completed");
              expect(received).not.toMatch(/"finish_reason":"|"finishReason":/);
            }
          } else {
            expect(response.status).toBe(502);
            await response.text();
          }
          await settled();
          expect(calls).toBe(11);
          expect(
            db()
              .query(
                "SELECT COUNT(*) AS count FROM temporal_messages WHERE session_id = ? AND role = 'assistant'",
              )
              .get(stateFor(alias).sessionID),
          ).toEqual({ count: 0 });
        }
      },
    );
  },
);

function request(
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

describe.each(["anthropic", "openai", "openai-responses", "gemini"] as const)(
  "native Anthropic recall transaction for %s client",
  (client) => {
    test.each([false, true])(
      "mixed handoff waits for EOF (cancel=%s)",
      async (cancel) => {
        const id = knowledge();
        const alias = crypto.randomUUID();
        const req = request(client, alias);
        req.stream = true;
        req.rawHeaders["x-lore-provider"] = "anthropic";
        req.rawHeaders["x-lore-upstream-url"] = "https://api.anthropic.com";
        req.rawHeaders["x-api-key"] = "test-key";
        delete req.rawHeaders.authorization;
        setUpstreamInterceptor(async () =>
          providerResponse("anthropic", 1, "mixed", true),
        );
        const response = await handleRequest(req, config());
        const reader = response.body!.getReader();
        let wire = "";
        for (;;) {
          const { done, value } = await reader.read();
          expect(done).toBe(false);
          wire += new TextDecoder().decode(value);
          if (
            client === "anthropic"
              ? (wire.match(/^event: message_stop$/gm)?.length ?? 0) === 2
              : client === "openai"
                ? wire.includes("data: [DONE]")
                : client === "openai-responses"
                  ? wire.includes("event: response.completed")
                  : wire.includes('"finishReason":')
          )
            break;
        }
        await vi.waitFor(() =>
          expect(streamingPostResponsePendingForTest()).toBe(1),
        );
        const state = stateFor(alias);
        expect.soft(state.recallStore.size).toBe(0);
        expect
          .soft(loadSessionTracking(state.sessionID)?.recallStore ?? null)
          .toBeNull();
        expect.soft(ltm.transferCount(id)).toBe(0);
        if (cancel) await reader.cancel();
        else expect((await reader.read()).done).toBe(true);
        reader.releaseLock();
        await settled();
        expect(state.recallStore.size).toBe(cancel ? 0 : 1);
        expect(ltm.transferCount(id)).toBe(cancel ? 0 : 1);
        expect(getSessionCosts(state.sessionID)?.conversation).toMatchObject({
          inputTokens: 3,
          outputTokens: 2,
          turns: 1,
        });
      },
    );
    test.each([
      "answer",
      "mixed",
      "fallback",
      "exhausted",
      "cancel",
      "abort",
      "storage",
      "commit",
    ] as const)("stages effects through %s", async (mode) => {
      const id = knowledge();
      const alias = crypto.randomUUID();
      const req = request(client, alias);
      req.stream = true;
      req.rawHeaders["x-lore-provider"] = "anthropic";
      req.rawHeaders["x-lore-upstream-url"] = "https://api.anthropic.com";
      req.rawHeaders["x-api-key"] = "test-key";
      delete req.rawHeaders.authorization;
      const caller = new AbortController();
      req.signal = caller.signal;
      const continuationStarted = Promise.withResolvers<void>();
      const releaseContinuation = Promise.withResolvers<void>();
      const snapshots: Array<{
        anchors: number;
        tracking: string | null;
        transfers: number;
      }> = [];
      let calls = 0;
      let commits = 0;
      if (mode === "storage")
        vi.spyOn(temporal, "store").mockImplementation(() => {
          throw new Error("injected storage failure");
        });
      setRecallPersistenceCommitObserverForTest(() => {
        commits++;
        if (mode === "commit") throw new Error("injected commit failure");
      });
      setUpstreamInterceptor(async () => {
        calls++;
        const state = stateFor(alias);
        snapshots.push({
          anchors: state.recallStore.size,
          tracking: loadSessionTracking(state.sessionID)?.recallStore ?? null,
          transfers: ltm.transferCount(id),
        });
        if (calls === 2 && (mode === "cancel" || mode === "abort")) {
          continuationStarted.resolve();
          await releaseContinuation.promise;
        }
        if (mode === "fallback" && calls === 2)
          return new Response("failure", { status: 503 });
        return providerResponse(
          "anthropic",
          calls,
          mode === "mixed"
            ? "mixed"
            : mode !== "exhausted" && calls === 3
              ? "answer"
              : "recall",
          true,
        );
      });
      const response = await handleRequest(req, config());
      const reader = response.body!.getReader();
      let wire = "";
      let failure: unknown;
      const read = (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            wire += new TextDecoder().decode(value);
          }
        } catch (error) {
          failure = error;
        }
      })();
      try {
        if (mode === "cancel" || mode === "abort") {
          await continuationStarted.promise;
          if (mode === "cancel") await reader.cancel();
          else caller.abort(new DOMException("client cancelled", "AbortError"));
        }
      } finally {
        releaseContinuation.resolve();
      }
      await read;
      reader.releaseLock();
      await settled();
      const state = stateFor(alias);
      const successful =
        mode === "answer" || mode === "mixed" || mode === "fallback";
      expect(calls).toBe(
        mode === "exhausted"
          ? 11
          : mode === "mixed"
            ? 1
            : ["cancel", "abort", "fallback"].includes(mode)
              ? 2
              : 3,
      );
      expect(snapshots).toEqual(
        snapshots.map(() => ({ anchors: 0, tracking: null, transfers: 0 })),
      );
      expect(state.recallStore.size).toBe(
        successful ? (mode === "answer" ? 2 : 1) : 0,
      );
      expect(ltm.transferCount(id)).toBe(successful ? 1 : 0);
      if (!successful)
        expect(
          loadSessionTracking(state.sessionID)?.recallStore ?? null,
        ).toBeNull();
      if (mode === "exhausted") {
        if (client === "openai-responses")
          expect(wire).toContain("event: response.failed");
        else expect(failure).toBeInstanceOf(Error);
      } else if (successful) {
        expect(failure).toBeUndefined();
        expect(wire).toContain(
          mode === "answer" ? "Completed answer" : "lore-recall:",
        );
        expect(
          JSON.parse(loadSessionTracking(state.sessionID)!.recallStore!).length,
        ).toBe(state.recallStore.size);
      }
      if (mode === "commit") expect(commits).toBe(1);
      if (mode === "storage") expect(commits).toBe(0);
      if (!successful)
        expect(
          db()
            .query(
              "SELECT COUNT(*) AS count FROM temporal_messages WHERE session_id = ? AND role = 'assistant'",
            )
            .get(state.sessionID),
        ).toEqual({ count: 0 });
    });
  },
);

test.each(["success", "cancel", "late-recall"] as const)(
  "standalone native recall delivery: %s",
  async (mode) => {
    const id = knowledge();
    const alias = crypto.randomUUID();
    const req = request("anthropic", alias);
    setUpstreamInterceptor(async () =>
      providerResponse("anthropic", 1, "answer"),
    );
    await (await handleRequest(req, config())).text();
    await settled();
    const state = stateFor(alias);
    const beforeTracking =
      loadSessionTracking(state.sessionID)?.recallStore ?? null;
    const recallStarted = Promise.withResolvers<void>();
    const releaseRecall = Promise.withResolvers<void>();
    const recallFinished = Promise.withResolvers<void>();
    if (mode === "late-recall") {
      const realRecall = core.runRecall;
      vi.spyOn(core, "runRecall").mockImplementationOnce(async (input) => {
        recallStarted.resolve();
        await releaseRecall.promise;
        try {
          // Model a non-cooperative in-flight search returning its real transfer
          // callback after cancellation; the gateway must discard it.
          return await realRecall({ ...input, signal: undefined });
        } finally {
          recallFinished.resolve();
        }
      });
    }
    setUpstreamInterceptor(async () =>
      providerResponse("anthropic", 2, "answer", true),
    );
    const completed = vi.fn();
    const response = buildStreamingResponse(
      providerResponse("anthropic", 1, "recall", true),
      completed,
      {
        clientMessages: req.messages,
        modifiedReq: req,
        config: config(),
        sessionState: state,
        cacheOptions: {},
        clientSpeaksAnthropic: true,
      },
    );
    const reader = response.body!.getReader();
    if (mode === "late-recall") {
      const drain = (async () => {
        while (!(await reader.read()).done) {
          /* drive source */
        }
      })();
      await recallStarted.promise;
      await reader.cancel();
      releaseRecall.resolve();
      await recallFinished.promise;
      await drain;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(completed).not.toHaveBeenCalled();
    } else {
      let wire = "";
      do {
        const { done, value } = await reader.read();
        expect(done).toBe(false);
        wire += new TextDecoder().decode(value);
      } while ((wire.match(/^event: message_stop$/gm)?.length ?? 0) < 3);
      await vi.waitFor(() => expect(completed).toHaveBeenCalledTimes(1));
      expect(state.recallStore.size).toBe(0);
      expect(ltm.transferCount(id)).toBe(0);
      if (mode === "cancel") await reader.cancel();
      else expect((await reader.read()).done).toBe(true);
    }
    reader.releaseLock();
    expect(state.recallStore.size).toBe(mode === "success" ? 1 : 0);
    expect(ltm.transferCount(id)).toBe(mode === "success" ? 1 : 0);
    if (mode !== "success")
      expect(loadSessionTracking(state.sessionID)?.recallStore ?? null).toBe(
        beforeTracking,
      );
  },
);

function config() {
  const cfg = loadConfig();
  cfg.remoteGateway = false;
  cfg.hostedMode = false;
  return cfg;
}

const createdKnowledge = new Set<string>();

function knowledge() {
  const id = ltm.create({
    projectPath: `/test/buffered-recall-origin/${crypto.randomUUID()}`,
    category: "gotcha",
    title: query,
    content: `${query}: preserve transaction boundaries.`,
    scope: "project",
    crossProject: true,
  });
  createdKnowledge.add(id);
  return id;
}

function stateFor(alias: string) {
  const state = [...getActiveSessions().values()].find(
    (s) => s.headerSessionId === alias,
  );
  expect(state).toBeDefined();
  return state!;
}

async function settled() {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await vi.waitFor(() => expect(streamingPostResponsePendingForTest()).toBe(0));
}

describe.each([
  ["anthropic", false],
  ["openai", false],
  ["openai-responses", false],
  ["openai-responses", true],
] as const)("buffered recall transaction: %s codex=%s", (protocol, codex) => {
  test.each(["answer", "mixed", "fallback"] as const)(
    "commits %s anchors and real transfers only after downstream EOF",
    async (outcome) => {
      const id = knowledge();
      const alias = crypto.randomUUID();
      let calls = 0;
      setUpstreamInterceptor(async (body) => {
        calls++;
        expect(stateFor(alias).recallStore.size).toBe(0);
        expect(ltm.transferCount(id)).toBe(0);
        if (outcome === "fallback" && calls === 2)
          return new Response("failure", { status: 503 });
        return providerResponse(
          protocol,
          calls,
          outcome === "mixed" ? "mixed" : calls === 11 ? "answer" : "recall",
          (body as Record<string, unknown>).stream === true,
        );
      });
      const response = await handleRequest(
        request(protocol, alias, codex),
        config(),
      );
      const state = stateFor(alias);
      expect(response.status).toBe(200);
      expect(state.recallStore.size).toBe(0);
      expect(ltm.transferCount(id)).toBe(0);
      const body = await response.text();
      await settled();
      expect(calls).toBe(
        outcome === "answer" ? 11 : outcome === "mixed" ? 1 : 2,
      );
      expect(body).toContain(
        outcome === "answer"
          ? "Completed answer"
          : outcome === "mixed"
            ? "Read"
            : "lore-recall:",
      );
      if (protocol === "openai-responses" && outcome !== "answer") {
        const envelope = JSON.parse(body);
        expect(body).toContain("lore-recall:");
        expect(
          envelope.output.some(
            (item: Record<string, unknown>) =>
              item.type === "function_call" && item.name === "recall",
          ),
        ).toBe(false);
      }
      expect(state.recallStore.size).toBe(outcome === "answer" ? 10 : 1);
      expect(
        JSON.parse(loadSessionTracking(state.sessionID)!.recallStore!).length,
      ).toBe(state.recallStore.size);
      expect(ltm.transferCount(id)).toBeGreaterThan(0);
      expect(getSessionCosts(state.sessionID)?.conversation.turns).toBe(1);
      ltm.remove(id);
    },
  );

  test.each(["cancel", "no-store"] as const)(
    "discards successful recall writes on %s",
    async (mode) => {
      const id = knowledge();
      const alias = crypto.randomUUID();
      let calls = 0;
      setUpstreamInterceptor(async (body) =>
        providerResponse(
          protocol,
          ++calls,
          calls === 2 ? "answer" : "recall",
          (body as Record<string, unknown>).stream === true,
        ),
      );
      const req = request(protocol, alias, codex);
      if (mode === "no-store") req.rawHeaders["x-lore-no-store"] = "true";
      const response = await handleRequest(req, config());
      expect(response.status).toBe(200);
      if (mode === "cancel") await response.body!.cancel();
      else await response.text();
      await settled();
      const state = stateFor(alias);
      expect(calls).toBe(2);
      expect(state.recallStore.size).toBe(0);
      expect(
        loadSessionTracking(state.sessionID)?.recallStore ?? null,
      ).toBeNull();
      expect(ltm.transferCount(id)).toBe(0);
      expect(
        db()
          .query(
            "SELECT COUNT(*) AS count FROM temporal_messages WHERE session_id = ? AND role = 'assistant'",
          )
          .get(state.sessionID),
      ).toEqual({ count: 0 });
      expect(getSessionCosts(state.sessionID)?.conversation).toMatchObject({
        inputTokens: 6,
        outputTokens: 4,
        turns: 1,
      });
      ltm.remove(id);
    },
  );

  test.each(["storage", "commit"] as const)(
    "rolls back partial writes after %s failure",
    async (mode) => {
      const id = knowledge();
      const alias = crypto.randomUUID();
      let calls = 0;
      let commits = 0;
      if (mode === "storage")
        vi.spyOn(temporal, "store").mockImplementation(() => {
          throw new Error("injected storage failure");
        });
      setRecallPersistenceCommitObserverForTest(() => {
        commits++;
        throw new Error("injected commit failure");
      });
      setUpstreamInterceptor(async (body) =>
        providerResponse(
          protocol,
          ++calls,
          calls === 3 ? "answer" : "recall",
          (body as Record<string, unknown>).stream === true,
        ),
      );
      const response = await handleRequest(
        request(protocol, alias, codex),
        config(),
      );
      expect(response.status).toBe(200);
      await response.text();
      await settled();
      const state = stateFor(alias);
      expect(commits).toBe(mode === "commit" ? 1 : 0);
      expect(state.recallStore.size).toBe(0);
      expect(
        loadSessionTracking(state.sessionID)?.recallStore ?? null,
      ).toBeNull();
      expect(ltm.transferCount(id)).toBe(0);
      expect(
        db()
          .query(
            "SELECT COUNT(*) AS count FROM temporal_messages WHERE session_id = ?",
          )
          .get(state.sessionID),
      ).toEqual({ count: 0 });
      ltm.remove(id);
    },
  );

  test.each(["recall", "invalid", "bad-usage", "http"] as const)(
    "discards anchors and real transfers after final %s failure",
    async (outcome) => {
      const id = knowledge();
      const alias = crypto.randomUUID();
      let calls = 0;
      setUpstreamInterceptor(async (body) => {
        calls++;
        if (calls === 11 && outcome === "http")
          return new Response("failure", { status: 503 });
        return providerResponse(
          protocol,
          calls,
          calls === 11 && outcome !== "http" ? outcome : "recall",
          (body as Record<string, unknown>).stream === true,
        );
      });
      const response = await handleRequest(
        request(protocol, alias, codex),
        config(),
      );
      expect(response.status).toBe(502);
      await response.text();
      await settled();
      const state = stateFor(alias);
      expect(calls).toBe(11);
      expect.soft(state.recallStore.size).toBe(0);
      expect
        .soft(
          (loadSessionTracking(state.sessionID)?.recallStore ?? null) === null,
        )
        .toBe(true);
      expect.soft(ltm.transferCount(id)).toBe(0);
      expect(
        db()
          .query(
            "SELECT COUNT(*) AS count FROM temporal_messages WHERE session_id = ? AND role = 'assistant'",
          )
          .get(state.sessionID),
      ).toEqual({ count: 0 });
      ltm.remove(id);
    },
  );

  test.each(["invalid", "bad-usage"] as const)(
    "accounts only validated final %s usage",
    async (outcome) => {
      const alias = crypto.randomUUID();
      let calls = 0;
      setUpstreamInterceptor(async (body) =>
        providerResponse(
          protocol,
          ++calls,
          calls === 11 ? outcome : "recall",
          (body as Record<string, unknown>).stream === true,
        ),
      );
      const response = await handleRequest(
        request(protocol, alias, codex),
        config(),
      );
      expect(response.status).toBe(502);
      await response.text();
      await settled();
      expect(
        getSessionCosts(stateFor(alias).sessionID)?.conversation,
      ).toMatchObject({
        inputTokens: outcome === "invalid" ? 1030 : 30,
        outputTokens: outcome === "invalid" ? 120 : 20,
        turns: 1,
      });
    },
  );
});
