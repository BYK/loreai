/**
 * Tests for `src/http-body.ts` — request-body `Content-Encoding` codecs.
 *
 * Regression coverage for issue #1032: the Codex CLI zstd-compresses request
 * bodies by default (ChatGPT auth), and the gateway must decode them on ingress
 * and re-encode them on the way upstream.
 */
import { describe, test, expect } from "vitest";
import {
  brotliCompressSync,
  deflateRawSync,
  deflateSync,
  gzipSync,
  zstdCompressSync,
  zstdDecompressSync,
} from "node:zlib";
import {
  buildUpstreamRouteContext,
  compressBody,
  decodeRequestBody,
  decompressBody,
  encodeUpstreamBody,
  encodeUpstreamBodyForRoute,
  isSupportedEncoding,
  mayReencodeUpstream,
  normalizeRequestEncoding,
} from "../src/http-body";

const SAMPLE = JSON.stringify({
  model: "gpt-5-codex",
  input: [{ type: "message", role: "user", content: "compress me" }],
  nested: { a: 1, b: [true, false, null], unicode: "héllo — 世界" },
});

/** Build a Request whose body is `bytes` with the given Content-Encoding. */
function reqWith(bytes: Uint8Array | string, encoding?: string): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (encoding) headers["content-encoding"] = encoding;
  return new Request("http://gateway.local/v1/responses", {
    method: "POST",
    headers,
    // Wrap Buffer/Uint8Array in a fresh Uint8Array so it satisfies `BodyInit`.
    body: typeof bytes === "string" ? bytes : new Uint8Array(bytes),
  });
}

const ENCODERS: Record<string, (s: string) => Buffer> = {
  zstd: (s) => zstdCompressSync(Buffer.from(s, "utf8")),
  gzip: (s) => gzipSync(Buffer.from(s, "utf8")),
  br: (s) => brotliCompressSync(Buffer.from(s, "utf8")),
  deflate: (s) => deflateSync(Buffer.from(s, "utf8")),
};

describe("normalizeRequestEncoding", () => {
  test("returns null for absent/empty/identity", () => {
    expect(normalizeRequestEncoding(null)).toBeNull();
    expect(normalizeRequestEncoding(undefined)).toBeNull();
    expect(normalizeRequestEncoding("")).toBeNull();
    expect(normalizeRequestEncoding("identity")).toBeNull();
    expect(normalizeRequestEncoding("  identity  ")).toBeNull();
  });

  test("lowercases and trims, taking the first token", () => {
    expect(normalizeRequestEncoding("ZSTD")).toBe("zstd");
    expect(normalizeRequestEncoding(" gzip ")).toBe("gzip");
    expect(normalizeRequestEncoding("zstd, identity")).toBe("zstd");
  });
});

describe("isSupportedEncoding", () => {
  test("accepts the codecs the gateway can round-trip", () => {
    for (const enc of ["zstd", "gzip", "x-gzip", "br", "deflate"]) {
      expect(isSupportedEncoding(enc)).toBe(true);
    }
  });

  test("rejects null and unknown encodings", () => {
    expect(isSupportedEncoding(null)).toBe(false);
    expect(isSupportedEncoding("identity")).toBe(false);
    expect(isSupportedEncoding("snappy")).toBe(false);
  });
});

describe("compressBody / decompressBody round-trip", () => {
  test.each(["zstd", "gzip", "x-gzip", "br", "deflate"])("%s", (enc) => {
    const compressed = compressBody(SAMPLE, enc);
    expect(decompressBody(compressed, enc).toString("utf8")).toBe(SAMPLE);
  });

  test("throws on an unsupported encoding", () => {
    expect(() => compressBody(SAMPLE, "snappy")).toThrow(/Unsupported/);
    expect(() => decompressBody(new Uint8Array([1, 2, 3]), "snappy")).toThrow(
      /Unsupported/,
    );
  });

  test("deflate decode falls back to raw DEFLATE (no zlib header)", () => {
    // Some clients send raw DEFLATE streams; decompressBody must inflate them
    // via the inflateRawSync fallback when the zlib-header parse fails.
    const raw = deflateRawSync(Buffer.from(SAMPLE, "utf8"));
    expect(decompressBody(raw, "deflate").toString("utf8")).toBe(SAMPLE);
  });
});

