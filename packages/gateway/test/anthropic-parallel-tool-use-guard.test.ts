/**
 * Anthropic parallel-tool-use guard.
 *
 * The recall loop aborts a turn as soon as a response carries more than one
 * `recall` tool_use block (RecallContinuationFailure category
 * `parallel_recall`). On the Anthropic wire that abort escapes to the relay's
 * catch and errors the client stream, so the turn is lost with zero content
 * instead of degrading — which Claude Code reports as
 * "Connection lost before a response was produced".
 *
 * The openai-responses path already guards the same hazard with
 * `parallel_tool_calls: false`. Anthropic's equivalent lives on `tool_choice`,
 * so the gateway asks for at most one tool use per turn while the recall tool
 * is in play. These tests pin the request body the gateway actually sends.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { DEFAULT_MODEL, DEFAULT_SYSTEM } from "./helpers/fixtures";
import type { Harness } from "./helpers/harness";
import { createHarness } from "./helpers/harness";
import { setUpstreamInterceptor } from "../src/pipeline";
import { withParallelToolUseDisabled } from "../src/recall";

const TOOL = {
  name: "bash",
  description: "run a command",
  input_schema: { type: "object", properties: {} },
};

function makeBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    model: DEFAULT_MODEL,
    max_tokens: 1024,
    stream: false,
    system: DEFAULT_SYSTEM,
    messages: [{ role: "user", content: "hello" }],
    tools: [TOOL],
    ...overrides,
  };
}

interface Sink {
  body?: Record<string, unknown>;
}

function captureInterceptor(sink: Sink) {
  return async (requestBody: unknown): Promise<Response> => {
    sink.body = requestBody as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        id: "msg_capture",
        type: "message",
        role: "assistant",
        model: DEFAULT_MODEL,
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 5, output_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
}

describe("withParallelToolUseDisabled", () => {
  it("defaults to an auto tool_choice when the client set none", () => {
    expect(withParallelToolUseDisabled(undefined)).toEqual({
      type: "auto",
      disable_parallel_tool_use: true,
    });
  });

  it("preserves a client-specified choice and overrides the parallel flag", () => {
    expect(
      withParallelToolUseDisabled({
        type: "auto",
        disable_parallel_tool_use: false,
      }),
    ).toEqual({ type: "auto", disable_parallel_tool_use: true });
  });

  it("leaves an explicit `none` choice alone", () => {
    // The flag is meaningless (and rejected by some proxies) under `none`.
    expect(withParallelToolUseDisabled({ type: "none" })).toBeUndefined();
  });

  it("repairs a non-object or type-less choice rather than forwarding it", () => {
    expect(withParallelToolUseDisabled("auto")).toEqual({
      type: "auto",
      disable_parallel_tool_use: true,
    });
    expect(withParallelToolUseDisabled({})).toEqual({
      type: "auto",
      disable_parallel_tool_use: true,
    });
  });
});

describe("Anthropic request carries the guard", () => {
  // One harness for the whole describe: repeated harness creation in a single
  // file leaves the later instances routing to the real upstream (401), so the
  // capture interceptor must be installed against a stable server.
  let harness: Harness;
  let sink: Sink;

  beforeAll(async () => {
    harness = await createHarness({
      fixtures: [],
      projectPath: mkdtempSync(join(tmpdir(), "lore-parguard-")),
    });
  });

  afterAll(async () => {
    await harness?.teardown();
    setUpstreamInterceptor(undefined);
  });

  beforeEach(() => {
    sink = {};
    setUpstreamInterceptor(captureInterceptor(sink));
  });

  afterEach(() => {
    setUpstreamInterceptor(undefined);
  });

  /** Each test gets its own project so sessions never leak across cases. */
  async function capture(body: Record<string, unknown>): Promise<Sink> {
    const resp = await harness.chat(body, "test-key", {
      "x-lore-project": mkdtempSync(join(tmpdir(), "lore-parguard-proj-")),
    });
    const text = await resp.text();
    expect(resp.status, text).toBe(200);
    return sink;
  }

  it("disables parallel tool use once the recall tool is injected", async () => {
    const sink = await capture(makeBody());
    // The recall tool rides along with the client's own tools.
    const tools = sink.body?.tools as Array<{ name: string }>;
    expect(tools.map((t) => t.name)).toContain("recall");
    expect(sink.body?.tool_choice).toEqual({
      type: "auto",
      disable_parallel_tool_use: true,
    });
  });

  it("does not inject the guard when there is no recall tool", async () => {
    // With no client tools the gateway injects no recall tool, so there is
    // nothing to guard and the request must stay untouched.
    const sink = await capture(makeBody({ tools: [] }));
    expect(sink.body?.tool_choice).toBeUndefined();
  });

  it("preserves a client tool_choice while adding the flag", async () => {
    const sink = await capture(
      makeBody({
        tool_choice: { type: "any", disable_parallel_tool_use: false },
      }),
    );
    expect(sink.body?.tool_choice).toEqual({
      type: "any",
      disable_parallel_tool_use: true,
    });
  });

  it("leaves a client `none` tool_choice untouched", async () => {
    const sink = await capture(makeBody({ tool_choice: { type: "none" } }));
    expect(sink.body?.tool_choice).toEqual({ type: "none" });
  });
});
