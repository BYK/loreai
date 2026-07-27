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
import { parse as parseBash } from "unbash";

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
 * `cat vitest.config.ts`, `vim .oxlintrc.json`, and `echo 'run mypy'` do NOT — they
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
      String.raw`(?:eslint|oxlint|oxfmt|biome|ruff|flake8|mypy|clippy|golangci-lint)\b`,
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

// A path-like token: one or more slash-separated segments ending in a
// dotted extension of 1-5 chars (e.g. `src/auth/jwt.ts`, `db.ts` won't match
// without a slash — the plain-text fallback needs at least one dir segment to
// avoid grabbing prose words). Used only as a fallback when the input isn't
// structured JSON.
const PATH_FALLBACK_RE = /(?:[\w.-]+\/)+[\w.-]+\.\w{1,5}/;

// ReDoS mitigation. The plain-text fallback runs on a RAW string input — which
// happens when a tool call's arguments failed to JSON-parse (streaming
// truncation / malformed blob) and the host stored the raw string in
// `state.input`. PATH_FALLBACK_RE's nested quantifiers backtrack super-linearly
// on a long run of slash-separated tokens with no matching extension (measured
// ~8s on a crafted 64KB `a/a/a/…` blob — a 64KB slice cap alone does NOT help,
// since the whole blob is one pathological token). recordToolCalls runs
// synchronously inside a SQLite savepoint on the hot request path, so an
// unguarded match would stall the event loop AND hold the write lock. Defenses,
// all O(n): (1) skip when there is no `/` at all; (2) scan only the first few KB
// (a real path appears early and is short); (3) split on whitespace and only run
// the regex on individual short tokens — a pathological no-whitespace blob is
// one giant token that exceeds PATH_TOKEN_MAX and is skipped, so the backtracking
// regex never sees adversarial input. A real path is a short, whitespace-bounded
// token, so this never drops a legitimate match.
const PATH_SCAN_LIMIT = 8192;
const PATH_TOKEN_MAX = 260; // generous vs the 255-char component limit on most FSes

// Commands whose positional arguments are file paths. We don't try to be
// comprehensive — `cat`, `tee`, `cp`, `mv`, `rm`, `head`, `tail`, `less`,
// `more`, `wc`, `stat`, `file`, `touch`, `chmod`, `chown`, `mkdir`, `rmdir`,
// `dirname`, `basename`, `realpath`, `readlink`, `source`, `.` cover the vast
// majority of agent bash that touches files. Deliberately excluded:
//   - `sed`, `awk`, `gawk`: their first non-flag arg is a SCRIPT (e.g.
//     `sed 's/x/y/' file`), not a file. Distinguishing the script from the
//     file operand requires a per-tool option table we don't have — missing
//     these is the safe direction.
//   - `grep`, `egrep`, `fgrep`, `rg`: their first non-flag arg is a PATTERN
//     (e.g. `grep foo file`), not a file. Same trade-off.
//   - `[`, `test`: builtin test expression; argument shape varies (`[ -f file ]`
//     vs `[ file1 -ef file2 ]`).
// For unknown commands, redirect targets (handled below) still surface the
// touched files. This is provenance-only and best-effort — a miss is always
// safe.
const FILE_OPERAND_COMMANDS = new Set([
  "cat",
  "tee",
  "cp",
  "mv",
  "rm",
  "ln",
  "install",
  "head",
  "tail",
  "less",
  "more",
  "wc",
  "stat",
  "file",
  "touch",
  "chmod",
  "chown",
  "mkdir",
  "rmdir",
  "dirname",
  "basename",
  "realpath",
  "readlink",
  "source",
  ".",
]);

/**
 * Heuristic: is a Word a literal-or-quoted (no expansion) single token safe to
 * treat as a file path? unbash breaks words into `parts` (Literal, SingleQuoted,
 * CommandExpansion, ParameterExpansion, etc.). A word containing expansions
 * (`$1`, `$(cmd)`, `~`, `${var}`) cannot be resolved to a file path statically,
 * so we skip it. This bounds the AST walk to safely-extractable operands.
 */
