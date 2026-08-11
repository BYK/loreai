/** Anthropic response values accepted at the provider boundary. */

export const ANTHROPIC_STOP_REASONS: ReadonlySet<string> = new Set([
  "end_turn",
  "max_tokens",
  "stop_sequence",
  "tool_use",
  "pause_turn",
  "refusal",
  "model_context_window_exceeded",
]);

export const ANTHROPIC_CONTENT_BLOCK_TYPES: ReadonlySet<string> = new Set([
  "text",
  "thinking",
  "redacted_thinking",
  "tool_use",
  "server_tool_use",
  "web_search_tool_result",
  "web_fetch_tool_result",
  "code_execution_tool_result",
  "bash_code_execution_tool_result",
  "text_editor_code_execution_tool_result",
  "tool_search_tool_result",
  "container_upload",
  // Server-side fallback emits a boundary block with no deltas.
  "fallback",
]);

export function normalizeAnthropicStopReason(reason: string): string {
  return reason === "refusal" ? "content_filter" : reason;
}

export function toAnthropicStopReason(reason: string): string {
  return reason === "content_filter" ? "refusal" : reason;
}