describe("decodeRequestBody", () => {
  test.each([
    "zstd",
    "gzip",
    "br",
    "deflate",
  ])("decodes a %s-compressed body back to the original JSON text", async (enc) => {
    const text = await decodeRequestBody(reqWith(ENCODERS[enc](SAMPLE), enc));
    expect(text).toBe(SAMPLE);
    expect(JSON.parse(text)).toMatchObject({ model: "gpt-5-codex" });
  });

  test("passes an unencoded body through unchanged", async () => {
    expect(await decodeRequestBody(reqWith(SAMPLE))).toBe(SAMPLE);
    expect(await decodeRequestBody(reqWith(SAMPLE, "identity"))).toBe(SAMPLE);
  });

  test("rejects malformed compressed bytes (would 400 in the handler)", async () => {
    const garbage = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
    await expect(decodeRequestBody(reqWith(garbage, "zstd"))).rejects.toThrow();
  });

  test("rejects an unsupported Content-Encoding", async () => {
    await expect(decodeRequestBody(reqWith(SAMPLE, "snappy"))).rejects.toThrow(
      /Unsupported/,
    );
  });
});

describe("encodeUpstreamBody", () => {
  test("re-compresses with the client's encoding and reports the header", () => {
    const { body, contentEncoding } = encodeUpstreamBody(SAMPLE, "zstd");
    expect(contentEncoding).toBe("zstd");
    expect(body).toBeInstanceOf(Uint8Array);
    expect(zstdDecompressSync(body as Uint8Array).toString("utf8")).toBe(
      SAMPLE,
    );
  });

  test("normalizes the encoding token before compressing", () => {
    const { body, contentEncoding } = encodeUpstreamBody(
      SAMPLE,
      "ZSTD, identity",
    );
    expect(contentEncoding).toBe("zstd");
    expect(zstdDecompressSync(body as Uint8Array).toString("utf8")).toBe(
      SAMPLE,
    );
  });

  test("sends uncompressed (no header) when there is no encoding", () => {
    expect(encodeUpstreamBody(SAMPLE, null)).toEqual({
      body: SAMPLE,
      contentEncoding: null,
    });
    expect(encodeUpstreamBody(SAMPLE, "identity")).toEqual({
      body: SAMPLE,
      contentEncoding: null,
    });
  });

  test("sends uncompressed when the encoding is unsupported", () => {
    expect(encodeUpstreamBody(SAMPLE, "snappy")).toEqual({
      body: SAMPLE,
      contentEncoding: null,
    });
  });
});

// Shared origins for the route-context truth table.
const OPENAI = "https://api.openai.com";
const ANTHROPIC = "https://api.anthropic.com";
const DEEPSEEK = "https://api.deepseek.com";

describe("mayReencodeUpstream", () => {
  test("permits re-encoding on a native passthrough (no overrides, same protocol + origin)", () => {
    // The Codex native path: openai-responses in, openai-responses out, same
    // upstream origin — a trusted destination.
    expect(
      mayReencodeUpstream({
        hasUpstreamUrlOverride: false,
        hasProviderOverride: false,
        ingressProtocol: "openai-responses",
        effectiveProtocol: "openai-responses",
        ingressOrigin: OPENAI,
        effectiveOrigin: OPENAI,
      }),
    ).toBe(true);
  });

  test("permits re-encoding when X-Lore-Provider is set even if the destination differs", () => {
    // Explicit provider override → the user/plugin chose the destination, so we
    // trust it accepts the client's encoding (e.g. Codex → openai-codex; this is
    // also how Vertex/Bedrock are reached — always provider-tagged).
    expect(
      mayReencodeUpstream({
        hasUpstreamUrlOverride: false,
        hasProviderOverride: true,
        ingressProtocol: "anthropic",
        effectiveProtocol: "openai",
        ingressOrigin: ANTHROPIC,
        effectiveOrigin: OPENAI,
      }),
    ).toBe(true);
  });

  test("permits re-encoding when X-Lore-Upstream-URL is set even if the destination differs", () => {
    // Explicit URL override → the user owns the destination.
    expect(
      mayReencodeUpstream({
        hasUpstreamUrlOverride: true,
        hasProviderOverride: false,
        ingressProtocol: "anthropic",
        effectiveProtocol: "openai",
        ingressOrigin: ANTHROPIC,
        effectiveOrigin: "https://up.example",
      }),
    ).toBe(true);
  });

  test("withholds re-encoding when the gateway auto-translates the protocol with no override", () => {
    // Bare Anthropic client whose model-prefix route resolves to an OpenAI
    // backend: the gateway re-routed to a different provider family the client
    // never targeted — its Content-Encoding may not be accepted there.
    expect(
      mayReencodeUpstream({
        hasUpstreamUrlOverride: false,
        hasProviderOverride: false,
        ingressProtocol: "anthropic",
        effectiveProtocol: "openai",
        ingressOrigin: ANTHROPIC,
        effectiveOrigin: OPENAI,
      }),
    ).toBe(false);
  });

  test("withholds re-encoding on a SAME-protocol re-route to a different host (F3 gap)", () => {
    // Bare OpenAI client whose `deepseek-*` model resolves to api.deepseek.com:
    // same wire protocol but a provider host the client never targeted. The
    // protocol-only predicate wrongly trusted this; the origin check distrusts.
    expect(
      mayReencodeUpstream({
        hasUpstreamUrlOverride: false,
        hasProviderOverride: false,
        ingressProtocol: "openai",
        effectiveProtocol: "openai",
        ingressOrigin: OPENAI,
        effectiveOrigin: DEEPSEEK,
      }),
    ).toBe(false);
  });
});

