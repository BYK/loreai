import { afterEach, describe, test, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  cacheAnthropicOrganizationFromResponse,
  isVerifiedAnthropicOAuthCredential,
  recordSuccessfulAnthropicOAuthAuth,
  recordSuccessfulChatGPTAuth,
  resolveCostAttribution,
  _resetCostAttributionForTest,
} from "../src/cost-attribution";
import { authFingerprint } from "../src/auth";
import { isAnthropicOAuthSession } from "../src/quota";
import {
  captureBillingPrefix as captureBillingPrefixImpl,
  captureSessionHeaders,
  _resetForTest,
} from "../src/cch";

afterEach(_resetCostAttributionForTest);

const OAUTH_CREDENTIAL = {
  scheme: "bearer",
  value: "sk-ant-oat01-oauth",
} as const;
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const captureBillingPrefix = (sessionID: string, system: string) =>
  captureBillingPrefixImpl(sessionID, system, OAUTH_CREDENTIAL);
const TRUSTED_ANTHROPIC_RESPONSE = {
  upstreamURL: ANTHROPIC_URL,
  responseURL: ANTHROPIC_URL,
  responseStatus: 200,
  directUpstreamResponse: true,
} as const;
const trustAnthropicCredential = (
  credential:
    | typeof OAUTH_CREDENTIAL
    | {
        scheme: "bearer";
        value: string;
      },
) =>
  recordSuccessfulAnthropicOAuthAuth({
    credential,
    ...TRUSTED_ANTHROPIC_RESPONSE,
  });

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

  test("billing header alone does not establish Anthropic subscription auth", () => {
    _resetForTest();
    const sessionID = "oauth-session";
    captureBillingPrefix(
      sessionID,
      "x-anthropic-billing-header: cc_version=2.1.181.abcde; cc_entrypoint=cli; cch=abcde",
    );
    expect(
      resolveCostAttribution({
        sessionID,
        providerID: "anthropic",
        credential: OAUTH_CREDENTIAL,
      }).authKind,
    ).toBe("api_key");
    _resetForTest();
  });

  test("Claude Code session markers cannot upgrade an API-key credential", () => {
    _resetForTest();
    const sessionID = "api-key-with-claude-marker";
    captureBillingPrefix(
      sessionID,
      "x-anthropic-billing-header: cc_version=2.1.181.abcde; cc_entrypoint=cli; cch=abcde",
    );

    expect(
      resolveCostAttribution({
        sessionID,
        providerID: "anthropic",
        credential: { scheme: "api-key", value: "sk-ant-api03-key" },
      }).authKind,
    ).toBe("api_key");
    _resetForTest();
  });

  test("Claude Code session markers cannot upgrade a different bearer credential", () => {
    _resetForTest();
    const sessionID = "bearer-key-with-claude-marker";
    captureBillingPrefix(
      sessionID,
      "x-anthropic-billing-header: cc_version=2.1.181.abcde; cc_entrypoint=cli; cch=abcde",
    );

    expect(
      resolveCostAttribution({
        sessionID,
        providerID: "anthropic",
        credential: { scheme: "bearer", value: "sk-ant-api03-key" },
      }).authKind,
    ).toBe("api_key");
    _resetForTest();
  });

  test("billing marker is scoped to the credential used on that turn", () => {
    _resetForTest();
    const sessionID = "credential-switched-billing-session";
    const oldCredential = {
      scheme: "bearer" as const,
      value: "old-session-token",
    };
    const currentCredential = {
      scheme: "bearer" as const,
      value: "new-session-token",
    };
    captureBillingPrefixImpl(
      sessionID,
      "x-anthropic-billing-header: cc_version=2.1.181.abcde; cc_entrypoint=cli; cch=abcde",
      oldCredential,
    );

    const attribution = resolveCostAttribution({
      sessionID,
      providerID: "anthropic",
      upstreamURL: ANTHROPIC_URL,
      credential: currentCredential,
    });
    const quotaSession = isAnthropicOAuthSession(sessionID, currentCredential);

    expect(attribution.authKind).toBe("api_key");
    expect(quotaSession).toBe(false);
  });

  test("OAuth-looking bearer credentials require trusted authentication", () => {
    expect(
      resolveCostAttribution({
        providerID: "anthropic",
        credential: { scheme: "bearer", value: "sk-ant-oat01-unverified" },
      }).authKind,
    ).toBe("api_key");
  });

  test("anthropic subscription via sk-ant-oat bearer", () => {
    recordSuccessfulAnthropicOAuthAuth({
      credential: OAUTH_CREDENTIAL,
      upstreamURL: ANTHROPIC_URL,
      responseURL: ANTHROPIC_URL,
      responseStatus: 200,
      directUpstreamResponse: true,
    });
    expect(
      resolveCostAttribution({
        providerID: "anthropic",
        upstreamURL: ANTHROPIC_URL,
        credential: OAUTH_CREDENTIAL,
      }).authKind,
    ).toBe("subscription");
  });

  test("Anthropic subscription trust requires a direct successful canonical response", () => {
    const rejectedCredentials = [
      {
        credential: {
          scheme: "bearer" as const,
          value: "sk-ant-oat01-unauthorized",
        },
        responseStatus: 401,
      },
      {
        credential: {
          scheme: "bearer" as const,
          value: "sk-ant-oat01-intercepted",
        },
        directUpstreamResponse: false,
      },
      {
        credential: {
          scheme: "bearer" as const,
          value: "sk-ant-oat01-custom-upstream",
        },
        upstreamURL: "https://anthropic-compatible.example/v1/messages",
      },
      {
        credential: {
          scheme: "bearer" as const,
          value: "sk-ant-oat01-redirected",
        },
        responseURL: "https://anthropic-compatible.example/v1/messages",
      },
      {
        credential: {
          scheme: "api-key" as const,
          value: "sk-ant-oat01-api-key",
        },
      },
    ];

    for (const [index, candidate] of rejectedCredentials.entries()) {
      recordSuccessfulAnthropicOAuthAuth({
        ...TRUSTED_ANTHROPIC_RESPONSE,
        ...candidate,
      });
      expect(
        resolveCostAttribution({
          providerID: "anthropic",
          upstreamURL: ANTHROPIC_URL,
          credential: candidate.credential,
        }).authKind,
        `candidate ${index}`,
      ).toBe("api_key");
    }
  });

  test("Anthropic subscription credential state refuses new identities at capacity", () => {
    const established = {
      scheme: "bearer" as const,
      value: "sk-ant-oat01-established",
    };
    for (let index = 0; index < 256; index++) {
      const credential =
        index === 0
          ? established
          : { scheme: "bearer" as const, value: `sk-ant-oat01-${index}` };
      trustAnthropicCredential(credential);
    }
    const overflow = {
      scheme: "bearer" as const,
      value: "sk-ant-oat01-overflow",
    };
    trustAnthropicCredential(overflow);

    expect(isVerifiedAnthropicOAuthCredential(established)).toBe(true);
    expect(isVerifiedAnthropicOAuthCredential(overflow)).toBe(false);
  });

  test("Anthropic rate-limit response headers do not establish subscription auth", () => {
    expect(
      resolveCostAttribution({
        providerID: "anthropic",
        responseHeaders: new Headers({
          "anthropic-ratelimit-unified-status": "allowed",
        }),
      }).authKind,
    ).toBe("api_key");
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
    "explicit providerID %p maps to openai without proving subscription auth",
    (providerID) => {
      expect(
        resolveCostAttribution({
          providerID,
          upstreamURL: "https://api.openai.com/v1",
        }),
      ).toMatchObject({ provider: "openai", authKind: "api_key" });
    },
  );

  test("OpenAI bearer subscription requires the canonical ChatGPT backend", () => {
    const credential = {
      scheme: "bearer" as const,
      value: "opaque-oauth-token",
    };
    recordSuccessfulChatGPTAuth({
      credential,
      upstreamURL: "https://chatgpt.com/backend-api",
      responseURL: "https://chatgpt.com/backend-api/codex/responses",
      responseStatus: 200,
      directUpstreamResponse: true,
    });
    expect(
      resolveCostAttribution({
        providerID: "openai",
        credential,
        upstreamURL: "https://chatgpt.com/backend-api",
      }).authKind,
    ).toBe("subscription");
    expect(
      resolveCostAttribution({
        providerID: "openai",
        credential: { scheme: "bearer", value: "opaque-oauth-token" },
        upstreamURL: "https://proxy.example/backend-api",
      }).authKind,
    ).toBe("api_key");
    expect(
      resolveCostAttribution({
        providerID: "openai",
        credential: { scheme: "api-key", value: "openai-key" },
        upstreamURL: "https://chatgpt.com/backend-api",
        responseHeaders: new Headers({ "x-codex-primary-used-percent": "99" }),
      }).authKind,
    ).toBe("api_key");
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
    const firstCredential = { scheme: "bearer" as const, value: jwt("first") };
    const refreshedCredential = {
      scheme: "bearer" as const,
      value: jwt("refreshed"),
    };
    for (const credential of [firstCredential, refreshedCredential]) {
      recordSuccessfulChatGPTAuth({
        credential,
        upstreamURL: "https://chatgpt.com/backend-api",
        responseURL: "https://chatgpt.com/backend-api/codex/responses",
        responseStatus: 200,
        directUpstreamResponse: true,
      });
    }
    const first = resolveCostAttribution({
      sessionID: "openai-jwt-session-one",
      providerID: "openai-codex",
      credential: firstCredential,
      upstreamURL: "https://chatgpt.com/backend-api",
    });
    const refreshed = resolveCostAttribution({
      sessionID: "openai-jwt-session-two",
      providerID: "openai-codex",
      credential: refreshedCredential,
      upstreamURL: "https://chatgpt.com/backend-api",
    });

    expect(first.authKind).toBe("subscription");
    expect(first.account).toBe("default");
    expect(refreshed.account).toBe("default");
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
    const credential = { scheme: "bearer" as const, value: jwt("first") };
    recordSuccessfulChatGPTAuth({
      credential,
      upstreamURL: "https://chatgpt.com/backend-api",
      responseURL: "https://chatgpt.com/backend-api/codex/responses",
      responseStatus: 200,
      directUpstreamResponse: true,
    });
    const attribution = resolveCostAttribution({
      sessionID: "header-priority-session",
      providerID: "openai-codex",
      credential,
      upstreamURL: "https://chatgpt.com/backend-api",
      requestHeaders: new Headers({ "chatgpt-account-id": "header-account" }),
    });
    const refreshed = resolveCostAttribution({
      providerID: "openai",
      credential,
      upstreamURL: "https://chatgpt.com/backend-api",
      requestHeaders: { "ChatGPT-Account-Id": "caller-selected-account" },
    });

    expect(attribution.authKind).toBe("subscription");
    expect(refreshed.account).toBe(attribution.account);
    expect(attribution.account).toBe("default");
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

  test("caller-selected Codex route and backend do not prove subscription auth", () => {
    const credential = {
      scheme: "bearer" as const,
      value: "caller-supplied-bearer-key",
    };
    const attribution = resolveCostAttribution({
      providerID: "openai-codex",
      credential,
      upstreamURL: "https://chatgpt.com/backend-api",
      responseHeaders: new Headers({
        "x-codex-primary-used-percent": "99",
      }),
    });

    expect(attribution.authKind).toBe("api_key");
    expect(attribution.account).toBe(authFingerprint(credential).slice(0, 12));
  });

  test("only a direct successful ChatGPT response establishes bearer auth", () => {
    const credential = { scheme: "bearer" as const, value: "candidate-token" };
    const attribution = () =>
      resolveCostAttribution({
        providerID: "openai-codex",
        credential,
        upstreamURL: "https://chatgpt.com/backend-api",
      });
    const common = {
      credential,
      upstreamURL: "https://chatgpt.com/backend-api",
      responseURL: "https://chatgpt.com/backend-api/codex/responses",
      directUpstreamResponse: true,
    };

    recordSuccessfulChatGPTAuth({ ...common, responseStatus: 401 });
    recordSuccessfulChatGPTAuth({
      ...common,
      responseStatus: 200,
      directUpstreamResponse: false,
    });
    recordSuccessfulChatGPTAuth({
      ...common,
      responseStatus: 200,
      responseURL: "https://proxy.example/backend-api/codex/responses",
    });
    expect(attribution().authKind).toBe("api_key");

    recordSuccessfulChatGPTAuth({ ...common, responseStatus: 200 });
    expect(attribution()).toMatchObject({
      provider: "openai",
      authKind: "subscription",
      account: "default",
    });
  });

  test("trusted subscription credential cache stays bounded without eviction", () => {
    const credentials = Array.from({ length: 257 }, (_, index) => ({
      scheme: "bearer" as const,
      value: `verified-token-${index}`,
    }));
    for (const credential of credentials) {
      recordSuccessfulChatGPTAuth({
        credential,
        upstreamURL: "https://chatgpt.com/backend-api",
        responseURL: "https://chatgpt.com/backend-api/codex/responses",
        responseStatus: 200,
        directUpstreamResponse: true,
      });
    }

    const attribution = (credential: (typeof credentials)[number]) =>
      resolveCostAttribution({
        providerID: "openai-codex",
        credential,
        upstreamURL: "https://chatgpt.com/backend-api",
      });
    expect(attribution(credentials[0]).authKind).toBe("subscription");
    expect(attribution(credentials[255]).authKind).toBe("subscription");
    expect(attribution(credentials[256]).authKind).toBe("api_key");
  });

  test("OpenAI subscriptions without trusted account data share the stable default", () => {
    const firstCredential = {
      scheme: "bearer" as const,
      value: "opaque-token-one",
    };
    const refreshedCredential = {
      scheme: "bearer" as const,
      value: "opaque-token-two",
    };
    const malformedCredential = {
      scheme: "bearer" as const,
      value: "header.!.signature",
    };
    for (const credential of [
      firstCredential,
      refreshedCredential,
      malformedCredential,
    ]) {
      recordSuccessfulChatGPTAuth({
        credential,
        upstreamURL: "https://chatgpt.com/backend-api",
        responseURL: "https://chatgpt.com/backend-api/codex/responses",
        responseStatus: 200,
        directUpstreamResponse: true,
      });
    }
    const first = resolveCostAttribution({
      providerID: "openai-codex",
      credential: firstCredential,
      upstreamURL: "https://chatgpt.com/backend-api",
    });
    const refreshed = resolveCostAttribution({
      providerID: "openai-codex",
      credential: refreshedCredential,
      upstreamURL: "https://chatgpt.com/backend-api",
    });
    const malformedJWT = resolveCostAttribution({
      providerID: "openai-codex",
      credential: malformedCredential,
      upstreamURL: "https://chatgpt.com/backend-api",
    });

    expect(first.authKind).toBe("subscription");
    expect(first.account).toBe("default");
    expect(refreshed.account).toBe("default");
    expect(malformedJWT.account).toBe("default");
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
    const firstCredential = {
      scheme: "bearer" as const,
      value: "sk-ant-oat01-first",
    };
    const refreshedCredential = {
      scheme: "bearer" as const,
      value: "sk-ant-oat01-refreshed",
    };
    const otherCredential = {
      scheme: "bearer" as const,
      value: "sk-ant-oat01-other",
    };
    trustAnthropicCredential(firstCredential);
    trustAnthropicCredential(refreshedCredential);
    trustAnthropicCredential(otherCredential);
    const first = resolveCostAttribution({
      providerID: "anthropic",
      credential: firstCredential,
      responseHeaders: new Headers({ "anthropic-organization-id": "org-123" }),
      ...TRUSTED_ANTHROPIC_RESPONSE,
    });
    const refreshed = resolveCostAttribution({
      providerID: "anthropic",
      credential: refreshedCredential,
      responseHeaders: new Headers({ "anthropic-organization-id": "org-123" }),
      ...TRUSTED_ANTHROPIC_RESPONSE,
    });
    const withoutOrganization = resolveCostAttribution({
      providerID: "anthropic",
      upstreamURL: ANTHROPIC_URL,
      credential: otherCredential,
    });

    expect(first).toMatchObject({ authKind: "subscription" });
    expect(first.account).toBe(refreshed.account);
    expect(first.account).toBe(
      createHash("sha256").update("org-123").digest("hex").slice(0, 12),
    );
    expect(withoutOrganization.account).toBe("default");
  });

  test("trusts direct Anthropic responses when Bun leaves Response.url empty", () => {
    const sessionID = "anthropic-empty-response-url-session";
    const responseHeaders = new Headers({
      "anthropic-organization-id": "org-empty-url",
    });
    recordSuccessfulAnthropicOAuthAuth({
      credential: OAUTH_CREDENTIAL,
      upstreamURL: ANTHROPIC_URL,
      responseURL: "",
      responseStatus: 200,
      directUpstreamResponse: true,
    });

    const attribution = resolveCostAttribution({
      sessionID,
      providerID: "anthropic",
      upstreamURL: ANTHROPIC_URL,
      credential: OAUTH_CREDENTIAL,
      responseHeaders,
      responseURL: "",
      responseStatus: 200,
      directUpstreamResponse: true,
    });
    cacheAnthropicOrganizationFromResponse({
      provider: attribution.provider,
      credential: OAUTH_CREDENTIAL,
      sessionID,
      observedAt: 1,
      responseStatus: 200,
      responseHeaders,
      upstreamURL: ANTHROPIC_URL,
      responseURL: "",
      directUpstreamResponse: true,
    });

    expect(isVerifiedAnthropicOAuthCredential(OAUTH_CREDENTIAL)).toBe(true);
    expect(attribution).toMatchObject({
      authKind: "subscription",
      account: createHash("sha256")
        .update("org-empty-url")
        .digest("hex")
        .slice(0, 12),
    });
    expect(
      resolveCostAttribution({
        sessionID,
        providerID: "anthropic",
        upstreamURL: ANTHROPIC_URL,
        credential: OAUTH_CREDENTIAL,
      }).account,
    ).toBe(attribution.account);
  });

  test("oversized Anthropic organization IDs do not select or cache an account", () => {
    const credential = {
      scheme: "bearer" as const,
      value: "sk-ant-oat01-oversized-org",
    };
    trustAnthropicCredential(credential);
    const responseHeaders = new Headers({
      "anthropic-organization-id": "o".repeat(129),
    });
    const attribution = resolveCostAttribution({
      providerID: "anthropic",
      credential,
      responseHeaders,
      ...TRUSTED_ANTHROPIC_RESPONSE,
    });

    cacheAnthropicOrganizationFromResponse({
      provider: attribution.provider,
      credential,
      sessionID: "oversized-anthropic-org-session",
      observedAt: 1,
      responseHeaders,
      ...TRUSTED_ANTHROPIC_RESPONSE,
    });

    expect(attribution.account).toBe("default");
    expect(
      resolveCostAttribution({
        sessionID: "oversized-anthropic-org-session",
        providerID: "anthropic",
        upstreamURL: ANTHROPIC_URL,
        credential,
      }).account,
    ).toBe("default");
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
    trustAnthropicCredential(credential);
    const responseHeaders = new Headers({
      "anthropic-organization-id": "org-cached",
    });
    const response = resolveCostAttribution({
      sessionID,
      providerID: "anthropic",
      credential,
      responseHeaders,
      ...TRUSTED_ANTHROPIC_RESPONSE,
    });
    cacheAnthropicOrganizationFromResponse({
      provider: response.provider,
      credential,
      sessionID,
      observedAt: 1,
      responseHeaders,
      ...TRUSTED_ANTHROPIC_RESPONSE,
    });
    const later = resolveCostAttribution({
      sessionID,
      providerID: "anthropic",
      upstreamURL: ANTHROPIC_URL,
      credential,
    });
    const unseenCredential = {
      scheme: "bearer" as const,
      value: "sk-ant-oat01-unseen",
    };
    trustAnthropicCredential(unseenCredential);
    const withoutKnownOrganization = resolveCostAttribution({
      providerID: "anthropic",
      upstreamURL: ANTHROPIC_URL,
      credential: unseenCredential,
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

  test("failed Anthropic responses cannot replace a verified organization", () => {
    _resetForTest();
    const sessionID = "anthropic-failed-org-session";
    const credential = {
      scheme: "bearer" as const,
      value: "sk-ant-oat01-failed-org",
    };
    trustAnthropicCredential(credential);
    const cacheOrganization = (
      organizationID: string,
      observedAt: number,
      responseStatus: number,
    ) => {
      const response = {
        ...TRUSTED_ANTHROPIC_RESPONSE,
        responseStatus,
      };
      cacheAnthropicOrganizationFromResponse({
        provider: "anthropic",
        credential,
        sessionID,
        observedAt,
        responseHeaders: new Headers({
          "anthropic-organization-id": organizationID,
        }),
        ...response,
      });
    };

    cacheOrganization("org-verified", 1, 200);
    cacheOrganization("org-from-rate-limit", 2, 429);

    const expectedAccount = createHash("sha256")
      .update("org-verified")
      .digest("hex")
      .slice(0, 12);
    expect(
      resolveCostAttribution({
        sessionID,
        providerID: "anthropic",
        upstreamURL: ANTHROPIC_URL,
        credential,
      }).account,
    ).toBe(expectedAccount);
    _resetForTest();
  });

  test("out-of-order successful responses use their own organization for quota attribution", () => {
    _resetForTest();
    const sessionID = "anthropic-out-of-order-org-session";
    const credential = {
      scheme: "bearer" as const,
      value: "sk-ant-oat01-out-of-order-org",
    };
    trustAnthropicCredential(credential);
    const response = (organizationID: string) =>
      new Headers({ "anthropic-organization-id": organizationID });
    const accountFor = (organizationID: string) =>
      createHash("sha256").update(organizationID).digest("hex").slice(0, 12);

    const newerHeaders = response("org-newer");
    cacheAnthropicOrganizationFromResponse({
      provider: "anthropic",
      credential,
      sessionID,
      observedAt: 200,
      responseHeaders: newerHeaders,
      ...TRUSTED_ANTHROPIC_RESPONSE,
    });
    const newerAttribution = resolveCostAttribution({
      sessionID,
      providerID: "anthropic",
      credential,
      responseHeaders: newerHeaders,
      ...TRUSTED_ANTHROPIC_RESPONSE,
    });

    const olderHeaders = response("org-older");
    const olderAttribution = resolveCostAttribution({
      sessionID,
      providerID: "anthropic",
      credential,
      responseHeaders: olderHeaders,
      ...TRUSTED_ANTHROPIC_RESPONSE,
    });
    cacheAnthropicOrganizationFromResponse({
      provider: olderAttribution.provider,
      credential,
      sessionID,
      observedAt: 100,
      responseHeaders: olderHeaders,
      ...TRUSTED_ANTHROPIC_RESPONSE,
    });

    expect(newerAttribution.account).toBe(accountFor("org-newer"));
    expect(olderAttribution.account).toBe(accountFor("org-older"));
    expect(
      resolveCostAttribution({
        sessionID,
        providerID: "anthropic",
        upstreamURL: ANTHROPIC_URL,
        credential,
      }).account,
    ).toBe(accountFor("org-newer"));
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
    trustAnthropicCredential(credentialA);
    trustAnthropicCredential(credentialB);
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
        ...TRUSTED_ANTHROPIC_RESPONSE,
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
        upstreamURL: ANTHROPIC_URL,
        credential: credentialA,
      }).account,
    ).toBe(accountA);
    expect(
      resolveCostAttribution({
        sessionID,
        providerID: "anthropic",
        upstreamURL: ANTHROPIC_URL,
        credential: credentialB,
      }).account,
    ).toBe("default");

    cacheOrganization(credentialB, "org-b");
    expect(
      resolveCostAttribution({
        sessionID,
        providerID: "anthropic",
        upstreamURL: ANTHROPIC_URL,
        credential: credentialB,
      }).account,
    ).toBe(accountB);
    expect(
      resolveCostAttribution({
        sessionID,
        providerID: "anthropic",
        upstreamURL: ANTHROPIC_URL,
        credential: credentialA,
      }).account,
    ).toBe(accountA);
    _resetForTest();
  });

  test("Codex response headers cannot classify API-key auth as a subscription", () => {
    const credential = { scheme: "api-key" as const, value: "synthetic-key" };
    const attribution = resolveCostAttribution({
      providerID: "openai-codex",
      credential,
      upstreamURL: "https://api.openai.com/v1/responses",
      responseHeaders: new Headers({ "x-codex-primary-used-percent": "10" }),
    });

    expect(attribution.authKind).toBe("api_key");
    expect(attribution.account).toBe(authFingerprint(credential).slice(0, 12));
  });

  test("canonical ChatGPT backend and bearer auth identify the subscription account", () => {
    const credential = {
      scheme: "bearer" as const,
      value: "opaque-subscription-token",
    };
    recordSuccessfulChatGPTAuth({
      credential,
      upstreamURL: "https://chatgpt.com/backend-api",
      responseURL: "https://chatgpt.com/backend-api/codex/responses",
      responseStatus: 200,
      directUpstreamResponse: true,
    });
    expect(
      resolveCostAttribution({
        providerID: "openai-codex",
        credential,
        upstreamURL: "https://chatgpt.com/backend-api",
        requestHeaders: new Headers({ "chatgpt-account-id": "caller-hint" }),
        responseHeaders: new Headers({ "x-codex-primary-used-percent": "10" }),
      }),
    ).toMatchObject({
      provider: "openai",
      authKind: "subscription",
      account: "default",
    });
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
