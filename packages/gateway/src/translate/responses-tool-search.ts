type ToolSearchPhase = "input" | "output" | "output-added";

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

function optionalString(
  value: Record<string, unknown>,
  key: string,
  nullable = false,
): boolean {
  return (
    !Object.hasOwn(value, key) ||
    typeof value[key] === "string" ||
    (nullable && value[key] === null)
  );
}

function optionalBoolean(
  value: Record<string, unknown>,
  key: string,
  nullable = false,
): boolean {
  return (
    !Object.hasOwn(value, key) ||
    typeof value[key] === "boolean" ||
    (nullable && value[key] === null)
  );
}

function optionalNullableNonEmptyString(
  value: Record<string, unknown>,
  key: string,
): boolean {
  return (
    !Object.hasOwn(value, key) ||
    value[key] === null ||
    isNonEmptyString(value[key])
  );
}

function validFunctionTool(
  value: Record<string, unknown>,
  namespaceChild: boolean,
): boolean {
  const allowed = namespaceChild
    ? ["type", "name", "description", "parameters", "strict"]
    : ["type", "name", "description", "parameters", "strict", "defer_loading"];
  if (
    value.type !== "function" ||
    !hasOnlyKeys(value, allowed) ||
    !isNonEmptyString(value.name) ||
    !optionalString(value, "description", true) ||
    !optionalBoolean(value, "strict", true) ||
    (!namespaceChild &&
      (!Object.hasOwn(value, "parameters") ||
        (value.parameters !== null && !isRecord(value.parameters)) ||
        !Object.hasOwn(value, "strict"))) ||
    (namespaceChild &&
      Object.hasOwn(value, "parameters") &&
      value.parameters !== null &&
      !isRecord(value.parameters)) ||
    (!namespaceChild && !optionalBoolean(value, "defer_loading"))
  ) {
    return false;
  }
  return true;
}

function validCustomTool(value: Record<string, unknown>): boolean {
  if (
    value.type !== "custom" ||
    !hasOnlyKeys(value, [
      "type",
      "name",
      "description",
      "format",
      "defer_loading",
    ]) ||
    !isNonEmptyString(value.name) ||
    !optionalString(value, "description") ||
    !optionalBoolean(value, "defer_loading")
  ) {
    return false;
  }
  if (!Object.hasOwn(value, "format")) return true;
  if (!isRecord(value.format)) return false;
  if (value.format.type === "text") {
    return hasOnlyKeys(value.format, ["type"]);
  }
  return (
    value.format.type === "grammar" &&
    hasOnlyKeys(value.format, ["type", "definition", "syntax"]) &&
    typeof value.format.definition === "string" &&
    (value.format.syntax === "lark" || value.format.syntax === "regex")
  );
}

function validNamespaceTool(value: Record<string, unknown>): boolean {
  return (
    value.type === "namespace" &&
    hasOnlyKeys(value, ["type", "name", "description", "tools"]) &&
    isNonEmptyString(value.name) &&
    typeof value.description === "string" &&
    Array.isArray(value.tools) &&
    value.tools.every(
      (tool) =>
        isRecord(tool) &&
        (validFunctionTool(tool, true) || validCustomTool(tool)),
    )
  );
}

function validNativeResponsesTool(value: unknown): boolean {
  if (!isRecord(value)) return false;
  // These are the native tool forms the Responses translator can safely replay.
  return (
    validFunctionTool(value, false) ||
    validCustomTool(value) ||
    validNamespaceTool(value)
  );
}

function validToolSearchTools(value: unknown): boolean {
  if (!Array.isArray(value) || !value.every(validNativeResponsesTool)) {
    return false;
  }
  const names = new Set<string>();
  for (const tool of value) {
    if (
      !isRecord(tool) ||
      !isNonEmptyString(tool.name) ||
      names.has(tool.name)
    ) {
      return false;
    }
    names.add(tool.name);
    if (tool.type === "namespace" && Array.isArray(tool.tools)) {
      const childNames = new Set<string>();
      for (const child of tool.tools) {
        if (
          !isRecord(child) ||
          !isNonEmptyString(child.name) ||
          childNames.has(child.name)
        ) {
          return false;
        }
        childNames.add(child.name);
      }
    }
  }
  return true;
}

function toolSearchOwner(
  value: Record<string, unknown>,
): "client" | "server" | undefined {
  if (value.execution === "server") {
    return Object.hasOwn(value, "call_id") && value.call_id === null
      ? "server"
      : undefined;
  }
  if (
    (value.execution === "client" ||
      (!Object.hasOwn(value, "execution") && value.execution === undefined)) &&
    isNonEmptyString(value.call_id)
  ) {
    return "client";
  }
  return undefined;
}

function validStatus(
  value: Record<string, unknown>,
  phase: ToolSearchPhase,
): boolean {
  if (!Object.hasOwn(value, "status")) return phase !== "output";
  if (phase === "input") {
    return value.status === "completed";
  }
  if (phase === "output") {
    return value.status === "completed";
  }
  return value.type === "tool_search_call"
    ? value.status === "in_progress"
    : value.status === "completed";
}

/** Validate native Responses tool definitions before they enter opaque history. */
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
      !optionalNullableNonEmptyString(value, "id") ||
      !toolSearchOwner(value) ||
      !validStatus(value, phase)
    ) {
      return false;
    }
    if (phase !== "input") {
      return (
        isNonEmptyString(value.id) &&
        Object.hasOwn(value, "execution") &&
        Object.hasOwn(value, "status") &&
        optionalString(value, "created_by")
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
      !validToolSearchTools(value.tools) ||
      !optionalNullableNonEmptyString(value, "id") ||
      !toolSearchOwner(value) ||
      !validStatus(value, phase)
    ) {
      return false;
    }
    if (phase !== "input") {
      return (
        isNonEmptyString(value.id) &&
        Object.hasOwn(value, "execution") &&
        Object.hasOwn(value, "status") &&
        optionalString(value, "created_by")
      );
    }
    return true;
  }

  return false;
}

/** Calls and results must form a one-to-one history with one execution owner. */
export function hasConsistentResponsesToolSearchOwnership(
  items: readonly unknown[],
): boolean {
  const calls = new Map<string, "client">();
  const outputs = new Map<string, "client">();
  const serverCalls: unknown[] = [];
  const serverOutputs: unknown[] = [];

  for (const item of items) {
    if (!isRecord(item)) continue;
    if (
      item.type !== "tool_search_call" &&
      item.type !== "tool_search_output"
    ) {
      continue;
    }
    const owner = toolSearchOwner(item);
    if (owner === undefined) return false;
    if (owner === "server") {
      (item.type === "tool_search_call" ? serverCalls : serverOutputs).push(
        item,
      );
      continue;
    }
    const ids = item.type === "tool_search_call" ? calls : outputs;
    if (!isNonEmptyString(item.call_id) || ids.has(item.call_id)) return false;
    ids.set(item.call_id, owner);
  }

  return (
    serverCalls.length === serverOutputs.length &&
    calls.size === outputs.size &&
    Array.from(calls).every(([callId, owner]) => outputs.get(callId) === owner)
  );
}
