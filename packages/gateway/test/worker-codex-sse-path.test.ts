/**
 * Regression for LOREAI-GATEWAY-38 (Sergiy): a background worker for a Codex
 * session hits the ChatGPT/Codex backend, which MANDATES streaming and returns
 * an openai-responses SSE stream even for a non-streaming worker request.
 *
 * Two failure modes, both fixed here:
 *   1. THROW — the SSE body arrives WITHOUT a `text/event-stream` content-type,
 *      so the old header-only guard fed it to `response.json()` →
 *      `SyntaxError: Unexpected token 'e', "event: res"... is not valid JSON`.
 *   2. SILENT-EMPTY — a single-`data:`-line reader would return only the last
 *      delta / terminal event, dropping the text streamed across the earlier
 *      `output_text.delta` events → `text=null`.
 *
 * The worker now sniffs the body prefix and runs a detected SSE stream through
 * the protocol's stream accumulator (`accumulateResponsesSSEStream`), merging
 * every delta into the full text — regardless of the content-type label.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/fetch", () => ({ upstreamFetch: vi.fn() }));

import { createGatewayLLMClient } from "../src/llm-adapter";
import { upstreamFetch } from "../src/fetch";
import { clearAllCosts } from "../src/cost-tracker";
import { resetBackgroundLimiter } from "../src/background-limiter";

const mockFetch = vi.mocked(upstreamFetch);

const UPSTREAMS = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
};

/**
 * A realistic multi-delta openai-responses SSE stream. The text arrives across
 * TWO `output_text.delta` events ("worker " + "text") — a stream accumulator
 * must merge them into "worker text"; a last-`data:`-line reader would drop all
 * but the final delta.
 */
const CODEX_RESPONSES_SSE = [
  "event: response.created",
  'data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5-codex"}}',
  "",
  "event: response.output_item.added",
  'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","role":"assistant"}}',
  "",
  "event: response.output_text.delta",
  'data: {"type":"response.output_text.delta","output_index":0,"delta":"worker "}',
  "",
  "event: response.output_text.delta",
  'data: {"type":"response.output_text.delta","output_index":0,"delta":"text"}',
  "",
  "event: response.completed",
  'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","usage":{"input_tokens":5,"output_tokens":2},"model":"gpt-5-codex"}}',
  "",
  "data: [DONE]",
  "",
].join("\n");

function sseResponse(contentType: string): Response {
  return new Response(CODEX_RESPONSES_SSE, {
    status: 200,
    headers: { "content-type": contentType },
  });
}

async function runCodexWorker(contentType: string): Promise<string | null> {
  const client = createGatewayLLMClient(
    UPSTREAMS,
    (_sid, providerID) =>
      providerID === "openai-codex"
        ? { scheme: "bearer", value: "codex_tok" }
        : null,
    { providerID: "openai-codex", modelID: "gpt-5-codex" },
  );
  mockFetch.mockResolvedValue(sseResponse(contentType));
  return client.prompt("system-prompt", "user-prompt", {
    sessionID: "sess-codex",
    workerID: "lore-distill",
    model: { providerID: "openai-codex", modelID: "gpt-5-codex" },
  });
}

describe("worker codex responses-SSE path", () => {
  beforeEach(() => mockFetch.mockReset());
  afterEach(() => {
    mockFetch.mockReset();
    clearAllCosts();
    resetBackgroundLimiter();
  });

  test("mislabeled SSE (application/json) → accumulates full text, does NOT throw", async () => {
    // Before the fix: response.json() on "event: res..." → SyntaxError → null.
    const result = await runCodexWorker("application/json");
    expect(result).toBe("worker text");
  });

  test("correct text/event-stream content-type → merges multi-delta stream", async () => {
    // The two output_text.delta events ("worker " + "text") must be merged; a
    // last-data-line reader would only ever see the terminal event → empty.
    const result = await runCodexWorker("text/event-stream");
    expect(result).toBe("worker text");
  });
});
