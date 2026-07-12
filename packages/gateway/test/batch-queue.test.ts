/**
 * Tests for the batch queue (BatchLLMClient wrapper).
 *
 * Uses a fake inner LLMClient and fake fetch to verify:
 *  - Urgent calls bypass the queue
 *  - Non-urgent calls are queued and flushed
 *  - Batch results are polled and promises resolved
 *  - Fallback to synchronous on batch API errors
 *  - Shutdown drains the queue
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createBatchLLMClient,
  extractAnthropicError,
} from "../src/batch-queue";

// Bridge: upstreamFetch now uses undici's own fetch (not globalThis.fetch),
// so tests that mock globalThis.fetch need this shim to intercept calls.
vi.mock("../src/fetch", () => ({
  upstreamFetch: (...args: Parameters<typeof fetch>) =>
    globalThis.fetch(...args),
}));
import type { LLMClient } from "@loreai/core";
import type { AuthCredential } from "../src/auth";
import {
  _resetTemperatureUnsupportedModels,
  isTemperatureUnsupportedModel,
  markTemperatureUnsupported,
} from "../src/llm-adapter";
import { _setModelDataForTest, clearModelDataCache } from "../src/worker-model";

const TEST_AUTH: AuthCredential = { scheme: "api-key", value: "test-key" };
const getTestAuth = () => TEST_AUTH;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a mock LLMClient that records calls and returns canned responses. */
function createMockLLMClient(): LLMClient & {
  calls: Array<{ system: string; user: string; opts: unknown }>;
} {
  const calls: Array<{ system: string; user: string; opts: unknown }> = [];
  return {
    calls,
    async prompt(system, user, opts) {
      calls.push({ system, user, opts });
      return `sync-response-for: ${user.slice(0, 30)}`;
    },
  };
}

/** Shape of the batch create request body for typed assertions. */
interface BatchCreateBody {
  requests: Array<{
    custom_id: string;
    params: {
      model: string;
      max_tokens: number;
      temperature?: number;
      system: string | Array<{ type: string; text: string }>;
      messages: Array<{ role: string; content: string }>;
    };
  }>;
}

/** Track fetch calls for assertions. */
let fetchCalls: Array<{ url: string; method: string; body?: BatchCreateBody }> =
  [];
let fetchResponses: Array<{ ok: boolean; status: number; body: unknown }> = [];

