/**
 * Argv preprocessor — runs before the legacy dispatcher and the Stricli app.
 *
 * Responsibilities, in priority order:
 *   1. Identify hidden diagnostics (`--print-vendor-info`, `--check-*`).
 *   2. Identify the `lore help` / `lore version` routes that Stricli owns in
 *      Phase 1, plus `--help` / `--version` shorthands for them.
 *   3. Compute the legacy dispatcher's view of the input (rewriting
 *      `lore` → `run`, `lore <agent>` → `run <agent> ...`).
 *
 * The result tells the orchestrator which path to take WITHOUT mutating the
 * user's argv in a way that would surprise the legacy dispatcher.
 */
const HIDDEN_DIAGNOSTICS = new Set([
  "--print-vendor-info",
  "--check-embeddings",
  "--check-vec",
  "--check-read-offload",
]);

/**
 * Routes owned by the Stricli app in Phase 3A+. Commands outside this set
 * keep going through the legacy `_cli()` dispatcher. Subsequent phases
 * extend this list as each command family migrates.
 */
export const STRICLI_ROUTES: ReadonlySet<string> = new Set([
  "help",
  "version",
  "whoami",
  "logs",
  "stop",
  "log",
  "diff",
  "doctor",
  "lint",
  "login",
  "logout",
  "sync",
  "team",
  "admin",
  "import",
  "entity",
  "data",
  "recall",
  "uninstall",
]);

export interface PreprocessResult {
  /**
   * True when the Stricli app should run. Today this is `help` / `version`
   * / `whoami`. False routes through the legacy `_cli()` dispatcher.
   */
  useStricli: boolean;
  /**
   * The user-supplied argv the legacy `_cli()` should see. Identical to
   * `process.argv.slice(2)` for most cases; rewritten for `lore <agent>`
   * shorthand so the legacy dispatcher's view is unchanged.
   */
  legacyArgv: string[];
}

/**
 * Static, dependency-free list of known agent shorthand binaries.
 *
 * Kept in sync with `AGENTS[].binary` in `agents.ts`. Phase 1 verifies
 * parity with a property test; Phase 2 may replace this with a runtime
 * read of the agent registry.
 */
export const KNOWN_AGENT_BINARIES: ReadonlySet<string> = new Set([
  "claude",
  "codex",
  "pi",
  "opencode",
  "hermes",
  "copilot",
  "gemini",
]);

export const KNOWN_ROOT_COMMANDS: ReadonlySet<string> = new Set([
  "run",
  "start",
  "stop",
  "setup",
  "doctor",
  "data",
  "recall",
  "lint",
  "log",
  "diff",
  "login",
  "logout",
  "whoami",
  "sync",
  "team",
  "admin",
  "logs",
  "import",
  "entity",
  "upgrade",
  "uninstall",
  "help",
  "version",
]);

export function preprocessArgv(argv: readonly string[]): PreprocessResult {
  const userArgv = [...argv];
  const legacyArgv = userArgv;

  // Empty argv → `run` (matches the legacy dispatcher's `?? "run"` default).
  if (userArgv.length === 0) {
    return { useStricli: false, legacyArgv: ["run"] };
  }

  const first = userArgv[0];

  // Hidden diagnostics: always legacy. The dispatcher handles them before
  // any command lookup.
  if (HIDDEN_DIAGNOSTICS.has(first)) {
    return { useStricli: false, legacyArgv };
  }

  // `--help` / `-h` alone: Stricli `help` route.
  if (userArgv.length === 1 && (first === "--help" || first === "-h")) {
    return { useStricli: true, legacyArgv: [] };
  }

  // `--version` / `-v` alone: Stricli `version` route.
  if (userArgv.length === 1 && (first === "--version" || first === "-v")) {
    return { useStricli: true, legacyArgv: [] };
  }

  // `lore help [path] [--json]` → Stricli.
  if (first === "help") {
    return { useStricli: true, legacyArgv: [] };
  }

  // `lore version` → Stricli.
  if (first === "version") {
    return { useStricli: true, legacyArgv: [] };
  }

  // `lore <stricli-route> ...` → Stricli. Phase 3A adds `whoami`; subsequent
  // phases append more entries as commands migrate.
  if (first && STRICLI_ROUTES.has(first)) {
    return { useStricli: true, legacyArgv: [] };
  }

  // `lore <agent>` shorthand → legacy with rewritten argv `run <agent> ...`.
  if (
    first &&
    KNOWN_AGENT_BINARIES.has(first) &&
    !KNOWN_ROOT_COMMANDS.has(first)
  ) {
    return {
      useStricli: false,
      legacyArgv: ["run", first, ...userArgv.slice(1)],
    };
  }

  // Everything else: legacy (until subsequent phases migrate commands).
  return { useStricli: false, legacyArgv };
}
