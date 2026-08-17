/**
 * Background worker requests for `gpt-5.6-*` model IDs on the `github-copilot`
 * provider must target the OpenAI Responses API endpoint
 * `https://api.githubcopilot.com/responses` (NO `/v1`, NO `/chat/completions`)
 * with a Responses-shaped body:
 *   - `input: [...]` items array (not `messages`)
 *   - `instructions: "..."` (not a `{role:"system",...}` first message)
 *   - `reasoning: { effort: ... }` (not `reasoning_effort: ...`)
 *   - `max_output_tokens` (not `max_completion_tokens`)
 *   - `store: false` (Codex parity — required by Copilot too, observed)
 *
 * Other github-copilot models (gpt-5-mini, claude-sonnet-4.5, etc.) continue to
 * route through `/chat/completions` and are guarded by
 * `worker-github-copilot.test.ts`. This file guards ONLY the gpt-5.6-* route.
 *
 * Mirror of the gpt-5-mini → /chat/completions test (the prior protocol that
 * was the only supported Copilot path); the new path is required for the
 * `gpt-5.6-{sol,terra,luna}` family that Copilot rolled out on 2026-07-09
 * (changelog: https://github.blog/changelog/2026-07-09-openais-gpt-5-6-sol-terra-and-luna-are-now-available-in-github-copilot/).
 * That endpoint is `unsupported_api_for_model` on `/chat/completions` and ONLY
 * reachable on `/responses` — verified by probe.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { fetchArgUrl } from "./helpers/fetch-url";

vi.mock("../src/fetch", () => ({ upstreamFetch: vi.fn() }));

import { createGatewayLLMClient } from "../src/llm-adapter";
import { upstreamFetch } from "../src/fetch";
import { clearAllCosts } from "../src/cost-tracker";
import { resetBackgroundLimiter } from "../src/background-limiter";
import { _resetForTest as _resetWorkerHealthForTest } from "../src/worker-health";
import type { AuthCredential } from "../src/auth";

const mockFetch = vi.mocked(upstreamFetch);

// Same shape as the Codex responses fixture the codebase already produces; tests
// need realistic `usage.input_tokens_details` etc. so the parser path is exercised.
function responsesOkResponse(text = "worker ok") {
  return new Response(
    JSON.stringify({
      id: "resp_test_1",
      object: "response",
      created_at: 1785900000,
      model: "gpt-5.6-luna",
      status: "completed",
      output: [
        {
          type: "message",
          id: "msg_test_1",
          content: [
            {
              type: "output_text",
              text,
              annotations: [],
              logprobs: [],
            },
          ],
        },
      ],
      usage: {
        input_tokens: 8,
        output_tokens: 4,
        total_tokens: 12,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

// github-copilot resolves through the route table — its protocol hint is
// "openai" (the protocol field on the route), but the routing layer now
// detects `gpt-5.6-*` model IDs and forces the response-api protocol. Tests
// therefore thread the request with NO explicit protocol hint so the
// discriminator is the discriminator (not the upstream snapshot's hint).
const UPSTREAMS = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
};

async function runWorker(
  cred: AuthCredential | null,
  modelID: string,
  protocolHint?:
    | "anthropic"
    | "openai"
    | "openai-responses"
    | "vertex"
    | "gemini",
) {
  const client = createGatewayLLMClient(
    UPSTREAMS,
    (_sid, providerID) => (providerID === "github-copilot" ? cred : null),
    { providerID: "github-copilot", modelID },
  );
  const result = await client.prompt("system-prompt", "user-prompt", {
    sessionID: "sess-copilot-responses",
    workerID: "lore-distill",
    model: { providerID: "github-copilot", modelID },
    ...(protocolHint ? { protocol: protocolHint } : {}),
    upstreamProviderID: "github-copilot",
  });
  const call = mockFetch.mock.calls[0];
  return {
    result,
    url: fetchArgUrl(call?.[0]),
    headers: (call?.[1] as { headers?: Record<string, string> } | undefined)
      ?.headers,
    body: JSON.parse(
      String((call?.[1] as { body?: string } | undefined)?.body ?? "{}"),
    ) as Record<string, unknown>,
  };
}

describe("worker github-copilot Responses API path (gpt-5.6-*)", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(responsesOkResponse());
  });
  afterEach(() => {
    mockFetch.mockReset();
    clearAllCosts();
    resetBackgroundLimiter();
    _resetWorkerHealthForTest();
  });

  test("bearer cred → /responses URL + Copilot headers + Responses body", async () => {
    const { result, url, headers, body } = await runWorker(
      { scheme: "bearer", value: "copilot_tok" },
      "gpt-5.6-luna",
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    // URL must be /responses (NOT /chat/completions, NOT /v1 prefix).
    expect(url).toBe("https://api.githubcopilot.com/responses");
    expect(url).not.toContain("/chat/completions");
    expect(url).not.toContain("/v1/");
    // GitHub Copilot canonical headers from copilotHeaders().
    expect(headers?.["Copilot-Integration-Id"]).toBe("vscode-chat");
    expect(headers?.["X-GitHub-Api-Version"]).toBeDefined();
    // Bearer auth (copilot uses Authorization: Bearer, NOT x-api-key).
    expect(headers?.Authorization).toBe("Bearer copilot_tok");
    // Responses body shape — instructions + input items, NOT messages.
    expect(body.messages).toBeUndefined();
    expect(body.instructions).toBe("system-prompt");
    expect(Array.isArray(body.input)).toBe(true);
    expect(body.input).toEqual([{ role: "user", content: "user-prompt" }]);
    // No `/chat/completions` keys: max_completion_tokens, reasoning_effort.
    expect(body.max_completion_tokens).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
    // Responses-specific keys present.
    expect(body.model).toBe("gpt-5.6-luna");
    expect(body.stream).toBe(false);
    expect(body.store).toBe(false);
    // Response parsed back from Responses output[0].content[0].text.
    expect(result).toContain("worker ok");
  });

  test("reasoning_effort from caller maps to `reasoning: { effort }` (NOT reasoning_effort)", async () => {
    const { body } = await runWorker(
      { scheme: "bearer", value: "tok" },
      "gpt-5.6-luna",
    );
    // Default reasoningEffort is undefined → omit both forms.
    expect(body.reasoning).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();

    // Force `reasoningEffort: "medium"` via a custom client that overrides opts.
    const client = createGatewayLLMClient(
      UPSTREAMS,
      (_sid, providerID) =>
        providerID === "github-copilot"
          ? { scheme: "bearer", value: "tok" }
          : null,
      { providerID: "github-copilot", modelID: "gpt-5.6-luna" },
    );
    await client.prompt("sys", "user", {
      sessionID: "sess-re",
      workerID: "lore-curator",
      model: { providerID: "github-copilot", modelID: "gpt-5.6-luna" },
      reasoningEffort: "medium",
      upstreamProviderID: "github-copilot",
    });
    const call = mockFetch.mock.calls[1];
    const bodyWithEffort = JSON.parse(
      String((call?.[1] as { body?: string } | undefined)?.body ?? "{}"),
    ) as Record<string, unknown>;
    expect(bodyWithEffort.reasoning).toEqual({ effort: "medium" });
    expect(bodyWithEffort.reasoning_effort).toBeUndefined();
  });

  test("effort off omits unsupported Copilot Responses reasoning none", async () => {
    const client = createGatewayLLMClient(
      UPSTREAMS,
      () => ({ scheme: "bearer", value: "tok" }),
      { providerID: "github-copilot", modelID: "gpt-5.6-luna" },
    );
    await client.prompt("sys", "user", {
      sessionID: "sess-off",
      workerID: "lore-invariant-check",
      model: { providerID: "github-copilot", modelID: "gpt-5.6-luna" },
      reasoningEffort: "off",
      upstreamProviderID: "github-copilot",
    });

    const body = JSON.parse(
      String((mockFetch.mock.calls[0]?.[1] as { body?: string })?.body ?? "{}"),
    ) as Record<string, unknown>;
    expect(body.reasoning).toBeUndefined();
  });

  test("effort off remains explicit for other Responses providers", async () => {
    const client = createGatewayLLMClient(
      UPSTREAMS,
      (_sid, providerID) =>
        providerID === "openai" ? { scheme: "bearer", value: "tok" } : null,
      { providerID: "openai", modelID: "gpt-5.6-luna" },
    );
    await client.prompt("sys", "user", {
      sessionID: "sess-openai-off",
      workerID: "lore-invariant-check",
      model: { providerID: "openai", modelID: "gpt-5.6-luna" },
      protocol: "openai-responses",
      upstreamProviderID: "openai",
      reasoningEffort: "off",
    });

    const body = JSON.parse(
      String((mockFetch.mock.calls[0]?.[1] as { body?: string })?.body ?? "{}"),
    ) as Record<string, unknown>;
    expect(body.reasoning).toEqual({ effort: "none" });
  });

  test("detailed outcome distinguishes missing auth from invalid model output", async () => {
    const client = createGatewayLLMClient(UPSTREAMS, () => null, {
      providerID: "github-copilot",
      modelID: "gpt-5.6-luna",
    });
    const outcome = await client.promptDetailed("sys", "user", {
      workerID: "lore-invariant-check",
      model: { providerID: "github-copilot", modelID: "gpt-5.6-luna" },
    });

    expect(outcome).toMatchObject({
      kind: "failure",
      code: "no-auth",
      attempts: 0,
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("reads successful Responses bodies beyond the old 64 KiB cap", async () => {
    const text = "x".repeat(70 * 1024);
    mockFetch.mockResolvedValueOnce(responsesOkResponse(text));

    const { result } = await runWorker(
      { scheme: "bearer", value: "tok" },
      "gpt-5.6-luna",
    );
    expect(result).toBe(text);
  });

  test("provider-declared incomplete response is a typed failure even with text", async () => {
    const body = JSON.parse(await responsesOkResponse("partial").text()) as {
      status: string;
      incomplete_details?: { reason: string };
    };
    body.status = "incomplete";
    body.incomplete_details = { reason: "max_output_tokens" };
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = createGatewayLLMClient(
      UPSTREAMS,
      () => ({ scheme: "bearer", value: "tok" }),
      { providerID: "github-copilot", modelID: "gpt-5.6-luna" },
    );

    const outcome = await client.promptDetailed("sys", "user", {
      workerID: "lore-invariant-check",
      model: { providerID: "github-copilot", modelID: "gpt-5.6-luna" },
      upstreamProviderID: "github-copilot",
    });
    expect(outcome).toMatchObject({
      kind: "failure",
      code: "incomplete-response",
      attempts: 1,
    });
  });

  test("max_tokens becomes max_output_tokens (NOT max_completion_tokens)", async () => {
    const { body } = await runWorker(
      { scheme: "bearer", value: "tok" },
      "gpt-5.6-luna",
    );
    // Defense against a regression that omits or hardcodes the field:
    // assert the value flows through, not just the key's presence.
    expect(body.max_output_tokens).toBeDefined();
    expect(body.max_output_tokens).toBeGreaterThan(0);
    expect(body.max_completion_tokens).toBeUndefined();
  });

  test("route discriminator: gpt-5.6-* → /responses; gpt-5-mini stays on /chat/completions", async () => {
    // Both calls go through the github-copilot provider — the discriminator is
    // the model id (`resolveWorkerProtocol` checks `isResponsesOnlyModel`).
    // Capture each from its distinct mockFetch.mock.calls[N] since the
    // helper returns calls[0] (the first mock call of its invocation).
    const client = createGatewayLLMClient(
      UPSTREAMS,
      (_sid, providerID) =>
        providerID === "github-copilot"
          ? { scheme: "bearer", value: "tok" }
          : null,
      { providerID: "github-copilot", modelID: "gpt-5.6-luna" },
    );
    await client.prompt("sys", "u", {
      sessionID: "sess-1",
      workerID: "lore-distill",
      model: { providerID: "github-copilot", modelID: "gpt-5.6-luna" },
      upstreamProviderID: "github-copilot",
    });
    const r1Url = fetchArgUrl(mockFetch.mock.calls[0]?.[0]);
    const r1Body = JSON.parse(
      String(
        (mockFetch.mock.calls[0]?.[1] as { body?: string } | undefined)?.body ??
          "{}",
      ),
    ) as Record<string, unknown>;
    expect(r1Url).toBe("https://api.githubcopilot.com/responses");
    expect(r1Body.input).toBeDefined();
    expect(r1Body.messages).toBeUndefined();

    // Second call uses the gpt-5-mini model → must stay on /chat/completions.
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion",
          choices: [{ message: { role: "assistant", content: "pong" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client2 = createGatewayLLMClient(
      UPSTREAMS,
      (_sid, providerID) =>
        providerID === "github-copilot"
          ? { scheme: "bearer", value: "tok" }
          : null,
      { providerID: "github-copilot", modelID: "gpt-5-mini" },
    );
    await client2.prompt("sys", "u", {
      sessionID: "sess-2",
      workerID: "lore-distill",
      model: { providerID: "github-copilot", modelID: "gpt-5-mini" },
      upstreamProviderID: "github-copilot",
    });
    const r2Url = fetchArgUrl(mockFetch.mock.calls[1]?.[0]);
    const r2Body = JSON.parse(
      String(
        (mockFetch.mock.calls[1]?.[1] as { body?: string } | undefined)?.body ??
          "{}",
      ),
    ) as Record<string, unknown>;
    expect(r2Url).toBe("https://api.githubcopilot.com/chat/completions");
    expect(r2Body.messages).toBeDefined();
    expect(r2Body.input).toBeUndefined();
  });

  test("unsupported_api_for_model rebuilds and retries via the alternate protocol", async () => {
    mockFetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { code: "unsupported_api_for_model" } }),
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(responsesOkResponse("alternate worked"));

    const model = { providerID: "github-copilot", modelID: "future-model" };
    const client = createGatewayLLMClient(
      UPSTREAMS,
      () => ({ scheme: "bearer", value: "tok" }),
      model,
    );
    const outcome = await client.promptDetailed("sys", "user", {
      sessionID: "sess-alternate-protocol",
      workerID: "lore-invariant-check",
      model,
      upstreamProviderID: "github-copilot",
    });

    expect(outcome).toMatchObject({
      kind: "success",
      text: "alternate worked",
      protocol: "openai-responses",
      attempts: 2,
    });
    expect(fetchArgUrl(mockFetch.mock.calls[0]?.[0])).toBe(
      "https://api.githubcopilot.com/chat/completions",
    );
    expect(fetchArgUrl(mockFetch.mock.calls[1]?.[0])).toBe(
      "https://api.githubcopilot.com/responses",
    );
    const alternateBody = JSON.parse(
      String((mockFetch.mock.calls[1]?.[1] as { body?: string })?.body ?? "{}"),
    ) as Record<string, unknown>;
    expect(alternateBody.input).toBeDefined();
    expect(alternateBody.messages).toBeUndefined();
  });

  test("alternate-protocol rebuild reapplies the serialized request cap", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { code: "unsupported_api_for_model" } }),
        { status: 400 },
      ),
    );
    const model = { providerID: "github-copilot", modelID: "future-model" };
    const client = createGatewayLLMClient(
      UPSTREAMS,
      () => ({ scheme: "bearer", value: "tok" }),
      model,
    );

    const outcome = await client.promptDetailed("", "\u0000".repeat(699_029), {
      sessionID: "sess-alternate-protocol-cap",
      workerID: "lore-invariant-check",
      model,
      maxTokens: 4096,
      upstreamProviderID: "github-copilot",
    });

    expect(outcome.kind).toBe("failure");
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(
      Buffer.byteLength(
        String((mockFetch.mock.calls[0]?.[1] as { body?: string })?.body ?? ""),
      ),
    ).toBeLessThanOrEqual(4 * 1024 * 1024);
  });

  test("model fallback recomputes Responses protocol for a chat-only backup", async () => {
    mockFetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: { code: "model_not_supported", message: "not available" },
          }),
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "backup worked" } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

    const client = createGatewayLLMClient(
      UPSTREAMS,
      () => ({ scheme: "bearer", value: "tok" }),
      { providerID: "github-copilot", modelID: "gpt-5.6-luna" },
    );
    const outcome = await client.promptDetailed("sys", "user", {
      sessionID: "sess-mixed-protocol-fallback",
      workerID: "lore-invariant-check",
      model: { providerID: "github-copilot", modelID: "gpt-5.6-luna" },
      upstreamProviderID: "github-copilot",
    });

    expect(outcome).toMatchObject({
      kind: "success",
      text: "backup worked",
      protocol: "openai",
      attempts: 2,
    });
    expect(fetchArgUrl(mockFetch.mock.calls[0]?.[0])).toBe(
      "https://api.githubcopilot.com/responses",
    );
    expect(fetchArgUrl(mockFetch.mock.calls[1]?.[0])).toBe(
      "https://api.githubcopilot.com/chat/completions",
    );
    const fallbackBody = JSON.parse(
      String((mockFetch.mock.calls[1]?.[1] as { body?: string })?.body ?? "{}"),
    ) as Record<string, unknown>;
    expect(fallbackBody.messages).toBeDefined();
    expect(fallbackBody.input).toBeUndefined();
  });
});
