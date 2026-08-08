import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { fetchArgUrl } from "./helpers/fetch-url";

// Mock the upstream fetch wrapper so the adapter's retry loop is driven by our
// stubbed responses regardless of whether a fetch interceptor is installed on
// globalThis.fetch (upstreamFetch is the gateway's own upstream path and does
// not go through globalThis.fetch, so mocking it is the reliable seam).
vi.mock("../src/fetch", () => ({ upstreamFetch: vi.fn() }));
vi.mock("../src/worker-health", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/worker-health")>();
  return {
    ...actual,
    recordWorkerFailure: vi.fn(actual.recordWorkerFailure),
    markWorkerPaused: vi.fn(actual.markWorkerPaused),
    markWorkerIncapable: vi.fn(actual.markWorkerIncapable),
    recordEmptyWorkerResponse: vi.fn(actual.recordEmptyWorkerResponse),
    markFreeModelsDataBlocked: vi.fn(actual.markFreeModelsDataBlocked),
  };
});

import {
  backoffMs,
  abortableSleep,
  readWorkerResponseText,
  createGatewayLLMClient,
  getLastWorkerError,
  maxRetriesFor,
  normalizeOpenAIUsage,
  resolveWorkerProtocol,
  AUTH_ERROR_CODES,
  isTemperatureUnsupportedModel,
  isAnthropicClaudeModel,
  isDataPolicyBlocked404,
  isModelUnsupported400,
  isThinkingUnsupportedModel,
  markThinkingUnsupported,
  workerThinkingOnByDefault,
  workerModelReasons,
  modelRejectsTemperatureByData,
  _resetTemperatureUnsupportedModels,
  _resetThinkingUnsupportedModels,
} from "../src/llm-adapter";
import { _setModelDataForTest, clearModelDataCache } from "../src/worker-model";
import { workerModelCandidates } from "../src/worker-model";
import {
  getConsecutiveTrips,
  resetBackgroundLimiter,
} from "../src/background-limiter";
import { upstreamFetch } from "../src/fetch";
import { clearAllCosts, getSessionCosts } from "../src/cost-tracker";
import {
  recordWorkerFailure,
  markWorkerPaused,
  recordEmptyWorkerResponse,
} from "../src/worker-health";
import {
  markWorkerIncapable,
  markFreeModelsDataBlocked,
  _resetForTest as _resetWorkerHealthForTest,
} from "../src/worker-health";
import { captureSessionHeaders, captureBillingPrefix } from "../src/cch";
import { _setTestVertexTokenProvider } from "../src/vertex-auth";

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

