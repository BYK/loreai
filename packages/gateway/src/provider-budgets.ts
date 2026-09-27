/**
 * Per-provider budgets (issue #1927): budgets keyed by
 * (provider, auth_kind, account) in USD, tokens, or quota percent. USD/token
 * budgets are evaluated against the persisted daily provider ledger; percent
 * budgets evaluate against the latest quota snapshot for the 5h/7d windows.
 */

import {
  getKV,
  setKV,
  getProviderDayUsage,
  listProviderQuotas,
  type ProviderAuthKind,
} from "@loreai/core";

export type ProviderBudgetUnit = "usd" | "tokens" | "percent";
export type ProviderBudgetWindow = "daily" | "5h" | "7d";

export type ProviderBudget = {
  provider: string;
  auth_kind: ProviderAuthKind | null;
  account: string | null;
  unit: ProviderBudgetUnit;
  window: ProviderBudgetWindow;
  amount: number;
};

export type ProviderBudgetStatus = ProviderBudget & {
  used: number | null;
  fraction: number | null;
  resets_at: number | null;
  stale: boolean;
};

const PROVIDER_BUDGETS_KV_KEY = "provider_budgets";
const MAX_BUDGETS = 50;
const PROVIDER_RE = /^[a-z0-9._-]{1,64}$/;
const ACCOUNT_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const AUTH_KINDS = new Set(["api_key", "subscription"]);
const UNITS = new Set(["usd", "tokens", "percent"]);
const WINDOWS = new Set(["daily", "5h", "7d"]);

/**
 * Validate a user-supplied budgets array. Returns the normalized list, or a
 * human-readable error string.
 */
export function parseProviderBudgets(
  input: unknown,
): ProviderBudget[] | string {
  if (!Array.isArray(input)) return "provider_budgets must be an array.";
  if (input.length > MAX_BUDGETS) {
    return `provider_budgets accepts at most ${MAX_BUDGETS} entries.`;
  }
  const out: ProviderBudget[] = [];
  const seen = new Set<string>();
  for (const entry of input) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return "each provider budget must be an object.";
    }
    const rec = entry as Record<string, unknown>;
    for (const key of Object.keys(rec)) {
      if (
        ![
          "provider",
          "auth_kind",
          "account",
          "unit",
          "window",
          "amount",
        ].includes(key)
      ) {
        return `unknown provider budget field "${key}".`;
      }
    }
    const provider = rec.provider;
    if (typeof provider !== "string" || !PROVIDER_RE.test(provider)) {
      return `provider must match ${PROVIDER_RE.source}.`;
    }
    let authKind: ProviderAuthKind | null = null;
    if (rec.auth_kind !== undefined && rec.auth_kind !== null) {
      if (typeof rec.auth_kind !== "string" || !AUTH_KINDS.has(rec.auth_kind)) {
        return 'auth_kind must be "api_key" or "subscription".';
      }
      authKind = rec.auth_kind as ProviderAuthKind;
    }
    let account: string | null = null;
    if (rec.account !== undefined && rec.account !== null) {
      if (typeof rec.account !== "string" || !ACCOUNT_RE.test(rec.account)) {
        return `account must match ${ACCOUNT_RE.source}.`;
      }
      account = rec.account;
    }
    if (typeof rec.unit !== "string" || !UNITS.has(rec.unit)) {
      return 'unit must be "usd", "tokens", or "percent".';
    }
    const unit = rec.unit as ProviderBudgetUnit;
    if (typeof rec.window !== "string" || !WINDOWS.has(rec.window)) {
      return 'window must be "daily", "5h", or "7d".';
    }
    const window = rec.window as ProviderBudgetWindow;
    if (window === "daily" && unit === "percent") {
      return (
        "percent budgets apply to quota windows (5h/7d); daily budgets " +
        'must be "usd" or "tokens".'
      );
    }
    if (window !== "daily" && unit !== "percent") {
      return (
        '5h/7d windows require unit "percent" — usd/token usage is only ' +
        "persisted per day, so shorter windows are not measurable."
      );
    }
    const amount = rec.amount;
    if (
      typeof amount !== "number" ||
      !Number.isFinite(amount) ||
      amount <= 0 ||
      amount > 1e9 ||
      (unit === "percent" && amount > 100)
    ) {
      return `amount must be a finite number in (0, ${unit === "percent" ? 100 : 1e9}].`;
    }
    const tuple = [provider, authKind, account, unit, window].join("\x1f");
    if (seen.has(tuple)) {
      return "duplicate provider budget for (provider, auth_kind, account, unit, window).";
    }
    seen.add(tuple);
    out.push({
      provider,
      auth_kind: authKind,
      account,
      unit,
      window,
      amount,
    });
  }
  return out;
}

