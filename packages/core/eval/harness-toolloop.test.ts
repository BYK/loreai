import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { applyUpstreamOverride, askQuestionViaGateway } from "./harness";

describe("applyUpstreamOverride", () => {
  const saved = {
    upstream: process.env.EVAL_UPSTREAM_URL,
    project: process.env.EVAL_PROJECT,
  };
  beforeEach(() => {
    delete process.env.EVAL_UPSTREAM_URL;
    delete process.env.EVAL_PROJECT;
  });
  afterEach(() => {
    for (const [k, v] of [
      ["EVAL_UPSTREAM_URL", saved.upstream],
      ["EVAL_PROJECT", saved.project],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("no-op when neither env is set (default eval behavior unchanged)", () => {
    const body = { model: "orig", messages: [] };
    const r = applyUpstreamOverride(body, "M3");
    expect(r.body).toBe(body); // unchanged reference
    expect(r.headers).toEqual({});
  });

  test("EVAL_UPSTREAM_URL rewrites model and sets the upstream header", () => {
    process.env.EVAL_UPSTREAM_URL = "https://api.minimax.io/anthropic";
    const r = applyUpstreamOverride({ model: "claude-x", messages: [] }, "M3");
    expect(r.body.model).toBe("M3");
    expect(r.headers["x-lore-upstream-url"]).toBe(
      "https://api.minimax.io/anthropic",
    );
  });

  test("EVAL_PROJECT sets the project header without touching the model", () => {
    process.env.EVAL_PROJECT = "/eval/cm-1";
    const r = applyUpstreamOverride({ model: "claude-x", messages: [] }, "M3");
    expect(r.body.model).toBe("claude-x"); // no upstream → no model rewrite
    expect(r.headers["x-lore-project"]).toBe("/eval/cm-1");
    expect(r.headers["x-lore-upstream-url"]).toBeUndefined();
  });
});

type Resp = {
  content?: Array<Record<string, unknown>>;
  stop_reason?: string;
  usage?: Record<string, number>;
  error?: { message?: string };
  __recall?: boolean;
};

/** Fake GatewayHandle whose chat() is scripted per call index / request body. */
function fakeGateway(script: (call: number, body: any) => Resp) {
  const calls: any[] = [];
  const handle = {
    baseURL: "http://fake",
    async chat(requestBody: any) {
      const idx = calls.length;
      calls.push(requestBody);
      const data = script(idx, requestBody);
      return {
        headers: {
          get: (h: string) =>
            h === "x-lore-recall-invoked" && data.__recall ? "true" : null,
        },
        json: async () => data,
      } as unknown as Response;
    },
  };
  return { handle: handle as any, calls };
}

describe("askQuestionViaGateway tool loop", () => {
  test("Claude-like: returns text on the first turn (single call)", async () => {
    const { handle, calls } = fakeGateway(() => ({
      content: [{ type: "text", text: "direct answer" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 5, output_tokens: 3 },
    }));
    const r = await askQuestionViaGateway("q", handle, "M", "ctx");
    expect(r.hypothesis).toBe("direct answer");
    expect(calls.length).toBe(1);
    expect(calls[0].tools.length).toBeGreaterThan(0); // tools present for LTM injection
  });

  test("tool-happy: feeds a stub tool_result and re-asks, then returns text", async () => {
    const { handle, calls } = fakeGateway((i) =>
      i === 0
        ? {
            content: [{ type: "tool_use", id: "tu1", name: "read" }],
            stop_reason: "tool_use",
            usage: { input_tokens: 10, output_tokens: 5 },
          }
        : {
            content: [{ type: "text", text: "The answer is 42." }],
            stop_reason: "end_turn",
            usage: { input_tokens: 20, output_tokens: 8 },
          },
    );
    const r = await askQuestionViaGateway("q", handle, "M", "ctx");
    expect(r.hypothesis).toBe("The answer is 42.");
    expect(calls.length).toBe(2);
    // Second call carried a tool_result answering the first tool_use.
    const toolResults = (calls[1].messages as any[]).flatMap((m) =>
      Array.isArray(m.content) ? m.content : [],
    );
    expect(
      toolResults.some(
        (c: any) => c.type === "tool_result" && c.tool_use_id === "tu1",
      ),
    ).toBe(true);
    // Tokens accumulate across both calls.
    expect(r.tokens.input).toBe(30);
    expect(r.tokens.output).toBe(13);
  });

  test("persistently tool-happy: final round drops tools to force an answer", async () => {
    const { handle, calls } = fakeGateway((_i, body) =>
      body.tools && body.tools.length > 0
        ? {
            content: [{ type: "tool_use", id: `t${_i}`, name: "bash" }],
            stop_reason: "tool_use",
            usage: {},
          }
        : {
            content: [{ type: "text", text: "forced answer" }],
            stop_reason: "end_turn",
            usage: {},
          },
    );
    const r = await askQuestionViaGateway("q", handle, "M");
    expect(r.hypothesis).toBe("forced answer");
    // 4 tool rounds (with tools) + 1 forced tools-free round.
    expect(calls.length).toBe(5);
    expect(calls[4].tools).toEqual([]);
  });

  test("propagates recall-invoked and never returns empty on a tool-only reply", async () => {
    // Model only ever emits tool_use, even without tools (pathological): the
    // loop must still return the no-response marker, not hang or throw.
    const { handle, calls } = fakeGateway((i) => ({
      content: [{ type: "tool_use", id: `t${i}`, name: "read" }],
      stop_reason: "tool_use",
      usage: {},
      __recall: true,
    }));
    const r = await askQuestionViaGateway("q", handle, "M");
    expect(r.recallInvoked).toBe(true);
    expect(r.hypothesis).toBe("[No response from gateway]");
    expect(calls.length).toBe(5);
  });
});
