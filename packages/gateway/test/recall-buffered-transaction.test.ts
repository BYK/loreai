import { afterEach, describe, expect, test, vi } from "vitest";
import { db, ltm, loadSessionTracking, temporal } from "@loreai/core";
import { loadConfig } from "../src/config";
import { clearAllCosts, getSessionCosts } from "../src/cost-tracker";
import {
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
});

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

test.each(["failure", "commit", "capacity"] as const)(
  "preserves existing replay anchors after %s",
  async (mode) => {
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
    if (mode === "capacity") {
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
    }
    const mapBefore = new Map(state.recallStore);
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
      return providerResponse(
        "anthropic",
        100 + ++calls,
        mode === "failure" || calls === 1 ? "recall" : "answer",
      );
    });
    if (mode === "capacity") {
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
    return Response.json({
      id: `msg_${round}`,
      model: "claude-test",
      type: "message",
      role: "assistant",
      content,
      stop_reason: invalid ? null : recalling ? "tool_use" : "end_turn",
      usage: { input_tokens: input, output_tokens: output },
    });
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
      event(invalid ? "response.failed" : "response.completed", { response }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function request(
  protocol: Protocol,
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
