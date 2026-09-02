/**
 * Detection of Claude Code "side-channel" requests.
 *
 * Claude Code issues several auxiliary API calls that are NOT conversation
 * turns: the auto-mode permission classifier (one call per tool action),
 * conversation title/topic generation, and subagent naming/summary. These are
 * built with `skipSystemPromptPrefix: true`, so they carry NEITHER the coding
 * system prompt (no "Working directory:" line, no CLAUDE.md content) NOR —
 * since Claude Code 2.1.258, where the classifier request is built with
 * `forceAttributionHeader: true` — is the anchored OAuth billing header a
 * reliable discriminator: the classifier now DOES carry it at `system[0]`.
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
 *   1. a `Working directory:` marker line — Claude Code always embeds it in its
 *      coding system prompt (including for subagent turns), for any OS; or
 *   2. an AUTHORITATIVE workspace inference (a `cwd` field or a
 *      CLAUDE/AGENTS/.lore.md path), a broader heuristic than signal 1.
 *
 * The signals are OR-combined so a real turn is recognized on any platform
 * (signal 1 does not require a POSIX-style path). A side-channel call carries
 * none of these.
 *
 * NOTE: the anchored OAuth billing header is deliberately NOT a signal here.
 * Since Claude Code 2.1.258 the auto-mode permission classifier is built with
 * `forceAttributionHeader: true`, so it carries the billing header at
 * `system[0]` even though it is a `skipSystemPromptPrefix` side-channel call
 * (it never embeds the coding prompt, so signals 1 and 2 are still absent).
 * Treating the header as sufficient would demote the classifier out of the
 * bypass and corrupt its verdict. A real coding turn always carries the
 * `Working directory:` marker regardless, so dropping the header signal never
 * mis-classifies a real turn — it only ever widens the bypass to
 * side-channels that now carry `forceAttributionHeader`, which is correct.
 */
export function hasClaudeCodeCodingPrompt(system: string): boolean {
  if (CLAUDE_CODE_CWD_MARKER_RE.test(system)) return true;
  return inferProjectPathDetailed(system)?.authoritative === true;
}

/**
 * True when a request is a Claude Code side-channel / auxiliary call that must
 * be forwarded upstream untouched.
 *
 * Conservative by construction: it bypasses ONLY requests that (a) originate
 * from Claude Code (carry `x-claude-code-session-id`) AND (b) lack the coding
 * system prompt (no `Working directory:` marker, no authoritative workspace
 * inference). A real coding turn carries the marker on every platform, so it is
 * never mis-classified as a side-channel. Conversely, a side-channel that
 * somehow embedded a coding-prompt signal would merely fall through to the
 * normal pipeline — a safe (memory-only) miss, never a broken conversation.
 */
export function isClaudeCodeSideChannel(req: GatewayRequest): boolean {
  if (!isClaudeCodeClient(req.rawHeaders)) return false;
  return !hasClaudeCodeCodingPrompt(req.system);
}
