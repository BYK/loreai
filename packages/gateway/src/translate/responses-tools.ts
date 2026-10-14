import type {
  GatewayRequest,
  GatewayResponse,
  GatewayToolUseBlock,
} from "./types";
import { InvalidCrossProviderRequestError } from "./errors";

/** Native call envelopes stay attached to normalized tool parts during compression. */
export function nativeResponsesCall(
  raw: Record<string, unknown>,
): GatewayToolUseBlock | null {
  const custom = raw.type === "custom_tool_call";
  const search = raw.type === "tool_search_call";
  const namespaced =
    raw.type === "function_call" && raw.namespace !== undefined;
  if (!custom && !search && !namespaced) return null;
  if (
    typeof raw.call_id !== "string" ||
    !raw.call_id ||
    (!search && (typeof raw.name !== "string" || !raw.name)) ||
    (raw.namespace !== undefined && typeof raw.namespace !== "string") ||
    (custom && typeof raw.input !== "string") ||
    (namespaced && typeof raw.arguments !== "string") ||
    (search &&
      (!raw.arguments ||
        typeof raw.arguments !== "object" ||
        Array.isArray(raw.arguments)))
  ) {
    throw new InvalidCrossProviderRequestError();
  }
  const { input, arguments: args, name, call_id: callId, ...envelope } = raw;
  let normalizedInput = custom ? input : args;
  if (namespaced) {
    try {
      normalizedInput = JSON.parse(args as string);
    } catch {
      throw new InvalidCrossProviderRequestError();
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
  if (envelope.type === "custom_tool_call") {
    if (typeof block.input !== "string")
      throw new InvalidCrossProviderRequestError();
    return {
      ...envelope,
      call_id: block.id,
      name: block.name,
      input: block.input,
    };
  }
  if (envelope.type === "tool_search_call") {
    return { ...envelope, call_id: block.id, arguments: block.input };
  }
  return {
    ...envelope,
    call_id: block.id,
    name: block.name,
    arguments: JSON.stringify(block.input),
  };
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
    return { ...base, tools };
  }
  return { ...base, output };
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
