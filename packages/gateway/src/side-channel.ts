/**
 * Detection of Claude Code "side-channel" requests.
 *
 * Claude Code issues several auxiliary API calls that are NOT conversation
 * turns: the auto-mode permission classifier (one call per tool action),
 * conversation title/topic generation, and subagent naming/summary. These are
 * built with `skipSystemPromptPrefix: true`, so they lack workspace markers
 * in the system prompt. Since Claude Code 2.1.258, the classifier can carry
 * an OAuth billing header at `system[0]` via `forceAttributionHeader: true`;
 * that header is not a reliable discriminator.
 * All of these calls still carry the SAME `x-claude-code-session-id` header as
 * the live coding conversation (Claude Code attaches it to every request).
 *
 * Running these through Lore's context pipeline is harmful:
 *   - LTM system blocks + the distilled conversation prefix get injected, and
 *     gradient compression / tool-output stripping rewrites the messages,
 *     corrupting the request's carefully-scoped prompt; and
 *   - because they share the live session id and carry few messages, Lore's
 *     structural-compaction detector mis-routes them to `handleCompaction`,
 *     which returns a distilled SUMMARY instead of the expected response.
 *
 * For the auto-mode classifier this produces an unparseable / wrong verdict.
 * After 3 consecutive bad verdicts Claude Code drops auto mode back to
 * prompting for every action — the "auto mode asks for everything behind the
 * Lore proxy" symptom. The fix is to forward these requests upstream without
 * any Lore processing (`handlePassthrough`), never touching session state or
 * memory.
 */
import {
  ProjectPathConflictError,
  extractProjectHeader,
  getProjectPath,
  inferClaudeCodeReminderProjectPath,
  inferProjectPathDetailed,
  type ProjectPathResult,
} from "./config";
import { isClaudeCodeClient } from "./session";
import type { GatewayRequest } from "./translate/types";

/**
 * Older Claude Code coding system prompts contain a `Working directory:` line.
 * Match the LABEL only — not the path — to recognize a turn regardless of
 * path format, including a Windows `Working directory: C:\Users\…` that the POSIX-oriented
 * `inferProjectPathDetailed` heuristic does not treat as authoritative. It is
 * absent from every `skipSystemPromptPrefix` side-channel call.
 */
const CLAUDE_CODE_CWD_MARKER_RE = /(?:^|\n)[ \t]*Working directory:[ \t]*\S/i;

// skipSystemPromptPrefix removes Claude Code's coding preamble from auxiliary
// requests. A quoted reminder and a tools array alone cannot identify a turn.
const CLAUDE_CODE_CODING_PREAMBLE_RE =
  /(?:^|\n)[ \t]*You are Claude Code(?:[.,\s]|$)/i;

/**
 * True when the system prompt carries a coding-turn workspace marker.
 *
 * Detected by any signal:
 *   1. a `Working directory:` marker line on older Claude Code versions; or
 *   2. an AUTHORITATIVE workspace inference (a `cwd` field or a
 *      CLAUDE/AGENTS/.lore.md path), a broader heuristic than signal 1.
 *
 * The signals are OR-combined so a real turn is recognized on any platform
 * (signal 1 does not require a POSIX-style path). Claude Code 2.1.289 instead
 * places its workspace marker in the first user's opening system reminder.
 *
 * NOTE: the anchored OAuth billing header is deliberately NOT a signal here.
 * Since Claude Code 2.1.258 the auto-mode permission classifier is built with
 * `forceAttributionHeader: true`, so it carries the billing header at
 * `system[0]` even though it is a `skipSystemPromptPrefix` side-channel call.
 * Treating the header as sufficient would corrupt the classifier verdict.
 */
export function hasClaudeCodeCodingPrompt(system: string): boolean {
  if (CLAUDE_CODE_CWD_MARKER_RE.test(system)) return true;
  return inferProjectPathDetailed(system)?.authoritative === true;
}

/**
 * Only the opening reminder in the first user text block is eligible for
 * workspace inference. Later user text and tool results can quote arbitrary
 * paths and must never bind a session to a different project.
 */
function openingReminder(
  message: GatewayRequest["messages"][number] | undefined,
): string | null {
  const block = message?.role === "user" ? message.content[0] : undefined;
  if (block?.type !== "text") return null;
  const opening = /^\s*<system-reminder>/.exec(block.text);
  if (!opening) return null;
  const end = block.text.indexOf("</system-reminder>", opening[0].length);
  return end === -1 ? null : block.text.slice(opening[0].length, end);
}

function claudeCodeOpeningReminder(req: GatewayRequest): string | null {
  if (req.protocol !== "anthropic" || !isClaudeCodeClient(req.rawHeaders)) {
    return null;
  }
  return openingReminder(req.messages[0]);
}

/** Resolve the same coding-turn marker for routing and project attribution. */
export function getRequestProjectPath(req: GatewayRequest): ProjectPathResult {
  const result = getProjectPath(
    req.system,
    req.rawHeaders,
    claudeCodeOpeningReminder(req),
  );
  if (req.protocol === "anthropic" && isClaudeCodeClient(req.rawHeaders)) {
    // The first reminder can be retained across turns. A later instruction
    // record naming a different project means it no longer identifies the
    // current workspace; reject before reading or storing either project's data.
    for (const message of req.messages.slice(1)) {
      const reminder = openingReminder(message);
      const later = reminder
        ? inferClaudeCodeReminderProjectPath(reminder)
        : null;
      if (later && later.path !== result.path) {
        throw new ProjectPathConflictError();
      }
    }
  }
  return result;
}

/**
 * True when a request is a Claude Code side-channel / auxiliary call that must
 * be forwarded upstream untouched.
 *
 * Bypass requests with neither a system workspace marker nor an authoritative
 * marker in the opening user reminder. Do not use the billing header or an
 * arbitrary quoted path in user text as a coding-turn signal.
 */
export function isClaudeCodeSideChannel(req: GatewayRequest): boolean {
  if (!isClaudeCodeClient(req.rawHeaders)) return false;
  if (hasClaudeCodeCodingPrompt(req.system)) return false;
  // Claude Code's classifier and naming calls do not offer tools. Their first
  // user message can quote an earlier coding reminder, so reminder text alone
  // must never turn a tool-less auxiliary call into a conversation turn.
  if (
    req.protocol !== "anthropic" ||
    req.tools.length === 0 ||
    !CLAUDE_CODE_CODING_PREAMBLE_RE.test(req.system)
  ) {
    return true;
  }
  const reminder = claudeCodeOpeningReminder(req);
  return (
    !reminder ||
    !inferClaudeCodeReminderProjectPath(
      reminder,
      extractProjectHeader(req.rawHeaders),
    )
  );
}
