export const MAX_RECALL_QUERY_CHARS = 512;
export const MAX_RECALL_ID_CHARS = 256;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
  if (
    Array.from(id).some((char) => {
      const code = char.charCodeAt(0);
      return code < 32 || code === 127 || char === "…";
    })
  ) {
    return false;
  }

  const separator = id.indexOf(":");
  if (separator < 1) return false;
  const prefix = id.slice(0, separator);
  const sourceId = id.slice(separator + 1);
  switch (prefix) {
    case "k":
    case "xk":
    case "d":
    case "e":
      return UUID_RE.test(sourceId);
    case "t":
      // v82 intentionally preserves arbitrary pre-existing temporal primary
      // keys (including provider IDs such as msg_...). These are opaque exact
      // lookup keys, bounded and control-checked above; visibility is checked
      // separately against the owning tenant/project/session.
      return sourceId.length > 0;
    case "lat":
      // LAT references are repository-relative file + heading identities.
      return (
        sourceId.indexOf("#") > 0 &&
        !Array.from(sourceId).some((char) => {
          const code = char.charCodeAt(0);
          return code < 32 || code === 127 || char === "…";
        })
      );
    default:
      return false;
  }
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
