import type { GatewayToolResultBlock } from "./types";

/** A fixed, data-free client error for controls that cannot cross protocols. */
export class InvalidCrossProviderRequestError extends Error {
  constructor() {
    super("Unsupported cross-provider request");
    this.name = "InvalidCrossProviderRequestError";
  }
}

/** Text-only tool wire formats cannot carry a structured image or other block. */
export function requireTextOnlyToolResult(block: GatewayToolResultBlock): void {
  if (block.isError || block.content.some((part) => part.type !== "text")) {
    throw new InvalidCrossProviderRequestError();
  }
}
