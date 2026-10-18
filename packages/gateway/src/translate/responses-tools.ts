import type {
  GatewayRequest,
  GatewayResponse,
  GatewayToolUseBlock,
} from "./types";
import { InvalidCrossProviderRequestError } from "./errors";

function assertKnownNativeFields(
  raw: Record<string, unknown>,
  allowed: readonly string[],
): void {
  if (Object.keys(raw).some((key) => !allowed.includes(key))) {
    throw new InvalidCrossProviderRequestError();
  }
}

function nativeResponsesCallFields(raw: Record<string, unknown>): string[] {
  return raw.type === "custom_tool_call"
    ? ["type", "id", "call_id", "name", "namespace", "input", "status"]
    : raw.type === "tool_search_call"
      ? [
          "type",
          "id",
          "call_id",
          "name",
          "namespace",
          "execution",
          "arguments",
          "status",
        ]
      : raw.type === "function_call" && raw.namespace !== undefined
        ? ["type", "id", "call_id", "name", "namespace", "arguments", "status"]
        : [];
}

/** Drop provider extensions from upstream native calls before replay or persistence. */
export function stripUnknownNativeResponsesCallFields(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const allowed = nativeResponsesCallFields(raw);
  if (allowed.length === 0) return raw;
  return Object.fromEntries(
    Object.entries(raw).filter(([key]) => allowed.includes(key)),
  );
}

/** Native envelopes are stored on Lore parts, so only supported wire fields may cross that persistence boundary. */
export function assertNativeResponsesOutput(
  raw: Record<string, unknown>,
): void {
  const allowed =
    raw.type === "custom_tool_call_output"
      ? ["type", "id", "call_id", "output", "status", "namespace"]
      : raw.type === "tool_search_output"
        ? ["type", "id", "call_id", "execution", "tools", "status"]
        : [];
  assertKnownNativeFields(raw, allowed);
  if (
    (raw.id !== undefined &&
      (typeof raw.id !== "string" || raw.id.length === 0)) ||
    (raw.status !== undefined && raw.status !== "completed")
  ) {
    throw new InvalidCrossProviderRequestError();
  }
  if (raw.type === "custom_tool_call_output") {
    if (
      typeof raw.call_id !== "string" ||
      raw.call_id.length === 0 ||
      (typeof raw.output !== "string" && !Array.isArray(raw.output)) ||
      (raw.namespace !== undefined && typeof raw.namespace !== "string")
    ) {
      throw new InvalidCrossProviderRequestError();
    }
  }
  if (raw.type === "tool_search_output") {
    // Server-owned search outputs bypass client-call matching, so validate
    // their required payload and ownership shape before storing or replaying.
    const serverOwned = raw.execution === "server" && raw.call_id === null;
    const clientOwned =
      typeof raw.call_id === "string" &&
      raw.call_id.length > 0 &&
      (raw.execution === undefined || raw.execution === "client");
    if (!Array.isArray(raw.tools) || (!serverOwned && !clientOwned)) {
      throw new InvalidCrossProviderRequestError();
    }
  }
}

/** Revalidate durable native call envelopes before replay to an upstream. */
export function assertNativeResponsesCall(raw: Record<string, unknown>): void {
  const allowed = nativeResponsesCallFields(raw);
  if (allowed.length === 0) throw new InvalidCrossProviderRequestError();
  assertKnownNativeFields(raw, allowed);
  // Calls can be in progress in input history and incomplete/failed in
  // terminal Responses output; reject unknown strings without narrowing those
  // valid protocol states to "completed".
  const supportedStatuses =
    raw.type === "function_call"
      ? ["in_progress", "completed", "incomplete", "failed"]
      : ["in_progress", "completed", "incomplete"];
  if (
    (raw.id !== undefined && typeof raw.id !== "string") ||
    (raw.status !== undefined &&
      (typeof raw.status !== "string" ||
        !supportedStatuses.includes(raw.status)))
  ) {
    throw new InvalidCrossProviderRequestError();
  }
  if (raw.type === "tool_search_call") {
    // Hosted search calls bypass client call normalization, but their opaque
    // provenance still needs the same required-field and type guarantees.
    const serverOwned = raw.execution === "server" && raw.call_id === null;
    const clientOwned =
      typeof raw.call_id === "string" &&
      raw.call_id.length > 0 &&
      (raw.execution === undefined || raw.execution === "client");
    if (
      (!serverOwned && !clientOwned) ||
      (serverOwned &&
        (typeof raw.name !== "string" || raw.name.length === 0)) ||
      (raw.name !== undefined && typeof raw.name !== "string") ||
      raw.arguments === null ||
      typeof raw.arguments !== "object" ||
      Array.isArray(raw.arguments) ||
      (raw.namespace !== undefined && typeof raw.namespace !== "string")
    ) {
      throw new InvalidCrossProviderRequestError();
    }
    return;
  }
  if (
    typeof raw.call_id !== "string" ||
    raw.call_id.length === 0 ||
    typeof raw.name !== "string" ||
    raw.name.length === 0 ||
    (raw.namespace !== undefined && typeof raw.namespace !== "string") ||
    (raw.type === "custom_tool_call" && typeof raw.input !== "string") ||
    (raw.type === "function_call" && typeof raw.arguments !== "string")
  ) {
    throw new InvalidCrossProviderRequestError();
  }
}

