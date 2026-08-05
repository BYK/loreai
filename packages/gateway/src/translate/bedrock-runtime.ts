/**
 * AWS Bedrock Runtime API → Gateway transparent proxy.
 *
 * OpenCode's `amazon-bedrock` provider uses `@ai-sdk/amazon-bedrock`, which
 * drives the AWS SDK `BedrockRuntimeClient` and hits the native Converse /
 * InvokeModel endpoints at `bedrock-runtime.<region>.amazonaws.com/model/
 * <modelId>/<verb>`. With the opencode plugin's `baseURL` pinned to the
 * gateway, those requests land at `POST /v1/model/<modelId>/<verb>` — a path
 * the gateway does not recognize, so they 404.
 *
 * This module adds a transparent passthrough so the gateway becomes a
 * region-aware reverse proxy for those verbs. We forward the request body
 * and `Authorization` header verbatim and rebuild the upstream URL against
 * `LORE_BEDROCK_REGION` / `AWS_REGION` (default `us-east-1`). Streaming
 * responses are passed through byte-for-byte (the AWS event-stream binary
 * encoding is not safe to re-shape here).
 *
 * Scope: this is the `amazon-bedrock` provider's wire path. Claude models on
 * Bedrock via the bedrock-mantle Anthropic Messages API are a separate route
 * (see `./bedrock.ts` — `bedrockMantleUrl`, `isBedrockMantleDispatch`,
 * `X-Lore-Provider: bedrock`). Mantle is what the gateway actively translates
 * (gradient context, distillation, model-id remap); runtime here is a pure
 * passthrough because the AWS SDK already handles retries, streaming, and
 * credential rotation and re-shaping it would break those guarantees.
 */

export const BEDROCK_RUNTIME_VERBS = [
  "converse",
  "converse-stream",
  "invoke",
  "invoke-with-response-stream",
] as const;

export type BedrockRuntimeVerb = (typeof BEDROCK_RUNTIME_VERBS)[number];

/**
 * Match `POST /v1/model/<modelId>/<verb>` where `verb` is one of the four
 * Bedrock Runtime API operations. Captures modelId and verb for downstream
 * URL building.
 *
 * The `[a-zA-Z0-9._:-]` class on modelId is intentionally permissive: AWS
 * catalog ids routinely contain dots (e.g. `anthropic.claude-opus-4-6-v1`,
 * `google.gemma-3-4b-it`, `us.anthropic.claude-haiku-4-5`), dashes, and
 * version-suffix colons (e.g. `anthropic.claude-opus-4-5-20251101-v1:0`).
 * A bare `model/{modelId}/{verb}` segment is enough specificity that this
 * cannot accidentally collide with `/v1/models` (plural) or `/v1/messages`.
 */
export const BEDROCK_RUNTIME_PATH_RE =
  /^\/v1\/model\/([a-zA-Z0-9._:-]+)\/(converse|converse-stream|invoke|invoke-with-response-stream)$/;

/**
 * Build the Bedrock Runtime API origin for a region. No trailing slash — the
 * proxy concatenates `/model/<modelId>/<verb>` directly. `region` is trusted
 * (loaded from env / config; not user-input on the request path).
 */
export function bedrockRuntimeUrl(region: string): string {
  return `https://bedrock-runtime.${region}.amazonaws.com`;
}

/**
 * Forward an incoming Bedrock Runtime API request to the real
 * `bedrock-runtime.<region>.amazonaws.com` endpoint and return the upstream
 * response untouched. Body, status, and headers (including the AWS event
 * stream `Content-Type` for streaming verbs) are passed through verbatim.
 *
 * Headers forwarded: every header from the original request, minus `Host`
 * (Node's http module rewrites it for the new destination; carrying the
 * original `127.0.0.1:3207` value through would cause Bedrock to reject
 * with a TLS/SNI mismatch). `Authorization` (bearer token from
 * `AWS_BEARER_TOKEN_BEDROCK`) is host-agnostic and passes through unchanged.
 * SigV4-signed headers are NOT stripped — the upstream's 403 is a clearer
 * signal than a gateway-synthesized error.
 */
export async function proxyBedrockRuntimeRequest(
  req: Request,
  region: string,
): Promise<Response> {
  const match = BEDROCK_RUNTIME_PATH_RE.exec(new URL(req.url).pathname);
  if (!match) {
    return new Response(
      JSON.stringify({
        type: "error",
        error: {
          type: "invalid_request_error",
          message:
            "Bedrock Runtime proxy: path does not match /v1/model/<modelId>/<verb>",
        },
      }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }
  const [, modelId, verb] = match;

  const upstreamHeaders = new Headers();
  req.headers.forEach((value, key) => {
    if (key.toLowerCase() === "host") return;
    upstreamHeaders.set(key, value);
  });

  const destination = `${bedrockRuntimeUrl(region)}/model/${modelId}/${verb}`;

  // Buffer the request body upfront. Converse / InvokeModel bodies are JSON
  // payloads that arrive fully buffered (the wire-format response streams
  // out independently), so draining the Web ReadableStream here is both
  // correct and the simplest path for the upstream dispatcher — undici /
  // node:http treat a Buffer body as a single Content-Length chunk, which
  // sidesteps the `duplex: "half"` streaming-body contract entirely.
  const body = req.body ? Buffer.from(await req.arrayBuffer()) : undefined;

  const { upstreamFetch } = await import("../fetch");
  const upstream = await upstreamFetch(destination, {
    method: req.method,
    headers: upstreamHeaders,
    body,
  });

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: new Headers(upstream.headers),
  });
}
