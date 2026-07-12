import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { fetchArgUrl } from "./helpers/fetch-url";

// Structural / property-based guard against CROSS-PROVIDER COLLUSION on worker
// calls. This is the permanent regression net for the production incident where
// a configured `workerModel: minimax/MiniMax-M2.7` was sent to
// https://api.anthropic.com with the session's Anthropic api-key, looping on
// 401 "invalid x-api-key" with no backoff (auth errors don't retry) and pinning
// a CPU core.
//
// INVARIANT (must hold for EVERY provider, forever):
//   A worker model belonging to provider X must never have its request sent to
//   a DIFFERENT direct provider's endpoint (api.anthropic.com / api.openai.com).
//   It either routes to X's own endpoint (when a credential for X exists) or
//   fails closed (no upstream request) — but it never collides X's model with
//   Y's direct endpoint + Y's credential.
//
// This test drives the real `createGatewayLLMClient().prompt()` path across a
// matrix of (worker model provider × session/override provider) so that ANY
// future change to routing (resolveTarget, resolveWorkerProtocol, the guard) is
// caught if it reintroduces collusion.

vi.mock("../src/fetch", () => ({ upstreamFetch: vi.fn() }));
vi.mock("../src/worker-health", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/worker-health")>();
  return {
    ...actual,
    recordWorkerFailure: vi.fn(actual.recordWorkerFailure),
    markWorkerPaused: vi.fn(actual.markWorkerPaused),
  };
});

import { createGatewayLLMClient } from "../src/llm-adapter";
import { upstreamFetch } from "../src/fetch";
import { clearAllCosts } from "../src/cost-tracker";
import { resetBackgroundLimiter } from "../src/background-limiter";

const mockFetch = vi.mocked(upstreamFetch);

const UPSTREAMS = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
};

const DIRECT_HOSTS = ["api.anthropic.com", "api.openai.com"];

// Representative worker-model providers spanning the routing categories:
//  - direct providers (anthropic, openai)
//  - anthropic-protocol third parties with their own endpoint (minimax, fireworks)
//  - openai-protocol third parties (xai, deepseek)
//  - unknown provider (no route → must fail closed)
const WORKER_PROVIDERS: Array<{
  providerID: string;
  modelID: string;
  ownHost?: string; // present → routes here; absent → fail closed
}> = [
  {
    providerID: "anthropic",
    modelID: "claude-haiku-4-5",
    ownHost: "api.anthropic.com",
  },
  { providerID: "openai", modelID: "gpt-5-mini", ownHost: "api.openai.com" },
  { providerID: "minimax", modelID: "MiniMax-M2.7", ownHost: "api.minimax.io" },
  { providerID: "fireworks", modelID: "fw-model", ownHost: "api.fireworks.ai" },
  { providerID: "xai", modelID: "grok-x", ownHost: "api.x.ai" },
  {
    providerID: "deepseek",
    modelID: "deepseek-chat",
    ownHost: "api.deepseek.com",
  },
  { providerID: "totally-unknown-provider", modelID: "mystery-1" }, // no route
];

// Session/override providers the worker call might be "attached" to.
const SESSION_PROVIDERS = ["anthropic", "openai"] as const;

