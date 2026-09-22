export const CONTEXT_BOUNDARY_HEADER = "x-lore-context-boundary";
export const CONTEXT_BOUNDARY_MISMATCH_HEADER =
  "x-lore-context-boundary-mismatch";

export type ContextBoundaryProtocol =
  | "anthropic"
  | "openai"
  | "openai-responses"
  | "openai-codex"
  | "gemini";

/** Opaque continuation metadata returned by the gateway and echoed by core. */
export type ContextBoundary = {
  v: 1;
  protocol: ContextBoundaryProtocol;
  inputItems: number;
  inputDigest: string;
  retainedItems: number;
  sourceMessages: number;
  sourceDigest: string;
};

const MAX_BOUNDARY_COUNT = 10_000_000;
const DIGEST_RE = /^[a-f0-9]{64}$/;

function validCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_BOUNDARY_COUNT
  );
}

function validProtocol(value: unknown): value is ContextBoundaryProtocol {
  return [
    "anthropic",
    "openai",
    "openai-responses",
    "openai-codex",
    "gemini",
  ].includes(value as string);
}

/** Decode an untrusted boundary token without throwing. */
export function decodeContextBoundary(
  encoded: string,
): ContextBoundary | undefined {
  try {
    const value = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as Partial<ContextBoundary>;
    if (
      value.v !== 1 ||
      !validProtocol(value.protocol) ||
      !validCount(value.inputItems) ||
      !validCount(value.retainedItems) ||
      value.retainedItems > value.inputItems ||
      !validCount(value.sourceMessages) ||
      typeof value.inputDigest !== "string" ||
      !DIGEST_RE.test(value.inputDigest) ||
      typeof value.sourceDigest !== "string" ||
      !DIGEST_RE.test(value.sourceDigest)
    )
      return undefined;
    return value as ContextBoundary;
  } catch {
    return undefined;
  }
}

/** Encode only opaque, non-conversational continuation metadata. */
export function encodeContextBoundary(boundary: ContextBoundary): string {
  return Buffer.from(JSON.stringify(boundary)).toString("base64url");
}
