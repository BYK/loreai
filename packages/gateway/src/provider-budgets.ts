/**
 * Per-provider budgets (issue #1927), keyed by (provider, auth_kind, account,
 * window):
 *
 * - `pace`: spread a subscription quota window (5h / 7d) evenly. Usage ahead
 *   of the even-pace line plus `headroom` ramps throttle pressure.
 * - `cap`: a hard limit — USD/tokens per UTC day or ISO week (summed from the
 *   daily provider ledger), or quota percent per 5h / 7d window.
 * - `off`: disables the implicit pace budget for one subscription window.
 *
 * Every subscription account with quota rows gets an implicit pace budget for
 * each 5h / 7d window unless an explicit pace/off entry covers that window.
 * Caps never suppress pacing; both apply and the larger pressure wins.
 */

import {
  getKV,
  setKV,
  getProviderDayUsage,
  isProviderQuotaStale,
  listProviderQuotas,
  type ProviderAuthKind,
  type ProviderQuotaRow,
} from "@loreai/core";
import { resolveAuth } from "./auth";
import { resolveCostAttribution } from "./cost-attribution";

export type QuotaWindow = "5h" | "7d";
export type LedgerWindow = "day" | "week";
export type ProviderBudgetWindow = QuotaWindow | LedgerWindow;
export type ProviderBudgetUnit = "usd" | "tokens" | "percent";

type BudgetScope = { provider: string; account: string | null };

export type PaceBudget = BudgetScope & {
  auth_kind: "subscription";
  mode: "pace";
  window: QuotaWindow;
  headroom: number;
};

export type OffBudget = BudgetScope & {
  auth_kind: "subscription";
  mode: "off";
  window: QuotaWindow;
};

export type CapBudget = BudgetScope & { auth_kind: ProviderAuthKind } & (
    | { mode: "cap"; unit: "percent"; window: QuotaWindow; amount: number }
    | {
        mode: "cap";
        unit: "usd" | "tokens";
        window: LedgerWindow;
        amount: number;
      }
  );

export type ProviderBudget = PaceBudget | OffBudget | CapBudget;

export type ProviderBudgetState =
  | "ok"
  | "throttling"
  | "paused"
  | "stale"
  | "unknown"
  | "off";

export type ProviderBudgetStatus = ProviderBudget & {
  /** Quota percent (pace / percent cap), USD or tokens used in the window. */
  used: number | null;
  /** Pace only: even-pace line plus headroom, in percent points. */
  target: number | null;
  /** Pace only: `used - target`, in percent points. */
  ahead: number | null;
  /** Cap only: `used / amount`. */
  fraction: number | null;
  /** Throttle pressure in [0, 1]; 1 also pauses background workers. */
  pressure: number;
  resets_at: number | null;
  stale: boolean;
  implicit: boolean;
  status: ProviderBudgetState;
};

export type BudgetMatch = {
  provider: string;
  auth_kind: ProviderAuthKind;
  account: string;
};

export type BudgetPressure = {
  pressure: number;
  budget: ProviderBudgetStatus | null;
};

const PROVIDER_BUDGETS_KV_KEY = "provider_budgets";
const MAX_BUDGETS = 50;
const PROVIDER_RE = /^[a-z0-9._-]{1,64}$/;
const ACCOUNT_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const AUTH_KINDS = new Set(["api_key", "subscription"]);
const QUOTA_WINDOWS = new Set(["5h", "7d"]);
const LEDGER_WINDOWS = new Set(["day", "week"]);

/** Default pace headroom, in percent points above the even-pace line. */
export const DEFAULT_PACE_HEADROOM = 10;
const MAX_PACE_HEADROOM = 50;
/** Percent points ahead of target at which pace pressure reaches 1. */
export const PACE_RAMP = 10;
/** Cap fraction below which no throttling occurs. */
const CAP_FLOOR = 0.5;
/** Minimum elapsed hours used for the cap spend-rate estimate. */
const MIN_RATE_HOURS = 1;
/** Minimum remaining hours used for the sustainable cap rate. */
const MIN_REMAINING_HOURS = 0.5;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const BASE_FIELDS = ["provider", "auth_kind", "account", "mode", "window"];
const MODE_FIELDS: Record<ProviderBudget["mode"], Set<string>> = {
  pace: new Set([...BASE_FIELDS, "headroom"]),
  off: new Set(BASE_FIELDS),
  cap: new Set([...BASE_FIELDS, "unit", "amount"]),
};

