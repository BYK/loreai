/** Anthropic Messages protocol — `POST /v1/messages`. */
import type { GatewayConfig } from "../config";
import type { GatewayRequest } from "../translate/types";
import { parseAnthropicRequestChunks } from "../translate/anthropic";
import { decodedRequestChunks } from "../http-body";
import { headersToRecord } from "../management-access";
import { DATA_PLANE, type RouteModule } from "./types";
import {
  invalidStreamedBody,
  requestBodyLimitsForConfig,
  runPipeline,
} from "./shared";

export async function handleAnthropicMessages(
  req: Request,
  config: GatewayConfig,
): Promise<Response> {
  let gatewayReq: GatewayRequest;
  try {
    gatewayReq = await parseAnthropicRequestChunks(
      decodedRequestChunks(req, req.signal, requestBodyLimitsForConfig(config)),
      headersToRecord(req.headers),
    );
    gatewayReq.signal = req.signal;
  } catch (e) {
    return invalidStreamedBody(e);
  }
  return runPipeline(gatewayReq, config);
}

export const anthropicRoutes: RouteModule = {
  name: "anthropic",
  plane: DATA_PLANE,
  paths: ["/v1/messages"],
  register(app, ctx) {
    app.post("/v1/messages", ctx.foreground(handleAnthropicMessages));
  },
};
