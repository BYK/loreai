import { config, type LoreConfig } from "./config";
import {
  MAX_RECALL_BATCH_IDS,
  MAX_RECALL_DETAIL_CHARS,
  MAX_RECALL_ID_CHARS,
  MAX_RECALL_QUERY_CHARS,
  isRecallDetailRef,
  isValidRecallId,
  isValidRecallQuery,
  RECALL_PARAM_DESCRIPTIONS,
  runRecall,
  type RecallInput,
  type RecallResult,
  type RecallScope,
} from "./recall";

export const RECALL_TOOL_NAME = "recall";

export const RECALL_TOOL_SCOPES = [
  "all",
  "session",
  "project",
  "knowledge",
] as const satisfies readonly RecallScope[];

/** Canonical provider-neutral input schema used by gateway and host adapters. */
export const RECALL_TOOL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    query: {
      type: "string",
      maxLength: MAX_RECALL_QUERY_CHARS,
      description: RECALL_PARAM_DESCRIPTIONS.query,
    },
    scope: {
      type: "string",
      enum: RECALL_TOOL_SCOPES,
      description: RECALL_PARAM_DESCRIPTIONS.scope,
    },
    id: {
      type: "string",
      minLength: 1,
      maxLength: MAX_RECALL_ID_CHARS,
      description: RECALL_PARAM_DESCRIPTIONS.id,
    },
    ids: {
      type: "array",
      minItems: 1,
      maxItems: MAX_RECALL_BATCH_IDS,
      items: {
        type: "string",
        minLength: 1,
        maxLength: MAX_RECALL_ID_CHARS,
      },
      description: RECALL_PARAM_DESCRIPTIONS.ids,
    },
    detailOffset: {
      type: "integer",
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
      description: RECALL_PARAM_DESCRIPTIONS.detailOffset,
    },
    detailLimit: {
      type: "integer",
      minimum: 1,
      maximum: MAX_RECALL_DETAIL_CHARS,
      description: RECALL_PARAM_DESCRIPTIONS.detailLimit,
    },
  },
  anyOf: [{ required: ["query"] }, { required: ["id"] }, { required: ["ids"] }],
  additionalProperties: false,
} as const;

export type RecallToolArguments = {
  query?: string;
  scope?: RecallScope;
  id?: string;
  ids?: string[];
  detailOffset?: number;
  detailLimit?: number;
};

export type RecallToolContext = {
  projectPath: string;
  sessionID?: string;
  signal?: AbortSignal;
};

export type RecallToolRunner = (input: RecallInput) => Promise<RecallResult>;
export type RecallToolExecutor = (
  input: unknown,
  context: RecallToolContext,
) => Promise<string>;

export type RecallToolParseResult =
  | { valid: true; value: RecallToolArguments }
  | { valid: false; error: string };

const RECALL_TOOL_KEYS = new Set(
  Object.keys(RECALL_TOOL_INPUT_SCHEMA.properties),
);

