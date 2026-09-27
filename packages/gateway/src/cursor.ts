import {
  listQuery,
  type KnowledgeKeyset,
  type KnowledgeSort,
} from "@loreai/core";

export const CURSOR_VERSION = 1;

/** Client-facing message; callers map it to their HTTP error. */
export class InvalidCursor extends Error {}

export function encodeCursor(
  payload: { v: typeof CURSOR_VERSION } & Record<string, unknown>,
): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeCursor(token: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]+$/.test(token) || token.length > 4096) {
    throw new InvalidCursor("Malformed cursor");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    throw new InvalidCursor("Malformed cursor");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    (parsed as Record<string, unknown>).v !== CURSOR_VERSION
  ) {
    throw new InvalidCursor("Malformed cursor");
  }
  return parsed as Record<string, unknown>;
}

export function assertCursorBinding(
  actual: unknown,
  expected: unknown,
  what: "project" | "session",
): void {
  if (actual !== expected) {
    throw new InvalidCursor(`Cursor was issued for a different ${what}`);
  }
}

export function encodeKnowledgeCursor(
  kind: "knowledge" | "knowledge_all",
  project: string | null,
  sort: KnowledgeSort,
  keyset: KnowledgeKeyset,
): string {
  return encodeCursor({
    v: CURSOR_VERSION,
    kind,
    project,
    sort,
    key: keyset.key,
    id: keyset.id,
  });
}

export function decodeKnowledgeCursor(
  token: string,
  kind: "knowledge" | "knowledge_all",
  project: string | null,
  sort: KnowledgeSort,
): KnowledgeKeyset {
  const cursor = decodeCursor(token);
  const validProject =
    kind === "knowledge"
      ? typeof cursor.project === "string"
      : cursor.project === null || typeof cursor.project === "string";
  if (cursor.kind !== kind) {
    throw new InvalidCursor("Malformed cursor");
  }
  if (!validProject) {
    throw new InvalidCursor("Malformed cursor");
  }
  if (
    typeof cursor.sort !== "string" ||
    !listQuery.isKnowledgeSort(cursor.sort)
  ) {
    throw new InvalidCursor("Malformed cursor");
  }
  if (typeof cursor.id !== "string" || cursor.id.length === 0) {
    throw new InvalidCursor("Malformed cursor");
  }
  if (typeof cursor.key !== "number" && typeof cursor.key !== "string") {
    throw new InvalidCursor("Malformed cursor");
  }
  assertCursorBinding(cursor.project, project, "project");
  if (cursor.sort !== sort) {
    throw new InvalidCursor(
      `Cursor was issued for sort=${cursor.sort}; request uses sort=${sort}`,
    );
  }
  const keyset: KnowledgeKeyset = { key: cursor.key, id: cursor.id };
  if (!listQuery.knowledgeKeysetMatchesSort(keyset, sort)) {
    throw new InvalidCursor("Malformed cursor");
  }
  return keyset;
}
