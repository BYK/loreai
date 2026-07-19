/**
 * Reasoning-effort → worker request body mapping (invariant-check `--effort`).
 *
 * The effort dial is provider-specific:
 *   - OpenAI Chat Completions → `reasoning_effort` (xhigh clamps to high; off omits)
 *   - Anthropic Messages → extended-thinking `budget_tokens`, which also raises
 *     max_tokens above the budget and drops temperature (both Anthropic rules).
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/fetch", () => ({ upstreamFetch: vi.fn() }));

import { createGatewayLLMClient } from "../src/llm-adapter";
import { upstreamFetch } from "../src/fetch";
import { clearAllCosts } from "../src/cost-tracker";
import { resetBackgroundLimiter } from "../src/background-limiter";
import type { ReasoningEffort } from "@loreai/core";

const mockFetch = vi.mocked(upstreamFetch);

const UPSTREAMS = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
};

function okOpenAI() {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: "ok" } }],
      model: "gpt-5",
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function okAnthropic() {
  return new Response(
    JSON.stringify({
      content: [{ type: "text", text: "ok" }],
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function bodyOf(n: number): Record<string, unknown> {
  const raw = mockFetch.mock.calls[n][1]?.body;
  return JSON.parse(typeof raw === "string" ? raw : "{}") as Record<
    string,
    unknown
  >;
}

describe("reasoning-effort → OpenAI reasoning_effort", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(okOpenAI());
  });
  afterEach(() => {
    mockFetch.mockReset();
    clearAllCosts();
    resetBackgroundLimiter();
  });

  async function run(effort: ReasoningEffort | undefined) {
    const client = createGatewayLLMClient(
      UPSTREAMS,
      () => ({ scheme: "api-key", value: "sk-openai" }),
      { providerID: "openai", modelID: "gpt-5" },
    );
    await client.prompt("system", "user", {
      sessionID: "s",
      workerID: "lore-invariant-check",
      model: { providerID: "openai", modelID: "gpt-5" },
      reasoningEffort: effort,
    });
    return bodyOf(0);
  }

  test("high passes through", async () => {
    expect((await run("high")).reasoning_effort).toBe("high");
  });
  test("low passes through", async () => {
    expect((await run("low")).reasoning_effort).toBe("low");
  });
  test("xhigh clamps to high", async () => {
    expect((await run("xhigh")).reasoning_effort).toBe("high");
  });
  test("off omits the param", async () => {
    expect((await run("off")).reasoning_effort).toBeUndefined();
  });
  test("undefined omits the param", async () => {
    expect((await run(undefined)).reasoning_effort).toBeUndefined();
  });
});

describe("reasoning-effort → Anthropic thinking budget", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(okAnthropic());
  });
  afterEach(() => {
    mockFetch.mockReset();
    clearAllCosts();
    resetBackgroundLimiter();
  });

  async function run(effort: ReasoningEffort | undefined, maxTokens = 256) {
    const client = createGatewayLLMClient(
      UPSTREAMS,
      () => ({ scheme: "api-key", value: "sk-ant-key" }),
      { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
    );
    await client.prompt("system", "user", {
      sessionID: "s",
      workerID: "lore-invariant-check",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      reasoningEffort: effort,
      maxTokens,
      temperature: 0,
    });
    return bodyOf(0);
  }

  test("high enables thinking with a budget and raises max_tokens above it", async () => {
    const body = run;
    const b = await body("high", 256);
    const thinking = b.thinking as { type: string; budget_tokens: number };
    expect(thinking.type).toBe("enabled");
    expect(thinking.budget_tokens).toBeGreaterThanOrEqual(1024);
    // max_tokens must exceed the thinking budget (Anthropic rule); the tiny 256
    // judge cap is raised to budget + headroom.
    expect(b.max_tokens as number).toBeGreaterThan(thinking.budget_tokens);
  });

  test("temperature is dropped when thinking is enabled", async () => {
    const b = await run("medium", 256);
    expect(b.temperature).toBeUndefined();
    expect((b.thinking as { type: string }).type).toBe("enabled");
  });

  test("off keeps the disabled-thinking suppression and preserves temperature/max_tokens", async () => {
    const b = await run("off", 256);
    // effort off → no enabled-thinking block; worker disable path applies.
    const thinking = b.thinking as { type: string } | undefined;
    if (thinking) expect(thinking.type).toBe("disabled");
    expect(b.max_tokens).toBe(256);
  });
});