/** Hosted search is completed by the provider and has no client call identity. */
export function isServerOwnedResponsesSearch(
  raw: Record<string, unknown>,
): boolean {
  return (
    (raw.type === "tool_search_call" || raw.type === "tool_search_output") &&
    raw.execution === "server" &&
    raw.call_id === null
  );
}

/** Native call envelopes stay attached to normalized tool parts during compression. */
export function nativeResponsesCall(
  raw: Record<string, unknown>,
  mode: "request" | "response" = "request",
): GatewayToolUseBlock | null {
  if (isServerOwnedResponsesSearch(raw)) return null;
  const custom = raw.type === "custom_tool_call";
  const search = raw.type === "tool_search_call";
  const namespaced =
    raw.type === "function_call" && raw.namespace !== undefined;
  if (!custom && !search && !namespaced) return null;
  // Client input must match the supported envelope exactly. Provider responses
  // may add fields over time, so retain only the understood wire subset before
  // validation, replay, or durable capture.
  const call =
    mode === "response" ? stripUnknownNativeResponsesCallFields(raw) : raw;
  assertNativeResponsesCall(call);
  if (
    typeof call.call_id !== "string" ||
    !call.call_id ||
    (!search && (typeof call.name !== "string" || !call.name)) ||
    (call.namespace !== undefined && typeof call.namespace !== "string") ||
    (custom && typeof call.input !== "string") ||
    (namespaced && typeof call.arguments !== "string") ||
    (search &&
      (!call.arguments ||
        typeof call.arguments !== "object" ||
        Array.isArray(call.arguments)))
  ) {
    throw new InvalidCrossProviderRequestError();
  }
  const { input, arguments: args, name, call_id: callId, ...envelope } = call;
  let normalizedInput = custom ? input : args;
  if (namespaced) {
    try {
      normalizedInput = JSON.parse(args as string);
    } catch {
      if (mode === "request") throw new InvalidCrossProviderRequestError();
      // A token-limited upstream response can end inside its JSON arguments.
      // Keep the string for accounting and exact native fallback replay.
      envelope.arguments = args;
    }
  }
  return {
    type: "tool_use",
    id: callId,
    name: search ? "tool_search" : (name as string),
    input: normalizedInput,
    responsesCall: envelope,
  };
}

export function responsesCallItem(
  block: GatewayToolUseBlock,
): Record<string, unknown> {
  const envelope = block.responsesCall ?? { type: "function_call" };
  const persistedNativeCall = block.responsesCall !== undefined;
  if (envelope.type === "custom_tool_call") {
    if (typeof block.input !== "string")
      throw new InvalidCrossProviderRequestError();
    const item = {
      ...envelope,
      call_id: block.id,
      name: block.name,
      input: block.input,
    };
    if (persistedNativeCall) assertNativeResponsesCall(item);
    return item;
  }
  if (envelope.type === "tool_search_call") {
    const item = { ...envelope, call_id: block.id, arguments: block.input };
    if (persistedNativeCall) assertNativeResponsesCall(item);
    return item;
  }
  const item = {
    ...envelope,
    call_id: block.id,
    name: block.name,
    arguments:
      typeof envelope.arguments === "string"
        ? envelope.arguments
        : JSON.stringify(block.input),
  };
  if (persistedNativeCall) assertNativeResponsesCall(item);
  return item;
}

export function responsesOutputItem(
  envelope: Record<string, unknown> | undefined,
  callId: string,
  output: unknown,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    ...(envelope ?? { type: "function_call_output" }),
    call_id: callId,
  };
  if (base.type === "tool_search_output") {
    let tools: unknown;
    try {
      tools = typeof output === "string" ? JSON.parse(output) : undefined;
    } catch {
      throw new InvalidCrossProviderRequestError();
    }
    if (!Array.isArray(tools)) throw new InvalidCrossProviderRequestError();
    const item = { ...base, tools };
    if (envelope) assertNativeResponsesOutput(item);
    return item;
  }
  const item = { ...base, output };
  if (envelope) assertNativeResponsesOutput(item);
  return item;
}

/** A foreign wire format cannot carry grammars, namespaces, or native call kinds. */
export function assertNoNativeResponsesTools(req: GatewayRequest): void {
  if (
    req.extras?.nativeInstructionPrefix?.items.some(
      (item) => item.id !== undefined,
    ) ||
    req.tools.some((tool) => tool.responsesNative !== undefined) ||
    req.messages.some((message) =>
      message.content.some(
        (block) =>
          (block.type === "tool_use" && block.responsesCall !== undefined) ||
          (block.type === "tool_result" && block.responsesOutput !== undefined),
      ),
    )
  ) {
    throw new InvalidCrossProviderRequestError();
  }
}

/** Native output kinds cannot be flattened into a foreign function-call response. */
export function assertPortableResponsesResponse(resp: GatewayResponse): void {
  if (
    resp.content.some(
      (block) => block.type === "tool_use" && block.responsesCall !== undefined,
    )
  ) {
    throw new InvalidCrossProviderRequestError();
  }
}
