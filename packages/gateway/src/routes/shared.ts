/** Helpers shared by the data-plane route modules. */
import { CONTEXT_BOUNDARY_MISMATCH_HEADER, log } from "@loreai/core";
import type { GatewayConfig } from "../config";
import type { GatewayRequest } from "../translate/types";
import { handleRequest } from "../pipeline";
import {
  EMBEDDED_REQUEST_BODY_LIMITS,
  HttpRequestBodyTooLargeError,
  type RequestBodyLimits,
} from "../http-body";
import { StreamedRequestBoundaryMismatchError } from "../translate/streaming-request";
import {
  closingErrorResponse,
  errorResponse,
  withoutCors,
} from "../management-access";

export function invalidJsonBody(): Response {
  return errorResponse(400, "invalid_request_error", "Invalid JSON body");
}

export function parseFailure(e: unknown): Response {
  const msg = e instanceof Error ? e.message : "Failed to parse request";
  return errorResponse(400, "invalid_request_error", msg);
}

/**
 * 400 for a request whose body could not be parsed. JSON syntax failures get
 * the generic message; a translator's own error keeps its message.
 */
export function invalidStreamedBody(e?: unknown): Response {
  if (e instanceof StreamedRequestBoundaryMismatchError) {
    const response = closingErrorResponse(
      409,
      "context_boundary_mismatch",
      e.message,
    );
    response.headers.set(CONTEXT_BOUNDARY_MISMATCH_HEADER, "true");
    return response;
  }
  if (e instanceof HttpRequestBodyTooLargeError) {
    const limit = formatByteLimit(e.limit);
    const phase = e.phase === "compressed" ? "compressed" : "decompressed";
    return closingErrorResponse(
      413,
      "request_too_large",
      `Request body exceeded the ${limit} ${phase} limit. Reduce the conversation history or start a new session.`,
    );
  }
  return closingErrorResponse(
    400,
    "invalid_request_error",
    streamedBodyErrorMessage(e),
  );
}

function streamedBodyErrorMessage(e?: unknown): string {
  if (!(e instanceof Error) || e instanceof SyntaxError) {
    return "Invalid JSON body";
  }
  if (e.message === "Parse Error") {
    return "Request body could not be read completely; the client may have closed the connection while uploading the conversation. Retry the request.";
  }
  return e.message;
}

function formatByteLimit(bytes: number): string {
  if (bytes % (1024 * 1024) === 0) {
    return `${bytes / (1024 * 1024)} MiB`;
  }
  if (bytes % 1024 === 0) return `${bytes / 1024} KiB`;
  return `${bytes} bytes`;
}

/**
 * In-process callers already own the request body, so they can use the larger
 * embedded limit. Hosted and remote gateways retain the smaller public cap.
 */
export function requestBodyLimitsForConfig(
  config: GatewayConfig,
): RequestBodyLimits | undefined {
  return config.hostedMode === false && config.remoteGateway === false
    ? EMBEDDED_REQUEST_BODY_LIMITS
    : undefined;
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
