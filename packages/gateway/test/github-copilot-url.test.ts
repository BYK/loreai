/**
 * Regression tests for issue #1052 — the `github-copilot` provider returned
 * `404 page not found` because the gateway unconditionally prepended `/v1/` when
 * forwarding upstream, but GitHub Copilot serves chat completions at the root
 * (`/chat/completions`, no `/v1` segment).
 *
 * Two mechanisms cooperate:
 *  1. `verbatimUpstreamUrl` — forwards foreground requests to the client's exact
 *     original endpoint (preserved by the fetch interceptor) when not
 *     translating/rerouting.
 *  2. `buildOpenAIChatCompletionsUrl` — host-aware reconstruction for paths with
 *     no original request (background workers / env-var providers).
 */
import { describe, test, expect } from "vitest";
import { extractUpstreamPathHeader, verbatimUpstreamUrl } from "../src/config";
import {
  buildOpenAIChatCompletionsUrl,
  buildOpenAIUpstreamRequest,
  isGitHubCopilotHost,
} from "../src/translate/openai";
import type { GatewayRequest } from "../src/translate/types";

// ---------------------------------------------------------------------------
// extractUpstreamPathHeader
// ---------------------------------------------------------------------------

describe("extractUpstreamPathHeader", () => {
  test("returns undefined when header is absent", () => {
    expect(extractUpstreamPathHeader({})).toBeUndefined();
    expect(
      extractUpstreamPathHeader({ "x-api-key": "sk-abc" }),
    ).toBeUndefined();
  });

  test("accepts a bare /chat/completions path", () => {
    expect(
      extractUpstreamPathHeader({
        "x-lore-upstream-path": "/chat/completions",
      }),
    ).toBe("/chat/completions");
  });

  test("accepts a prefixed /api/v1/chat/completions path", () => {
    expect(
      extractUpstreamPathHeader({
        "x-lore-upstream-path": "/api/v1/chat/completions",
      }),
    ).toBe("/api/v1/chat/completions");
  });

  test("rejects non-absolute paths", () => {
    expect(
      extractUpstreamPathHeader({ "x-lore-upstream-path": "chat/completions" }),
    ).toBeUndefined();
  });

  test("rejects protocol-relative //host (would imply a different host)", () => {
    expect(
      extractUpstreamPathHeader({ "x-lore-upstream-path": "//evil.com/x" }),
    ).toBeUndefined();
  });

  test("rejects path traversal", () => {
    expect(
      extractUpstreamPathHeader({ "x-lore-upstream-path": "/a/../b" }),
    ).toBeUndefined();
  });

  test("rejects whitespace", () => {
    expect(
      extractUpstreamPathHeader({ "x-lore-upstream-path": "/a b" }),
    ).toBeUndefined();
  });

  test("rejects over-length values", () => {
    expect(
      extractUpstreamPathHeader({
        "x-lore-upstream-path": `/${"a".repeat(600)}`,
      }),
    ).toBeUndefined();
  });

  test("strips control characters then validates", () => {
    expect(
      extractUpstreamPathHeader({
        "x-lore-upstream-path": "/chat/completions\n",
      }),
    ).toBe("/chat/completions");
  });
});

// ---------------------------------------------------------------------------
// verbatimUpstreamUrl
// ---------------------------------------------------------------------------

