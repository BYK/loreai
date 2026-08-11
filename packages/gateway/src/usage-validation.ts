/** Runtime validation for provider-reported token usage. */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function invalid(message: string): never {
  throw new Error(message);
}

function tokenCount(
  value: unknown,
  message: string,
  allowNull = false,
): number | undefined {
  if (value === undefined || (allowNull && value === null)) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid(message);
  return value as number;
}

/** Add validated token counts without allowing a safe-integer overflow. */
export function safeTokenSum(
  values: Array<number | undefined>,
  message: string,
): number {
  let total = 0;
  for (const value of values) {
    if (value === undefined) continue;
    if (value > Number.MAX_SAFE_INTEGER - total) invalid(message);
    total += value;
  }
  return total;
}

function optionalDetails(
  value: unknown,
  message: string,
): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) invalid(message);
  return value;
}

function validateSubset(
  components: Array<number | undefined>,
  total: number | undefined,
  message: string,
): number {
  const sum = safeTokenSum(components, message);
  if (sum > 0 && total === undefined) invalid(message);
  if (total !== undefined && sum > total) invalid(message);
  return sum;
}

export function validateAnthropicUsage(
  value: unknown,
  options: {
    message: string;
    required?: boolean;
    requireInput?: boolean;
    requireOutput?: boolean;
    allowNullCounts?: boolean;
  },
): Record<string, unknown> | undefined {
  if (value === undefined || value === null) {
    if (options.required) invalid(options.message);
    return undefined;
  }
  if (!isRecord(value)) invalid(options.message);

  const input = tokenCount(
    value.input_tokens,
    options.message,
    options.allowNullCounts,
  );
  const output = tokenCount(value.output_tokens, options.message);
  const cacheRead = tokenCount(
    value.cache_read_input_tokens,
    options.message,
    true,
  );
  const cacheCreation = tokenCount(
    value.cache_creation_input_tokens,
    options.message,
    true,
  );
  if (options.requireInput && input === undefined) invalid(options.message);
  if (options.requireOutput && output === undefined) invalid(options.message);
  safeTokenSum([input, output, cacheRead, cacheCreation], options.message);

  const cacheDetails = optionalDetails(value.cache_creation, options.message);
  if (cacheDetails) {
    const fiveMinute = tokenCount(
      cacheDetails.ephemeral_5m_input_tokens,
      options.message,
    );
    const oneHour = tokenCount(
      cacheDetails.ephemeral_1h_input_tokens,
      options.message,
    );
    validateSubset([fiveMinute, oneHour], cacheCreation, options.message);
  }

  const outputDetails = optionalDetails(
    value.output_tokens_details,
    options.message,
  );
  if (outputDetails) {
    const thinking = tokenCount(outputDetails.thinking_tokens, options.message);
    validateSubset([thinking], output, options.message);
  }

  const serverToolUse = optionalDetails(value.server_tool_use, options.message);
  if (serverToolUse) {
    const webSearch = tokenCount(
      serverToolUse.web_search_requests,
      options.message,
    );
    const webFetch = tokenCount(
      serverToolUse.web_fetch_requests,
      options.message,
    );
    safeTokenSum([webSearch, webFetch], options.message);
  }

  return value;
}

const OPENAI_COMPLETION_DETAIL_FIELDS = [
  "reasoning_tokens",
  "audio_tokens",
  "accepted_prediction_tokens",
  "rejected_prediction_tokens",
] as const;

function validateOpenAIDetails(
  value: unknown,
  total: number | undefined,
  fields: readonly string[],
  message: string,
): Record<string, unknown> | undefined {
  const details = optionalDetails(value, message);
  if (!details) return undefined;
  const components = fields.map((field) => tokenCount(details[field], message));
  validateSubset(components, total, message);
  return details;
}

export function validateOpenAIUsage(
  value: unknown,
  message: string,
): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) invalid(message);

  const prompt = tokenCount(value.prompt_tokens, message);
  const completion = tokenCount(value.completion_tokens, message);
  const total = tokenCount(value.total_tokens, message);
  if (
    total !== undefined &&
    (prompt === undefined || completion === undefined)
  ) {
    invalid(message);
  }
  const componentTotal = safeTokenSum([prompt, completion], message);
  // Cache counts are subsets of prompt_tokens; reasoning/audio/prediction
  // counts are subsets of completion_tokens. They must not be added again.
  if (total !== undefined && componentTotal !== total) invalid(message);

  const promptDetails = validateOpenAIDetails(
    value.prompt_tokens_details,
    prompt,
    ["cached_tokens", "cache_write_tokens"],
    message,
  );
  if (promptDetails) {
    const cached = tokenCount(promptDetails.cached_tokens, message);
    const cacheWrite = tokenCount(promptDetails.cache_write_tokens, message);
    validateSubset([cached, cacheWrite], prompt, message);
  }
  validateOpenAIDetails(
    value.completion_tokens_details,
    completion,
    OPENAI_COMPLETION_DETAIL_FIELDS,
    message,
  );

  return value;
}