describe("buildUpstreamRouteContext", () => {
  const facts = (
    over: Partial<Parameters<typeof buildUpstreamRouteContext>[0]>,
  ) =>
    buildUpstreamRouteContext({
      upstreamUrlHeader: null,
      providerHeader: null,
      ingressProtocol: "openai",
      effectiveProtocol: "openai",
      ingressUpstreamBase: OPENAI,
      effectiveUpstreamBase: OPENAI,
      ...over,
    });

  test("derives hasUpstreamUrlOverride from header truthiness", () => {
    expect(
      facts({ upstreamUrlHeader: "https://up.example" }).hasUpstreamUrlOverride,
    ).toBe(true);
    for (const empty of [null, undefined, ""]) {
      expect(facts({ upstreamUrlHeader: empty }).hasUpstreamUrlOverride).toBe(
        false,
      );
    }
  });

  test("derives hasProviderOverride from header truthiness", () => {
    expect(facts({ providerHeader: "openai-codex" }).hasProviderOverride).toBe(
      true,
    );
    for (const empty of [null, undefined, ""]) {
      expect(facts({ providerHeader: empty }).hasProviderOverride).toBe(false);
    }
  });

  test("maps ingress/effective protocols to the right fields (not swapped)", () => {
    // Distinct sentinel values catch an ingress/effective swap — the exact
    // mis-wiring that would silently disable the auto-cross-route guard.
    const ctx = facts({
      ingressProtocol: "INGRESS",
      effectiveProtocol: "EFFECTIVE",
    });
    expect(ctx.ingressProtocol).toBe("INGRESS");
    expect(ctx.effectiveProtocol).toBe("EFFECTIVE");
  });

  test("derives origins from the base URLs (right fields, path/query stripped)", () => {
    const ctx = facts({
      ingressUpstreamBase: `${ANTHROPIC}/v1/messages`,
      effectiveUpstreamBase: `${DEEPSEEK}/v1/chat/completions?x=1`,
    });
    expect(ctx.ingressOrigin).toBe(ANTHROPIC);
    expect(ctx.effectiveOrigin).toBe(DEEPSEEK);
  });

  test("falls back to the raw base string when it is not a parseable URL", () => {
    const ctx = facts({
      ingressUpstreamBase: "not a url",
      effectiveUpstreamBase: "also not a url",
    });
    expect(ctx.ingressOrigin).toBe("not a url");
    expect(ctx.effectiveOrigin).toBe("also not a url");
  });

  test("composes with mayReencodeUpstream into the full route truth table", () => {
    // Lock the raw-inputs → decision path end to end (the wiring the call site
    // depends on), not just the already-derived context.
    const decide = (
      url: string | null,
      provider: string | null,
      ingressProtocol: string,
      effectiveProtocol: string,
      ingressUpstreamBase: string,
      effectiveUpstreamBase: string,
    ) =>
      mayReencodeUpstream(
        buildUpstreamRouteContext({
          upstreamUrlHeader: url,
          providerHeader: provider,
          ingressProtocol,
          effectiveProtocol,
          ingressUpstreamBase,
          effectiveUpstreamBase,
        }),
      );
    // Auto cross-route (no overrides, protocol translated) → distrust.
    expect(decide(null, null, "anthropic", "openai", ANTHROPIC, OPENAI)).toBe(
      false,
    );
    // Same-protocol re-route to a different host (F3 gap) → distrust.
    expect(decide(null, null, "openai", "openai", OPENAI, DEEPSEEK)).toBe(
      false,
    );
    // Native passthrough (no overrides, same protocol + origin) → trust.
    expect(
      decide(
        null,
        null,
        "openai-responses",
        "openai-responses",
        OPENAI,
        OPENAI,
      ),
    ).toBe(true);
    // Explicit URL override, even when re-routed → trust.
    expect(
      decide(
        "https://up.example",
        null,
        "anthropic",
        "openai",
        ANTHROPIC,
        OPENAI,
      ),
    ).toBe(true);
    // Explicit provider override (real Codex/Vertex/Bedrock path) → trust.
    expect(
      decide(null, "openai-codex", "anthropic", "openai", ANTHROPIC, OPENAI),
    ).toBe(true);
  });
});

