/**
 * `lore lint` — typed Stricli command (Phase 3D.1).
 *
 * Wraps the legacy `commandInvariantCheck` from `./invariant-check` via
 * the shared `runLegacyAndCollect` bridge in `../lib/legacy-bridge`.
 *
 * The legacy handler reads from `process.argv` and accepts positionals
 * + values. Stricli parses flags into a typed shape, so we map the
 * typed flags back into the legacy `Record<string, unknown>` shape and
 * call the legacy command. The bridge captures all legacy output and
 * surfaces failures as __legacy_exit sentinels.
 *
 * Output shape:
 *   - human: rendered per-candidate verdicts (legacy format)
 *   - JSON:  { output: <captured stdout> }
 *
 * Exit codes: legacy semantics preserved.
 *   - 0  normal completion (advisory mode — always 0 even on findings)
 *   - 1  the legacy handler called process.exit(1) (e.g. invalid --effort)
 *   - 2  --gate mode + a strict/soft invariant violation
 *
 * Phase 3D.1 ships a thin pass-through wrapper. Flag parsing is still
 * delegated to the legacy handler (which reads process.argv). The
 * full flag-migration pass is Phase 3D.1b.
 */
import { buildOutputCommand } from "../lib/command";
import { runLegacyAndCollect } from "../lib/legacy-bridge";
import { commandInvariantCheck } from "../invariant-check";

type LintFlags = Record<string, never>;

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
    "enforce via process.exit(2).",
  parameters: {
    flags: {},
    positional: {
      kind: "array",
      parameter: { parse: String, brief: "lint argument", optional: true },
    },
  },
  config: {
    renderHuman: (data) => data,
    toJson: (data) => ({ output: data }),
  },
  async handler() {
    const { exitCode, captured } = await runLegacyAndCollect(() =>
      commandInvariantCheck([], {}),
    );
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
    return { kind: "value" as const, data: captured };
  },
});