function pushFetchResponse(ok: boolean, status: number, body: unknown) {
  fetchResponses.push({ ok, status, body });
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  fetchCalls = [];
  fetchResponses = [];

  // @ts-expect-error — mock global fetch
  globalThis.fetch = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    // FormData bodies (OpenAI file uploads) can't be JSON-parsed
    const body =
      init?.body && typeof init.body === "string"
        ? JSON.parse(init.body)
        : undefined;
    fetchCalls.push({ url: url.toString(), method, body });

    const response = fetchResponses.shift();
    if (!response) {
      return {
        ok: false,
        status: 500,
        text: async () => "no mock response",
        json: async () => ({}),
      };
    }
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.ok ? "OK" : "Error",
      text: async () => JSON.stringify(response.body),
      json: async () => response.body,
    };
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const DEFAULT_MODEL = {
  providerID: "anthropic",
  modelID: "claude-sonnet-4-20250514",
};
const UPSTREAMS = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BatchLLMClient", () => {
  test("urgent calls bypass the queue and delegate to inner client", async () => {
    const inner = createMockLLMClient();
    const client = createBatchLLMClient(
      inner,
      UPSTREAMS,
      getTestAuth,
      DEFAULT_MODEL,
      {
        flushIntervalMs: 60_000, // Long interval so flush doesn't auto-trigger
      },
    );

    const result = await client.prompt("system", "urgent message", {
      workerID: "lore-distill",
      urgent: true,
    });

    expect(result).toBe("sync-response-for: urgent message");
    expect(inner.calls).toHaveLength(1);
    expect(inner.calls[0].user).toBe("urgent message");

    const s = client.stats();
    expect(s.totalUrgent).toBe(1);
    expect(s.totalQueued).toBe(0);
    expect(s.queued).toBe(0);

    await client.shutdown();
  });

  test("bearer-token (OAuth) calls bypass the queue and delegate to inner client", async () => {
    const inner = createMockLLMClient();
    const bearerAuth: AuthCredential = {
      scheme: "bearer",
      value: "sk-ant-oat-test-token",
    };
    const getBearerAuth = () => bearerAuth;

    const client = createBatchLLMClient(
      inner,
      UPSTREAMS,
      getBearerAuth,
      DEFAULT_MODEL,
      {
        flushIntervalMs: 60_000,
      },
    );

    const result = await client.prompt("system", "oauth worker call", {
      workerID: "lore-distill",
      sessionID: "oauth-session",
    });

    // Should process synchronously via inner client, not queue
    expect(result).toBe("sync-response-for: oauth worker call");
    expect(inner.calls).toHaveLength(1);
    expect(inner.calls[0].user).toBe("oauth worker call");

    const s = client.stats();
    expect(s.totalFallback).toBe(1); // Counted as fallback, not urgent or queued
    expect(s.totalQueued).toBe(0);
    expect(s.totalUrgent).toBe(0);
    expect(s.queued).toBe(0);

    await client.shutdown();
  });

  test("api-key calls are still queued normally (not affected by bearer bypass)", async () => {
    const inner = createMockLLMClient();
    const client = createBatchLLMClient(
      inner,
      UPSTREAMS,
      getTestAuth,
      DEFAULT_MODEL,
      {
        flushIntervalMs: 60_000,
        maxQueueSize: 100,
      },
    );

    // Don't await — should be queued
    const _promise = client.prompt("system", "api-key background work", {
      workerID: "lore-distill",
    });

    // Should be queued, not sent to inner yet
    expect(inner.calls).toHaveLength(0);
    const s = client.stats();
    expect(s.totalQueued).toBe(1);
    expect(s.queued).toBe(1);

    await client.shutdown();
  });

  test("non-urgent calls are queued (not immediately sent to inner)", async () => {
    const inner = createMockLLMClient();
    const client = createBatchLLMClient(
      inner,
      UPSTREAMS,
      getTestAuth,
      DEFAULT_MODEL,
      {
        flushIntervalMs: 60_000,
        maxQueueSize: 100,
      },
    );

    // Don't await — the promise is pending until batch resolves
    const promise = client.prompt("system", "background work", {
      workerID: "lore-distill",
    });

    // Inner client should NOT have been called yet
    expect(inner.calls).toHaveLength(0);

    const s = client.stats();
    expect(s.queued).toBe(1);
    expect(s.totalQueued).toBe(1);

    // Shutdown will fallback to synchronous
    await client.shutdown();

    // Now the promise should resolve (via fallback)
    const result = await promise;
    expect(result).toBe("sync-response-for: background work");
    expect(inner.calls).toHaveLength(1);
  });

  test("auto-flush when queue reaches maxQueueSize", async () => {
    const inner = createMockLLMClient();

    // Set up batch create response
    pushFetchResponse(true, 200, {
      id: "msgbatch_test1",
      processing_status: "in_progress",
    });

    const client = createBatchLLMClient(
      inner,
      UPSTREAMS,
      getTestAuth,
      DEFAULT_MODEL,
      {
        flushIntervalMs: 60_000,
        maxQueueSize: 3,
        pollIntervalMs: 60_000,
      },
    );

    // Queue 3 items — should auto-flush on the 3rd
    const _p1 = client.prompt("sys", "msg1", { workerID: "lore-distill" });
    const _p2 = client.prompt("sys", "msg2", { workerID: "lore-distill" });
    const _p3 = client.prompt("sys", "msg3", { workerID: "lore-distill" });

    // Wait a tick for the flush to complete
    await new Promise((r) => setTimeout(r, 50));

    // Should have called the batch API
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe(
      `${UPSTREAMS.anthropic}/v1/messages/batches`,
    );
    expect(fetchCalls[0]?.method).toBe("POST");
    expect(fetchCalls[0]?.body?.requests).toHaveLength(3);

    const s = client.stats();
    expect(s.totalBatched).toBe(3);
    expect(s.inflightBatches).toBe(1);

    // Clean up — shutdown resolves remaining promises with null
    await client.shutdown();
  });

  test("fallback to synchronous when batch API returns error", async () => {
    const inner = createMockLLMClient();

    // Set up batch create to fail
    pushFetchResponse(false, 500, { error: "internal server error" });

    const client = createBatchLLMClient(
      inner,
      UPSTREAMS,
      getTestAuth,
      DEFAULT_MODEL,
      {
        flushIntervalMs: 60_000,
        maxQueueSize: 2,
      },
    );

    const p1 = client.prompt("sys", "msg1", { workerID: "lore-distill" });
    const p2 = client.prompt("sys", "msg2", { workerID: "lore-distill" });

    // Wait for auto-flush + fallback
    await new Promise((r) => setTimeout(r, 100));

    const r1 = await p1;
    const r2 = await p2;

    expect(r1).toBe("sync-response-for: msg1");
    expect(r2).toBe("sync-response-for: msg2");

    // Inner should have been called for both (fallback)
    expect(inner.calls).toHaveLength(2);

    const s = client.stats();
    expect(s.totalFallback).toBe(2);

    await client.shutdown();
  });

  test("fallback to synchronous when no API key", async () => {
    const inner = createMockLLMClient();

    const client = createBatchLLMClient(
      inner,
      UPSTREAMS,
      () => null,
      DEFAULT_MODEL,
      {
        flushIntervalMs: 60_000,
        maxQueueSize: 1,
      },
    );

    const p1 = client.prompt("sys", "msg1", { workerID: "lore-distill" });

    // Wait for flush + fallback
    await new Promise((r) => setTimeout(r, 100));

    const result = await p1;
    expect(result).toBe("sync-response-for: msg1");
    expect(inner.calls).toHaveLength(1);

    await client.shutdown();
  });

  test("shutdown drains queue synchronously via inner client", async () => {
    const inner = createMockLLMClient();
    const client = createBatchLLMClient(
      inner,
      UPSTREAMS,
      getTestAuth,
      DEFAULT_MODEL,
      {
        flushIntervalMs: 60_000,
        maxQueueSize: 100,
      },
    );

    const p1 = client.prompt("sys", "msg1", { workerID: "lore-distill" });
    const p2 = client.prompt("sys", "msg2", { workerID: "lore-curator" });

    // Shutdown should drain via fallback
    await client.shutdown();

    expect(await p1).toBe("sync-response-for: msg1");
    expect(await p2).toBe("sync-response-for: msg2");
    expect(inner.calls).toHaveLength(2);

    const s = client.stats();
    expect(s.totalFallback).toBe(2);
  });

  test("shutdown({ drainQueue: false }) drops queued items without calling inner (fast process exit)", async () => {
    const inner = createMockLLMClient();
    const client = createBatchLLMClient(
      inner,
      UPSTREAMS,
      getTestAuth,
      DEFAULT_MODEL,
      {
        flushIntervalMs: 60_000,
        maxQueueSize: 100,
      },
    );

    const p1 = client.prompt("sys", "msg1", { workerID: "lore-distill" });
    const p2 = client.prompt("sys", "msg2", { workerID: "lore-curator" });
    expect(client.stats().queued).toBe(2);

    // Fast exit: queued background prompts must NOT be replayed as live LLM
    // calls (that retry/backoff path is what made Ctrl+C hang for minutes).
    await client.shutdown({ drainQueue: false });

    // Promises resolve with null; inner client never touched.
    expect(await p1).toBeNull();
    expect(await p2).toBeNull();
    expect(inner.calls).toHaveLength(0);

    const s = client.stats();
    expect(s.totalFallback).toBe(0);
    expect(s.queued).toBe(0);
  });

  test("after shutdown, new calls go directly to inner client", async () => {
    const inner = createMockLLMClient();
    const client = createBatchLLMClient(
      inner,
      UPSTREAMS,
      getTestAuth,
      DEFAULT_MODEL,
      {
        flushIntervalMs: 60_000,
      },
    );

    await client.shutdown();

    // New call after shutdown should go through inner immediately (treated as urgent)
    const result = await client.prompt("sys", "post-shutdown", {
      workerID: "lore-distill",
    });

    expect(result).toBe("sync-response-for: post-shutdown");
    expect(inner.calls).toHaveLength(1);
  });

  test("stats reflect accurate counts", async () => {
    const inner = createMockLLMClient();
    const client = createBatchLLMClient(
      inner,
      UPSTREAMS,
      getTestAuth,
      DEFAULT_MODEL,
      {
        flushIntervalMs: 60_000,
        maxQueueSize: 100,
      },
    );

    // 2 urgent, 3 queued
    await client.prompt("sys", "urgent1", { urgent: true });
    await client.prompt("sys", "urgent2", { urgent: true });
    const _p1 = client.prompt("sys", "bg1", {});
    const _p2 = client.prompt("sys", "bg2", {});
    const _p3 = client.prompt("sys", "bg3", {});

    let s = client.stats();
    expect(s.totalUrgent).toBe(2);
    expect(s.totalQueued).toBe(3);
    expect(s.queued).toBe(3);
    expect(s.inflightBatches).toBe(0);

    await client.shutdown();

    s = client.stats();
    expect(s.totalFallback).toBe(3);
    expect(s.queued).toBe(0);
  });

  test("default model is used when no explicit model in opts", async () => {
    const inner = createMockLLMClient();

    // Set up batch create response
    pushFetchResponse(true, 200, {
      id: "msgbatch_model_test",
      processing_status: "in_progress",
    });

    const client = createBatchLLMClient(
      inner,
      UPSTREAMS,
      getTestAuth,
      DEFAULT_MODEL,
      {
        flushIntervalMs: 60_000,
        maxQueueSize: 1,
      },
    );

    void client.prompt("sys prompt", "user msg", { workerID: "lore-distill" });

    // Wait for auto-flush
    await new Promise((r) => setTimeout(r, 50));

    // Verify the batch request uses the default model
    expect(fetchCalls).toHaveLength(1);
    const body = fetchCalls[0]?.body;
    if (!body) throw new Error("expected fetch body");
    const req0 = body.requests[0];
    if (!req0) throw new Error("expected batch request");
    expect(req0.params.model).toBe("claude-sonnet-4-20250514");
    const sys = req0.params.system as Array<{ type: string; text: string }>;
    expect(sys[0]?.text).toBe("sys prompt");
    expect(req0.params.messages[0]?.content).toBe("user msg");

    await client.shutdown();
  });

  test("explicit model override is used in batch request", async () => {
    const inner = createMockLLMClient();

    pushFetchResponse(true, 200, {
      id: "msgbatch_override",
      processing_status: "in_progress",
    });

    const client = createBatchLLMClient(
      inner,
      UPSTREAMS,
      getTestAuth,
      DEFAULT_MODEL,
      {
        flushIntervalMs: 60_000,
        maxQueueSize: 1,
      },
    );

    void client.prompt("sys", "msg", {
      model: { providerID: "anthropic", modelID: "claude-haiku-3-5-20241022" },
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(fetchCalls[0]?.body?.requests[0]?.params.model).toBe(
      "claude-haiku-3-5-20241022",
    );

    await client.shutdown();
  });

  // -------------------------------------------------------------------------
  // OpenAI batch queue tests
  // -------------------------------------------------------------------------

  test("OpenAI items are grouped separately from Anthropic items", async () => {
    const inner = createMockLLMClient();

    // Response for Anthropic batch submit
    pushFetchResponse(true, 200, {
      id: "msgbatch_anthropic",
      processing_status: "in_progress",
    });
    // Response for OpenAI file upload
    pushFetchResponse(true, 200, { id: "file-abc123" });
    // Response for OpenAI batch create
    pushFetchResponse(true, 200, { id: "batch_openai1" });

    const client = createBatchLLMClient(
      inner,
      UPSTREAMS,
      getTestAuth,
      DEFAULT_MODEL,
      {
        flushIntervalMs: 60_000,
        maxQueueSize: 2,
      },
    );

    // Queue one Anthropic item
    void client.prompt("sys", "anthropic-msg", {
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" },
    });
    // Queue one OpenAI item — triggers auto-flush at maxQueueSize=2
    void client.prompt("sys", "openai-msg", {
      model: { providerID: "openai", modelID: "gpt-5.4-mini" },
    });

    // Wait for flush
    await new Promise((r) => setTimeout(r, 100));

    // Should have 3 fetch calls: Anthropic batch, OpenAI file upload, OpenAI batch create
    expect(fetchCalls).toHaveLength(3);

    // First call: Anthropic batch submission
    expect(fetchCalls[0]?.url).toBe(
      `${UPSTREAMS.anthropic}/v1/messages/batches`,
    );
    expect(fetchCalls[0]?.method).toBe("POST");

    // Second call: OpenAI file upload (FormData — body won't be JSON-parsed)
    expect(fetchCalls[1]?.url).toBe(`${UPSTREAMS.openai}/v1/files`);
    expect(fetchCalls[1]?.method).toBe("POST");

    // Third call: OpenAI batch creation
    expect(fetchCalls[2]?.url).toBe(`${UPSTREAMS.openai}/v1/batches`);
    expect(fetchCalls[2]?.method).toBe("POST");

    const s = client.stats();
    expect(s.totalBatched).toBe(2);
    expect(s.inflightBatches).toBe(2);

    await client.shutdown();
  });

  test("OpenAI batch failure falls back to inner client", async () => {
    const inner = createMockLLMClient();

    // OpenAI file upload fails
    pushFetchResponse(false, 500, { error: "internal server error" });

    const client = createBatchLLMClient(
      inner,
      UPSTREAMS,
      getTestAuth,
      DEFAULT_MODEL,
      {
        flushIntervalMs: 60_000,
        maxQueueSize: 1,
      },
    );

    const p1 = client.prompt("sys", "openai-msg", {
      model: { providerID: "openai", modelID: "gpt-5.4-mini" },
      workerID: "lore-distill",
    });

    // Wait for flush + fallback
    await new Promise((r) => setTimeout(r, 100));

    const result = await p1;
    expect(result).toBe("sync-response-for: openai-msg");
    expect(inner.calls).toHaveLength(1);

    const s = client.stats();
    expect(s.totalFallback).toBe(1);

    await client.shutdown();
  });

  test("OpenAI batch lifecycle: upload → create → poll → results", async () => {
    const inner = createMockLLMClient();

    // Use a custom fetch mock to control the entire lifecycle in order
    let capturedCustomId = "";
    const prevFetch = globalThis.fetch;
    let callIndex = 0;

    // @ts-expect-error — mock fetch
    globalThis.fetch = async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const idx = callIndex++;

      // 0: File upload
      if (idx === 0) {
        expect(String(url)).toContain("/v1/files");
        // Extract custom_id from the JSONL for later
        if (init?.body instanceof FormData) {
          const file = init.body.get("file") as Blob;
          const text = await file.text();
          const parsed = JSON.parse(text);
          capturedCustomId = parsed.custom_id;
        }
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => JSON.stringify({ id: "file-batch123" }),
          json: async () => ({ id: "file-batch123" }),
        };
      }

      // 1: Batch create
      if (idx === 1) {
        expect(String(url)).toContain("/v1/batches");
        expect(method).toBe("POST");
        const body = JSON.parse(init?.body as string);
        expect(body.input_file_id).toBe("file-batch123");
        expect(body.endpoint).toBe("/v1/chat/completions");
        expect(body.completion_window).toBe("24h");
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => JSON.stringify({ id: "batch_lifecycle" }),
          json: async () => ({ id: "batch_lifecycle" }),
        };
      }

      // 2: Poll — return completed
      if (idx === 2) {
        expect(String(url)).toContain("/v1/batches/batch_lifecycle");
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () =>
            JSON.stringify({
              status: "completed",
              output_file_id: "file-results",
            }),
          json: async () => ({
            status: "completed",
            output_file_id: "file-results",
          }),
        };
      }

      // 3: Download results
      if (idx === 3) {
        expect(String(url)).toContain("/v1/files/file-results/content");
        const resultsJsonl = JSON.stringify({
          custom_id: capturedCustomId,
          response: {
            status_code: 200,
            body: {
              choices: [{ message: { content: "OpenAI batch result" } }],
              model: "gpt-5.4-mini",
              usage: { prompt_tokens: 100, completion_tokens: 50 },
            },
          },
        });
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => resultsJsonl,
          json: async () => JSON.parse(resultsJsonl),
        };
      }

      return {
        ok: false,
        status: 500,
        text: async () => "unexpected",
        json: async () => ({}),
      };
    };

    const client = createBatchLLMClient(
      inner,
      UPSTREAMS,
      getTestAuth,
      DEFAULT_MODEL,
      {
        flushIntervalMs: 60_000,
        maxQueueSize: 1,
        pollIntervalMs: 50, // Fast polling for test
      },
    );

    const promise = client.prompt("sys prompt", "user msg", {
      model: { providerID: "openai", modelID: "gpt-5.4-mini" },
      workerID: "lore-distill",
    });

    // Wait for flush + poll + results
    await new Promise((r) => setTimeout(r, 300));

    const result = await promise;
    expect(result).toBe("OpenAI batch result");

    const s = client.stats();
    expect(s.totalBatched).toBe(1);
    expect(s.totalResolved).toBe(1);

    globalThis.fetch = prevFetch;
    await client.shutdown();
  });

  // -------------------------------------------------------------------------
  // Rate-limit resilience (Claude Max / batch-disabled sessions)
  // -------------------------------------------------------------------------

  test("fallbackAll does not mark calls as urgent (enables circuit breaker)", async () => {
    const inner = createMockLLMClient();

    // Set up batch create to fail — triggers fallbackAll
    pushFetchResponse(false, 500, { error: "internal server error" });

    const client = createBatchLLMClient(
      inner,
      UPSTREAMS,
      getTestAuth,
      DEFAULT_MODEL,
      {
        flushIntervalMs: 60_000,
        maxQueueSize: 2,
      },
    );

    const p1 = client.prompt("sys", "msg1", { workerID: "lore-distill" });
    const p2 = client.prompt("sys", "msg2", { workerID: "lore-curator" });

    // Wait for auto-flush + fallback
    await new Promise((r) => setTimeout(r, 100));

    await Promise.all([p1, p2]);

    // Verify inner.prompt was called WITHOUT urgent: true
    // (urgent bypasses the circuit breaker, which is the whole bug)
    for (const call of inner.calls) {
      const opts = call.opts as Record<string, unknown> | undefined;
      expect(opts?.urgent).toBeUndefined();
    }

    await client.shutdown();
  });

  test("disabled sessions skip the queue and process immediately", async () => {
    const inner = createMockLLMClient();

    // First: submit a batch that returns 403 (auth error) to disable the session
    pushFetchResponse(false, 403, {
      error: "OAuth token does not meet scope requirement",
    });

    const client = createBatchLLMClient(
      inner,
      UPSTREAMS,
      getTestAuth,
      DEFAULT_MODEL,
      {
        flushIntervalMs: 60_000,
        maxQueueSize: 1,
      },
    );

    // Queue one item with a session ID — triggers auto-flush → 403 → session disabled
    const p1 = client.prompt("sys", "first-msg", {
      workerID: "lore-distill",
      sessionID: "session-no-batch",
    });

    // Wait for flush + fallback
    await new Promise((r) => setTimeout(r, 100));
    await p1;

    // Now the session is disabled. The next call should skip the queue entirely.
    const beforeCalls = inner.calls.length;
    const p2 = client.prompt("sys", "fast-msg", {
      workerID: "lore-distill",
      sessionID: "session-no-batch",
    });

    // The promise should resolve very quickly (no 30s queue wait)
    const result = await p2;
    expect(result).toBe("sync-response-for: fast-msg");
    expect(inner.calls.length).toBe(beforeCalls + 1);

    // Should be counted as fallback, not queued
    const s = client.stats();
    expect(s.totalFallback).toBeGreaterThanOrEqual(2); // first (from 403 fallback) + second (fast-path)

    await client.shutdown();
  });

  test("OpenAI items use system as message role, not block array", async () => {
    const inner = createMockLLMClient();

    // We need to capture the JSONL content from the file upload.
    // Override fetch to capture FormData body content.
    let capturedJsonl = "";
    const prevFetch = globalThis.fetch;

    // @ts-expect-error — mock fetch to capture FormData
    globalThis.fetch = async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";

      // For file upload, capture the FormData body
      if (
        typeof url === "string" &&
        url.includes("/v1/files") &&
        init?.body instanceof FormData
      ) {
        const formData = init.body;
        const file = formData.get("file") as Blob;
        if (file) {
          capturedJsonl = await file.text();
        }
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => JSON.stringify({ id: "file-test" }),
          json: async () => ({ id: "file-test" }),
        };
      }

      // For batch create, return success
      if (
        typeof url === "string" &&
        url.includes("/v1/batches") &&
        method === "POST"
      ) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => JSON.stringify({ id: "batch-test" }),
          json: async () => ({ id: "batch-test" }),
        };
      }

      // Default
      return {
        ok: false,
        status: 500,
        text: async () => "unexpected",
        json: async () => ({}),
      };
    };

    const client = createBatchLLMClient(
      inner,
      UPSTREAMS,
      getTestAuth,
      DEFAULT_MODEL,
      {
        flushIntervalMs: 60_000,
        maxQueueSize: 1,
      },
    );

    void client.prompt("my system prompt", "my user message", {
      model: { providerID: "openai", modelID: "gpt-5.4-mini" },
    });

    // Wait for flush
    await new Promise((r) => setTimeout(r, 100));

    // Parse the captured JSONL
    expect(capturedJsonl).not.toBe("");
    const line = JSON.parse(capturedJsonl) as {
      custom_id: string;
      method: string;
      url: string;
      body: {
        model: string;
        max_completion_tokens: number;
        messages: Array<{ role: string; content: string }>;
      };
    };

    // Verify JSONL structure
    expect(line.method).toBe("POST");
    expect(line.url).toBe("/v1/chat/completions");
    expect(line.body.model).toBe("gpt-5.4-mini");
    expect(line.body.max_completion_tokens).toBe(8192);

    // System should be converted to a message, not a block array
    expect(line.body.messages).toHaveLength(2);
    expect(line.body.messages[0]).toEqual({
      role: "system",
      content: "my system prompt",
    });
    expect(line.body.messages[1]).toEqual({
      role: "user",
      content: "my user message",
    });

    // Restore original mock
    globalThis.fetch = prevFetch;

    await client.shutdown();
  });

  // -------------------------------------------------------------------------
  // Errored-result parsing (regression: "batch item … errored: error: undefined")
  // -------------------------------------------------------------------------

  describe("extractAnthropicError", () => {
    test("reads the nested ErrorResponse envelope (real Anthropic shape)", () => {
      // Anthropic wraps the cause in `{ type: "error", request_id, error: { type, message } }`.
      expect(
        extractAnthropicError(
          {
            type: "error",
            request_id: "req_1",
            error: {
              type: "invalid_request_error",
              message: "max_tokens: too large",
            },
          },
          "errored",
        ),
      ).toBe("invalid_request_error: max_tokens: too large");
    });

    test("tolerates a flattened envelope ({ type, message } at top level)", () => {
      expect(
        extractAnthropicError(
          { type: "overloaded_error", message: "Overloaded" },
          "errored",
        ),
      ).toBe("overloaded_error: Overloaded");
    });

    test("falls back to the outcome string, never yields 'error: undefined'", () => {
      // The old bug: reading `.type`/`.message` off the envelope produced
      // "error: undefined". The fallback must be the outcome, not undefined.
      expect(extractAnthropicError({ type: "error" }, "errored")).toBe(
        "errored",
      );
      expect(extractAnthropicError(undefined, "canceled")).toBe("canceled");
      expect(extractAnthropicError({ type: "error" }, "errored")).not.toContain(
        "undefined",
      );
    });
  });

  test("anthropic errored result surfaces the real message, not 'error: undefined'", async () => {
    const inner = createMockLLMClient();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    let capturedCustomId = "";
    let callIndex = 0;
    const prevFetch = globalThis.fetch;

    // @ts-expect-error — mock fetch
    globalThis.fetch = async (url: string, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      const idx = callIndex++;

      // 0: batch submit — capture the generated custom_id so results correlate
      if (idx === 0) {
        expect(u).toBe(`${UPSTREAMS.anthropic}/v1/messages/batches`);
        expect(method).toBe("POST");
        const body = JSON.parse(init?.body as string) as {
          requests: Array<{ custom_id: string }>;
        };
        capturedCustomId = body.requests[0]?.custom_id ?? "";
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => JSON.stringify({ id: "msgbatch_err" }),
          json: async () => ({ id: "msgbatch_err" }),
        };
      }

      // 1: poll — batch has ended
      if (idx === 1) {
        expect(u).toContain("/v1/messages/batches/msgbatch_err");
        const pollBody = {
          processing_status: "ended",
          results_url: `${UPSTREAMS.anthropic}/v1/messages/batches/msgbatch_err/results`,
        };
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => JSON.stringify(pollBody),
          json: async () => pollBody,
        };
      }

      // 2: results — one errored row with the real nested envelope
      if (idx === 2) {
        expect(u).toContain("/results");
        const jsonl = JSON.stringify({
          custom_id: capturedCustomId,
          result: {
            type: "errored",
            error: {
              type: "error",
              request_id: "req_1",
              error: {
                type: "invalid_request_error",
                message: "max_tokens: too large",
              },
            },
          },
        });
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => jsonl,
          json: async () => JSON.parse(jsonl),
        };
      }

      return {
        ok: false,
        status: 500,
        statusText: "Error",
        text: async () => "unexpected",
        json: async () => ({}),
      };
    };

    const client = createBatchLLMClient(
      inner,
      UPSTREAMS,
      getTestAuth,
      DEFAULT_MODEL,
      { flushIntervalMs: 60_000, maxQueueSize: 1, pollIntervalMs: 50 },
    );

    const promise = client.prompt("sys", "user msg", {
      workerID: "lore-distill",
    });

    await new Promise((r) => setTimeout(r, 300));
    const result = await promise;

    // Errored items resolve to null (background caller degrades gracefully)
    expect(result).toBeNull();

    const logged = errorSpy.mock.calls
      .map((c) => c.map((a) => String(a)).join(" "))
      .join("\n");
    expect(logged).toContain("invalid_request_error: max_tokens: too large");
    expect(logged).not.toContain("errored: error: undefined");

    const s = client.stats();
    expect(s.totalFailed).toBe(1);

    errorSpy.mockRestore();
    globalThis.fetch = prevFetch;
    await client.shutdown();
  });

  test("openai errored result includes the response body error message", async () => {
    const inner = createMockLLMClient();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    let capturedCustomId = "";
    let callIndex = 0;
    const prevFetch = globalThis.fetch;

    // @ts-expect-error — mock fetch
    globalThis.fetch = async (url: string, init?: RequestInit) => {
      const u = String(url);
      const idx = callIndex++;

      // 0: file upload — capture custom_id from the uploaded JSONL
      if (idx === 0) {
        expect(u).toContain("/v1/files");
        if (init?.body instanceof FormData) {
          const file = init.body.get("file") as Blob;
          const parsed = JSON.parse(await file.text());
          capturedCustomId = parsed.custom_id;
        }
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => JSON.stringify({ id: "file-batch-err" }),
          json: async () => ({ id: "file-batch-err" }),
        };
      }

      // 1: batch create
      if (idx === 1) {
        expect(u).toContain("/v1/batches");
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => JSON.stringify({ id: "batch_err" }),
          json: async () => ({ id: "batch_err" }),
        };
      }

      // 2: poll — completed
      if (idx === 2) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () =>
            JSON.stringify({
              status: "completed",
              output_file_id: "file-results",
            }),
          json: async () => ({
            status: "completed",
            output_file_id: "file-results",
          }),
        };
      }

      // 3: download results — errored row with a real error body
      if (idx === 3) {
        expect(u).toContain("/v1/files/file-results/content");
        const jsonl = JSON.stringify({
          custom_id: capturedCustomId,
          response: {
            status_code: 400,
            body: {
              error: {
                type: "invalid_request_error",
                message: "context_length_exceeded",
              },
            },
          },
        });
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => jsonl,
          json: async () => JSON.parse(jsonl),
        };
      }

      return {
        ok: false,
        status: 500,
        statusText: "Error",
        text: async () => "unexpected",
        json: async () => ({}),
      };
    };

    const client = createBatchLLMClient(
      inner,
      UPSTREAMS,
      getTestAuth,
      DEFAULT_MODEL,
      { flushIntervalMs: 60_000, maxQueueSize: 1, pollIntervalMs: 50 },
    );

    const promise = client.prompt("sys", "user msg", {
      model: { providerID: "openai", modelID: "gpt-5.4-mini" },
      workerID: "lore-distill",
    });

    await new Promise((r) => setTimeout(r, 300));
    const result = await promise;

    expect(result).toBeNull();

    const logged = errorSpy.mock.calls
      .map((c) => c.map((a) => String(a)).join(" "))
      .join("\n");
    expect(logged).toContain("HTTP 400");
    expect(logged).toContain("context_length_exceeded");

    errorSpy.mockRestore();
    globalThis.fetch = prevFetch;
    await client.shutdown();
  });
});

