/**
 * The one place request URLs are assembled. Every route the SPA calls and
 * every UI-contract test in the gateway goes through `apiPath()` so a path
 * segment or query value is never hand-encoded two different ways; the
 * `.oxlintrc.json` override for `packages/ui/src/lib` and the contract test
 * rejects direct `encodeURIComponent` / `URLSearchParams` there.
 */

export type QueryParams = Record<
  string,
  string | number | boolean | null | undefined
>;

/**
 * `?a=1&b=x` for the defined entries of `params` (in insertion order), or
 * `""` when nothing is set. `null` / `undefined` values are omitted, so an
 * optional flag can be passed as `flag || null`.
 */
export function query(params: QueryParams): string {
  const values = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined) {
      values.set(key, String(value));
    }
  }
  const encoded = values.toString();
  return encoded ? `?${encoded}` : "";
}

/**
 * `/seg/ment?query` — each segment percent-encoded as one path component
 * (a `/` inside an id stays inside the segment), followed by `query(params)`.
 *
 * `apiPath(["sessions", id, "search"], { path, q })` →
 * `/sessions/<id>/search?path=…&q=…`
 */
export function apiPath(
  segments: readonly string[],
  params: QueryParams = {},
): string {
  return `/${segments.map(encodeURIComponent).join("/")}${query(params)}`;
}
