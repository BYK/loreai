import type { GatewayMessage, GatewayTool } from "./types";
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

export function responsesToolName(raw: Record<string, unknown>): string {
  if (
    typeof raw.name !== "string" ||
    (raw.namespace !== undefined &&
      (typeof raw.namespace !== "string" || !raw.namespace))
  )
    throw new InvalidCrossProviderRequestError();
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
  const native =
    source.provenanceContent
      ?.filter((b) => b.type === "opaque" && b.responsesItem)
      .map((b) => (b.type === "opaque" ? b.raw : {})) ?? [];
  for (const block of message.content) {
    const raw = native.find(
      (item) =>
        (block.type === "tool_use" || block.type === "tool_result") &&
        item.call_id ===
          (block.type === "tool_use" ? block.id : block.toolUseId) &&
        (block.type === "tool_use"
          ? ["function_call", "custom_tool_call"].includes(String(item.type))
          : ["function_call_output", "custom_tool_call_output"].includes(
              String(item.type),
            )),
    );
    if (!raw) continue;
    if (block.type === "tool_use") block.raw = raw;
    if (block.type === "tool_result") block.nativeResponsesEnvelope = raw;
  }
}
