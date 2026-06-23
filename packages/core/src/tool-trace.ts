/**
 * Structured tool-call execution-trace analysis.
 *
 * Companion to `pattern-extract.ts` — a pure, no-LLM module that turns raw
 * tool-call outcomes (recorded in the `tool_calls` table by `temporal.ts`)
 * into structured signals consumed by four downstream readers:
 *   - the distillation observer (a pinned "tool failures in this segment" block)
 *   - the auto-gotcha post-distillation loop (recurring failures → knowledge)
 *   - the curator (cross-session failure context appended to its prompt)
 *   - recall (a tool-failure section appended to search results)
 *
 * `classifyToolError()` buckets an arbitrary error string into a stable,
 * deterministic type so that the same recurring failure aggregates across
 * sessions regardless of incidental variation (paths, ids, line numbers).
 *
 * Per Lee et al. (2026) "Meta-Harness" (arXiv:2603.28052), access to raw
 * execution traces — not compressed summaries — is the single most important
 * factor for effective harness optimization. This module preserves the
 * diagnostic signal (which tool failed, with what error type) that the
 * lossy `[tool:...]` text serialization in `temporal.ts` discards.
 */

import { db, ensureProject } from "./db";

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/** Maximum length of a stored raw error message (bounded for storage). */
export const MAX_ERROR_MESSAGE_LEN = 500;

type ErrorBucket = { regex: RegExp; type: string };

/**
 * Ordered regex → bucket table. First match wins, so more specific patterns
 * must precede broader ones. All matched against the lowercased first
 * non-empty line of the error string.
 */
const ERROR_BUCKETS: ErrorBucket[] = [
  { regex: /timed? ?out|etimedout/, type: "timeout" },
  {
    regex: /permission denied|eacces|not permitted|operation not permitted/,
    type: "permission",
  },
  // edit_noop must precede the generic not_found bucket — "oldString not
  // found" would otherwise match /not found/ first.
  {
    regex: /oldstring not found|no changes|nothing to|no replacement/,
    type: "edit_noop",
  },
  { regex: /no such file|enoent|does not exist|not found/, type: "not_found" },
  { regex: /already exists|eexist/, type: "already_exists" },
  {
    regex: /connection|econnrefused|econnreset|network|dns|enotfound|socket/,
    type: "network",
  },
  {
    regex: /syntax error|parse error|unexpected token|unexpected end/,
    type: "syntax",
  },
  {
    regex: /type error|is not a function|undefined is not|cannot read propert/,
    type: "type_error",
  },
  {
    regex: /exit code|command failed|non-zero|exited with/,
    type: "command_failed",
  },
  { regex: /abort|cancel|interrupt|sigint|sigterm/, type: "aborted" },
];

/**
 * Bucket an arbitrary tool error into a stable, deterministic type slug.
 *
 * Returns `"unknown"` for an empty error. Curated buckets (see
 * `ERROR_BUCKETS`) return bare slugs (e.g. `"timeout"`); anything else is
 * derived from the first few words of the error, prefixed `other:` so callers
 * can distinguish curated buckets from raw-derived ones.
 */
export function classifyToolError(_tool: string, error: string): string {
  // Cap the working string before regex processing. 1000 chars is generous
  // for classification; anything beyond is noise (full stack traces, binary
  // garbage). The raw error is stored separately in tool_calls.error_message.
  const firstLine = (error ?? "")
    .slice(0, 1000)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstLine) return "unknown";

  const normalized = firstLine.toLowerCase().replace(/\s+/g, " ").trim();
  for (const bucket of ERROR_BUCKETS) {
    if (bucket.regex.test(normalized)) return bucket.type;
  }

  // Fallback: kebab-case the first ≤4 alphabetic words, capped at 40 chars.
  const words = normalized
    .replace(/[^a-z\s]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1)
    .slice(0, 4);
  const slug = words.join("-").slice(0, 40).replace(/-+$/g, "");
  return slug ? `other:${slug}` : "unknown";
}

// ---------------------------------------------------------------------------
// Verifier classification (outcome-reward loop, #497)
// ---------------------------------------------------------------------------

/**
 * Recognizes a test / build / typecheck / lint runner at the START of a command
 * segment. Anchoring to command position (rather than matching the token
 * anywhere) is what makes the verdict high-precision: `pnpm test` matches, but
 * `cat vitest.config.ts`, `vim biome.json`, and `echo 'run mypy'` do NOT — they
 * merely mention a runner. Optional benign prefixes (sudo/env/time/npx/…) are
 * skipped so `npx vitest` / `sudo pnpm test` still match. A non-match means "not
 * a verifier" (no signal), the safe default for a confidence-adjusting loop.
 */
