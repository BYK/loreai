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

import { promiseAgainstAbort, responseAgainstAbort } from "../abort-race";
import { upstreamFetch } from "../fetch";
import { createForegroundAbortScope, wrapBodyWithCleanup } from "../pipeline";
import { cancelAndReleaseReader } from "../stream/anthropic";

/** Bedrock Runtime InvokeModel accepts request payloads up to 25 MiB. */
export const BEDROCK_RUNTIME_MAX_REQUEST_BYTES = 25 * 1024 * 1024;

class BedrockRuntimeRequestTooLargeError extends Error {
  constructor() {
    super(
      `Bedrock Runtime request exceeded ${BEDROCK_RUNTIME_MAX_REQUEST_BYTES} byte limit`,
    );
    this.name = "BedrockRuntimeRequestTooLargeError";
  }
}

export async function readBedrockRuntimeRequestBody(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): Promise<Buffer> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let completed = false;
  try {
    while (true) {
      const { done, value } = await promiseAgainstAbort(
        () => reader.read(),
        signal,
      );
      signal.throwIfAborted();
      if (done) {
        completed = true;
        break;
      }
      if (!value) continue;
      total += value.byteLength;
      if (total > BEDROCK_RUNTIME_MAX_REQUEST_BYTES) {
        throw new BedrockRuntimeRequestTooLargeError();
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, total);
  } finally {
    if (completed) {
      try {
        reader.releaseLock();
      } catch {
        // Normal completion has no pending read in conforming runtimes.
      }
    } else {
      cancelAndReleaseReader(reader, signal.reason);
    }
  }
}

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

const BEDROCK_STRIPPED_HEADERS = new Set([
  "connection",
  "cookie",
  "cookie2",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export function bedrockRuntimeHeaders(headers: Headers): Headers {
  const connectionHeaders = new Set(
    (headers.get("connection") ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );
  const upstream = new Headers();
  headers.forEach((value, key) => {
    const normalized = key.toLowerCase();
    if (
      BEDROCK_STRIPPED_HEADERS.has(normalized) ||
      connectionHeaders.has(normalized) ||
      normalized.startsWith("x-lore-")
    ) {
      return;
    }
    upstream.set(key, value);
  });
  return upstream;
}

/**
 * Forward an incoming Bedrock Runtime API request to the real
 * `bedrock-runtime.<region>.amazonaws.com` endpoint and return the upstream
 * response untouched. Body, status, and headers (including the AWS event
 * stream `Content-Type` for streaming verbs) are passed through verbatim.
 *
 * End-to-end AWS headers, including `Authorization` and signed `x-amz-*`
 * fields, pass through. Hop-by-hop fields, connection-nominated headers,
 * cookies, proxy credentials, and Lore's internal metadata do not cross the
 * origin boundary.
 */
export async function proxyBedrockRuntimeRequest(
  req: Request,
  region: string,
  deps: { upstreamFetch?: typeof upstreamFetch } = {},
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

  const upstreamHeaders = bedrockRuntimeHeaders(req.headers);

  const destination = `${bedrockRuntimeUrl(region)}/model/${modelId}/${verb}`;

  const abortScope = createForegroundAbortScope(req.signal);
  try {
    const body = req.body
      ? await readBedrockRuntimeRequestBody(req.body, abortScope.signal)
      : undefined;

    const upstream = await responseAgainstAbort(
      () =>
        (deps.upstreamFetch ?? upstreamFetch)(destination, {
          method: req.method,
          headers: upstreamHeaders,
          body: body ? new Uint8Array(body) : undefined,
          signal: abortScope.signal,
        }),
      abortScope.signal,
    );

    return wrapBodyWithCleanup(
      new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: new Headers(upstream.headers),
      }),
      abortScope.dispose,
      abortScope.signal,
    );
  } catch (error) {
    abortScope.dispose();
    if (error instanceof BedrockRuntimeRequestTooLargeError) {
      return new Response(
        JSON.stringify({
          type: "error",
          error: {
            type: "invalid_request_error",
            message: error.message,
          },
        }),
        { status: 413, headers: { "content-type": "application/json" } },
      );
    }
    throw error;
  }
}