/** Load persisted provider budgets; corrupt entries are dropped, never throws. */
export function getProviderBudgets(): ProviderBudget[] {
  let raw: string | null = null;
  try {
    raw = getKV(PROVIDER_BUDGETS_KV_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];
  try {
    const parsed = parseProviderBudgets(JSON.parse(raw));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Replace all persisted provider budgets. */
export function setProviderBudgets(list: ProviderBudget[]): void {
  setKV(PROVIDER_BUDGETS_KV_KEY, JSON.stringify(list));
}

/** Test helper. */
export function resetProviderBudgetState(): void {
  // State lives only in KV; nothing in-memory to reset.
}

/** Next UTC midnight after `now` (ms epoch). */
function nextUtcMidnight(now: number): number {
  const d = new Date(now);
  return Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate() + 1,
    0,
    0,
    0,
    0,
  );
}

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function clampFraction(used: number, amount: number): number {
  return Math.max(0, used / amount);
}

function quotaPercentOf(row: {
  usedPercent: number | null;
  limit: number | null;
  remaining: number | null;
}): number | null {
  if (row.usedPercent !== null && Number.isFinite(row.usedPercent)) {
    return Math.min(100, Math.max(0, row.usedPercent));
  }
  if (
    row.limit !== null &&
    row.limit > 0 &&
    row.remaining !== null &&
    row.remaining >= 0
  ) {
    return Math.min(
      100,
      Math.max(0, ((row.limit - row.remaining) / row.limit) * 100),
    );
  }
  return null;
}

function evaluateOne(
  budget: ProviderBudget,
  now: number,
): ProviderBudgetStatus {
  if (budget.window === "daily") {
    const usage = getProviderDayUsage(
      utcDay(now),
      budget.provider,
      budget.auth_kind,
      budget.account,
    );
    if (budget.unit === "percent") {
      // Corrupt KV entry (validation rejects this combination).
      return {
        ...budget,
        used: null,
        fraction: null,
        resets_at: nextUtcMidnight(now),
        stale: true,
      };
    }
    const used = budget.unit === "usd" ? usage.cost : usage.tokens;
    return {
      ...budget,
      used,
      fraction: clampFraction(used, budget.amount),
      resets_at: nextUtcMidnight(now),
      stale: false,
    };
  }
  // 5h / 7d percent windows come from the latest quota snapshot.
  const rows = listProviderQuotas().filter(
    (row) =>
      row.provider === budget.provider &&
      row.window === budget.window &&
      (budget.auth_kind === null || row.authKind === budget.auth_kind) &&
      (budget.account === null || row.account === budget.account),
  );
  const latest = rows.reduce<(typeof rows)[number] | null>(
    (best, row) => (best && best.observedAt > row.observedAt ? best : row),
    null,
  );
  if (!latest) {
    return {
      ...budget,
      used: null,
      fraction: null,
      resets_at: null,
      stale: true,
    };
  }
  if (latest.resetsAt !== null && now >= latest.resetsAt) {
    // The window rolled over since the observation; we do not invent the
    // next reset boundary.
    return {
      ...budget,
      used: 0,
      fraction: 0,
      resets_at: latest.resetsAt,
      stale: true,
    };
  }
  const used = quotaPercentOf(latest);
  return {
    ...budget,
    used,
    fraction: used === null ? null : clampFraction(used, budget.amount),
    resets_at: latest.resetsAt,
    stale: false,
  };
}

/** Evaluate all persisted provider budgets against current usage data. */
export function evaluateProviderBudgets(
  now = Date.now(),
): ProviderBudgetStatus[] {
  return getProviderBudgets().map((budget) => evaluateOne(budget, now));
}

/**
 * Throttle pressure in [0,1] from the budgets matching an attribution tuple.
 * Same 50% floor shape as the daily/quota throttle: 0 until half the budget
 * is consumed, ramping linearly to 1 at the limit.
 */
export function computeProviderBudgetPressure(
  statuses: ProviderBudgetStatus[],
  match: { provider: string; auth_kind: string; account: string } | null,
): number {
  if (!match) return 0;
  let pressure = 0;
  for (const status of statuses) {
    if (status.provider !== match.provider) continue;
    if (status.auth_kind !== null && status.auth_kind !== match.auth_kind) {
      continue;
    }
    if (status.account !== null && status.account !== match.account) continue;
    if (status.fraction === null) continue;
    const local =
      status.fraction >= 1 ? 1 : Math.max(0, (status.fraction - 0.5) / 0.5);
    if (local > pressure) pressure = local;
  }
  return pressure;
}
