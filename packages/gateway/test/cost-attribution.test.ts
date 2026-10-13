import { afterEach, describe, test, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  cacheAnthropicOrganizationFromResponse,
  resolveCostAttribution,
  _resetCostAttributionForTest,
} from "../src/cost-attribution";
import { authFingerprint } from "../src/auth";
import {
  captureBillingPrefix,
  captureSessionHeaders,
  _resetForTest,
} from "../src/cch";

afterEach(_resetCostAttributionForTest);

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

  test("OpenAI JWT account claims never override credential-scoped identity", () => {
    const jwt = (nonce: string) => {
      const payload = Buffer.from(
        JSON.stringify({
          nonce,
          "https://api.openai.com/auth": {
            chatgpt_account_id: "acct-shared",
          },
        }),
      ).toString("base64url");
      return `header.${payload}.signature-${nonce}`;
    };
    const first = resolveCostAttribution({
      sessionID: "openai-jwt-session-one",
      providerID: "openai-codex",
      credential: { scheme: "bearer", value: jwt("first") },
    });
    const refreshed = resolveCostAttribution({
      sessionID: "openai-jwt-session-two",
      providerID: "openai-codex",
      credential: { scheme: "bearer", value: jwt("refreshed") },
    });

    expect(first.authKind).toBe("subscription");
    expect(first.account).toBe(
      authFingerprint({ scheme: "bearer", value: jwt("first") }).slice(0, 12),
    );
    expect(refreshed.account).toBe(
      authFingerprint({ scheme: "bearer", value: jwt("refreshed") }).slice(
        0,
        12,
      ),
    );
    expect(first.account).not.toBe(refreshed.account);
  });

  test("openai account attribution ignores request and session header hints", () => {
    _resetForTest();
    captureSessionHeaders("header-priority-session", {
      "chatgpt-account-id": "snapshot-account",
    });
    const jwt = (nonce: string) => {
      const payload = Buffer.from(
        JSON.stringify({
          nonce,
          "https://api.openai.com/auth": {
            chatgpt_account_id: "jwt-account",
          },
        }),
      ).toString("base64url");
      return `header.${payload}.signature-${nonce}`;
    };
    const attribution = resolveCostAttribution({
      sessionID: "header-priority-session",
      providerID: "openai-codex",
      credential: {
        scheme: "bearer",
        value: jwt("first"),
      },
      requestHeaders: new Headers({ "chatgpt-account-id": "header-account" }),
    });
    const refreshed = resolveCostAttribution({
      providerID: "openai",
      credential: { scheme: "bearer", value: jwt("first") },
      requestHeaders: { "ChatGPT-Account-Id": "caller-selected-account" },
    });

    expect(attribution.authKind).toBe("subscription");
    expect(refreshed.account).toBe(attribution.account);
    expect(attribution.account).toBe(
      authFingerprint({ scheme: "bearer", value: jwt("first") }).slice(0, 12),
    );
    expect(attribution.account).not.toBe(
      createHash("sha256").update("header-account").digest("hex").slice(0, 12),
    );
    expect(attribution.account).not.toBe(
      createHash("sha256")
        .update("snapshot-account")
        .digest("hex")
        .slice(0, 12),
    );
    _resetForTest();
  });

  test("forged OpenAI JWT account claims do not choose identity or auth kind", () => {
    const credential = {
      scheme: "bearer" as const,
      value: `header.${Buffer.from(
        JSON.stringify({
          "https://api.openai.com/auth": {
            chatgpt_account_id: "caller-chosen-account",
          },
        }),
      ).toString("base64url")}.unverified-signature`,
    };
    const attribution = resolveCostAttribution({
      providerID: "openai",
      credential,
    });

    expect(attribution.authKind).toBe("api_key");
    expect(attribution.account).toBe(authFingerprint(credential).slice(0, 12));
    expect(attribution.account).not.toBe(
      createHash("sha256")
        .update("caller-chosen-account")
        .digest("hex")
        .slice(0, 12),
    );
  });

  test("untrusted account headers cannot classify an OpenAI API key as a subscription", () => {
    _resetForTest();
    const sessionID = "codex-session";
    captureSessionHeaders(sessionID, { "chatgpt-account-id": "acct_123" });
    const credential = { scheme: "api-key" as const, value: "openai-key" };
    const attribution = resolveCostAttribution({
      sessionID,
      providerID: "openai",
      credential,
      requestHeaders: new Headers({
        "chatgpt-account-id": "caller-account",
        "x-codex-primary-used-percent": "10",
      }),
    });
    expect(attribution.authKind).toBe("api_key");
    expect(attribution.account).toBe(authFingerprint(credential).slice(0, 12));
    _resetForTest();
  });

  test("OpenAI subscriptions without a verified account use credential fingerprints", () => {
    const first = resolveCostAttribution({
      providerID: "openai-codex",
      credential: { scheme: "bearer", value: "opaque-token-one" },
    });
    const refreshed = resolveCostAttribution({
      providerID: "openai-codex",
      credential: { scheme: "bearer", value: "opaque-token-two" },
    });
    const malformedJWT = resolveCostAttribution({
      providerID: "openai-codex",
      credential: { scheme: "bearer", value: "header.!.signature" },
    });

    expect(first.authKind).toBe("subscription");
    expect(first.account).toBe(
      authFingerprint({ scheme: "bearer", value: "opaque-token-one" }).slice(
        0,
        12,
      ),
    );
    expect(refreshed.account).toBe(
      authFingerprint({ scheme: "bearer", value: "opaque-token-two" }).slice(
        0,
        12,
      ),
    );
    expect(malformedJWT.account).toBe(
      authFingerprint({ scheme: "bearer", value: "header.!.signature" }).slice(
        0,
        12,
      ),
    );
  });

  test("openai API-key credentials remain fingerprinted", () => {
    const credential = { scheme: "api-key" as const, value: "key-not-a-token" };
    const attribution = resolveCostAttribution({
      providerID: "openai",
      credential,
    });

    expect(attribution.authKind).toBe("api_key");
    expect(attribution.account).toBe(authFingerprint(credential).slice(0, 12));
  });

  test("anthropic OAuth tokens share a stable organization key", () => {
    const first = resolveCostAttribution({
      providerID: "anthropic",
      credential: { scheme: "bearer", value: "sk-ant-oat01-first" },
      responseHeaders: new Headers({ "anthropic-organization-id": "org-123" }),
    });
    const refreshed = resolveCostAttribution({
      providerID: "anthropic",
      credential: { scheme: "bearer", value: "sk-ant-oat01-refreshed" },
      responseHeaders: new Headers({ "anthropic-organization-id": "org-123" }),
    });
    const withoutOrganization = resolveCostAttribution({
      providerID: "anthropic",
      credential: { scheme: "bearer", value: "sk-ant-oat01-other" },
    });

    expect(first).toMatchObject({ authKind: "subscription" });
    expect(first.account).toBe(refreshed.account);
    expect(first.account).toBe(
      createHash("sha256").update("org-123").digest("hex").slice(0, 12),
    );
    expect(withoutOrganization.account).toBe("default");
  });

  test("anthropic organization is reused for later headerless attribution", () => {
    _resetForTest();
    const sessionID = "anthropic-org-cache-session";
    captureBillingPrefix(
      sessionID,
      "x-anthropic-billing-header: cc_version=2.1.181.abcde; cc_entrypoint=cli; cch=abcde",
    );
    const credential = {
      scheme: "bearer" as const,
      value: "sk-ant-oat01-cached",
    };
    const responseHeaders = new Headers({
      "anthropic-organization-id": "org-cached",
    });
    const response = resolveCostAttribution({
      sessionID,
      providerID: "anthropic",
      credential,
      responseHeaders,
    });
    cacheAnthropicOrganizationFromResponse({
      provider: response.provider,
      credential,
      sessionID,
      observedAt: 1,
      responseHeaders,
    });
    const later = resolveCostAttribution({
      sessionID,
      providerID: "anthropic",
      credential,
    });
    const withoutKnownOrganization = resolveCostAttribution({
      providerID: "anthropic",
      credential: { scheme: "bearer", value: "sk-ant-oat01-unseen" },
    });
    const sessionOnly = resolveCostAttribution({
      sessionID,
      providerID: "anthropic",
    });

    expect(later.account).toBe(response.account);
    expect(response.account).toBe(
      createHash("sha256").update("org-cached").digest("hex").slice(0, 12),
    );
    expect(withoutKnownOrganization.account).toBe("default");
    expect(sessionOnly.account).toBe("default");
    _resetForTest();
  });

  test("Anthropic session attribution stays bound to its credential", () => {
    _resetForTest();
    const sessionID = "anthropic-switched-credential-session";
    const credentialA = {
      scheme: "bearer" as const,
      value: "sk-ant-oat01-credential-a",
    };
    const credentialB = {
      scheme: "bearer" as const,
      value: "sk-ant-oat01-credential-b",
    };
    const cacheOrganization = (
      credential: typeof credentialA,
      organizationID: string,
    ) =>
      cacheAnthropicOrganizationFromResponse({
        provider: "anthropic",
        credential,
        sessionID,
        observedAt: 1,
        responseHeaders: new Headers({
          "anthropic-organization-id": organizationID,
        }),
      });
    const accountA = createHash("sha256")
      .update("org-a")
      .digest("hex")
      .slice(0, 12);
    const accountB = createHash("sha256")
      .update("org-b")
      .digest("hex")
      .slice(0, 12);

    cacheOrganization(credentialA, "org-a");
    expect(
      resolveCostAttribution({
        sessionID,
        providerID: "anthropic",
        credential: credentialA,
      }).account,
    ).toBe(accountA);
    expect(
      resolveCostAttribution({
        sessionID,
        providerID: "anthropic",
        credential: credentialB,
      }).account,
    ).toBe("default");

    cacheOrganization(credentialB, "org-b");
    expect(
      resolveCostAttribution({
        sessionID,
        providerID: "anthropic",
        credential: credentialB,
      }).account,
    ).toBe(accountB);
    expect(
      resolveCostAttribution({
        sessionID,
        providerID: "anthropic",
        credential: credentialA,
      }).account,
    ).toBe(accountA);
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
    expect(attribution.authKind).toBe("api_key");
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
