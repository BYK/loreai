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
  buildVertexUpstream,
  isVertexHost,
  toVertexBody,
  toVertexModelId,
  VERTEX_ANTHROPIC_VERSION,
  vertexHost,
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
  test("builds the global :streamRawPredict URL on the bare aiplatform host", () => {
    // The global endpoint is served from the BARE `aiplatform.googleapis.com`
    // host — NOT `global-aiplatform.googleapis.com` (which resolves but 404s on
    // the rawPredict path, verified live). The path still carries
    // `locations/global`. Regression guard for that live-confirmed bug.
    const url = vertexRawPredictUrl(
      "global",
      "my-proj",
      "claude-opus-4-8",
      true,
    );
    expect(url).toBe(
      "https://aiplatform.googleapis.com/v1/projects/my-proj/locations/global/publishers/anthropic/models/claude-opus-4-8:streamRawPredict",
    );
    expect(url).not.toContain("global-aiplatform.googleapis.com");
  });

  test("builds a regional :rawPredict URL (non-streaming)", () => {
    expect(vertexRawPredictUrl("us-east1", "p", "claude-opus-4-8", false)).toBe(
      "https://us-east1-aiplatform.googleapis.com/v1/projects/p/locations/us-east1/publishers/anthropic/models/claude-opus-4-8:rawPredict",
    );
  });

  test("keeps a literal @ in a dated model id (no %40 encoding)", () => {
    // Vertex (and Google's SDK) expect the unencoded "@" in the path; "%40"
    // risks a 404. Guard against a regression back to encodeURIComponent's "%40".
    const url = vertexRawPredictUrl(
      "global",
      "p",
      "claude-haiku-4-5@20251001",
      false,
    );
    expect(url).toContain("models/claude-haiku-4-5@20251001:rawPredict");
    expect(url).not.toContain("%40");
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

describe("vertexHost", () => {
  test("global → bare aiplatform host; regional → prefixed host", () => {
    expect(vertexHost("global")).toBe("aiplatform.googleapis.com");
    expect(vertexHost("us-east5")).toBe("us-east5-aiplatform.googleapis.com");
    // Regression: global must NEVER produce the dead global-aiplatform host.
    expect(vertexHost("global")).not.toBe("global-aiplatform.googleapis.com");
  });
});

describe("vertexRegionFromUrl / isVertexHost", () => {
  test("extracts the region from base URL or bare host", () => {
    expect(
      vertexRegionFromUrl("https://us-east1-aiplatform.googleapis.com"),
    ).toBe("us-east1");
    // The bare host is the global endpoint.
    expect(vertexRegionFromUrl("https://aiplatform.googleapis.com")).toBe(
      "global",
    );
    expect(vertexRegionFromUrl("aiplatform.googleapis.com")).toBe("global");
    // Legacy global-aiplatform host still parses to "global" so a manually
    // configured upstream self-heals to the bare host on the next rebuild.
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
  // Bare host = the global endpoint (NOT global-aiplatform; see vertexHost).
  const vertexBase = "https://aiplatform.googleapis.com";

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

  test("normalizes a legacy global-aiplatform base to the bare host", () => {
    const profile = resolveProfile(
      "claude-opus-4-8",
      "vertex",
      "5m",
      "https://global-aiplatform.googleapis.com",
      "google-vertex",
    );
    expect(profile?.upstreamUrl).toBe("https://aiplatform.googleapis.com");
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

  test("warmup body strips stream/model and keeps anthropic_version", () => {
    // Regression: prepareAnthropicWarmupBody re-adds `stream:false`, which
    // Vertex rejects. The vertex profile must re-strip it (and `model`).
    const profile = resolveProfile(
      "claude-opus-4-8",
      "vertex",
      "5m",
      vertexBase,
      "google-vertex",
    );
    expect(profile).not.toBeNull();
    // A stored Vertex body (as lastRequestBody would hold) carrying a stray
    // stream/model — the warmup transform must remove both.
    const stored = JSON.stringify({
      anthropic_version: "vertex-2023-10-16",
      model: "claude-opus-4-8",
      stream: true,
      max_tokens: 1024,
      system: [
        { type: "text", text: "s", cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: "hi" }],
    });
    const warmup = JSON.parse(profile?.prepareWarmupBody(stored) ?? "{}");
    expect("stream" in warmup).toBe(false);
    expect("model" in warmup).toBe(false);
    expect(warmup.anthropic_version).toBe("vertex-2023-10-16");
  });

  test("threads prefixTokens through to a size-scaled 5m margin", () => {
    // Vertex Claude uses Anthropic prompt caching, so it is exposed to the same
    // large-prefix TTL-race partial as the first-party path — the size-aware
    // margin must apply here too (computeWarmupMargin).
    const flat = resolveProfile(
      "claude-opus-4-8",
      "vertex",
      "5m",
      vertexBase,
      "google-vertex",
    );
    const scaled = resolveProfile(
      "claude-opus-4-8",
      "vertex",
      "5m",
      vertexBase,
      "google-vertex",
      164_807,
    );
    expect(flat?.warmupMarginMs).toBe(45_000);
    expect(scaled?.warmupMarginMs).toBeCloseTo(89_497.89, 2);
    // 1h vertex stays flat regardless of prefix size.
    const oneHour = resolveProfile(
      "claude-opus-4-8",
      "vertex",
      "1h",
      vertexBase,
      "google-vertex",
      1_000_000,
    );
    expect(oneHour?.warmupMarginMs).toBe(300_000);
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

describe("buildVertexUpstream — conversation transport rewrite", () => {
  // A representative `buildAnthropicRequest` result: Claude Code forwards
  // x-api-key, anthropic-version, AND anthropic-beta (prompt-caching/extended-
  // cache-ttl/context-1m beta tokens); the body carries model + stream.
  const baseOpts = () => ({
    anthropicHeaders: {
      "content-type": "application/json",
      "x-api-key": "sk-ant-client-key",
      "anthropic-version": "2023-06-01",
      "anthropic-beta":
        "prompt-caching-2024-07-31,extended-cache-ttl-2025-04-11",
      "user-agent": "claude-cli/2.0",
    } as Record<string, string>,
    anthropicBody: {
      model: "claude-opus-4-5",
      stream: true,
      max_tokens: 1024,
      messages: [{ role: "user", content: "hi" }],
    } as Record<string, unknown>,
    configRegion: "global",
    project: "my-proj",
    model: "claude-opus-4-5",
    stream: true,
    token: "gcp-oauth-token",
  });

  test("strips x-api-key, anthropic-version AND anthropic-beta; sets the bearer", () => {
    // Regression for Seer #14881922/0: anthropic-beta is an api.anthropic.com-
    // only header; forwarding it to Vertex risks a 400. It must be removed, like
    // x-api-key and anthropic-version already were.
    const { headers } = buildVertexUpstream({
      ...baseOpts(),
      effectiveUpstreamBase: "https://aiplatform.googleapis.com",
    });
    expect("x-api-key" in headers).toBe(false);
    expect("anthropic-version" in headers).toBe(false);
    expect("anthropic-beta" in headers).toBe(false);
    expect(headers.Authorization).toBe("Bearer gcp-oauth-token");
    // Non-Anthropic forwarded headers (e.g. content-type, user-agent) survive.
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["user-agent"]).toBe("claude-cli/2.0");
  });

  test("does not mutate the caller's header object", () => {
    const opts = {
      ...baseOpts(),
      effectiveUpstreamBase: "https://aiplatform.googleapis.com",
    };
    buildVertexUpstream(opts);
    // The source headers are untouched (a fresh copy is rewritten).
    expect(opts.anthropicHeaders["anthropic-beta"]).toBe(
      "prompt-caching-2024-07-31,extended-cache-ttl-2025-04-11",
    );
    expect(opts.anthropicHeaders["x-api-key"]).toBe("sk-ant-client-key");
  });

  test("transforms the body: drops model/stream, injects anthropic_version", () => {
    const { body } = buildVertexUpstream({
      ...baseOpts(),
      effectiveUpstreamBase: "https://aiplatform.googleapis.com",
    });
    expect(body.anthropic_version).toBe(VERTEX_ANTHROPIC_VERSION);
    expect("model" in body).toBe(false);
    expect("stream" in body).toBe(false);
    expect(body.max_tokens).toBe(1024);
  });

  test("honors an X-Lore-Upstream-URL regional override for the URL region", () => {
    // Regression for Seer #14881922/1: a regional X-Lore-Upstream-URL must win
    // over config.vertexRegion (which here is "global"). The override host's
    // region is parsed and threaded into the rawPredict URL.
    const { url } = buildVertexUpstream({
      ...baseOpts(),
      effectiveUpstreamBase: "https://us-east1-aiplatform.googleapis.com",
    });
    expect(url).toBe(
      "https://us-east1-aiplatform.googleapis.com/v1/projects/my-proj/locations/us-east1/publishers/anthropic/models/claude-opus-4-5@20251101:streamRawPredict",
    );
  });

  test("falls back to configRegion when the base is the self-built global host", () => {
    // No header override → effectiveUpstreamBase is the self-built global host;
    // vertexRegionFromUrl round-trips configRegion ("global" → bare host + path).
    const { url } = buildVertexUpstream({
      ...baseOpts(),
      configRegion: "global",
      effectiveUpstreamBase: "https://aiplatform.googleapis.com",
    });
    expect(url).toBe(
      "https://aiplatform.googleapis.com/v1/projects/my-proj/locations/global/publishers/anthropic/models/claude-opus-4-5@20251101:streamRawPredict",
    );
  });

  test("falls back to configRegion when the base is not a Vertex host", () => {
    // A non-Vertex effectiveUpstreamBase (e.g. a proxy/multi-region endpoint
    // vertexRegionFromUrl can't parse) → configRegion is used, never null/"".
    const { url } = buildVertexUpstream({
      ...baseOpts(),
      configRegion: "europe-west1",
      effectiveUpstreamBase: "https://aiplatform.eu.rep.googleapis.com",
    });
    expect(url).toContain("https://europe-west1-aiplatform.googleapis.com/");
    expect(url).toContain("/locations/europe-west1/");
  });

  test("selects the :rawPredict verb for a non-streaming request", () => {
    const { url } = buildVertexUpstream({
      ...baseOpts(),
      stream: false,
      effectiveUpstreamBase: "https://aiplatform.googleapis.com",
    });
    expect(url.endsWith(":rawPredict")).toBe(true);
  });
});
