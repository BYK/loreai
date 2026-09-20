/**
 * OpenAI-shaped protocols:
 *   POST /v1/chat/completions, /chat/completions → Chat Completions
 *   POST /v1/responses                            → Responses API
 *   POST /v1/codex/responses                      → Codex (ChatGPT) ingress
 *   POST /v1/responses/compact                    → Codex compaction
 */
import type { GatewayConfig } from "../config";
import type { GatewayRequest } from "../translate/types";
import { parseOpenAIRequest } from "../translate/openai";
import {
  parseOpenAICodexRequestChunks,
  parseOpenAIResponsesRequestChunks,
} from "../translate/openai-responses";
import { handleResponsesCompactEndpoint } from "../pipeline";
import { decodeRequestBody, decodedRequestChunks } from "../http-body";
import {
  closingErrorResponse,
  headersToRecord,
  withoutCors,
} from "../management-access";
import { DATA_PLANE, type RouteModule } from "./types";
import { invalidJsonBody, parseFailure, runPipeline } from "./shared";

export async function handleOpenAIChatCompletions(
  req: Request,
  config: GatewayConfig,
): Promise<Response> {
  let body: unknown;
  try {
    body = JSON.parse(await decodeRequestBody(req));
  } catch {
    return invalidJsonBody();
  }

  let gatewayReq: GatewayRequest;
  try {
    gatewayReq = parseOpenAIRequest(body, headersToRecord(req.headers));
    gatewayReq.signal = req.signal;
  } catch (e) {
    return parseFailure(e);
  }
  return runPipeline(gatewayReq, config);
}

/**
 * A malformed Responses stream can remain unfinished after parsing fails.
 * Closing the connection cancels Node's request body once the fixed 400 is
 * delivered.
 */
function invalidStreamedBody(): Response {
  return closingErrorResponse(
    400,
    "invalid_request_error",
    "Invalid JSON body",
  );
}

export async function handleOpenAIResponses(
  req: Request,
  config: GatewayConfig,
): Promise<Response> {
  let gatewayReq: GatewayRequest;
  try {
    gatewayReq = await parseOpenAIResponsesRequestChunks(
      decodedRequestChunks(req, req.signal),
      headersToRecord(req.headers),
    );
    gatewayReq.signal = req.signal;
  } catch {
    return invalidStreamedBody();
  }
  return runPipeline(gatewayReq, config);
}

/**
 * Codex (ChatGPT) ingress — `POST /v1/codex/responses`. Pi's `openai-codex`
 * provider appends `/codex/responses` to the registered gateway baseUrl. The
 * wire format is the OpenAI Responses API; we flag the request as Codex so the
 * upstream is routed to `/backend-api/codex/responses` and Codex control fields
 * (`store: false`, `include`, …) are preserved.
 */
export async function handleOpenAICodexResponses(
  req: Request,
  config: GatewayConfig,
): Promise<Response> {
  let gatewayReq: GatewayRequest;
  try {
    gatewayReq = await parseOpenAICodexRequestChunks(
      decodedRequestChunks(req, req.signal),
      headersToRecord(req.headers),
    );
    gatewayReq.signal = req.signal;
  } catch {
    return invalidStreamedBody();
  }
  return runPipeline(gatewayReq, config);
}

export const openaiRoutes: RouteModule = {
  name: "openai",
  plane: DATA_PLANE,
  paths: [
    "/v1/chat/completions",
    "/chat/completions",
    "/v1/responses",
    "/v1/codex/responses",
    "/v1/responses/compact",
  ],
  register(app, ctx) {
    // The bare `/chat/completions` (no /v1) form is accepted too: GitHub
    // Copilot CLI redirected via COPILOT_API_URL posts to the origin's bare
    // path (its API omits the /v1 segment, like api.githubcopilot.com).
    app.post(
      "/v1/chat/completions",
      ctx.foreground(handleOpenAIChatCompletions),
    );
    app.post("/chat/completions", ctx.foreground(handleOpenAIChatCompletions));

    app.post("/v1/responses/compact", async (c) =>
      withoutCors(await ctx.foreground(handleResponsesCompactEndpoint)(c)),
    );

    app.post("/v1/codex/responses", ctx.foreground(handleOpenAICodexResponses));

    // NOTE: the bare `/responses` (no /v1) form used by GitHub Copilot CLI's
    // Responses wire API (GPT-5 series) is intentionally NOT accepted yet — the
    // responses upstream builder emits `${base}/v1/responses`, which would 404
    // against api.githubcopilot.com (its endpoints omit /v1). Wiring that needs
    // a host-aware responses path (like buildOpenAIChatCompletionsUrl) first.
    app.post("/v1/responses", ctx.foreground(handleOpenAIResponses));
  },
};
