import type { GatewayContentBlock, GatewayMessage, GatewayTool } from "./types";
import { InvalidCrossProviderRequestError } from "./errors";

export const NATIVE_METADATA = "internal_chat_message_metadata_passthrough";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Validate native-only fields without teaching foreign translators to drop them. */
export function nativeResponsesEnvelope(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const copy = { ...raw };
  if (Object.hasOwn(raw, NATIVE_METADATA)) {
    if (!record(raw[NATIVE_METADATA]))
      throw new InvalidCrossProviderRequestError();
    delete copy[NATIVE_METADATA];
  }
  if (raw.id !== undefined && (typeof raw.id !== "string" || !raw.id)) {
    throw new InvalidCrossProviderRequestError();
  }
  if (raw.namespace !== undefined) {
    if (typeof raw.namespace !== "string" || !raw.namespace)
      throw new InvalidCrossProviderRequestError();
    delete copy.namespace;
  }
  return copy;
}

export function responsesToolName(
  raw: Record<string, unknown>,
  source: "request" | "response",
): string {
  if (
    typeof raw.name !== "string" ||
    (raw.namespace !== undefined &&
      (typeof raw.namespace !== "string" || !raw.namespace))
  ) {
    // Only client input failures are HTTP 400. Malformed provider output must
    // follow the upstream failure path, including buffered meta responses.
    throw source === "request"
      ? new InvalidCrossProviderRequestError()
      : new Error("malformed Responses response tool name");
  }
  return typeof raw.namespace === "string"
    ? `${raw.namespace}.${raw.name}`
    : raw.name;
}

/** Flat inventory for context accounting; original definitions stay on their native wire. */
export function parseNativeResponsesTools(
  value: unknown,
  inputOnly: boolean,
): GatewayTool[] {
  if (!Array.isArray(value)) throw new InvalidCrossProviderRequestError();
  const tools: GatewayTool[] = [];
  const names = new Set<string>();
  const emittedRoots = new Set<Record<string, unknown>>();
  const visit = (
    raw: unknown,
    namespace: string | undefined,
    root: Record<string, unknown>,
  ): void => {
    if (
      !record(raw) ||
      typeof raw.type !== "string" ||
      typeof raw.name !== "string" ||
      !raw.name ||
      (raw.description !== undefined && typeof raw.description !== "string")
    ) {
      throw new InvalidCrossProviderRequestError();
    }
    if (raw.type === "namespace") {
      if (
        namespace !== undefined ||
        !Array.isArray(raw.tools) ||
        !raw.tools.length ||
        Object.keys(raw).some(
          (k) => !["type", "name", "description", "tools"].includes(k),
        )
      )
        throw new InvalidCrossProviderRequestError();
      for (const child of raw.tools) visit(child, raw.name, root);
      return;
    }
    if (raw.type !== "function" && raw.type !== "custom")
      throw new InvalidCrossProviderRequestError();
    const allowed =
      raw.type === "function"
        ? ["type", "name", "description", "parameters", "strict"]
        : ["type", "name", "description", "format"];
    if (
      Object.keys(raw).some((k) => !allowed.includes(k)) ||
      (raw.strict !== undefined && typeof raw.strict !== "boolean") ||
      (raw.type === "function" && !record(raw.parameters)) ||
      (raw.type === "custom" && raw.format !== undefined && !record(raw.format))
    )
      throw new InvalidCrossProviderRequestError();
    const name = namespace ? `${namespace}.${raw.name}` : raw.name;
    if (names.has(name)) throw new InvalidCrossProviderRequestError();
    names.add(name);
    tools.push({
      name,
      description: typeof raw.description === "string" ? raw.description : "",
      inputSchema:
        raw.type === "function"
          ? (raw.parameters as Record<string, unknown>)
          : { type: "string" },
      ...(raw.strict === undefined ? {} : { strict: raw.strict }),
      responsesNative: {
        inputOnly,
        ...(emittedRoots.has(root) ? {} : { definition: root }),
      },
    });
    emittedRoots.add(root);
  };
  for (const raw of value) {
    if (!record(raw)) throw new InvalidCrossProviderRequestError();
    visit(raw, undefined, raw);
  }
  return tools;
}

/** Preserve native tool kind/namespace when gradient rebuilds visible tool parts. */
export function restoreNativeResponsesToolEnvelopes(
  message: GatewayMessage,
  source: Pick<GatewayMessage, "content" | "provenanceContent">,
): void {
  const calls = new Map<string, GatewayContentBlock>();
  const outputs = new Map<string, GatewayContentBlock>();
  for (const item of source.provenanceContent ?? []) {
    if (
      item.type !== "opaque" ||
      !item.responsesItem ||
      typeof item.raw.call_id !== "string"
    )
      continue;
    const index = ["function_call", "custom_tool_call"].includes(
      String(item.raw.type),
    )
      ? calls
      : ["function_call_output", "custom_tool_call_output"].includes(
            String(item.raw.type),
          )
        ? outputs
        : undefined;
    if (index && !index.has(item.raw.call_id))
      index.set(item.raw.call_id, item);
  }
  for (const block of message.content) {
    const original =
      block.type === "tool_use"
        ? calls.get(block.id)
        : block.type === "tool_result"
          ? outputs.get(block.toolUseId)
          : undefined;
    if (original?.type !== "opaque") continue;
    if (block.type === "tool_use") block.raw = original.raw;
    if (block.type === "tool_result")
      block.nativeResponsesEnvelope = original.raw;
    if (original.responsesSourceIndex !== undefined)
      block.responsesSourceIndex = original.responsesSourceIndex;
  }
  // Internal tool states are resolved in call order; native results can arrive
  // in another order. Keep synthetic content in place while restoring source order.
  const ordered = orderNativeResponsesSourceBlocks(message.content);
  for (let index = 0; index < ordered.length; index++)
    message.content[index] = ordered[index];
}

export function orderNativeResponsesSourceBlocks(
  blocks: GatewayContentBlock[],
): GatewayContentBlock[] {
  const ordered = blocks
    .filter((block) => block.responsesSourceIndex !== undefined)
    .sort((a, b) => a.responsesSourceIndex! - b.responsesSourceIndex!);
  if (!ordered.length) return blocks;
  let index = 0;
  return blocks.map((block) =>
    block.responsesSourceIndex === undefined ? block : ordered[index++],
  );
}
