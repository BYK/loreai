import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

// Mock the upstream fetch wrapper so the adapter's retry loop is driven by our
// stubbed responses regardless of whether a fetch interceptor is installed
// (stubbing globalThis.fetch alone would silently break if `getOriginalFetch`
// had captured the real fetch).
vi.mock("../src/fetch", () => ({ upstreamFetch: vi.fn() }));
vi.mock("../src/worker-health", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/worker-health")>();
  return {
    ...actual,
    recordWorkerFailure: vi.fn(actual.recordWorkerFailure),
    markWorkerPaused: vi.fn(actual.markWorkerPaused),
  };
});

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
import { recordWorkerFailure, markWorkerPaused } from "../src/worker-health";
import { captureSessionHeaders, captureBillingPrefix } from "../src/cch";

// Claude Code billing-header system prompt — marks a session as an OAuth
// billing session so worker calls replay its sniffed anthropic-beta header.
const BILLING_SYSTEM =
  "x-anthropic-billing-header: cc_version=2.1.177.00c; cc_entrypoint=cli; cch=a55d7;";

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

  // openai-codex must use the Responses API — never collapse to Chat Completions.
  test("openai-codex resolves to 'openai-codex-responses' regardless of hint", () => {
    expect(resolveWorkerProtocol("openai-codex", "openai-responses")).toBe(
      "openai-codex-responses",
    );
    expect(resolveWorkerProtocol("openai-codex", "openai")).toBe(
      "openai-codex-responses",
    );
    expect(resolveWorkerProtocol("openai-codex")).toBe(
      "openai-codex-responses",
    );
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

    // Exhausted → null (caller falls back), all attempts made, breaker tripped
    // once — scoped to the provider that 429'd (anthropic here).
    expect(result).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(4); // maxRetries(3) + 1
    expect(getConsecutiveTrips("anthropic")).toBe(1);
    // A different provider's breaker is unaffected by anthropic's 429.
    expect(getConsecutiveTrips("openrouter")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Provider error envelopes wrapped in HTTP 200 bodies (#899)
// ---------------------------------------------------------------------------

describe("worker handles provider error envelopes in HTTP 200 bodies (#899)", () => {
  const mockFetch = vi.mocked(upstreamFetch);
  const realMaxRetries = process.env.LORE_MAX_RETRIES;
  const UPSTREAMS = {
    anthropic: "https://api.anthropic.com",
    openai: "https://api.openai.com",
  };

  beforeEach(() => {
    process.env.LORE_MAX_RETRIES = "3";
    resetBackgroundLimiter();
    vi.mocked(recordWorkerFailure).mockClear();
  });
  afterEach(() => {
    mockFetch.mockReset();
    clearAllCosts();
    resetBackgroundLimiter();
    if (realMaxRetries === undefined) delete process.env.LORE_MAX_RETRIES;
    else process.env.LORE_MAX_RETRIES = realMaxRetries;
  });

  // HTTP 200 whose body is a provider error envelope. retry-after:0 keeps the
  // retries instant so the loop runs to exhaustion without real waits.
  function envelope200(code: number) {
    return new Response(
      JSON.stringify({ error: { message: "Provider returned error", code } }),
      {
        status: 200,
        headers: { "content-type": "application/json", "retry-after": "0" },
      },
    );
  }
  function anthropicSuccess() {
    return new Response(
      JSON.stringify({
        content: [{ type: "text", text: "recovered" }],
        model: "claude-test",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  function client() {
    return createGatewayLLMClient(
      UPSTREAMS,
      () => ({ scheme: "api-key", value: "sk-ant-test" }),
      { providerID: "anthropic", modelID: "claude-test" },
    );
  }

  test("retries a 200 + embedded 504 and recovers when the retry succeeds", async () => {
    mockFetch
      .mockResolvedValueOnce(envelope200(504))
      .mockResolvedValueOnce(anthropicSuccess());
    const text = await client().prompt("system", "user", {
      sessionID: "s-recover",
      workerID: "lore-distill",
    });
    expect(text).toBe("recovered");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test("retries to exhaustion on a persistent 200 + embedded 504 → null, records upstream-error (not incapable)", async () => {
    // mockImplementation (not mockResolvedValue): each retry needs a FRESH
    // Response — a body can only be read once.
    mockFetch.mockImplementation(async () => envelope200(504));
    const text = await client().prompt("system", "user", {
      sessionID: "s-exhaust",
      workerID: "lore-distill",
    });
    expect(text).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(4); // maxRetries(3) + 1
    // Mirrors the HTTP-level transient exhaustion reason (504 → upstream-error).
    expect(recordWorkerFailure).toHaveBeenCalledWith(
      "s-exhaust",
      "lore-distill",
      "upstream-error",
    );
    // A flaky upstream must never mark a capable model incapable.
    expect(recordWorkerFailure).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "worker-incapable",
    );
  });

  test("does NOT retry a 200 + embedded NON-transient (400) error", async () => {
    // Guards the TRANSIENT_CODES gate: a non-transient embedded code must fall
    // through to the normal empty-response path (single call, no retry), not be
    // treated as retryable. (A 400 envelope took the same null path pre-PR too,
    // so this asserts the gate condition, not the block's existence.)
    mockFetch.mockResolvedValue(envelope200(400));
    const text = await client().prompt("system", "user", {
      sessionID: "s-400",
      workerID: "lore-distill",
    });
    expect(text).toBeNull();
    // Falls through to the existing empty-response handling — no retry.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test("an embedded 429 trips the provider circuit breaker", async () => {
    mockFetch.mockImplementation(async () => envelope200(429));
    await client().prompt("system", "user", {
      sessionID: "s-429",
      workerID: "lore-distill",
    });
    expect(getConsecutiveTrips("anthropic")).toBe(1);
  });

  test("a real HTTP 504 is now transient and retried (was a hard fail)", async () => {
    mockFetch.mockImplementation(
      async () =>
        new Response("gateway timeout", {
          status: 504,
          headers: { "retry-after": "0" },
        }),
    );
    const text = await client().prompt("system", "user", {
      sessionID: "s-http504",
      workerID: "lore-distill",
    });
    expect(text).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(4); // maxRetries(3) + 1
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

  test("openai-codex worker calls the Responses endpoint with store:false + Codex headers", async () => {
    // Seed the per-session Codex fingerprint as a real conversation turn would.
    captureSessionHeaders("sess-codex", {
      "chatgpt-account-id": "acct-xyz",
      originator: "pi",
      "openai-beta": "responses=experimental",
    });

    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "codex worker reply" }],
            },
          ],
          model: "gpt-5.1-codex-mini",
          usage: { input_tokens: 12, output_tokens: 3 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const client = createGatewayLLMClient(
      UPSTREAMS,
      () => ({ scheme: "bearer", value: "jwt-token" }),
      { providerID: "openai-codex", modelID: "gpt-5.1-codex-mini" },
    );

    const text = await client.prompt("system", "user", {
      sessionID: "sess-codex",
      workerID: "lore-distill",
      // Session upstream override (chatgpt backend) + responses protocol hint.
      upstreamUrl: "https://chatgpt.com/backend-api",
      protocol: "openai-responses",
    });

    expect(text).toBe("codex worker reply");
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://chatgpt.com/backend-api/codex/responses");
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer jwt-token");
    expect(headers["chatgpt-account-id"]).toBe("acct-xyz");
    expect(headers.originator).toBe("pi");
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body.store).toBe(false);
    expect(body.model).toBe("gpt-5.1-codex-mini");
    expect(Array.isArray(body.input)).toBe(true);
    // ChatGPT Codex rejects max_output_tokens — worker calls must omit it.
    expect(body.max_output_tokens).toBeUndefined();
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

// ---------------------------------------------------------------------------
// HTTP 402: insufficient credit — no Sentry escalation, soft-pause
// ---------------------------------------------------------------------------

describe("worker 402 insufficient credit handling", () => {
  const mockFetch = vi.mocked(upstreamFetch);
  const mockRecordFailure = vi.mocked(recordWorkerFailure);
  const mockMarkPaused = vi.mocked(markWorkerPaused);

  beforeEach(() => {
    // Clear accumulated calls from prior describe blocks (429 tests etc.)
    mockRecordFailure.mockClear();
    mockMarkPaused.mockClear();
  });

  afterEach(() => {
    mockFetch.mockReset();
  });

  test("402 returns null, calls markWorkerPaused, and does NOT call recordWorkerFailure", async () => {
    mockFetch.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              message: "requires more credits",
              code: 402,
            },
          }),
          { status: 402, statusText: "Payment Required" },
        ),
    );

    const client = createGatewayLLMClient(
      {
        anthropic: "https://api.anthropic.com",
        openai: "https://api.openai.com",
      },
      () => ({ scheme: "api-key", value: "sk-ant-test" }),
      // Use "anthropic" provider to match the upstreams map and avoid
      // protocol-mismatch. The 402 behavior is provider-agnostic.
      { providerID: "anthropic", modelID: "claude-test" },
    );

    const result = await client.prompt("system", "user", {
      workerID: "lore-distill",
      sessionID: "sess-402-test",
    });

    // 402 is non-retried — only one fetch attempt.
    expect(result).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    // Soft-pause the session so we stop retrying every turn.
    expect(mockMarkPaused).toHaveBeenCalledWith("sess-402-test");
    // Critically: recordWorkerFailure must NOT be called — that's what
    // escalates to Sentry after 3 hits, and 402 is an expected account state.
    expect(mockRecordFailure).not.toHaveBeenCalled();
  });

  test("402 without sessionID logs but does not call markWorkerPaused", async () => {
    mockFetch.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            error: { message: "requires more credits", code: 402 },
          }),
          { status: 402, statusText: "Payment Required" },
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
      workerID: "lore-distill",
      // no sessionID — session-less worker
    });

    expect(result).toBeNull();
    expect(mockMarkPaused).not.toHaveBeenCalled();
    expect(mockRecordFailure).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Cross-provider collusion guard
//
// REGRESSION: production incident where a configured `workerModel:
// minimax/MiniMax-M2.7` was sent to https://api.anthropic.com with the
// session's Anthropic api-key, producing a 401 "invalid x-api-key" loop with
// no backoff (auth errors don't retry) — 175 of 200 worker errors, pinning a
// CPU core across multiple sessions.
//
// INVARIANT (must hold forever): a worker model's provider MUST match BOTH
//  (a) the upstream URL the request is sent to, AND
//  (b) the credential used.
// A worker call may NEVER send provider A's model to provider B's endpoint, and
// MUST fail closed (skip + record "cross-provider", no upstream request) when a
// matching route/credential is unavailable.
// ---------------------------------------------------------------------------

describe("cross-provider collusion guard", () => {
  const mockFetch = vi.mocked(upstreamFetch);
  const mockRecordFailure = vi.mocked(recordWorkerFailure);

  const UPSTREAMS = {
    anthropic: "https://api.anthropic.com",
    openai: "https://api.openai.com",
  };

  beforeEach(() => {
    mockRecordFailure.mockClear();
  });

  afterEach(() => {
    mockFetch.mockReset();
    clearAllCosts();
    resetBackgroundLimiter();
  });

  // The core regression: minimax model + Anthropic api-key (the exact prod
  // misconfig). It must NOT reach api.anthropic.com. Either it routes to
  // minimax's own endpoint (only if a minimax credential exists) or it fails
  // closed — but it must never collude provider A's model with provider B's
  // direct endpoint.
  test("NEVER sends a minimax model to api.anthropic.com with an Anthropic key", async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({ error: { message: "invalid x-api-key" } }),
        { status: 401 },
      ),
    );

    // getAuth simulates production: no minimax credential, only the Anthropic
    // key is known (returned for any provider via the global fallback today).
    const client = createGatewayLLMClient(
      UPSTREAMS,
      () => ({ scheme: "api-key", value: "sk-ant-anthropic-key" }),
      { providerID: "anthropic", modelID: "claude-haiku-4-5" },
    );

    const result = await client.prompt("system", "user", {
      sessionID: "sess-xprov",
      workerID: "lore-distill",
      model: { providerID: "minimax", modelID: "MiniMax-M2.7" },
    });

    expect(result).toBeNull();
    // The invariant: if any upstream call was made, it must NOT be to the
    // Anthropic direct endpoint with the minimax model.
    for (const call of mockFetch.mock.calls) {
      const url = String(call[0]);
      expect(url).not.toContain("api.anthropic.com");
    }
  });

  test("fails closed (skip + record cross-provider, no fetch) when no matching credential", async () => {
    // getAuth returns null for the minimax provider (no minimax credential) —
    // the post-fix resolveAuth behavior. The call must be skipped entirely.
    const client = createGatewayLLMClient(
      UPSTREAMS,
      (_sid, providerID) =>
        providerID === "minimax"
          ? null
          : { scheme: "api-key", value: "sk-ant-anthropic-key" },
      { providerID: "anthropic", modelID: "claude-haiku-4-5" },
    );

    const result = await client.prompt("system", "user", {
      sessionID: "sess-xprov-2",
      workerID: "lore-distill",
      model: { providerID: "minimax", modelID: "MiniMax-M2.7" },
    });

    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockRecordFailure).toHaveBeenCalledWith(
      "sess-xprov-2",
      "lore-distill",
      expect.stringMatching(/cross-provider|no-auth/),
    );
  });

  test("routes a minimax model to the minimax endpoint when a minimax credential exists", async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: "minimax reply" }],
          model: "MiniMax-M2.7",
          usage: { input_tokens: 5, output_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    // A real minimax credential is available for the minimax provider.
    const client = createGatewayLLMClient(
      UPSTREAMS,
      (_sid, providerID) =>
        providerID === "minimax"
          ? { scheme: "api-key", value: "minimax-secret-key" }
          : { scheme: "api-key", value: "sk-ant-anthropic-key" },
      { providerID: "anthropic", modelID: "claude-haiku-4-5" },
    );

    const result = await client.prompt("system", "user", {
      sessionID: "sess-xprov-3",
      workerID: "lore-distill",
      model: { providerID: "minimax", modelID: "MiniMax-M2.7" },
    });

    expect(result).toBe("minimax reply");
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const url = String(mockFetch.mock.calls[0][0]);
    // minimax PROVIDER_ROUTES url is https://api.minimax.io/anthropic
    expect(url).toContain("api.minimax.io");
    expect(url).not.toContain("api.anthropic.com");
  });

  test("soft-pauses on a non-transient 400 so it stops re-firing every turn", async () => {
    const mockMarkPaused = vi.mocked(markWorkerPaused);
    mockMarkPaused.mockClear();
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({ error: { message: "bad request, model not found" } }),
        { status: 400 },
      ),
    );
    const client = createGatewayLLMClient(
      UPSTREAMS,
      () => ({ scheme: "api-key", value: "sk-ant-test" }),
      { providerID: "anthropic", modelID: "claude-test" },
    );

    const result = await client.prompt("system", "user", {
      sessionID: "sess-400-pause",
      workerID: "lore-distill",
    });

    expect(result).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1); // no retry
    expect(mockMarkPaused).toHaveBeenCalledWith("sess-400-pause");
  });

  test("soft-pauses on a persistent 401 auth error (cross-provider key-valid-but-wrong loop)", async () => {
    const mockMarkPaused = vi.mocked(markWorkerPaused);
    mockMarkPaused.mockClear();
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({ error: { message: "invalid x-api-key" } }),
        { status: 401 },
      ),
    );
    const client = createGatewayLLMClient(
      UPSTREAMS,
      () => ({ scheme: "api-key", value: "sk-ant-test" }),
      { providerID: "anthropic", modelID: "claude-test" },
    );

    const result = await client.prompt("system", "user", {
      sessionID: "sess-401-pause",
      workerID: "lore-distill",
    });

    expect(result).toBeNull();
    expect(mockMarkPaused).toHaveBeenCalledWith("sess-401-pause");
  });

  test("does not let a session upstreamUrl override re-home a different provider's model", async () => {
    // Session is Anthropic (upstreamUrl=api.anthropic.com) but the worker model
    // is minimax. The session override must NOT be applied to the minimax model.
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: "ok" }],
          model: "MiniMax-M2.7",
          usage: { input_tokens: 5, output_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const client = createGatewayLLMClient(
      UPSTREAMS,
      (_sid, providerID) =>
        providerID === "minimax"
          ? { scheme: "api-key", value: "minimax-secret-key" }
          : { scheme: "api-key", value: "sk-ant-anthropic-key" },
      { providerID: "anthropic", modelID: "claude-haiku-4-5" },
    );

    await client.prompt("system", "user", {
      sessionID: "sess-xprov-4",
      workerID: "lore-distill",
      model: { providerID: "minimax", modelID: "MiniMax-M2.7" },
      // The session's Anthropic endpoint — must be IGNORED for a minimax model.
      upstreamUrl: "https://api.anthropic.com",
      protocol: "anthropic",
    });

    for (const call of mockFetch.mock.calls) {
      expect(String(call[0])).not.toContain("api.anthropic.com");
    }
  });
});

