/** Helpers shared by the data-plane route modules. */
import { log } from "@loreai/core";
import type { GatewayConfig } from "../config";
import type { GatewayRequest } from "../translate/types";
import { handleRequest } from "../pipeline";
import { errorResponse, withoutCors } from "../management-access";

export function invalidJsonBody(): Response {
  return errorResponse(400, "invalid_request_error", "Invalid JSON body");
}

export function parseFailure(e: unknown): Response {
  const msg = e instanceof Error ? e.message : "Failed to parse request";
  return errorResponse(400, "invalid_request_error", msg);
}

/**
 * Run the translating pipeline; it returns the response in the client's
 * native wire format (JSON or SSE), so no server-side translation follows.
 */
export async function runPipeline(
  gatewayReq: GatewayRequest,
  config: GatewayConfig,
): Promise<Response> {
  try {
    return withoutCors(await handleRequest(gatewayReq, config));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Pipeline error";
    log.error(`pipeline error: ${msg}`);
    return errorResponse(502, "api_error", `Gateway pipeline error: ${msg}`);
  }
}
