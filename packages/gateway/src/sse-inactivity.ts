/**
 * Foreground relay deadline configuration.
 *
 * Centralizes the three timers that bound a foreground request so their
 * ordering is explicit and tunable from one place:
 *
 *   1. upstream SSE inactivity  (tightest — per-stream transport fault)
 *   2. foreground request abort (coarser — whole-request ceiling)
 *   3. client keepalive ping    (client-side liveness only, see pipeline.ts)
 *
 * Previously (1) and (2) were independent hardcoded constants (120s and 300s)
 * with no declared relationship. That made any attempt to raise (1) a silent
 * no-op above 300s: the coarser timer fired first and surfaced as a
 * whole-request timeout.
 */

/** Node accepts delays up to 2^31-1 ms; beyond that setTimeout overflows. */
const MAX_DEADLINE_MS = 2_147_483_647;
/** A floor keeps an accidental `=1` from turning a deadline into a hard abort. */
const MIN_DEADLINE_MS = 1_000;

/**
 * Parse a Node-safe deadline in milliseconds.
 *
 * Invalid input (non-integer, non-positive, or beyond the 32-bit timer
 * ceiling) falls back to the supplied default rather than arming a bogus
 * timer. Mirrors `parseShutdownDeadline`'s contract so the timeout seams in
 * the gateway behave identically.
 */
export function parseSseInactivityMs(
  raw: string | undefined,
  fallback: number,
): number {
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_DEADLINE_MS) {
    return fallback;
  }
  return Math.max(value, MIN_DEADLINE_MS);
}

/**
 * Default upstream-side SSE inactivity deadline for foreground relays.
 *
 * Bounds how long the gateway tolerates silence from the upstream provider
 * before aborting the relay. The former value of 120s was too aggressive for
 * models whose extended-thinking phases legitimately emit nothing for minutes
 * (Opus-class reasoning over large cached prompts): the gateway killed the
 * stream mid-thinking, the client saw a truncated 200 with zero content and
 * reported a transport loss, while its own watchdogs (180s/300s) never fired.
 *
 * 600s sits above every client watchdog the gateway serves, so the client
 * remains the authority on a stalled stream and the gateway intervenes only on
 * a genuinely dead connection.
 */
export const DEFAULT_FOREGROUND_SSE_INACTIVITY_MS = 600_000;

/**
 * Default wall-clock ceiling for a single foreground request.
 *
 * A hard abort of the whole relay (recall deadline + abort scope), so it must
 * stay above {@link DEFAULT_FOREGROUND_SSE_INACTIVITY_MS}.
 */
export const DEFAULT_FOREGROUND_REQUEST_TIMEOUT_MS = 900_000;

/** Slack so the finer inactivity fault surfaces before the coarser abort. */
const FOREGROUND_TIMEOUT_HEADROOM_MS = 60_000;

/**
 * Foreground relay inactivity deadline: env-overridable, defaults to 600s.
 * Read once at module load; restart the gateway to apply a change.
 */
export const FOREGROUND_SSE_INACTIVITY_MS: number = parseSseInactivityMs(
  // How long the gateway tolerates upstream silence on a foreground relay
  // before aborting it. Raise this for models whose extended-thinking phases
  // emit nothing for minutes (Opus-class reasoning over large cached prompts),
  // since a too-low value kills the stream mid-thinking and the client reports
  // a connection loss rather than a stall. Positive integer ms; invalid values
  // fall back to 600000. Floored at 1000 and clamped to the 32-bit timer
  // ceiling. Env: LORE_FOREGROUND_SSE_INACTIVITY_MS.
  process.env.LORE_FOREGROUND_SSE_INACTIVITY_MS,
  DEFAULT_FOREGROUND_SSE_INACTIVITY_MS,
);

/**
 * Foreground request timeout: env-overridable, defaults to 900s.
 *
 * Clamped to `max(configured, inactivity + headroom)` so raising the
 * inactivity deadline cannot leave a tighter request ceiling silently in
 * force — the trap that made a 120s->600s change a no-op above 300s.
 */
export const FOREGROUND_REQUEST_TIMEOUT_MS: number = Math.max(
  parseSseInactivityMs(
    // Wall-clock ceiling for a single foreground request: the hard abort of
    // the whole relay (recall deadline + abort scope). Automatically raised to
    // stay at least 60s above LORE_FOREGROUND_SSE_INACTIVITY_MS, so a request
    // timeout can never make the inactivity deadline unreachable. Positive
    // integer ms; invalid values fall back to 900000. Env:
    // LORE_FOREGROUND_REQUEST_TIMEOUT_MS.
    process.env.LORE_FOREGROUND_REQUEST_TIMEOUT_MS,
    DEFAULT_FOREGROUND_REQUEST_TIMEOUT_MS,
  ),
  FOREGROUND_SSE_INACTIVITY_MS + FOREGROUND_TIMEOUT_HEADROOM_MS,
);

/**
 * Worker (background/auxiliary call) response deadline. Same defect class as
 * the foreground relay: a self-hosted reasoning model can spend longer than
 * 120s in hidden reasoning without emitting a byte. Separate from the
 * foreground pair because worker calls are not user-visible and need not match
 * the client's watchdog budget.
 */
export const WORKER_RESPONSE_INACTIVITY_MS: number = parseSseInactivityMs(
  // How long a background/auxiliary worker call tolerates upstream silence
  // before aborting. Separate from the foreground pair because worker calls are
  // not user-visible and need not match the client's watchdog budget. Positive
  // integer ms; invalid values fall back to 600000. Env:
  // LORE_WORKER_RESPONSE_INACTIVITY_MS.
  process.env.LORE_WORKER_RESPONSE_INACTIVITY_MS,
  DEFAULT_FOREGROUND_SSE_INACTIVITY_MS,
);
