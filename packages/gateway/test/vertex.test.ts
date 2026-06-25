/**
 * Unit tests for the Google Vertex AI (Claude) integration.
 *
 * Vertex speaks the native Anthropic Messages body but to a `:rawPredict` URL
 * (model in the path), with `anthropic_version` in the body and GCP OAuth2
 * auth. The Vertex-specific code is: the model-id remap (`toVertexModelId`),
 * the URL builder (`vertexRawPredictUrl`), the body transform (`toVertexBody`),
 * the host/region helpers, the provider routes, the worker protocol, the warmer
 * profile, and the ADC token seam. End-to-end routing is covered in
 * `vertex-routing.test.ts`.
 */
import { afterEach, describe, expect, test } from "vitest";
import {
  isVertexHost,
  toVertexBody,
  toVertexModelId,
  VERTEX_ANTHROPIC_VERSION,
  vertexRawPredictUrl,
  vertexRegionFromUrl,
} from "../src/translate/vertex";
import { resolveProviderRoute } from "../src/config";
import { resolveWorkerProtocol } from "../src/llm-adapter";
import { resolveProfile } from "../src/cache-warmer";
import {
  _setTestVertexTokenProvider,
  getVertexAccessToken,
  resolveVertexProject,
} from "../src/vertex-auth";

