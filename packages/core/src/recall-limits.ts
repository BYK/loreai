export const MAX_RECALL_QUERY_CHARS = 512;

export function isValidRecallQuery(query: unknown): query is string {
  return typeof query === "string" && query.length <= MAX_RECALL_QUERY_CHARS;
}

export function assertValidRecallQuery(
  query: unknown,
): asserts query is string {
  if (!isValidRecallQuery(query)) {
    throw new Error(
      `Recall query must be a string no longer than ${MAX_RECALL_QUERY_CHARS} characters`,
    );
  }
}