describe("verbatimUpstreamUrl", () => {
  const base = {
    reconstructedUrl: "https://api.githubcopilot.com/v1/chat/completions",
    effectiveUpstreamBase: "https://api.githubcopilot.com",
    headerUpstream: "https://api.githubcopilot.com",
    upstreamPath: "/chat/completions",
    effectiveProtocol: "openai" as const,
    ingressProtocol: "openai" as const,
  };

  test("forwards verbatim to Copilot's bare /chat/completions", () => {
    expect(verbatimUpstreamUrl(base)).toBe(
      "https://api.githubcopilot.com/chat/completions",
    );
  });

  test("anchors at the ORIGIN so a base prefix is never doubled", () => {
    // OpenRouter: base carries `/api`, and the full pathname already includes it.
    expect(
      verbatimUpstreamUrl({
        reconstructedUrl: "https://openrouter.ai/api/v1/chat/completions",
        effectiveUpstreamBase: "https://openrouter.ai/api",
        headerUpstream: "https://openrouter.ai/api",
        upstreamPath: "/api/v1/chat/completions",
        effectiveProtocol: "openai",
        ingressProtocol: "openai",
      }),
    ).toBe("https://openrouter.ai/api/v1/chat/completions");
  });

  test("standard /v1 path is unchanged (verbatim == reconstructed)", () => {
    expect(
      verbatimUpstreamUrl({
        reconstructedUrl: "https://api.openai.com/v1/chat/completions",
        effectiveUpstreamBase: "https://api.openai.com",
        headerUpstream: "https://api.openai.com",
        upstreamPath: "/v1/chat/completions",
        effectiveProtocol: "openai",
        ingressProtocol: "openai",
      }),
    ).toBe("https://api.openai.com/v1/chat/completions");
  });

  test("does NOT forward verbatim when translating protocols", () => {
    // anthropic ingress → openai egress: the original path is for the wrong wire.
    expect(
      verbatimUpstreamUrl({
        ...base,
        effectiveProtocol: "openai",
        ingressProtocol: "anthropic",
        upstreamPath: "/v1/messages",
      }),
    ).toBe(base.reconstructedUrl);
  });

  test("never overrides a vertex turn", () => {
    expect(
      verbatimUpstreamUrl({
        ...base,
        effectiveProtocol: "vertex",
        ingressProtocol: "vertex",
      }),
    ).toBe(base.reconstructedUrl);
  });

  test("reconstructs when there is no preserved path (worker/env-var)", () => {
    expect(verbatimUpstreamUrl({ ...base, upstreamPath: undefined })).toBe(
      base.reconstructedUrl,
    );
  });

  test("reconstructs when there is no upstream-url header (rerouted)", () => {
    expect(verbatimUpstreamUrl({ ...base, headerUpstream: undefined })).toBe(
      base.reconstructedUrl,
    );
  });

  test("reconstructs when the base is not a parseable URL", () => {
    expect(
      verbatimUpstreamUrl({ ...base, effectiveUpstreamBase: "not a url" }),
    ).toBe(base.reconstructedUrl);
  });
});

// ---------------------------------------------------------------------------
// buildOpenAIChatCompletionsUrl + buildOpenAIUpstreamRequest
// ---------------------------------------------------------------------------

