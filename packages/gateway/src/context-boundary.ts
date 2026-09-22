import {
  CONTEXT_BOUNDARY_HEADER,
  decodeContextBoundary,
  encodeContextBoundary,
  type ContextBoundary,
  type ContextBoundaryProtocol,
} from "@loreai/core";
import { StreamedRequestBoundaryMismatchError } from "./translate/streaming-request";

function headerValue(headers: Record<string, string>): string | undefined {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === CONTEXT_BOUNDARY_HEADER) return value;
  }
  return undefined;
}

/** Parse and validate the opaque token supplied by the fetch interceptor. */
export function parseContextBoundary(
  headers: Record<string, string>,
  protocol: ContextBoundaryProtocol,
): ContextBoundary | undefined {
  const encoded = headerValue(headers);
  if (encoded === undefined) return undefined;
  const boundary = decodeContextBoundary(encoded);
  if (!boundary || boundary.protocol !== protocol) {
    throw new StreamedRequestBoundaryMismatchError(
      "The context boundary is invalid for this protocol; retrying with the full conversation.",
    );
  }
  return boundary;
}

export { encodeContextBoundary };
export type { ContextBoundary, ContextBoundaryProtocol };
