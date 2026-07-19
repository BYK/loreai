/**
 * Reasoning-effort vocabulary and per-protocol mappings for worker LLM calls.
 *
 * Effort is a single knob a caller can turn to trade cost for depth on a
 * reasoning-capable model. It is surfaced by `lore invariant-check` (as
 * `--effort` / the `invariantCheck.effort` config key) and threaded through
 * `LLMClient.prompt(..., { reasoningEffort })` into the gateway worker request
 * builders.
 *
 * The vocabulary matches Warden's (`off | low | medium | high | xhigh`) so the
 * two tools speak the same language. Each protocol maps it to its own native
 * dial:
 *   - OpenAI Chat Completions → `reasoning_effort` (ignored by non-reasoning
 *     models like gpt-4o-mini; honored by o-series / gpt-5). `xhigh` is not a
 *     standard OpenAI value, so it is clamped to `high` to avoid a 400.
 *   - Anthropic Messages / Vertex → extended-thinking `budget_tokens`.
 *
 * `off` is the default and means "send no reasoning dial at all" — identical to
 * the pre-effort behavior (OpenAI: omit `reasoning_effort`; Anthropic: the
 * worker's existing `thinking:{type:"disabled"}` suppression still applies).
 */
export type ReasoningEffort = "off" | "low" | "medium" | "high" | "xhigh";

export const REASONING_EFFORTS: readonly ReasoningEffort[] = [
  "off",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

/** Narrow an arbitrary string to a ReasoningEffort, or null if unrecognized. */
export function parseReasoningEffort(
  s: string | undefined | null,
): ReasoningEffort | null {
  if (!s) return null;
  const v = s.trim().toLowerCase();
  return (REASONING_EFFORTS as readonly string[]).includes(v)
    ? (v as ReasoningEffort)
    : null;
}

/**
 * Map effort to OpenAI Chat Completions `reasoning_effort`.
 *
 * Returns null when no param should be sent (`off`). `xhigh` clamps to `high`
 * because OpenAI does not accept `xhigh` and would reject the request.
 */
export function openAIReasoningEffort(
  effort: ReasoningEffort | undefined,
): "low" | "medium" | "high" | null {
  switch (effort) {
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      return "high"; // not a standard OpenAI value — clamp down, don't 400
    default:
      return null; // "off" / undefined → omit the param
  }
}

/**
 * Map effort to an Anthropic extended-thinking `budget_tokens`, or null when
 * thinking should not be explicitly enabled (`off`/undefined → caller keeps its
 * existing disable-thinking behavior).
 *
 * Budgets are deliberately modest — the judge does bounded single-shot
 * classification, not open-ended agentic reasoning. Anthropic requires
 * `budget_tokens >= 1024`.
 */
export function anthropicThinkingBudget(
  effort: ReasoningEffort | undefined,
): number | null {
  switch (effort) {
    case "low":
      return 2048;
    case "medium":
      return 8192;
    case "high":
      return 16384;
    case "xhigh":
      return 32768;
    default:
      return null; // "off" / undefined → do not enable thinking
  }
}
