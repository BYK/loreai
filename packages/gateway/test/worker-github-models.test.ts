/**
 * GitHub Models (https://models.github.ai) worker routing. GitHub Models is
 * OpenAI-Chat-shaped but deviates in two ways the gateway must handle when
 * reconstructing a background/worker request (there is no client request to
 * forward verbatim):
 *   1. It serves Chat Completions at `/inference/chat/completions` (NO `/v1`).
 *   2. It requires two static headers beyond auth: `Accept:
 *      application/vnd.github+json` and `X-GitHub-Api-Version`, and auth is a
 *      GitHub token carried as `Authorization: Bearer`.
 * Both must be scoped to models.github.ai — they must NEVER ride along on other
 * OpenAI-compatible providers.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { fetchArgUrl } from "./helpers/fetch-url";

vi.mock("../src/fetch", () => ({ upstreamFetch: vi.fn() }));

import { createGatewayLLMClient } from "../src/llm-adapter";
import { upstreamFetch } from "../src/fetch";
import { clearAllCosts } from "../src/cost-tracker";
import { resetBackgroundLimiter } from "../src/background-limiter";
import { GITHUB_MODELS_API_VERSION } from "../src/translate/openai";

const mockFetch = vi.mocked(upstreamFetch);

const UPSTREAMS = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
};

function okResponse() {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: "ok" } }],
      model: "openai/gpt-4o-mini",
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** Read the headers object the worker passed to upstreamFetch on call `n`. */
function callHeaders(n: number): Record<string, string> {
  return (mockFetch.mock.calls[n][1]?.headers ?? {}) as Record<string, string>;
}

describe("worker GitHub Models routing (#1368)", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(okResponse());
  });
  afterEach(() => {
    mockFetch.mockReset();
    clearAllCosts();
    resetBackgroundLimiter();
  });

  test("routes to /inference/chat/completions with the GitHub Models headers", async () => {
    const client = createGatewayLLMClient(
      UPSTREAMS,
      (_sid, providerID) =>
        providerID === "github-models"
          ? { scheme: "bearer", value: "gh_token" }
          : null,
      { providerID: "github-models", modelID: "openai/gpt-4o-mini" },
    );

    await client.prompt("system", "user", {
      sessionID: "sess-ghm",
      workerID: "lore-invariant-check",
      model: { providerID: "github-models", modelID: "openai/gpt-4o-mini" },
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const url = fetchArgUrl(mockFetch.mock.calls[0][0]);
    expect(url).toBe("https://models.github.ai/inference/chat/completions");
    // NOT the conventional /v1 path.
    expect(url).not.toContain("/v1/chat/completions");

    const headers = callHeaders(0);
    expect(headers.Accept).toBe("application/vnd.github+json");
    expect(headers["X-GitHub-Api-Version"]).toBe(GITHUB_MODELS_API_VERSION);
    // GitHub token rides as a Bearer credential.
    expect(headers.Authorization).toBe("Bearer gh_token");
  });

  test("preserves the {publisher}/{model} id in the request body", async () => {
    const client = createGatewayLLMClient(
      UPSTREAMS,
      () => ({ scheme: "bearer", value: "gh_token" }),
      { providerID: "github-models", modelID: "openai/gpt-4o-mini" },
    );

    await client.prompt("system", "user", {
      sessionID: "sess-ghm-model",
      workerID: "lore-invariant-check",
      model: { providerID: "github-models", modelID: "openai/gpt-4o-mini" },
    });

    const rawBody = mockFetch.mock.calls[0][1]?.body;
    const body = JSON.parse(typeof rawBody === "string" ? rawBody : "{}") as {
      model?: string;
    };
    expect(body.model).toBe("openai/gpt-4o-mini");
  });

  test("does NOT leak the GitHub Models headers onto another OpenAI provider", async () => {
    const client = createGatewayLLMClient(
      UPSTREAMS,
      (_sid, providerID) =>
        providerID === "deepseek"
          ? { scheme: "bearer", value: "ds_key" }
          : null,
      { providerID: "deepseek", modelID: "deepseek-chat" },
    );

    await client.prompt("system", "user", {
      sessionID: "sess-ds",
      workerID: "lore-invariant-check",
      model: { providerID: "deepseek", modelID: "deepseek-chat" },
    });

    const url = fetchArgUrl(mockFetch.mock.calls[0][0]);
    expect(url).toBe("https://api.deepseek.com/v1/chat/completions");
    const headers = callHeaders(0);
    expect(headers.Accept).toBeUndefined();
    expect(headers["X-GitHub-Api-Version"]).toBeUndefined();
  });
});
