/**
 * Scroll-up lazy loading of older history (#1923): the pure decision rules
 * the session reader's scroll handler applies, kept apart from the
 * virtualiser so each gate stays testable. Nothing here claims anything the
 * server did not say — `hasOlder === null` and an outstanding `olderError`
 * both refuse to load (an error is only retried by the explicit control).
 */

/** One viewport of margin above the list still counts as "near the top". */
export function nearTopOfList(args: {
  scrollTop: number;
  listOffset: number;
  clientHeight: number;
}): boolean {
  return args.scrollTop - args.listOffset < args.clientHeight;
}

export interface OlderGate {
  hasOlder: boolean | null;
  /** `loadingOlder` prop or the reader's own in-flight page. */
  busy: boolean;
  /** Reported `olderError`: an error requires the explicit Retry. */
  error: unknown;
  /** The reader has landed at the newest message once. */
  landed: boolean;
  /** A pending deep link owns the scroll. */
  linkPending: boolean;
}

function gateOpen(gate: OlderGate): boolean {
  if (!gate.landed || gate.linkPending) return false;
  if (gate.hasOlder !== true || gate.busy || gate.error) return false;
  return true;
}

/**
 * The scroll-event rule: a page loads only on an *upward* move near the top
 * of the list. The moved-up requirement excludes the reader's own landing
 * and prepend-compensation scrolls, which only ever move down.
 */
export function shouldLoadOlder(
  gate: OlderGate & {
    scrollTop: number;
    prevScrollTop: number;
    listOffset: number;
    clientHeight: number;
  },
): boolean {
  if (!gateOpen(gate)) return false;
  if (gate.scrollTop >= gate.prevScrollTop) return false;
  return nearTopOfList(gate);
}

/**
 * The chain rule, applied right after a prepend lands: without the moved-up
 * requirement, because a page shorter than a viewport can leave the reader
 * already at the top with more history still unfetched.
 */
export function shouldChainOlder(
  gate: OlderGate & {
    scrollTop: number;
    listOffset: number;
    clientHeight: number;
  },
): boolean {
  if (!gateOpen(gate)) return false;
  return nearTopOfList(gate);
}