function validateResponsesInputDetails(
  value: unknown,
  input: number | undefined,
  message: string,
): Record<string, unknown> | undefined {
  const details = optionalDetails(value, message);
  if (!details) return undefined;
  const cached = tokenCount(details.cached_tokens, message);
  const cacheWrite = tokenCount(details.cache_write_tokens, message);
  validateSubset([cached, cacheWrite], input, message);
  return details;
}

export function validateResponsesUsage(
  value: unknown,
  message: string,
): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) invalid(message);

  const input = tokenCount(value.input_tokens, message);
  const output = tokenCount(value.output_tokens, message);
  const total = tokenCount(value.total_tokens, message);
  if (total !== undefined && (input === undefined || output === undefined)) {
    invalid(message);
  }
  const componentTotal = safeTokenSum([input, output], message);
  // Responses uses the same inclusive parent-count semantics as Chat:
  // cache details belong to input_tokens and reasoning details to output_tokens.
  if (total !== undefined && componentTotal !== total) invalid(message);

  validateResponsesInputDetails(value.input_tokens_details, input, message);
  validateResponsesInputDetails(value.prompt_tokens_details, input, message);
  validateOpenAIDetails(
    value.output_tokens_details,
    output,
    OPENAI_COMPLETION_DETAIL_FIELDS,
    message,
  );

  return value;
}

const GEMINI_COUNT_FIELDS = [
  "promptTokenCount",
  "candidatesTokenCount",
  "thoughtsTokenCount",
  "cachedContentTokenCount",
  "toolUsePromptTokenCount",
  "totalTokenCount",
] as const;

function validateGeminiModalityDetails(
  value: unknown,
  total: number | undefined,
  message: string,
): void {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value)) invalid(message);
  const components: number[] = [];
  for (const detail of value) {
    if (!isRecord(detail)) invalid(message);
    const count = tokenCount(detail.tokenCount, message);
    if (count !== undefined) components.push(count);
  }
  validateSubset(components, total, message);
}

export function validateGeminiUsageMetadata(
  value: unknown,
  message: string,
): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) invalid(message);

  const counts = Object.fromEntries(
    GEMINI_COUNT_FIELDS.map((field) => [
      field,
      tokenCount(value[field], message),
    ]),
  ) as Record<(typeof GEMINI_COUNT_FIELDS)[number], number | undefined>;

  // Gemini reports cached tokens as a subset of promptTokenCount and modality
  // details as decompositions of their parent counts, so neither is added here.
  // thoughtsTokenCount and toolUsePromptTokenCount are separate billable
  // components of totalTokenCount.
  const componentTotal = safeTokenSum(
    [
      counts.promptTokenCount,
      counts.candidatesTokenCount,
      counts.thoughtsTokenCount,
      counts.toolUsePromptTokenCount,
    ],
    message,
  );
  if (
    counts.totalTokenCount !== undefined &&
    (counts.promptTokenCount === undefined ||
      counts.candidatesTokenCount === undefined ||
      componentTotal !== counts.totalTokenCount)
  ) {
    invalid(message);
  }
  if (
    counts.cachedContentTokenCount !== undefined &&
    (counts.promptTokenCount === undefined ||
      counts.cachedContentTokenCount > counts.promptTokenCount)
  ) {
    invalid(message);
  }

  validateGeminiModalityDetails(
    value.cacheTokensDetails,
    counts.cachedContentTokenCount,
    message,
  );
  validateGeminiModalityDetails(
    value.candidatesTokensDetails,
    counts.candidatesTokenCount,
    message,
  );
  validateGeminiModalityDetails(
    value.promptTokensDetails,
    counts.promptTokenCount,
    message,
  );
  validateGeminiModalityDetails(
    value.toolUsePromptTokensDetails,
    counts.toolUsePromptTokenCount,
    message,
  );

  return value;
}
