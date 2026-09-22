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
import { digestChain } from "../src/chain-digest";
import { encodeContextBoundary } from "../src/context-boundary";

const GATEWAY = "http://127.0.0.1:3207";

type Captured = { url: string; init: RequestInit | undefined };

describe("installFetchInterceptor — end-to-end routing", () => {
  let cleanup: () => void;
  let captured: Captured | null;
  let realFetch: typeof globalThis.fetch;
  let observedAuthorization: string | null;
  let observedApiKey: string | null;

  beforeEach(() => {
    captured = null;
    observedAuthorization = null;
    observedApiKey = null;
    // Stub the underlying fetch so the interceptor calls into our capture.
    realFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = {
        url:
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url,
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
      onRequestHeaders: (headers) => {
        observedAuthorization = headers.get("authorization");
        observedApiKey = headers.get("x-api-key");
      },
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
      expect(observedAuthorization).toBe("Bearer sk-test");
    });

    test("observes auth on requests already targeting the gateway", async () => {
      await fetch(`${GATEWAY}/v1/messages`, {
        method: "POST",
        headers: { authorization: "Bearer direct" },
        body: JSON.stringify({ model: "claude", messages: [] }),
      });
      expect(observedAuthorization).toBe("Bearer direct");
      expect(captured?.url).toBe(`${GATEWAY}/v1/messages`);
    });

    test("observes both auth schemes without altering either", async () => {
      await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          authorization: "Bearer secondary",
          "x-api-key": "primary-key",
        },
        body: JSON.stringify({ model: "claude", messages: [] }),
      });
      expect(observedApiKey).toBe("primary-key");
      expect(observedAuthorization).toBe("Bearer secondary");
      expect(headerVal("x-api-key")).toBe("primary-key");
      expect(headerVal("authorization")).toBe("Bearer secondary");
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

describe("context continuation", () => {
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  test("reuses the gateway boundary and retries once after a mismatch", async () => {
    const prefix = [{ type: "message", role: "user", content: "old" }];
    const suffix = { type: "message", role: "user", content: "new" };
    const oldBoundary = encodeContextBoundary({
      v: 1,
      protocol: "openai-codex",
      inputItems: prefix.length,
      inputDigest: digestChain(prefix),
      retainedItems: 0,
      sourceMessages: 1,
      sourceDigest: digestChain([{ role: "user", content: "old" }]),
    });
    const freshBoundary = encodeContextBoundary({
      v: 1,
      protocol: "openai-codex",
      inputItems: 2,
      inputDigest: digestChain([...prefix, suffix]),
      retainedItems: 0,
      sourceMessages: 2,
      sourceDigest: digestChain([
        { role: "user", content: "old" },
        { role: "user", content: "new" },
      ]),
    });
    const calls: Array<{ url: string; headers: Headers; body?: unknown }> = [];
    let call = 0;
    const original = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({
          url:
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.href
                : input.url,
          headers: new Headers(init?.headers),
          body:
            typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        });
        call++;
        if (call === 2) {
          return new Response("boundary mismatch", {
            status: 409,
            headers: { "x-lore-context-boundary-mismatch": "true" },
          });
        }
        return new Response("ok", {
          status: 200,
          headers: {
            "x-lore-context-boundary": call === 1 ? oldBoundary : freshBoundary,
          },
        });
      },
    );
    globalThis.fetch = original;
    cleanup = installFetchInterceptor({
      gatewayBase: GATEWAY,
      getHeaders: () => ({ "x-lore-session-id": "sess-boundary" }),
    });

    const url = "https://chatgpt.com/backend-api/codex/responses";
    const firstInit = {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.6-codex", input: prefix }),
    };
    await (await fetch(url, firstInit)).text();
    const response = await fetch(url, {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-5.6-codex",
        input: [...prefix, suffix],
      }),
    });

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(3);
    expect(calls[0].headers.get("x-lore-context-boundary")).toBeNull();
    expect(calls[0].headers.get("x-lore-context-boundary-capability")).toBe(
      "v1",
    );
    expect(calls[1].headers.get("x-lore-context-boundary")).toBe(oldBoundary);
    expect(calls[1].headers.get("x-lore-context-boundary-capability")).toBe(
      "v1",
    );
    expect(calls[2].headers.get("x-lore-context-boundary")).toBeNull();
    expect(calls[2].headers.get("x-lore-context-boundary-capability")).toBe(
      "v1",
    );
    expect(calls[1].body).toMatchObject({ input: [suffix] });
    expect(calls[2].body).toMatchObject({ input: [...prefix, suffix] });
  });

  test("recovers when an older response reaches EOF after a newer boundary", async () => {
    const first = { type: "message", role: "user", content: "first" };
    const second = { type: "message", role: "user", content: "second" };
    const third = { type: "message", role: "user", content: "third" };
    const boundary = (items: unknown[]) =>
      encodeContextBoundary({
        v: 1,
        protocol: "openai-responses",
        inputItems: items.length,
        inputDigest: digestChain(items),
        retainedItems: 0,
        sourceMessages: items.length,
        sourceDigest: digestChain(items),
      });
    const olderBoundary = boundary([first]);
    const newerBoundary = boundary([first, second]);
    const finalBoundary = boundary([first, second, third]);
    const calls: Array<{ headers: Headers; body: Record<string, unknown> }> =
      [];
    globalThis.fetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (typeof init?.body !== "string") {
          throw new Error("expected a JSON string body");
        }
        calls.push({
          headers: new Headers(init.headers),
          body: JSON.parse(init.body) as Record<string, unknown>,
        });
        switch (calls.length) {
          case 1:
            return new Response("older", {
              headers: { "x-lore-context-boundary": olderBoundary },
            });
          case 2:
            return new Response("newer", {
              headers: { "x-lore-context-boundary": newerBoundary },
            });
          case 3:
            return new Response("boundary mismatch", {
              status: 409,
              headers: { "x-lore-context-boundary-mismatch": "true" },
            });
          default:
            return new Response("replayed", {
              headers: { "x-lore-context-boundary": finalBoundary },
            });
        }
      },
    );
    cleanup = installFetchInterceptor({
      gatewayBase: GATEWAY,
      getHeaders: () => ({ "x-lore-session-id": "sess-out-of-order" }),
    });
    const url = "https://api.openai.com/v1/responses";

    const olderResponse = await fetch(url, {
      method: "POST",
      body: JSON.stringify({ model: "gpt", input: [first] }),
    });
    const newerResponse = await fetch(url, {
      method: "POST",
      body: JSON.stringify({ model: "gpt", input: [first, second] }),
    });
    await newerResponse.text();
    await olderResponse.text();
    await (
      await fetch(url, {
        method: "POST",
        body: JSON.stringify({ model: "gpt", input: [first, second, third] }),
      })
    ).text();

    expect(calls).toHaveLength(4);
    expect(calls[2].headers.get("x-lore-context-boundary")).toBe(olderBoundary);
    expect(calls[2].body.input).toEqual([second, third]);
    expect(calls[3].headers.get("x-lore-context-boundary")).toBeNull();
    expect(calls[3].body.input).toEqual([first, second, third]);
  });

  test.each([
    {
      name: "Anthropic",
      url: "https://api.anthropic.com/v1/messages",
      protocol: "anthropic" as const,
      key: "messages" as const,
      prefix: [
        { role: "user", content: "old question" },
        { role: "assistant", content: "old answer" },
      ],
      suffix: { role: "user", content: "new question" },
      retainedItems: 0,
    },
    {
      name: "OpenAI Chat",
      url: "https://api.openai.com/v1/chat/completions",
      protocol: "openai" as const,
      key: "messages" as const,
      prefix: [
        { role: "system", content: "stable system" },
        { role: "user", content: "old question" },
        { role: "assistant", content: "old answer" },
      ],
      suffix: { role: "user", content: "new question" },
      retainedItems: 1,
    },
    {
      name: "OpenAI Responses",
      url: "https://api.openai.com/v1/responses",
      protocol: "openai-responses" as const,
      key: "input" as const,
      prefix: [
        { type: "message", role: "user", content: "old question" },
        { type: "message", role: "assistant", content: "old answer" },
      ],
      suffix: {
        type: "message",
        role: "user",
        content: "new question",
      },
      retainedItems: 0,
    },
    {
      name: "Gemini",
      url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent",
      protocol: "gemini" as const,
      key: "contents" as const,
      prefix: [
        { role: "user", parts: [{ text: "old question" }] },
        { role: "model", parts: [{ text: "old answer" }] },
      ],
      suffix: { role: "user", parts: [{ text: "new question" }] },
      retainedItems: 0,
    },
  ])("elides the verified $name prefix", async (fixture) => {
    const calls: Array<{ headers: Headers; body: Record<string, unknown> }> =
      [];
    const boundary = encodeContextBoundary({
      v: 1,
      protocol: fixture.protocol,
      inputItems: fixture.prefix.length,
      inputDigest: digestChain(fixture.prefix),
      retainedItems: fixture.retainedItems,
      sourceMessages: fixture.prefix.length - fixture.retainedItems,
      sourceDigest: digestChain([]),
    });
    globalThis.fetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (typeof init?.body !== "string") {
          throw new Error("expected a JSON string body");
        }
        calls.push({
          headers: new Headers(init?.headers),
          body: JSON.parse(init.body) as Record<string, unknown>,
        });
        return new Response("ok", {
          headers: { "x-lore-context-boundary": boundary },
        });
      },
    );
    cleanup = installFetchInterceptor({
      gatewayBase: GATEWAY,
      getHeaders: () => ({
        "x-lore-session-id": `sess-${fixture.protocol}`,
      }),
    });

    await (
      await fetch(fixture.url, {
        method: "POST",
        body: JSON.stringify({
          model: "model",
          [fixture.key]: fixture.prefix,
        }),
      })
    ).text();
    await (
      await fetch(fixture.url, {
        method: "POST",
        body: JSON.stringify({
          model: "model",
          [fixture.key]: [...fixture.prefix, fixture.suffix],
        }),
      })
    ).text();

    expect(calls).toHaveLength(2);
    expect(calls[0].headers.get("x-lore-context-boundary-capability")).toBe(
      "v1",
    );
    expect(calls[1].headers.get("x-lore-context-boundary")).toBe(boundary);
    expect(calls[1].headers.get("x-lore-context-boundary-capability")).toBe(
      "v1",
    );
    expect(calls[1].body[fixture.key]).toEqual([
      ...fixture.prefix.slice(0, fixture.retainedItems),
      fixture.suffix,
    ]);
  });

  test("never attaches a generation boundary to Responses compaction", async () => {
    const prefix = [{ type: "message", role: "user", content: "old" }];
    const suffix = { type: "message", role: "user", content: "new" };
    const boundary = encodeContextBoundary({
      v: 1,
      protocol: "openai-responses",
      inputItems: prefix.length,
      inputDigest: digestChain(prefix),
      retainedItems: 0,
      sourceMessages: 1,
      sourceDigest: digestChain([{ role: "user", content: "old" }]),
    });
    const calls: Array<{
      url: string;
      headers: Headers;
      body: Record<string, unknown>;
    }> = [];
    globalThis.fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (typeof init?.body !== "string") {
          throw new Error("expected a JSON string body");
        }
        calls.push({
          url:
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.href
                : input.url,
          headers: new Headers(init.headers),
          body: JSON.parse(init.body) as Record<string, unknown>,
        });
        return new Response("ok", {
          headers:
            calls.length === 1
              ? { "x-lore-context-boundary": boundary }
              : undefined,
        });
      },
    );
    cleanup = installFetchInterceptor({
      gatewayBase: GATEWAY,
      getHeaders: () => ({ "x-lore-session-id": "sess-responses-compact" }),
    });

    await (
      await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        body: JSON.stringify({ model: "gpt", input: prefix }),
      })
    ).text();
    const fullInput = [...prefix, suffix];
    await (
      await fetch("https://api.openai.com/v1/responses/compact", {
        method: "POST",
        headers: { "x-lore-context-boundary-capability": "v1" },
        body: JSON.stringify({ model: "gpt", input: fullInput }),
      })
    ).text();

    expect(calls[1].url).toBe(`${GATEWAY}/v1/responses/compact`);
    expect(calls[1].headers.get("x-lore-context-boundary")).toBeNull();
    expect(
      calls[1].headers.get("x-lore-context-boundary-capability"),
    ).toBeNull();
    expect(calls[1].body.input).toEqual(fullInput);
  });

  test("sends the full body when the cached prefix was edited", async () => {
    const prefix = [{ role: "user", content: "original" }];
    const boundary = encodeContextBoundary({
      v: 1,
      protocol: "anthropic",
      inputItems: 1,
      inputDigest: digestChain(prefix),
      retainedItems: 0,
      sourceMessages: 1,
      sourceDigest: digestChain([]),
    });
    const calls: Array<{ headers: Headers; body: unknown }> = [];
    globalThis.fetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (typeof init?.body !== "string") {
          throw new Error("expected a JSON string body");
        }
        calls.push({
          headers: new Headers(init?.headers),
          body: JSON.parse(init.body),
        });
        return new Response("ok", {
          headers:
            calls.length === 1
              ? { "x-lore-context-boundary": boundary }
              : undefined,
        });
      },
    );
    cleanup = installFetchInterceptor({
      gatewayBase: GATEWAY,
      getHeaders: () => ({ "x-lore-session-id": "sess-edited" }),
    });
    const url = "https://api.anthropic.com/v1/messages";
    await (
      await fetch(url, {
        method: "POST",
        body: JSON.stringify({ model: "claude", messages: prefix }),
      })
    ).text();
    const edited = [
      { role: "user", content: "edited" },
      { role: "user", content: "new" },
    ];
    await (
      await fetch(url, {
        method: "POST",
        body: JSON.stringify({ model: "claude", messages: edited }),
      })
    ).text();

    expect(calls[1].headers.get("x-lore-context-boundary")).toBeNull();
    expect(calls[1].body).toMatchObject({ messages: edited });
  });

  test("does not cache a boundary from a cancelled response", async () => {
    const prefix = [{ role: "user", content: "old" }];
    const boundary = encodeContextBoundary({
      v: 1,
      protocol: "anthropic",
      inputItems: 1,
      inputDigest: digestChain(prefix),
      retainedItems: 0,
      sourceMessages: 1,
      sourceDigest: digestChain([]),
    });
    const headers: Headers[] = [];
    globalThis.fetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        headers.push(new Headers(init?.headers));
        return new Response("not consumed", {
          headers: { "x-lore-context-boundary": boundary },
        });
      },
    );
    cleanup = installFetchInterceptor({
      gatewayBase: GATEWAY,
      getHeaders: () => ({ "x-lore-session-id": "sess-cancelled" }),
    });
    const url = "https://api.anthropic.com/v1/messages";
    const first = await fetch(url, {
      method: "POST",
      body: JSON.stringify({ model: "claude", messages: prefix }),
    });
    await first.body?.cancel();
    await (
      await fetch(url, {
        method: "POST",
        body: JSON.stringify({
          model: "claude",
          messages: [...prefix, { role: "user", content: "new" }],
        }),
      })
    ).text();

    expect(headers[1].get("x-lore-context-boundary")).toBeNull();
  });

  test("does not await non-settling upstream cleanup when cancelling", async () => {
    const prefix = [{ role: "user", content: "old" }];
    const boundary = encodeContextBoundary({
      v: 1,
      protocol: "anthropic",
      inputItems: 1,
      inputDigest: digestChain(prefix),
      retainedItems: 0,
      sourceMessages: 1,
      sourceDigest: digestChain([]),
    });
    let releaseUpstreamCancel!: () => void;
    const upstreamCancelBlocked = new Promise<void>((resolve) => {
      releaseUpstreamCancel = resolve;
    });
    let upstreamCancelCalled = false;
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("partial"));
          },
          cancel() {
            upstreamCancelCalled = true;
            return upstreamCancelBlocked;
          },
        }),
        { headers: { "x-lore-context-boundary": boundary } },
      );
    });
    cleanup = installFetchInterceptor({
      gatewayBase: GATEWAY,
      getHeaders: () => ({ "x-lore-session-id": "sess-hostile-cancel" }),
    });

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "claude", messages: prefix }),
    });
    const responseBody = response.body;
    if (!responseBody) throw new Error("missing response body");
    let cancelSettled = false;
    const cancel = responseBody.cancel().then(() => {
      cancelSettled = true;
    });

    try {
      await vi.waitFor(() => expect(upstreamCancelCalled).toBe(true));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(cancelSettled).toBe(true);
    } finally {
      releaseUpstreamCancel();
      await cancel;
    }
  });

  test("preserves fetch-managed response metadata and clone metadata", async () => {
    const prefix = [{ role: "user", content: "old" }];
    const boundary = encodeContextBoundary({
      v: 1,
      protocol: "anthropic",
      inputItems: 1,
      inputDigest: digestChain(prefix),
      retainedItems: 0,
      sourceMessages: 1,
      sourceDigest: digestChain([]),
    });
    globalThis.fetch = vi.fn(async () => {
      const response = new Response("ok", {
        headers: { "x-lore-context-boundary": boundary },
      });
      Object.defineProperties(response, {
        url: { configurable: true, value: "https://provider.test/final" },
        redirected: { configurable: true, value: true },
        type: { configurable: true, value: "cors" },
      });
      return response;
    });
    cleanup = installFetchInterceptor({
      gatewayBase: GATEWAY,
      getHeaders: () => ({ "x-lore-session-id": "sess-response-metadata" }),
    });

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "claude", messages: prefix }),
    });
    const clone = response.clone();

    for (const candidate of [response, clone]) {
      expect(candidate.url).toBe("https://provider.test/final");
      expect(candidate.redirected).toBe(true);
      expect(candidate.type).toBe("cors");
    }
    await expect(Promise.all([response.text(), clone.text()])).resolves.toEqual(
      ["ok", "ok"],
    );
  });

  test("preserves fetch(Request) and does not attach an unreplayable boundary", async () => {
    const calls: Array<{
      method: string | undefined;
      body: string | undefined;
      boundary: string | null;
    }> = [];
    let call = 0;
    const original = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        calls.push({
          method: request.method,
          body: request.body ? await request.text() : undefined,
          boundary: request.headers.get("x-lore-context-boundary"),
        });
        call++;
        return new Response("ok", {
          status: 200,
          headers:
            call === 1
              ? {
                  "x-lore-context-boundary": encodeContextBoundary({
                    v: 1,
                    protocol: "openai-codex",
                    inputItems: 0,
                    inputDigest: digestChain([]),
                    retainedItems: 0,
                    sourceMessages: 0,
                    sourceDigest: digestChain([]),
                  }),
                }
              : undefined,
        });
      },
    );
    globalThis.fetch = original;
    cleanup = installFetchInterceptor({
      gatewayBase: GATEWAY,
      getHeaders: () => ({ "x-lore-session-id": "sess-request" }),
    });

    const url = "https://chatgpt.com/backend-api/codex/responses";
    await (
      await fetch(url, {
        method: "POST",
        body: JSON.stringify({ model: "gpt-5.6-codex", input: [] }),
      })
    ).text();
    const requestBody = JSON.stringify({
      model: "gpt-5.6-codex",
      input: [{ type: "message", role: "user", content: "continue" }],
    });
    await (
      await fetch(
        new Request(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: requestBody,
        }),
      )
    ).text();

    expect(calls[1]).toEqual({
      method: "POST",
      body: requestBody,
      boundary: null,
    });
  });
});
