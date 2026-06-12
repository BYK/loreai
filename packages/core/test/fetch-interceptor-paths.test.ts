/**
 * Tests for the fetch interceptor's LLM API path pattern matching (B3).
 *
 * The interceptor transparently reroutes LLM API calls through the Lore
 * gateway. It needs to recognize the standard LLM API paths plus common
 * aggregator variants (OpenRouter, etc.) so that X-Lore-* context headers
 * (project path, git remote, session ID) are injected for all of them.
 *
 * These tests are the regression coverage for the broadened pattern list
 * introduced to address the persistent "lore-config" bug for users whose
 * providers used a non-standard path prefix.
 */
import { describe, test, expect } from "vitest";
import { shouldIntercept } from "../src/fetch-interceptor";

const GATEWAY = "http://127.0.0.1:3207";

describe("shouldIntercept — LLM API path patterns", () => {
  describe("Anthropic paths (standard /v1/messages)", () => {
    test("matches /v1/messages", () => {
      expect(
        shouldIntercept("https://api.anthropic.com/v1/messages", GATEWAY),
      ).toBe(true);
    });

    test("matches /v1/messages with query string", () => {
      expect(
        shouldIntercept(
          "https://api.anthropic.com/v1/messages?beta=true",
          GATEWAY,
        ),
      ).toBe(true);
    });

    test("matches /v1/messages with sub-path", () => {
      expect(
        shouldIntercept("https://api.anthropic.com/v1/messages/foo", GATEWAY),
      ).toBe(true);
    });
  });

  describe("OpenAI Chat Completions (standard /v1/chat/completions)", () => {
    test("matches /v1/chat/completions", () => {
      expect(
        shouldIntercept("https://api.openai.com/v1/chat/completions", GATEWAY),
      ).toBe(true);
    });

    test("matches /v1/chat/completions with query string", () => {
      expect(
        shouldIntercept(
          "https://api.openai.com/v1/chat/completions?stream=true",
          GATEWAY,
        ),
      ).toBe(true);
    });
  });

  describe("OpenAI Responses API (standard /v1/responses)", () => {
    test("matches /v1/responses", () => {
      expect(
        shouldIntercept("https://api.openai.com/v1/responses", GATEWAY),
      ).toBe(true);
    });
  });

  describe("Aggregator paths (/api/v1/... — OpenRouter etc.)", () => {
    test("matches /api/v1/chat/completions (OpenRouter)", () => {
      expect(
        shouldIntercept(
          "https://openrouter.ai/api/v1/chat/completions",
          GATEWAY,
        ),
      ).toBe(true);
    });

    test("matches /api/v1/messages (some Anthropic-compatible providers)", () => {
      expect(
        shouldIntercept("https://api.example.com/api/v1/messages", GATEWAY),
      ).toBe(true);
    });

    test("matches /api/v1/responses (OpenAI-compatible aggregator)", () => {
      expect(
        shouldIntercept("https://api.example.com/api/v1/responses", GATEWAY),
      ).toBe(true);
    });
  });

  describe("Generic /api/... paths (no v1 segment)", () => {
    test("matches /api/chat/completions", () => {
      expect(
        shouldIntercept(
          "https://api.example.com/api/chat/completions",
          GATEWAY,
        ),
      ).toBe(true);
    });

    test("matches /api/messages", () => {
      expect(
        shouldIntercept("https://api.example.com/api/messages", GATEWAY),
      ).toBe(true);
    });
  });

  describe("Proxy paths (/openai/v1/... and /anthropic/v1/...)", () => {
    test("matches /openai/v1/chat/completions", () => {
      expect(
        shouldIntercept(
          "https://proxy.example.com/openai/v1/chat/completions",
          GATEWAY,
        ),
      ).toBe(true);
    });

    test("matches /anthropic/v1/messages", () => {
      expect(
        shouldIntercept(
          "https://proxy.example.com/anthropic/v1/messages",
          GATEWAY,
        ),
      ).toBe(true);
    });
  });

  describe("Codex (ChatGPT) /codex/responses paths", () => {
    test("matches /codex/responses on ChatGPT backend", () => {
      expect(
        shouldIntercept(
          "https://chatgpt.com/backend-api/codex/responses",
          GATEWAY,
        ),
      ).toBe(true);
    });

    test("matches /codex/responses with query string", () => {
      expect(
        shouldIntercept(
          "https://chatgpt.com/backend-api/codex/responses?foo=bar",
          GATEWAY,
        ),
      ).toBe(true);
    });

    test("matches /codex/responses on non-ChatGPT host", () => {
      expect(
        shouldIntercept("https://api.example.com/codex/responses", GATEWAY),
      ).toBe(true);
    });

    test("does NOT match /codex/foo", () => {
      expect(
        shouldIntercept("https://chatgpt.com/backend-api/codex/foo", GATEWAY),
      ).toBe(false);
    });
  });

  describe("Negative cases — non-LLM paths", () => {
    test("does NOT match /health", () => {
      expect(shouldIntercept("https://api.example.com/health", GATEWAY)).toBe(
        false,
      );
    });

    test("does NOT match /v1/models (not an LLM API call we route)", () => {
      // models endpoint isn't matched — it's metadata, not a request we
      // want to inject headers into. If we ever need to route it, add
      // 'models' to the patterns.
      expect(shouldIntercept("https://api.openai.com/v1/models", GATEWAY)).toBe(
        false,
      );
    });

    test("does NOT match arbitrary /v1/foo paths", () => {
      expect(
        shouldIntercept("https://api.example.com/v1/embeddings", GATEWAY),
      ).toBe(false);
    });

    test("does NOT match /api/foo/embeddings (sub-paths under /api/v1 don't match if no /v1/)", () => {
      expect(
        shouldIntercept("https://api.example.com/api/foo/embeddings", GATEWAY),
      ).toBe(false);
    });
  });

  describe("Localhost exclusion (infinite-loop prevention)", () => {
    test("does NOT intercept localhost (could be local LLM server)", () => {
      expect(
        shouldIntercept("http://localhost:8000/v1/messages", GATEWAY),
      ).toBe(false);
    });

    test("does NOT intercept 127.0.0.1", () => {
      expect(
        shouldIntercept("http://127.0.0.1:8000/v1/messages", GATEWAY),
      ).toBe(false);
    });

    test("does NOT intercept 0.0.0.0", () => {
      expect(shouldIntercept("http://0.0.0.0:8000/v1/messages", GATEWAY)).toBe(
        false,
      );
    });

    test("does NOT intercept ::1 (IPv6 loopback)", () => {
      expect(shouldIntercept("http://[::1]:8000/v1/messages", GATEWAY)).toBe(
        false,
      );
    });
  });

  describe("Gateway exclusion (intercepted requests must not loop)", () => {
    test("does NOT intercept requests already going to the gateway", () => {
      expect(
        shouldIntercept("http://127.0.0.1:3207/v1/messages", GATEWAY),
      ).toBe(false);
    });
  });

  describe("URL parsing error tolerance", () => {
    test("does NOT throw on malformed URLs", () => {
      expect(shouldIntercept("not a url", GATEWAY)).toBe(false);
    });

    test("does NOT throw on empty string", () => {
      expect(shouldIntercept("", GATEWAY)).toBe(false);
    });
  });
});
