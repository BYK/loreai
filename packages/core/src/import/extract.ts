/**
 * Knowledge extraction from imported conversations.
 *
 * Takes conversation chunks and feeds them to the curator LLM to extract
 * knowledge entries directly, without going through the temporal → distill
 * pipeline. This is cheaper and faster than full-pipeline import.
 */
import * as ltm from "../ltm";
import { parseOps, applyOps } from "../curator";
import { CURATOR_SYSTEM, curatorUser } from "../prompt";
import type { LLMClient } from "../types";
import type { ConversationChunk } from "./types";

/**
 * Max length of `lastError` in `ExtractionResult`. Keeps diagnostic output
 * bounded when a per-chunk throw produces a verbose HTTP body (e.g. an
 * openrouter 400 with a 5KB JSON response). Truncated errors end with "…".
 */
const MAX_ERROR_LENGTH = 400;

/**
 * System prompt for import extraction.
 * Extends the standard curator prompt with guidance for historical conversations.
 */
const IMPORT_CURATOR_SYSTEM = `${CURATOR_SYSTEM}

ADDITIONAL CONTEXT: You are extracting knowledge from HISTORICAL conversations with a different AI coding agent. Focus on durable insights that are still relevant:
- Architecture decisions, design patterns, and project conventions
- Gotchas, non-obvious bugs, and their fixes
- Developer preferences and workflow patterns
- Key technical choices and their rationale

Ignore:
- References to the other agent's specific capabilities or limitations
- Task-specific state that is no longer current (e.g. "currently debugging X")
- Debugging steps for issues that were already resolved
- Transient conversation artifacts (greetings, acknowledgments, status updates)`;

export type ExtractionProgress = {
  /** Current chunk being processed (1-based) */
  current: number;
  /** Total chunks to process */
  total: number;
  /** Knowledge entries created so far */
  created: number;
  /** Knowledge entries updated (dedup hit) so far */
  updated: number;
};

export type ExtractionResult = {
  /** Total knowledge entries created */
  created: number;
  /** Total entries that hit dedup (updated existing) */
  updated: number;
  /** Total entries deleted */
  deleted: number;
  /** Chunks processed successfully */
  chunksProcessed: number;
  /** Chunks that failed (LLM error) */
  chunksFailed: number;
  /**
   * Chunks for which the LLM actually returned a response (non-null). A no-auth
   * call returns null WITHOUT throwing, so it counts as neither processed-error
   * nor answered. Callers use this to distinguish "the model answered but found
   * nothing worth keeping" (safe to mark the source imported) from "the model
   * never answered — auth/capability failure" (do NOT mark imported, so a later
   * run retries). `chunksAnswered === 0` on a non-empty chunk set means the
   * extraction never authenticated / never ran for real.
   */
  chunksAnswered: number;
  /**
   * True when the loop terminated EARLY after a chunk's LLM call returned null
   * AND a recent worker failure was attributed to an upstream auth rejection
   * (HTTP 401/403). The intact credential-burn path here would have processed
   * every remaining chunk with the same broken key — N doomed requests + N
   * Sentry captures for a 71-chunk import. Aborting lets the caller surface an
   * actionable "your credential is invalid" error instead of the generic
   * "no response from the model" message.
   *
   * Implies `chunksAnswered === 0`. Always false on the empty-chunks fast-path
   * (we never even start the loop in that case). Distinct from `chunksFailed`:
   * abortedByAuth means we CHOSE to stop, not that every chunk happened to fail.
   */
  abortedByAuth: boolean;
  /**
   * First non-abort error from the loop (the per-chunk try/catch swallows
   * errors to keep the loop running; the first one is preserved here so the
   * chain's diagnostic can surface it). undefined when every chunk succeeded
   * (chunksAnswered === chunks.length) or the loop never started (empty
   * chunks). Truncated to MAX_ERROR_LENGTH chars to keep diagnostic output
   * bounded.
   *
   * Adm (Slack 2026-07-30) hit this with openrouter — the loop threw on
   * every chunk but the diagnostic said only "openrouter did not answer"
   * with zero detail.
   */
  lastError?: string;
};

/**
 * Extract knowledge entries from conversation chunks via the curator LLM.
 *
 * Processes chunks sequentially (not parallel) to avoid rate limits
 * and to let later chunks see entries created by earlier chunks
 * (better dedup via the existing entries list in the prompt).
 */
