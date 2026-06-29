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
  compressBody,
  decodeRequestBody,
  decompressBody,
  encodeUpstreamBody,
  isSupportedEncoding,
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
