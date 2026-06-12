/**
 * Regression tests for worker response parsing of reasoning models.
 *
 * Free/reasoning models commonly served on aggregators (OpenCode Zen, etc.) —
 * DeepSeek, Qwen-thinking, Nemotron, MiniMax — put their answer in a reasoning
 * field and leave the normal `content`/`text` block empty. Before the fix the
 * worker parsers returned `null`, which the adapter classified as an opaque
 * `no-response`, blocking background distillation/curation. These tests lock in
 * the reasoning-field fallback AND assert the normal path is unchanged.
 */
import { describe, test, expect } from "vitest";
import {
  parseOpenAIResponse,
  parseAnthropicResponse,
} from "../src/llm-adapter";

describe("parseOpenAIResponse — reasoning-model fallback", () => {
  test("positive: normal content body still parses unchanged", () => {
    const r = parseOpenAIResponse({
      choices: [{ message: { content: "the real answer" } }],
      model: "gpt-x",
    });
    expect(r.text).toBe("the real answer");
    expect(r.model).toBe("gpt-x");
  });

  test("falls back to reasoning_content when content is empty (DeepSeek/Qwen)", () => {
    const r = parseOpenAIResponse({
      choices: [
        {
          message: { content: "", reasoning_content: "answer in reasoning" },
          finish_reason: "stop",
        },
      ],
    });
    expect(r.text).toBe("answer in reasoning");
  });

  test("falls back to reasoning_content when content is missing", () => {
    const r = parseOpenAIResponse({
      choices: [{ message: { reasoning_content: "only reasoning here" } }],
    });
    expect(r.text).toBe("only reasoning here");
  });

  test("falls back to `reasoning` field (OpenRouter shape)", () => {
    const r = parseOpenAIResponse({
      choices: [{ message: { reasoning: "openrouter reasoning text" } }],
    });
    expect(r.text).toBe("openrouter reasoning text");
  });

  test("prefers content over reasoning when both present", () => {
    const r = parseOpenAIResponse({
      choices: [
        {
          message: {
            content: "primary",
            reasoning_content: "secondary",
          },
        },
      ],
    });
    expect(r.text).toBe("primary");
  });

  test("negative: genuinely empty body still returns null (real failure preserved)", () => {
    const r = parseOpenAIResponse({ choices: [{ message: {} }] });
    expect(r.text).toBeNull();
  });

  test("non-string content (null) falls back to reasoning, never returned as text", () => {
    const r = parseOpenAIResponse({
      // content null at runtime (some providers) — must not be returned as text
      choices: [
        {
          message: {
            content: null as unknown as string,
            reasoning_content: "fallback reasoning",
          },
        },
      ],
    });
    expect(r.text).toBe("fallback reasoning");
  });

  test("ignores a non-string reasoning field", () => {
    const r = parseOpenAIResponse({
      choices: [
        {
          message: {
            reasoning_content: 42 as unknown as string,
          },
        },
      ],
    });
    expect(r.text).toBeNull();
  });

  test("negative: no choices returns null", () => {
    const r = parseOpenAIResponse({});
    expect(r.text).toBeNull();
  });
});

describe("parseAnthropicResponse — thinking-block fallback", () => {
  test("positive: normal text block still parses unchanged", () => {
    const r = parseAnthropicResponse({
      content: [{ type: "text", text: "the real answer" }],
      model: "claude-x",
    });
    expect(r.text).toBe("the real answer");
    expect(r.model).toBe("claude-x");
  });

  test("falls back to thinking block when no text block exists", () => {
    const r = parseAnthropicResponse({
      content: [{ type: "thinking", thinking: "answer in thinking" }],
    });
    expect(r.text).toBe("answer in thinking");
  });

  test("prefers text block over thinking block", () => {
    const r = parseAnthropicResponse({
      content: [
        { type: "thinking", thinking: "secondary" },
        { type: "text", text: "primary" },
      ],
    });
    expect(r.text).toBe("primary");
  });

  test("negative: genuinely empty content still returns null", () => {
    const r = parseAnthropicResponse({ content: [] });
    expect(r.text).toBeNull();
  });

  test("negative: missing content returns null", () => {
    const r = parseAnthropicResponse({});
    expect(r.text).toBeNull();
  });
});
