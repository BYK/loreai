/** Content-free request dimensions for otherwise opaque upstream 400s.
 * The upstream body may contain user text or credentials: no values from it
 * may reach the logger, even when a client supplies an arbitrary item type. */
export function upstreamRequestShape(
  body: unknown,
  serializedBody: string,
): string {
  const details = [`bodyBytes=${Buffer.byteLength(serializedBody, "utf8")}`];
  // Interceptors can mutate the body after serialization. Getters, Proxy traps
  // and toJSON may then throw, but diagnostics must preserve the provider 400.
  try {
    const payload =
      body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const rawInput = payload.input;
    const input = Array.isArray(rawInput) ? rawInput : [];
    const rawTools = payload.tools;
    const tools = Array.isArray(rawTools) ? rawTools : [];
    const instructions = payload.instructions;
    details.push(
      `instructionsBytes=${typeof instructions === "string" ? Buffer.byteLength(instructions, "utf8") : 0}`,
      `inputItems=${input.length}`,
      `tools=${tools.length}`,
    );
    // A rejected giant body is already expensive to retain. Its total byte
    // count is enough to flag size pressure without serializing it again.
    if (serializedBody.length > 8 * 1024 * 1024 || input.length > 4096) {
      return details.join(" ");
    }
    let largestItemBytes = 0;
    let largestItemType = "other";
    for (const item of input) {
      const itemBytes = Buffer.byteLength(
        JSON.stringify(item) ?? "null",
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
      details.push(
        `largestItemBytes=${largestItemBytes}`,
        `largestItemType=${largestItemType}`,
      );
    }
  } catch {
    // The already-serialized body size remains useful.
  }
  return details.join(" ");
}
