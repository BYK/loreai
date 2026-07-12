/**
 * Coerce a possibly-non-string value (e.g. a field read off parsed-JSON typed as
 * `unknown`/`Record<string, unknown>`) to a string.
 *
 * Returns the value verbatim when it is already a string, otherwise `fallback`
 * (default `""`). This is the safe replacement for `String(x ?? "")` on loosely
 * typed protocol fields: identical output for the valid string case, but maps a
 * malformed object value to `fallback` instead of the useless `"[object Object]"`
 * (the bug `typescript/no-base-to-string` guards against).
 */
export function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}
