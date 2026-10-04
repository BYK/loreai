/**
 * Shared cursor codec and `limit` parsing for the `/api/v1` management API.
 *
 * Cursor tokens are opaque to clients: base64url(JSON) of a versioned keyset
 * payload (`{v: CURSOR_VERSION, ...}`). They are NOT offsets — decoding
 * validates every field, and a token that fails to decode or was minted with a
 * different version is rejected with 400 `invalid_cursor`. A malformed `limit`
 * is rejected with 400 `invalid_request`.
 */

export class BadRequest extends Error {
  constructor(
    readonly errorType: string,
    message: string,
  ) {
    super(message);
  }
}

export const CURSOR_VERSION = 1;

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function encodeCursor(payload: object): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/** Decode a token into a plain object, or throw `invalid_cursor`. */
export function decodeCursorObject(token: string): Record<string, unknown> {
  // base64url alphabet only — anything else is rejected before decoding so a
  // sloppy token can't decode to something unexpected.
  if (!/^[A-Za-z0-9_-]+$/.test(token) || token.length > 4096) {
    throw new BadRequest("invalid_cursor", "Malformed cursor");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    throw new BadRequest("invalid_cursor", "Malformed cursor");
  }
  if (!isRecord(parsed) || parsed.v !== CURSOR_VERSION) {
    throw new BadRequest("invalid_cursor", "Malformed cursor");
  }
  return parsed;
}

/** `limit` query param: absent → `defaultLimit`, else 1..`maxLimit`. */
export function parseLimit(
  url: URL,
  defaultLimit: number,
  maxLimit: number,
): number {
  const raw = url.searchParams.get("limit");
  if (raw === null || raw === "") return defaultLimit;
  if (!/^\d+$/.test(raw))
    throw new BadRequest("invalid_request", `Invalid limit: ${raw}`);
  const n = parseInt(raw, 10);
  if (n < 1) throw new BadRequest("invalid_request", `Invalid limit: ${raw}`);
  return Math.min(n, maxLimit);
}