function isStaticLiteralWord(word: {
  text: string;
  value: string;
  parts?: ReadonlyArray<{ type: string }>;
}): boolean {
  if (word.text.length === 0 || word.text.length > PATH_TOKEN_MAX) return false;
  if (/\s/.test(word.text)) return false;
  // Tilde is a runtime expansion (home directory) even though unbash doesn't
  // tag it with a part type — skip it.
  if (word.text.startsWith("~")) return false;
  // Glob metacharacters are runtime expansions of the shell. unbash does NOT
  // tag them with a part type (it doesn't model pathname expansion), so the
  // `parts: undefined` lazy-getter fallback below would otherwise treat a
  // `src/*.ts` literal as a static path-shaped token and surface it as a
  // touched file. Reject up front.
  if (/[*?[\]]/.test(word.text)) return false;
  if (!word.parts || word.parts.length === 0) return true; // unbash lazy getter; fall back to text
  for (const p of word.parts) {
    // The runtime type discriminator is "SingleQuoted" (the interface name
    // SingleQuotedPart is just the TS name for the same shape; verify
    // unbash/types.d.ts). Any other part type — CommandExpansion,
    // ParameterExpansion, ArithmeticExpansion, ProcessSubstitution — is a
    // runtime expansion we cannot resolve.
    if (p.type === "Literal" || p.type === "SingleQuoted") continue;
    // DoubleQuoted is a wrapper around a child-part list. Accept iff every
    // child is a literal (no `$VAR`, `$(…)`, `${…}`). This makes
    // `cat "src/a.ts"` work (purely literal double-quoted path) while still
    // rejecting `cat "$HOME/src/a.ts"` (SimpleExpansion inside).
    if (p.type === "DoubleQuoted") {
      const inner = (p as { parts?: ReadonlyArray<{ type: string }> }).parts;
      if (!inner || inner.length === 0) continue;
      if (inner.every((c) => c.type === "Literal")) continue;
      return false;
    }
    return false;
  }
  return true;
}

function cleanPathToken(s: string): string | undefined {
  // For the AST walk we want SOME shape constraint so a literal word like
  // "foo" (a pattern, a variable name, a flag value) isn't mistaken for a
  // touched file. We accept: anything with a `/` (definite path), or a
  // bare name with a dotted extension like `db.ts` / `out.log` (looks like
  // a file). Words with no slash and no extension are not path-like.
  // The plaintext regex fallback (PATH_FALLBACK_RE) is a separate concern —
  // there we keep the strict slash requirement (prose risk).
  if (s.length === 0 || s.length > PATH_TOKEN_MAX || /\s/.test(s)) {
    return undefined;
  }
  if (s.includes("/")) return s;
  // Bare name with a dotted extension of 1-5 trailing letters.
  if (/^[^.]+\.[A-Za-z]{1,5}$/.test(s)) return s;
  return undefined;
}

/**
 * Best-effort extraction of the source-file paths a tool call acted on, from a
 * bash command string. Uses `unbash` (webpro-nl/unbash, zero-dep, tolerant
 * parser) to walk the AST. Returns the union of:
 *
 *   1. **Redirect targets** for file-touching operators (`>`, `>>`, `<`, `<>`,
 *      `>|`, `>&`, `>>`-family, `<&`). A command like `echo x > out.ts` touches
 *      `out.ts` even though `out.ts` is not a positional operand.
 *   2. **Positional operands** of commands in FILE_OPERAND_COMMANDS
 *      (`cat`, `sed`, `awk`, `grep`, `tee`, `cp`, `mv`, …) that look like paths
 *      (non-empty, contain a `/`, no whitespace, within PATH_TOKEN_MAX).
 *
 * Words containing parameter/command/arithmetic expansions (`$1`, `$(cmd)`, `~`,
 * `${var}`) are skipped — we can't statically resolve them. The result is
 * de-duplicated while preserving first-seen order.
 *
 * This is **provenance only** — best-effort, never load-bearing, so a miss is
 * always safe.
 */
