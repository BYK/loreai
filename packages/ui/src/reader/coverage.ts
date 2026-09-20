/**
 * The reader's coverage declaration (UI-06c): what the view in front of the
 * reader actually contains, stated from what the server and cache reported —
 * never inferred as "complete" because nothing said otherwise.
 *
 *  - `captured`  every message Lore captured for the session is loaded;
 *  - `partial`   a window of the captured history: older pages not loaded,
 *                a cached window, or a total the server has not confirmed.
 *
 * Both are *Lore's capture*; the harness's own transcript is a separate
 * source that no adapter exposes yet, so the declaration always states that
 * the native transcript is not available rather than leaving it implied.
 */

export type CoverageKind = "captured" | "partial";

export interface CoverageInput {
  /** Message blocks currently loaded in the reader. */
  loaded: number;
  /** Captured total reported by the server; null while unknown. */
  total: number | null;
  /** Older pages exist beyond the loaded window: true / false / null. */
  hasOlder: boolean | null;
  /** The loaded window came from a cache that holds only part of the session. */
  cachedWindow: boolean;
}

export interface CoverageDeclaration {
  kind: CoverageKind;
  /** Short label: "Captured history" / "Partial history". */
  label: string;
  /** Detail, e.g. "100 of 312 captured messages loaded". */
  detail: string;
  /** Why the view is partial; null when it is complete. */
  reason: "older" | "unknown-total" | "cached-window" | "count" | null;
  /** The harness transcript: not exposed by any adapter yet. */
  native: "unavailable";
}

export const NATIVE_TRANSCRIPT_LABEL = "Native transcript not yet available";

function messages(n: number): string {
  return `${n.toLocaleString()} ${n === 1 ? "message" : "messages"}`;
}

export function coverageDeclaration(input: CoverageInput): CoverageDeclaration {
  const { loaded, total, hasOlder, cachedWindow } = input;
  const partial = (
    reason: NonNullable<CoverageDeclaration["reason"]>,
    detail: string,
  ): CoverageDeclaration => ({
    kind: "partial",
    label: "Partial history",
    detail,
    reason,
    native: "unavailable",
  });
  if (cachedWindow) {
    return partial(
      "cached-window",
      total === null
        ? `${messages(loaded)} from the cached window; completeness unknown`
        : `${loaded.toLocaleString()} of ${total.toLocaleString()} captured messages, from the cached window`,
    );
  }
  if (hasOlder === true) {
    return partial(
      "older",
      total === null
        ? `${messages(loaded)} loaded; older history not loaded`
        : `${loaded.toLocaleString()} of ${total.toLocaleString()} captured messages loaded`,
    );
  }
  if (total === null || hasOlder === null) {
    return partial(
      "unknown-total",
      `${messages(loaded)} loaded; completeness unknown`,
    );
  }
  if (loaded < total) {
    return partial(
      "count",
      `${loaded.toLocaleString()} of ${total.toLocaleString()} captured messages loaded`,
    );
  }
  return {
    kind: "captured",
    label: "Captured history",
    detail: `${messages(loaded)}, complete as captured`,
    reason: null,
    native: "unavailable",
  };
}