const VERIFIER_LEADING = new RegExp(
  // Optional leading prefixes that precede the real command. The package-manager
  // prefix (with an optional run/exec/dlx verb) lets the bare-runner branch fire
  // on `pnpm exec biome`, `pnpm vitest`, `npx vitest`, etc. — while `pnpm install`
  // / `pnpm add vitest` stay non-matches because the runner is not at the head of
  // what remains after the prefix.
  String.raw`^\s*(?:(?:sudo|time|npx|bunx)\s+|\w+=\S+\s+|env\s+|(?:npm|pnpm|yarn|bun)\s+(?:run\s+|exec\s+|dlx\s+)?)*` +
    "(?:" +
    [
      // package-manager verify scripts: pnpm test, yarn coverage, npm run e2e, ...
      String.raw`(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|typecheck|type-check|lint|tsc|check|verify|validate|e2e|spec|coverage)\b`,
      // `ci` ONLY with an explicit `run` — bare `npm ci` is a clean dependency
      // INSTALL (fails on network/registry/lockfile, unrelated to code), so it
      // must never be counted as a verifier.
      String.raw`(?:npm|pnpm|yarn|bun)\s+run\s+ci\b`,
      // direct test runners
      String.raw`(?:vitest|jest|mocha|ava|pytest|rspec|phpunit|gotestsum|tox|nox|ctest|pre-commit)\b`,
      // language / build toolchains with a verify subcommand
      String.raw`(?:go|cargo|gradle|mvn|dotnet|swift)\s+(?:test|build|check)\b`,
      String.raw`deno\s+(?:test|check|lint)\b`,
      // task runners invoked with a verify target (NOT `make run` / bare `make`)
      String.raw`(?:make|just|task)\s+(?:test|build|lint|check|typecheck|type-check|ci|verify|validate|e2e|spec|coverage)\b`,
      String.raw`rake\s+(?:test|spec)\b`,
      String.raw`bazel\s+(?:test|build)\b`,
      // typecheck / compile
      String.raw`(?:tsc|tsgo)\b`,
      // linters / formatters used as gates
      String.raw`(?:eslint|biome|ruff|flake8|mypy|clippy|golangci-lint)\b`,
    ].join("|") +
    ")",
  "i",
);

/**
 * Best-effort extraction of a shell command string from a tool call's `input`
 * (host-shaped, hence `unknown`). Handles the common bash shape
 * (`{ command: string }` / `{ cmd: string }`) and a bare string; returns null
 * when no command is recoverable (the call is then treated as a non-verifier).
 */
export function extractCommand(input: unknown): string | null {
  if (typeof input === "string") return input;
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    if (typeof o.command === "string") return o.command;
    if (typeof o.cmd === "string") return o.cmd;
  }
  return null;
}

/**
 * True when a tool call's `input` invokes a recognized verifier. The command is
 * split into segments on the shell chaining/pipe operators (`&&`, `||`, `;`,
 * `|`, newline) and a segment counts only when a runner leads it — so
 * `cd pkg && pnpm test` matches (2nd segment) while `cat vitest.config.ts` and
 * `grep biome .` do not.
 */
export function isVerifierCall(input: unknown): boolean {
  const cmd = extractCommand(input);
  if (!cmd) return false;
  // Bound the work before regex (mirrors classifyToolError). A verifier
  // invocation leads a command segment, so it lives near the start; the cap is
  // defense-in-depth against a pathological multi-KB command on this
  // request-adjacent path. Truncation can only drop a match (safe direction).
  return cmd
    .slice(0, 4000)
    .split(/&&|\|\||[;\n|]/)
    .some((segment) => VERIFIER_LEADING.test(segment));
}

export type SessionVerifierVerdict = "pass" | "fail" | "none";

/**
 * Derive a session's verifier verdict from its recorded tool calls:
 *  - `fail` if ANY verifier call errored (status='error'); a failing verifier is
 *    a decisive negative signal regardless of later passes.
 *  - `pass` if ≥1 verifier call completed and none errored.
 *  - `none` if the session ran no verifier calls — no outcome signal.
 *
 * Only `verifier = 1` calls count, so incidental command failures (a missing
 * file, a `grep` miss) never move knowledge confidence.
 */
export function sessionVerifierVerdict(
  projectPath: string,
  sessionID: string,
): SessionVerifierVerdict {
  const pid = ensureProject(projectPath);
  const row = db()
    .query(
      `SELECT
         SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS fails,
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS passes
       FROM tool_calls
       WHERE project_id = ? AND session_id = ? AND verifier = 1`,
    )
    .get(pid, sessionID) as { fails: number | null; passes: number | null };
  if ((row?.fails ?? 0) > 0) return "fail";
  if ((row?.passes ?? 0) > 0) return "pass";
  return "none";
}

