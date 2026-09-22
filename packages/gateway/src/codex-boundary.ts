import { StreamedRequestBoundaryMismatchError } from "./translate/streaming-request";

export type CodexContextBoundary = {
  v: 1;
  inputItems: number;
  inputDigest: string;
  sourceMessages: number;
  sourceDigest: string;
};

const BOUNDARY_HEADER = "x-lore-codex-context-boundary";
const MAX_BOUNDARY_COUNT = 10_000_000;
const DIGEST_RE = /^[a-f0-9]{64}$/;

function headerValue(headers: Record<string, string>): string | undefined {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === BOUNDARY_HEADER) return value;
  }
  return undefined;
}

function validCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_BOUNDARY_COUNT
  );
}

/** Parse and validate the opaque token supplied by the Codex interceptor. */
export function parseCodexContextBoundary(
  headers: Record<string, string>,
): CodexContextBoundary | undefined {
  const encoded = headerValue(headers);
  if (encoded === undefined) return undefined;
  try {
    const value = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as Partial<CodexContextBoundary>;
    if (
      value.v !== 1 ||
      !validCount(value.inputItems) ||
      !validCount(value.sourceMessages) ||
      typeof value.inputDigest !== "string" ||
      !DIGEST_RE.test(value.inputDigest) ||
      typeof value.sourceDigest !== "string" ||
      !DIGEST_RE.test(value.sourceDigest)
    )
      throw new Error("invalid fields");
    return value as CodexContextBoundary;
  } catch {
    throw new StreamedRequestBoundaryMismatchError(
      "The Codex context boundary is invalid; retrying with the full conversation.",
    );
  }
}

/** Encode only opaque, non-conversational continuation metadata. */
export function encodeCodexContextBoundary(
  boundary: CodexContextBoundary,
): string {
  return Buffer.from(JSON.stringify(boundary)).toString("base64url");
}
