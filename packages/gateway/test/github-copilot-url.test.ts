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
import {
  extractUpstreamPathHeader,
  isUpstreamWithinBase,
  verbatimUpstreamUrl,
} from "../src/config";
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

  test("accepts an absolute request target with an encoded query", () => {
    expect(
      extractUpstreamPathHeader({
        "x-lore-upstream-path":
          "/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse&callback=https%3A%2F%2Fexample.com%2Fdone",
      }),
    ).toBe(
      "/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse&callback=https%3A%2F%2Fexample.com%2Fdone",
    );
  });

  test("accepts a request target above the former pathname-only limit", () => {
    const target = `/v1/messages?cursor=${"a".repeat(600)}`;
    expect(extractUpstreamPathHeader({ "x-lore-upstream-path": target })).toBe(
      target,
    );
  });

  test("treats literal dot segments in the query as opaque data", () => {
    expect(
      extractUpstreamPathHeader({
        "x-lore-upstream-path": "/v1/messages?relative=../next-page",
      }),
    ).toBe("/v1/messages?relative=../next-page");
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

  test("rejects fragments, which are never part of an HTTP request target", () => {
    expect(
      extractUpstreamPathHeader({
        "x-lore-upstream-path": "/v1/messages?ok=true#not-forwarded",
      }),
    ).toBeUndefined();
  });

  test("rejects over-length values", () => {
    expect(
      extractUpstreamPathHeader({
        "x-lore-upstream-path": `/${"a".repeat(2100)}`,
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

  test.each([
    {
      provider: "Anthropic",
      protocol: "anthropic" as const,
      origin: "https://api.anthropic.com",
      target: "/v1/messages?beta=tools%2Ccomputer-use",
    },
    {
      provider: "OpenAI Chat Completions",
      protocol: "openai" as const,
      origin: "https://api.openai.com",
      target: "/v1/chat/completions?api-version=2026-09-01",
    },
    {
      provider: "OpenAI Responses",
      protocol: "openai-responses" as const,
      origin: "https://api.openai.com",
      target: "/v1/responses?include=reasoning.encrypted_content",
    },
    {
      provider: "Codex",
      protocol: "openai-responses" as const,
      origin: "https://chatgpt.com",
      target: "/backend-api/codex/responses?conversation_id=conv-1",
    },
    {
      provider: "Gemini",
      protocol: "gemini" as const,
      origin: "https://generativelanguage.googleapis.com",
      target: "/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
    },
  ])(
    "preserves $provider's pathname + query",
    ({ protocol, origin, target }) => {
      expect(
        verbatimUpstreamUrl({
          reconstructedUrl: `${origin}/canonical-fallback`,
          effectiveUpstreamBase: origin,
          headerUpstream: origin,
          upstreamPath: target,
          effectiveProtocol: protocol,
          ingressProtocol: protocol,
        }),
      ).toBe(`${origin}${target}`);
    },
  );

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

describe("isUpstreamWithinBase", () => {
  test("checks the destination path while allowing an opaque query", () => {
    expect(
      isUpstreamWithinBase(
        "https://api.example.com/tenant-a/v1/messages?callback=https%3A%2F%2Fexample.net%2Fdone",
        "https://api.example.com/tenant-a",
      ),
    ).toBe(true);
  });

  test("does not let a query disguise a path outside the configured base", () => {
    expect(
      isUpstreamWithinBase(
        "https://api.example.com/tenant-ab/v1/messages?base=%2Ftenant-a",
        "https://api.example.com/tenant-a",
      ),
    ).toBe(false);
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
