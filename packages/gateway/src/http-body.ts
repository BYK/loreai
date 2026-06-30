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

/** The routing facts that decide whether re-encoding is safe for a request. */
export interface UpstreamRouteContext {
  /** An `X-Lore-Upstream-URL` header explicitly redirected the destination. */
  hasUpstreamUrlOverride: boolean;
  /** An `X-Lore-Provider` header explicitly named the destination provider. */
  hasProviderOverride: boolean;
  /** The wire protocol the request arrived as (`req.protocol`). */
  ingressProtocol: string;
  /** The wire protocol actually used upstream after routing/translation. */
  effectiveProtocol: string;
  /** Origin (`scheme://host[:port]`) of the ingress protocol's native upstream. */
  ingressOrigin: string;
  /** Origin of the destination actually used after routing/translation. */
  effectiveOrigin: string;
}

/** Raw routing facts the forwarding path already computed, pre-derivation. */
export interface UpstreamRouteFacts {
  /** Raw `X-Lore-Upstream-URL` header value (truthy ⇒ explicit URL override). */
  upstreamUrlHeader: string | null | undefined;
  /** Raw `X-Lore-Provider` header value (truthy ⇒ explicit provider override). */
  providerHeader: string | null | undefined;
  /** The wire protocol the request arrived as (`req.protocol`). */
  ingressProtocol: string;
  /** The wire protocol actually used upstream after routing/translation. */
  effectiveProtocol: string;
  /** Base URL of the ingress protocol's native upstream (config default). */
  ingressUpstreamBase: string;
  /** Base URL of the destination actually used after routing/translation. */
  effectiveUpstreamBase: string;
}

/**
 * Parse a base URL to its origin (`scheme://host[:port]`). Falls back to the
 * raw string when it is not a parseable URL — two distinct unparseable bases
 * then still compare as "changed", which biases to the safe (uncompressed)
 * branch.
 */
function originOf(base: string): string {
  try {
    return new URL(base).origin;
  } catch {
    return base;
  }
}

/**
 * Build an {@link UpstreamRouteContext} from the raw routing facts the
 * forwarding path already computed.
 *
 * Centralizing the derivation here (the `!!` header coercions and the
 * base-URL → origin parsing) keeps it pure and unit-testable: the call site
 * forwards the values it already has instead of re-deriving them in an inline
 * object literal that no test can reach. See the `buildUpstreamRouteContext`
 * tests for the locked truth table.
 */
export function buildUpstreamRouteContext(
  facts: UpstreamRouteFacts,
): UpstreamRouteContext {
  return {
    hasUpstreamUrlOverride: !!facts.upstreamUrlHeader,
    hasProviderOverride: !!facts.providerHeader,
    ingressProtocol: facts.ingressProtocol,
    effectiveProtocol: facts.effectiveProtocol,
    ingressOrigin: originOf(facts.ingressUpstreamBase),
    effectiveOrigin: originOf(facts.effectiveUpstreamBase),
  };
}

/**
 * Decide whether the gateway may re-apply the client's request `Content-
 * Encoding` to the upstream request for this route.
 *
 * The client only compresses because it knows the destination IT targeted
 * accepts the encoding (e.g. Codex zstd → the ChatGPT codex backend). The
 * gateway may replay that encoding only when it did NOT translate the wire
 * protocol itself, or when the destination was explicitly chosen:
 *   - a native passthrough (the upstream wire protocol equals the ingress
 *     protocol — the gateway did not translate),
 *   - an explicit `X-Lore-Upstream-URL` override (the user owns the URL), or
 *   - an explicit `X-Lore-Provider` override (the plugin/user named the
 *     provider — this is how the real Codex path routes to openai-codex).
 *
 * When the gateway itself AUTO-routes to a destination the client never
 * targeted with no explicit override — either by translating the wire protocol
 * (e.g. a bare Anthropic client whose model-prefix route resolves to an OpenAI
 * backend) OR by re-routing to a different provider host on the same protocol
 * (e.g. a bare OpenAI client whose `deepseek-*` model resolves to
 * `api.deepseek.com`) — that backend may reject the encoding. In that case
 * forward uncompressed; an uncompressed body is accepted by every endpoint.
 *
 * The trust signal is therefore the DESTINATION: re-encode only when the
 * upstream origin equals the ingress protocol's native upstream origin (a true
 * native passthrough), or when the destination was explicitly chosen
 * (`X-Lore-Upstream-URL` / `X-Lore-Provider`). The protocol-inequality term is
 * kept as a belt-and-suspenders fallback for the (impossible-in-practice) case
 * where an origin fails to parse. This also makes Vertex/Bedrock a non-issue:
 * both are reachable only via the explicit `X-Lore-Provider` override, so they
 * short-circuit to trusted and never reach the origin comparison.
 *
 * No live behavior change today: the only client that compresses requests is
 * Codex, which is always provider-tagged → trusted before this check. This is
 * the faithful completion of the "trust explicit overrides, distrust gateway
 * auto-routing" design (#1032 follow-up).
 */
export function mayReencodeUpstream(route: UpstreamRouteContext): boolean {
  const autoCrossRouted =
    !route.hasUpstreamUrlOverride &&
    !route.hasProviderOverride &&
    (route.effectiveProtocol !== route.ingressProtocol ||
      route.effectiveOrigin !== route.ingressOrigin);
  return !autoCrossRouted;
}

/**
 * Route-aware wrapper around {@link encodeUpstreamBody}: re-applies the
 * client's `Content-Encoding` only when {@link mayReencodeUpstream} permits it
 * for the resolved route; otherwise forwards the body uncompressed (always
 * safe). Both forwarding call sites (the main upstream forward and the
 * compaction passthrough) route through this single chokepoint so the
 * destination-scoped re-encoding cannot be bypassed at an individual call site.
 */
export function encodeUpstreamBodyForRoute(
  serializedBody: string,
  rawEncoding: string | null | undefined,
  route: UpstreamRouteContext,
): { body: BodyInit; contentEncoding: string | null } {
  return encodeUpstreamBody(
    serializedBody,
    mayReencodeUpstream(route) ? rawEncoding : null,
  );
}
