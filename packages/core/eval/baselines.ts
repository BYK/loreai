/**
 * Baseline implementations for the Lore eval suite.
 *
 * Each baseline takes a conversation transcript and produces a context
 * string that an LLM would use to answer questions about the session.
 *
 * Baselines:
 *   1. Tail window — keep last N tokens, drop the rest
 *   2. Compaction + tail window — LLM-summarize dropped prefix + tail
 *   3. Raw — full conversation (upper-bound reference)
 *   4. Lore context-only (ablation) — via gateway config override
 *   5. Lore memory-only (ablation) — via gateway config override
 *   6. (removed — auto-mem0 was a deprecated external baseline)
 */
import type { ConversationTurn, ContentPart } from "./types";
import type { EvalLLMClient } from "./llm-backend";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Estimate tokens from text length (same heuristic as gradient.ts). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

/** Render a content part to text. */
function renderContentPart(part: ContentPart): string {
  switch (part.type) {
    case "text":
      return part.text;
    case "tool_use":
      return `[Tool call: ${part.name}(${JSON.stringify(part.input).slice(0, 500)})]`;
    case "tool_result":
      return `[Tool result${part.is_error ? " (error)" : ""}:\n${part.content}]`;
  }
}

/** Render a conversation turn to text. */
function renderTurn(turn: ConversationTurn): string {
  const role = turn.role === "user" ? "User" : "Assistant";
  const parts = turn.content.map(renderContentPart).join("\n");
  return `${role}:\n${parts}`;
}

/** Render an array of turns to a single text block. */
export function renderConversation(turns: ConversationTurn[]): string {
  return turns.map(renderTurn).join("\n\n---\n\n");
}

/** Estimate total tokens for an array of turns. */
function totalTokens(turns: ConversationTurn[]): number {
  return turns.reduce(
    (sum, t) => sum + (t.tokens ?? estimateTokens(renderTurn(t))),
    0,
  );
}

// ---------------------------------------------------------------------------
// Baseline 1: Tail Window
// ---------------------------------------------------------------------------

/**
 * Keep the last `budgetTokens` tokens of the conversation.
 * Everything before the cutoff is dropped entirely.
 */
export function tailWindowBaseline(
  turns: ConversationTurn[],
  budgetTokens = 80_000,
): string {
  let tailTokens = 0;
  let cutoff = turns.length;

  for (let i = turns.length - 1; i >= 0; i--) {
    const turnTokens = turns[i].tokens ?? estimateTokens(renderTurn(turns[i]));
    if (tailTokens + turnTokens > budgetTokens) {
      cutoff = i + 1;
      break;
    }
    tailTokens += turnTokens;
    if (i === 0) cutoff = 0;
  }

  const droppedCount = cutoff;
  const tail = turns.slice(cutoff);

  if (droppedCount === 0) {
    return renderConversation(tail);
  }

  return (
    `[Note: ${droppedCount} earlier messages were dropped from context due to context window limits.]\n\n` +
    renderConversation(tail)
  );
}

// ---------------------------------------------------------------------------
// Baseline 2: Compaction + Tail Window
// ---------------------------------------------------------------------------

/**
 * OpenCode's ACTUAL production compaction prompt + settings, ported verbatim so
 * the baseline matches what a real coding agent does (not a hand-rolled proxy).
 *
 * Sources (github.com/sst/opencode):
 *  - System prompt: packages/opencode/src/agent/prompt/compaction.txt
 *  - Summary template + buildPrompt: packages/core/src/session/compaction.ts
 *  - Settings: packages/opencode/src/session/compaction.ts + session/overflow.ts
 *
 * Real behavior we replicate:
 *  - Anchored summary: ONE summary is maintained and UPDATED each pass (via a
 *    <previous-summary> block), not a growing stack of per-pass summaries.
 *  - Small verbatim tail: preserve_recent_tokens = clamp(usable*0.25, 2K, 8K) →
 *    effectively ~8K tokens (MAX_PRESERVE_RECENT_TOKENS) for large models, plus
 *    at least the last 2 turns.
 *  - Overflow trigger: compact when live tokens >= usable, where
 *    usable = context - min(20K, maxOutputTokens).
 *  - Summary output capped at 4096 tokens; tool outputs truncated to 2000 chars.
 */
const COMPACTION_SYSTEM = `You are an anchored context summarization assistant for coding sessions.

Summarize only the conversation history you are given. The newest turns may be kept verbatim outside your summary, so focus on the older context that still matters for continuing the work.

If the prompt includes a <previous-summary> block, treat it as the current anchored summary. Update it with the new history by preserving still-true details, removing stale details, and merging in new facts.

Always follow the exact output structure requested by the user prompt. Keep every section, preserve exact file paths and identifiers when known, and prefer terse bullets over paragraphs.

Do not answer the conversation itself. Do not mention that you are summarizing, compacting, or merging context. Respond in the same language as the conversation.`;

