import { describe, test, expect, afterEach, vi } from "vitest";

// Mock the upstream fetch wrapper so the adapter's retry loop is driven by our
// stubbed responses regardless of whether a fetch interceptor is installed
// (stubbing globalThis.fetch alone would silently break if `getOriginalFetch`
// had captured the real fetch).
vi.mock("../src/fetch", () => ({ upstreamFetch: vi.fn() }));

import {
  backoffMs,
  createGatewayLLMClient,
  maxRetriesFor,
  normalizeOpenAIUsage,
  resolveWorkerProtocol,
  AUTH_ERROR_CODES,
} from "../src/llm-adapter";
import {
  getConsecutiveTrips,
  resetBackgroundLimiter,
} from "../src/background-limiter";
import { upstreamFetch } from "../src/fetch";
import { clearAllCosts, getSessionCosts } from "../src/cost-tracker";

// ---------------------------------------------------------------------------
// maxRetriesFor — unified policy (modeled on Claude Code's single budget)
// ---------------------------------------------------------------------------

describe("maxRetriesFor (unified policy)", () => {
  test("returns the default budget (8) regardless of status or urgency", () => {
    expect(maxRetriesFor()).toBe(8);
    expect(maxRetriesFor(429)).toBe(8);
    expect(maxRetriesFor(500)).toBe(8);
    expect(maxRetriesFor(502)).toBe(8);
    expect(maxRetriesFor(503)).toBe(8);
    expect(maxRetriesFor(529)).toBe(8);
    expect(maxRetriesFor(null)).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// backoffMs — Retry-After (honored exactly, capped at MAX_DELAY_MS = 32s)
// ---------------------------------------------------------------------------

describe("backoffMs — with Retry-After", () => {
  test("honors small Retry-After exactly (no jitter on the server-hint path)", () => {
    expect(backoffMs(0, 1000)).toBe(1000);
    expect(backoffMs(3, 5000)).toBe(5000);
    expect(backoffMs(0, 100)).toBe(100);
  });

  test("honors Retry-After right up to the 32s cap", () => {
    expect(backoffMs(0, 32_000)).toBe(32_000);
  });

  test("caps Retry-After at 32s regardless of attempt", () => {
    expect(backoffMs(0, 60_000)).toBe(32_000);
    expect(backoffMs(2, 300_000)).toBe(32_000);
  });
});

// ---------------------------------------------------------------------------
// backoffMs — exponential backoff with jitter (no Retry-After)
// ---------------------------------------------------------------------------

describe("backoffMs — exponential backoff without Retry-After", () => {
  test("ramps 0.5s → 32s (capped), each within [base, 1.25*base)", () => {
    const cases: Array<[number, number]> = [
      [0, 500],
      [1, 1000],
      [2, 2000],
      [3, 4000],
      [4, 8000],
      [5, 16_000],
      [6, 32_000],
      [10, 32_000], // capped
    ];
    for (const [attempt, base] of cases) {
      const delay = backoffMs(attempt, null);
      expect(delay).toBeGreaterThanOrEqual(base);
      expect(delay).toBeLessThan(base * 1.25);
    }
  });

  test("jitter makes repeated delays non-constant", () => {
    const samples = new Set(
      Array.from({ length: 25 }, () => backoffMs(3, null)),
    );
    expect(samples.size).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// Unified retry budget (regression guard for the OpenCode-hang report)
// ---------------------------------------------------------------------------

describe("unified retry budget", () => {
  test("first retry is sub-second — no 60s background first-wait (hang regression)", () => {
    // The old urgent/background split made urgent calls (compaction) inherit a
    // 60s background first-wait, which looked like a hang. The unified policy's
    // first retry without Retry-After is ~0.5s + jitter.
    const first = backoffMs(0, null);
    expect(first).toBeGreaterThanOrEqual(500);
    expect(first).toBeLessThan(700); // 500 + up to 25% jitter
  });

  test("429 with Retry-After: 60 — every wait capped at 32s", () => {
    // 8 retries × 32s cap = 256s ceiling. Server hint honored, no jitter.
    let total = 0;
    for (let attempt = 0; attempt < maxRetriesFor(429); attempt++) {
      total += backoffMs(attempt, 60_000);
    }
    expect(total).toBe(256_000);
  });

  test("429 without Retry-After: bounded exponential sum", () => {
    // 0.5 + 1 + 2 + 4 + 8 + 16 + 32 + 32 = 95.5s of base delay, + jitter.
    let total = 0;
    for (let attempt = 0; attempt < maxRetriesFor(429); attempt++) {
      total += backoffMs(attempt, null);
    }
    const base = 500 + 1000 + 2000 + 4000 + 8000 + 16_000 + 32_000 + 32_000;
    expect(total).toBeGreaterThanOrEqual(base);
    expect(total).toBeLessThan(base * 1.25);
  });
});

// ---------------------------------------------------------------------------
// normalizeOpenAIUsage — maps OpenAI usage to AnthropicUsage shape
// ---------------------------------------------------------------------------

describe("normalizeOpenAIUsage", () => {
  test("maps all OpenAI usage fields correctly", () => {
    const result = normalizeOpenAIUsage({
      prompt_tokens: 100,
      completion_tokens: 50,
      prompt_tokens_details: { cached_tokens: 30 },
    });

    expect(result).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 0,
    });
  });

  test("handles missing prompt_tokens_details", () => {
    const result = normalizeOpenAIUsage({
      prompt_tokens: 200,
      completion_tokens: 75,
    });

    expect(result).toEqual({
      input_tokens: 200,
      output_tokens: 75,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
  });

  test("handles undefined usage gracefully", () => {
    const result = normalizeOpenAIUsage(undefined);

    expect(result).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
  });

  test("handles empty usage object", () => {
    const result = normalizeOpenAIUsage({});

    expect(result).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
  });

  test("handles zero cached_tokens", () => {
    const result = normalizeOpenAIUsage({
      prompt_tokens: 500,
      completion_tokens: 200,
      prompt_tokens_details: { cached_tokens: 0 },
    });

    expect(result).toEqual({
      input_tokens: 500,
      output_tokens: 200,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// AUTH_ERROR_CODES — auth failure detection
// ---------------------------------------------------------------------------

describe("AUTH_ERROR_CODES", () => {
  test("includes 401 (Unauthorized)", () => {
    expect(AUTH_ERROR_CODES.has(401)).toBe(true);
  });

  test("includes 403 (Forbidden)", () => {
    expect(AUTH_ERROR_CODES.has(403)).toBe(true);
  });

  test("does not include transient error codes", () => {
    // These should be retried, not treated as auth errors
    expect(AUTH_ERROR_CODES.has(429)).toBe(false);
    expect(AUTH_ERROR_CODES.has(500)).toBe(false);
    expect(AUTH_ERROR_CODES.has(502)).toBe(false);
    expect(AUTH_ERROR_CODES.has(503)).toBe(false);
    expect(AUTH_ERROR_CODES.has(529)).toBe(false);
  });

  test("does not include success or other client errors", () => {
    expect(AUTH_ERROR_CODES.has(200)).toBe(false);
    expect(AUTH_ERROR_CODES.has(400)).toBe(false);
    expect(AUTH_ERROR_CODES.has(404)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveWorkerProtocol
// ---------------------------------------------------------------------------

describe("resolveWorkerProtocol", () => {
  // Priority 1: explicit protocol from UpstreamSnapshot wins
  test("explicit 'anthropic' wins over route table", () => {
    expect(resolveWorkerProtocol("openai", "anthropic")).toBe("anthropic");
  });

  test("explicit 'openai' wins over route table", () => {
    expect(resolveWorkerProtocol("anthropic", "openai")).toBe("openai");
  });

  test("explicit 'openai-responses' collapses to 'openai'", () => {
    expect(resolveWorkerProtocol("anthropic", "openai-responses")).toBe(
      "openai",
    );
  });

  // Priority 2: route table lookup
  test("anthropic provider resolves to 'anthropic' via route table", () => {
    expect(resolveWorkerProtocol("anthropic")).toBe("anthropic");
  });

  test("openai provider resolves to 'openai' via route table", () => {
    expect(resolveWorkerProtocol("openai")).toBe("openai");
  });

  test("deepseek provider resolves to 'openai' via route table", () => {
    expect(resolveWorkerProtocol("deepseek")).toBe("openai");
  });

  // Priority 3: default for aggregators/unknown providers
  test("opencode (protocol: null) defaults to 'anthropic'", () => {
    expect(resolveWorkerProtocol("opencode")).toBe("anthropic");
  });

  test("unknown provider defaults to 'anthropic'", () => {
    expect(resolveWorkerProtocol("some-unknown-provider")).toBe("anthropic");
  });
});

// ---------------------------------------------------------------------------
// resolveMaxRetries (via maxRetriesFor) — LORE_MAX_RETRIES parsing edge cases
// ---------------------------------------------------------------------------

describe("LORE_MAX_RETRIES env parsing", () => {
  const original = process.env.LORE_MAX_RETRIES;
  afterEach(() => {
    if (original === undefined) delete process.env.LORE_MAX_RETRIES;
    else process.env.LORE_MAX_RETRIES = original;
  });

  test("defaults to 8 when unset", () => {
    delete process.env.LORE_MAX_RETRIES;
    expect(maxRetriesFor()).toBe(8);
  });

  test("honors a valid positive integer", () => {
    process.env.LORE_MAX_RETRIES = "3";
    expect(maxRetriesFor()).toBe(3);
  });

  test("truncates a float via parseInt", () => {
    process.env.LORE_MAX_RETRIES = "5.9";
    expect(maxRetriesFor()).toBe(5);
  });

  test("falls back to default for 0, negative, empty, and non-numeric (never disables retries)", () => {
    for (const bad of ["0", "-1", "", "abc", "Infinity"]) {
      process.env.LORE_MAX_RETRIES = bad;
      expect(maxRetriesFor()).toBe(8);
    }
  });
});

// ---------------------------------------------------------------------------
// Circuit breaker: a 429 trips the breaker once per call, even when urgent
// ---------------------------------------------------------------------------

describe("worker 429 trips the circuit breaker (urgent included)", () => {
  const mockFetch = vi.mocked(upstreamFetch);
  const realMaxRetries = process.env.LORE_MAX_RETRIES;

  afterEach(() => {
    mockFetch.mockReset();
    if (realMaxRetries === undefined) delete process.env.LORE_MAX_RETRIES;
    else process.env.LORE_MAX_RETRIES = realMaxRetries;
  });

  test("urgent 429 storm trips the breaker exactly once across the retry loop", async () => {
    // Small budget + Retry-After: 0 → retries are instant, so the loop runs
    // to exhaustion without real waits.
    process.env.LORE_MAX_RETRIES = "3";
    resetBackgroundLimiter();

    mockFetch.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            type: "error",
            error: { type: "rate_limit_error", message: "Error" },
          }),
          { status: 429, headers: { "retry-after": "0" } },
        ),
    );

    const client = createGatewayLLMClient(
      {
        anthropic: "https://api.anthropic.com",
        openai: "https://api.openai.com",
      },
      () => ({ scheme: "api-key", value: "sk-ant-test" }),
      { providerID: "anthropic", modelID: "claude-test" },
    );

    const result = await client.prompt("system", "user", {
      urgent: true,
      workerID: "lore-compact",
    });

    // Exhausted → null (caller falls back), all attempts made, breaker tripped once.
    expect(result).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(4); // maxRetries(3) + 1
    expect(getConsecutiveTrips()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// createGatewayLLMClient.prompt() — request building, success, and guards
// ---------------------------------------------------------------------------

describe("createGatewayLLMClient.prompt", () => {
  const mockFetch = vi.mocked(upstreamFetch);

  const UPSTREAMS = {
    anthropic: "https://api.anthropic.com",
    openai: "https://api.openai.com",
  };

  afterEach(() => {
    mockFetch.mockReset();
    clearAllCosts();
    resetBackgroundLimiter();
  });

  function anthropicResponse() {
    return new Response(
      JSON.stringify({
        content: [{ type: "text", text: "hello from worker" }],
        model: "claude-test",
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  test("Anthropic success returns text and records worker cost", async () => {
    mockFetch.mockResolvedValue(anthropicResponse());
    const client = createGatewayLLMClient(
      UPSTREAMS,
      () => ({ scheme: "api-key", value: "sk-ant-test" }),
      { providerID: "anthropic", modelID: "claude-test" },
    );

    const text = await client.prompt("system", "user", {
      sessionID: "sess-1",
      workerID: "lore-distill",
    });

    expect(text).toBe("hello from worker");
    expect(mockFetch).toHaveBeenCalledTimes(1);
    // Anthropic Messages endpoint + usage recorded into the distillation bucket.
    expect(mockFetch.mock.calls[0][0]).toContain("/v1/messages");
    expect(getSessionCosts("sess-1")?.workers.distillation.calls).toBe(1);
  });

  test("OpenAI success returns text via the chat-completions endpoint", async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "hi from openai" } }],
          model: "gpt-test",
          usage: { prompt_tokens: 8, completion_tokens: 4 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = createGatewayLLMClient(
      UPSTREAMS,
      () => ({ scheme: "api-key", value: "sk-openai-test" }),
      { providerID: "openai", modelID: "gpt-test" },
    );

    const text = await client.prompt("system", "user", {
      workerID: "lore-curator",
    });

    expect(text).toBe("hi from openai");
    expect(mockFetch.mock.calls[0][0]).toContain("/chat/completions");
  });

  test("returns null without calling upstream when no auth is available", async () => {
    const client = createGatewayLLMClient(UPSTREAMS, () => null, {
      providerID: "anthropic",
      modelID: "claude-test",
    });

    const text = await client.prompt("system", "user", {
      workerID: "lore-distill",
    });

    expect(text).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("skips the request on a provider/key protocol mismatch", async () => {
    // Anthropic target but an OpenAI-style key → mismatch guard returns null
    // before any upstream call.
    const client = createGatewayLLMClient(
      UPSTREAMS,
      () => ({ scheme: "api-key", value: "sk-openai-not-anthropic" }),
      { providerID: "anthropic", modelID: "claude-test" },
    );

    const text = await client.prompt("system", "user", {
      workerID: "lore-distill",
    });

    expect(text).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("returns null on a 401 auth error (no credential change)", async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "unauthorized" } }), {
        status: 401,
      }),
    );
    const client = createGatewayLLMClient(
      UPSTREAMS,
      () => ({ scheme: "api-key", value: "sk-ant-test" }),
      { providerID: "anthropic", modelID: "claude-test" },
    );

    // No sessionID → markAuthStale is skipped; static cred → no retry.
    const text = await client.prompt("system", "user", {
      workerID: "lore-distill",
    });

    expect(text).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
