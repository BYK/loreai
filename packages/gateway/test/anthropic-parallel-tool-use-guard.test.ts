/**
 * Anthropic-compatible recall requests must not allow parallel tool calls.
 *
 * The recall loop rejects a response containing multiple recall tool calls.
 * Anthropic and Vertex expose the compatible wire as `tool_choice`, while
 * OpenAI Responses uses `parallel_tool_calls`. Bedrock Mantle is excluded until
 * its endpoint accepts Anthropic's `disable_parallel_tool_use` field.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function makeAnthropicResponse(): Response {
  return new Response(
    JSON.stringify({
      id: "msg_guard",
      type: "message",
      role: "assistant",
      model: DEFAULT_MODEL,
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 5, output_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("withParallelToolUseDisabled", () => {
  it("defaults to auto and enables the Anthropic guard", () => {
    expect(withParallelToolUseDisabled(undefined)).toEqual({
      type: "auto",
      disable_parallel_tool_use: true,
    });
  });

  it("preserves the client choice while forcing the guard", () => {
    expect(
      withParallelToolUseDisabled({
        type: "tool",
        name: "bash",
        disable_parallel_tool_use: false,
      }),
    ).toEqual({
      type: "tool",
      name: "bash",
      disable_parallel_tool_use: true,
    });
  });

  it("does not add the flag to an explicit none choice", () => {
    expect(withParallelToolUseDisabled({ type: "none" })).toBeUndefined();
  });

  it("normalizes malformed choices to auto", () => {
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

describe("Anthropic effective wire routing", () => {
  let harness: Harness;
  let captured: Record<string, unknown> | undefined;

  beforeAll(async () => {
    harness = await createHarness({
      fixtures: [],
      projectPath: mkdtempSync(join(tmpdir(), "lore-parguard-")),
    });
  });

  beforeEach(() => {
    captured = undefined;
    setUpstreamInterceptor(async (body) => {
      captured = body as Record<string, unknown>;
      return makeAnthropicResponse();
    });
  });

  afterEach(() => {
    setUpstreamInterceptor(undefined);
  });

  it("guards a native Anthropic request after recall injection", async () => {
    const response = await harness.chat(
      {
        model: DEFAULT_MODEL,
        max_tokens: 1024,
        stream: false,
        system: DEFAULT_SYSTEM,
        messages: [{ role: "user", content: "hello" }],
        tools: [TOOL],
      },
      "test-key",
      { "x-lore-project": mkdtempSync(join(tmpdir(), "lore-parguard-proj-")) },
    );

    expect(response.status, await response.text()).toBe(200);
    expect(captured?.tools).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "recall" })]),
    );
    expect(captured?.tool_choice).toEqual({
      type: "auto",
      disable_parallel_tool_use: true,
    });
  });
});
