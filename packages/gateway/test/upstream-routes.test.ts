import { describe, test, expect } from "bun:test";
import {
  resolveUpstreamRoute,
  resolveProviderRoute,
  extractProviderHeader,
} from "../src/config";

// ---------------------------------------------------------------------------
// resolveUpstreamRoute
// ---------------------------------------------------------------------------

describe("resolveUpstreamRoute", () => {
  describe("Anthropic", () => {
    test("routes claude- models to Anthropic API", () => {
      expect(resolveUpstreamRoute("claude-sonnet-4-5")).toEqual({
        url: "https://api.anthropic.com",
        protocol: "anthropic",
      });
    });
  });

  describe("OpenAI", () => {
    test("routes gpt- models to OpenAI API", () => {
      expect(resolveUpstreamRoute("gpt-4o")).toEqual({
        url: "https://api.openai.com",
        protocol: "openai",
      });
    });

    test("routes o1- models to OpenAI API", () => {
      expect(resolveUpstreamRoute("o1-pro")).toEqual({
        url: "https://api.openai.com",
        protocol: "openai",
      });
    });

    test("routes o3- models to OpenAI API", () => {
      expect(resolveUpstreamRoute("o3-mini")).toEqual({
        url: "https://api.openai.com",
        protocol: "openai",
      });
    });

    test("routes o4- models to OpenAI API", () => {
      expect(resolveUpstreamRoute("o4-mini")).toEqual({
        url: "https://api.openai.com",
        protocol: "openai",
      });
    });
  });

  describe("xAI", () => {
    test("routes grok- models to xAI API", () => {
      expect(resolveUpstreamRoute("grok-3-beta")).toEqual({
        url: "https://api.x.ai",
        protocol: "openai",
      });
    });
  });

  describe("Mistral (direct)", () => {
    test("routes mistral- models to Mistral API", () => {
      expect(resolveUpstreamRoute("mistral-large-latest")).toEqual({
        url: "https://api.mistral.ai",
        protocol: "openai",
      });
    });

    test("routes codestral- models to Mistral API", () => {
      expect(resolveUpstreamRoute("codestral-latest")).toEqual({
        url: "https://api.mistral.ai",
        protocol: "openai",
      });
    });
  });

  describe("Google (direct)", () => {
    test("routes gemini- models to Google API", () => {
      expect(resolveUpstreamRoute("gemini-2.5-pro")).toEqual({
        url: "https://generativelanguage.googleapis.com",
        protocol: "openai",
      });
    });
  });

  describe("DeepSeek", () => {
    test("routes deepseek- (dash) models to DeepSeek direct API", () => {
      expect(resolveUpstreamRoute("deepseek-v4-pro")).toEqual({
        url: "https://api.deepseek.com",
        protocol: "openai",
      });
    });

    test("routes deepseek-chat to DeepSeek direct API", () => {
      expect(resolveUpstreamRoute("deepseek-chat")).toEqual({
        url: "https://api.deepseek.com",
        protocol: "openai",
      });
    });

    test("routes deepseek-reasoner to DeepSeek direct API", () => {
      expect(resolveUpstreamRoute("deepseek-reasoner")).toEqual({
        url: "https://api.deepseek.com",
        protocol: "openai",
      });
    });

    test("routes deepseek/ (slash) models to Nvidia NIM", () => {
      expect(resolveUpstreamRoute("deepseek/deepseek-r1")).toEqual({
        url: "https://integrate.api.nvidia.com",
        protocol: "openai",
      });
    });
  });

  describe("Nvidia NIM (slash-prefix)", () => {
    test("routes nvidia/ models to Nvidia NIM", () => {
      expect(resolveUpstreamRoute("nvidia/llama-3.1-nemotron")).toEqual({
        url: "https://integrate.api.nvidia.com",
        protocol: "openai",
      });
    });

    test("routes meta/ models to Nvidia NIM", () => {
      expect(resolveUpstreamRoute("meta/llama-4-maverick")).toEqual({
        url: "https://integrate.api.nvidia.com",
        protocol: "openai",
      });
    });

    test("routes mistralai/ models to Nvidia NIM", () => {
      expect(resolveUpstreamRoute("mistralai/mistral-large")).toEqual({
        url: "https://integrate.api.nvidia.com",
        protocol: "openai",
      });
    });

    test("routes google/ models to Nvidia NIM", () => {
      expect(resolveUpstreamRoute("google/gemma-3")).toEqual({
        url: "https://integrate.api.nvidia.com",
        protocol: "openai",
      });
    });

    test("routes qwen/ models to Nvidia NIM", () => {
      expect(resolveUpstreamRoute("qwen/qwen3-235b-a22b")).toEqual({
        url: "https://integrate.api.nvidia.com",
        protocol: "openai",
      });
    });
  });

  describe("Unknown models", () => {
    test("returns null for unknown model prefix", () => {
      expect(resolveUpstreamRoute("llama-4-maverick")).toBeNull();
    });

    test("returns null for model without prefix", () => {
      expect(resolveUpstreamRoute("some-random-model")).toBeNull();
    });

    test("returns null for MiniMax models (handled by provider route)", () => {
      expect(resolveUpstreamRoute("MiniMax-M3")).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// resolveProviderRoute
// ---------------------------------------------------------------------------

describe("resolveProviderRoute", () => {
  describe("Anthropic protocol providers", () => {
    test("routes anthropic provider", () => {
      expect(resolveProviderRoute("anthropic")).toEqual({
        url: "https://api.anthropic.com",
        protocol: "anthropic",
      });
    });

    test("routes minimax to MiniMax global API (Anthropic protocol)", () => {
      expect(resolveProviderRoute("minimax")).toEqual({
        url: "https://api.minimax.io/anthropic",
        protocol: "anthropic",
      });
    });

    test("routes minimax-cn to MiniMax China API (Anthropic protocol)", () => {
      expect(resolveProviderRoute("minimax-cn")).toEqual({
        url: "https://api.minimaxi.com/anthropic",
        protocol: "anthropic",
      });
    });

    test("routes fireworks provider", () => {
      expect(resolveProviderRoute("fireworks")).toEqual({
        url: "https://api.fireworks.ai/inference",
        protocol: "anthropic",
      });
    });

    test("routes kimi-coding provider", () => {
      expect(resolveProviderRoute("kimi-coding")).toEqual({
        url: "https://api.kimi.com/coding",
        protocol: "anthropic",
      });
    });

    test("returns null url for github-copilot (requires user config)", () => {
      expect(resolveProviderRoute("github-copilot")).toEqual({
        url: null,
        protocol: "openai",
      });
    });
  });

  describe("OpenAI protocol providers", () => {
    test("routes deepseek provider", () => {
      expect(resolveProviderRoute("deepseek")).toEqual({
        url: "https://api.deepseek.com",
        protocol: "openai",
      });
    });

    test("routes xai provider", () => {
      expect(resolveProviderRoute("xai")).toEqual({
        url: "https://api.x.ai",
        protocol: "openai",
      });
    });

    test("routes groq provider", () => {
      expect(resolveProviderRoute("groq")).toEqual({
        url: "https://api.groq.com/openai",
        protocol: "openai",
      });
    });

    test("routes openrouter provider", () => {
      expect(resolveProviderRoute("openrouter")).toEqual({
        url: "https://openrouter.ai/api",
        protocol: "openai",
      });
    });
  });

  describe("OpenAI Responses protocol", () => {
    test("routes openai provider with responses protocol", () => {
      expect(resolveProviderRoute("openai")).toEqual({
        url: "https://api.openai.com",
        protocol: "openai-responses",
      });
    });
  });

  describe("Local/self-hosted providers", () => {
    test("returns null url for vllm (requires user config)", () => {
      expect(resolveProviderRoute("vllm")).toEqual({
        url: null,
        protocol: "openai",
      });
    });

    test("returns null url for ollama (requires user config)", () => {
      expect(resolveProviderRoute("ollama")).toEqual({
        url: null,
        protocol: "openai",
      });
    });
  });

  describe("Unknown providers", () => {
    test("returns null for unknown provider", () => {
      expect(resolveProviderRoute("unknown-provider")).toBeNull();
    });

    test("returns null for empty string", () => {
      expect(resolveProviderRoute("")).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// extractProviderHeader
// ---------------------------------------------------------------------------

describe("extractProviderHeader", () => {
  test("extracts valid provider ID", () => {
    expect(extractProviderHeader({ "x-lore-provider": "minimax" })).toBe(
      "minimax",
    );
  });

  test("extracts hyphenated provider ID", () => {
    expect(extractProviderHeader({ "x-lore-provider": "minimax-cn" })).toBe(
      "minimax-cn",
    );
  });

  test("lowercases provider ID", () => {
    expect(extractProviderHeader({ "x-lore-provider": "MiniMax" })).toBe(
      "minimax",
    );
  });

  test("returns undefined for missing header", () => {
    expect(extractProviderHeader({})).toBeUndefined();
  });

  test("returns undefined for empty header", () => {
    expect(extractProviderHeader({ "x-lore-provider": "" })).toBeUndefined();
  });

  test("returns undefined for header with invalid characters", () => {
    expect(
      extractProviderHeader({ "x-lore-provider": "mini max!" }),
    ).toBeUndefined();
  });

  test("returns undefined for header exceeding max length", () => {
    expect(
      extractProviderHeader({
        "x-lore-provider": "a".repeat(65),
      }),
    ).toBeUndefined();
  });

  test("accepts header at max length", () => {
    const id = "a".repeat(64);
    expect(extractProviderHeader({ "x-lore-provider": id })).toBe(id);
  });

  test("strips control characters", () => {
    expect(extractProviderHeader({ "x-lore-provider": "mini\x00max" })).toBe(
      "minimax",
    );
  });
});