function parseEntry(entry: unknown): ProviderBudget | string {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return "each provider budget must be an object.";
  }
  const rec = entry as Record<string, unknown>;
  const mode = rec.mode;
  if (mode !== "pace" && mode !== "cap" && mode !== "off") {
    return 'mode must be "pace", "cap", or "off".';
  }
  for (const key of Object.keys(rec)) {
    if (!MODE_FIELDS[mode].has(key)) {
      return `unknown field "${key}" for a ${mode} budget.`;
    }
  }
  const provider = rec.provider;
  if (typeof provider !== "string" || !PROVIDER_RE.test(provider)) {
    return `provider must match ${PROVIDER_RE.source}.`;
  }
  let account: string | null = null;
  if (rec.account !== undefined && rec.account !== null) {
    if (typeof rec.account !== "string" || !ACCOUNT_RE.test(rec.account)) {
      return `account must match ${ACCOUNT_RE.source}.`;
    }
    account = rec.account;
  }
  const window = rec.window;
  if (mode === "pace" || mode === "off") {
    if (rec.auth_kind !== "subscription") {
      return `${mode} budgets require auth_kind "subscription" — only subscription quota windows can be paced.`;
    }
    if (typeof window !== "string" || !QUOTA_WINDOWS.has(window)) {
      return `${mode} budgets require window "5h" or "7d".`;
    }
    if (mode === "off") {
      return {
        provider,
        auth_kind: "subscription",
        account,
        mode,
        window: window as QuotaWindow,
      };
    }
    const headroom = rec.headroom ?? DEFAULT_PACE_HEADROOM;
    if (
      typeof headroom !== "number" ||
      !Number.isFinite(headroom) ||
      headroom < 0 ||
      headroom > MAX_PACE_HEADROOM
    ) {
      return `headroom must be a number of percent points in [0, ${MAX_PACE_HEADROOM}].`;
    }
    return {
      provider,
      auth_kind: "subscription",
      account,
      mode,
      window: window as QuotaWindow,
      headroom,
    };
  }
  if (typeof rec.auth_kind !== "string" || !AUTH_KINDS.has(rec.auth_kind)) {
    return 'auth_kind must be "api_key" or "subscription".';
  }
  const authKind = rec.auth_kind as ProviderAuthKind;
  const unit = rec.unit;
  if (unit !== "usd" && unit !== "tokens" && unit !== "percent") {
    return 'unit must be "usd", "tokens", or "percent".';
  }
  if (unit === "percent") {
    if (typeof window !== "string" || !QUOTA_WINDOWS.has(window)) {
      return 'percent caps require window "5h" or "7d".';
    }
  } else if (typeof window !== "string" || !LEDGER_WINDOWS.has(window)) {
    return `${unit} caps require window "day" or "week".`;
  }
  const amount = rec.amount;
  const maxAmount = unit === "percent" ? 100 : 1e9;
  if (
    typeof amount !== "number" ||
    !Number.isFinite(amount) ||
    amount <= 0 ||
    amount > maxAmount
  ) {
    return `amount must be a finite number in (0, ${maxAmount}].`;
  }
  return unit === "percent"
    ? {
        provider,
        auth_kind: authKind,
        account,
        mode,
        unit,
        window: window as QuotaWindow,
        amount,
      }
    : {
        provider,
        auth_kind: authKind,
        account,
        mode,
        unit,
        window: window as LedgerWindow,
        amount,
      };
}

/** Pace and off share a slot per window; caps get one slot per unit. */
function slotKey(budget: ProviderBudget): string {
  return [
    budget.provider,
    budget.auth_kind,
    budget.account ?? "",
    budget.window,
    budget.mode === "cap" ? `cap:${budget.unit}` : "pace",
  ].join("\x1f");
}