describe("encodeUpstreamBodyForRoute", () => {
  const NATIVE = {
    hasUpstreamUrlOverride: false,
    hasProviderOverride: false,
    ingressProtocol: "openai-responses",
    effectiveProtocol: "openai-responses",
    ingressOrigin: OPENAI,
    effectiveOrigin: OPENAI,
  };
  const AUTO_CROSS_ROUTED = {
    hasUpstreamUrlOverride: false,
    hasProviderOverride: false,
    ingressProtocol: "anthropic",
    effectiveProtocol: "openai",
    ingressOrigin: ANTHROPIC,
    effectiveOrigin: OPENAI,
  };
  const SAME_PROTO_FOREIGN_HOST = {
    hasUpstreamUrlOverride: false,
    hasProviderOverride: false,
    ingressProtocol: "openai",
    effectiveProtocol: "openai",
    ingressOrigin: OPENAI,
    effectiveOrigin: DEEPSEEK,
  };
  const EXPLICIT_URL_TRANSLATED = {
    hasUpstreamUrlOverride: true,
    hasProviderOverride: false,
    ingressProtocol: "anthropic",
    effectiveProtocol: "openai",
    ingressOrigin: ANTHROPIC,
    effectiveOrigin: "https://up.example",
  };

  test("re-applies the client's encoding on a trusted (native) route", () => {
    const { body, contentEncoding } = encodeUpstreamBodyForRoute(
      SAMPLE,
      "zstd",
      NATIVE,
    );
    expect(contentEncoding).toBe("zstd");
    expect(zstdDecompressSync(body as Uint8Array).toString("utf8")).toBe(
      SAMPLE,
    );
  });

  test("re-applies the client's encoding on an explicit URL override (even when translated)", () => {
    const { body, contentEncoding } = encodeUpstreamBodyForRoute(
      SAMPLE,
      "zstd",
      EXPLICIT_URL_TRANSLATED,
    );
    expect(contentEncoding).toBe("zstd");
    expect(zstdDecompressSync(body as Uint8Array).toString("utf8")).toBe(
      SAMPLE,
    );
  });

  test("forwards UNCOMPRESSED when the gateway auto-cross-routes", () => {
    // The mismatch guard: a compressing client auto-translated to a provider it
    // never targeted must NOT have its Content-Encoding replayed upstream.
    expect(
      encodeUpstreamBodyForRoute(SAMPLE, "zstd", AUTO_CROSS_ROUTED),
    ).toEqual({ body: SAMPLE, contentEncoding: null });
  });

  test("forwards UNCOMPRESSED on a same-protocol re-route to a foreign host (F3 gap)", () => {
    // A same-protocol model-prefix re-route to a different provider host (e.g.
    // openai client → deepseek backend) must also forward uncompressed.
    expect(
      encodeUpstreamBodyForRoute(SAMPLE, "zstd", SAME_PROTO_FOREIGN_HOST),
    ).toEqual({ body: SAMPLE, contentEncoding: null });
  });

  test("forwards uncompressed on any route when the client sent no encoding", () => {
    expect(encodeUpstreamBodyForRoute(SAMPLE, null, NATIVE)).toEqual({
      body: SAMPLE,
      contentEncoding: null,
    });
    expect(encodeUpstreamBodyForRoute(SAMPLE, null, AUTO_CROSS_ROUTED)).toEqual(
      {
        body: SAMPLE,
        contentEncoding: null,
      },
    );
  });
});
