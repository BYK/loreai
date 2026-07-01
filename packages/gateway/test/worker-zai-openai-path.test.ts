/**
 * Issue #1093 — background worker requests routed to the `zai` provider must
 * target Z.AI's OpenAI-compat endpoint under its `/v4` version segment, NOT the
 * conventional `/v1/chat/completions`. `zai` has `url: null` (host is
 * user-supplied via LORE_UPSTREAM_ZAI, injected as the session's
 * `x-lore-upstream-url`), so the worker resolves its target from the session
 * override. Since the base already carries `/api/paas/v4`, prepending `/v1`
 * would produce `.../v4/v1/chat/completions` and 404. Workers build prompts from
 * scratch (no original request to forward verbatim), so the URL is reconstructed
 * by `buildOpenAIChatCompletionsUrl`, which appends only `/chat/completions` for
 * a version-suffixed base.
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

const ZAI_BASE = "https://api.z.ai/api/paas/v4";

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

describe("worker zai URL (#1093)", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(okResponse());
  });
  afterEach(() => {
    mockFetch.mockReset();
    clearAllCosts();
    resetBackgroundLimiter();
  });

  test("forwards to the /v4 base + /chat/completions, not a doubled /v1", async () => {
    const client = createGatewayLLMClient(
      UPSTREAMS,
      (_sid, providerID) =>
        providerID === "zai" ? { scheme: "bearer", value: "zai_worker" } : null,
      { providerID: "zai", modelID: "glm-4.6" },
    );

    await client.prompt("system", "user", {
      sessionID: "sess-zai",
      workerID: "lore-distill",
      model: { providerID: "zai", modelID: "glm-4.6" },
      // The session override carries the user's LORE_UPSTREAM_ZAI base.
      upstreamUrl: ZAI_BASE,
      upstreamProviderID: "zai",
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const url = String(mockFetch.mock.calls[0][0]);
    expect(url).toBe(`${ZAI_BASE}/chat/completions`);
    expect(url).not.toContain("/v4/v1/chat/completions");
  });

  test("tolerates a trailing slash on the configured base", async () => {
    const client = createGatewayLLMClient(
      UPSTREAMS,
      (_sid, providerID) =>
        providerID === "zai" ? { scheme: "bearer", value: "zai_worker" } : null,
      { providerID: "zai", modelID: "glm-4.6" },
    );

    await client.prompt("system", "user", {
      sessionID: "sess-zai-slash",
      workerID: "lore-distill",
      model: { providerID: "zai", modelID: "glm-4.6" },
      upstreamUrl: `${ZAI_BASE}/`,
      upstreamProviderID: "zai",
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const url = String(mockFetch.mock.calls[0][0]);
    expect(url).toBe(`${ZAI_BASE}/chat/completions`);
  });
});
