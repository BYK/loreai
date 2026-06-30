/**
 * Issue #1052 — background worker requests routed to the `github-copilot`
 * provider must target `https://api.githubcopilot.com/chat/completions` (NO
 * `/v1` segment). Workers build prompts from scratch (no original request to
 * forward verbatim), so the URL is reconstructed host-aware by
 * `buildOpenAIChatCompletionsUrl`.
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

function okResponse() {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: "ok" } }],
      model: "m",
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("worker github-copilot URL (#1052)", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(okResponse());
  });
  afterEach(() => {
    mockFetch.mockReset();
    clearAllCosts();
    resetBackgroundLimiter();
  });

  test("forwards to /chat/completions with no /v1 prefix", async () => {
    const client = createGatewayLLMClient(
      UPSTREAMS,
      (_sid, providerID) =>
        providerID === "github-copilot"
          ? { scheme: "bearer", value: "gho_worker" }
          : null,
      { providerID: "github-copilot", modelID: "gpt-4.1" },
    );

    await client.prompt("system", "user", {
      sessionID: "sess-copilot",
      workerID: "lore-distill",
      model: { providerID: "github-copilot", modelID: "gpt-4.1" },
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const url = String(mockFetch.mock.calls[0][0]);
    expect(url).toBe("https://api.githubcopilot.com/chat/completions");
    expect(url).not.toContain("/v1/chat/completions");
  });
});