/** Validate untrusted tool arguments once for every harness adapter. */
export function parseRecallToolArguments(
  input: unknown,
): RecallToolParseResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { valid: false, error: "Recall arguments must be an object." };
  }

  const record = input as Record<string, unknown>;
  if (Object.keys(record).some((key) => !RECALL_TOOL_KEYS.has(key))) {
    return {
      valid: false,
      error: "Recall arguments contain unsupported properties.",
    };
  }

  const queryValue = record.query === null ? undefined : record.query;
  const scopeValue = record.scope === null ? undefined : record.scope;
  const idValue = record.id === null ? undefined : record.id;
  const idsValue = record.ids === null ? undefined : record.ids;
  const detailOffsetValue =
    record.detailOffset === null ? undefined : record.detailOffset;
  const detailLimitValue =
    record.detailLimit === null ? undefined : record.detailLimit;

  if (
    queryValue !== undefined &&
    (typeof queryValue !== "string" || !isValidRecallQuery(queryValue))
  ) {
    return { valid: false, error: "Recall query is invalid." };
  }
  if (
    scopeValue !== undefined &&
    (typeof scopeValue !== "string" ||
      !RECALL_TOOL_SCOPES.includes(scopeValue as RecallScope))
  ) {
    return { valid: false, error: "Recall scope is invalid." };
  }
  if (
    idValue !== undefined &&
    !isValidRecallId(idValue) &&
    !isRecallDetailRef(idValue)
  ) {
    return { valid: false, error: "Recall id is invalid." };
  }
  if (
    idsValue !== undefined &&
    (!Array.isArray(idsValue) ||
      idsValue.length < 1 ||
      idsValue.length > MAX_RECALL_BATCH_IDS ||
      !Array.from(idsValue).every(
        (id) => isValidRecallId(id) || isRecallDetailRef(id),
      ))
  ) {
    return { valid: false, error: "Recall ids are invalid." };
  }
  if (
    detailOffsetValue !== undefined &&
    (typeof detailOffsetValue !== "number" ||
      !Number.isSafeInteger(detailOffsetValue) ||
      detailOffsetValue < 0)
  ) {
    return { valid: false, error: "Recall detailOffset is invalid." };
  }
  if (
    detailLimitValue !== undefined &&
    (typeof detailLimitValue !== "number" ||
      !Number.isSafeInteger(detailLimitValue) ||
      detailLimitValue < 1 ||
      detailLimitValue > MAX_RECALL_DETAIL_CHARS)
  ) {
    return { valid: false, error: "Recall detailLimit is invalid." };
  }
  if (
    idValue !== undefined &&
    typeof idValue === "string" &&
    idsValue !== undefined
  ) {
    return { valid: false, error: "Pass either id or ids, not both." };
  }
  if (
    (detailOffsetValue !== undefined || detailLimitValue !== undefined) &&
    idValue === undefined
  ) {
    return {
      valid: false,
      error: "detailOffset and detailLimit require id.",
    };
  }
  if (
    (queryValue === undefined ||
      typeof queryValue !== "string" ||
      queryValue.trim() === "") &&
    idValue === undefined &&
    idsValue === undefined
  ) {
    return { valid: false, error: "Pass query, id, or ids to recall." };
  }

  return {
    valid: true,
    value: {
      ...(typeof queryValue === "string" ? { query: queryValue } : {}),
      ...(typeof scopeValue === "string"
        ? { scope: scopeValue as RecallScope }
        : {}),
      ...(typeof idValue === "string" ? { id: idValue } : {}),
      ...(Array.isArray(idsValue) ? { ids: idsValue as string[] } : {}),
      ...(typeof detailOffsetValue === "number"
        ? { detailOffset: detailOffsetValue }
        : {}),
      ...(typeof detailLimitValue === "number"
        ? { detailLimit: detailLimitValue }
        : {}),
    },
  };
}

function parseRecallToolArgumentsSafely(input: unknown): RecallToolParseResult {
  try {
    return parseRecallToolArguments(input);
  } catch {
    return { valid: false, error: "Recall arguments are invalid." };
  }
}

/** Build a host-neutral executor that all harness tool wrappers can call. */
export function createRecallToolExecutor(
  run: RecallToolRunner = runRecall,
  getConfig: () => LoreConfig = config,
): RecallToolExecutor {
  return async (input, context) => {
    const parsed = parseRecallToolArgumentsSafely(input);
    if (!parsed.valid) return parsed.error;
    if (context.signal?.aborted) return "Recall was cancelled.";

    try {
      const cfg = getConfig();
      return await run({
        ...parsed.value,
        query: parsed.value.query ?? "",
        projectPath: context.projectPath,
        sessionID: context.sessionID,
        knowledgeEnabled: cfg.knowledge.enabled,
        searchConfig: cfg.search,
        // Opaque detail references are session-bound capabilities.
        detailRefs: Boolean(context.sessionID?.trim()),
        recordTransfers: true,
        signal: context.signal,
      });
    } catch {
      // Never surface private query, provider, configuration, or exception text.
      return context.signal?.aborted
        ? "Recall was cancelled."
        : "Recall failed. Please try again.";
    }
  };
}

export const executeRecallTool = createRecallToolExecutor();
