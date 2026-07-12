/**
 * Extract the URL string from a fetch mock's first argument.
 *
 * `fetch`'s first parameter is `string | URL | Request` (`RequestInfo | URL`).
 * Stringifying it directly risks `"[object Request]"`, so narrow each case to a
 * real string (mirrors the production logic in `src/fetch.ts`). Accepts
 * `undefined` (e.g. `mockFetch.mock.calls[0]?.[0]`) and maps it to `""`.
 */
export function fetchArgUrl(input: RequestInfo | URL | undefined): string {
  if (input == null) return "";
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}