describe("toVertexModelId", () => {
  test("passes through short ids that Vertex uses verbatim", () => {
    expect(toVertexModelId("claude-opus-4-8")).toBe("claude-opus-4-8");
    expect(toVertexModelId("claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
    expect(toVertexModelId("claude-fable-5")).toBe("claude-fable-5");
  });

  test("maps short ids that Vertex pins to a dated id", () => {
    expect(toVertexModelId("claude-haiku-4-5")).toBe(
      "claude-haiku-4-5@20251001",
    );
    expect(toVertexModelId("claude-sonnet-4-5")).toBe(
      "claude-sonnet-4-5@20250929",
    );
  });

  test("converts an Anthropic dash-date id to Vertex @-date form", () => {
    expect(toVertexModelId("claude-3-5-haiku-20241022")).toBe(
      "claude-3-5-haiku@20241022",
    );
    expect(toVertexModelId("claude-opus-4-1-20250805")).toBe(
      "claude-opus-4-1@20250805",
    );
  });

  test("leaves an already-Vertex-dated id unchanged (idempotent)", () => {
    expect(toVertexModelId("claude-sonnet-4-5@20250929")).toBe(
      "claude-sonnet-4-5@20250929",
    );
    expect(toVertexModelId(toVertexModelId("claude-sonnet-4-5"))).toBe(
      "claude-sonnet-4-5@20250929",
    );
  });

  test("does not resolve inherited Object.prototype members", () => {
    expect(toVertexModelId("valueOf")).toBe("valueOf");
    expect(toVertexModelId("toString")).toBe("toString");
  });
});

describe("vertexRawPredictUrl", () => {
  test("builds the global :streamRawPredict URL", () => {
    expect(
      vertexRawPredictUrl("global", "my-proj", "claude-opus-4-8", true),
    ).toBe(
      "https://global-aiplatform.googleapis.com/v1/projects/my-proj/locations/global/publishers/anthropic/models/claude-opus-4-8:streamRawPredict",
    );
  });

  test("builds a regional :rawPredict URL (non-streaming)", () => {
    expect(vertexRawPredictUrl("us-east1", "p", "claude-opus-4-8", false)).toBe(
      "https://us-east1-aiplatform.googleapis.com/v1/projects/p/locations/us-east1/publishers/anthropic/models/claude-opus-4-8:rawPredict",
    );
  });

  test("URL-encodes the model id (the @ in a dated id)", () => {
    expect(
      vertexRawPredictUrl("global", "p", "claude-haiku-4-5@20251001", false),
    ).toContain("models/claude-haiku-4-5%4020251001:rawPredict");
  });
});

describe("toVertexBody", () => {
  test("strips model + stream and injects anthropic_version", () => {
    const out = toVertexBody({
      model: "claude-opus-4-8",
      stream: true,
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(out.anthropic_version).toBe(VERTEX_ANTHROPIC_VERSION);
    expect("model" in out).toBe(false);
    expect("stream" in out).toBe(false);
    expect(out.max_tokens).toBe(100);
    expect(out.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  test("preserves system + tools + cache_control verbatim", () => {
    const system = [
      { type: "text", text: "sys", cache_control: { type: "ephemeral" } },
    ];
    const tools = [{ name: "t", input_schema: { type: "object" } }];
    const out = toVertexBody({ model: "m", system, tools });
    expect(out.system).toEqual(system);
    expect(out.tools).toEqual(tools);
  });

  test("does not mutate the input object", () => {
    const input = { model: "m", stream: false, max_tokens: 1 };
    const snapshot = JSON.stringify(input);
    toVertexBody(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe("vertexRegionFromUrl / isVertexHost", () => {
  test("extracts the region from base URL or bare host", () => {
    expect(
      vertexRegionFromUrl("https://us-east1-aiplatform.googleapis.com"),
    ).toBe("us-east1");
    expect(vertexRegionFromUrl("global-aiplatform.googleapis.com")).toBe(
      "global",
    );
    expect(
      vertexRegionFromUrl(
        "https://global-aiplatform.googleapis.com/v1/projects/p/locations/global/publishers/anthropic/models/claude-opus-4-8:rawPredict",
      ),
    ).toBe("global");
  });

  test("rejects non-Vertex and spoofed hosts", () => {
    expect(vertexRegionFromUrl("https://api.anthropic.com")).toBeNull();
    expect(isVertexHost("https://api.anthropic.com")).toBe(false);
    // Spoof: aiplatform as a subdomain of an attacker host.
    expect(
      isVertexHost("https://global-aiplatform.googleapis.com.evil.com"),
    ).toBe(false);
    expect(isVertexHost("")).toBe(false);
  });
});

describe("resolveProviderRoute — vertex (self-URL-building, OAuth2)", () => {
  for (const id of ["vertex", "google-vertex", "google-vertex-anthropic"]) {
    test(`"${id}" routes via the vertex protocol with null url`, () => {
      const route = resolveProviderRoute(id);
      expect(route).not.toBeNull();
      // url is null — the region URL is built at request time.
      expect(route?.url).toBeNull();
      expect(route?.protocol).toBe("vertex");
    });
  }
});

describe("resolveWorkerProtocol — vertex (distinct, not collapsed)", () => {
  test("a vertex session keeps the vertex worker protocol", () => {
    // Vertex must NOT collapse to anthropic — workers need the rawPredict URL
    // + OAuth2, handled by buildVertexWorkerRequest.
    expect(resolveWorkerProtocol("google-vertex", "vertex")).toBe("vertex");
    expect(resolveWorkerProtocol("vertex", "vertex")).toBe("vertex");
    // Route-table lookup (no explicit hint) also resolves to vertex.
    expect(resolveWorkerProtocol("google-vertex")).toBe("vertex");
  });
});

describe("resolveProfile — vertex warming", () => {
  const vertexBase = "https://global-aiplatform.googleapis.com";

  test("warms a vertex session (provider id + host)", () => {
    const profile = resolveProfile(
      "claude-opus-4-8",
      "vertex",
      "5m",
      vertexBase,
      "google-vertex",
    );
    expect(profile).not.toBeNull();
    expect(profile?.authMode).toBe("vertex");
    // upstreamUrl is the region base — executeWarmup rebuilds the rawPredict URL.
    expect(profile?.upstreamUrl).toBe(vertexBase);
  });

  test("skips a vertex protocol with a non-vertex host (no leak)", () => {
    const profile = resolveProfile(
      "claude-opus-4-8",
      "vertex",
      "5m",
      "https://api.anthropic.com",
      undefined,
    );
    expect(profile).toBeNull();
  });
});

describe("vertex-auth — ADC token seam", () => {
  afterEach(() => _setTestVertexTokenProvider(null));

  test("getVertexAccessToken returns the injected test token", async () => {
    _setTestVertexTokenProvider(() => Promise.resolve("test-token-123"));
    expect(await getVertexAccessToken()).toBe("test-token-123");
  });

  test("resolveVertexProject prefers the configured project (no ADC call)", async () => {
    _setTestVertexTokenProvider(() => Promise.resolve("t"));
    expect(await resolveVertexProject("explicit-proj")).toBe("explicit-proj");
  });
});
