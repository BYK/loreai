import { isDeepStrictEqual } from "node:util";

const CONTROLS = [
  "model",
  "stream",
  "max_tokens",
  "max_completion_tokens",
  "thinking_budget",
  "reasoning_effort",
  "verbosity",
  "temperature",
  "top_p",
  "frequency_penalty",
  "presence_penalty",
  "stop",
  "seed",
  "user",
  "store",
  "tool_choice",
  "parallel_tool_calls",
  "response_format",
  "stream_options",
  "logprobs",
  "top_logprobs",
  "provider",
] as const;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function inspect(body: Record<string, unknown>) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const tools = Array.isArray(body.tools) ? body.tools : [];
  let cacheAnnotations = 0;
  let copilotCacheAnnotations = 0;
  let invalidMessages = 0;
  let invalidToolSchemas = 0;
  let arrayContent = 0;
  const countCache = (value: unknown) => {
    const item = record(value);
    if (Object.hasOwn(item, "cache_control")) cacheAnnotations++;
    if (Object.hasOwn(item, "copilot_cache_control")) copilotCacheAnnotations++;
  };
  for (const value of messages.slice(0, 512)) {
    const message = record(value);
    countCache(message);
    if (
      !["system", "developer", "user", "assistant", "tool"].includes(
        String(message.role),
      ) ||
      !(
        typeof message.content === "string" ||
        Array.isArray(message.content) ||
        (message.role === "assistant" &&
          message.content == null &&
          Array.isArray(message.tool_calls))
      )
    ) {
      invalidMessages++;
    }
    if (Array.isArray(message.content)) {
      arrayContent++;
      for (const part of message.content.slice(0, 128)) countCache(part);
    }
  }
  for (const value of tools.slice(0, 128)) {
    const tool = record(value);
    countCache(tool);
    const fn = record(tool.function);
    countCache(fn);
    if (
      tool.type !== "function" ||
      typeof fn.name !== "string" ||
      !fn.parameters ||
      typeof fn.parameters !== "object" ||
      Array.isArray(fn.parameters)
    ) {
      invalidToolSchemas++;
    }
  }
  return {
    messages: messages.length,
    tools: tools.length,
    arrayContent,
    cacheAnnotations,
    copilotCacheAnnotations,
    invalidMessages,
    invalidToolSchemas,
    unknownControls: Object.keys(body).filter(
      (key) =>
        key !== "messages" &&
        key !== "tools" &&
        !(CONTROLS as readonly string[]).includes(key),
    ).length,
    truncated:
      messages.length > 512 ||
      tools.length > 128 ||
      messages.slice(0, 512).some((value) => {
        const content = record(value).content;
        return Array.isArray(content) && content.length > 128;
      }),
  };
}

/** Local-only comparison: never returns payload values, names, paths, or hashes. */
export function compareCopilotChatRequests(
  original: unknown,
  rebuilt: unknown,
) {
  const before = record(original);
  const after = record(rebuilt);
  const beforeTools = Array.isArray(before.tools) ? before.tools : [];
  const afterTools = Array.isArray(after.tools) ? after.tools : [];
  const compareTools = (field: string) =>
    beforeTools.length > 128 || afterTools.length > 128
      ? null
      : isDeepStrictEqual(
          beforeTools.map((tool) => record(record(tool).function)[field]),
          afterTools.map((tool) => record(record(tool).function)[field]),
        );
  return {
    controls: {
      added: CONTROLS.filter(
        (key) => !Object.hasOwn(before, key) && Object.hasOwn(after, key),
      ),
      removed: CONTROLS.filter(
        (key) => Object.hasOwn(before, key) && !Object.hasOwn(after, key),
      ),
      changed: CONTROLS.filter(
        (key) =>
          Object.hasOwn(before, key) &&
          Object.hasOwn(after, key) &&
          !isDeepStrictEqual(before[key], after[key]),
      ),
    },
    ingress: inspect(before),
    rebuilt: inspect(after),
    toolSchemasEqual: compareTools("parameters"),
    toolNamesEqual: compareTools("name"),
  };
}