// ---------------------------------------------------------------------------
// Aggregation accessors
// ---------------------------------------------------------------------------

export type ToolFailureStat = {
  tool: string;
  error_type: string | null;
  /** Total failures matching (tool, error_type) across the project. */
  failure_count: number;
  /** Distinct sessions in which this (tool, error_type) failed. */
  session_count: number;
  /** A representative raw error message (may be null). */
  sample_message: string | null;
};

/**
 * Per-tool failure aggregation across all sessions in a project, grouped by
 * `(tool, error_type)`. Used by the curator context and the auto-gotcha loop.
 */
export function toolFailureStats(
  projectPath: string,
  opts?: { minSessions?: number; excludeSessionID?: string },
): ToolFailureStat[] {
  const pid = ensureProject(projectPath);
  const minSessions = opts?.minSessions ?? 1;
  const exclude = opts?.excludeSessionID ?? null;
  return db()
    .query(
      `SELECT tool, error_type,
              COUNT(*) AS failure_count,
              COUNT(DISTINCT session_id) AS session_count,
              MAX(error_message) AS sample_message
       FROM tool_calls
       WHERE project_id = ? AND status = 'error'
         AND (? IS NULL OR session_id <> ?)
       GROUP BY tool, error_type
       HAVING session_count >= ?
       ORDER BY session_count DESC, failure_count DESC`,
    )
    .all(pid, exclude, exclude, minSessions) as ToolFailureStat[];
}

export type RecentToolFailure = {
  tool: string;
  error_type: string | null;
  error_message: string | null;
  created_at: number;
};

/**
 * Recent failures within a single session. Used by the distillation observer
 * pinned block (scoped to the current segment's time window) and recall's
 * session-scoped tool-failure section.
 */
export function recentSessionFailures(
  projectPath: string,
  sessionID: string,
  opts?: { limit?: number; sinceMs?: number },
): RecentToolFailure[] {
  const pid = ensureProject(projectPath);
  const limit = opts?.limit ?? 10;
  const since = opts?.sinceMs ?? 0;
  return db()
    .query(
      `SELECT tool, error_type, error_message, created_at
       FROM tool_calls
       WHERE project_id = ? AND session_id = ? AND status = 'error'
         AND created_at >= ?
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(pid, sessionID, since, limit) as RecentToolFailure[];
}

// ---------------------------------------------------------------------------
// Knowledge-entry text helpers (auto-gotcha)
// ---------------------------------------------------------------------------

/**
 * Deterministic gotcha title for a recurring tool failure. Stable wording so
 * `ltm.create()`'s title-based dedup guard collapses repeats across distills.
 */
export function toolGotchaTitle(
  tool: string,
  errorType: string | null,
): string {
  return `Recurring ${tool} failure: ${errorType ?? "unknown error"}`;
}

/** Maximum length for a knowledge entry's content field (chars). */
const MAX_ENTRY_CONTENT_LENGTH = 1200;

/** Body text for an auto-created tool-failure gotcha entry (capped at 1200 chars). */
export function toolGotchaContent(stat: ToolFailureStat): string {
  const sample = stat.sample_message
    ? ` Sample error: ${stat.sample_message.slice(0, 200)}.`
    : "";
  const raw =
    `The \`${stat.tool}\` tool repeatedly failed with "${stat.error_type ?? "unknown error"}" ` +
    `across ${stat.session_count} sessions (${stat.failure_count} total failures).${sample} ` +
    `Investigate the root cause — this is a recurring obstacle in this project.`;
  return raw.length > MAX_ENTRY_CONTENT_LENGTH
    ? raw.slice(0, MAX_ENTRY_CONTENT_LENGTH)
    : raw;
}

// ---------------------------------------------------------------------------
// Recall surfacing
// ---------------------------------------------------------------------------

/**
 * Render a markdown tool-failure section for recall results, or `""` when
 * there are no failures. Session-scoped when `sessionID` is provided
 * (recent failures in this session), otherwise project-wide recurring ones.
 */
export function formatToolFailureSection(
  projectPath: string,
  sessionID?: string,
): string {
  if (sessionID) {
    const rows = recentSessionFailures(projectPath, sessionID, { limit: 5 });
    if (!rows.length) return "";
    const lines = rows.map((r) => `- ${r.tool} → ${r.error_type ?? "unknown"}`);
    return `### Tool Failures (this session)\n${lines.join("\n")}`;
  }
  const stats = toolFailureStats(projectPath, { minSessions: 1 }).slice(0, 5);
  if (!stats.length) return "";
  const lines = stats.map(
    (s) =>
      `- ${s.tool} → ${s.error_type ?? "unknown"} (${s.failure_count}× across ${s.session_count} sessions)`,
  );
  return `### Recurring Tool Failures\n${lines.join("\n")}`;
}