export function extractFilePathsFromCommand(cmd: string): string[] {
  if (typeof cmd !== "string" || cmd.length === 0) return [];
  // Bound the input — a pathological multi-KB command shouldn't traverse the
  // AST for ages on the request path. Truncation can only drop matches
  // (safe direction).
  const slice = cmd.slice(0, PATH_SCAN_LIMIT);
  let ast: ReturnType<typeof parseBash>;
  try {
    ast = parseBash(slice);
  } catch {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string | undefined) => {
    const clean = cleanPathToken(raw ?? "");
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  };

  // Walk every command node reachable in the AST, surfacing redirect targets
  // and file-operand positional args. unbash models control flow as nested
  // commands inside If/While/For/Subshell/etc., so a generic visit collects
  // every reachable Command node without bespoke per-construct handling.
  // We also surface `redirects` at every node level — unbash carries
  // trailing redirects on the OUTER node, not on the inner Command, for
  // compound constructs like `(cat a) > out.ts`, `for … done > out.ts`,
  // `if … fi > out.ts`, and `function foo { … } > log`.
  const FILE_TOUCHING_REDIRECT_OPS = new Set([
    ">",
    ">>",
    "<",
    "<>",
    ">|",
    ">&",
    "<&",
    // bash 4+ "redirect stdout AND stderr to file" shorthand, equivalent to
    // `> file 2>&1`. Common in modern scripts and CI configs.
    "&>",
    "&>>",
  ]);
  const processRedirects = (
    redirects:
      | ReadonlyArray<{
          operator: string;
          target?: {
            text: string;
            value: string;
            parts?: ReadonlyArray<{ type: string }>;
          };
        }>
      | undefined,
  ): void => {
    if (!redirects) return;
    for (const r of redirects) {
      // Heredoc (`<<`, `<<-`) and herestring (`<<<`) targets are delimiters
      // or inline content, NOT file paths.
      if (!FILE_TOUCHING_REDIRECT_OPS.has(r.operator)) continue;
      if (r.target && isStaticLiteralWord(r.target)) push(r.target.value);
    }
  };
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const n = node as {
      type?: string;
      // Command fields:
      name?: {
        text: string;
        value: string;
        parts?: ReadonlyArray<{ type: string }>;
      };
      suffix?: ReadonlyArray<{
        text: string;
        value: string;
        parts?: ReadonlyArray<{ type: string }>;
      }>;
      redirects?: ReadonlyArray<{
        operator: string;
        target?: {
          text: string;
          value: string;
          parts?: ReadonlyArray<{ type: string }>;
        };
      }>;
      // Statement wraps a single command in `command` (e.g. `cat a` is
      // Statement{ command: Command{ … } }). CompoundList wraps multiple
      // statements in `commands: Statement[]`.
      command?: unknown;
      commands?: ReadonlyArray<unknown>;
      clause?: unknown;
      then?: unknown;
      elif?: ReadonlyArray<{ clause?: unknown; then?: unknown }>;
      else?: unknown;
      body?: unknown;
      do?: unknown;
      done?: unknown;
      // For: the iterated wordlist.
      wordlist?: ReadonlyArray<{
        text: string;
        value: string;
        parts?: ReadonlyArray<{ type: string }>;
      }>;
      // Case: items[i].body is a CompoundList of Statements.
      items?: ReadonlyArray<{ body?: unknown }>;
    };
    if (n.type === "Command") {
      processRedirects(n.redirects);
      const cmdName = n.name?.text.split(/\s+/)[0] ?? "";
      if (FILE_OPERAND_COMMANDS.has(cmdName)) {
        let skipNext = false;
        for (const w of n.suffix ?? []) {
          if (skipNext) {
            skipNext = false;
            continue;
          }
          if (!isStaticLiteralWord(w)) continue;
          if (w.text.startsWith("-")) {
            // Eat the next token for long-form options that take an argument,
            // e.g. `--file FILE` (used by `sed -i` style).
            if (/^--(?:file|in-place)(?:=.*)?$/.test(w.text)) skipNext = true;
            continue;
          }
          // Use `w.value` (strips quote characters) rather than `w.text` so
          // single-quoted paths like `'src/a.ts'` land in the DB as the
          // unquoted path.
          push(w.value);
        }
      }
      return;
    }
    if (n.type === "Statement") {
      // Trailing redirect on a compound: `(cat a) > out.ts`,
      // `for … done > out.ts`, `if … fi > out.ts`, `function foo { … } > log`.
      processRedirects(n.redirects);
      if (n.command) visit(n.command);
    }
    // For: `for f in src/a.ts src/b.ts; do cat $f; done` — the wordlist is
    // a static set of path candidates; each is a touched file.
    if (n.type === "For" && n.wordlist) {
      for (const w of n.wordlist) {
        if (isStaticLiteralWord(w)) push(w.value);
      }
    }
    // Function/Coproc carry their own redirects.
    if (n.type === "Function" || n.type === "Coproc") {
      processRedirects(n.redirects);
    }
    // Generic descent for control flow and compound lists.
    if (n.commands) for (const c of n.commands) visit(c);
    if (n.clause) visit(n.clause);
    if (n.then) visit(n.then);
    if (n.else) visit(n.else);
    for (const ei of n.elif ?? []) {
      if (ei.clause) visit(ei.clause);
      if (ei.then) visit(ei.then);
    }
    if (n.body) visit(n.body);
    if (n.do) visit(n.do);
    if (n.done) visit(n.done);
    // Case: items[i].body is a CompoundList of Statements.
    if (n.items) {
      for (const it of n.items) {
        if (it && typeof it === "object" && it.body) visit(it.body);
      }
    }
  };

  for (const stmt of ast.commands ?? []) {
    visit(stmt);
  }
  return out;
}

