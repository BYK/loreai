/** Report reviewed failure classes without persisting provider text or payloads. */
export function responsesValidationCheck(error: unknown): string {
  if (!(error instanceof Error)) return "unknown";
  const eventCheck =
    /^Responses response\.(?:function_call_arguments\.(?:delta|done)|content_part\.(?:added|done)|reasoning_(?:text\.(?:delta|done)|summary_(?:text\.(?:delta|done)|part\.(?:added|done)))) (changed item_id|does not match item type|changed content type)/.exec(
      error.message,
    );
  if (eventCheck) {
    return eventCheck[1] === "changed item_id"
      ? "event_item_id_changed"
      : eventCheck[1] === "does not match item type"
        ? "event_item_type_mismatch"
        : "event_content_type_changed";
  }
  if (
    /^Responses response\.(?:content_part\.(?:added|done)|reasoning_(?:text\.(?:delta|done)|summary_(?:text\.(?:delta|done)|part\.(?:added|done)))) arrived before output_item\.added/.test(
      error.message,
    )
  ) {
    return "event_before_output_added";
  }
  const checks = [
    ["invalid Responses function arguments delta", "arguments_delta_invalid"],
    [
      "invalid Responses function arguments completion",
      "arguments_done_invalid",
    ],
    [
      "Responses function arguments completion changed streamed arguments",
      "arguments_stream_changed",
    ],
    [
      "duplicate Responses function arguments completion",
      "arguments_done_duplicate",
    ],
    [
      "Responses function arguments changed after completion",
      "arguments_after_completion",
    ],
    [
      "Copilot Responses identity alias_owner_conflict",
      "copilot_alias_owner_conflict",
    ],
    ["Copilot Responses identity alias_reserved", "copilot_alias_reserved"],
    ["Copilot Responses identity alias_limit", "copilot_alias_limit"],
    [
      "Responses output_item.done changed item envelope",
      "output_envelope_changed",
    ],
    ["Responses output_item.done invalid status", "output_status_invalid"],
    [
      "Responses output_item.done invalid encrypted content",
      "output_encrypted_content_invalid",
    ],
    [
      "invalid Responses response.content_part.added value",
      "content_part_value_invalid",
    ],
    [
      "invalid Responses response.content_part.done value",
      "content_part_value_invalid",
    ],
    [
      "invalid Responses reasoning summary item",
      "reasoning_summary_shape_invalid",
    ],
    [
      "invalid Responses reasoning content item",
      "reasoning_content_shape_invalid",
    ],
    [
      "Responses reasoning summary must be an array",
      "reasoning_summary_array_invalid",
    ],
    [
      "Responses reasoning content must be an array",
      "reasoning_content_array_invalid",
    ],
    ["non-contiguous Responses summary_index", "summary_index_noncontiguous"],
    [
      "non-contiguous Responses reasoning content",
      "reasoning_content_noncontiguous",
    ],
    [
      "Responses reasoning summary part changed initial content",
      "summary_initial_changed",
    ],
    [
      "Responses reasoning summary changed streamed content",
      "summary_stream_changed",
    ],
    [
      "Responses reasoning summary changed after completion",
      "summary_after_completion",
    ],
    [
      "duplicate Responses reasoning summary completion",
      "summary_completion_duplicate",
    ],
    ["invalid Responses reasoning summary delta", "summary_delta_invalid"],
    [
      "invalid Responses reasoning summary final value",
      "summary_final_invalid",
    ],
    ["Responses content changed after completion", "content_after_completion"],
    ["invalid Responses output_index", "output_index_invalid"],
    [
      "Responses output_item.done changed item identity",
      "output_identity_changed",
    ],
    ["Responses output_item.done changed item type", "output_type_changed"],
    [
      "Responses output_item.done changed arguments",
      "output_arguments_changed",
    ],
    [
      "Responses output_item.done introduced untracked reasoning",
      "untracked_reasoning",
    ],
    ["Responses output_item.done missing item", "output_item_missing"],
    ["invalid Responses content_part.added", "content_part_added_order"],
    ["invalid Responses content_part.done", "content_part_done_order"],
    [
      "Responses content_part.added changed initial content",
      "content_initial_changed",
    ],
    ["Responses content_part.done changed content", "content_final_changed"],
    ["invalid Responses content type", "content_type_invalid"],
    ["invalid Responses content_index", "content_index_invalid"],
    ["invalid Responses summary_index", "summary_index_invalid"],
    ["unsupported Responses reasoning event", "reasoning_event_unsupported"],
    [
      "unsupported reviewed Responses reasoning event",
      "reasoning_event_unreviewed",
    ],
    ["invalid Responses reasoning summary part", "summary_part_order"],
    [
      "invalid Responses reasoning summary completion",
      "summary_completion_order",
    ],
    [
      "Responses reasoning summary part changed content",
      "summary_content_changed",
    ],
  ] as const;
  return (
    checks.find(([prefix]) => error.message.startsWith(prefix))?.[1] ??
    "unknown"
  );
}

