/**
 * Typed command output.
 *
 * The Phase 2 output contract:
 *   - Every information-producing command returns typed domain data.
 *   - `renderHuman` formats for the terminal (default).
 *   - `renderJson` produces a stable JSON object for `--json`.
 *   - `--fields <paths>` filters both forms to a subset of the data.
 *   - JSON output never includes prompts, hints, banners, or ANSI escapes.
 *
 * Today only the types and a tiny test helper are exported. Phase 2 commands
 * in `lib/command.ts` will wrap handlers with `withOutput()` to apply these
 * rules; the typed `help` and `version` commands in `app.ts` already write
 * directly to `this.process.stdout` and remain unchanged.
 */
import type { LoreCommandContext } from "../context";

/**
 * A typed domain result. The discriminator is `kind`; future variants may
 * add streaming (`asyncIterable`) or binary (`bytes`).
 */
export type CommandOutput<T> =
  | { kind: "value"; data: T; hint?: string }
  | { kind: "empty"; hint?: string }
  | { kind: "stream"; data: AsyncIterable<T>; hint?: string };

/**
 * Field paths supported by `--fields`. Dotted paths reach nested fields;
 * callers normalize to a canonical form before comparison.
 */
export type FieldPath = string;

/**
 * Configuration for a command's output pipeline.
 *
 * Handlers attach an `OutputConfig<T>` to their command so the wrapper
 * knows how to render human/JSON/field-filtered forms from the same `T`.
 */
export interface OutputConfig<T> {
  /** Render the data for a human terminal. Default formatter pretty-prints. */
  renderHuman: (data: T, ctx: LoreCommandContext) => string;
  /**
   * Transform `T` into the JSON payload. Default is identity; override when
   * the human view contains derived fields that should not appear in JSON.
   */
  toJson?: (data: T, ctx: LoreCommandContext) => unknown;
  /**
   * Optional field-name allow-list. When set, `--fields` accepts only these
   * paths. Otherwise any dotted path is accepted (best-effort deep select).
   */
  knownFields?: ReadonlyArray<FieldPath>;
}

/**
 * Deep-select fields from an object by dotted path. Used by `--fields`.
 *
 * Unknown paths are silently omitted (no error), matching the Sentry CLI
 * behavior so an over-broad selector never crashes a script.
 */
export function selectFields<T extends Record<string, unknown>>(
  data: T,
  fields: ReadonlyArray<FieldPath>,
): Partial<T> {
  if (fields.length === 0) return data;
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const value = readPath(data, f);
    if (value !== undefined) writePath(out, f, value);
  }
  return out as Partial<T>;
}

function readPath(obj: unknown, path: string): unknown {
  if (obj == null) return undefined;
  let cur: unknown = obj;
  for (const seg of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function writePath(
  out: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const segs = path.split(".");
  let cur = out;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i] ?? "";
    if (cur[seg] == null || typeof cur[seg] !== "object") {
      cur[seg] = {};
    }
    cur = cur[seg] as Record<string, unknown>;
  }
  const last = segs[segs.length - 1] ?? path;
  cur[last] = value;
}

/**
 * Render an output payload as JSON Lines (one JSON object per yielded item).
 * Used by streaming commands in `--json` mode so consumers can pipe directly
 * into `jq -c`.
 */
export async function* jsonLines<T>(
  stream: AsyncIterable<T>,
): AsyncGenerator<string> {
  for await (const item of stream) {
    yield `${JSON.stringify(item)}\n`;
  }
}
