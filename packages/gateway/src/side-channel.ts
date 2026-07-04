/**
 * Detection of Claude Code "side-channel" requests.
 *
 * Claude Code issues several auxiliary API calls that are NOT conversation
 * turns: the auto-mode permission classifier (one call per tool action),
 * conversation title/topic generation, and subagent naming/summary. These are
 * built with `skipSystemPromptPrefix: true`, so they carry NEITHER the coding
 * system prompt (no "Working directory:" line, no CLAUDE.md content) NOR the
 * anchored OAuth billing header — yet they still carry the SAME
 * `x-claude-code-session-id` header as the live coding conversation (Claude
 * Code attaches it to every request).
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
import { hasBillingHeader } from "./cch";
import { inferProjectPathDetailed } from "./config";
import { isClaudeCodeClient } from "./session";
import type { GatewayRequest } from "./translate/types";

/**
 * Claude Code's coding system prompt always contains a `Working directory:`
 * line (verified in the 2.1.x binary). We match the LABEL only — not the path —
 * so it recognizes a coding turn regardless of the path format, including a
 * Windows `Working directory: C:\Users\…` that the POSIX-oriented
 * `inferProjectPathDetailed` heuristic does not treat as authoritative. It is
 * absent from every `skipSystemPromptPrefix` side-channel call.
 */
const CLAUDE_CODE_CWD_MARKER_RE = /(?:^|\n)[ \t]*Working directory:[ \t]*\S/i;

/**
 * True when a system prompt carries the Claude Code CODING prompt — i.e. it
 * belongs to a real conversation turn (the main session OR a subagent), not a
 * side-channel call.
 *
 * Detected by any signal:
 *   1. the anchored OAuth billing header (present whenever
 *      `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1`, which both `lore run` and
 *      `lore setup` set — the standard Lore configuration); or
 *   2. a `Working directory:` marker line — Claude Code always embeds it in its
 *      coding system prompt (including for subagent turns), for any OS; or
 *   3. an AUTHORITATIVE workspace inference (a `cwd` field or a
 *      CLAUDE/AGENTS/.lore.md path), a broader heuristic than signal 2.
 *
 * The signals are OR-combined so a real turn is recognized even in a manual
 * setup that omits the first-party env var (no billing header), on any platform
 * (signal 2 does not require a POSIX-style path). A side-channel call carries
 * none of these.
 */
export function hasClaudeCodeCodingPrompt(system: string): boolean {
  if (hasBillingHeader(system)) return true;
  if (CLAUDE_CODE_CWD_MARKER_RE.test(system)) return true;
  return inferProjectPathDetailed(system)?.authoritative === true;
}

/**
 * True when a request is a Claude Code side-channel / auxiliary call that must
 * be forwarded upstream untouched.
 *
 * Conservative by construction: it bypasses ONLY requests that (a) originate
 * from Claude Code (carry `x-claude-code-session-id`) AND (b) lack the coding
 * system prompt (no billing header, no `Working directory:` marker, no
 * authoritative workspace inference). A real coding turn carries the marker on
 * every platform, so it is never mis-classified as a side-channel. Conversely,
 * a side-channel that somehow embedded a coding-prompt signal would merely fall
 * through to the normal pipeline — a safe (memory-only) miss, never a broken
 * conversation.
 */
export function isClaudeCodeSideChannel(req: GatewayRequest): boolean {
  if (!isClaudeCodeClient(req.rawHeaders)) return false;
  return !hasClaudeCodeCodingPrompt(req.system);
}
