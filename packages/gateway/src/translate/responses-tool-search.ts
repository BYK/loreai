const TOOL_SEARCH_EXECUTIONS = new Set(["client", "server"]);
const TOOL_SEARCH_STATUSES = new Set([
  "in_progress",
  "completed",
  "incomplete",
]);

type ToolSearchPhase = "input" | "output";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const allow = new Set(allowed);
  return Object.keys(value).every((key) => allow.has(key));
}

function optionalNullableString(
  value: Record<string, unknown>,
  key: string,
): boolean {
  return (
    !Object.hasOwn(value, key) ||
    value[key] === null ||
    isNonEmptyString(value[key])
  );
}

function optionalExecution(value: Record<string, unknown>): boolean {
  return (
    !Object.hasOwn(value, "execution") ||
    (typeof value.execution === "string" &&
      TOOL_SEARCH_EXECUTIONS.has(value.execution))
  );
}

function optionalStatus(value: Record<string, unknown>): boolean {
  return (
    !Object.hasOwn(value, "status") ||
    value.status === null ||
    (typeof value.status === "string" && TOOL_SEARCH_STATUSES.has(value.status))
  );
}

/** Validate the SDK-defined tool-search envelope before opaque replay. */
export function isValidResponsesToolSearchItem(
  value: unknown,
  phase: ToolSearchPhase,
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;

  if (value.type === "tool_search_call") {
    const allowed =
      phase === "input"
        ? ["type", "arguments", "id", "call_id", "execution", "status"]
        : [
            "type",
            "arguments",
            "id",
            "call_id",
            "execution",
            "status",
            "created_by",
          ];
    if (
      !hasOnlyKeys(value, allowed) ||
      !Object.hasOwn(value, "arguments") ||
      !optionalNullableString(value, "id") ||
      !optionalNullableString(value, "call_id") ||
      !optionalExecution(value) ||
      !optionalStatus(value)
    ) {
      return false;
    }
    if (phase === "output") {
      return (
        isNonEmptyString(value.id) &&
        Object.hasOwn(value, "call_id") &&
        Object.hasOwn(value, "execution") &&
        Object.hasOwn(value, "status") &&
        value.status !== null &&
        (value.created_by === undefined || typeof value.created_by === "string")
      );
    }
    return true;
  }

  if (value.type === "tool_search_output") {
    const allowed =
      phase === "input"
        ? ["type", "tools", "id", "call_id", "execution", "status"]
        : [
            "type",
            "tools",
            "id",
            "call_id",
            "execution",
            "status",
            "created_by",
          ];
    if (
      !hasOnlyKeys(value, allowed) ||
      !Array.isArray(value.tools) ||
      !value.tools.every(
        (tool) => isRecord(tool) && isNonEmptyString(tool.type),
      ) ||
      !optionalNullableString(value, "id") ||
      !optionalNullableString(value, "call_id") ||
      !optionalExecution(value) ||
      !optionalStatus(value)
    ) {
      return false;
    }
    if (phase === "output") {
      return (
        isNonEmptyString(value.id) &&
        Object.hasOwn(value, "call_id") &&
        Object.hasOwn(value, "execution") &&
        Object.hasOwn(value, "status") &&
        value.status !== null &&
        (value.created_by === undefined || typeof value.created_by === "string")
      );
    }
    return true;
  }

  return false;
}

/** Paired call/results must retain the same server/client execution owner. */
export function hasConsistentResponsesToolSearchOwnership(
  items: readonly unknown[],
): boolean {
  const calls = new Map<string, string | undefined>();
  for (const item of items) {
    if (!isRecord(item) || item.type !== "tool_search_call") continue;
    if (typeof item.call_id !== "string") continue;
    if (calls.has(item.call_id)) return false;
    calls.set(
      item.call_id,
      typeof item.execution === "string" ? item.execution : undefined,
    );
  }

  for (const item of items) {
    if (
      !isRecord(item) ||
      item.type !== "tool_search_output" ||
      typeof item.call_id !== "string"
    ) {
      continue;
    }
    const callExecution = calls.get(item.call_id);
    if (callExecution !== undefined && callExecution !== item.execution) {
      return false;
    }
  }
  return true;
}
