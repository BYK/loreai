/**
 * End-to-end routing guard for GitHub Copilot CLI interception.
 *
 * The Copilot CLI's default (GitHub-hosted) mode is redirected at lore via the
 * `COPILOT_API_URL` env var. Copilot then sends OpenAI-format requests carrying
 * its own exchanged Copilot bearer token and a `Copilot-Integration-Id` header,
 * but it has NO way to set `X-Lore-Provider`. Its model ids (`gpt-5.4`,
 * `claude-sonnet-4.6`, …) would otherwise route via model-prefix to the WRONG
 * upstream (api.openai.com / api.anthropic.com). This test pins the behavior:
 * when a `Copilot-Integration-Id` header is present and there is no explicit
 * provider / upstream override, the gateway forwards to the `github-copilot`
 * upstream (api.githubcopilot.com). Explicit `X-Lore-Provider` /
 * `X-Lore-Upstream-URL` (BYOK) still win.
 *
 * Mechanism mirrors github-copilot-url.e2e.test.ts: `upstreamFetch` is mocked to
 * capture the resolved upstream URL, and the pipeline's upstream interceptor is
 * overridden to invoke the real (mocked) request so the URL flows into the mock.
 */
import { describe, test, expect, afterEach, vi } from "vitest";

vi.mock("../src/fetch", () => ({ upstreamFetch: vi.fn() }));

import { upstreamFetch } from "../src/fetch";
import type { Harness } from "./helpers/harness";
import { createHarness } from "./helpers/harness";

const mockFetch = vi.mocked(upstreamFetch);

function openAIResponse(): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-x",
      object: "chat.completion",
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "ok" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/**
 * Send an OpenAI chat-completions request with the given model + headers and
 * return the captured upstream URL the gateway forwarded to.
 */
async function captureUpstreamUrl(
  harness: Harness,
  model: string,
  headers: Record<string, string>,
  ingressPath = "/v1/chat/completions",
): Promise<string> {
  const { setUpstreamInterceptor } = await import("../src/pipeline");
  setUpstreamInterceptor(async (_body, _model, _stream, makeReal) =>
    makeReal(),
  );
  mockFetch.mockReset();
  mockFetch.mockResolvedValue(openAIResponse());

  const res = await fetch(`${harness.baseURL}${ingressPath}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer tid=copilot-token",
      "x-lore-project": "/tmp/copilot-routing-e2e",
      ...headers,
    },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  await res.text().catch(() => undefined);

  expect(mockFetch).toHaveBeenCalled();
  return String(mockFetch.mock.calls[0][0]);
}

describe("Copilot-Integration-Id → github-copilot upstream routing", () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.teardown();
    harness = undefined;
  });

  test("routes a gpt- model to api.githubcopilot.com (not api.openai.com)", async () => {
    harness = await createHarness({ fixtures: [] });
    const url = await captureUpstreamUrl(harness, "gpt-5.4", {
      "copilot-integration-id": "copilot-cli",
    });
    expect(url).toContain("api.githubcopilot.com");
    expect(url).not.toContain("api.openai.com");
  });

  test("routes a claude- model to api.githubcopilot.com (beats model-prefix anthropic route)", async () => {
    harness = await createHarness({ fixtures: [] });
    const url = await captureUpstreamUrl(harness, "claude-sonnet-4.6", {
      "copilot-integration-id": "copilot-cli",
    });
    expect(url).toContain("api.githubcopilot.com");
    expect(url).not.toContain("api.anthropic.com");
  });

  test("explicit X-Lore-Provider wins over the integration-id signal (BYOK/other)", async () => {
    harness = await createHarness({ fixtures: [] });
    const url = await captureUpstreamUrl(harness, "gpt-5.4", {
      "copilot-integration-id": "copilot-cli",
      "x-lore-provider": "openai",
    });
    // Explicit provider override must not be hijacked to github-copilot.
    expect(url).not.toContain("api.githubcopilot.com");
  });

  test("explicit X-Lore-Upstream-URL (BYOK) wins over the integration-id signal", async () => {
    harness = await createHarness({ fixtures: [] });
    const url = await captureUpstreamUrl(harness, "gpt-5.4", {
      "copilot-integration-id": "copilot-cli",
      "x-lore-upstream-url": "https://api.openai.com",
    });
    expect(url).not.toContain("api.githubcopilot.com");
    expect(url).toContain("api.openai.com");
  });

  test("without the integration-id header, model-prefix routing is unchanged", async () => {
    harness = await createHarness({ fixtures: [] });
    const url = await captureUpstreamUrl(harness, "gpt-5.4", {});
    expect(url).toContain("api.openai.com");
    expect(url).not.toContain("api.githubcopilot.com");
  });
});

describe("Copilot bare (no /v1) ingress paths", () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.teardown();
    harness = undefined;
  });

  test("POST /chat/completions (no /v1) is accepted and routed", async () => {
    // Copilot CLI redirected via COPILOT_API_URL hits the origin's bare
    // /chat/completions (no /v1 segment). It must reach the OpenAI handler and,
    // with the integration-id header, forward to github-copilot.
    harness = await createHarness({ fixtures: [] });
    const url = await captureUpstreamUrl(
      harness,
      "gpt-5.4",
      { "copilot-integration-id": "copilot-cli" },
      "/chat/completions",
    );
    expect(url).toContain("api.githubcopilot.com");
  });
});
