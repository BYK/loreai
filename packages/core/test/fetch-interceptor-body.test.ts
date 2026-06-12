/**
 * Tests for the fetch interceptor's body-shape protocol detection.
 *
 * When a URL doesn't match any known LLM API path pattern but the path
 * looks LLM-like (contains /messages, /chat/completions, or /responses),
 * the interceptor inspects the request body JSON to detect the protocol
 * by its unique per-protocol identifiers.
 */
import { describe, test, expect } from "vitest";
import {
  shouldIntercept,
  detectProtocolFromBody,
} from "../src/fetch-interceptor";

const GATEWAY = "http://127.0.0.1:3207";

describe("detectProtocolFromBody", () => {
  describe("openai-responses — distinctive markers", () => {
    test("detects via `input` array", () => {
      expect(
        detectProtocolFromBody(JSON.stringify({ model: "gpt-4", input: [] })),
      ).toBe("openai-responses");
    });

    test("detects via `max_output_tokens`", () => {
      expect(
        detectProtocolFromBody(
          JSON.stringify({ model: "gpt-4", max_output_tokens: 100 }),
        ),
      ).toBe("openai-responses");
    });

    test("detects via `previous_response_id`", () => {
      expect(
        detectProtocolFromBody(
          JSON.stringify({ model: "gpt-4", previous_response_id: "resp_123" }),
        ),
      ).toBe("openai-responses");
    });

    test("`input` array wins even alongside a `messages` field", () => {
      expect(
        detectProtocolFromBody(
          JSON.stringify({ model: "gpt-4", input: [], messages: [] }),
        ),
      ).toBe("openai-responses");
    });

    // Ambiguous fields are intentionally NOT used as markers — `store` and
    // `instructions` appear in some Chat Completions extensions, so a body
    // carrying only those is NOT classified as openai-responses.
    test("does NOT classify `store`-only Chat body as openai-responses", () => {
      expect(
        detectProtocolFromBody(
          JSON.stringify({
            model: "gpt-4",
            store: true,
            messages: [{ role: "user", content: "Hi" }],
          }),
        ),
      ).toBe("openai");
    });

    test("does NOT classify `instructions`-only Chat body as openai-responses", () => {
      expect(
        detectProtocolFromBody(
          JSON.stringify({
            model: "gpt-4",
            instructions: "be brief",
            messages: [{ role: "user", content: "Hi" }],
          }),
        ),
      ).toBe("openai");
    });
  });

  describe("anthropic — unique marker: top-level system field", () => {
    test("detects `system` + `messages` as anthropic", () => {
      expect(
        detectProtocolFromBody(
          JSON.stringify({
            model: "claude-sonnet-4-20250514",
            system: "You are helpful.",
            messages: [{ role: "user", content: "Hi" }],
          }),
        ),
      ).toBe("anthropic");
    });

    test("detects `system` (array form) + `messages` as anthropic", () => {
      expect(
        detectProtocolFromBody(
          JSON.stringify({
            model: "claude-sonnet-4-20250514",
            system: [{ type: "text", text: "You are helpful." }],
            messages: [{ role: "user", content: "Hi" }],
            max_tokens: 1024,
          }),
        ),
      ).toBe("anthropic");
    });

    test("does NOT detect as anthropic when `system` is absent", () => {
      expect(
        detectProtocolFromBody(
          JSON.stringify({
            model: "claude-sonnet-4-20250514",
            messages: [{ role: "user", content: "Hi" }],
          }),
        ),
      ).toBe("openai");
    });
  });

  describe("openai — fallback: model + messages", () => {
    test("detects `model` + `messages` as openai", () => {
      expect(
        detectProtocolFromBody(
          JSON.stringify({
            model: "gpt-4",
            messages: [{ role: "user", content: "Hi" }],
          }),
        ),
      ).toBe("openai");
    });

    test("detects openai even with extra fields", () => {
      expect(
        detectProtocolFromBody(
          JSON.stringify({
            model: "gpt-4",
            messages: [{ role: "user", content: "Hi" }],
            temperature: 0.7,
          }),
        ),
      ).toBe("openai");
    });
  });

  describe("negative cases", () => {
    test("returns null for empty object", () => {
      expect(detectProtocolFromBody("{}")).toBeNull();
    });

    test("returns null when model is missing", () => {
      expect(
        detectProtocolFromBody(
          JSON.stringify({ messages: [{ role: "user", content: "Hi" }] }),
        ),
      ).toBeNull();
    });

    test("returns null when messages is not an array", () => {
      expect(
        detectProtocolFromBody(
          JSON.stringify({ model: "gpt-4", messages: "hi" }),
        ),
      ).toBeNull();
    });

    test("returns null for a prompt-based body (not an LLM API body)", () => {
      expect(
        detectProtocolFromBody(JSON.stringify({ model: "gpt-4", prompt: "" })),
      ).toBeNull();
    });

    test("returns null for invalid JSON", () => {
      expect(detectProtocolFromBody("not json")).toBeNull();
    });

    test("returns null for null body", () => {
      expect(detectProtocolFromBody("null")).toBeNull();
    });

    test("returns null for array body", () => {
      expect(detectProtocolFromBody("[]")).toBeNull();
    });
  });
});

describe("shouldIntercept — Codex path recognition", () => {
  test("matches chatgpt.com/backend-api/codex/responses", () => {
    expect(
      shouldIntercept(
        "https://chatgpt.com/backend-api/codex/responses",
        GATEWAY,
      ),
    ).toBe(true);
  });

  test("matches with query string", () => {
    expect(
      shouldIntercept(
        "https://chatgpt.com/backend-api/codex/responses?stream=true",
        GATEWAY,
      ),
    ).toBe(true);
  });

  test("does NOT match /codex/foo", () => {
    expect(
      shouldIntercept("https://chatgpt.com/backend-api/codex/foo", GATEWAY),
    ).toBe(false);
  });

  test("does NOT match gateway URLs", () => {
    expect(
      shouldIntercept("http://127.0.0.1:3207/v1/codex/responses", GATEWAY),
    ).toBe(false);
  });
});