describe("buildOpenAIChatCompletionsUrl", () => {
  test("GitHub Copilot host omits the /v1 segment", () => {
    expect(buildOpenAIChatCompletionsUrl("https://api.githubcopilot.com")).toBe(
      "https://api.githubcopilot.com/chat/completions",
    );
  });

  test("per-plan/regional Copilot hosts also omit /v1 (issue #1052 — individual/business/enterprise)", () => {
    for (const host of [
      "api.individual.githubcopilot.com",
      "api.business.githubcopilot.com",
      "api.enterprise.githubcopilot.com",
      "proxy.individual.githubcopilot.com",
    ]) {
      expect(buildOpenAIChatCompletionsUrl(`https://${host}`)).toBe(
        `https://${host}/chat/completions`,
      );
    }
  });

  test("a lookalike host that only CONTAINS the domain is NOT treated as Copilot", () => {
    // Guards against a naive substring match: this host ends in `.evil.example`,
    // so it must fall back to the standard /v1 form, not Copilot's root path.
    expect(
      buildOpenAIChatCompletionsUrl(
        "https://api.githubcopilot.com.evil.example",
      ),
    ).toBe("https://api.githubcopilot.com.evil.example/v1/chat/completions");
  });

  test("Google Gemini host uses the /v1beta/openai path (issue #1070)", () => {
    expect(
      buildOpenAIChatCompletionsUrl(
        "https://generativelanguage.googleapis.com",
      ),
    ).toBe(
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    );
  });

  test("standard provider keeps the /v1 segment", () => {
    expect(buildOpenAIChatCompletionsUrl("https://api.openai.com")).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
  });

  test("provider base with a path prefix keeps /v1 appended", () => {
    expect(buildOpenAIChatCompletionsUrl("https://api.groq.com/openai")).toBe(
      "https://api.groq.com/openai/v1/chat/completions",
    );
  });

  test("version-suffixed base appends only /chat/completions — Z.AI (issue #1093)", () => {
    // The user-supplied LORE_UPSTREAM_ZAI already carries the `/v4` version, so a
    // `/v1` prefix would double it (`.../v4/v1/chat/completions`) and 404.
    expect(buildOpenAIChatCompletionsUrl("https://api.z.ai/api/paas/v4")).toBe(
      "https://api.z.ai/api/paas/v4/chat/completions",
    );
  });

  test("version-suffixed base — Z.AI coding-plan prefix (issue #1093)", () => {
    expect(
      buildOpenAIChatCompletionsUrl("https://api.z.ai/api/coding/paas/v4"),
    ).toBe("https://api.z.ai/api/coding/paas/v4/chat/completions");
  });

  test("base already ending in /v1 is not doubled", () => {
    // A self-hosted server configured with an explicit `/v1` root: appending
    // only `/chat/completions` yields the correct single-`/v1` URL.
    expect(buildOpenAIChatCompletionsUrl("http://localhost:8000/v1")).toBe(
      "http://localhost:8000/v1/chat/completions",
    );
  });

  test("non-numeric version-like suffix does NOT trigger the rule", () => {
    // `/v1beta` is not a bare `/vN` segment (regex boundary guard): a host not in
    // the static map falls back to the conventional `/v1/chat/completions`.
    expect(buildOpenAIChatCompletionsUrl("https://example.com/v1beta")).toBe(
      "https://example.com/v1beta/v1/chat/completions",
    );
  });

  test("falls back to the /v1 form when the base is not a URL", () => {
    expect(buildOpenAIChatCompletionsUrl("not a url")).toBe(
      "not a url/v1/chat/completions",
    );
  });
});

describe("isGitHubCopilotHost", () => {
  test("matches the apex and every subdomain", () => {
    for (const h of [
      "githubcopilot.com",
      "api.githubcopilot.com",
      "api.individual.githubcopilot.com",
      "api.business.githubcopilot.com",
      "api.enterprise.githubcopilot.com",
      "proxy.individual.githubcopilot.com",
    ]) {
      expect(isGitHubCopilotHost(h)).toBe(true);
    }
  });

  test("does NOT match lookalikes or unrelated hosts", () => {
    for (const h of [
      "api.githubcopilot.com.evil.example",
      "notgithubcopilot.com",
      "api.openai.com",
      "githubcopilot.com.attacker.net",
    ]) {
      expect(isGitHubCopilotHost(h)).toBe(false);
    }
  });
});

describe("buildOpenAIUpstreamRequest — reconstructed URL is host-aware", () => {
  function makeReq(): GatewayRequest {
    return {
      protocol: "openai",
      model: "gpt-4",
      stream: false,
      maxTokens: 1000,
      metadata: {
        projectId: "test",
        projectPath: "/test",
        gitRemote: "test",
        gitRoot: "/test",
      },
      system: "system prompt",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [],
      rawHeaders: {},
    };
  }

  test("github-copilot base → no /v1 (issue #1052)", () => {
    expect(
      buildOpenAIUpstreamRequest(makeReq(), "https://api.githubcopilot.com")
        .url,
    ).toBe("https://api.githubcopilot.com/chat/completions");
  });

  test("openai base → /v1/chat/completions", () => {
    expect(
      buildOpenAIUpstreamRequest(makeReq(), "https://api.openai.com").url,
    ).toBe("https://api.openai.com/v1/chat/completions");
  });

  test("Z.AI versioned base → /v4/chat/completions (issue #1093)", () => {
    expect(
      buildOpenAIUpstreamRequest(makeReq(), "https://api.z.ai/api/paas/v4").url,
    ).toBe("https://api.z.ai/api/paas/v4/chat/completions");
  });
});
