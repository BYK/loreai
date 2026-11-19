import { createHash } from "node:crypto";
import { credentialTenantFingerprint, extractAuth } from "./auth";
import { compressBody } from "./cache-analytics";
import type { GatewayUsage } from "./translate/types";
import { isRecord, validateResponsesUsage } from "./usage-validation";
import { getExactModelEntrySyncForProvider } from "./worker-model";

export const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
export const OPENAI_CACHE_TTL_MS = 30 * 60_000;

// Keep background replay bounded even when the foreground accepts a large body.
const MAX_REPLAY_BYTES = 1024 * 1024;
const SCOPE_HEADERS = ["openai-organization", "openai-project", "openai-beta"];

export function openAIWarmupHeadersAllowed(
  headers: Record<string, string>,
): boolean {
  return Object.keys(headers).every(
    (name) =>
      name === "authorization" ||
      name === "content-type" ||
      SCOPE_HEADERS.includes(name),
  );
}

export type OpenAIWarmupPricing = {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
};

export type OpenAIWarmupRoute = {
  scope: string;
  headers: Record<string, string>;
  model: string;
  cacheKey?: string;
};

export type OpenAIWarmupReplay = OpenAIWarmupRoute & {
  body: Uint8Array;
  prefixTokens: number;
  uncachedTokens: number;
  pricing: OpenAIWarmupPricing;
};

export function openAIWarmupPricing(
  model: string,
): OpenAIWarmupPricing | undefined {
  // The native prewarm and renewable 30-minute lifetime start with GPT-5.6.
  if (
    !/^gpt-(?:5\.6|6(?:\.\d+)?)-(?:astra|sol|terra|luna)(?:-\d{4}-\d{2}-\d{2})?$/.test(
      model,
    )
  )
    return;
  const cost = getExactModelEntrySyncForProvider("openai", model)?.cost;
  if (
    !cost?.input ||
    cost.input <= 0 ||
    !cost.output ||
    cost.output <= 0 ||
    !Number.isFinite(cost.input) ||
    !Number.isFinite(cost.output)
  )
    return;
  const readMultiplier = /^gpt-6\.1-(?:sol|terra)(?:-|$)/.test(model)
    ? 0.05
    : 0.1;
  return {
    input: cost.input,
    output: cost.output,
    cache_read: cost.input * readMultiplier,
    cache_write: cost.input * 1.25,
  };
}

export function openAIWarmupScope(
  headers: Record<string, string>,
  model: string,
  cacheKey: string | undefined,
): OpenAIWarmupRoute | undefined {
  const credential = extractAuth(headers);
  if (credential?.scheme !== "bearer") return;
  const scopeHeaders = Object.fromEntries(
    SCOPE_HEADERS.flatMap((name) =>
      headers[name] === undefined ? [] : [[name, headers[name]]],
    ),
  );
  const scope = createHash("sha256")
    .update(
      JSON.stringify([
        credentialTenantFingerprint(credential),
        model,
        cacheKey,
        scopeHeaders,
      ]),
    )
    .digest("hex");
  return { scope, headers: scopeHeaders, model, cacheKey };
}

/** Accept only rendered text, reasoning and local function calls for replay. */
function selfContainedInput(value: unknown): boolean {
  if (typeof value === "string") return true;
  if (!Array.isArray(value)) return false;
  return value.every((item) => {
    if (!isRecord(item) || item.prompt_cache_breakpoint !== undefined)
      return false;
    switch (item.type) {
      case undefined:
      case "message":
        return (
          typeof item.content === "string" ||
          (Array.isArray(item.content) &&
            item.content.every(
              (part) =>
                isRecord(part) &&
                part.prompt_cache_breakpoint === undefined &&
                (part.type === "input_text" ||
                  part.type === "output_text" ||
                  part.type === "refusal"),
            ))
        );
      case "function_call":
      case "reasoning":
        return true;
      case "function_call_output":
        return typeof item.output === "string";
      default:
        return false;
    }
  });
}

export function prepareOpenAIWarmupReplay(
  serializedBody: string,
  route: OpenAIWarmupRoute,
  usage: GatewayUsage,
  minimumTokens: number,
): OpenAIWarmupReplay | undefined {
  // The gateway's usage counters are disjoint. An accepted foreground write
  // also populated the prefix; the replay itself must read it without writes.
  const prefixTokens =
    (usage.cacheReadInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0);
  if (
    !Number.isSafeInteger(prefixTokens) ||
    prefixTokens < minimumTokens ||
    serializedBody.length > 8 * MAX_REPLAY_BYTES
  )
    return;
  const pricing = openAIWarmupPricing(route.model);
  if (!pricing) return;

  const body = JSON.parse(serializedBody) as Record<string, unknown>;
  const options = body.prompt_cache_options;
  if (
    body.model !== route.model ||
    body.store !== false ||
    body.previous_response_id != null ||
    body.conversation != null ||
    body.prompt != null ||
    body.prompt_cache_retention != null ||
    body.service_tier != null ||
    body.truncation === "auto" ||
    (options !== undefined &&
      (!isRecord(options) ||
        Object.keys(options).some(
          (key) => !["ttl", "mode", "prewarm"].includes(key),
        ) ||
        (options.ttl !== undefined && options.ttl !== "30m") ||
        (options.mode !== undefined && options.mode !== "implicit") ||
        (options.prewarm !== undefined && options.prewarm !== false))) ||
    (body.tools !== undefined &&
      (!Array.isArray(body.tools) ||
        body.tools.some(
          (tool) =>
            !isRecord(tool) ||
            tool.type !== "function" ||
            tool.prompt_cache_breakpoint !== undefined,
        ))) ||
    !selfContainedInput(body.input)
  )
    return;

  body.prompt_cache_options = {
    ...(options as object | undefined),
    prewarm: true,
  };
  body.stream = false;
  delete body.max_output_tokens;
  delete body.stream_options;
  delete body.background;

  const compressed = compressBody(JSON.stringify(body));
  if (compressed.byteLength > MAX_REPLAY_BYTES) return;
  return {
    ...route,
    body: compressed,
    prefixTokens,
    uncachedTokens: usage.inputTokens ?? 0,
    pricing,
  };
}

export function parseOpenAIWarmupUsage(response: unknown) {
  if (!isRecord(response)) return;
  const usage = validateResponsesUsage(
    response.usage,
    "malformed OpenAI prewarm usage",
  );
  if (!usage || !isRecord(usage.input_tokens_details)) return;
  const { input_tokens: total, output_tokens: outputTokens } = usage;
  const {
    cached_tokens: cacheReadTokens,
    cache_write_tokens: cacheCreationTokens,
  } = usage.input_tokens_details;
  if (
    typeof total !== "number" ||
    typeof outputTokens !== "number" ||
    typeof cacheReadTokens !== "number" ||
    typeof cacheCreationTokens !== "number"
  )
    return;
  return {
    inputTokens: total - cacheReadTokens - cacheCreationTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    completed:
      response.status === "completed" &&
      response.error == null &&
      Array.isArray(response.output) &&
      response.output.length === 0,
  };
}
