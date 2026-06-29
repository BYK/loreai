/**
 * HTTP request-body codecs for `Content-Encoding`.
 *
 * Clients may compress request bodies. In particular, the OpenAI Codex CLI
 * (codex-rs) zstd-compresses request bodies by default when talking to the
 * codex-backend over ChatGPT auth (`EnableRequestCompression` is a Stable,
 * default-on feature) and sends `Content-Encoding: zstd`. The gateway must
 * therefore decode the body before JSON-parsing it — otherwise the raw
 * compressed bytes fail `JSON.parse` and every turn returns
 * `400 "Invalid JSON body"` (issue #1032).
 *
 * The gateway transforms and re-serializes the body before forwarding it
 * upstream, so it also RE-COMPRESSES with the client's original encoding so
 * the upstream sees the same wire encoding it would receive from the client
 * directly. `content-encoding` is gateway-owned on the upstream request: it is
 * set to match the actual bytes, never blindly forwarded from the client.
 *
 * `node:zlib` provides every codec used here; `zstd*Sync` requires Node
 * >= 22.15, which is the `@loreai/gateway` engines floor.
 */
import {
  brotliCompressSync,
  brotliDecompressSync,
  deflateSync,
  gunzipSync,
  gzipSync,
  inflateRawSync,
  inflateSync,
  zstdCompressSync,
  zstdDecompressSync,
} from "node:zlib";

/**
 * Content-encodings the gateway can decode AND re-encode. `x-gzip` is the
 * legacy alias for `gzip`. `identity` (and the empty value) are handled by the
 * callers as "no encoding" and never reach the codec switch.
 */
const SUPPORTED_ENCODINGS = new Set([
  "zstd",
  "gzip",
  "x-gzip",
  "br",
  "deflate",
]);

/**
 * Normalize a `Content-Encoding` header value to a single lowercase token.
 *
 * Returns `null` for an absent/empty header or `identity` (i.e. "no encoding").
 * Only the first token is considered — clients that compress send exactly one
 * encoding (Codex sends `zstd`); a trailing `, identity` is tolerated.
 */
export function normalizeRequestEncoding(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;
  const enc = (raw.split(",")[0] ?? "").trim().toLowerCase();
  if (!enc || enc === "identity") return null;
  return enc;
}

/** True when `enc` is a codec the gateway can decode and re-encode. */
export function isSupportedEncoding(enc: string | null | undefined): boolean {
  return enc != null && SUPPORTED_ENCODINGS.has(enc);
}

/**
 * Decompress `bytes` according to `encoding`. Throws on an unsupported
 * encoding or on malformed compressed input.
 */
export function decompressBody(bytes: Uint8Array, encoding: string): Buffer {
  switch (encoding) {
    case "zstd":
      return zstdDecompressSync(bytes);
    case "gzip":
    case "x-gzip":
      return gunzipSync(bytes);
    case "br":
      return brotliDecompressSync(bytes);
    case "deflate":
      // Some clients send raw DEFLATE (no zlib header); fall back to it.
      try {
        return inflateSync(bytes);
      } catch {
        return inflateRawSync(bytes);
      }
    default:
      throw new Error(`Unsupported Content-Encoding: ${encoding}`);
  }
}

/**
 * Compress `data` according to `encoding`. Throws on an unsupported encoding.
 */
export function compressBody(
  data: Uint8Array | string,
  encoding: string,
): Buffer {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  switch (encoding) {
    case "zstd":
      return zstdCompressSync(buf);
    case "gzip":
    case "x-gzip":
      return gzipSync(buf);
    case "br":
      return brotliCompressSync(buf);
    case "deflate":
      return deflateSync(buf);
    default:
      throw new Error(`Unsupported Content-Encoding: ${encoding}`);
  }
}

/**
 * Read a request body as UTF-8 text, transparently decoding any supported
 * `Content-Encoding`.
 *
 * - No encoding / `identity` → `req.text()` (no buffering change).
 * - Supported encoding → buffer the bytes and decompress.
 * - Unsupported encoding → throws (callers map this to a 400, same as a
 *   JSON parse failure).
 */
export async function decodeRequestBody(req: Request): Promise<string> {
  const enc = normalizeRequestEncoding(req.headers.get("content-encoding"));
  if (!enc) return req.text();
  if (!isSupportedEncoding(enc)) {
    throw new Error(`Unsupported Content-Encoding: ${enc}`);
  }
  const bytes = new Uint8Array(await req.arrayBuffer());
  return decompressBody(bytes, enc).toString("utf8");
}

/**
 * Prepare an already-serialized JSON body for the upstream, re-applying the
 * client's original `Content-Encoding` so the upstream receives the same wire
 * encoding the client used.
 *
 * Returns the body to send (a compressed `Uint8Array` when re-encoding, else
 * the original string) and the `content-encoding` value to set on the upstream
 * headers (`null` = send uncompressed, set no header). Pure and synchronous so
 * it can be unit-tested without driving the pipeline. An unsupported encoding
 * or a (practically impossible) compression failure falls back to sending the
 * uncompressed string.
 */
export function encodeUpstreamBody(
  serializedBody: string,
  rawEncoding: string | null | undefined,
): { body: BodyInit; contentEncoding: string | null } {
  const enc = normalizeRequestEncoding(rawEncoding);
  if (!isSupportedEncoding(enc)) {
    return { body: serializedBody, contentEncoding: null };
  }
  try {
    // Wrap in a fresh Uint8Array so the value is a `BodyInit` (Node's `Buffer`
    // is `Uint8Array<ArrayBufferLike>`, which the DOM `BodyInit` type rejects).
    // Same pattern as cli/remote.ts.
    return {
      body: new Uint8Array(compressBody(serializedBody, enc as string)),
      contentEncoding: enc,
    };
  } catch {
    return { body: serializedBody, contentEncoding: null };
  }
}
