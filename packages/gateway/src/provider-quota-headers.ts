/**
 * Parse provider quota/rate-limit response headers into normalized quota
 * window snapshots and persist the latest observation per
 * (provider, auth kind, account, window) (issue #1926).
 */

import { upsertProviderQuota, log } from "@loreai/core";
import type { CostAttribution } from "./cost-attribution";

export type ParsedQuotaWindow = {
  window: string;
  label: string | null;
  windowMinutes: number | null;
  usedPercent: number | null;
  remaining: number | null;
  limit: number | null;
  resetsAt: number | null;
  source:
    | "anthropic-unified"
    | "anthropic-ratelimit"
    | "openai-ratelimit"
    | "codex"
    | "ratelimit";
};

function num(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function nonneg(value: number | null): number | null {
  return value !== null && value >= 0 ? value : null;
}

function percent(value: number | null): number | null {
  if (value === null) return null;
  return Math.min(100, Math.max(0, value));
}

/** Epoch timestamp → ms. Values < 1e11 are seconds, else already ms. */
function epochMs(value: number | null): number | null {
  if (value === null || value <= 0) return null;
  return value < 1e11 ? value * 1000 : value;
}

/** RFC3339 date → ms, or null. */
function rfc3339Ms(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const DURATION_PART = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;

/** Parse "1h2m3.5s" / "6m0s" / "250ms" / "1s" → ms, or null. */
function durationMs(value: string | null): number | null {
  if (!value) return null;
  let total = 0;
  let matched = false;
  for (const match of value.matchAll(DURATION_PART)) {
    matched = true;
    const amount = Number.parseFloat(match[1]);
    if (!Number.isFinite(amount) || amount < 0) return null;
    switch (match[2]) {
      case "h":
        total += amount * 3_600_000;
        break;
      case "m":
        total += amount * 60_000;
        break;
      case "s":
        total += amount * 1000;
        break;
      case "ms":
        total += amount;
        break;
    }
  }
  if (!matched) return null;
  return total;
}

function makeWindow(
  partial: Omit<ParsedQuotaWindow, "label"> & { label?: string | null },
): ParsedQuotaWindow | null {
  if (
    partial.usedPercent === null &&
    partial.remaining === null &&
    partial.limit === null &&
    partial.resetsAt === null &&
    partial.windowMinutes === null
  ) {
    // No usable numeric field at all — nothing worth persisting.
    return null;
  }
  return { label: null, ...partial };
}

function utilizationToPercent(value: string | null): number | null {
  const parsed = num(value);
  if (parsed === null || parsed < 0) return null;
  // 0..1 is a fraction; anything above 1 is already a percent.
  return percent(parsed <= 1 ? parsed * 100 : parsed);
}

/** Named Codex/other buckets: x-<name>-{primary|secondary}-<field>. */
const NAMED_BUCKET_RE =
  /^x-(.+)-(primary|secondary)-(used-percent|window-minutes|reset-at)$/;

/**
 * Parse all recognized quota header families into normalized windows.
 * `observedAt` (ms epoch) is used to convert relative reset durations.
 */
export function parseProviderQuotaHeaders(
  headers: Headers,
  observedAt: number,
): ParsedQuotaWindow[] {
  const windows = new Map<string, ParsedQuotaWindow>();
  const put = (w: ParsedQuotaWindow | null): ParsedQuotaWindow | null => {
    if (w === null) return null;
    const existing = windows.get(w.window);
    if (existing) {
      windows.set(w.window, {
        ...existing,
        label: w.label ?? existing.label,
        windowMinutes: w.windowMinutes ?? existing.windowMinutes,
        usedPercent: w.usedPercent ?? existing.usedPercent,
        remaining: w.remaining ?? existing.remaining,
        limit: w.limit ?? existing.limit,
        resetsAt: w.resetsAt ?? existing.resetsAt,
      });
      return windows.get(w.window)!;
    }
    windows.set(w.window, w);
    return w;
  };

  // --- Anthropic unified (OAuth subscription) ------------------------------
  const unifiedStatus = headers.get("anthropic-ratelimit-unified-status");
  for (const [id, minutes] of [
    ["5h", 300],
    ["7d", 10080],
  ] as const) {
    const usedPercent = utilizationToPercent(
      headers.get(`anthropic-ratelimit-unified-${id}-utilization`),
    );
    const resetsAt = epochMs(
      num(headers.get(`anthropic-ratelimit-unified-${id}-reset`)),
    );
    // Skip entirely absent windows — windowMinutes alone is not a signal.
    if (usedPercent === null && resetsAt === null) continue;
    put(
      makeWindow({
        window: id,
        windowMinutes: minutes,
        usedPercent,
        remaining: null,
        limit: null,
        resetsAt,
        source: "anthropic-unified",
        label: unifiedStatus,
      }),
    );
  }

  // --- Anthropic API-key ratelimits -----------------------------------------
  for (const family of [
    "requests",
    "tokens",
    "input-tokens",
    "output-tokens",
  ]) {
    const limit = nonneg(
      num(headers.get(`anthropic-ratelimit-${family}-limit`)),
    );
    const remaining = nonneg(
      num(headers.get(`anthropic-ratelimit-${family}-remaining`)),
    );
    const usedPercent =
      limit !== null && limit > 0 && remaining !== null
        ? percent(((limit - remaining) / limit) * 100)
        : null;
    put(
      makeWindow({
        window: family,
        label: null,
        windowMinutes: null,
        usedPercent,
        remaining,
        limit,
        resetsAt: rfc3339Ms(headers.get(`anthropic-ratelimit-${family}-reset`)),
        source: "anthropic-ratelimit",
      }),
    );
  }

  // --- OpenAI x-ratelimit-* --------------------------------------------------
  // x-ratelimit-{limit|remaining|reset}-{window} — the window is everything
  // after the field name ("requests", "tokens", "tokens-minute", ...).
  for (const name of headers.keys()) {
    const match = /^x-ratelimit-(limit|remaining|reset)-(.+)$/.exec(name);
    if (!match) continue;
    const [, field, windowName] = match;
    const w = makeWindow({
      window: windowName,
      label: null,
      windowMinutes: null,
      usedPercent: null,
      remaining: field === "remaining" ? nonneg(num(headers.get(name))) : null,
      limit: field === "limit" ? nonneg(num(headers.get(name))) : null,
      resetsAt: field === "reset" ? epochFromDuration(headers.get(name)) : null,
      source: "openai-ratelimit",
    });
    put(w);
    // Compute usedPercent once limit+remaining are both known.
    const merged = windows.get(windowName);
    if (
      merged &&
      merged.usedPercent === null &&
      merged.limit !== null &&
      merged.limit > 0 &&
      merged.remaining !== null
    ) {
      merged.usedPercent = percent(
        ((merged.limit - merged.remaining) / merged.limit) * 100,
      );
    }
  }
  function epochFromDuration(value: string | null): number | null {
    const ms = durationMs(value);
    return ms === null ? null : observedAt + ms;
  }

  // --- Codex quota windows ---------------------------------------------------
  const codexLabel = (prefix: string): string | null =>
    headers.get(`${prefix}-limit-name`);
  const codexWindows = new Map<
    string,
    { prefix: string; name: string | null; slot: string }
  >();
  for (const name of headers.keys()) {
    const match = NAMED_BUCKET_RE.exec(name);
    if (!match) continue;
    const prefix = match[1];
    const slot = match[2];
    let bucketName: string | null;
    if (prefix === "codex") {
      bucketName = null;
    } else if (prefix.startsWith("codex-")) {
      bucketName = prefix.slice("codex-".length);
    } else {
      bucketName = prefix;
    }
    const key = `${prefix}:${slot}`;
    if (!codexWindows.has(key)) {
      codexWindows.set(key, { prefix, name: bucketName, slot });
    }
  }
  for (const entry of codexWindows.values()) {
    const base = `x-${entry.prefix}-${entry.slot}`;
    const minutes = nonneg(num(headers.get(`${base}-window-minutes`)));
    const windowId =
      minutes === 300
        ? "5h"
        : minutes === 10080
          ? "7d"
          : minutes !== null
            ? `${minutes}m`
            : entry.slot;
    const window = entry.name === null ? windowId : `${entry.name}:${windowId}`;
    put(
      makeWindow({
        window,
        label: codexLabel(`x-${entry.prefix}`),
        windowMinutes: minutes,
        usedPercent: percent(num(headers.get(`${base}-used-percent`))),
        remaining: null,
        limit: null,
        resetsAt: epochMs(num(headers.get(`${base}-reset-at`))),
        source: "codex",
      }),
    );
  }
  // Codex credits balance.
  if (headers.get("x-codex-credits-unlimited") !== "true") {
    put(
      makeWindow({
        window: "credits",
        label: "credits",
        windowMinutes: null,
        usedPercent: null,
        remaining: nonneg(num(headers.get("x-codex-credits-balance"))),
        limit: null,
        resetsAt: null,
        source: "codex",
      }),
    );
  }

  // --- Generic / IETF ratelimit family ---------------------------------------
  const fillIfUnset = (
    windowName: string,
    field: "limit" | "remaining" | "resetsAt",
    value: number | null,
  ): void => {
    if (value === null) return;
    const existing = windows.get(windowName);
    if (existing) {
      if (existing[field] === null) existing[field] = value;
      return;
    }
    put(
      makeWindow({
        window: windowName,
        label: null,
        windowMinutes: null,
        usedPercent: null,
        remaining: field === "remaining" ? value : null,
        limit: field === "limit" ? value : null,
        resetsAt: field === "resetsAt" ? value : null,
        source: "ratelimit",
      }),
    );
  };
  for (const prefix of ["x-rate-limit", "ratelimit"] as const) {
    for (const field of ["limit", "remaining", "reset"] as const) {
      const raw = headers.get(`${prefix}-${field}`);
      // `reset` is seconds-from-now for the generic family (not a Go-style
      // duration like OpenAI's x-ratelimit-reset-*).
      const seconds = field === "reset" ? num(raw) : null;
      const value =
        field === "reset"
          ? seconds !== null && seconds >= 0
            ? observedAt + seconds * 1000
            : null
          : nonneg(num(raw));
      fillIfUnset("requests", field === "reset" ? "resetsAt" : field, value);
    }
  }
  // IETF RateLimit: `ratelimit: "name";r=99;t=30`
  const ietf = headers.get("ratelimit");
  if (ietf) {
    const name = /^"([^"]+)"/.exec(ietf)?.[1] ?? "default";
    const remainingMatch = /(?:^|;)\s*r=(\d+(?:\.\d+)?)/.exec(ietf);
    const resetMatch = /(?:^|;)\s*t=(\d+(?:\.\d+)?)/.exec(ietf);
    const existing = windows.get(name);
    const target: ParsedQuotaWindow = existing ?? {
      window: name,
      label: null,
      windowMinutes: null,
      usedPercent: null,
      remaining: null,
      limit: null,
      resetsAt: null,
      source: "ratelimit",
    };
    if (!existing) windows.set(name, target);
    {
      if (remainingMatch && target.remaining === null) {
        target.remaining = nonneg(num(remainingMatch[1]));
      }
      if (resetMatch && target.resetsAt === null) {
        const seconds = num(resetMatch[1]);
        if (seconds !== null) target.resetsAt = observedAt + seconds * 1000;
      }
      // A bare "name";t=30 line with no numeric field would have been
      // dropped by makeWindow; if it was dropped and still has nothing,
      // remove it.
      if (
        target.usedPercent === null &&
        target.remaining === null &&
        target.limit === null &&
        target.resetsAt === null &&
        target.windowMinutes === null
      ) {
        windows.delete(name);
      }
    }
  }
  // IETF RateLimit-Policy: `ratelimit-policy: "name";q=100;w=60`
  const policy = headers.get("ratelimit-policy");
  if (policy) {
    const name = /^"([^"]+)"/.exec(policy)?.[1] ?? "default";
    const quotaMatch = /(?:^|;)\s*q=(\d+(?:\.\d+)?)/.exec(policy);
    const windowMatch = /(?:^|;)\s*w=(\d+(?:\.\d+)?)/.exec(policy);
    const target = windows.get(name);
    if (target) {
      if (quotaMatch && target.limit === null) {
        target.limit = nonneg(num(quotaMatch[1]));
      }
      if (windowMatch && target.windowMinutes === null) {
        const seconds = num(windowMatch[1]);
        if (seconds !== null) target.windowMinutes = seconds / 60;
      }
    } else {
      const seconds = windowMatch ? num(windowMatch[1]) : null;
      put(
        makeWindow({
          window: name,
          label: null,
          windowMinutes: seconds !== null ? seconds / 60 : null,
          usedPercent: null,
          remaining: null,
          limit: quotaMatch ? nonneg(num(quotaMatch[1])) : null,
          resetsAt: null,
          source: "ratelimit",
        }),
      );
    }
  }

  return [...windows.values()];
}

/**
 * Parse quota headers from an upstream response and persist each window as
 * the latest snapshot for the attributed provider/account. Never throws —
 * failures (e.g. closed DB in tests) are logged at debug level.
 */
export function observeProviderQuotaHeaders(
  headers: Headers,
  attribution: CostAttribution,
  observedAt: number = Date.now(),
): void {
  try {
    const windows = parseProviderQuotaHeaders(headers, observedAt);
    for (const w of windows) {
      upsertProviderQuota({
        provider: attribution.provider,
        authKind: attribution.authKind,
        account: attribution.account,
        window: w.window,
        label: w.label,
        windowMinutes: w.windowMinutes,
        usedPercent: w.usedPercent,
        remaining: w.remaining,
        limit: w.limit,
        resetsAt: w.resetsAt,
        source: w.source,
        observedAt,
      });
    }
  } catch (error) {
    log.info("provider quota capture failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
