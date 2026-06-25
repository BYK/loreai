/**
 * Unit tests for the bedrock-mantle integration.
 *
 * Bedrock rides the gateway's `anthropic` protocol via the bedrock-mantle
 * endpoint, so the only Bedrock-specific code is: the model-id remap
 * (`toMantleModelId`), the region URL builder (`bedrockMantleUrl`), the host
 * recognizer (`isBedrockMantleHost`), the provider route (`bedrockMantle: true`,
 * protocol "anthropic"), the worker protocol resolution, and the cache-warmer
 * profile gate. End-to-end routing is covered in `bedrock-routing.test.ts`.
 */
import { describe, test, expect } from "vitest";
import {
  bedrockMantleUrl,
  isBedrockMantleDispatch,
  isBedrockMantleHost,
  toMantleModelId,
} from "../src/translate/bedrock";
import { resolveProviderRoute } from "../src/config";
import { resolveWorkerProtocol } from "../src/llm-adapter";
import { resolveProfile } from "../src/cache-warmer";

describe("toMantleModelId", () => {
  test("prefixes a client claude-* id with anthropic.", () => {
    expect(toMantleModelId("claude-opus-4-8")).toBe(
      "anthropic.claude-opus-4-8",
    );
    expect(toMantleModelId("claude-haiku-4-5")).toBe(
      "anthropic.claude-haiku-4-5",
    );
    expect(toMantleModelId("claude-3-5-sonnet-20241022")).toBe(
      "anthropic.claude-3-5-sonnet-20241022",
    );
  });

  test("passes through an already-mantle id unchanged (idempotent)", () => {
    const id = "anthropic.claude-opus-4-8";
    expect(toMantleModelId(id)).toBe(id);
    expect(toMantleModelId(toMantleModelId("claude-opus-4-8"))).toBe(
      "anthropic.claude-opus-4-8",
    );
  });

  test("passes through non-claude ids unchanged", () => {
    expect(toMantleModelId("gpt-5.5")).toBe("gpt-5.5");
    expect(toMantleModelId("google.gemma-4-31b")).toBe("google.gemma-4-31b");
  });

  test("does not resolve inherited Object.prototype members", () => {
    // A model literally named "valueOf"/"toString" must not pick up the
    // prototype function via the alias map (Object.hasOwn guard).
    expect(toMantleModelId("valueOf")).toBe("valueOf");
    expect(toMantleModelId("toString")).toBe("toString");
  });
});

describe("bedrockMantleUrl", () => {
  test("builds the regional /anthropic base (no /v1/messages)", () => {
    expect(bedrockMantleUrl("us-east-1")).toBe(
      "https://bedrock-mantle.us-east-1.api.aws/anthropic",
    );
    expect(bedrockMantleUrl("eu-west-1")).toBe(
      "https://bedrock-mantle.eu-west-1.api.aws/anthropic",
    );
  });
});

describe("isBedrockMantleHost", () => {
  test("matches mantle hosts (bare host or full URL)", () => {
    expect(isBedrockMantleHost("bedrock-mantle.us-east-1.api.aws")).toBe(true);
    expect(
      isBedrockMantleHost("https://bedrock-mantle.us-east-1.api.aws/anthropic"),
    ).toBe(true);
    expect(
      isBedrockMantleHost("https://bedrock-mantle.eu-west-1.api.aws"),
    ).toBe(true);
  });

  test("rejects non-mantle and spoofed hosts", () => {
    expect(isBedrockMantleHost("https://api.anthropic.com")).toBe(false);
    expect(
      isBedrockMantleHost("https://bedrock-runtime.us-east-1.amazonaws.com"),
    ).toBe(false);
    // Spoof: mantle prefix as a subdomain of an attacker host.
    expect(
      isBedrockMantleHost("https://bedrock-mantle.us-east-1.api.aws.evil.com"),
    ).toBe(false);
    expect(isBedrockMantleHost("")).toBe(false);
  });
});

