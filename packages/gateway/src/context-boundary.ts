import {
  CONTEXT_BOUNDARY_CAPABILITY_HEADER,
  CONTEXT_BOUNDARY_CAPABILITY_VALUE,
  CONTEXT_BOUNDARY_HEADER,
  decodeContextBoundary,
  encodeContextBoundary,
  type ContextBoundary,
  type ContextBoundaryProtocol,
} from "@loreai/core";
import { StreamedRequestBoundaryMismatchError } from "./translate/streaming-request";

function headerValue(
  headers: Record<string, string>,
  headerName: string,
): string | undefined {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === headerName) return value;
  }
  return undefined;
}

/** Whether this client understands the context-boundary checkpoint contract. */
export function supportsContextBoundary(
  headers: Record<string, string>,
): boolean {
  return (
    headerValue(headers, CONTEXT_BOUNDARY_CAPABILITY_HEADER) ===
      CONTEXT_BOUNDARY_CAPABILITY_VALUE ||
    headerValue(headers, CONTEXT_BOUNDARY_HEADER) !== undefined
  );
}

/** Parse and validate the opaque token supplied by the fetch interceptor. */
export function parseContextBoundary(
  headers: Record<string, string>,
  protocol: ContextBoundaryProtocol,
): ContextBoundary | undefined {
  const encoded = headerValue(headers, CONTEXT_BOUNDARY_HEADER);
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
