/**
 * End-to-end tests for installFetchInterceptor.
 *
 * These exercise the actual interception flow — URL rewriting, header
 * injection, X-Lore-Upstream-URL derivation, and the body-shape fallback —
 * by installing the interceptor over a stubbed originalFetch and asserting
 * what URL/headers/body the gateway would receive.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import {
  installFetchInterceptor,
  interceptUrlForProtocol,
} from "../src/fetch-interceptor";

const GATEWAY = "http://127.0.0.1:3207";

type Captured = { url: string; init: RequestInit | undefined };

describe("installFetchInterceptor — end-to-end routing", () => {
  let cleanup: () => void;
  let captured: Captured | null;
  let realFetch: typeof globalThis.fetch;

  beforeEach(() => {
    captured = null;
    // Stub the underlying fetch so the interceptor calls into our capture.
    realFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = {
        url: typeof input === "string" ? input : input.toString(),
        init,
      };
      return new Response("ok", { status: 200 });
    });
    globalThis.fetch = realFetch;

    cleanup = installFetchInterceptor({
      gatewayBase: GATEWAY,
      getHeaders: () => ({
        "x-lore-session-id": "sess-123",
        "x-lore-project": "/home/me/proj",
      }),
    });
  });

  afterEach(() => {
    cleanup();
  });

  function headerVal(name: string): string | null {
    const h = captured?.init?.headers;
    return h ? new Headers(h).get(name) : null;
  }

  describe("Path 1 — URL-matched interception", () => {
    test("rewrites Anthropic /v1/messages to gateway + sets upstream base", async () => {
      await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        body: JSON.stringify({ model: "claude", messages: [] }),
      });
      expect(captured?.url).toBe(`${GATEWAY}/v1/messages`);
      expect(headerVal("x-lore-upstream-url")).toBe(
        "https://api.anthropic.com",
      );
    });

    test("rewrites Codex /backend-api/codex/responses → /v1/codex/responses", async () => {
      await fetch("https://chatgpt.com/backend-api/codex/responses", {
        method: "POST",
        body: JSON.stringify({ model: "gpt-5", input: [] }),
      });
      expect(captured?.url).toBe(`${GATEWAY}/v1/codex/responses`);
      // The crux of the fix: upstream base must be origin + /backend-api so
      // the gateway forwards to ChatGPT's codex endpoint.
      expect(headerVal("x-lore-upstream-url")).toBe(
        "https://chatgpt.com/backend-api",
      );
    });

    test("preserves original headers and injects X-Lore-* context", async () => {
      await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer sk-test" },
        body: JSON.stringify({ model: "gpt-4", messages: [] }),
      });
      expect(headerVal("authorization")).toBe("Bearer sk-test");
      expect(headerVal("x-lore-session-id")).toBe("sess-123");
      expect(headerVal("x-lore-project")).toBe("/home/me/proj");
    });

    test("forwards the original body intact", async () => {
      const body = JSON.stringify({ model: "gpt-4", messages: [{ x: 1 }] });
      await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        body,
      });
      expect(captured?.init?.body).toBe(body);
    });

    test("aggregator /api/v1/chat/completions keeps the /v1/ prefix path", async () => {
      await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "x", messages: [] }),
      });
      expect(captured?.url).toBe(`${GATEWAY}/v1/chat/completions`);
      expect(headerVal("x-lore-upstream-url")).toBe(
        "https://openrouter.ai/api",
      );
    });
  });

  describe("Path 2 — body-shape fallback for non-standard paths", () => {
    test("routes a non-standard /v2/chat/completions via detected openai protocol", async () => {
      await fetch("https://api.example.com/v2/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "gpt-4", messages: [] }),
      });
      // Routed to the canonical OpenAI Chat gateway endpoint
      expect(captured?.url).toBe(`${GATEWAY}/v1/chat/completions`);
      // Upstream base strips the recognized endpoint suffix
      expect(headerVal("x-lore-upstream-url")).toBe(
        "https://api.example.com/v2",
      );
      expect(headerVal("x-lore-session-id")).toBe("sess-123");
    });

    test("routes a non-standard /llm/messages via detected anthropic protocol", async () => {
      await fetch("https://proxy.example.com/llm/messages", {
        method: "POST",
        body: JSON.stringify({
          model: "claude",
          system: "be brief",
          messages: [],
        }),
      });
      expect(captured?.url).toBe(`${GATEWAY}/v1/messages`);
      expect(headerVal("x-lore-upstream-url")).toBe(
        "https://proxy.example.com/llm",
      );
    });

    test("routes a non-standard /custom/responses via detected responses protocol", async () => {
      await fetch("https://api.example.com/custom/responses", {
        method: "POST",
        body: JSON.stringify({ model: "gpt-5", input: [] }),
      });
      expect(captured?.url).toBe(`${GATEWAY}/v1/responses`);
      expect(headerVal("x-lore-upstream-url")).toBe(
        "https://api.example.com/custom",
      );
    });

    test("detects from an ArrayBuffer-backed (Uint8Array) body", async () => {
      const json = JSON.stringify({ model: "gpt-4", messages: [] });
      await fetch("https://api.example.com/v2/chat/completions", {
        method: "POST",
        body: new TextEncoder().encode(json),
      });
      expect(captured?.url).toBe(`${GATEWAY}/v1/chat/completions`);
    });

    test("does NOT intercept when body shape is unrecognized", async () => {
      await fetch("https://api.example.com/v2/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "gpt-4", prompt: "hi" }),
      });
      // Passed through untouched (still the original URL)
      expect(captured?.url).toBe("https://api.example.com/v2/chat/completions");
      expect(headerVal("x-lore-upstream-url")).toBeNull();
    });

    test("does NOT intercept a streaming body it cannot read", async () => {
      const stream = new ReadableStream();
      await fetch("https://api.example.com/v2/chat/completions", {
        method: "POST",
        body: stream,
        // @ts-expect-error duplex required for stream bodies in Node fetch
        duplex: "half",
      }).catch(() => {});
      // Either passed through untouched or never rewritten to gateway.
      expect(captured?.url).not.toBe(`${GATEWAY}/v1/chat/completions`);
    });
  });

  describe("x-lore-upstream-path — original endpoint preservation (#1052)", () => {
    test("GitHub Copilot /chat/completions (no /v1) preserves the bare path", async () => {
      // Body-detected (Path 2): Copilot's endpoint has no /v1/ segment, so the
      // URL patterns miss and we fall back to body-shape detection.
      await fetch("https://api.githubcopilot.com/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "gpt-4", messages: [] }),
      });
      expect(captured?.url).toBe(`${GATEWAY}/v1/chat/completions`);
      expect(headerVal("x-lore-upstream-url")).toBe(
        "https://api.githubcopilot.com",
      );
      // The crux of #1052: the gateway must learn the real endpoint omits /v1/.
      expect(headerVal("x-lore-upstream-path")).toBe("/chat/completions");
    });

    test("standard /v1/chat/completions carries the full /v1 path", async () => {
      await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "gpt-4", messages: [] }),
      });
      expect(headerVal("x-lore-upstream-path")).toBe("/v1/chat/completions");
    });

    test("aggregator /api/v1/... carries the FULL pathname (incl. prefix)", async () => {
      await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "x", messages: [] }),
      });
      // Full pathname (not the post-base suffix) so the gateway reconstructs the
      // original URL as origin + pathname without doubling the /api prefix.
      expect(headerVal("x-lore-upstream-path")).toBe(
        "/api/v1/chat/completions",
      );
    });

    test("Codex /backend-api/codex/responses carries the full pathname", async () => {
      await fetch("https://chatgpt.com/backend-api/codex/responses", {
        method: "POST",
        body: JSON.stringify({ model: "gpt-5", input: [] }),
      });
      expect(headerVal("x-lore-upstream-path")).toBe(
        "/backend-api/codex/responses",
      );
    });
  });

  describe("non-interception cases", () => {
    test("does not touch non-LLM URLs", async () => {
      await fetch("https://registry.npmjs.org/some-package");
      expect(captured?.url).toBe("https://registry.npmjs.org/some-package");
    });

    test("does not intercept local LLM servers", async () => {
      await fetch("http://localhost:8000/v1/messages", {
        method: "POST",
        body: JSON.stringify({ model: "x", messages: [] }),
      });
      expect(captured?.url).toBe("http://localhost:8000/v1/messages");
    });
  });
});

describe("interceptUrlForProtocol", () => {
  const gateway = new URL(GATEWAY);

  test("maps openai → /v1/chat/completions and strips endpoint suffix", () => {
    const r = interceptUrlForProtocol(
      new URL("https://api.example.com/v2/chat/completions"),
      gateway,
      "openai",
    );
    expect(r.gatewayUrl).toBe(`${GATEWAY}/v1/chat/completions`);
    expect(r.upstreamBase).toBe("https://api.example.com/v2");
    // upstreamPath is the FULL original pathname (for verbatim forwarding).
    expect(r.upstreamPath).toBe("/v2/chat/completions");
  });

  test("upstreamPath preserves a Copilot-style bare /chat/completions", () => {
    const r = interceptUrlForProtocol(
      new URL("https://api.githubcopilot.com/chat/completions"),
      gateway,
      "openai",
    );
    expect(r.upstreamBase).toBe("https://api.githubcopilot.com");
    expect(r.upstreamPath).toBe("/chat/completions");
  });

  test("maps anthropic → /v1/messages", () => {
    const r = interceptUrlForProtocol(
      new URL("https://proxy.example.com/llm/messages"),
      gateway,
      "anthropic",
    );
    expect(r.gatewayUrl).toBe(`${GATEWAY}/v1/messages`);
    expect(r.upstreamBase).toBe("https://proxy.example.com/llm");
  });

  test("maps openai-responses → /v1/responses", () => {
    const r = interceptUrlForProtocol(
      new URL("https://api.example.com/custom/responses"),
      gateway,
      "openai-responses",
    );
    expect(r.gatewayUrl).toBe(`${GATEWAY}/v1/responses`);
    expect(r.upstreamBase).toBe("https://api.example.com/custom");
  });

  test("preserves query string", () => {
    const r = interceptUrlForProtocol(
      new URL("https://api.example.com/v2/chat/completions?stream=true"),
      gateway,
      "openai",
    );
    expect(r.gatewayUrl).toBe(`${GATEWAY}/v1/chat/completions?stream=true`);
  });

  test("falls back to origin when no known endpoint suffix is present", () => {
    const r = interceptUrlForProtocol(
      new URL("https://api.example.com/weird/path"),
      gateway,
      "openai",
    );
    expect(r.upstreamBase).toBe("https://api.example.com");
  });
});