export async function extractKnowledge(input: {
  llm: LLMClient;
  projectPath: string;
  chunks: ConversationChunk[];
  sessionID?: string;
  model?: { providerID: string; modelID: string };
  onProgress?: (progress: ExtractionProgress) => void;
  /**
   * Optional peek provided by the gateway-side caller. Returns true when a
   * recent worker call (within this import run) was rejected by the upstream
   * as auth-failed (HTTP 401/403). When `llm.prompt` returns null AND the
   * peek reports true, the loop aborts immediately and the result's
   * `abortedByAuth` is set — burning 70 more chunks with the same broken key
   * is worse than unhelpful (it's expensive, alerts Sentry, and replaces a
   * clean actionable error with a hostile log storm). Core can't peek
   * worker-health itself (cross-package), so the gateway injects this.
   *
   * Defaults to a permissive always-false probe when omitted — preserves the
   * existing behavior for callers that don't care (e.g. tests of the chunk
   * loop in isolation).
   */
  wasRecentChunkAuthRejected?: () => boolean;
}): Promise<ExtractionResult> {
  const result: ExtractionResult = {
    created: 0,
    updated: 0,
    deleted: 0,
    chunksProcessed: 0,
    chunksFailed: 0,
    chunksAnswered: 0,
    abortedByAuth: false,
    lastError: undefined,
  };

  if (input.chunks.length === 0) {
    return result;
  }

  // Sort chunks chronologically so knowledge builds up naturally
  const sorted = [...input.chunks].sort((a, b) => a.timestamp - b.timestamp);

  // Default probe: when the gateway doesn't inject one, NEVER trip the
  // auth-abort. This keeps the existing semantics for tests and for any
  // future caller that doesn't track worker failures.
  const probeAuth = input.wasRecentChunkAuthRejected ?? (() => false);

  for (let i = 0; i < sorted.length; i++) {
    const chunk = sorted[i];

    // Get existing entries (refreshed each iteration for dedup)
    const existing = ltm.forProject(input.projectPath, false);
    const existingForPrompt = existing.map((e) => ({
      id: e.id,
      category: e.category,
      title: e.title,
      content: e.content,
    }));

    const userContent = curatorUser({
      messages: chunk.text,
      existing: existingForPrompt,
    });

    try {
      const response = await input.llm.prompt(
        IMPORT_CURATOR_SYSTEM,
        userContent,
        {
          model: input.model,
          workerID: "lore-import",
          thinking: false,
          maxTokens: 4096,
          sessionID: input.sessionID,
          temperature: 0,
        },
      );

      if (response) {
        result.chunksAnswered++;
        const ops = parseOps(response);
        const applied = applyOps(ops, {
          projectPath: input.projectPath,
          sessionID: input.sessionID,
        });
        result.created += applied.created;
        result.updated += applied.updated;
        result.deleted += applied.deleted;
      } else if (probeAuth()) {
        // `llm.prompt` returned null AND we just learned the upstream said
        // 401. The remaining chunks will hit the same broken credential —
        // stop here, attribute the abort to auth, and let the caller surface
        // an actionable fix rather than a 70-line hostile log. Note we still
        // call `onProgress` below with the partial total so the CLI's spinner
        // can clear cleanly instead of leaving the \r in place.
        result.abortedByAuth = true;
        result.chunksFailed++;
        result.chunksProcessed++;
        input.onProgress?.({
          current: i + 1,
          total: sorted.length,
          created: result.created,
          updated: result.updated,
        });
        return result;
      }

      result.chunksProcessed++;
    } catch (e) {
      result.chunksFailed++;
      // Preserve the FIRST error so the chain's "no-response" diagnostic
      // can surface it. Subsequent identical failures are folded into a
      // count in the surface message. Truncate to keep diagnostic output
      // bounded (a 304-chunk import with a verbose HTTP body would otherwise
      // produce an unreadable error).
      if (result.lastError === undefined) {
        const msg = e instanceof Error ? e.message : String(e);
        result.lastError =
          msg.length > MAX_ERROR_LENGTH
            ? msg.slice(0, MAX_ERROR_LENGTH) + "…"
            : msg;
      }
    }

    input.onProgress?.({
      current: i + 1,
      total: sorted.length,
      created: result.created,
      updated: result.updated,
    });
  }

  return result;
}