describe("abortableSleep", () => {
  test("rejects immediately when retry backoff is aborted", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    try {
      const pending = abortableSleep(32_000, controller.signal);
      controller.abort(new DOMException("client disconnected", "AbortError"));
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("readWorkerResponseText", () => {
  test("cancels a stalled worker error body on abort", async () => {
    const controller = new AbortController();
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull() {
          return new Promise(() => {});
        },
        cancel() {
          cancelled = true;
        },
      }),
      { status: 500 },
    );
    const pending = readWorkerResponseText(response, controller.signal);
    await Promise.resolve();
    controller.abort(new DOMException("client disconnected", "AbortError"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled).toBe(true);
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
      // prompt_tokens (100) is inclusive of cached_tokens (30); the disjoint
      // convention subtracts it → input_tokens = 70.
      input_tokens: 70,
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

  test("explicit 'openai-responses' is preserved for providers that support it", () => {
    // Real api.openai.com natively speaks /v1/responses — its route table
    // declares `protocol: "openai-responses"` (config.ts:573-578). An
    // explicit hint on the openai provider is honored through.
    expect(resolveWorkerProtocol("openai", "openai-responses")).toBe(
      "openai-responses",
    );
    // openai-codex: its route table also declares `protocol: "openai-responses"`
    // (config.ts:581-586), and the early-return at the top of the function
    // unconditionally maps openai-codex → openai-codex-responses.
    // github-copilot supports /responses for the gpt-5.6-* family via the
    // per-model override (no `protocol: "openai-responses"` in its route
    // table entry, but `isResponsesOnlyModel(modelID)` gates it). The
    // production call site (llm-adapter.ts:2021) ALWAYS passes modelID;
    // the no-modelID branch is unreachable from the worker pipeline.
    expect(
      resolveWorkerProtocol(
        "github-copilot",
        "openai-responses",
        "gpt-5.6-luna",
      ),
    ).toBe("openai-responses");
    expect(
      resolveWorkerProtocol(
        "github-copilot",
        "openai-responses",
        "gpt-5.6-sol",
      ),
    ).toBe("openai-responses");
  });

  test("explicit 'openai-responses' collapses to 'openai' for providers that don't support it (defensive guard)", () => {
    // Seer inline review (PR #1582#discussion_r3725297559) flagged that
    // PR #1582's unconditional `if (explicit === "openai-responses") return
    // "openai-responses"` weakened the pre-existing defensive collapse.
    // A misconfigured snapshot where upstreamProviderID="anthropic" but
    // protocol="openai-responses" would silently route to /v1/responses on
    // api.anthropic.com (404). Restore the guard: only providers whose
    // route table declares `protocol: "openai-responses"` (or the per-model
    // override triggers) get the hint preserved.
    expect(resolveWorkerProtocol("anthropic", "openai-responses")).toBe(
      "openai",
    );
    expect(resolveWorkerProtocol("vertex", "openai-responses")).toBe("openai");
    expect(resolveWorkerProtocol("google", "openai-responses")).toBe("openai");
    expect(resolveWorkerProtocol("deepseek", "openai-responses")).toBe(
      "openai",
    );
    expect(resolveWorkerProtocol("minimax", "openai-responses")).toBe("openai");
    // github-copilot with a NON-gpt-5.6-* model (where the per-model
    // override doesn't trigger) also collapses — the route table says
    // `protocol: "openai"`, not "openai-responses".
    expect(
      resolveWorkerProtocol("github-copilot", "openai-responses", "gpt-5-mini"),
    ).toBe("openai");
    expect(
      resolveWorkerProtocol(
        "github-copilot",
        "openai-responses",
        "claude-sonnet-4.5",
      ),
    ).toBe("openai");
  });

  test("per-model override: github-copilot + gpt-5.6-* resolves to 'openai-responses'", () => {
    expect(
      resolveWorkerProtocol("github-copilot", undefined, "gpt-5.6-luna"),
    ).toBe("openai-responses");
    expect(
      resolveWorkerProtocol("github-copilot", undefined, "gpt-5.6-sol"),
    ).toBe("openai-responses");
    expect(
      resolveWorkerProtocol("github-copilot", undefined, "gpt-5.6-terra"),
    ).toBe("openai-responses");
    // Dashless branch — defensive coverage. models.dev currently only lists
    // the three-member `gpt-5.6-{sol,terra,luna}` family, but the resolver
    // also accepts the bare slug. If the family ever gets a name without
    // a hyphen (e.g. a renaming), this branch should keep working without
    // a code change.
    expect(resolveWorkerProtocol("github-copilot", undefined, "gpt-5.6")).toBe(
      "openai-responses",
    );
  });

  test("per-model override: github-copilot + non-gpt-5.6 stays 'openai' (chat-completions)", () => {
    // gpt-5-mini, claude-sonnet-4.5, etc. are reachable on /chat/completions;
    // the routing layer must not flip them to /responses speculatively.
    expect(
      resolveWorkerProtocol("github-copilot", undefined, "gpt-5-mini"),
    ).toBe("openai");
    expect(
      resolveWorkerProtocol("github-copilot", undefined, "claude-sonnet-4.5"),
    ).toBe("openai");
  });

  test("per-model override does NOT trigger for non-github-copilot providers", () => {
    // Real api.openai.com has no /responses-routes-only model; even if a
    // model id matches the prefix, the provider id is the authority and
    // wins.
    expect(resolveWorkerProtocol("openai", undefined, "gpt-5.6-luna")).toBe(
      "openai",
    );
  });

  test("explicit 'gemini' stays 'gemini' (does NOT collapse to openai)", () => {
    expect(resolveWorkerProtocol("google", "gemini")).toBe("gemini");
    // Even against an unrelated provider id, the explicit hint wins.
    expect(resolveWorkerProtocol("anthropic", "gemini")).toBe("gemini");
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
    vi.mocked(recordEmptyWorkerResponse).mockClear();
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

    const event = (type: string, data: Record<string, unknown>) =>
      `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    mockFetch.mockResolvedValue(
      new Response(
        event("response.created", {
          response: { id: "resp_worker", model: "gpt-5.1-codex-mini" },
        }) +
          event("response.output_item.added", {
            output_index: 0,
            item: { type: "message", id: "msg_worker", role: "assistant" },
          }) +
          event("response.output_text.delta", {
            output_index: 0,
            delta: "codex worker ",
          }) +
          event("response.output_text.delta", {
            output_index: 0,
            delta: "reply",
          }) +
          event("response.completed", {
            response: {
              id: "resp_worker",
              model: "gpt-5.1-codex-mini",
              status: "completed",
              usage: { input_tokens: 12, output_tokens: 3 },
            },
          }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
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
    expect(body.stream).toBe(true);
    expect(body.model).toBe("gpt-5.1-codex-mini");
    expect(Array.isArray(body.input)).toBe(true);
    // ChatGPT Codex rejects max_output_tokens — worker calls must omit it.
    expect(body.max_output_tokens).toBeUndefined();
    const distillationCost =
      getSessionCosts("sess-codex")?.workers.distillation;
    expect(distillationCost?.calls).toBe(1);
    expect(distillationCost?.cost).toBeGreaterThan(0);
  });

  test.each([
    [
      "failed terminal",
      `event: response.failed\ndata: ${JSON.stringify({
        response: { status: "failed", error: { message: "upstream failed" } },
      })}\n\n`,
      "response.failed terminal",
    ],
    [
      "malformed event",
      "event: response.output_text.delta\ndata: {not-json}\n\n",
      "malformed response.output_text.delta event",
    ],
    [
      "missing terminal",
      `event: response.output_text.delta\ndata: ${JSON.stringify({
        output_index: 0,
        delta: "partial",
      })}\n\n`,
      "missing terminal response status",
    ],
    [
      "failed status",
      `event: response.completed\ndata: ${JSON.stringify({
        response: { status: "failed" },
      })}\n\n`,
      "terminal response status=failed",
    ],
    [
      "cancelled status",
      `event: response.completed\ndata: ${JSON.stringify({
        response: { status: "cancelled" },
      })}\n\n`,
      "terminal response status=cancelled",
    ],
  ])(
    "openai-codex worker classifies %s SSE as upstream-error, never model incapability",
    async (_case, stream, diagnostic) => {
      mockFetch.mockResolvedValue(
        new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      );
      const client = createGatewayLLMClient(
        UPSTREAMS,
        () => ({ scheme: "bearer", value: "jwt-token" }),
        { providerID: "openai-codex", modelID: "gpt-5.1-codex-mini" },
      );

      const text = await client.prompt("system", "user", {
        sessionID: "sess-codex-failed-stream",
        workerID: "lore-distill",
        upstreamUrl: "https://chatgpt.com/backend-api",
        protocol: "openai-responses",
      });

      expect(text).toBeNull();
      expect(recordWorkerFailure).toHaveBeenCalledWith(
        "sess-codex-failed-stream",
        "lore-distill",
        "upstream-error",
      );
      expect(recordEmptyWorkerResponse).not.toHaveBeenCalled();
      expect(markWorkerIncapable).not.toHaveBeenCalled();
      expect(getLastWorkerError()).toContain(diagnostic);
    },
  );

  test.each(["response.done", "response.incomplete"])(
    "openai-codex worker accepts %s with CRLF framing",
    async (terminalEvent) => {
      const event = (type: string, data: Record<string, unknown>) =>
        `event: ${type}\r\ndata: ${JSON.stringify(data)}\r\n\r\n`;
      mockFetch.mockResolvedValue(
        new Response(
          event("response.output_item.added", {
            output_index: 0,
            item: { type: "message", id: "msg_worker", role: "assistant" },
          }) +
            event("response.output_text.delta", {
              output_index: 0,
              delta: "codex CRLF reply",
            }) +
            event(terminalEvent, {
              response: {
                status:
                  terminalEvent === "response.incomplete"
                    ? "incomplete"
                    : "completed",
              },
            }),
          { headers: { "content-type": "text/event-stream" } },
        ),
      );
      const client = createGatewayLLMClient(
        UPSTREAMS,
        () => ({ scheme: "bearer", value: "jwt-token" }),
        { providerID: "openai-codex", modelID: "gpt-5.1-codex-mini" },
      );

      const text = await client.prompt("system", "user", {
        sessionID: `sess-codex-${terminalEvent}`,
        workerID: "lore-distill",
        upstreamUrl: "https://chatgpt.com/backend-api",
        protocol: "openai-responses",
      });

      expect(text).toBe("codex CRLF reply");
      expect(recordEmptyWorkerResponse).not.toHaveBeenCalled();
    },
  );

  test("bedrock-mantle worker remaps body.model to the mantle catalog id", async () => {
    // A Bedrock session's worker (distillation/curation) routes to the session's
    // mantle upstream over the Anthropic path with the client's Bedrock API key.
    // The OUTGOING body model MUST be the mantle catalog id (`anthropic.<model>`),
    // or mantle rejects it as unknown — silently degrading all memory-building.
    mockFetch.mockResolvedValue(anthropicResponse());
    const client = createGatewayLLMClient(
      UPSTREAMS,
      () => ({ scheme: "api-key", value: "bedrock-api-key-test" }),
      { providerID: "bedrock", modelID: "claude-haiku-4-5" },
    );

    const text = await client.prompt("system", "user", {
      sessionID: "sess-bedrock",
      workerID: "lore-distill",
      // Session upstream override = the regional mantle base (from the snapshot).
      upstreamUrl: "https://bedrock-mantle.us-east-1.api.aws/anthropic",
      upstreamProviderID: "bedrock",
      protocol: "anthropic",
    });

    expect(text).toBe("hello from worker");
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(
      "https://bedrock-mantle.us-east-1.api.aws/anthropic/v1/messages",
    );
    const headers = init?.headers as Record<string, string>;
    // Client's Bedrock API key via x-api-key; mantle requires anthropic-version.
    expect(headers["x-api-key"]).toBe("bedrock-api-key-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    // No SigV4 / OAuth on the mantle worker path (api-key scheme).
    expect(headers.Authorization).toBeUndefined();
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body.model).toBe("anthropic.claude-haiku-4-5");
  });

  test("a non-mantle anthropic worker keeps the bare client model id", async () => {
    // Guards the remap from over-reaching: a normal Anthropic worker must NOT
    // get the `anthropic.` prefix.
    mockFetch.mockResolvedValue(anthropicResponse());
    const client = createGatewayLLMClient(
      UPSTREAMS,
      () => ({ scheme: "api-key", value: "sk-ant-test" }),
      { providerID: "anthropic", modelID: "claude-haiku-4-5" },
    );

    await client.prompt("system", "user", {
      sessionID: "sess-anthropic",
      workerID: "lore-distill",
    });

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain("api.anthropic.com");
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body.model).toBe("claude-haiku-4-5");
  });

  test("vertex worker posts to :rawPredict with a GCP bearer and strips the client key", async () => {
    // A Vertex session's worker (distillation/curation) must POST the Anthropic
    // body to the per-model :rawPredict URL authenticated with lore's GCP OAuth2
    // bearer — NEVER the client x-api-key / anthropic-version header. Guards the
    // credential swap (a regression that forwarded the client key would leak it
    // to GCP and 401 every background call).
    _setTestVertexTokenProvider(() => Promise.resolve("test-vertex-token"));
    try {
      mockFetch.mockResolvedValue(anthropicResponse());
      const client = createGatewayLLMClient(
        UPSTREAMS,
        () => ({ scheme: "api-key", value: "client-key-ignored-for-vertex" }),
        { providerID: "vertex", modelID: "claude-opus-4-8" },
        { vertexProject: "test-vertex-project" },
      );

      const text = await client.prompt("system", "user", {
        sessionID: "sess-vertex",
        workerID: "lore-distill",
        // Legacy global-aiplatform base — the worker must self-heal it to the
        // bare aiplatform host when it rebuilds the rawPredict URL.
        upstreamUrl: "https://global-aiplatform.googleapis.com",
        upstreamProviderID: "vertex",
        protocol: "vertex",
      });

      expect(text).toBe("hello from worker");
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe(
        "https://aiplatform.googleapis.com/v1/projects/test-vertex-project/locations/global/publishers/anthropic/models/claude-opus-4-8:rawPredict",
      );
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer test-vertex-token");
      expect(headers["x-api-key"]).toBeUndefined();
      expect(headers["anthropic-version"]).toBeUndefined();
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      expect(body.anthropic_version).toBe("vertex-2023-10-16");
      expect("model" in body).toBe(false);
      expect("stream" in body).toBe(false);
    } finally {
      _setTestVertexTokenProvider(null);
    }
  });

  test("vertex worker proceeds even when the client sends NO credential", async () => {
    // Vertex auth is lore's GCP token, so a client sending no x-api-key is the
    // legitimate gateway-holds-credentials case. Background distillation/curation
    // must still run (a missing client key must NOT disable it for vertex).
    _setTestVertexTokenProvider(() => Promise.resolve("test-vertex-token"));
    try {
      mockFetch.mockResolvedValue(anthropicResponse());
      const client = createGatewayLLMClient(
        UPSTREAMS,
        () => null, // client provided no credential
        { providerID: "vertex", modelID: "claude-opus-4-8" },
        { vertexProject: "test-vertex-project" },
      );

      const text = await client.prompt("system", "user", {
        sessionID: "sess-vertex-nokey",
        workerID: "lore-distill",
        upstreamUrl: "https://aiplatform.googleapis.com",
        upstreamProviderID: "vertex",
        protocol: "vertex",
      });

      expect(text).toBe("hello from worker");
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toContain(":rawPredict");
      expect((init!.headers as Record<string, string>).Authorization).toBe(
        "Bearer test-vertex-token",
      );
    } finally {
      _setTestVertexTokenProvider(null);
    }
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
// Data-policy 404 detection + :free auto-recovery
//
// REGRESSION: an OpenRouter session auto-selected a $0 `:free` worker model,
// which OpenRouter 404s for accounts that haven't opted into its data policy
// ("No endpoints available matching your guardrail restrictions and data
// policy"). The old code classified it as retriable `upstream-error`, causing a
// tight retry storm + a misleading "upstream failing" degradation warning. The
// fix blocklists the model + :free tier and classifies it as `data-policy`.
// ---------------------------------------------------------------------------

describe("isDataPolicyBlocked404 detector", () => {
  const OR_BODY = JSON.stringify({
    error: {
      message:
        "No endpoints available matching your guardrail restrictions and data policy. Configure: https://openrouter.ai/settings/privacy",
      code: 404,
    },
  });

  test("true for OpenRouter data-policy 404", () => {
    expect(isDataPolicyBlocked404(404, OR_BODY)).toBe(true);
  });

  test("matches on guardrail / privacy phrasing too", () => {
    expect(
      isDataPolicyBlocked404(404, "no endpoints matching your guardrail rules"),
    ).toBe(true);
    expect(
      isDataPolicyBlocked404(404, "No endpoints; see /settings/privacy"),
    ).toBe(true);
  });

  test("false for an ordinary 404 (wrong URL / unknown model)", () => {
    expect(isDataPolicyBlocked404(404, "model not found")).toBe(false);
    expect(isDataPolicyBlocked404(404, "404 page not found")).toBe(false);
  });

  test("false for the same body on a non-404 status", () => {
    expect(isDataPolicyBlocked404(429, OR_BODY)).toBe(false);
    expect(isDataPolicyBlocked404(400, OR_BODY)).toBe(false);
  });
});

describe("worker data-policy 404: blocklist + re-resolve, not an outage", () => {
  const mockFetch = vi.mocked(upstreamFetch);
  const mockRecordFailure = vi.mocked(recordWorkerFailure);
  const mockMarkPaused = vi.mocked(markWorkerPaused);
  const mockMarkIncapable = vi.mocked(markWorkerIncapable);
  const mockMarkFreeBlocked = vi.mocked(markFreeModelsDataBlocked);

  const DATA_POLICY_404 = JSON.stringify({
    error: {
      message:
        "No endpoints available matching your guardrail restrictions and data policy. Configure: https://openrouter.ai/settings/privacy",
      code: 404,
    },
  });

  beforeEach(() => {
    mockRecordFailure.mockClear();
    mockMarkPaused.mockClear();
    mockMarkIncapable.mockClear();
    mockMarkFreeBlocked.mockClear();
    // Reset the shared worker-health blocklist so a model marked incapable by
    // one test (ANY_WORKER-scoped, e.g. the data-policy 404 case) does not leak
    // into the next and short-circuit its prompt() at the incapable guard.
    _resetWorkerHealthForTest();
  });

  afterEach(() => {
    mockFetch.mockReset();
    _resetWorkerHealthForTest();
  });

  test("a :free model data-policy 404 blocklists the model + provider :free tier, records data-policy (NOT upstream-error), and does NOT credit-pause", async () => {
    mockFetch.mockImplementation(
      async () =>
        new Response(DATA_POLICY_404, { status: 404, statusText: "Not Found" }),
    );

    const client = createGatewayLLMClient(
      {
        anthropic: "https://api.anthropic.com",
        openai: "https://api.openai.com",
        openrouter: "https://openrouter.ai/api",
      } as unknown as { anthropic: string; openai: string },
      () => ({ scheme: "bearer", value: "sk-or-test" }),
      { providerID: "openrouter", modelID: "cohere/north-mini-code:free" },
    );

    const result = await client.prompt("system", "user", {
      workerID: "lore-distill",
      sessionID: "sess-dp-test",
      protocol: "openai",
      upstreamProviderID: "openrouter",
      upstreamUrl: "https://openrouter.ai/api",
    });

    expect(result).toBeNull();
    // Not retried — a data-policy 404 is permanent for this model.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    // Specific model blocklisted.
    expect(mockMarkIncapable).toHaveBeenCalledWith(
      "openrouter",
      "cohere/north-mini-code:free",
    );
    // Whole :free tier blocked for the provider (it IS a :free model).
    expect(mockMarkFreeBlocked).toHaveBeenCalledWith("openrouter");
    // Classified as data-policy, NOT upstream-error.
    // Mutation: classify as upstream-error → this assertion RED.
    expect(mockRecordFailure).toHaveBeenCalledWith(
      "sess-dp-test",
      "lore-distill",
      "data-policy",
    );
    expect(mockRecordFailure).not.toHaveBeenCalledWith(
      "sess-dp-test",
      "lore-distill",
      "upstream-error",
    );
    // The fix is re-resolution, not pausing the session.
    expect(mockMarkPaused).not.toHaveBeenCalled();
  });

  test("a NON-:free model data-policy 404 blocklists the model but NOT the :free tier", async () => {
    mockFetch.mockImplementation(
      async () =>
        new Response(DATA_POLICY_404, { status: 404, statusText: "Not Found" }),
    );

    const client = createGatewayLLMClient(
      {
        anthropic: "https://api.anthropic.com",
        openai: "https://api.openai.com",
        openrouter: "https://openrouter.ai/api",
      } as unknown as { anthropic: string; openai: string },
      () => ({ scheme: "bearer", value: "sk-or-test" }),
      { providerID: "openrouter", modelID: "some/paid-model" },
    );

    await client.prompt("system", "user", {
      workerID: "lore-distill",
      sessionID: "sess-dp-paid",
      protocol: "openai",
      upstreamProviderID: "openrouter",
      upstreamUrl: "https://openrouter.ai/api",
    });

    expect(mockMarkIncapable).toHaveBeenCalledWith(
      "openrouter",
      "some/paid-model",
    );
    expect(mockMarkFreeBlocked).not.toHaveBeenCalled();
    expect(mockRecordFailure).toHaveBeenCalledWith(
      "sess-dp-paid",
      "lore-distill",
      "data-policy",
    );
  });

  test("an ordinary 404 (not data-policy) stays upstream-error + credit-pause", async () => {
    mockFetch.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({ error: { message: "model not found" } }),
          {
            status: 404,
            statusText: "Not Found",
          },
        ),
    );

    const client = createGatewayLLMClient(
      {
        anthropic: "https://api.anthropic.com",
        openai: "https://api.openai.com",
        openrouter: "https://openrouter.ai/api",
      } as unknown as { anthropic: string; openai: string },
      () => ({ scheme: "bearer", value: "sk-or-test" }),
      { providerID: "openrouter", modelID: "some/model" },
    );

    await client.prompt("system", "user", {
      workerID: "lore-distill",
      sessionID: "sess-plain-404",
      protocol: "openai",
      upstreamProviderID: "openrouter",
      upstreamUrl: "https://openrouter.ai/api",
    });

    // Ordinary 404 keeps the legacy behavior: upstream-error + soft-pause.
    expect(mockMarkIncapable).not.toHaveBeenCalled();
    expect(mockMarkFreeBlocked).not.toHaveBeenCalled();
    expect(mockRecordFailure).toHaveBeenCalledWith(
      "sess-plain-404",
      "lore-distill",
      "upstream-error",
    );
    expect(mockMarkPaused).toHaveBeenCalledWith("sess-plain-404");
  });

  test("a data-policy error surfaced as HTTP 200 + {error:{code:404}} envelope is blocklisted as data-policy (not miscounted as empty/incapable)", async () => {
    mockFetch.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              message:
                "No endpoints available matching your guardrail restrictions and data policy. Configure: https://openrouter.ai/settings/privacy",
              code: 404,
            },
          }),
          {
            // Misleading 200 wire status — the real signal is the embedded code.
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    );

    const client = createGatewayLLMClient(
      {
        anthropic: "https://api.anthropic.com",
        openai: "https://api.openai.com",
        openrouter: "https://openrouter.ai/api",
      } as unknown as { anthropic: string; openai: string },
      () => ({ scheme: "bearer", value: "sk-or-test" }),
      { providerID: "openrouter", modelID: "cohere/north-mini-code:free" },
    );

    const result = await client.prompt("system", "user", {
      workerID: "lore-distill",
      sessionID: "sess-dp-200",
      protocol: "openai",
      upstreamProviderID: "openrouter",
      upstreamUrl: "https://openrouter.ai/api",
    });

    expect(result).toBeNull();
    // Mutation: remove the HTTP-200-envelope data-policy branch → this is
    // recorded via the empty-response path (worker-incapable eventually), NOT
    // data-policy, and the :free tier is never blocked → RED.
    expect(mockMarkIncapable).toHaveBeenCalledWith(
      "openrouter",
      "cohere/north-mini-code:free",
    );
    expect(mockMarkFreeBlocked).toHaveBeenCalledWith("openrouter");
    expect(mockRecordFailure).toHaveBeenCalledWith(
      "sess-dp-200",
      "lore-distill",
      "data-policy",
    );
    expect(mockMarkPaused).not.toHaveBeenCalled();
  });

  test("a NORMAL 200 completion whose text mentions the data-policy phrase is NOT blocklisted (no embedded error code)", async () => {
    // Seer #1407 false-positive guard: a successful reply (bodyErrCode === null)
    // that happens to contain "No endpoints … data policy" — e.g. the model
    // explaining OpenRouter's own error to the user — must be returned normally,
    // NEVER blocklisted. Mutation: revert the gate to `bodyErrCode ?? 404` →
    // this reply is treated as a data-policy failure → RED.
    mockFetch.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            id: "cmpl-normal",
            choices: [
              {
                message: {
                  role: "assistant",
                  content:
                    "OpenRouter returns 'No endpoints available matching your guardrail restrictions and data policy' when your account has not opted into prompt logging.",
                },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 20, completion_tokens: 30 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    const client = createGatewayLLMClient(
      {
        anthropic: "https://api.anthropic.com",
        openai: "https://api.openai.com",
        openrouter: "https://openrouter.ai/api",
      } as unknown as { anthropic: string; openai: string },
      () => ({ scheme: "bearer", value: "sk-or-test" }),
      { providerID: "openrouter", modelID: "cohere/north-mini-code:free" },
    );

    const result = await client.prompt("system", "user", {
      workerID: "lore-distill",
      sessionID: "sess-dp-falsepos",
      protocol: "openai",
      upstreamProviderID: "openrouter",
      upstreamUrl: "https://openrouter.ai/api",
    });

    // The completion text is returned; nothing is blocklisted or recorded.
    expect(result).toContain("OpenRouter returns");
    expect(mockMarkIncapable).not.toHaveBeenCalled();
    expect(mockMarkFreeBlocked).not.toHaveBeenCalled();
    expect(mockRecordFailure).not.toHaveBeenCalled();
    expect(mockMarkPaused).not.toHaveBeenCalled();
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
      const url = fetchArgUrl(call[0]);
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
    const url = fetchArgUrl(mockFetch.mock.calls[0][0]);
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
      expect(fetchArgUrl(call[0])).not.toContain("api.anthropic.com");
    }
  });
});

// ---------------------------------------------------------------------------
// Worker beta stripping — `context-1m` is NEVER carried on worker calls.
//
// The client's `anthropic-beta` (incl. a `context-1m` long-context beta) is
// replayed verbatim onto worker calls. Workers operate on bounded message
// segments (a distillation segment is capped at 16K tokens, the whole session
// is typically well under 200K) and never need the 1M window — so we strip
// the `context-1m` beta UNCONDITIONALLY on the worker build path. This used
// to be capability-conditional (drop only for sub-1M models like haiku), but
// that left the default worker model (claude-sonnet-4-6, 1M-capable) carrying
// the beta on subscription auth accounts without purchased usage credits, where
// Anthropic rejects any call carrying `context-1m` with a 429 — "Usage credits
// are required for long context requests." — and that 429 is permanent, so
// workers exhaust their retry budget, the circuit breaker trips, and
// distillation/curation/cache-warming stop forever (issue #1571). Other betas
// (oauth-2025-04-20, fine-grained-tool-streaming, extended-cache-ttl,
// prompt-caching-scope) are always preserved. A runtime 400-retry-without-beta
// safety net remains in the retry loop for any future beta the upstream rejects.
// ---------------------------------------------------------------------------

describe("worker beta stripping (#1571)", () => {
  const mockFetch = vi.mocked(upstreamFetch);

  const UPSTREAMS = {
    anthropic: "https://api.anthropic.com",
    openai: "https://api.openai.com",
  };

  beforeEach(() => {
    vi.mocked(recordWorkerFailure).mockClear();
    vi.mocked(markWorkerPaused).mockClear();
  });

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

  test("drops the context-1m beta for a 1M-capable worker model (opus) — issue #1571", async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: "ok" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    // The user's session is on a 1M-capable model (claude-opus-4-8) and opted
    // into the long-context beta. The default worker model is also 1M-capable
    // (claude-sonnet-4-6, the model that actually triggered the bug). The
    // worker MUST drop the context-1m beta — otherwise the call 429s on
    // subscription auth accounts without usage credits and the session's
    // background work stops forever. The OAuth gate is preserved so the bearer
    // token still authenticates.
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

    const beta = betaOf(0);
    expect(beta).toBeDefined();
    // The long-context beta is dropped — workers never need 1M. The OAuth gate
    // is preserved so the request still authenticates.
    expect(beta).not.toContain("context-1m");
    expect(beta).toContain("oauth-2025-04-20");
  });

  test("drops the context-1m beta on the default worker model (claude-sonnet-4-6) — reproduces #1571", async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: "ok" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    // This is the exact setup from the bug report: the user is on a 1M
    // session model, the worker resolves to claude-sonnet-4-6 (1M-capable),
    // and the upstream is subscription auth without usage credits. Without the
    // fix, the worker call carries context-1m and 429s permanently. With the
    // fix, the beta is stripped upfront and the call succeeds.
    captureBillingPrefix("sess-sonnet46", BILLING_SYSTEM);
    captureSessionHeaders("sess-sonnet46", {
      "anthropic-beta": "oauth-2025-04-20,context-1m-2025-08-07",
    });

    const client = createGatewayLLMClient(
      UPSTREAMS,
      () => ({ scheme: "bearer", value: "oauth-token" }),
      { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
    );

    await client.prompt("system", "user", {
      sessionID: "sess-sonnet46",
      workerID: "lore-distill",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
    });

    const beta = betaOf(0);
    expect(beta).toBeDefined();
    expect(beta).not.toContain("context-1m");
    expect(beta).toContain("oauth-2025-04-20");
  });

  test("drops the context-1m beta even when the user opted in with a date-suffixed variant", async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: "ok" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    // The date suffix on context-1m-* changes over time; the strip must match
    // any variant of the stem so a future release doesn't suddenly start
    // carrying the beta again.
    captureBillingPrefix("sess-suffix", BILLING_SYSTEM);
    captureSessionHeaders("sess-suffix", {
      "anthropic-beta": "oauth-2025-04-20,context-1m-2099-12-31",
    });

    const client = createGatewayLLMClient(
      UPSTREAMS,
      () => ({ scheme: "bearer", value: "oauth-token" }),
      { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
    );

    await client.prompt("system", "user", {
      sessionID: "sess-suffix",
      workerID: "lore-distill",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
    });

    const beta = betaOf(0);
    expect(beta).toBeDefined();
    expect(beta).not.toContain("context-1m");
    expect(beta).toContain("oauth-2025-04-20");
  });

  test("removes the entire anthropic-beta header when stripping context-1m leaves no other betas", async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: "ok" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    // Mark the session as billing/OAuth so `captureSessionHeaders` actually
    // persists the snapshot (it returns early otherwise — `buildOAuthWorkerHeaders`
    // would then return `null` and the worker request would never carry
    // `anthropic-beta` at all, making the test a no-op).
    captureBillingPrefix("sess-only-context", BILLING_SYSTEM);
    // If the sniffed beta IS the long-context beta, `buildOAuthWorkerHeaders`
    // replays it directly (not the WORKER_BETAS fallback). The upfront strip
    // removes context-1m and leaves no betas — so the header is dropped
    // entirely rather than echoed back as an empty value. This is the
    // end-to-end integration of the `delete headers[betaKey]` branch
    // (covered directly as a unit test on `stripBetaHeaders` in
    // `long-context-beta.test.ts`).
    captureSessionHeaders("sess-only-context", {
      "anthropic-beta": "context-1m-2025-08-07",
    });

    const client = createGatewayLLMClient(
      UPSTREAMS,
      () => ({ scheme: "bearer", value: "oauth-token" }),
      { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
    );

    await client.prompt("system", "user", {
      sessionID: "sess-only-context",
      workerID: "lore-distill",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
    });

    // The header should be absent entirely — no `anthropic-beta` key in the
    // outbound request (regardless of case).
    const init = mockFetch.mock.calls[0]?.[1];
    const headers = init?.headers as Record<string, string> | undefined;
    const key =
      headers &&
      Object.keys(headers).find((k) => k.toLowerCase() === "anthropic-beta");
    expect(key).toBeUndefined();
  });

  test("matches the anthropic-beta header case-insensitively (e.g. Anthropic-Beta key)", async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: "ok" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    // The header key match uses `k.toLowerCase() === "anthropic-beta"`, so a
    // header keyed `Anthropic-Beta` is normalized. Lock this down so a future
    // refactor that switches to a case-sensitive match doesn't silently start
    // carrying context-1m again on mis-keyed sessions.
    captureBillingPrefix("sess-case-key", BILLING_SYSTEM);
    captureSessionHeaders("sess-case-key", {
      "Anthropic-Beta": "oauth-2025-04-20,context-1m-2025-08-07",
    });

    const client = createGatewayLLMClient(
      UPSTREAMS,
      () => ({ scheme: "bearer", value: "oauth-token" }),
      { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
    );

    await client.prompt("system", "user", {
      sessionID: "sess-case-key",
      workerID: "lore-distill",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
    });

    // Find the surviving anthropic-beta value across any case-variant key
    // (the worker request may normalize or preserve the key); verify the
    // context-1m token is gone in all cases.
    const init = mockFetch.mock.calls[0]?.[1];
    const headers = init?.headers as Record<string, string> | undefined;
    const beta =
      headers &&
      Object.values(headers).find(
        (v) => typeof v === "string" && v.includes("oauth-2025-04-20"),
      );
    expect(beta).toBeDefined();
    expect(beta).not.toContain("context-1m");
  });

  test("does not crash on an empty anthropic-beta header value (no-op)", async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: "ok" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    // An empty value should not crash and should not be turned into anything
    // weird. The guard `if (!betaValue)` short-circuits, leaving the header
    // exactly as-is. This is a defensive pin against a future refactor that
    // might drop the guard and accidentally create an empty header value.
    captureBillingPrefix("sess-empty-beta", BILLING_SYSTEM);
    captureSessionHeaders("sess-empty-beta", {
      "anthropic-beta": "",
    });

    const client = createGatewayLLMClient(
      UPSTREAMS,
      () => ({ scheme: "bearer", value: "oauth-token" }),
      { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
    );

    await client.prompt("system", "user", {
      sessionID: "sess-empty-beta",
      workerID: "lore-distill",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
    });

    // The call succeeded without crashing; one outbound fetch (no retry).
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Temperature-vs-model capability + runtime 400-retry-without-temperature
//
// Worker call sites set `temperature: 0` for reproducible distillation/curation.
// Newer models (e.g. claude-sonnet-5) DEPRECATED the sampling param and reject
// any request carrying it with a 400 ("`temperature` is deprecated for this
// model."), which broke every worker on that model. We (1) retry once with the
// temperature param removed on such a 400, and (2) learn the fact so subsequent
// worker calls to that model omit temperature upfront.
// ---------------------------------------------------------------------------

describe("worker temperature capability", () => {
  const mockFetch = vi.mocked(upstreamFetch);

  const UPSTREAMS = {
    anthropic: "https://api.anthropic.com",
    openai: "https://api.openai.com",
  };

  beforeEach(() => {
    _resetTemperatureUnsupportedModels();
    vi.mocked(recordWorkerFailure).mockClear();
    vi.mocked(markWorkerPaused).mockClear();
  });

  afterEach(() => {
    mockFetch.mockReset();
    clearAllCosts();
    resetBackgroundLimiter();
    _resetTemperatureUnsupportedModels();
  });

  function bodyOf(callIndex: number): Record<string, unknown> | undefined {
    const init = mockFetch.mock.calls[callIndex]?.[1];
    const raw = init?.body;
    if (typeof raw !== "string") return undefined;
    return JSON.parse(raw) as Record<string, unknown>;
  }

  function betaOf(callIndex: number): string | undefined {
    const init = mockFetch.mock.calls[callIndex]?.[1];
    const headers = init?.headers as Record<string, string> | undefined;
    if (!headers) return undefined;
    const key = Object.keys(headers).find(
      (k) => k.toLowerCase() === "anthropic-beta",
    );
    return key ? headers[key] : undefined;
  }

  const TEMP_DEPRECATED_400 = JSON.stringify({
    type: "error",
    error: {
      type: "invalid_request_error",
      message: "`temperature` is deprecated for this model.",
    },
  });

  test("sends temperature upfront for a model not known to reject it", async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: "ok" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const client = createGatewayLLMClient(
      UPSTREAMS,
      () => ({ scheme: "api-key", value: "sk-ant-test" }),
      { providerID: "anthropic", modelID: "claude-opus-4-8" },
    );

    await client.prompt("system", "user", {
      sessionID: "sess-temp-ok",
      workerID: "lore-distill",
      model: { providerID: "anthropic", modelID: "claude-opus-4-8" },
      temperature: 0,
    });

    expect(bodyOf(0)?.temperature).toBe(0);
  });

  test("retries once without temperature on a deprecation 400, then succeeds", async () => {
    let call = 0;
    mockFetch.mockImplementation(async () => {
      call++;
      if (call === 1) {
        return new Response(TEMP_DEPRECATED_400, { status: 400 });
      }
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: "recovered" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const client = createGatewayLLMClient(
      UPSTREAMS,
      () => ({ scheme: "api-key", value: "sk-ant-test" }),
      { providerID: "anthropic", modelID: "claude-sonnet-5" },
    );

    const result = await client.prompt("system", "user", {
      sessionID: "sess-temp-400",
      workerID: "lore-distill",
      model: { providerID: "anthropic", modelID: "claude-sonnet-5" },
      temperature: 0,
    });

    expect(result).toBe("recovered");
    expect(mockFetch).toHaveBeenCalledTimes(2);
    // First attempt carried temperature; the retry dropped it entirely.
    expect(bodyOf(0)?.temperature).toBe(0);
    expect(bodyOf(1)).toBeDefined();
    expect(bodyOf(1)).not.toHaveProperty("temperature");
    // The model is now learned as temperature-unsupported.
    expect(
      isTemperatureUnsupportedModel({
        providerID: "anthropic",
        modelID: "claude-sonnet-5",
      }),
    ).toBe(true);
    // A recovered temperature-strip retry is NOT a worker failure: the health
    // ladder must not be incremented and the session must not be soft-paused.
    expect(recordWorkerFailure).not.toHaveBeenCalled();
    expect(markWorkerPaused).not.toHaveBeenCalled();
  });

  test("omits temperature upfront on the next call once a model is learned", async () => {
    // First call: 400 then recover (teaches the set).
    let call = 0;
    mockFetch.mockImplementation(async () => {
      call++;
      if (call === 1) {
        return new Response(TEMP_DEPRECATED_400, { status: 400 });
      }
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: "ok" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const client = createGatewayLLMClient(
      UPSTREAMS,
      () => ({ scheme: "api-key", value: "sk-ant-test" }),
      { providerID: "anthropic", modelID: "claude-sonnet-5" },
    );

    const opts = {
      sessionID: "sess-temp-learn",
      workerID: "lore-distill",
      model: { providerID: "anthropic", modelID: "claude-sonnet-5" },
      temperature: 0,
    };

    await client.prompt("system", "user", opts);
    expect(mockFetch).toHaveBeenCalledTimes(2); // 400 + retry

    // Second prompt to the same model: no wasted round-trip — temperature is
    // omitted on the FIRST request, so a single 200 call suffices.
    await client.prompt("system", "user", opts);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(bodyOf(2)).toBeDefined();
    expect(bodyOf(2)).not.toHaveProperty("temperature");
  });

  test("does not strip temperature for an unrelated 400", async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          type: "error",
          error: { type: "invalid_request_error", message: "bad max_tokens" },
        }),
        { status: 400 },
      ),
    );

    const client = createGatewayLLMClient(
      UPSTREAMS,
      () => ({ scheme: "api-key", value: "sk-ant-test" }),
      { providerID: "anthropic", modelID: "claude-sonnet-5" },
    );

    const result = await client.prompt("system", "user", {
      sessionID: "sess-temp-unrelated",
      workerID: "lore-distill",
      model: { providerID: "anthropic", modelID: "claude-sonnet-5" },
      temperature: 0,
    });

    // Unrelated 400 → no retry, no learning.
    expect(result).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(
      isTemperatureUnsupportedModel({
        providerID: "anthropic",
        modelID: "claude-sonnet-5",
      }),
    ).toBe(false);
  });

  test("does not learn the model when the temperature-stripped retry still fails", async () => {
    // call 1: temperature-deprecated 400 → strip + retry.
    // call 2: an UNRELATED 400 → temperature was not the (only) cause, so the
    // model must NOT be learned (learning is deferred to a successful retry).
    let call = 0;
    mockFetch.mockImplementation(async () => {
      call++;
      if (call === 1) {
        return new Response(TEMP_DEPRECATED_400, { status: 400 });
      }
      return new Response(
        JSON.stringify({
          error: { type: "invalid_request_error", message: "bad max_tokens" },
        }),
        { status: 400 },
      );
    });

    const client = createGatewayLLMClient(
      UPSTREAMS,
      () => ({ scheme: "api-key", value: "sk-ant-test" }),
      { providerID: "anthropic", modelID: "claude-sonnet-5" },
    );

    const result = await client.prompt("system", "user", {
      sessionID: "sess-temp-fail",
      workerID: "lore-distill",
      model: { providerID: "anthropic", modelID: "claude-sonnet-5" },
      temperature: 0,
    });

    expect(result).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(2); // stripped once, still failed
    expect(bodyOf(1)).not.toHaveProperty("temperature"); // strip did happen
    // But the model is NOT learned — the retry never confirmed the cure.
    expect(
      isTemperatureUnsupportedModel({
        providerID: "anthropic",
        modelID: "claude-sonnet-5",
      }),
    ).toBe(false);
  });

  test("temperature-strip rebuild uses the refreshed credential (not the stale one) after an auth refresh in the same call", async () => {
    // call 1: 401 → auth refresh (getAuth now returns the fresh key), rebuild.
    // call 2: temperature 400 → strip + rebuild. The rebuild MUST sign with the
    //         refreshed key, not the original stale one that already 401'd.
    // call 3: 200.
    let call = 0;
    mockFetch.mockImplementation(async () => {
      call++;
      if (call === 1) return new Response("unauthorized", { status: 401 });
      if (call === 2) return new Response(TEMP_DEPRECATED_400, { status: 400 });
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: "recovered" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    let authCall = 0;
    const getAuth = () => {
      authCall++;
      return {
        scheme: "api-key" as const,
        value: authCall === 1 ? "sk-ant-stale" : "sk-ant-fresh",
      };
    };

    const client = createGatewayLLMClient(UPSTREAMS, getAuth, {
      providerID: "anthropic",
      modelID: "claude-sonnet-5",
    });

    const result = await client.prompt("system", "user", {
      sessionID: "sess-temp-authrefresh",
      workerID: "lore-distill",
      model: { providerID: "anthropic", modelID: "claude-sonnet-5" },
      temperature: 0,
    });

    const keyOf = (i: number): string | undefined => {
      const init = mockFetch.mock.calls[i]?.[1];
      const headers = init?.headers as Record<string, string> | undefined;
      return headers?.["x-api-key"];
    };

    expect(result).toBe("recovered");
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(keyOf(1)).toBe("sk-ant-fresh"); // auth rebuild adopted the fresh key
    expect(keyOf(2)).toBe("sk-ant-fresh"); // temperature rebuild kept the fresh key
    expect(bodyOf(2)).not.toHaveProperty("temperature");
  });

  test("strips temperature on the OpenAI Chat Completions worker path too", async () => {
    let call = 0;
    mockFetch.mockImplementation(async () => {
      call++;
      if (call === 1) {
        return new Response(
          JSON.stringify({
            error: {
              message: "Unsupported parameter: 'temperature' is not supported.",
              type: "invalid_request_error",
            },
          }),
          { status: 400 },
        );
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "recovered" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const client = createGatewayLLMClient(
      UPSTREAMS,
      () => ({ scheme: "api-key", value: "sk-openai-test" }),
      { providerID: "openai", modelID: "gpt-5" },
    );

    const result = await client.prompt("system", "user", {
      sessionID: "sess-temp-openai",
      workerID: "lore-distill",
      model: { providerID: "openai", modelID: "gpt-5" },
      protocol: "openai",
      temperature: 0,
    });

    expect(result).toBe("recovered");
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(bodyOf(0)?.temperature).toBe(0);
    expect(bodyOf(1)).toBeDefined();
    expect(bodyOf(1)).not.toHaveProperty("temperature");
  });

  test("temperature rebuild does not resurrect the context-1m beta (upfront strip is unconditional across rebuilds)", async () => {
    // Verify the temperature rebuild path also keeps context-1m stripped.
    // The upfront filter strips context-1m UNCONDITIONALLY for workers
    // (issue #1571), so the rebuild through buildWorkerRequest cannot
    // resurrect the beta — the same invariant as before, but now enforced
    // at build time rather than via the runtime `if (betaStripped)` latch.
    let call = 0;
    mockFetch.mockImplementation(async () => {
      call++;
      if (call === 1) {
        return new Response(TEMP_DEPRECATED_400, { status: 400 });
      }
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: "recovered" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    // The user opted into context-1m on a 1M-capable session model. The
    // upfront filter strips the beta for workers regardless of the session
    // model — and the rebuild through buildWorkerRequest keeps the strip.
    captureBillingPrefix("sess-rebuild", BILLING_SYSTEM);
    captureSessionHeaders("sess-rebuild", {
      "anthropic-beta": "oauth-2025-04-20,context-1m-2025-08-07",
    });

    const client = createGatewayLLMClient(
      UPSTREAMS,
      () => ({ scheme: "bearer", value: "oauth-token" }),
      { providerID: "anthropic", modelID: "claude-opus-4-8" },
    );

    const result = await client.prompt("system", "user", {
      sessionID: "sess-rebuild",
      workerID: "lore-distill",
      model: { providerID: "anthropic", modelID: "claude-opus-4-8" },
      temperature: 0,
    });

    expect(result).toBe("recovered");
    expect(mockFetch).toHaveBeenCalledTimes(2);
    // First attempt: context-1m already stripped upfront, OAuth gate present.
    expect(betaOf(0)).not.toContain("context-1m");
    expect(betaOf(0)).toContain("oauth-2025-04-20");
    expect(bodyOf(0)).toHaveProperty("temperature");
    // Rebuild after temperature 400: still no context-1m (upfront strip is
    // unconditional across rebuilds), no temperature, OAuth gate preserved.
    expect(betaOf(1)).not.toContain("context-1m");
    expect(betaOf(1)).toContain("oauth-2025-04-20");
    expect(bodyOf(1)).not.toHaveProperty("temperature");
  });
});

// ---------------------------------------------------------------------------
// Worker thinking suppression.
//
// Workers do deterministic single-shot summarization (distillation/curation)
// and never benefit from extended/adaptive thinking. Newer Claude models
// (claude-sonnet-5+) use ADAPTIVE thinking that is silently activated by the
// replayed Claude Code OAuth fingerprint (`oauth-2025-04-20` beta on
// api.anthropic.com). When active, the model can return an EMPTY thinking block
// with no visible text — the worker then sees a "no usable text" empty response
// and the whole distill/curate loop degrades. We send `thinking:{type:"disabled"}`
// on genuine Anthropic Claude worker requests to force plain text output.
// ---------------------------------------------------------------------------
describe("worker thinking disabled for Anthropic Claude models", () => {
  const mockFetch = vi.mocked(upstreamFetch);

  const UPSTREAMS = {
    anthropic: "https://api.anthropic.com",
    openai: "https://api.openai.com",
  };

  beforeEach(() => {
    _resetThinkingUnsupportedModels();
    vi.mocked(recordWorkerFailure).mockClear();
    vi.mocked(markWorkerPaused).mockClear();
  });

  afterEach(() => {
    mockFetch.mockReset();
    clearAllCosts();
    resetBackgroundLimiter();
    _resetThinkingUnsupportedModels();
  });

  // Anthropic-style 400 for a model that doesn't accept the `thinking` field
  // (e.g. one that predates the thinking API).
  const THINKING_UNSUPPORTED_400 = JSON.stringify({
    type: "error",
    error: {
      type: "invalid_request_error",
      message: "thinking: Extra inputs are not permitted",
    },
  });

  function bodyOf(callIndex: number): Record<string, unknown> | undefined {
    const raw = mockFetch.mock.calls[callIndex]?.[1]?.body;
    if (typeof raw !== "string") return undefined;
    return JSON.parse(raw) as Record<string, unknown>;
  }

  function betaOf(callIndex: number): string | undefined {
    const headers = mockFetch.mock.calls[callIndex]?.[1]?.headers as
      | Record<string, string>
      | undefined;
    if (!headers) return undefined;
    const key = Object.keys(headers).find(
      (k) => k.toLowerCase() === "anthropic-beta",
    );
    return key ? headers[key] : undefined;
  }

  const okResponse = () =>
    new Response(
      JSON.stringify({
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  test("isAnthropicClaudeModel matches real Claude ids and excludes compat providers", () => {
    expect(isAnthropicClaudeModel("claude-sonnet-5")).toBe(true);
    expect(isAnthropicClaudeModel("claude-haiku-4-5")).toBe(true);
    expect(isAnthropicClaudeModel("anthropic.claude-haiku-4-5")).toBe(true); // Bedrock mantle id
    expect(isAnthropicClaudeModel("MiniMax-M1")).toBe(false);
    expect(isAnthropicClaudeModel("gpt-5")).toBe(false);
  });

  test("genuine Anthropic Claude worker request disables thinking", async () => {
    mockFetch.mockResolvedValue(okResponse());
    const client = createGatewayLLMClient(
      UPSTREAMS,
      () => ({ scheme: "api-key", value: "sk-ant-test" }),
      { providerID: "anthropic", modelID: "claude-sonnet-5" },
    );

    await client.prompt("system", "user", {
      sessionID: "sess-think-basic",
      workerID: "lore-distill",
      model: { providerID: "anthropic", modelID: "claude-sonnet-5" },
    });

    expect(bodyOf(0)?.thinking).toEqual({ type: "disabled" });
  });

  test("OAuth-fingerprint Claude worker (the failing production path) disables thinking despite the replayed interleaved-thinking beta", async () => {
    mockFetch.mockResolvedValue(okResponse());
    // Simulate a Claude Code OAuth session: billing prefix marks it, and the
    // sniffed anthropic-beta (with the interleaved-thinking flag that would
    // otherwise let sonnet-5 emit an empty thinking block) is replayed onto
    // worker calls.
    captureBillingPrefix("sess-think-oauth", BILLING_SYSTEM);
    captureSessionHeaders("sess-think-oauth", {
      "anthropic-beta": "oauth-2025-04-20,interleaved-thinking-2025-05-14",
    });

    const client = createGatewayLLMClient(
      UPSTREAMS,
      () => ({ scheme: "bearer", value: "oauth-token" }),
      { providerID: "anthropic", modelID: "claude-sonnet-5" },
    );

    await client.prompt("system", "user", {
      sessionID: "sess-think-oauth",
      workerID: "lore-distill",
      model: { providerID: "anthropic", modelID: "claude-sonnet-5" },
    });

    // The interleaved-thinking beta IS replayed (unchanged behavior)...
    expect(betaOf(0)).toContain("interleaved-thinking");
    // ...but thinking is explicitly disabled, so the model cannot burn its
    // budget on an (empty) thinking block and starve the visible text.
    expect(bodyOf(0)?.thinking).toEqual({ type: "disabled" });
  });

  test("anthropic-compat (non-Claude) worker does NOT send a thinking param", async () => {
    mockFetch.mockResolvedValue(okResponse());
    const client = createGatewayLLMClient(
      UPSTREAMS,
      () => ({ scheme: "api-key", value: "mm-key" }),
      { providerID: "minimax", modelID: "MiniMax-M1" },
    );

    await client.prompt("system", "user", {
      sessionID: "sess-think-mm",
      workerID: "lore-distill",
      model: { providerID: "minimax", modelID: "MiniMax-M1" },
      protocol: "anthropic",
      upstreamProviderID: "minimax",
      upstreamUrl: "https://api.minimaxi.chat",
    });

    expect(bodyOf(0)).not.toHaveProperty("thinking");
  });

  test("bedrock mantle Claude worker disables thinking (Anthropic Messages shape; sonnet-5-gen adaptive thinking is on by default on Bedrock too)", async () => {
    mockFetch.mockResolvedValue(okResponse());
    const client = createGatewayLLMClient(
      UPSTREAMS,
      () => ({ scheme: "api-key", value: "bedrock-key" }),
      { providerID: "bedrock", modelID: "claude-haiku-4-5" },
    );

    await client.prompt("system", "user", {
      sessionID: "sess-think-bedrock",
      workerID: "lore-distill",
      upstreamUrl: "https://bedrock-mantle.us-east-1.api.aws/anthropic",
      upstreamProviderID: "bedrock",
      protocol: "anthropic",
    });

    expect(bodyOf(0)?.thinking).toEqual({ type: "disabled" });
    // The body model is the mantle catalog id.
    expect(bodyOf(0)?.model).toBe("anthropic.claude-haiku-4-5");
  });

  test("vertex Claude worker disables thinking (threads thinking:{type:disabled} through toVertexBody)", async () => {
    // Vertex-served sonnet-5 has the same adaptive-thinking-on default; the
    // disable flag must survive the vertex body transform. Guards against a
    // silent regression where buildVertexWorkerRequest drops `disableThinking`.
    _setModelDataForTest({
      "claude-sonnet-5": {
        id: "claude-sonnet-5",
        reasoning: true,
        reasoning_options: [{ type: "toggle" }, { type: "effort" }],
      },
    });
    _setTestVertexTokenProvider(() => Promise.resolve("test-vertex-token"));
    try {
      mockFetch.mockResolvedValue(okResponse());
      const client = createGatewayLLMClient(
        UPSTREAMS,
        () => ({ scheme: "api-key", value: "client-key-ignored-for-vertex" }),
        { providerID: "vertex", modelID: "claude-sonnet-5" },
        { vertexProject: "test-vertex-project" },
      );

      await client.prompt("system", "user", {
        sessionID: "sess-vertex-think",
        workerID: "lore-distill",
        upstreamUrl: "https://aiplatform.googleapis.com",
        upstreamProviderID: "vertex",
        protocol: "vertex",
      });

      // toVertexBody preserves `thinking`, so the disabled flag reaches the wire.
      expect(bodyOf(0)?.thinking).toEqual({ type: "disabled" });
      // Vertex body never carries model/stream (belt-and-suspenders sanity).
      expect("model" in (bodyOf(0) ?? {})).toBe(false);
    } finally {
      _setTestVertexTokenProvider(null);
      clearModelDataCache();
    }
  });

  // -------------------------------------------------------------------------
  // Data-driven capability from models.dev (thinking + temperature).
  // -------------------------------------------------------------------------
  describe("driven by models.dev capability data", () => {
    afterEach(() => {
      clearModelDataCache();
    });

    test("workerThinkingOnByDefault: toggle → true; effort/budget_tokens/none → false", () => {
      _setModelDataForTest({
        "claude-sonnet-5": {
          id: "claude-sonnet-5",
          reasoning: true,
          reasoning_options: [{ type: "toggle" }, { type: "effort" }],
        },
        "claude-opus-4-8": {
          id: "claude-opus-4-8",
          reasoning: true,
          reasoning_options: [{ type: "effort" }],
        },
        "claude-sonnet-4-5": {
          id: "claude-sonnet-4-5",
          reasoning: true,
          reasoning_options: [{ type: "budget_tokens" }],
        },
        "some-nonreasoning": { id: "some-nonreasoning", reasoning: false },
      });
      expect(workerThinkingOnByDefault({ modelID: "claude-sonnet-5" })).toBe(
        true,
      );
      // On-by-default only for `toggle`; effort/budget_tokens run without
      // thinking unless asked, so no opt-out param is needed.
      expect(workerThinkingOnByDefault({ modelID: "claude-opus-4-8" })).toBe(
        false,
      );
      expect(workerThinkingOnByDefault({ modelID: "claude-sonnet-4-5" })).toBe(
        false,
      );
      expect(workerThinkingOnByDefault({ modelID: "some-nonreasoning" })).toBe(
        false,
      );
    });

    test("workerModelReasons: ANY reasoning_options → true (broader than the toggle-only thinking predicate)", () => {
      _setModelDataForTest({
        "toggle-model": {
          id: "toggle-model",
          reasoning_options: [{ type: "toggle" }],
        },
        "effort-model": {
          id: "effort-model",
          reasoning_options: [{ type: "effort" }],
        },
        "budget-model": {
          id: "budget-model",
          reasoning_options: [{ type: "budget_tokens" }],
        },
        "plain-model": { id: "plain-model", reasoning: false },
      });
      // The reasoning-headroom floor must fire for EVERY reasoning shape, not
      // just toggle — an effort-typed model (OpenRouter's claude-sonnet-5) still
      // burns hidden tokens by default. This is the divergence from
      // workerThinkingOnByDefault (toggle-only) that the production bug exposed.
      expect(workerModelReasons({ modelID: "toggle-model" })).toBe(true);
      expect(workerModelReasons({ modelID: "effort-model" })).toBe(true);
      expect(workerModelReasons({ modelID: "budget-model" })).toBe(true);
      expect(workerModelReasons({ modelID: "plain-model" })).toBe(false);
      // Explicit divergence: effort-typed is NOT thinking-on-by-default (no
      // opt-out param) but DOES reason (needs the budget floor).
      expect(workerThinkingOnByDefault({ modelID: "effort-model" })).toBe(
        false,
      );
      expect(workerModelReasons({ modelID: "effort-model" })).toBe(true);
    });

    test("workerModelReasons: falls back to the Claude-id heuristic when models.dev has no data", () => {
      clearModelDataCache();
      expect(workerModelReasons({ modelID: "claude-sonnet-5" })).toBe(true);
      expect(workerModelReasons({ modelID: "MiniMax-M1" })).toBe(false);
    });

    test("workerThinkingOnByDefault: falls back to the Claude-id heuristic when models.dev has no data (offline safety)", () => {
      clearModelDataCache(); // no models.dev data available
      // A models.dev outage must NOT stop us disabling thinking on Claude models.
      expect(workerThinkingOnByDefault({ modelID: "claude-sonnet-5" })).toBe(
        true,
      );
      expect(workerThinkingOnByDefault({ modelID: "MiniMax-M1" })).toBe(false);
    });

    test("effort-only model (opus-4-8) does NOT get a thinking param when models.dev data is present", async () => {
      _setModelDataForTest({
        "claude-opus-4-8": {
          id: "claude-opus-4-8",
          reasoning: true,
          reasoning_options: [{ type: "effort" }],
        },
      });
      mockFetch.mockResolvedValue(okResponse());
      const client = createGatewayLLMClient(
        UPSTREAMS,
        () => ({ scheme: "api-key", value: "sk-ant-test" }),
        { providerID: "anthropic", modelID: "claude-opus-4-8" },
      );
      await client.prompt("system", "user", {
        sessionID: "sess-effort",
        workerID: "lore-distill",
        model: { providerID: "anthropic", modelID: "claude-opus-4-8" },
      });
      expect(bodyOf(0)).not.toHaveProperty("thinking");
    });

    test("modelRejectsTemperatureByData reflects the models.dev temperature flag", () => {
      _setModelDataForTest({
        "claude-sonnet-5": { id: "claude-sonnet-5", temperature: false },
        "claude-sonnet-4-5": { id: "claude-sonnet-4-5", temperature: true },
      });
      expect(modelRejectsTemperatureByData("claude-sonnet-5")).toBe(true);
      expect(modelRejectsTemperatureByData("claude-sonnet-4-5")).toBe(false);
      // Unknown model (no data) → not proactively stripped (learning net covers).
      expect(modelRejectsTemperatureByData("mystery-model")).toBe(false);
    });

    test("temperature is stripped upfront (no 400 needed) when models.dev marks the model temperature:false", async () => {
      _setModelDataForTest({
        "claude-sonnet-5": { id: "claude-sonnet-5", temperature: false },
      });
      mockFetch.mockResolvedValue(okResponse());
      const client = createGatewayLLMClient(
        UPSTREAMS,
        () => ({ scheme: "api-key", value: "sk-ant-test" }),
        { providerID: "anthropic", modelID: "claude-sonnet-5" },
      );
      await client.prompt("system", "user", {
        sessionID: "sess-temp-data",
        workerID: "lore-distill",
        model: { providerID: "anthropic", modelID: "claude-sonnet-5" },
        temperature: 0,
      });
      // Single attempt, no 400 round-trip — temperature omitted from the start.
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(bodyOf(0)).not.toHaveProperty("temperature");
    });

    test("temperature is kept when models.dev marks the model temperature:true", async () => {
      _setModelDataForTest({
        "claude-sonnet-4-5": { id: "claude-sonnet-4-5", temperature: true },
      });
      mockFetch.mockResolvedValue(okResponse());
      const client = createGatewayLLMClient(
        UPSTREAMS,
        () => ({ scheme: "api-key", value: "sk-ant-test" }),
        { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
      );
      await client.prompt("system", "user", {
        sessionID: "sess-temp-keep-data",
        workerID: "lore-distill",
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
        temperature: 0,
      });
      expect(bodyOf(0)?.temperature).toBe(0);
    });
  });

  test("retries once without the thinking param on a thinking-unsupported 400, then succeeds and learns", async () => {
    let call = 0;
    mockFetch.mockImplementation(async () => {
      call++;
      if (call === 1) {
        return new Response(THINKING_UNSUPPORTED_400, { status: 400 });
      }
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: "recovered" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const model = { providerID: "anthropic", modelID: "claude-legacy-3" };
    const client = createGatewayLLMClient(
      UPSTREAMS,
      () => ({ scheme: "api-key", value: "sk-ant-test" }),
      model,
    );

    const result = await client.prompt("system", "user", {
      sessionID: "sess-think-400",
      workerID: "lore-distill",
      model,
    });

    expect(result).toBe("recovered");
    expect(mockFetch).toHaveBeenCalledTimes(2);
    // First attempt carried thinking; the retry dropped it entirely.
    expect(bodyOf(0)?.thinking).toEqual({ type: "disabled" });
    expect(bodyOf(1)).toBeDefined();
    expect(bodyOf(1)).not.toHaveProperty("thinking");
    // The model is now learned as thinking-unsupported.
    expect(isThinkingUnsupportedModel(model)).toBe(true);
    // A recovered thinking-strip retry is NOT a worker failure.
    expect(recordWorkerFailure).not.toHaveBeenCalled();
    expect(markWorkerPaused).not.toHaveBeenCalled();
  });

  test("omits the thinking param upfront once a model is learned", async () => {
    const model = { providerID: "anthropic", modelID: "claude-legacy-3" };
    markThinkingUnsupported(model);
    mockFetch.mockResolvedValue(okResponse());

    const client = createGatewayLLMClient(
      UPSTREAMS,
      () => ({ scheme: "api-key", value: "sk-ant-test" }),
      model,
    );

    await client.prompt("system", "user", {
      sessionID: "sess-think-learned",
      workerID: "lore-distill",
      model,
    });

    // No wasted round-trip — thinking is omitted upfront on the first call.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(bodyOf(0)).not.toHaveProperty("thinking");
  });

  test("does not strip thinking for an unrelated 400", async () => {
    let call = 0;
    mockFetch.mockImplementation(async () => {
      call++;
      return new Response(
        JSON.stringify({
          type: "error",
          error: { type: "invalid_request_error", message: "bad request" },
        }),
        { status: 400 },
      );
    });

    const model = { providerID: "anthropic", modelID: "claude-sonnet-5" };
    const client = createGatewayLLMClient(
      UPSTREAMS,
      () => ({ scheme: "api-key", value: "sk-ant-test" }),
      model,
    );

    const result = await client.prompt("system", "user", {
      sessionID: "sess-think-unrelated",
      workerID: "lore-distill",
      model,
    });

    expect(result).toBeNull();
    // No thinking-strip retry for an unrelated 400 — single attempt, not learned.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(isThinkingUnsupportedModel(model)).toBe(false);
    expect(call).toBe(1);
  });

  test("does not strip thinking for a 400 that mentions 'thinking' without a rejection verb", async () => {
    // The word "thinking" alone must NOT trigger a strip — only a genuine
    // rejection (deprecated/unsupported/not permitted/…) should. Guards the
    // rejection-verb clause of isThinkingUnsupported400. NB: the body must avoid
    // every verb, including "invalid" (so no `invalid_request_error` type here).
    let call = 0;
    mockFetch.mockImplementation(async () => {
      call++;
      return new Response(
        JSON.stringify({
          type: "error",
          error: {
            type: "bad_request",
            message: "the thinking field value is too large",
          },
        }),
        { status: 400 },
      );
    });

    const model = { providerID: "anthropic", modelID: "claude-sonnet-5" };
    const client = createGatewayLLMClient(
      UPSTREAMS,
      () => ({ scheme: "api-key", value: "sk-ant-test" }),
      model,
    );

    const result = await client.prompt("system", "user", {
      sessionID: "sess-think-verbless",
      workerID: "lore-distill",
      model,
    });

    expect(result).toBeNull();
    // "thinking" present but no rejection verb → no strip retry, single attempt.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(isThinkingUnsupportedModel(model)).toBe(false);
    expect(call).toBe(1);
  });

  test("does not learn the model when the thinking-stripped retry still fails", async () => {
    // call 1: thinking-unsupported 400 → strip + retry.
    // call 2: an UNRELATED 400 → thinking was not the (only) cause, so the model
    // must NOT be learned (learning is deferred to a successful retry). Mirror of
    // the temperature-suite symmetry test.
    let call = 0;
    mockFetch.mockImplementation(async () => {
      call++;
      if (call === 1) {
        return new Response(THINKING_UNSUPPORTED_400, { status: 400 });
      }
      return new Response(
        JSON.stringify({
          error: { type: "invalid_request_error", message: "bad max_tokens" },
        }),
        { status: 400 },
      );
    });

    const model = { providerID: "anthropic", modelID: "claude-legacy-3" };
    const client = createGatewayLLMClient(
      UPSTREAMS,
      () => ({ scheme: "api-key", value: "sk-ant-test" }),
      model,
    );

    const result = await client.prompt("system", "user", {
      sessionID: "sess-think-strip-fail",
      workerID: "lore-distill",
      model,
    });

    expect(result).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(2); // stripped once, still failed
    expect(bodyOf(1)).not.toHaveProperty("thinking"); // strip did happen
    // But the model is NOT learned — the retry never confirmed the cure.
    expect(isThinkingUnsupportedModel(model)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Worker empty-response retry on budget truncation (finish_reason: "length")
//
// REGRESSION: after PR #1407 made worker selection stay inside the session
// model's vendor lineage, an OpenRouter Claude session resolves its worker to
// a same-vendor REASONING model (e.g. anthropic/claude-sonnet-5). Routed over
// the OpenAI protocol, that model spends the entire max_completion_tokens
// budget on hidden reasoning and returns an EMPTY completion with
// finish_reason:"length" — previously miscounted as a no-response failure that
// degraded the whole session. The adapter now retries ONCE with the budget
// multiplied (clamped to the model's output limit).
// ---------------------------------------------------------------------------
describe("worker empty-response retry on budget truncation (finish_reason: length)", () => {
  const mockFetch = vi.mocked(upstreamFetch);
  const UPSTREAMS = {
    anthropic: "https://api.anthropic.com",
    openai: "https://api.openai.com",
    openrouter: "https://openrouter.ai/api",
  };

  beforeEach(() => {
    mockFetch.mockReset();
    _resetWorkerHealthForTest();
    vi.mocked(recordWorkerFailure).mockClear();
    vi.mocked(markWorkerPaused).mockClear();
    vi.mocked(markWorkerIncapable).mockClear();
    vi.mocked(markFreeModelsDataBlocked).mockClear();
    // A reasoning model with a large output limit so the retry ceiling is the
    // WORKER_LENGTH_RETRY_CAP (64000), not the model limit.
    _setModelDataForTest({
      "anthropic/claude-sonnet-5": {
        id: "anthropic/claude-sonnet-5",
        cost: { input: 3, output: 15 },
        limit: { context: 200_000, output: 64_000 },
      },
    });
  });
  afterEach(() => {
    mockFetch.mockReset();
    clearAllCosts();
    resetBackgroundLimiter();
    clearModelDataCache();
    _resetWorkerHealthForTest();
    vi.mocked(recordWorkerFailure).mockClear();
    vi.mocked(markWorkerPaused).mockClear();
    vi.mocked(markWorkerIncapable).mockClear();
    vi.mocked(markFreeModelsDataBlocked).mockClear();
  });

  function lengthTruncated() {
    return new Response(
      JSON.stringify({
        id: "gen-x",
        object: "chat.completion",
        model: "anthropic/claude-sonnet-5",
        choices: [
          {
            index: 0,
            finish_reason: "length",
            native_finish_reason: "max_tokens",
            message: { role: "assistant", content: "" },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 16384 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  function openAISuccess(text: string) {
    return new Response(
      JSON.stringify({
        id: "gen-ok",
        object: "chat.completion",
        model: "anthropic/claude-sonnet-5",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: text },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 42 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  function client() {
    return createGatewayLLMClient(
      UPSTREAMS,
      () => ({ scheme: "bearer", value: "sk-or-test" }),
      { providerID: "openrouter", modelID: "anthropic/claude-sonnet-5" },
    );
  }
  function bodyOf(callIndex: number): Record<string, unknown> | undefined {
    const raw = mockFetch.mock.calls[callIndex]?.[1]?.body;
    if (typeof raw !== "string") return undefined;
    return JSON.parse(raw) as Record<string, unknown>;
  }
  // OpenAI SSE stream that truncates on the output budget with EMPTY content —
  // the finish reason only survives on the accumulated stream (stopReason), not
  // in a JSON body. content-type is text/event-stream so looksLikeSSE trips.
  function lengthTruncatedSSE() {
    const body = [
      'data: {"id":"gen-sse","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}',
      "",
      'data: {"id":"gen-sse","choices":[{"index":0,"delta":{},"finish_reason":"length"}],"usage":{"prompt_tokens":100,"completion_tokens":16384}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }
  // JSON body whose ONLY truncation signal is the aggregator `native_finish_reason`
  // (OpenRouter shape): `finish_reason` is null, `native_finish_reason` is the
  // upstream `MAX_TOKENS` (note casing). extractFinishReason must read it.
  function lengthTruncatedNativeOnly() {
    return new Response(
      JSON.stringify({
        id: "gen-native",
        object: "chat.completion",
        model: "anthropic/claude-sonnet-5",
        choices: [
          {
            index: 0,
            finish_reason: null,
            native_finish_reason: "MAX_TOKENS",
            message: { role: "assistant", content: "" },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 16384 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  test("retries ONCE with a raised budget and recovers when the reasoning model then emits text", async () => {
    mockFetch
      .mockResolvedValueOnce(lengthTruncated())
      .mockResolvedValueOnce(openAISuccess("distilled summary"));

    const text = await client().prompt("system", "user", {
      sessionID: "sess-length-recover",
      workerID: "lore-distill",
      protocol: "openai",
      upstreamProviderID: "openrouter",
      upstreamUrl: "https://openrouter.ai/api",
    });

    // Mutation: remove the length-retry block → only 1 call, text is null,
    // recordWorkerFailure('no-response') fires → RED.
    expect(text).toBe("distilled summary");
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // First attempt floored to the reasoning budget (24576 for the reasoning
    // client model); the retry raised it (4× = 98304, clamped to the model's
    // 64000 output limit).
    expect(bodyOf(0)?.max_completion_tokens).toBe(24576);
    expect(bodyOf(1)?.max_completion_tokens).toBe(64000);

    // A successful retry is NOT a failure.
    expect(vi.mocked(recordWorkerFailure)).not.toHaveBeenCalled();
  });

  test("retries at most ONCE — a still-truncated retry falls through to no-response, not an infinite loop", async () => {
    mockFetch.mockImplementation(async () => lengthTruncated());

    const text = await client().prompt("system", "user", {
      sessionID: "sess-length-persist",
      workerID: "lore-distill",
      protocol: "openai",
      upstreamProviderID: "openrouter",
      upstreamUrl: "https://openrouter.ai/api",
    });

    expect(text).toBeNull();
    // Exactly one retry: original + one bumped attempt.
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(bodyOf(1)?.max_completion_tokens).toBe(64000);
    // A budget truncation is retryable, not a capability signal, so it is
    // recorded as no-response (never worker-incapable).
    expect(vi.mocked(recordWorkerFailure)).toHaveBeenCalledWith(
      "sess-length-persist",
      "lore-distill",
      "no-response",
    );
  });

  test("a normal empty completion with finish_reason:'stop' is NOT budget-retried (capability path unchanged)", async () => {
    const emptyStop = () =>
      new Response(
        JSON.stringify({
          id: "gen-empty",
          object: "chat.completion",
          model: "anthropic/claude-sonnet-5",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: { role: "assistant", content: "" },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 0 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    mockFetch.mockImplementation(async () => emptyStop());

    const text = await client().prompt("system", "user", {
      sessionID: "sess-empty-stop",
      workerID: "lore-distill",
      protocol: "openai",
      upstreamProviderID: "openrouter",
      upstreamUrl: "https://openrouter.ai/api",
    });

    expect(text).toBeNull();
    // No budget retry for a genuine 'stop' empty — single attempt.
    // Mutation: broaden isLengthTruncation to accept 'stop' → 2 calls → RED.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test("OpenAI worker builder pre-sizes max_completion_tokens with reasoning headroom when effort is set", async () => {
    // Builder-alignment half of the fix: the OpenAI-protocol worker request must
    // mirror the native Anthropic/Vertex builders and raise the output budget by
    // the reasoning token budget + headroom when reasoning is active, so a
    // reasoning model gets room for the answer AFTER thinking on the FIRST
    // attempt (not only via the length-retry). effort=high → thinking budget
    // 16384 + HEADROOM 8192 = 24576, above the DEFAULT_WORKER_MAX_TOKENS (16384)
    // raw budget.
    // Mutation: drop the effectiveMaxTokens headroom in buildOpenAIWorkerRequest
    // → first call sends the raw 16384 instead of 24576 → RED.
    mockFetch.mockResolvedValueOnce(openAISuccess("ok"));

    await client().prompt("system", "user", {
      sessionID: "sess-effort-headroom",
      workerID: "lore-distill",
      protocol: "openai",
      upstreamProviderID: "openrouter",
      upstreamUrl: "https://openrouter.ai/api",
      reasoningEffort: "high",
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(bodyOf(0)?.max_completion_tokens).toBe(24576);
    expect(bodyOf(0)?.reasoning_effort).toBe("high");
  });

  test("OpenAI worker builder applies the reasoning floor for a reasoning-on-by-default model even with NO effort and a small raw budget (regression: live truncation storm)", async () => {
    // The core regression: distillation/curation workers pass tiny raw budgets
    // (~1-8K) and NO reasoning effort, but OpenRouter routes reasoning models
    // (anthropic/claude-sonnet-5) that reason regardless — burning the whole
    // budget on hidden reasoning and returning empty finish_reason:"length".
    // The builder must floor the budget to DEFAULT_REASONING_MODEL_BUDGET (16384)
    // + THINKING_OUTPUT_HEADROOM (8192) = 24576 on the FIRST attempt, so the
    // answer survives without relying on the length-retry.
    // Mutation: drop the workerReasoningHeadroomFloor / workerModelReasons
    // branch → first call sends the raw 1035 → RED.
    mockFetch.mockResolvedValueOnce(openAISuccess("ok"));

    await client().prompt("system", "user", {
      sessionID: "sess-reasoning-floor",
      workerID: "lore-distill",
      protocol: "openai",
      upstreamProviderID: "openrouter",
      upstreamUrl: "https://openrouter.ai/api",
      maxTokens: 1035,
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(bodyOf(0)?.max_completion_tokens).toBe(24576);
    // No explicit effort → reasoning_effort must NOT be sent (the model reasons
    // on its own; we only give it room).
    expect(bodyOf(0)).not.toHaveProperty("reasoning_effort");
  });

  test("floor applies to an EFFORT-typed reasoning model with no toggle and no 'claude' id (regression: production curator truncation storm)", async () => {
    // The exact production regression that survived #1418: models.dev lists
    // OpenRouter's anthropic/claude-sonnet-5 with reasoning_options:[{effort}]
    // (NO toggle). workerThinkingOnByDefault returns false (toggle-only), so the
    // floor never applied and the curator's 2048 budget was burned on hidden
    // reasoning → empty finish_reason:"length". The floor must key off the
    // broader workerModelReasons (ANY reasoning_options), NOT the toggle-only
    // predicate. Uses a NON-"claude" id so the Claude fallback CANNOT mask the
    // bug — the ONLY signal is the effort-typed reasoning_options.
    // Mutation: revert the floor gate to workerThinkingOnByDefault → false for
    // this effort-only entry → first call sends raw 2048 → RED.
    _setModelDataForTest({
      "acme/reasoner-x": {
        id: "acme/reasoner-x",
        cost: { input: 1, output: 3 },
        limit: { context: 200_000, output: 64_000 },
        reasoning_options: [{ type: "effort" }],
      },
    });
    mockFetch.mockResolvedValueOnce(openAISuccess("ok"));

    await createGatewayLLMClient(
      UPSTREAMS,
      () => ({ scheme: "bearer", value: "sk-or-test" }),
      { providerID: "openrouter", modelID: "acme/reasoner-x" },
    ).prompt("system", "user", {
      sessionID: "sess-effort-typed-floor",
      workerID: "lore-curator",
      protocol: "openai",
      upstreamProviderID: "openrouter",
      upstreamUrl: "https://openrouter.ai/api",
      maxTokens: 2048,
    });

    expect(bodyOf(0)?.max_completion_tokens).toBe(24576);
    // Model reasons by default but we set no effort → do NOT force reasoning_effort.
    expect(bodyOf(0)).not.toHaveProperty("reasoning_effort");
  });

  test("OpenAI worker builder does NOT floor a NON-reasoning model with no effort (no wasted budget)", async () => {
    // A plain non-reasoning model keeps the caller's small raw budget — the floor
    // must not inflate it. Mutation: apply the floor unconditionally → 16384 → RED.
    _setModelDataForTest({
      "openai/gpt-4o-mini": {
        id: "openai/gpt-4o-mini",
        cost: { input: 1, output: 2 },
        limit: { context: 128_000, output: 16_384 },
        // no reasoning_options → not reasoning-on-by-default; id has no "claude".
      },
    });
    mockFetch.mockResolvedValueOnce(openAISuccess("ok"));

    await createGatewayLLMClient(
      UPSTREAMS,
      () => ({ scheme: "bearer", value: "sk-or-test" }),
      { providerID: "openrouter", modelID: "openai/gpt-4o-mini" },
    ).prompt("system", "user", {
      sessionID: "sess-nonreasoning",
      workerID: "lore-distill",
      protocol: "openai",
      upstreamProviderID: "openrouter",
      upstreamUrl: "https://openrouter.ai/api",
      maxTokens: 1035,
    });

    expect(bodyOf(0)?.max_completion_tokens).toBe(1035);
    expect(bodyOf(0)).not.toHaveProperty("reasoning_effort");
  });

  test("does NOT length-retry when the model's output limit is at or below the current budget (no shrink, no wasted call)", async () => {
    // Guards the retry's raise-check (`maxTokens < lengthRetryCeiling`).
    // A model whose output limit (8192) is below the default budget (16384) can
    // never be given MORE room — retrying would either shrink the budget or waste
    // a call. Uses a NON-reasoning, non-"claude" id so the reasoning floor is 0
    // and the ceiling clamp is the only thing preventing the retry.
    // Mutation: delete the `maxTokens < lengthRetryCeiling` guard → the retry
    // fires and rebuilds with a NON-larger budget (a shrink to min(16384*4,
    // 8192)=8192) → 2 calls → RED.
    _setModelDataForTest({
      "openai/mini-8k": {
        id: "openai/mini-8k",
        cost: { input: 1, output: 5 },
        limit: { context: 100_000, output: 8_192 },
      },
    });
    mockFetch.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            id: "gen-small",
            object: "chat.completion",
            model: "openai/mini-8k",
            choices: [
              {
                index: 0,
                finish_reason: "length",
                message: { role: "assistant", content: "" },
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 8192 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    const text = await createGatewayLLMClient(
      UPSTREAMS,
      () => ({ scheme: "bearer", value: "sk-or-test" }),
      { providerID: "openrouter", modelID: "openai/mini-8k" },
    ).prompt("system", "user", {
      sessionID: "sess-small-limit",
      workerID: "lore-distill",
      protocol: "openai",
      upstreamProviderID: "openrouter",
      upstreamUrl: "https://openrouter.ai/api",
    });

    expect(text).toBeNull();
    // Guard fired: single attempt, no retry.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test("length-retry is reachable for an SSE (streamed) truncation — stopReason from the accumulated stream (Seer #1413)", async () => {
    mockFetch
      .mockResolvedValueOnce(lengthTruncatedSSE())
      .mockResolvedValueOnce(openAISuccess("streamed then recovered"));

    const text = await client().prompt("system", "user", {
      sessionID: "sess-sse-length",
      workerID: "lore-distill",
      protocol: "openai",
      upstreamProviderID: "openrouter",
      upstreamUrl: "https://openrouter.ai/api",
    });

    // For SSE, rawData is `{}`; the retry is only reachable via the accumulated
    // GatewayResponse.stopReason (length → max_tokens). Mutation: use
    // extractFinishReason(rawData) instead of sseStopReason → no retry, null,
    // no-response recorded → RED.
    expect(text).toBe("streamed then recovered");
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(bodyOf(1)?.max_completion_tokens).toBe(64000);
  });

  test("length-retry fires when the ONLY truncation signal is native_finish_reason (Seer #1413)", async () => {
    mockFetch
      .mockResolvedValueOnce(lengthTruncatedNativeOnly())
      .mockResolvedValueOnce(openAISuccess("recovered via native reason"));

    const text = await client().prompt("system", "user", {
      sessionID: "sess-native-length",
      workerID: "lore-distill",
      protocol: "openai",
      upstreamProviderID: "openrouter",
      upstreamUrl: "https://openrouter.ai/api",
    });

    // finish_reason is null; the truncation is only in native_finish_reason
    // ("MAX_TOKENS"). Mutation: drop the native_finish_reason read in
    // extractFinishReason, or drop the toLowerCase in isLengthTruncation → no
    // retry → RED.
    expect(text).toBe("recovered via native reason");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test("length-retry multiplies from the FLOORED effective budget, not the tiny raw budget", async () => {
    // A reasoning-on-by-default model truncates on a tiny raw budget (1035). The
    // loop floors it to the reasoning floor (24576) BEFORE the first attempt, so
    // the retry multiplies from 24576 (→ min(24576*4, ceiling 64000) = 64000),
    // NOT from 1035 (which would give a useless 4140).
    // Mutation: remove the reasoningFloor from the loop `maxTokens` init →
    // first attempt sends 1035, retry sends 4140 → bodyOf assertions RED.
    mockFetch
      .mockResolvedValueOnce(lengthTruncated())
      .mockResolvedValueOnce(openAISuccess("recovered at floor"));

    const text = await client().prompt("system", "user", {
      sessionID: "sess-retry-floor",
      workerID: "lore-distill",
      protocol: "openai",
      upstreamProviderID: "openrouter",
      upstreamUrl: "https://openrouter.ai/api",
      maxTokens: 1035,
    });

    expect(text).toBe("recovered at floor");
    expect(mockFetch).toHaveBeenCalledTimes(2);
    // First attempt floored to 24576; retry multiplied from that → 64000.
    expect(bodyOf(0)?.max_completion_tokens).toBe(24576);
    expect(bodyOf(1)?.max_completion_tokens).toBe(64000);
  });

  test("does NOT apply the reasoning floor on the ANTHROPIC protocol (thinking is suppressed there, not budgeted)", async () => {
    // Protocol-gate guard. A reasoning-on-by-default Claude model on the native
    // Anthropic protocol must NOT get the loop floor: that path sends
    // `thinking:{type:"disabled"}` (effectiveDisableThinking) so it never burns
    // the budget on reasoning. The floor is for protocols with NO suppression
    // lever (openai, gemini). The worker must send the raw small budget as-is.
    // Mutation: drop the `target.protocol === "openai" || "gemini"` gate → the
    // floor inflates max_tokens to 16384 → RED.
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: "ok" }],
          model: "claude-sonnet-5",
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const text = await createGatewayLLMClient(
      UPSTREAMS,
      () => ({ scheme: "api-key", value: "sk-ant-test" }),
      { providerID: "anthropic", modelID: "claude-sonnet-5" },
    ).prompt("system", "user", {
      sessionID: "sess-anthropic-nofloor",
      workerID: "lore-distill",
      protocol: "anthropic",
      maxTokens: 1035,
    });

    expect(text).toBe("ok");
    // Anthropic path: raw budget passed through unchanged (no reasoning floor).
    expect(bodyOf(0)?.max_tokens).toBe(1035);
  });

  test("applies the reasoning floor on the native GEMINI protocol (no thinking-disable lever there either)", async () => {
    // Gemini 2.5 reasons by default and counts thinking against
    // `maxOutputTokens`, and the native Gemini worker builder has no
    // thinking-disable lever — so it needs the same floor as the OpenAI path.
    // Mutation: drop `|| target.protocol === "gemini"` from the gate → the raw
    // 1035 is sent as maxOutputTokens → RED.
    _setModelDataForTest({
      "gemini-2.5-flash": {
        id: "gemini-2.5-flash",
        cost: { input: 1, output: 3 },
        limit: { context: 1_000_000, output: 64_000 },
        reasoning_options: [{ type: "toggle" }],
      },
    });
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "ok" }] } }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
          modelVersion: "gemini-2.5-flash",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const text = await createGatewayLLMClient(
      UPSTREAMS,
      () => ({ scheme: "api-key", value: "goog-key" }),
      { providerID: "google", modelID: "gemini-2.5-flash" },
    ).prompt("system", "user", {
      sessionID: "sess-gemini-floor",
      workerID: "lore-distill",
      protocol: "gemini",
      upstreamProviderID: "google",
      upstreamUrl: "https://generativelanguage.googleapis.com",
      maxTokens: 1035,
    });

    expect(text).toBe("ok");
    // Gemini path: floored to the reasoning budget (16384 + 8192 = 24576).
    expect(
      (bodyOf(0)?.generationConfig as { maxOutputTokens?: number } | undefined)
        ?.maxOutputTokens,
    ).toBe(24576);
  });
});

describe("isModelUnsupported400 detector", () => {
  test("true for Copilot model_not_supported / unsupported_api_for_model", () => {
    expect(
      isModelUnsupported400(
        400,
        JSON.stringify({
          error: {
            message: "The requested model is not supported.",
            code: "model_not_supported",
          },
        }),
      ),
    ).toBe(true);
    expect(
      isModelUnsupported400(
        400,
        JSON.stringify({ error: { code: "unsupported_api_for_model" } }),
      ),
    ).toBe(true);
  });

  test("true for prose 'model X is not available/found/does not exist'", () => {
    expect(
      isModelUnsupported400(400, "The model gpt-5-mini is not available"),
    ).toBe(true);
    expect(isModelUnsupported400(400, "model not found")).toBe(true);
    expect(
      isModelUnsupported400(400, "That model does not exist for this account"),
    ).toBe(true);
  });

  test("false for a generic 400 (bad param / quota) — must not swap the model", () => {
    expect(isModelUnsupported400(400, "temperature is not supported")).toBe(
      false,
    );
    expect(isModelUnsupported400(400, "invalid request: bad max_tokens")).toBe(
      false,
    );
  });

  test("false for non-400 statuses", () => {
    expect(
      isModelUnsupported400(404, JSON.stringify({ code: "model_not_found" })),
    ).toBe(false);
    expect(
      isModelUnsupported400(
        429,
        JSON.stringify({ code: "model_not_supported" }),
      ),
    ).toBe(false);
  });
});

describe("workerModelCandidates", () => {
  test("github-copilot: preferred first, then same-provider backups (deduped)", () => {
    const out = workerModelCandidates({
      providerID: "github-copilot",
      modelID: "gpt-5-mini",
    });
    expect(out[0]).toEqual({
      providerID: "github-copilot",
      modelID: "gpt-5-mini",
    });
    const ids = out.map((c) => c.modelID);
    // Preferred appears exactly once (dedup), and Claude backups are present.
    expect(ids.filter((m) => m === "gpt-5-mini")).toHaveLength(1);
    expect(ids).toContain("claude-sonnet-4.6");
    // Every candidate stays on the same provider — a worker must never switch.
    expect(out.every((c) => c.providerID === "github-copilot")).toBe(true);
  });

  test("a non-preferred copilot model still yields the full provider backup set", () => {
    const ids = workerModelCandidates({
      providerID: "github-copilot",
      modelID: "gpt-4o-mini",
    }).map((c) => c.modelID);
    expect(ids[0]).toBe("gpt-4o-mini");
    expect(ids).toContain("gpt-5-mini");
    expect(ids).toContain("claude-sonnet-4.6");
    expect(ids.filter((m) => m === "gpt-4o-mini")).toHaveLength(1);
  });

  test("a provider with no fallback list → just the preferred model", () => {
    expect(
      workerModelCandidates({
        providerID: "anthropic",
        modelID: "claude-sonnet-5",
      }),
    ).toEqual([{ providerID: "anthropic", modelID: "claude-sonnet-5" }]);
  });
});

describe("worker 400 model-not-supported: fall back to a same-provider backup", () => {
  const mockFetch = vi.mocked(upstreamFetch);
  const mockMarkIncapable = vi.mocked(markWorkerIncapable);
  const mockMarkPaused = vi.mocked(markWorkerPaused);

  const UNSUPPORTED_400 = JSON.stringify({
    error: {
      message: 'The requested model "gpt-5-mini" is not supported.',
      code: "model_not_supported",
    },
  });
  const OK_200 = JSON.stringify({
    choices: [{ message: { content: "worked on the backup" } }],
    usage: { prompt_tokens: 5, completion_tokens: 3 },
  });

  beforeEach(() => {
    mockMarkIncapable.mockClear();
    mockMarkPaused.mockClear();
    _resetWorkerHealthForTest();
  });
  afterEach(() => {
    mockFetch.mockReset();
    _resetWorkerHealthForTest();
  });

  test("preferred model 400s model_not_supported → blocklist it, retry with the next candidate, succeed", async () => {
    let call = 0;
    mockFetch.mockImplementation(async () => {
      call++;
      return call === 1
        ? new Response(UNSUPPORTED_400, {
            status: 400,
            statusText: "Bad Request",
          })
        : new Response(OK_200, {
            status: 200,
            headers: { "content-type": "application/json" },
          });
    });

    const client = createGatewayLLMClient(
      {
        anthropic: "https://api.githubcopilot.com",
        openai: "https://api.githubcopilot.com",
      },
      () => ({ scheme: "bearer", value: "gho_test" }),
      { providerID: "github-copilot", modelID: "gpt-5-mini" },
    );

    const text = await client.prompt("system", "user", {
      workerID: "lore-import",
      sessionID: "sess-fallback",
      protocol: "openai",
      upstreamProviderID: "github-copilot",
      upstreamUrl: "https://api.githubcopilot.com",
    });

    // Recovered on the backup model.
    expect(text).toBe("worked on the backup");
    expect(mockFetch).toHaveBeenCalledTimes(2);
    // The preferred model was blocklisted for this worker kind.
    expect(mockMarkIncapable).toHaveBeenCalledWith(
      "github-copilot",
      "gpt-5-mini",
    );
    // Second request used a DIFFERENT (backup) model id.
    const [, secondInit] = mockFetch.mock.calls[1];
    const secondBody = JSON.parse(secondInit?.body as string) as {
      model?: string;
    };
    expect(secondBody.model).toBeDefined();
    expect(secondBody.model).not.toBe("gpt-5-mini");
    // Not a session credit-pause — the fix is a model swap, not a pause.
    expect(mockMarkPaused).not.toHaveBeenCalled();
  });

  test("a provider with NO backup list surfaces the 400 (no swap, one call)", async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { message: "model not found", code: "model_not_supported" },
        }),
        { status: 400, statusText: "Bad Request" },
      ),
    );

    const client = createGatewayLLMClient(
      {
        anthropic: "https://api.anthropic.com",
        openai: "https://api.openai.com",
      },
      () => ({ scheme: "api-key", value: "sk-ant-test" }),
      { providerID: "anthropic", modelID: "claude-sonnet-5" },
    );

    const text = await client.prompt("system", "user", {
      workerID: "lore-import",
      sessionID: "sess-nobackup",
    });

    expect(text).toBeNull();
    // No backup to try → exactly one attempt, no model blocklisted via this path.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockMarkIncapable).not.toHaveBeenCalled();
  });

  test("after one chunk blocklists the preferred model, the NEXT call starts directly on the backup (no repeated 400)", async () => {
    // Call 1: preferred 400s, backup 200s (blocklists preferred).
    // Call 2: the top-of-prompt candidate advance must skip the now-incapable
    // preferred and go straight to the backup — otherwise every later chunk
    // would either re-400 or be skipped outright.
    let call = 0;
    mockFetch.mockImplementation(async (_url, init) => {
      call++;
      const body = JSON.parse(init?.body as string) as { model?: string };
      // Only the preferred model 400s; any backup succeeds.
      return body.model === "gpt-5-mini"
        ? new Response(UNSUPPORTED_400, {
            status: 400,
            statusText: "Bad Request",
          })
        : new Response(OK_200, {
            status: 200,
            headers: { "content-type": "application/json" },
          });
    });

    const client = createGatewayLLMClient(
      {
        anthropic: "https://api.githubcopilot.com",
        openai: "https://api.githubcopilot.com",
      },
      () => ({ scheme: "bearer", value: "gho_test" }),
      { providerID: "github-copilot", modelID: "gpt-5-mini" },
    );

    const opts = {
      workerID: "lore-import",
      sessionID: "sess-advance",
      protocol: "openai" as const,
      upstreamProviderID: "github-copilot",
      upstreamUrl: "https://api.githubcopilot.com",
    };

    const first = await client.prompt("system", "user", opts);
    expect(first).toBe("worked on the backup");
    const callsAfterFirst = call; // 2 (preferred 400 + backup 200)
    expect(callsAfterFirst).toBe(2);

    const second = await client.prompt("system", "user", opts);
    expect(second).toBe("worked on the backup");
    // The second call made exactly ONE fetch — it started on the backup and
    // never re-tried the blocklisted preferred model.
    expect(call - callsAfterFirst).toBe(1);
    const [, secondCallInit] = mockFetch.mock.calls[2];
    const secondCallBody = JSON.parse(secondCallInit?.body as string) as {
      model?: string;
    };
    expect(secondCallBody.model).not.toBe("gpt-5-mini");
  });

  test("a model swap does NOT consume the transient-error retry budget", async () => {
    // Seer #15455762: a model fallback must not spend the `maxRetries` budget
    // meant for 429/5xx. With maxRetries=1: preferred 400s (swap), then the
    // BACKUP hits one transient 429 before 200. If the swap consumed the single
    // retry, the 429 would exhaust the budget and the call would fail. It must
    // succeed — the backup keeps its full transient allowance.
    const prev = process.env.LORE_MAX_RETRIES;
    process.env.LORE_MAX_RETRIES = "1";
    resetBackgroundLimiter();
    try {
      let call = 0;
      mockFetch.mockImplementation(async (_url, init) => {
        call++;
        const body = JSON.parse(init?.body as string) as { model?: string };
        if (body.model === "gpt-5-mini") {
          // Preferred → model_not_supported (triggers the swap).
          return new Response(UNSUPPORTED_400, {
            status: 400,
            statusText: "Bad Request",
          });
        }
        // Backup: one transient 429 (retry-after 0 → instant), then success.
        if (call === 2) {
          return new Response(
            JSON.stringify({ error: { message: "rate limited" } }),
            { status: 429, headers: { "retry-after": "0" } },
          );
        }
        return new Response(OK_200, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });

      const client = createGatewayLLMClient(
        {
          anthropic: "https://api.githubcopilot.com",
          openai: "https://api.githubcopilot.com",
        },
        () => ({ scheme: "bearer", value: "gho_test" }),
        { providerID: "github-copilot", modelID: "gpt-5-mini" },
      );

      const text = await client.prompt("system", "user", {
        workerID: "lore-import",
        sessionID: "sess-budget",
        protocol: "openai",
        upstreamProviderID: "github-copilot",
        upstreamUrl: "https://api.githubcopilot.com",
      });

      // preferred 400 (swap) → backup 429 (transient retry) → backup 200.
      expect(text).toBe("worked on the backup");
      expect(call).toBe(3);
    } finally {
      if (prev === undefined) delete process.env.LORE_MAX_RETRIES;
      else process.env.LORE_MAX_RETRIES = prev;
    }
  });
});