/**
 * Validate a user-supplied explicit budget list. Returns the normalized list,
 * or a human-readable error string.
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
  for (const [index, entry] of input.entries()) {
    const budget = parseEntry(entry);
    if (typeof budget === "string") {
      return `provider_budgets[${index}]: ${budget}`;
    }
    const key = slotKey(budget);
    if (seen.has(key)) {
      return `provider_budgets[${index}]: duplicate ${budget.mode === "cap" ? `${budget.unit} cap` : "pace/off entry"} for this provider, auth_kind, account, and window.`;
    }
    seen.add(key);
    out.push(budget);
  }
  return out;
}

/**
 * Load the explicit budget list. Each persisted entry is re-validated
 * individually; invalid or duplicate entries are dropped. Never throws.
 */
export function getProviderBudgets(): ProviderBudget[] {
  let parsed: unknown;
  try {
    const raw = getKV(PROVIDER_BUDGETS_KV_KEY);
    if (!raw) return [];
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: ProviderBudget[] = [];
  const seen = new Set<string>();
  for (const entry of parsed) {
    const budget = parseEntry(entry);
    if (typeof budget === "string") continue;
    const key = slotKey(budget);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(budget);
    if (out.length === MAX_BUDGETS) break;
  }
  return out;
}

/** Replace the explicit budget list. */
export function setProviderBudgets(list: ProviderBudget[]): void {
  setKV(PROVIDER_BUDGETS_KV_KEY, JSON.stringify(list));
}

function covers(
  budget: { provider: string; auth_kind: string; account: string | null },
  match: { provider: string; auth_kind: string; account: string },
): boolean {
  return (
    budget.provider === match.provider &&
    budget.auth_kind === match.auth_kind &&
    (budget.account === null || budget.account === match.account)
  );
}

/**
 * Implicit pace budgets: one per subscription (provider, account, window)
 * quota row for 5h / 7d, unless an explicit pace or off entry covers it.
 */
function implicitBudgets(
  explicit: ProviderBudget[],
  rows: ProviderQuotaRow[],
): PaceBudget[] {
  const out: PaceBudget[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.authKind !== "subscription") continue;
    if (row.window !== "5h" && row.window !== "7d") continue;
    const key = [row.provider, row.account, row.window].join("\x1f");
    if (seen.has(key)) continue;
    seen.add(key);
    const overridden = explicit.some(
      (b) =>
        b.mode !== "cap" &&
        b.window === row.window &&
        covers(b, {
          provider: row.provider,
          auth_kind: row.authKind,
          account: row.account,
        }),
    );
    if (overridden) continue;
    out.push({
      provider: row.provider,
      auth_kind: "subscription",
      account: row.account,
      mode: "pace",
      window: row.window,
      headroom: DEFAULT_PACE_HEADROOM,
    });
  }
  return out;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function quotaPercentOf(row: ProviderQuotaRow): number | null {
  if (row.usedPercent !== null && Number.isFinite(row.usedPercent)) {
    return clamp(row.usedPercent, 0, 100);
  }
  if (
    row.limit !== null &&
    row.limit > 0 &&
    row.remaining !== null &&
    row.remaining >= 0
  ) {
    return clamp(((row.limit - row.remaining) / row.limit) * 100, 0, 100);
  }
  return null;
}

/** Cap pressure: 0 below half the cap, linear to 1 at the cap. */
function capRamp(fraction: number): number {
  if (fraction >= 1) return 1;
  return Math.max(0, (fraction - CAP_FLOOR) / (1 - CAP_FLOOR));
}

function stateFor(pressure: number): ProviderBudgetState {
  return pressure >= 1 ? "paused" : pressure > 0 ? "throttling" : "ok";
}

type Measurement = Omit<
  ProviderBudgetStatus,
  keyof ProviderBudget | "implicit"
>;

const UNKNOWN: Measurement = {
  used: null,
  target: null,
  ahead: null,
  fraction: null,
  pressure: 0,
  resets_at: null,
  stale: false,
  status: "unknown",
};

/** Pace or percent-cap measurement against one account's quota window. */
function measureQuota(
  budget: PaceBudget | Extract<CapBudget, { unit: "percent" }>,
  row: ProviderQuotaRow,
  now: number,
): Measurement {
  if (isProviderQuotaStale(row, now)) {
    return {
      ...UNKNOWN,
      resets_at: row.resetsAt,
      stale: true,
      status: "stale",
    };
  }
  const used = quotaPercentOf(row);
  if (used === null) return { ...UNKNOWN, resets_at: row.resetsAt };
  if (budget.mode === "cap") {
    const fraction = used / budget.amount;
    const pressure = capRamp(fraction);
    return {
      ...UNKNOWN,
      used,
      fraction,
      pressure,
      resets_at: row.resetsAt,
      status: stateFor(pressure),
    };
  }
  if (row.windowMinutes === null || row.resetsAt === null) {
    return { ...UNKNOWN, used, resets_at: row.resetsAt };
  }
  const length = row.windowMinutes * 60_000;
  if (!(length > 0)) return { ...UNKNOWN, used, resets_at: row.resetsAt };
  const elapsed = clamp(length - (row.resetsAt - now), 0, length);
  const target = Math.min(100, (100 * elapsed) / length + budget.headroom);
  const ahead = used - target;
  const pressure = used >= 100 ? 1 : clamp(ahead / PACE_RAMP, 0, 1);
  return {
    ...UNKNOWN,
    used,
    target,
    ahead,
    pressure,
    resets_at: row.resetsAt,
    status: stateFor(pressure),
  };
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** [start, end) of the UTC day or ISO week (Monday 00:00 UTC) containing now. */
export function ledgerWindowBounds(
  window: LedgerWindow,
  now: number,
): { start: number; end: number } {
  const d = new Date(now);
  const dayStart = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
  );
  if (window === "day") return { start: dayStart, end: dayStart + DAY_MS };
  const sinceMonday = (d.getUTCDay() + 6) % 7;
  const start = dayStart - sinceMonday * DAY_MS;
  return { start, end: start + 7 * DAY_MS };
}

/**
 * USD/token cap: the 50%-floor ramp, gated by a rate check — no pressure
 * while the window's average spend rate is sustainable (at or below the
 * remaining amount spread over the hours left). Above it, pressure is shaped
 * so the throttle delay (pressure² × max) keeps the original curve
 * ramp² × tanh(overshoot / 3).
 */
function measureLedger(
  budget: Extract<CapBudget, { unit: "usd" | "tokens" }>,
  now: number,
): Measurement {
  const { start, end } = ledgerWindowBounds(budget.window, now);
  let used = 0;
  for (let day = start; day <= now && day < end; day += DAY_MS) {
    const usage = getProviderDayUsage(
      utcDay(day),
      budget.provider,
      budget.auth_kind,
      budget.account,
    );
    used += budget.unit === "usd" ? usage.cost : usage.tokens;
  }
  const fraction = used / budget.amount;
  let pressure = 0;
  if (fraction >= 1) {
    pressure = 1;
  } else if (fraction >= CAP_FLOOR) {
    const elapsedHours = Math.max((now - start) / HOUR_MS, MIN_RATE_HOURS);
    const remainingHours = Math.max((end - now) / HOUR_MS, MIN_REMAINING_HOURS);
    const rate = used / elapsedHours;
    const targetRate = (budget.amount - used) / remainingHours;
    if (rate > targetRate) {
      const overshoot = Math.min(rate / targetRate - 1, 10);
      pressure = capRamp(fraction) * Math.sqrt(Math.tanh(overshoot / 3));
    }
  }
  return {
    ...UNKNOWN,
    used,
    fraction,
    pressure,
    resets_at: end,
    status: stateFor(pressure),
  };
}

function latestRow(
  rows: ProviderQuotaRow[],
  budget: ProviderBudget,
  account: string,
): ProviderQuotaRow | null {
  let best: ProviderQuotaRow | null = null;
  for (const row of rows) {
    if (
      row.provider !== budget.provider ||
      row.authKind !== budget.auth_kind ||
      row.window !== budget.window ||
      row.account !== account
    ) {
      continue;
    }
    if (!best || row.observedAt > best.observedAt) best = row;
  }
  return best;
}

/**
 * Measure a budget. Quota windows are per account: a budget without an
 * account (or `onlyAccount` unset) reports the worst-pressure account.
 */
function measure(
  budget: Exclude<ProviderBudget, OffBudget>,
  rows: ProviderQuotaRow[],
  now: number,
  onlyAccount?: string,
): Measurement {
  if (budget.mode === "cap" && budget.unit !== "percent") {
    return measureLedger(budget, now);
  }
  const quotaBudget = budget;
  const accounts =
    budget.account !== null
      ? [budget.account]
      : onlyAccount !== undefined
        ? [onlyAccount]
        : [
            ...new Set(
              rows
                .filter(
                  (row) =>
                    row.provider === budget.provider &&
                    row.authKind === budget.auth_kind &&
                    row.window === budget.window,
                )
                .map((row) => row.account),
            ),
          ];
  let worst: Measurement | null = null;
  for (const account of accounts) {
    const row = latestRow(rows, budget, account);
    const result = row ? measureQuota(quotaBudget, row, now) : UNKNOWN;
    if (!worst || result.pressure > worst.pressure) worst = result;
  }
  return worst ?? UNKNOWN;
}

function statusOf(
  budget: ProviderBudget,
  implicit: boolean,
  rows: ProviderQuotaRow[],
  now: number,
  onlyAccount?: string,
): ProviderBudgetStatus {
  if (budget.mode === "off") {
    return {
      ...budget,
      ...UNKNOWN,
      status: "off",
      implicit,
    };
  }
  return {
    ...budget,
    ...measure(budget, rows, now, onlyAccount),
    implicit,
  };
}

/** Statuses for every explicit (including off) and implicit budget. */
export function evaluateProviderBudgets(
  now = Date.now(),
): ProviderBudgetStatus[] {
  const explicit = getProviderBudgets();
  const rows = listProviderQuotas();
  return [
    ...explicit.map((budget) => statusOf(budget, false, rows, now)),
    ...implicitBudgets(explicit, rows).map((budget) =>
      statusOf(budget, true, rows, now),
    ),
  ];
}

/**
 * Max pressure over the budgets covering an attribution, with the budget
 * that produced it. Quota windows are evaluated for the attribution's own
 * account.
 */
export function providerBudgetPressure(
  match: BudgetMatch | null,
  now = Date.now(),
): BudgetPressure {
  if (!match) return { pressure: 0, budget: null };
  const explicit = getProviderBudgets();
  const rows = listProviderQuotas();
  let best: BudgetPressure = { pressure: 0, budget: null };
  const candidates: Array<[ProviderBudget, boolean]> = [
    ...explicit.map((b): [ProviderBudget, boolean] => [b, false]),
    ...implicitBudgets(explicit, rows).map((b): [ProviderBudget, boolean] => [
      b,
      true,
    ]),
  ];
  for (const [budget, implicit] of candidates) {
    if (budget.mode === "off" || !covers(budget, match)) continue;
    const status = statusOf(budget, implicit, rows, now, match.account);
    if (status.pressure > best.pressure) {
      best = { pressure: status.pressure, budget: status };
    }
  }
  return best;
}

/** Human-readable budget name for logs. */
export function describeProviderBudget(status: ProviderBudgetStatus): string {
  const scope = `${status.provider}/${status.auth_kind}/${status.account ?? "*"}`;
  const kind =
    status.mode === "cap" ? `${status.unit} cap ${status.amount}` : status.mode;
  const detail =
    status.ahead !== null
      ? ` ahead=${status.ahead.toFixed(1)}pts`
      : status.fraction !== null
        ? ` used=${(status.fraction * 100).toFixed(0)}%`
        : "";
  return `${scope} ${status.window} ${kind}${status.implicit ? " (implicit)" : ""}${detail}`;
}

/** Budget attribution for a session's last upstream; null when unknown. */
export function sessionBudgetMatch(
  sessionID: string,
  upstream?: { providerID?: string; url?: string },
): BudgetMatch | null {
  const attribution = resolveCostAttribution({
    sessionID,
    providerID: upstream?.providerID,
    upstreamURL: upstream?.url,
    credential: resolveAuth(sessionID, upstream?.providerID),
  });
  if (attribution.provider === "unknown") return null;
  return {
    provider: attribution.provider,
    auth_kind: attribution.authKind,
    account: attribution.account,
  };
}

/**
 * Whether a budget covering the session's attribution is at pressure 1 —
 * background workers pause for it the same way they do for quota. Never
 * throws: a DB failure must not break the caller.
 */
export function isSessionBudgetPaused(
  sessionID: string,
  upstream?: { providerID?: string; url?: string },
): boolean {
  try {
    return (
      providerBudgetPressure(sessionBudgetMatch(sessionID, upstream))
        .pressure >= 1
    );
  } catch {
    return false;
  }
}