describe("isBedrockMantleDispatch — gate (bedrockMantle ∧ anthropic)", () => {
  test("true only for a bedrockMantle route on an anthropic dispatch", () => {
    expect(isBedrockMantleDispatch({ bedrockMantle: true }, "anthropic")).toBe(
      true,
    );
  });

  test("false on a non-anthropic dispatch even for a bedrockMantle route", () => {
    // The load-bearing guard: an openai-responses ingress carrying
    // X-Lore-Provider: bedrock must NOT build the mantle URL / remap the model.
    expect(
      isBedrockMantleDispatch({ bedrockMantle: true }, "openai-responses"),
    ).toBe(false);
    expect(isBedrockMantleDispatch({ bedrockMantle: true }, "openai")).toBe(
      false,
    );
    expect(isBedrockMantleDispatch({ bedrockMantle: true }, "vertex")).toBe(
      false,
    );
  });

  test("false for a non-bedrock route and for null/undefined", () => {
    expect(isBedrockMantleDispatch({}, "anthropic")).toBe(false);
    expect(isBedrockMantleDispatch({ bedrockMantle: false }, "anthropic")).toBe(
      false,
    );
    expect(isBedrockMantleDispatch(null, "anthropic")).toBe(false);
    expect(isBedrockMantleDispatch(undefined, "anthropic")).toBe(false);
  });
});

describe("resolveProviderRoute — bedrock → mantle (anthropic protocol)", () => {
  for (const id of ["bedrock", "amazon-bedrock"]) {
    test(`"${id}" routes via the anthropic protocol with bedrockMantle`, () => {
      const route = resolveProviderRoute(id);
      expect(route).not.toBeNull();
      // url is null — the region URL is built at request time.
      expect(route?.url).toBeNull();
      // Wire protocol is plain anthropic (mantle is Anthropic-compatible).
      expect(route?.protocol).toBe("anthropic");
      // The flag that triggers mantle URL-building + model remap.
      expect(route?.bedrockMantle).toBe(true);
    });
  }
});

describe("resolveWorkerProtocol — bedrock", () => {
  test("a bedrock-mantle session's anthropic snapshot → anthropic workers", () => {
    // The snapshot protocol for a bedrock-mantle session is "anthropic"
    // (the provider route's protocol), so workers use the anthropic path.
    expect(resolveWorkerProtocol("bedrock", "anthropic")).toBe("anthropic");
    expect(resolveWorkerProtocol("amazon-bedrock", "anthropic")).toBe(
      "anthropic",
    );
    // Route-table lookup (no explicit hint) also resolves to anthropic.
    expect(resolveWorkerProtocol("bedrock")).toBe("anthropic");
  });
});

describe("resolveProfile — bedrock-mantle warming", () => {
  const mantleBase = "https://bedrock-mantle.us-east-1.api.aws/anthropic";

  test("warms a bedrock-mantle session (provider id)", () => {
    const profile = resolveProfile(
      "claude-haiku-4-5",
      "anthropic",
      "5m",
      mantleBase,
      "bedrock",
    );
    expect(profile).not.toBeNull();
    // Warmup targets the mantle messages endpoint with the session's key.
    expect(profile?.upstreamUrl).toBe(`${mantleBase}/v1/messages`);
  });

  test("warms a bedrock-mantle session detected by host (no provider header)", () => {
    const profile = resolveProfile(
      "claude-haiku-4-5",
      "anthropic",
      "5m",
      mantleBase,
      undefined,
    );
    expect(profile).not.toBeNull();
    expect(profile?.upstreamUrl).toBe(`${mantleBase}/v1/messages`);
  });

  test("still SKIPS foreign anthropic-compat hosts (MiniMax) — no warming", () => {
    // Guards the mantle allowance from over-reaching: a foreign anthropic-compat
    // host must still be skipped (warming it would leak the key to anthropic).
    const profile = resolveProfile(
      "MiniMax-M2",
      "anthropic",
      "5m",
      "https://api.minimax.io/anthropic",
      "minimax",
    );
    expect(profile).toBeNull();
  });

  test("does not warm non-anthropic protocols", () => {
    expect(
      resolveProfile("gpt-5.5", "openai", "5m", undefined, "openai"),
    ).toBeNull();
  });

  test("threads prefixTokens through to a size-scaled 5m margin", () => {
    // Bedrock-mantle rides the Anthropic profile, so it must scale the 5m margin
    // for large prefixes like the first-party/vertex paths (computeWarmupMargin).
    const flat = resolveProfile(
      "claude-haiku-4-5",
      "anthropic",
      "5m",
      mantleBase,
      "bedrock",
    );
    const scaled = resolveProfile(
      "claude-haiku-4-5",
      "anthropic",
      "5m",
      mantleBase,
      "bedrock",
      164_807,
    );
    expect(flat?.warmupMarginMs).toBe(45_000);
    expect(scaled?.warmupMarginMs).toBeCloseTo(89_497.89, 2);
  });
});
