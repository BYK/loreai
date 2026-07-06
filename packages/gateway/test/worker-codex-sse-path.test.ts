/**
 * Regression for LOREAI-GATEWAY-38 (Sergiy): a background worker for a Codex
 * session hits the ChatGPT/Codex backend, which MANDATES streaming and returns
 * an openai-responses SSE stream even for a non-streaming worker request.
 *
 * Two failure modes, both fixed here:
 *   1. THROW — the SSE body arrives WITHOUT a `text/event-stream` content-type,
 *      so the old header-only guard fed it to `response.json()` →
 *      `SyntaxError: Unexpected token 'e', "event: res"... is not valid JSON`.
 *   2. SILENT-EMPTY — even with the correct content-type, the last `data:` line
 *      is the `response.completed` ENVELOPE (`{type, response:{...}}`), but the
 *      worker parser reads `output`/`output_text` at top level → `text=null`.
 *
 * `readCompletionJSON` now sniffs the body prefix AND unwraps the responses
 * envelope, so the worker extracts the real text in both cases.
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

/** An openai-responses SSE stream whose terminal event carries the full text. */
const CODEX_RESPONSES_SSE = [
  "event: response.created",
  'data: {"type":"response.created","response":{"id":"resp_1"}}',
  "event: response.output_text.delta",
  'data: {"type":"response.output_text.delta","delta":"worker "}',
  "event: response.completed",
  'data: {"type":"response.completed","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"worker text"}]}],"usage":{"input_tokens":5,"output_tokens":2},"model":"gpt-5-codex"}}',
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

  test("mislabeled SSE (application/json) → extracts text, does NOT throw", async () => {
    // Before the fix: response.json() on "event: res..." → SyntaxError → null.
    const result = await runCodexWorker("application/json");
    expect(result).toBe("worker text");
  });

  test("correct text/event-stream content-type → unwraps envelope → extracts text", async () => {
    // Before the fix: extractJSONFromSSE returned the `response.completed`
    // envelope, so the parser read output_text=undefined → null (silent-empty).
    const result = await runCodexWorker("text/event-stream");
    expect(result).toBe("worker text");
  });
});
