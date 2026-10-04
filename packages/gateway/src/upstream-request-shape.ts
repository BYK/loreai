import { sanitizeSurrogates } from "@loreai/core";

/** Sanitize JSON string values and property names before sending upstream. */
export function sanitizeUpstreamJson(_key: string, value: unknown): unknown {
  if (typeof value === "string") return sanitizeSurrogates(value);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const keys = Object.keys(value);
  if (keys.every((key) => sanitizeSurrogates(key) === key)) return value;
  const sanitized = keys.map((key) => sanitizeSurrogates(key));
  if (new Set(sanitized).size !== keys.length) {
    throw new Error("Cannot serialize colliding Unicode property names");
  }
  return Object.fromEntries(
    keys.map((key, index) => [
      sanitized[index],
      (value as Record<string, unknown>)[key],
    ]),
  );
}

/** Content-free request dimensions for otherwise opaque upstream 400s. */
export type UpstreamRequestShape = {
  bodyBytes: number;
  inputItems: number;
  tools: number;
  instructionsBytes?: number;
  largestItemBytes?: number;
  largestItemType?:
    | "message"
    | "function_call"
    | "function_call_output"
    | "reasoning"
    | "other";
};

/** Only code-selected field names and allowlisted item types reach telemetry. */
export function upstreamRequestShape(
  body: unknown,
  serializedBody: string,
  protocol: "anthropic" | "openai" | "openai-responses" | "vertex" | "gemini",
): UpstreamRequestShape {
  const shape: UpstreamRequestShape = {
    bodyBytes: Buffer.byteLength(serializedBody, "utf8"),
    inputItems: 0,
    tools: 0,
  };
  // Interceptors can mutate the body after serialization. Getters, Proxy traps
  // and toJSON may then throw, but diagnostics must preserve the provider 400.
  try {
    const payload =
      body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const rawInput =
      protocol === "openai-responses"
        ? payload.input
        : protocol === "gemini"
          ? payload.contents
          : payload.messages;
    const input = Array.isArray(rawInput) ? rawInput : [];
    const rawTools = payload.tools;
    const tools = Array.isArray(rawTools) ? rawTools : [];
    shape.inputItems = input.length;
    // Gemini groups all functions in one top-level tools entry.
    shape.tools =
      protocol === "gemini"
        ? tools.reduce((count, tool) => {
            const declarations =
              tool && typeof tool === "object"
                ? (tool as Record<string, unknown>).functionDeclarations
                : undefined;
            return (
              count + (Array.isArray(declarations) ? declarations.length : 1)
            );
          }, 0)
        : tools.length;
    if (protocol === "openai-responses") {
      const instructions = payload.instructions;
      shape.instructionsBytes =
        typeof instructions === "string"
          ? Buffer.byteLength(instructions, "utf8")
          : 0;
    }
    // A rejected giant body is already expensive to retain. Its total byte
    // count is enough to flag size pressure without serializing it again.
    if (shape.bodyBytes > 8 * 1024 * 1024 || input.length > 4096) {
      return shape;
    }
    let largestItemBytes = 0;
    let largestItemType: UpstreamRequestShape["largestItemType"] = "other";
    for (const item of input) {
      const itemBytes = Buffer.byteLength(
        JSON.stringify(item, sanitizeUpstreamJson) ?? "null",
        "utf8",
      );
      if (itemBytes <= largestItemBytes) continue;
      largestItemBytes = itemBytes;
      const kind =
        item && typeof item === "object"
          ? (item as Record<string, unknown>).type
          : undefined;
      largestItemType =
        kind === "message" ||
        kind === "function_call" ||
        kind === "function_call_output" ||
        kind === "reasoning"
          ? kind
          : "other";
    }
    if (input.length) {
      shape.largestItemBytes = largestItemBytes;
      shape.largestItemType = largestItemType;
    }
  } catch {
    // The already-serialized body size remains useful.
  }
  return shape;
}

export function formatUpstreamRequestShape(
  shape: UpstreamRequestShape,
): string {
  return Object.entries(shape)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
}