const COMPACTION_SUMMARY_TEMPLATE = `Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Goal
- [single-sentence task summary]

## Constraints & Preferences
- [user constraints, preferences, specs, or "(none)"]

## Progress
### Done
- [completed work or "(none)"]

### In Progress
- [current work or "(none)"]

### Blocked
- [blockers or "(none)"]

## Key Decisions
- [decision and why, or "(none)"]

## Next Steps
- [ordered next actions or "(none)"]

## Critical Context
- [important technical facts, errors, open questions, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
</template>

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, commands, error strings, and identifiers when known.
- Do not mention the summary process or that context was compacted.`;

/** OpenCode's buildPrompt (packages/core/src/session/compaction.ts). */
function buildCompactionUser(
  previousSummary: string | undefined,
  context: string,
): string {
  const head = previousSummary
    ? `Update the anchored summary (shown below in <previous-summary>) using the conversation history that follows.\nPreserve still-true details, remove stale details, and merge in the new facts.\n<previous-summary>\n${previousSummary}\n</previous-summary>`
    : "Create a new anchored summary from the conversation history that follows.";
  return [head, COMPACTION_SUMMARY_TEMPLATE, context].join("\n\n");
}

// Real OpenCode compaction constants (session/compaction.ts + session/overflow.ts)
const COMPACTION_BUFFER = 20_000; // reserved output headroom (overflow.ts)
const MIN_PRESERVE_RECENT_TOKENS = 2_000;
const MAX_PRESERVE_RECENT_TOKENS = 8_000;
const SUMMARY_OUTPUT_TOKENS = 4_096;
const MIN_TAIL_TURNS = 2; // DEFAULT_TAIL_TURNS

/** Tool outputs are truncated to 2000 chars in OpenCode's compaction serializer. */
const COMPACTION_TOOL_OUTPUT_MAX_CHARS = 2_000;

function renderTurnForCompaction(turn: ConversationTurn): string {
  const role = turn.role === "user" ? "User" : "Assistant";
  const parts = turn.content
    .map((part) => {
      if (part.type === "tool_result") {
        const body =
          part.content.length <= COMPACTION_TOOL_OUTPUT_MAX_CHARS
            ? part.content
            : `${part.content.slice(0, COMPACTION_TOOL_OUTPUT_MAX_CHARS)}\n[truncated]`;
        return `[Tool result${part.is_error ? " (error)" : ""}:\n${body}]`;
      }
      return renderContentPart(part);
    })
    .join("\n");
  return `${role}:\n${parts}`;
}

function renderConversationForCompaction(turns: ConversationTurn[]): string {
  return turns.map(renderTurnForCompaction).join("\n\n---\n\n");
}

/**
 * Faithful port of OpenCode's PROGRESSIVE auto-compaction (the way a real coding
 * agent manages a long session). Replay turns in order; whenever the live
 * context (anchored summary + raw tail) reaches `usable = context - reserved`,
 * fold everything except the small verbatim tail into the anchored summary and
 * continue. The summary is ANCHORED — one running summary that is UPDATED each
 * pass via a <previous-summary> block (not a growing stack), exactly as
 * OpenCode does. Early detail decays compound-style as it is repeatedly
 * re-summarized through the ~4K-token structured template.
 *
 * Settings mirror OpenCode exactly:
 *  - usable = context - min(20K, maxOutputTokens)         (overflow.ts)
 *  - verbatim tail = clamp(usable*0.25, 2K, 8K) + ≥2 turns (compaction.ts)
 *  - summary output capped at 4096 tokens
 *  - tool outputs truncated to 2000 chars (renderTurnForCompaction)
 *
 * Same-session-model summarization is intentional and realistic: real agents
 * compact with the session model, so a stronger model produces a tighter,
 * more abstractive summary (loses more verbatim specifics) than a weaker one.
 */