/**
 * Best-effort extraction of the source-file paths a tool call acted on, from
 * its `input` (host-shaped, hence `unknown`). Returns an array of unique
 * file paths in first-seen order. The multi-path shape matters because a
 * single bash command (e.g. `cat a.ts b.ts`) or a tool_use with several path
 * keys can touch N files — the union is what D2c PR-2 needs to associate a
 * knowledge entry with the session's touched files.
 *
 *   - Object input: read `path` / `filePath` / `file` (single).
 *   - JSON string of the same object/array shape: parse + same logic.
 *   - Plain-text path-like token in a raw string: same heuristic as v75.
 *   - Bash command string: \`extractFilePathsFromCommand\` (unbash AST walk).
 *
 * Returns [] when no path is recoverable (e.g. plain bash that doesn't touch
 * files, grep, task, …). This is provenance only — a miss is always safe.
 */
export function extractFilePaths(input: unknown): string[] {
  const fromObject = (o: Record<string, unknown>): string[] => {
    for (const key of ["path", "filePath", "file"] as const) {
      const v = o[key];
      if (typeof v === "string" && v.length > 0) return [v];
    }
    return [];
  };
  if (input && typeof input === "object") {
    const arr = fromObject(input as Record<string, unknown>);
    if (arr.length) return arr;
    // Object with a `command`/`cmd` field → fall through to command parsing.
    const cmd = extractCommand(input);
    if (cmd) return extractFilePathsFromCommand(cmd);
    return [];
  }
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input);
      if (parsed && typeof parsed === "object") {
        const arr = fromObject(parsed as Record<string, unknown>);
        if (arr.length) return arr;
        const cmd = extractCommand(parsed);
        if (cmd) return extractFilePathsFromCommand(cmd);
        return [];
      }
    } catch {
      // not JSON — fall through to the plain-text path heuristic
    }
    // The fallback regex requires a `/`; a `/`-free string can never match.
    if (input.indexOf("/") === -1) return [];
    // Bound the scan, then run the backtracking regex only on short,
    // whitespace-bounded tokens (see PATH_SCAN_LIMIT/PATH_TOKEN_MAX notes).
    const out: string[] = [];
    const seen = new Set<string>();
    for (const token of input.slice(0, PATH_SCAN_LIMIT).split(/\s+/)) {
      if (
        token.length === 0 ||
        token.length > PATH_TOKEN_MAX ||
        token.indexOf("/") === -1
      ) {
        continue;
      }
      const match = token.match(PATH_FALLBACK_RE)?.[0];
      if (match && !seen.has(match)) {
        seen.add(match);
        out.push(match);
      }
    }
    return out;
  }
  return [];
}

/**
 * True when a tool call's `input` invokes a recognized verifier. The command is
 * split into segments on the shell chaining/pipe operators (`&&`, `||`, `;`,
 * `|`, newline) and a segment counts only when a runner leads it — so
 * `cd pkg && pnpm test` matches (2nd segment) while `cat vitest.config.ts` and
 * `grep oxlint .` do not.
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
