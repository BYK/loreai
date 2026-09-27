/**
 * In-session quick search (#1922): the pure helpers behind the collapsible
 * bar — the platform find shortcut, and the `n/m` counter text. The bar
 * itself lives in `~/components/reader/QuickSearch.tsx`.
 */

/**
 * Ctrl/Cmd+F — the chord browsers use for page find. Bare `f`, Alt and
 * Shift combinations are not the shortcut.
 */
export function isFindShortcut(e: KeyboardEvent): boolean {
  return (
    e.key.toLowerCase() === "f" &&
    (e.ctrlKey || e.metaKey) &&
    !e.altKey &&
    !e.shiftKey
  );
}

/**
 * `n/m`: n is the 1-based position of the current hit (0 before any
 * cycling), m the hits found so far. While the scan is still running the
 * position is unknown, so it renders as `…/m`.
 */
export function formatCount(
  index: number,
  total: number,
  scanning: boolean,
): string {
  return `${scanning ? "…" : index + 1}/${total}`;
}
