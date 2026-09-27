import { describe, test, expect } from "vitest";
import { resolveCostAttribution } from "../src/cost-attribution";
import { authFingerprint } from "../src/auth";
import {
  captureBillingPrefix,
  captureSessionHeaders,
  _resetForTest,
} from "../src/cch";

describe("resolveCostAttribution", () => {
  test("explicit providerID wins and is normalized", () => {
    expect(resolveCostAttribution({ providerID: " Anthropic " }).provider).toBe(
      "anthropic",
    );
  });

  test.each([
    ["https://api.anthropic.com", "anthropic"],
    ["https://api.openai.com/v1", "openai"],
    ["https://chatgpt.com/backend-api", "openai"],
    ["https://chatgpt.com/backend-api/codex/responses", "openai"],
    ["https://generativelanguage.googleapis.com", "google"],
    ["https://us-central1-aiplatform.googleapis.com", "vertex"],
    ["https://openrouter.ai/api", "openrouter"],
    ["https://api.githubcopilot.com", "github-copilot"],
    ["https://bedrock-runtime.us-east-1.amazonaws.com", "bedrock"],
    ["https://opencode.ai/zen/v1/chat/completions", "opencode"],
    ["https://opencode.ai/zen/go/v1/chat/completions", "opencode-go"],
    ["https://api.deepseek.com/chat/completions", "deepseek"],
    ["https://api.groq.com/openai/v1/chat/completions", "groq"],
    ["https://api.minimax.io", "api.minimax.io"],
    [
      "https://self-hosted-llm.internal/v1/chat/completions",
      "self-hosted-llm.internal",
    ],
    ["not a url", "unknown"],
    [undefined, "unknown"],
  ])("infers provider from host %s → %s", (url, expected) => {
    expect(resolveCostAttribution({ upstreamURL: url }).provider).toBe(
      expected,
    );
  });

  test("anthropic subscription via Claude Code OAuth session", () => {
    _resetForTest();
    const sessionID = "oauth-session";
    captureBillingPrefix(
      sessionID,
      "x-anthropic-billing-header: cc_version=2.1.181.abcde; cc_entrypoint=cli; cch=abcde",
    );
    expect(
      resolveCostAttribution({ sessionID, providerID: "anthropic" }).authKind,
    ).toBe("subscription");
    _resetForTest();
  });

  test("anthropic subscription via sk-ant-oat bearer", () => {
    expect(
      resolveCostAttribution({
        providerID: "anthropic",
        credential: { scheme: "bearer", value: "sk-ant-oat01-xyz" },
      }).authKind,
    ).toBe("subscription");
  });

  test("anthropic subscription via unified ratelimit response headers", () => {
    expect(
      resolveCostAttribution({
        providerID: "anthropic",
        responseHeaders: new Headers({
          "anthropic-ratelimit-unified-status": "allowed",
        }),
      }).authKind,
    ).toBe("subscription");
  });

  test("anthropic API key stays api_key", () => {
    expect(
      resolveCostAttribution({
        providerID: "anthropic",
        credential: { scheme: "api-key", value: "sk-ant-api03-key" },
      }).authKind,
    ).toBe("api_key");
  });

  test.each(["openai-codex", "OpenAI-Codex "])(
    "explicit providerID %p maps to openai subscription",
    (providerID) => {
      expect(
        resolveCostAttribution({
          providerID,
          upstreamURL: "https://api.openai.com/v1",
        }),
      ).toMatchObject({ provider: "openai", authKind: "subscription" });
    },
  );

  test("openai subscription via /backend-api URL", () => {
    expect(
      resolveCostAttribution({
        providerID: "openai",
        upstreamURL: "https://chatgpt.com/backend-api",
      }).authKind,
    ).toBe("subscription");
  });

  test("openai subscription via chatgpt-account-id session snapshot", () => {
    _resetForTest();
    const sessionID = "codex-session";
    captureSessionHeaders(sessionID, { "chatgpt-account-id": "acct_123" });
    const attribution = resolveCostAttribution({
      sessionID,
      providerID: "openai",
    });
    expect(attribution.authKind).toBe("subscription");
    // Account is sha256-derived, never the raw account id.
    expect(attribution.account).toMatch(/^[0-9a-f]{12}$/);
    expect(attribution.account).not.toContain("acct_123");
    _resetForTest();
  });

  test("openai subscription via x-codex-* response headers", () => {
    expect(
      resolveCostAttribution({
        providerID: "openai",
        responseHeaders: new Headers({ "x-codex-primary-used-percent": "10" }),
      }).authKind,
    ).toBe("subscription");
  });

  test("account is the credential fingerprint, never the raw secret", () => {
    const credential = {
      scheme: "api-key",
      value: "super-secret-key",
    } as const;
    const attribution = resolveCostAttribution({
      providerID: "anthropic",
      credential,
    });
    expect(attribution.account).toBe(authFingerprint(credential).slice(0, 12));
    expect(attribution.account).not.toContain("super-secret");
  });

  test("empty credential value (vertex placeholder) → default", () => {
    expect(
      resolveCostAttribution({
        providerID: "vertex",
        credential: { scheme: "bearer", value: "" },
      }).account,
    ).toBe("default");
  });

  test("no credential → default", () => {
    expect(resolveCostAttribution({ providerID: "anthropic" }).account).toBe(
      "default",
    );
  });
});
