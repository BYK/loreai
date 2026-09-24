import { afterEach, describe, expect, test, vi } from "vitest";
import { db, ltm, loadSessionTracking } from "@loreai/core";
import { getSessionCosts } from "../src/cost-tracker";
import {
  accumulateNonStreamResponse,
  handleRequest,
  setRecallPersistenceCommitObserverForTest,
  setUpstreamInterceptor,
} from "../src/pipeline";
import { parseAnthropicResponseJSON } from "../src/translate/anthropic";
import {
  _setNowForTest as setWorkerHealthTime,
  getDegradationWarning,
  recordWorkerFailure,
} from "../src/worker-health";
import {
  buildRecallAnchor,
  recallAnchorContext,
  MAX_RECALL_STORE_ENTRIES,
} from "../src/recall";
import type * as coreConfig from "../../core/src/config";
import {
  prepareProductiveRecallSources,
  TEST_RECALL_EXECUTION_CAP,
  FINAL_RECALL_CALL,
  providerResponse,
  request,
  config,
  knowledge,
  stateFor,
  settled,
  resetRecallBufferedForTest,
} from "./helpers/recall-buffered";

// These tests assert on recall/buffered-transaction behaviour, never on
// vectors; skip the ONNX embedding provider so stored messages bypass the
// embedding worker (cuts ~40% of the file's wall time).
vi.mock("../../core/src/config", async (importOriginal) => {
  const mod = await importOriginal<typeof coreConfig>();
  return {
    ...mod,
    config: () => {
      const c = mod.config();
      c.search.embeddings.enabled = false;
      return c;
    },
  };
});

afterEach(resetRecallBufferedForTest);

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
      prepareProductiveRecallSources();
      let calls = 0;
      setUpstreamInterceptor(async () => {
        calls++;
        if (calls < FINAL_RECALL_CALL)
          return providerResponse(protocol, calls, "recall");
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
      expect(calls).toBe(FINAL_RECALL_CALL + 1);
      expect(state.recallStore.size).toBe(0);
      expect(getSessionCosts(state.sessionID)?.conversation).toMatchObject({
        inputTokens:
          TEST_RECALL_EXECUTION_CAP * 3 + (usageKind === "valid" ? 2000 : 0),
        outputTokens:
          TEST_RECALL_EXECUTION_CAP * 2 + (usageKind === "valid" ? 200 : 0),
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
    prepareProductiveRecallSources();
    const alias = crypto.randomUUID();
    const req = request("openai", alias);
    req.stream = true;
    req.rawHeaders["x-lore-provider"] = "openai";
    let calls = 0;
    setUpstreamInterceptor(async (body) =>
      providerResponse(
        "openai-responses",
        ++calls,
        calls === FINAL_RECALL_CALL ? outcome : "recall",
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
      outcome === "answer" ? TEST_RECALL_EXECUTION_CAP : 0,
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