// ---------------------------------------------------------------------------
// Beta-vs-model capability validation + runtime 400-retry-without-beta
//
// The client's `anthropic-beta` (incl. a `context-1m` long-context beta) is
// replayed onto worker calls. A 1M beta is a logical error for a model whose
// context window is < 1M (e.g. claude-haiku-4-5, 200K) and Anthropic rejects it
// with a 400. We (1) validate betas against the selected model's capability
// matrix and drop incompatible ones up front, and (2) as a runtime safety net,
// retry once with all beta headers removed on a beta-related 400.
// ---------------------------------------------------------------------------

describe("worker beta capability validation", () => {
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

  function betaOf(callIndex: number): string | undefined {
    const init = mockFetch.mock.calls[callIndex]?.[1];
    const headers = init?.headers as Record<string, string> | undefined;
    if (!headers) return undefined;
    const key = Object.keys(headers).find(
      (k) => k.toLowerCase() === "anthropic-beta",
    );
    return key ? headers[key] : undefined;
  }

  test("drops the context-1m beta for a sub-1M model (haiku) but keeps other betas", async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: "ok" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    // Mark the session as a billing/OAuth session and seed a sniffed beta that
    // includes context-1m alongside legitimate betas.
    captureBillingPrefix("sess-haiku-beta", BILLING_SYSTEM);
    captureSessionHeaders("sess-haiku-beta", {
      "anthropic-beta":
        "oauth-2025-04-20,context-1m-2025-08-07,fine-grained-tool-streaming-2025-05-14",
    });

    const client = createGatewayLLMClient(
      UPSTREAMS,
      () => ({ scheme: "bearer", value: "oauth-token" }),
      { providerID: "anthropic", modelID: "claude-haiku-4-5" },
    );

    await client.prompt("system", "user", {
      sessionID: "sess-haiku-beta",
      workerID: "lore-distill",
      model: { providerID: "anthropic", modelID: "claude-haiku-4-5" },
    });

    const beta = betaOf(0);
    expect(beta).toBeDefined();
    expect(beta).not.toContain("context-1m");
    // Other betas preserved.
    expect(beta).toContain("oauth-2025-04-20");
    expect(beta).toContain("fine-grained-tool-streaming-2025-05-14");
  });

  test("keeps the context-1m beta for a 1M-capable model (opus)", async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: "ok" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    captureBillingPrefix("sess-opus-beta", BILLING_SYSTEM);
    captureSessionHeaders("sess-opus-beta", {
      "anthropic-beta": "oauth-2025-04-20,context-1m-2025-08-07",
    });

    const client = createGatewayLLMClient(
      UPSTREAMS,
      () => ({ scheme: "bearer", value: "oauth-token" }),
      { providerID: "anthropic", modelID: "claude-opus-4-8" },
    );

    await client.prompt("system", "user", {
      sessionID: "sess-opus-beta",
      workerID: "lore-distill",
      model: { providerID: "anthropic", modelID: "claude-opus-4-8" },
    });

    // opus-4 has a 1M context window in the fallback table → beta retained.
    expect(betaOf(0)).toContain("context-1m");
  });

  test("retries once without beta headers on a beta-related 400, then succeeds", async () => {
    let call = 0;
    mockFetch.mockImplementation(async () => {
      call++;
      if (call === 1) {
        return new Response(
          JSON.stringify({
            error: {
              type: "invalid_request_error",
              message:
                "The long context beta is not yet available for this subscription.",
            },
          }),
          { status: 400 },
        );
      }
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: "recovered" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    // Use a 1M-capable model (opus) so the capability filter KEEPS the beta —
    // then simulate the real scenario where the model supports 1M but the
    // SUBSCRIPTION isn't entitled, so Anthropic still 400s. The runtime
    // beta-stripped retry is what recovers. The sniffed beta also carries the
    // OAuth gate (oauth-2025-04-20) which MUST survive the retry — stripping it
    // would turn the recoverable 400 into a 401.
    captureBillingPrefix("sess-400-beta", BILLING_SYSTEM);
    captureSessionHeaders("sess-400-beta", {
      "anthropic-beta": "oauth-2025-04-20,context-1m-2025-08-07",
    });

    const client = createGatewayLLMClient(
      UPSTREAMS,
      () => ({ scheme: "bearer", value: "oauth-token" }),
      { providerID: "anthropic", modelID: "claude-opus-4-8" },
    );

    const result = await client.prompt("system", "user", {
      sessionID: "sess-400-beta",
      workerID: "lore-distill",
      model: { providerID: "anthropic", modelID: "claude-opus-4-8" },
    });

    expect(result).toBe("recovered");
    expect(mockFetch).toHaveBeenCalledTimes(2);
    // First attempt carried the long-context beta.
    expect(betaOf(0)).toContain("context-1m");
    expect(betaOf(0)).toContain("oauth-2025-04-20");
    // Retry dropped ONLY the long-context beta — the OAuth gate is preserved
    // (stripping it would 401 the retry).
    expect(betaOf(1)).toBeDefined();
    expect(betaOf(1)).not.toContain("context-1m");
    expect(betaOf(1)).toContain("oauth-2025-04-20");
  });
});
