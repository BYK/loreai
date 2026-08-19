import { afterEach, describe, expect, test } from "vitest";
import { MockAgent } from "undici";
import { setUpstreamDispatcherForTest } from "../src/fetch";
import {
  createGatewayLLMClient,
  canonicalWorkerProviderID,
  getLastWorkerError,
  normalizedWorkerHostname,
  resolveTarget,
  workerOriginProtocolFamilies,
} from "../src/llm-adapter";

describe("worker route provenance", () => {
  let mock: MockAgent | undefined;

  afterEach(async () => {
    setUpstreamDispatcherForTest(null);
    await mock?.close();
    mock = undefined;
  });

  test("OpenAI Responses with no OpenAI upstream never leaks to Anthropic", async () => {
    mock = new MockAgent();
    mock.disableNetConnect();
    let anthropicRequests = 0;
    mock
      .get("https://api.anthropic.com")
      .intercept({ path: () => true, method: "POST" })
      .reply(() => {
        anthropicRequests++;
        return { statusCode: 200, data: "{}" };
      });
    setUpstreamDispatcherForTest(mock);

    const client = createGatewayLLMClient(
      { anthropic: "https://api.anthropic.com", openai: "" },
      (_session, provider) =>
        provider === "openai"
          ? { scheme: "api-key", value: "sk-openai-secret" }
          : null,
      { providerID: "openai", modelID: "gpt-5.6-sol" },
    );
    await expect(
      client.prompt("system", "user", {
        sessionID: "sess-route-provenance",
        workerID: "lore-distill",
        upstreamProviderID: "openai",
        protocol: "openai-responses",
      }),
    ).resolves.toBeNull();
    expect(anthropicRequests).toBe(0);
    expect(getLastWorkerError()).toContain("no upstream route for openai");
  });

  test.each([
    [
      "Gemini Developer API",
      "https://generativelanguage.googleapis.com",
      ["gemini", "openai"],
    ],
    [
      "Vertex regional",
      "https://us-central1-aiplatform.googleapis.com/v1/projects/proj/locations/us-central1/publishers/google",
      ["gemini", "vertex"],
    ],
    [
      "Vertex global",
      "https://aiplatform.googleapis.com/v1/projects/proj/locations/global/publishers/google",
      ["gemini", "vertex"],
    ],
    ["OpenAI", "https://api.openai.com/v1", ["openai"]],
    ["Anthropic", "https://api.anthropic.com/v1", ["anthropic"]],
    ["ChatGPT", "https://chatgpt.com/backend-api", ["openai"]],
  ])("classifies the %s canonical origin", (_name, url, expected) => {
    expect([...(workerOriginProtocolFamilies(url) ?? [])].sort()).toEqual(
      [...expected].sort(),
    );
  });

  test.each([
    ["OpenAI", "https://API.OPENAI.COM./v1", "api.openai.com", ["openai"]],
    [
      "Anthropic",
      "https://API.ANTHROPIC.COM./v1",
      "api.anthropic.com",
      ["anthropic"],
    ],
    ["ChatGPT", "https://CHATGPT.COM./backend-api", "chatgpt.com", ["openai"]],
    [
      "Gemini",
      "https://GENERATIVELANGUAGE.GOOGLEAPIS.COM./v1beta",
      "generativelanguage.googleapis.com",
      ["gemini", "openai"],
    ],
    [
      "Vertex regional",
      "https://US-CENTRAL1-AIPLATFORM.GOOGLEAPIS.COM./v1/projects/p/locations/us-central1",
      "us-central1-aiplatform.googleapis.com",
      ["gemini", "vertex"],
    ],
    [
      "Vertex global",
      "https://AIPLATFORM.GOOGLEAPIS.COM./v1/projects/p/locations/global",
      "aiplatform.googleapis.com",
      ["gemini", "vertex"],
    ],
  ])(
    "normalizes the %s terminal root dot for canonical classification",
    (_name, url, hostname, expected) => {
      expect(normalizedWorkerHostname(url)).toBe(hostname);
      expect([...(workerOriginProtocolFamilies(url) ?? [])].sort()).toEqual(
        [...expected].sort(),
      );
    },
  );

  test("supports only explicit provider alias families", () => {
    for (const id of ["vertex", "google-vertex", "google-vertex-anthropic"]) {
      expect(canonicalWorkerProviderID(id)).toBe("vertex");
    }
    for (const id of ["bedrock", "amazon-bedrock"]) {
      expect(canonicalWorkerProviderID(id)).toBe("bedrock");
    }
    for (const id of [
      "google",
      "gemini",
      "openai",
      "vertex-custom",
      "google-vertexx",
      "amazon-bedrock-custom",
    ]) {
      expect(canonicalWorkerProviderID(id)).toBe(id);
    }
  });

  test("allows pairwise aliases while rejecting near-name and cross-Google providers", () => {
    const defaults = {
      anthropic: "https://api.anthropic.com",
      openai: "https://api.openai.com",
    };
    const vertexUrl =
      "https://us-east1-aiplatform.googleapis.com/v1/projects/p/locations/us-east1";
    const vertexAliases = [
      "vertex",
      "google-vertex",
      "google-vertex-anthropic",
    ];
    for (const modelProvider of vertexAliases) {
      for (const sessionProvider of vertexAliases) {
        expect(
          resolveTarget(
            defaults,
            "vertex",
            vertexUrl,
            modelProvider,
            sessionProvider,
          ),
        ).toMatchObject({ url: vertexUrl, protocol: "vertex" });
      }
    }
    const bedrockUrl = "https://bedrock-mantle.us-east-1.api.aws/anthropic";
    for (const modelProvider of ["bedrock", "amazon-bedrock"]) {
      for (const sessionProvider of ["bedrock", "amazon-bedrock"]) {
        expect(
          resolveTarget(
            defaults,
            "anthropic",
            bedrockUrl,
            modelProvider,
            sessionProvider,
          ),
        ).toMatchObject({ url: bedrockUrl, protocol: "anthropic" });
      }
    }
    for (const nearName of [
      "vertex-custom",
      "google-vertexx",
      "amazon-bedrock-custom",
    ]) {
      expect(
        resolveTarget(defaults, "vertex", vertexUrl, "vertex", nearName),
      ).toMatchObject({ routeUnavailable: true, url: "" });
    }
    expect(
      resolveTarget(defaults, "gemini", vertexUrl, "google", "google"),
    ).toMatchObject({ routeUnavailable: true, url: "" });
    expect(
      resolveTarget(
        defaults,
        "gemini",
        "https://generativelanguage.googleapis.com",
        "vertex",
        "vertex",
      ),
    ).toMatchObject({ routeUnavailable: true, url: "" });
  });

  test("applies exact protocol capabilities after alias-family matching", () => {
    const defaults = {
      anthropic: "https://api.anthropic.com",
      openai: "https://api.openai.com",
    };
    const vertexUrl =
      "https://us-east1-aiplatform.googleapis.com/v1/projects/p/locations/us-east1";
    const vertexProviders = [
      "vertex",
      "google-vertex",
      "google-vertex-anthropic",
    ] as const;
    const protocols = ["vertex", "gemini", "openai", "anthropic"] as const;
    for (const modelProvider of vertexProviders) {
      for (const sessionProvider of vertexProviders) {
        for (const protocol of protocols) {
          const allowed =
            protocol === "vertex" ||
            (protocol === "gemini" &&
              modelProvider === "google-vertex" &&
              sessionProvider === "google-vertex");
          const target = resolveTarget(
            defaults,
            protocol,
            vertexUrl,
            modelProvider,
            sessionProvider,
          );
          if (allowed) {
            expect(target).toMatchObject({ url: vertexUrl, protocol });
          } else {
            expect(target).toMatchObject({ routeUnavailable: true, url: "" });
          }
        }
      }
    }

    const bedrockUrl = "https://bedrock-mantle.us-east-1.api.aws/anthropic";
    for (const modelProvider of ["bedrock", "amazon-bedrock"] as const) {
      for (const sessionProvider of ["bedrock", "amazon-bedrock"] as const) {
        for (const protocol of protocols) {
          const target = resolveTarget(
            defaults,
            protocol,
            bedrockUrl,
            modelProvider,
            sessionProvider,
          );
          if (protocol === "anthropic") {
            expect(target).toMatchObject({ url: bedrockUrl, protocol });
          } else {
            expect(target).toMatchObject({ routeUnavailable: true, url: "" });
          }
        }
      }
    }
  });

  test.each([
    ["OpenAI", "api.openai.com", "/v1", "openai", "openai"],
    ["Anthropic", "api.anthropic.com", "/v1", "anthropic", "anthropic"],
    ["ChatGPT", "chatgpt.com", "/backend-api", "openai", "openai"],
    [
      "Gemini",
      "generativelanguage.googleapis.com",
      "/v1beta",
      "google",
      "gemini",
    ],
    [
      "Vertex regional",
      "us-east1-aiplatform.googleapis.com",
      "/v1/projects/p/locations/us-east1",
      "vertex",
      "vertex",
    ],
    [
      "Vertex global",
      "aiplatform.googleapis.com",
      "/v1/projects/p/locations/global",
      "vertex",
      "vertex",
    ],
  ] as const)(
    "requires HTTPS on the effective default port for %s canonical evidence",
    (_name, host, path, provider, protocol) => {
      const defaults = {
        anthropic: "https://api.anthropic.com",
        openai: "https://api.openai.com",
      };
      for (const url of [
        `https://${host}${path}`,
        `https://${host.toUpperCase()}.:443${path}`,
      ]) {
        expect(workerOriginProtocolFamilies(url)?.size).toBeGreaterThan(0);
        expect(
          resolveTarget(defaults, protocol, url, provider, provider),
        ).not.toMatchObject({ routeUnavailable: true });
      }
      for (const url of [
        `http://${host}${path}`,
        `ftp://${host}${path}`,
        `ws://${host}${path}`,
        `https://${host}:444${path}`,
      ]) {
        expect(workerOriginProtocolFamilies(url)).toEqual(new Set());
        expect(
          resolveTarget(defaults, protocol, url, provider, provider),
        ).toMatchObject({ routeUnavailable: true, url: "" });
      }
    },
  );

  test("does not reclassify known invalid canonical origins as custom", () => {
    const defaults = {
      anthropic: "https://api.anthropic.com",
      openai: "https://api.openai.com",
    };
    expect(
      workerOriginProtocolFamilies("https://chatgpt.com/custom-api"),
    ).toEqual(new Set());
    expect(
      resolveTarget(
        defaults,
        "openai-codex-responses",
        "https://chatgpt.com/custom-api",
        "openai",
        "openai",
      ),
    ).toMatchObject({ routeUnavailable: true, url: "" });

    // Unknown custom hosts retain the explicit-provenance behavior.
    expect(
      resolveTarget(
        defaults,
        "openai",
        "http://custom.internal:444/api",
        "custom-provider",
        "custom-provider",
      ),
    ).toMatchObject({
      url: "http://custom.internal:444/api",
      protocol: "openai",
    });
  });

  test("normalizes accepted canonical targets and rejects trailing-dot relabeling", () => {
    const defaults = {
      anthropic: "https://api.anthropic.com.",
      openai: "https://api.openai.com.",
    };
    expect(
      resolveTarget(defaults, "anthropic", undefined, "anthropic").url,
    ).toBe("https://api.anthropic.com");
    expect(
      resolveTarget(defaults, "openai-responses", undefined, "openai").url,
    ).toBe("https://api.openai.com");
    expect(
      resolveTarget(
        defaults,
        "openai-responses",
        "https://api.anthropic.com.",
        "openai",
        "openai",
      ),
    ).toMatchObject({ routeUnavailable: true, url: "" });
    expect(
      resolveTarget(
        defaults,
        "anthropic",
        "https://api.openai.com.",
        "anthropic",
        "anthropic",
      ),
    ).toMatchObject({ routeUnavailable: true, url: "" });
  });

  test("resolves canonical and configured provider aliases without crossing families", () => {
    const defaults = {
      anthropic: "https://api.anthropic.com",
      openai: "https://api.openai.com",
    };

    expect(
      resolveTarget(defaults, "gemini", undefined, "google"),
    ).toMatchObject({
      url: "https://generativelanguage.googleapis.com",
      protocol: "gemini",
      providerName: "google",
    });
    for (const vertexUrl of [
      "https://europe-west1-aiplatform.googleapis.com/v1/projects/p/locations/europe-west1/publishers/google",
      "https://aiplatform.googleapis.com/v1/projects/p/locations/global/publishers/google",
    ]) {
      expect(
        resolveTarget(
          defaults,
          "gemini",
          vertexUrl,
          "google-vertex",
          "google-vertex",
        ),
      ).toMatchObject({ url: vertexUrl, protocol: "gemini" });
      expect(
        resolveTarget(defaults, "vertex", vertexUrl, "vertex", "vertex"),
      ).toMatchObject({ url: vertexUrl, protocol: "vertex" });
    }

    expect(
      resolveTarget(
        { ...defaults, openai: "https://openai.internal/api" },
        "openai-responses",
        undefined,
        "openai",
      ),
    ).toMatchObject({
      url: "https://openai.internal/api",
      protocol: "openai-responses",
    });
    expect(
      resolveTarget(
        { ...defaults, anthropic: "https://anthropic.internal/api" },
        "anthropic",
        undefined,
        "anthropic",
      ),
    ).toMatchObject({
      url: "https://anthropic.internal/api",
      protocol: "anthropic",
    });
    expect(
      resolveTarget(
        defaults,
        "gemini",
        "https://gemini.internal/base",
        "google",
        "google",
      ),
    ).toMatchObject({
      url: "https://gemini.internal/base",
      protocol: "gemini",
    });
    expect(
      resolveTarget(
        defaults,
        "openai-codex-responses",
        "https://chatgpt.com/backend-api",
        "openai",
        "openai",
      ),
    ).toMatchObject({
      url: "https://chatgpt.com/backend-api",
      protocol: "openai-codex-responses",
    });

    // Canonical provider ownership cannot be forged by a matching label.
    expect(
      resolveTarget(
        defaults,
        "openai-responses",
        "https://api.anthropic.com",
        "openai",
        "openai",
      ),
    ).toMatchObject({ routeUnavailable: true, url: "" });
    expect(
      resolveTarget(
        defaults,
        "gemini",
        "https://generativelanguage.googleapis.com",
        "unrelated-provider",
        "unrelated-provider",
      ),
    ).toMatchObject({ routeUnavailable: true, url: "" });
    expect(
      resolveTarget(
        defaults,
        "anthropic",
        "https://api.openai.com",
        "anthropic",
        "anthropic",
      ),
    ).toMatchObject({ routeUnavailable: true, url: "" });

    // A foreign explicit override is rejected; resolution stays on the model's
    // own trusted route rather than sending credentials to that override.
    expect(
      resolveTarget(
        defaults,
        "openai-responses",
        "https://api.anthropic.com",
        "openai",
        "anthropic",
      ).url,
    ).toBe("https://api.openai.com");
    expect(
      resolveTarget(
        defaults,
        "anthropic",
        "https://api.openai.com",
        "anthropic",
        "openai",
      ).url,
    ).toBe("https://api.anthropic.com");
  });
});
