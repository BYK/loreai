import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  normalizeAnthropicBaseUrl,
  resolveBackend,
  resolveJudgeBackend,
} from "./llm-backend";

describe("normalizeAnthropicBaseUrl", () => {
  test("passes a bare base through unchanged", () => {
    expect(normalizeAnthropicBaseUrl("https://api.anthropic.com")).toBe(
      "https://api.anthropic.com",
    );
  });

  test("strips a trailing slash", () => {
    expect(normalizeAnthropicBaseUrl("https://api.minimax.io/anthropic/")).toBe(
      "https://api.minimax.io/anthropic",
    );
  });

  test("strips a trailing /v1 so /v1/messages is not doubled", () => {
    expect(
      normalizeAnthropicBaseUrl("https://api.minimax.io/anthropic/v1"),
    ).toBe("https://api.minimax.io/anthropic");
    expect(
      normalizeAnthropicBaseUrl("https://api.minimax.io/anthropic/v1/"),
    ).toBe("https://api.minimax.io/anthropic");
  });

  test("strips a full messages endpoint so it is not appended twice", () => {
    expect(
      normalizeAnthropicBaseUrl("https://api.minimax.io/anthropic/v1/messages"),
    ).toBe("https://api.minimax.io/anthropic");
  });
});

describe("resolveBackend ANTHROPIC_BASE_URL", () => {
  const saved = {
    key: process.env.ANTHROPIC_API_KEY,
    base: process.env.ANTHROPIC_BASE_URL,
    openai: process.env.OPENAI_API_KEY,
    gha: process.env.GITHUB_ACTIONS,
  };

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.OPENAI_API_KEY = undefined;
    process.env.GITHUB_ACTIONS = undefined;
    delete process.env.ANTHROPIC_BASE_URL;
  });

  afterEach(() => {
    for (const [k, v] of [
      ["ANTHROPIC_API_KEY", saved.key],
      ["ANTHROPIC_BASE_URL", saved.base],
      ["OPENAI_API_KEY", saved.openai],
      ["GITHUB_ACTIONS", saved.gha],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("defaults to api.anthropic.com when unset", () => {
    expect(resolveBackend().baseUrl).toBe("https://api.anthropic.com");
  });

  test("honors ANTHROPIC_BASE_URL for a custom Anthropic-compatible provider", () => {
    process.env.ANTHROPIC_BASE_URL = "https://api.minimax.io/anthropic/v1";
    const cfg = resolveBackend({
      model: "MiniMax-M3",
      judgeModel: "MiniMax-M3",
    });
    expect(cfg.backend).toBe("anthropic");
    expect(cfg.baseUrl).toBe("https://api.minimax.io/anthropic");
    expect(cfg.model).toBe("MiniMax-M3");
  });
});

describe("resolveJudgeBackend", () => {
  const saved = {
    key: process.env.JUDGE_API_KEY,
    model: process.env.JUDGE_MODEL,
  };

  afterEach(() => {
    for (const [key, value] of [
      ["JUDGE_API_KEY", saved.key],
      ["JUDGE_MODEL", saved.model],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("uses an Anthropic default rather than a non-Anthropic answer model", () => {
    process.env.JUDGE_API_KEY = "judge-key";
    delete process.env.JUDGE_MODEL;
    const judge = resolveJudgeBackend({
      backend: "openai",
      model: "gpt-5.6-terra",
      judgeModel: "gpt-5.6-terra",
      apiKey: "answer-key",
      baseUrl: "https://api.openai.com",
    });
    expect(judge.backend).toBe("anthropic");
    expect(judge.model).toBe("claude-sonnet-4-6");
  });
});