export function upstreamRejectionDiagnostic(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return "body=json_invalid";
  }
  if (!parsed || typeof parsed !== "object") return "body=other";
  const payload = parsed as Record<string, unknown>;
  const error =
    payload.error && typeof payload.error === "object"
      ? (payload.error as Record<string, unknown>)
      : payload;
  const codes = [
    "unsupported_api_for_model",
    "model_not_supported",
    "model_not_found",
    "invalid_request_body",
    "invalid_request_error",
    "invalid_argument",
    "context_length_exceeded",
    "unauthorized",
    "permission_denied",
  ];
  const code =
    typeof error.code === "string" && codes.includes(error.code)
      ? error.code
      : "unrecognized";
  const message =
    typeof error.message === "string" ? error.message.slice(0, 8192) : "";
  const hints = [
    ["tool", /\btools?\b/i],
    ["schema", /\bschema\b/i],
    ["unsupported", /\bunsupported\b|not supported/i],
    ["model", /\bmodel\b/i],
    ["token", /\btokens?\b/i],
    ["limit", /\blimit\b|too (?:many|large|long)/i],
    ["reasoning", /\breasoning\b/i],
    ["parameter", /\bparameter\b/i],
  ] as const;
  const summary = `body=json code=${code} hints=${
    hints
      .filter(([, pattern]) => pattern.test(message))
      .map(([name]) => name)
      .join(",") || "none"
  }`;
  if (code !== "invalid_request_body") return summary;

  // Inspect bounded provider text, but emit only reviewed constants.
  const explanation = message;
  const fields = [
    "cache_control",
    "copilot_cache_control",
    "thinking_budget",
    "reasoning_effort",
    "max_tokens",
    "max_completion_tokens",
    "parallel_tool_calls",
    "tool_choice",
    "response_format",
    "stream_options",
  ].filter((field) => new RegExp(`\\b${field}\\b`).test(explanation));
  const checks = [
    ["additional_properties", /\badditionalProperties\b/],
    [
      "unknown_field",
      /\b(?:unknown|unrecognized|unexpected) (?:field|property|parameter)\b/i,
    ],
    [
      "required_field",
      /\b(?:required|missing) (?:field|property|parameter)\b/i,
    ],
    [
      "invalid_type",
      /\binvalid type\b|\bexpected (?:string|number|integer|boolean|object|array)\b/i,
    ],
  ] as const;
  const messageShape =
    error.message === undefined
      ? "missing"
      : error.message === null
        ? "null"
        : typeof error.message === "string"
          ? error.message.length === 0
            ? "empty"
            : "string"
          : "other";
  return `${summary} message=${messageShape} param=${rejectionParameter(error.param)} fields=${fields.join(",") || "none"} checks=${
    checks
      .filter(([, pattern]) => pattern.test(explanation))
      .map(([name]) => name)
      .join(",") || "none"
  }`;
}

function rejectionParameter(value: unknown): string {
  if (value === undefined) return "missing";
  if (value === null) return "null";
  if (typeof value !== "string") return "other";
  if (value === "") return "empty";
  if (value.length > 512) return "unrecognized";
  const path = value
    .replace(/^\//, "")
    .replace(/\//g, ".")
    .replace(/\[\d+\]/g, ".0")
    .replace(/\.\d+(?=\.|$)/g, ".0");
  if (/^tools\.0\.function\.parameters(?:\.|$)/.test(path)) {
    return "tool_schema";
  }
  if (path === "tools.0.function.name") return "tool_name";
  if (/^messages\.0\.content(?:\.|$)/.test(path)) return "message_content";
  if (path === "messages.0.role") return "message_role";
  const fields = [
    "model",
    "messages",
    "tools",
    "cache_control",
    "copilot_cache_control",
    "thinking_budget",
    "reasoning_effort",
    "max_tokens",
    "max_completion_tokens",
    "parallel_tool_calls",
    "tool_choice",
    "response_format",
    "stream_options",
    "temperature",
    "top_p",
  ];
  return fields.includes(path) ? path : "unrecognized";
}
