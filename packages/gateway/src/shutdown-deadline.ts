const DEFAULT_SHUTDOWN_DEADLINE_MS = 4000;
const MIN_SHUTDOWN_DEADLINE_MS = 10;
const MAX_SHUTDOWN_DEADLINE_MS = 2_147_483_647;

/** Parse a Node-safe integer shutdown deadline, falling back on invalid input. */
export function parseShutdownDeadline(
  raw: string | undefined,
  fallback: number = DEFAULT_SHUTDOWN_DEADLINE_MS,
): number {
  if (!raw) return fallback;
  const value = Number(raw);
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAX_SHUTDOWN_DEADLINE_MS
  ) {
    return fallback;
  }
  return Math.max(value, MIN_SHUTDOWN_DEADLINE_MS);
}

/** Shared bound for signal-driven and authenticated-control shutdown. */
export const SHUTDOWN_DEADLINE_MS = parseShutdownDeadline(
  process.env.LORE_SHUTDOWN_TIMEOUT_MS,
);
