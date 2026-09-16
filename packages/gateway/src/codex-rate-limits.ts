export const MAX_CODEX_RATE_LIMIT_EVENTS = 64;
export const MAX_CODEX_RATE_LIMIT_BYTES = 16 * 1024;

const encoder = new TextEncoder();

const CATEGORY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DECIMAL = /^(?:0|[1-9][0-9]{0,23})(?:\.[0-9]{1,12})?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function category(value: unknown): string | undefined {
  return typeof value === "string" && CATEGORY.test(value) ? value : undefined;
}

function rateLimit(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const result: Record<string, unknown> = {};
  if (
    typeof value.used_percent === "number" &&
    Number.isFinite(value.used_percent) &&
    value.used_percent >= 0 &&
    value.used_percent <= 100
  ) {
    result.used_percent = value.used_percent;
  }
  if (
    Number.isSafeInteger(value.window_minutes) &&
    (value.window_minutes as number) >= 1 &&
    (value.window_minutes as number) <= 5_256_000
  ) {
    result.window_minutes = value.window_minutes;
  }
  if (
    Number.isSafeInteger(value.reset_at) &&
    (value.reset_at as number) >= 0 &&
    (value.reset_at as number) <= 253_402_300_799
  ) {
    result.reset_at = value.reset_at;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function credits(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const result: Record<string, unknown> = {};
  if (typeof value.has_credits === "boolean") {
    result.has_credits = value.has_credits;
  }
  if (typeof value.unlimited === "boolean") {
    result.unlimited = value.unlimited;
  }
  if (
    (typeof value.balance === "number" &&
      Number.isFinite(value.balance) &&
      value.balance >= 0) ||
    (typeof value.balance === "string" && DECIMAL.test(value.balance))
  ) {
    result.balance = value.balance;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function sanitizeCodexRateLimitEvent(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(value) || value.type !== "codex.rate_limits") return undefined;
  const result: Record<string, unknown> = { type: "codex.rate_limits" };
  for (const name of [
    "plan_type",
    "metered_limit_name",
    "limit_name",
  ] as const) {
    const normalized = category(value[name]);
    if (normalized !== undefined) result[name] = normalized;
  }
  if (isRecord(value.rate_limits)) {
    const normalizedLimits: Record<string, unknown> = {};
    for (const name of ["primary", "secondary"] as const) {
      const normalized = rateLimit(value.rate_limits[name]);
      if (normalized) normalizedLimits[name] = normalized;
    }
    if (Object.keys(normalizedLimits).length > 0) {
      result.rate_limits = normalizedLimits;
    }
  }
  const normalizedCredits = credits(value.credits);
  if (normalizedCredits) result.credits = normalizedCredits;
  return Object.keys(result).length > 1 ? result : undefined;
}

export function appendCodexRateLimitEvent(
  events: Array<Record<string, unknown>>,
  value: unknown,
): Record<string, unknown> | undefined {
  const normalized = sanitizeCodexRateLimitEvent(value);
  if (!normalized) return undefined;
  const encoded = JSON.stringify(normalized);
  const previous = events.at(-1);
  if (previous && JSON.stringify(previous) === encoded) return undefined;
  if (events.length >= MAX_CODEX_RATE_LIMIT_EVENTS) return undefined;
  const bytes = events.reduce(
    (total, event) => total + encoder.encode(JSON.stringify(event)).byteLength,
    0,
  );
  if (bytes + encoder.encode(encoded).byteLength > MAX_CODEX_RATE_LIMIT_BYTES) {
    return undefined;
  }
  events.push(normalized);
  return normalized;
}

export function sanitizeCodexRateLimitEvents(
  values: readonly unknown[],
): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];
  for (const value of values) appendCodexRateLimitEvent(result, value);
  return result;
}
