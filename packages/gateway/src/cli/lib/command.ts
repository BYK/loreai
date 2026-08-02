/**
 * Mandatory command wrapper.
 *
 * Every Lore command must be created through `buildCommand`, never through
 * Stricli's `buildCommand` directly. This is the single enforcement point for
 * behavior every command should share: a typed context, the typed output
 * pipeline (human/JSON/fields), the typed error/exit-code pipeline, hints,
 * and hidden compatibility flags.
 *
 * Phase 2 introduces two flavors:
 *   - `buildCommand` (legacy): pass a handler that writes directly. Used by
 *     the help/version routes in `app.ts` and any handler that has not yet
 *     migrated to the typed result path.
 *   - `buildOutputCommand`: pass a handler returning a `CommandOutput<T>`
 *     plus an `OutputConfig<T>` so the wrapper renders human/JSON/fields
 *     uniformly and emits hints only in human mode.
 *
 * The Stricli runtime call (`run`) is wired in `cli.ts`; this module just
 * builds the Stricli `Command` value.
 */
import {
  buildCommand as buildStricliCommand,
  type Command,
  type TypedCommandParameters,
} from "@stricli/core";
import type { LoreCommandContext } from "../context";
import { CliError, emitCliError } from "./errors";
import {
  jsonLines,
  selectFields,
  type CommandOutput,
  type FieldPath,
  type OutputConfig,
} from "./output";

/**
 * A Lore command spec — a friendlier shape on top of Stricli's builder
 * arguments.
 */
export interface LoreCommandSpec<
  FLAGS extends Record<string, unknown> = Record<string, never>,
  ARGS extends readonly unknown[] = [],
> {
  /** Short imperative summary used in help listings. */
  brief: string;
  /** Optional longer description with constraints and examples. */
  fullDescription?: string;
  /** Parameters (positional + flags). Omit for a parameterless command. */
  parameters?: TypedCommandParameters<FLAGS, ARGS, LoreCommandContext>;
  /** The handler. Receives flags, then positionals, with `this` = LoreCommandContext. */
  handler: (this: LoreCommandContext, flags: FLAGS, ...args: ARGS) => void | Promise<void>;
}

/**
 * Wrap a Lore command spec into a Stricli `Command<LoreCommandContext>`.
 */
export function buildCommand<
  FLAGS extends Record<string, unknown> = Record<string, never>,
  ARGS extends readonly unknown[] = [],
>(
  spec: LoreCommandSpec<FLAGS, ARGS>,
): Command<LoreCommandContext> {
  const parameters = spec.parameters ?? ({} as TypedCommandParameters<
    FLAGS,
    ARGS,
    LoreCommandContext
  >);
  return buildStricliCommand<FLAGS, ARGS, LoreCommandContext>({
    parameters,
    docs: {
      brief: spec.brief,
      fullDescription: spec.fullDescription,
    },
    func: spec.handler,
  });
}

/**
 * An output-driven command spec. The handler returns a `CommandOutput<T>`;
 * the wrapper renders the data, applies `--json`/`--fields`, and emits hints
 * only in human mode.
 */
export interface OutputCommandSpec<
  T,
  FLAGS extends Record<string, unknown> = Record<string, never>,
  ARGS extends readonly unknown[] = [],
> {
  brief: string;
  fullDescription?: string;
  parameters?: TypedCommandParameters<FLAGS, ARGS, LoreCommandContext>;
  /**
   * The output configuration. `renderHuman` is mandatory; `toJson` is the
   * identity transform by default.
   */
  config: OutputConfig<T>;
  /**
   * The handler. Should return a `CommandOutput<T>` instead of writing to
   * stdout/stderr directly.
   */
  handler: (
    this: LoreCommandContext,
    flags: FLAGS,
    ...args: ARGS
  ) => Promise<CommandOutput<T>> | CommandOutput<T>;
}

/**
 * Standard flags every output-driven command gets. Phase 2 wires `--json`
 * automatically. `--fields` (when the config provides `knownFields`) and
 * `--limit` follow in Phase 3 slices as commands migrate.
 */
interface OutputCommandFlags extends Record<string, unknown> {
  json: boolean;
}

/**
 * Build a command that returns a typed result and renders via the output
 * pipeline.
 */
export function buildOutputCommand<
  T,
  FLAGS extends Record<string, unknown> = Record<string, never>,
  ARGS extends readonly unknown[] = [],
>(
  spec: OutputCommandSpec<T, FLAGS, ARGS>,
): Command<LoreCommandContext> {
  const userParameters = spec.parameters ?? ({} as Record<string, unknown>);
  const baseFlags =
    ((userParameters as { flags?: Record<string, unknown> }).flags ?? {});
  const mergedParameters = {
    ...userParameters,
    flags: {
      json: {
        kind: "boolean",
        brief: "Emit a stable JSON payload instead of human output",
        default: false,
      },
      ...baseFlags,
    },
  } as TypedCommandParameters<FLAGS, ARGS, LoreCommandContext>;
  return buildStricliCommand<FLAGS, ARGS, LoreCommandContext>({
    parameters: mergedParameters,
    docs: {
      brief: spec.brief,
      fullDescription: spec.fullDescription,
    },
    func(flags, ...args): Promise<void> {
      const json = Boolean((flags as unknown as OutputCommandFlags).json);
      try {
        const output = spec.handler.call(
          this,
          flags,
          ...args,
        );
        return Promise.resolve(output).then(async (resolved) => {
          await emitOutput(resolved, spec.config, json, this, args);
        }).catch((err: unknown) => {
          if (err instanceof CliError) {
            emitCliError(err, this, json);
            return;
          }
          throw err;
        });
      } catch (err) {
        if (err instanceof CliError) {
          emitCliError(err, this, json);
          return Promise.resolve();
        }
        return Promise.reject(err);
      }
    },
  });
}

/**
 * Render the output through the chosen pipeline.
 */
async function emitOutput<T>(
  output: CommandOutput<T>,
  config: OutputConfig<T>,
  json: boolean,
  ctx: LoreCommandContext,
  _args: readonly unknown[],
): Promise<void> {
  switch (output.kind) {
    case "value": {
      if (json) {
        const payload = config.toJson
          ? config.toJson(output.data, ctx)
          : output.data;
        ctx.process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      } else {
        ctx.process.stdout.write(`${config.renderHuman(output.data, ctx)}\n`);
      }
      if (!json && output.hint) {
        ctx.process.stderr.write(`\n${output.hint}\n`);
      }
      return;
    }
    case "empty": {
      if (!json && output.hint) {
        ctx.process.stderr.write(`${output.hint}\n`);
      }
      return;
    }
    case "stream": {
      if (json) {
        for await (const line of jsonLines(output.data)) {
          ctx.process.stdout.write(line);
        }
      } else {
        for await (const item of output.data) {
          ctx.process.stdout.write(`${config.renderHuman(item, ctx)}\n`);
        }
      }
      if (!json && output.hint) {
        ctx.process.stderr.write(`\n${output.hint}\n`);
      }
      return;
    }
  }
}

/**
 * Helper for command authors: parse `--fields` from a comma-separated string.
 * Empty/whitespace tokens are dropped silently.
 */
export function parseFields(raw: string | undefined): FieldPath[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Apply `--fields` to a record-typed data object.
 */
export function applyFields<T extends Record<string, unknown>>(
  data: T,
  fields: ReadonlyArray<FieldPath>,
): Partial<T> {
  return selectFields(data, fields);
}