export async function compactionBaseline(
  turns: ConversationTurn[],
  llm: EvalLLMClient,
  modelContextWindow: number = 200_000,
  maxOutputTokens: number = 32_000,
): Promise<string> {
  const reserved = Math.min(COMPACTION_BUFFER, maxOutputTokens);
  const usable = Math.max(0, modelContextWindow - reserved);
  const tailBudget = Math.min(
    MAX_PRESERVE_RECENT_TOKENS,
    Math.max(MIN_PRESERVE_RECENT_TOKENS, Math.floor(usable * 0.25)),
  );
  const SAFETY_CAP = 500;

  // Update the anchored summary with a prefix of raw turns. If the prefix is too
  // large to summarize in one call, fold it in sequential chunks (each chunk
  // updates the running anchor) so we never exceed the summarizer's own window.
  const foldIntoAnchor = async (
    anchor: string | undefined,
    prefix: ConversationTurn[],
  ): Promise<string> => {
    const safeInput = Math.max(
      20_000,
      usable - SUMMARY_OUTPUT_TOKENS - estimateTokens(anchor ?? ""),
    );
    const chunks: ConversationTurn[][] = [];
    let chunk: ConversationTurn[] = [];
    let chunkTokens = 0;
    for (const turn of prefix) {
      const t = turn.tokens ?? estimateTokens(renderTurnForCompaction(turn));
      if (chunkTokens + t > safeInput && chunk.length > 0) {
        chunks.push(chunk);
        chunk = [];
        chunkTokens = 0;
      }
      chunk.push(turn);
      chunkTokens += t;
    }
    if (chunk.length > 0) chunks.push(chunk);

    let current = anchor;
    for (const c of chunks) {
      const result = await llm.prompt(
        COMPACTION_SYSTEM,
        buildCompactionUser(current, renderConversationForCompaction(c)),
        { maxTokens: SUMMARY_OUTPUT_TOKENS, temperature: 0 },
      );
      current = result.text;
    }
    return current ?? "";
  };

  let window: ConversationTurn[] = []; // raw (un-summarized) recent turns
  let windowTokens = 0;
  let anchor: string | undefined; // the single running anchored summary
  let compactionCount = 0;

  for (const turn of turns) {
    window.push(turn);
    windowTokens +=
      turn.tokens ?? estimateTokens(renderTurnForCompaction(turn));

    const liveTokens = windowTokens + estimateTokens(anchor ?? "");
    if (liveTokens < usable || compactionCount >= SAFETY_CAP) continue;

    // Keep the last `tailBudget` tokens verbatim, but always at least the last
    // MIN_TAIL_TURNS turns.
    let tailTokens = 0;
    let cutoff = window.length;
    for (let i = window.length - 1; i >= 0; i--) {
      const t =
        window[i].tokens ?? estimateTokens(renderTurnForCompaction(window[i]));
      const turnsKept = window.length - i;
      if (tailTokens + t > tailBudget && turnsKept > MIN_TAIL_TURNS) {
        cutoff = i + 1;
        break;
      }
      tailTokens += t;
      if (i === 0) cutoff = 0;
    }
    let prefix = window.slice(0, cutoff);
    let tail = window.slice(cutoff);
    if (prefix.length === 0 && window.length > 1) {
      prefix = window.slice(0, -1);
      tail = window.slice(-1);
    }
    if (prefix.length === 0) continue; // lone turn > usable: can't compact

    anchor = await foldIntoAnchor(anchor, prefix);
    compactionCount++;
    window = tail;
    windowTokens = totalTokens(tail);
    console.log(
      `  [compaction] pass ${compactionCount}: folded ${prefix.length} turns → anchor ${estimateTokens(anchor)} tok; tail ${windowTokens} tok`,
    );
  }

  const finalTokens = windowTokens + estimateTokens(anchor ?? "");
  console.log(
    `  [compaction] ${compactionCount} progressive compaction(s); final context ${finalTokens} tok (anchor ${estimateTokens(anchor ?? "")}, tail ${windowTokens})`,
  );

  const parts: string[] = [];
  if (anchor) parts.push(`## Summary of earlier conversation\n\n${anchor}`);
  const tailText = renderConversation(window);
  if (tailText) parts.push(tailText);
  return parts.join("\n\n---\n\n");
}

// ---------------------------------------------------------------------------
// Baseline 3: Raw Context
// ---------------------------------------------------------------------------

/**
 * Full conversation with no compression.
 * Only viable when the conversation fits in context.
 */
export function rawBaseline(turns: ConversationTurn[]): string {
  return renderConversation(turns);
}

// ---------------------------------------------------------------------------
// Ablation config builders (for gateway-based baselines)
// ---------------------------------------------------------------------------

/**
 * Lore config overrides for context-only ablation.
 * Disables knowledge/LTM/curator while keeping gradient + distillation.
 */
export function contextOnlyConfigOverrides(): Record<string, unknown> {
  return {
    knowledge: { enabled: false },
    curator: { enabled: false },
  };
}

/**
 * Lore config overrides for memory-only ablation.
 * Keeps LTM/recall/curator but disables gradient compression.
 * The distilled prefix budget is zeroed so distillations are stored
 * (for recall search) but never injected into the context window.
 */
export function memoryOnlyConfigOverrides(): Record<string, unknown> {
  return {
    budget: {
      distilled: 0,
      raw: 0.95,
    },
  };
}

// ---------------------------------------------------------------------------
// Context builder for question-answering
// ---------------------------------------------------------------------------

/**
 * Build a question-answering prompt from a context string.
 * Used by all baselines to ask eval questions.
 */
export function buildQAPrompt(
  context: string,
  question: string,
  _mode: "baseline" | "lore",
): string {
  return (
    `Here is context from a past coding session.\n\n${context}\n\n` +
    `Question: ${question}\n\n` +
    `Answer concisely and specifically. Include exact values, file paths, and names when known.`
  );
}

export const QA_SYSTEM =
  "You are answering questions about past coding sessions. " +
  "Do your best to come up with the exact and correct answer. " +
  "Use all the tools available to you to find it. " +
  "Be specific and factual — include exact file paths, error messages, " +
  "version numbers, and names when known. " +
  "If you don't have enough information, say so.";