function okResponse() {
  return new Response(
    JSON.stringify({
      content: [{ type: "text", text: "ok" }],
      choices: [{ message: { content: "ok" } }],
      model: "m",
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        prompt_tokens: 1,
        completion_tokens: 1,
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("worker cross-provider routing matrix (structural guard)", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(okResponse());
  });
  afterEach(() => {
    mockFetch.mockReset();
    clearAllCosts();
    resetBackgroundLimiter();
  });

  for (const wp of WORKER_PROVIDERS) {
    for (const sessionProvider of SESSION_PROVIDERS) {
      const sessionHost =
        sessionProvider === "anthropic"
          ? "api.anthropic.com"
          : "api.openai.com";

      test(`worker=${wp.providerID} on ${sessionProvider} session never collides with the other direct provider`, async () => {
        // Provide a VALID, correctly-prefixed credential for the worker model's
        // provider so routing genuinely succeeds (not skipped by the protocol-
        // mismatch prefix guard) — this keeps the positive assertion below
        // non-vacuous. anthropic → sk-ant-; openai → sk- (non-ant); third
        // parties use a generic key (their host is exempt from the prefix
        // guard). The session/global cred is a foreign Anthropic key.
        const workerKey =
          wp.providerID === "anthropic"
            ? "sk-ant-worker"
            : wp.providerID === "openai"
              ? "sk-openai-worker"
              : "worker-key";
        const client = createGatewayLLMClient(
          UPSTREAMS,
          (_sid, providerID) =>
            providerID === wp.providerID
              ? { scheme: "api-key", value: workerKey }
              : { scheme: "api-key", value: "sk-ant-session" },
          { providerID: sessionProvider, modelID: "session-model" },
        );

        await client.prompt("system", "user", {
          sessionID: `sess-${wp.providerID}-${sessionProvider}`,
          workerID: "lore-distill",
          model: { providerID: wp.providerID, modelID: wp.modelID },
          // Simulate the session's endpoint override + its provider id.
          upstreamUrl: `https://${sessionHost}`,
          upstreamProviderID: sessionProvider,
          protocol: sessionProvider === "anthropic" ? "anthropic" : "openai",
        });

        // THE INVARIANT: no request may go to a direct provider host that the
        // worker model does NOT belong to.
        for (const call of mockFetch.mock.calls) {
          const url = fetchArgUrl(call[0]);
          for (const host of DIRECT_HOSTS) {
            const belongsToWorker = wp.ownHost === host;
            if (!belongsToWorker) {
              expect(url).not.toContain(host);
            }
          }
        }

        // Positive expectation (NON-vacuous): a routable provider with a valid
        // credential MUST make exactly one upstream call, to its OWN host. If a
        // regression makes such a provider fail closed (zero calls) or route to
        // a foreign host, this fails. Unknown/unroutable providers fail closed.
        if (wp.ownHost) {
          expect(mockFetch).toHaveBeenCalledTimes(1);
          expect(fetchArgUrl(mockFetch.mock.calls[0][0])).toContain(wp.ownHost);
        } else {
          expect(mockFetch).not.toHaveBeenCalled();
        }
      });
    }
  }

  test("anthropic worker request carries a user-agent (MiniMax rejects UA-less requests with a 401)", async () => {
    // A MiniMax session: worker routes to api.minimax.io with the MiniMax key.
    // Without a user-agent, MiniMax's anthropic-compat endpoint rejects the
    // request with a generic auth failure even though key+host are correct.
    const client = createGatewayLLMClient(
      UPSTREAMS,
      () => ({ scheme: "api-key", value: "mm-worker-key" }),
      { providerID: "minimax", modelID: "MiniMax-M2.7" },
    );

    await client.prompt("system", "user", {
      sessionID: "sess-minimax-ua",
      workerID: "lore-curator",
      model: { providerID: "minimax", modelID: "MiniMax-M2.7" },
      upstreamUrl: "https://api.minimax.io/anthropic",
      upstreamProviderID: "minimax",
      protocol: "anthropic",
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const opts = mockFetch.mock.calls[0][1] as {
      headers: Record<string, string>;
    };
    const headerKeys = Object.keys(opts.headers).map((k) => k.toLowerCase());
    expect(headerKeys).toContain("user-agent");
    expect(opts.headers["user-agent"]).toBeTruthy();
  });

  test("an unknown worker-model provider with no route ALWAYS fails closed (never falls back to a direct endpoint)", async () => {
    const client = createGatewayLLMClient(
      UPSTREAMS,
      () => ({ scheme: "api-key", value: "sk-ant-session" }),
      { providerID: "anthropic", modelID: "session-model" },
    );

    const result = await client.prompt("system", "user", {
      sessionID: "sess-unknown",
      workerID: "lore-distill",
      model: { providerID: "no-such-provider", modelID: "x" },
      upstreamUrl: "https://api.anthropic.com",
      upstreamProviderID: "anthropic",
      protocol: "anthropic",
    });

    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
