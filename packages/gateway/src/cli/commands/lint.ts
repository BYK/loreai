/**
 * `lore lint` — typed Stricli command (Phase 3D.1).
 *
 * The typed adapter wraps the legacy `commandInvariantCheck` from
 * `./invariant-check` via the shared `runLegacyAndCollect` bridge.
 * Stricli parses the typed flags into a `LintFlags` shape; the adapter
 * maps that into the legacy `Record<string, unknown>` shape the legacy
 * handler expects.
 *
 * Output shape:
 *   - human: rendered per-candidate verdicts (legacy format)
 *   - JSON:  unwrapped trailing CheckResult object (so `report.mjs`
 *            reads top-level `hunks`/`invariants`/`candidates`/
 *            `judgeCalls`/`findings` directly). Falls back to
 *            `{ output: <captured stdout> }` when no parseable
 *            trailing JSON object is found in the captured buffer
 *            (loud-but-diagnosable, vs. silent `undefined` fields).
 *
 * Exit codes: legacy semantics preserved.
 *   - 0  normal completion (advisory mode — always 0 even on findings)
 *   - 1  the legacy handler called process.exit(1) (e.g. invalid --effort)
 *   - 2  --gate mode + a strict/soft invariant violation (handled by
 *          `invariant-check.ts` setting process.exitCode directly;
 *          the bridge preserves the value via the M-1 sentinel fix)
 *
 * Phase 3D.1b will swap the legacy handler for a pure typed
 * implementation; this slice just routes the typed command through
 * Stricli with the legacy parsing layered on top.
 */
import { buildOutputCommand } from "../lib/command";
import { extractTrailingJsonObject } from "../lib/extract";
import { runLegacyAndCollect } from "../lib/legacy-bridge";
import { commandInvariantCheck } from "../invariant-check";

type LintFlags = {
  base?: string;
  head?: string;
  model?: string;
  project?: string;
  effort?: string;
  gate: boolean;
  "import-lore-md": boolean;
  jsonLines: boolean;
};

export const lintCommand = buildOutputCommand<
  string,
  LintFlags,
  readonly unknown[]
>({
  brief: "Semantic invariant lint (always advisory by default)",
  fullDescription:
    "Surfaces PR/commit candidates that violate documented team " +
    "invariants. Always advisory by default (exit 0 even on findings) " +
    "to keep the false-positive feedback loop honest; use --gate to " +
    "enforce via process.exit(2). Base/head are auto-detected (Craft-style) " +
    "from git + CI env, or overridden with --base/--head. --model " +
    "sweeps a specific worker model for the eval. --effort overrides " +
    "the `invariantCheck.effort` config (default off).",
  parameters: {
    flags: {
      base: {
        kind: "parsed",
        parse: String,
        brief: "Base commit SHA (default: auto-detect from git + CI env)",
        optional: true,
      },
      head: {
        kind: "parsed",
        parse: String,
        brief: "Head commit SHA (default: auto-detect from git + CI env)",
        optional: true,
      },
      model: {
        kind: "parsed",
        parse: String,
        brief: "Worker model to evaluate (provider/modelID or bare modelID)",
        optional: true,
      },
      project: {
        kind: "parsed",
        parse: String,
        brief: "Project directory (default: cwd)",
        optional: true,
      },
      effort: {
        kind: "parsed",
        parse: String,
        brief: "Reasoning effort: off, low, medium, high, xhigh",
        optional: true,
      },
      gate: {
        kind: "boolean",
        brief: "Enforce strict/soft invariants (exit 2 on violation)",
        default: false,
      },
      "import-lore-md": {
        kind: "boolean",
        brief:
          "Re-import the repository's AGENTS.md / *.lore.md files before linting",
        default: false,
      },
      jsonLines: {
        kind: "boolean",
        brief: "Emit JSON Lines (one finding per line) instead of human output",
        default: false,
      },
    },
    // No positionals declared — the legacy handler accepts none, and
    // declaring them here would let Stricli accept but ignore them
    // (L-2 review finding). Drop until the legacy handler is replaced.
  },
  config: {
    renderHuman: (data) => data,
    // The legacy handler emits console.error (range header, models.dev
    // status, embedding progress, judging heartbeat) and console.log
    // (the final JSON.stringify result) into the same stdout buffer
    // via `runLegacyAndCollect`. We unwrap the trailing JSON object so
    // `--json` callers (CI's report.mjs, eval scripts) receive the flat
    // `{hunks, invariants, candidates, judgeCalls, findings, ...}`
    // shape they parse — not `{output: "<mixed stdout/stderr string>"}`.
    // The legacy bridge had no separate stdout/stderr channels; the only
    // way to recover the JSON envelope is to scan for it. Falls back to
    // the wrapped form if no parseable object is found (which would also
    // break parse-in-place but is loud about the malformed shape, vs.
    // silent undefined-field render that the previous default produced).
    toJson: (data) => {
      if (typeof data !== "string") return data;
      const parsed = extractTrailingJsonObject(data);
      return parsed ?? { output: data };
    },
  },
  async handler(flags) {
    // Map the Stricli flags into the legacy `values` dict the
    // `commandInvariantCheck` handler expects. Only forward booleans
    // when the user actually set them (skip the `default: false`
    // values so the legacy handler's `=== true` checks don't trip on
    // a forwarded `false` it never asked for).
    const values: Record<string, unknown> = {
      base: flags.base,
      head: flags.head,
      model: flags.model,
      project: flags.project,
      effort: flags.effort,
    };
    if (flags.gate) values.gate = true;
    if (flags["import-lore-md"]) values["import-lore-md"] = true;
    if (flags.jsonLines) values.jsonLines = true;
    // `json` is auto-injected by buildOutputCommand; pass it through.
    values.json = (flags as { json?: boolean }).json;
    const { exitCode, captured } = await runLegacyAndCollect(() =>
      commandInvariantCheck([], values),
    );
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
    return { kind: "value" as const, data: captured };
  },
});