// ---------------------------------------------------------------------------
// Temperature capability on the batch path.
//
// Newer models (claude-sonnet-5, GPT-5 / o-series) DEPRECATE the sampling
// `temperature` param and 400 any request carrying it. The single-request path
// retries-then-strips + learns the model; a batch item has no per-item retry, so
// a submitted item carrying an unsupported `temperature` just errors. The batch
// submit must omit `temperature` upfront for models learned to reject it (shared
// set with the single path), and it must LEARN from a batch item that errors
// with a deprecation message so the next submit self-heals.
// ---------------------------------------------------------------------------
describe("BatchLLMClient temperature capability", () => {
  beforeEach(() => {
    _resetTemperatureUnsupportedModels();
    clearModelDataCache();
  });
  afterEach(() => {
    _resetTemperatureUnsupportedModels();
    clearModelDataCache();
  });

  test("Anthropic batch omits temperature for a model learned to reject it", async () => {
    const inner = createMockLLMClient();
    // Model already learned as temperature-unsupported (e.g. from a prior
    // single-request 400 or an earlier batch error).
    markTemperatureUnsupported({
      providerID: "anthropic",
      modelID: "claude-sonnet-4-20250514",
    });
    pushFetchResponse(true, 200, {
      id: "msgbatch_tempstrip",
      processing_status: "in_progress",
    });

    const client = createBatchLLMClient(
      inner,
      UPSTREAMS,
      getTestAuth,
      DEFAULT_MODEL,
      {
        flushIntervalMs: 60_000,
        maxQueueSize: 1,
      },
    );

    void client.prompt("sys", "msg", {
      workerID: "lore-distill",
      temperature: 0,
    });
    await new Promise((r) => setTimeout(r, 50));

    const params = fetchCalls[0]?.body?.requests[0]?.params;
    expect(params).toBeDefined();
    expect(params).not.toHaveProperty("temperature");

    await client.shutdown();
  });

  test("Anthropic batch keeps temperature for a model that supports it", async () => {
    const inner = createMockLLMClient();
    pushFetchResponse(true, 200, {
      id: "msgbatch_tempkeep",
      processing_status: "in_progress",
    });

    const client = createBatchLLMClient(
      inner,
      UPSTREAMS,
      getTestAuth,
      DEFAULT_MODEL,
      {
        flushIntervalMs: 60_000,
        maxQueueSize: 1,
      },
    );

    void client.prompt("sys", "msg", {
      workerID: "lore-distill",
      temperature: 0,
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchCalls[0]?.body?.requests[0]?.params.temperature).toBe(0);

    await client.shutdown();
  });

  test("Anthropic batch omits temperature UPFRONT for a model models.dev marks temperature:false (no prior 400)", async () => {
    const inner = createMockLLMClient();
    // models.dev says this model dropped the sampling `temperature` param.
    // The batch path must strip it on the FIRST submit — before any 400 — so
    // it never wastes a round-trip on a guaranteed-to-error item.
    _setModelDataForTest({
      "claude-sonnet-5": { id: "claude-sonnet-5", temperature: false },
    });
    pushFetchResponse(true, 200, {
      id: "msgbatch_datatempstrip",
      processing_status: "in_progress",
    });

    const client = createBatchLLMClient(
      inner,
      UPSTREAMS,
      getTestAuth,
      { providerID: "anthropic", modelID: "claude-sonnet-5" },
      {
        flushIntervalMs: 60_000,
        maxQueueSize: 1,
      },
    );

    void client.prompt("sys", "msg", {
      workerID: "lore-distill",
      temperature: 0,
    });
    await new Promise((r) => setTimeout(r, 50));

    const params = fetchCalls[0]?.body?.requests[0]?.params;
    expect(params).toBeDefined();
    expect(params).not.toHaveProperty("temperature");
    // Proactive strip came from models.dev data, NOT the runtime learning net.
    expect(
      isTemperatureUnsupportedModel({
        providerID: "anthropic",
        modelID: "claude-sonnet-5",
      }),
    ).toBe(false);

    await client.shutdown();
  });

  test("Anthropic batch keeps temperature when models.dev marks the model temperature:true", async () => {
    const inner = createMockLLMClient();
    _setModelDataForTest({
      "claude-sonnet-4-5": { id: "claude-sonnet-4-5", temperature: true },
    });
    pushFetchResponse(true, 200, {
      id: "msgbatch_datatempkeep",
      processing_status: "in_progress",
    });

    const client = createBatchLLMClient(
      inner,
      UPSTREAMS,
      getTestAuth,
      { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
      {
        flushIntervalMs: 60_000,
        maxQueueSize: 1,
      },
    );

    void client.prompt("sys", "msg", {
      workerID: "lore-distill",
      temperature: 0,
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchCalls[0]?.body?.requests[0]?.params.temperature).toBe(0);

    await client.shutdown();
  });

  test("OpenAI batch omits temperature UPFRONT for a model models.dev marks temperature:false", async () => {
    // The OpenAI submit path builds JSONL (not the anthropic requests[] shape),
    // so it needs its own coverage: the proactive strip must apply there too or
    // every gpt-5/o3 batch item 400s. Capture the uploaded JSONL and assert the
    // per-line body omits `temperature`.
    const inner = createMockLLMClient();
    _setModelDataForTest({ "gpt-5": { id: "gpt-5", temperature: false } });

    let capturedJsonl = "";
    const prevFetch = globalThis.fetch;
    // @ts-expect-error — mock fetch to capture the FormData file upload
    globalThis.fetch = async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (
        typeof url === "string" &&
        url.includes("/v1/files") &&
        init?.body instanceof FormData
      ) {
        const file = init.body.get("file") as Blob;
        if (file) capturedJsonl = await file.text();
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => JSON.stringify({ id: "file-temp" }),
          json: async () => ({ id: "file-temp" }),
        };
      }
      if (
        typeof url === "string" &&
        url.includes("/v1/batches") &&
        method === "POST"
      ) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => JSON.stringify({ id: "batch-temp" }),
          json: async () => ({ id: "batch-temp" }),
        };
      }
      return {
        ok: false,
        status: 500,
        text: async () => "unexpected",
        json: async () => ({}),
      };
    };

    const client = createBatchLLMClient(
      inner,
      UPSTREAMS,
      getTestAuth,
      DEFAULT_MODEL,
      {
        flushIntervalMs: 60_000,
        maxQueueSize: 1,
      },
    );

    void client.prompt("sys", "msg", {
      model: { providerID: "openai", modelID: "gpt-5" },
      workerID: "lore-distill",
      temperature: 0,
    });
    await new Promise((r) => setTimeout(r, 100));

    expect(capturedJsonl).not.toBe("");
    const line = JSON.parse(capturedJsonl) as { body: Record<string, unknown> };
    expect(line.body.model).toBe("gpt-5");
    expect(line.body).not.toHaveProperty("temperature");

    globalThis.fetch = prevFetch;
    await client.shutdown();
  });

  test("OpenAI batch keeps temperature for a model that supports it", async () => {
    const inner = createMockLLMClient();
    _setModelDataForTest({
      "gpt-5.4-mini": { id: "gpt-5.4-mini", temperature: true },
    });

    let capturedJsonl = "";
    const prevFetch = globalThis.fetch;
    // @ts-expect-error — mock fetch to capture the FormData file upload
    globalThis.fetch = async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (
        typeof url === "string" &&
        url.includes("/v1/files") &&
        init?.body instanceof FormData
      ) {
        const file = init.body.get("file") as Blob;
        if (file) capturedJsonl = await file.text();
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => JSON.stringify({ id: "file-keep" }),
          json: async () => ({ id: "file-keep" }),
        };
      }
      if (
        typeof url === "string" &&
        url.includes("/v1/batches") &&
        method === "POST"
      ) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => JSON.stringify({ id: "batch-keep" }),
          json: async () => ({ id: "batch-keep" }),
        };
      }
      return {
        ok: false,
        status: 500,
        text: async () => "unexpected",
        json: async () => ({}),
      };
    };

    const client = createBatchLLMClient(
      inner,
      UPSTREAMS,
      getTestAuth,
      DEFAULT_MODEL,
      {
        flushIntervalMs: 60_000,
        maxQueueSize: 1,
      },
    );

    void client.prompt("sys", "msg", {
      model: { providerID: "openai", modelID: "gpt-5.4-mini" },
      workerID: "lore-distill",
      temperature: 0,
    });
    await new Promise((r) => setTimeout(r, 100));

    expect(capturedJsonl).not.toBe("");
    const line = JSON.parse(capturedJsonl) as { body: Record<string, unknown> };
    expect(line.body.temperature).toBe(0);

    globalThis.fetch = prevFetch;
    await client.shutdown();
  });

  test("learns temperature-unsupported from a batch item that errors with a deprecation message", async () => {
    const inner = createMockLLMClient();
    const MODEL = { providerID: "anthropic", modelID: "claude-sonnet-5" };

    // Full Anthropic batch lifecycle, ordered: create → poll(ended) → results.
    let capturedCustomId = "";
    const prevFetch = globalThis.fetch;
    let idx = 0;
    // @ts-expect-error — mock fetch
    globalThis.fetch = async (url: string, init?: RequestInit) => {
      const i = idx++;
      // 0: batch create — capture the generated custom_id for the results row.
      if (i === 0) {
        expect(String(url)).toContain("/v1/messages/batches");
        const body = JSON.parse(init?.body as string);
        capturedCustomId = body.requests[0].custom_id;
        // Not-yet-learned model: temperature IS carried into the submit.
        expect(body.requests[0].params.temperature).toBe(0);
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => JSON.stringify({ id: "msgbatch_learn" }),
          json: async () => ({ id: "msgbatch_learn" }),
        };
      }
      // 1: poll — batch ended.
      if (i === 1) {
        const poll = {
          processing_status: "ended",
          results_url:
            "https://api.anthropic.com/v1/messages/batches/msgbatch_learn/results",
        };
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => JSON.stringify(poll),
          json: async () => poll,
        };
      }
      // 2: results JSONL — one errored row with the temperature-deprecation message.
      if (i === 2) {
        const jsonl = JSON.stringify({
          custom_id: capturedCustomId,
          result: {
            type: "errored",
            error: {
              type: "invalid_request_error",
              message: "`temperature` is deprecated for this model.",
            },
          },
        });
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => jsonl,
          json: async () => JSON.parse(jsonl),
        };
      }
      return {
        ok: false,
        status: 500,
        statusText: "Error",
        text: async () => "unexpected",
        json: async () => ({}),
      };
    };

    const client = createBatchLLMClient(inner, UPSTREAMS, getTestAuth, MODEL, {
      flushIntervalMs: 60_000,
      maxQueueSize: 1,
      pollIntervalMs: 50,
    });

    // Pre-condition: not yet learned.
    expect(isTemperatureUnsupportedModel(MODEL)).toBe(false);

    const promise = client.prompt("sys", "msg", {
      workerID: "lore-distill",
      model: MODEL,
      temperature: 0,
    });

    await new Promise((r) => setTimeout(r, 300));

    // Errored item resolves null (matches inner-client-on-error behavior)...
    expect(await promise).toBeNull();
    // ...and the model is now learned so the NEXT submit omits temperature.
    expect(isTemperatureUnsupportedModel(MODEL)).toBe(true);

    globalThis.fetch = prevFetch;
    await client.shutdown();
  });
});
