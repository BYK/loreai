import type { SSEStreamOptions } from "./stream/options";

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
/** Slack so the finer inactivity fault surfaces before the coarser abort. */
const REQUEST_TIMEOUT_HEADROOM_MS = 60_000;
/** Keep the derived request timeout inside Node's signed 32-bit timer range. */
const MAX_INACTIVITY_DEADLINE_MS =
  MAX_DEADLINE_MS - REQUEST_TIMEOUT_HEADROOM_MS;

export interface SSEInactivityOverrides {
  foregroundSseInactivityMs?: number;
  foregroundRequestTimeoutMs?: number;
  workerResponseInactivityMs?: number;
  workerRequestTimeoutMs?: number;
}

export interface SSEInactivityDeadlines {
  foregroundSseInactivityMs: number;
  foregroundRequestTimeoutMs: number;
  workerResponseInactivityMs: number;
  workerRequestTimeoutMs: number;
}

/**
 * Parse a Node-safe deadline in milliseconds.
 *
 * Invalid input (non-integer, non-positive, or beyond the 32-bit timer
 * ceiling) falls back to the supplied default rather than arming a bogus
 * timer. Mirrors `parseShutdownDeadline`'s contract so the timeout seams in
 * the gateway behave identically. `maximum` can reserve room for a related
 * timer; accepted values above it are capped to that safe maximum.
 */
export function parseSseInactivityMs(
  raw: string | undefined,
  fallback: number,
  maximum = MAX_DEADLINE_MS,
): number {
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_DEADLINE_MS) {
    return fallback;
  }
  return Math.min(Math.max(value, MIN_DEADLINE_MS), maximum);
}

/** Resolve timeouts with environment variables taking precedence over Lore config. */
export function resolveSSEInactivityDeadlines(
  config: SSEInactivityOverrides = {},
  env: NodeJS.ProcessEnv = process.env,
): SSEInactivityDeadlines {
  const configured = (value: number | undefined, fallback: number): number =>
    value === undefined
      ? fallback
      : parseSseInactivityMs(String(value), fallback);

  const foregroundSseInactivityMs = parseSseInactivityMs(
    // How long the foreground relay tolerates upstream silence. Default:
    // 600000ms. Also set as `timeouts.foregroundSseInactivityMs` in `.lore.json`;
    // this environment variable takes priority.
    env.LORE_FOREGROUND_SSE_INACTIVITY_MS,
    configured(
      config.foregroundSseInactivityMs,
      DEFAULT_FOREGROUND_SSE_INACTIVITY_MS,
    ),
    MAX_INACTIVITY_DEADLINE_MS,
  );
  const workerResponseInactivityMs = parseSseInactivityMs(
    // How long a worker tolerates upstream silence. Default: 600000ms. Also set
    // as `timeouts.workerResponseInactivityMs` in `.lore.json`; this environment
    // variable takes priority.
    env.LORE_WORKER_RESPONSE_INACTIVITY_MS,
    configured(
      config.workerResponseInactivityMs,
      DEFAULT_FOREGROUND_SSE_INACTIVITY_MS,
    ),
    MAX_INACTIVITY_DEADLINE_MS,
  );

  return {
    foregroundSseInactivityMs,
    foregroundRequestTimeoutMs: Math.max(
      parseSseInactivityMs(
        // Whole-request foreground ceiling. Default: 900000ms; raised as needed
        // to preserve 60000ms of headroom. Also set as
        // `timeouts.foregroundRequestTimeoutMs` in `.lore.json`; this environment
        // variable takes priority.
        env.LORE_FOREGROUND_REQUEST_TIMEOUT_MS,
        configured(
          config.foregroundRequestTimeoutMs,
          DEFAULT_FOREGROUND_REQUEST_TIMEOUT_MS,
        ),
      ),
      foregroundSseInactivityMs + REQUEST_TIMEOUT_HEADROOM_MS,
    ),
    workerResponseInactivityMs,
    workerRequestTimeoutMs: Math.max(
      parseSseInactivityMs(
        // Whole-request worker ceiling. Default: 900000ms; raised as needed to
        // preserve 60000ms of headroom. Also set as
        // `timeouts.workerRequestTimeoutMs` in `.lore.json`; this environment
        // variable takes priority.
        env.LORE_WORKER_REQUEST_TIMEOUT_MS,
        configured(
          config.workerRequestTimeoutMs,
          DEFAULT_FOREGROUND_REQUEST_TIMEOUT_MS,
        ),
      ),
      workerResponseInactivityMs + REQUEST_TIMEOUT_HEADROOM_MS,
    ),
  };
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

const ENV_DEFAULTS = resolveSSEInactivityDeadlines();

/**
 * Active deadlines for this gateway process. A non-hosted gateway replaces
 * them after loading `.lore.json`; hosted mode uses operator env.
 */
let currentDeadlines: SSEInactivityDeadlines = ENV_DEFAULTS;

export function getSSEInactivityDeadlines(): Readonly<SSEInactivityDeadlines> {
  return currentDeadlines;
}

export function configureSSEInactivityDeadlines(
  config: SSEInactivityOverrides = {},
): Readonly<SSEInactivityDeadlines> {
  currentDeadlines = resolveSSEInactivityDeadlines(config);
  return currentDeadlines;
}

export function foregroundSSEStreamOptions(
  signal?: AbortSignal,
): SSEStreamOptions {
  return {
    signal,
    inactivityMs: currentDeadlines.foregroundSseInactivityMs,
  };
}

export function workerSSEStreamOptions(signal?: AbortSignal): SSEStreamOptions {
  return {
    signal,
    inactivityMs: currentDeadlines.workerResponseInactivityMs,
  };
}

// Keep the env-resolved exports for test timing and internal API compatibility.
// Production request paths read the active deadlines at call time.
export const FOREGROUND_SSE_INACTIVITY_MS =
  ENV_DEFAULTS.foregroundSseInactivityMs;
export const FOREGROUND_REQUEST_TIMEOUT_MS =
  ENV_DEFAULTS.foregroundRequestTimeoutMs;
export const WORKER_RESPONSE_INACTIVITY_MS =
  ENV_DEFAULTS.workerResponseInactivityMs;
export const WORKER_REQUEST_TIMEOUT_MS = ENV_DEFAULTS.workerRequestTimeoutMs;
