export const MAX_RECALL_QUERY_CHARS = 512;
export const MAX_RECALL_ID_CHARS = 256;

export function isRecallDetailRef(id: unknown): id is string {
  return (
    typeof id === "string" &&
    /^r:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)
  );
}

export function isValidRecallId(id: unknown): id is string {
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    id.length > MAX_RECALL_ID_CHARS
  ) {
    return false;
  }
  return !Array.from(id).some((char) => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127 || char === "…";
  });
}

export function isValidRecallQuery(query: unknown): query is string {
  return (
    typeof query === "string" &&
    query.length <= MAX_RECALL_QUERY_CHARS &&
    !Array.from(query).some((char) => {
      const code = char.charCodeAt(0);
      return code < 32 || code === 127 || char === "…";
    })
  );
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
