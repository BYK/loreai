/** Pure helpers for the per-provider cost cards (#1926 UI half). */

import type { CostsSnapshot, ProviderBudgetInput } from "~/contracts";

export type ProviderRow = {
  provider: string;
  auth_kind: "api_key" | "subscription";
  account: string;
  spend: number;
  today_spend: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  requests: number;
  last_day: string | null;
};

export type QuotaRow = {
  provider: string;
  auth_kind: "api_key" | "subscription";
  account: string;
  window: string;
  label: string | null;
  window_minutes: number | null;
  used_percent: number | null;
  remaining: number | null;
  limit: number | null;
  resets_at: number | null;
  source: string;
  observed_at: number;
  stale: boolean;
};

/** Fallback staleness bound when the window length itself is unknown. */
const QUOTA_STALE_FALLBACK_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a quota snapshot may no longer reflect the live window — the
 * gateway-computed flag OR the same rule re-evaluated against the current
 * time (so snapshots kept open in the browser degrade too).
 */
export function quotaStale(row: QuotaRow, now: number): boolean {
  if (row.stale) return true;
  if (row.resets_at !== null && now >= row.resets_at) return true;
  const age = now - row.observed_at;
  return row.window_minutes !== null
    ? age > row.window_minutes * 60_000
    : age > QUOTA_STALE_FALLBACK_MS;
}

export type BudgetRow = CostsSnapshot["provider_budgets"][number];

export type ProviderCardModel = {
  key: string;
  provider: string;
  auth_kind: "api_key" | "subscription";
  account: string;
  costs: ProviderRow | null;
  quotas: QuotaRow[];
};

const PROVIDER_NAMES: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  gemini: "Gemini",
  google: "Gemini",
  vertex: "Vertex AI",
  openrouter: "OpenRouter",
  "github-copilot": "GitHub Copilot",
  bedrock: "Amazon Bedrock",
  opencode: "OpenCode Zen",
  "opencode-go": "OpenCode Go",
  unknown: "Unknown provider",
};

export function displayProvider(id: string): string {
  return PROVIDER_NAMES[id] ?? id;
}

/**
 * Effective usage percent for a quota window: `used_percent` when present,
 * else derived from limit/remaining; null when nothing numeric is known.
 */
export function quotaPercent(row: QuotaRow): number | null {
  if (row.used_percent !== null) return row.used_percent;
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

/**
 * Human countdown to a quota reset, relative to `now` (ms epoch).
 * "" when resets_at is null; "reset passed" when already in the past.
 */
export function formatResetCountdown(
  resetsAt: number | null,
  now: number,
): string {
  if (resetsAt === null) return "";
  const delta = resetsAt - now;
  if (delta <= 0) return "reset passed";
  return `resets in ${formatDuration(delta)}`;
}

/** Compact duration: "45s", "14m", "2h 14m", "3d 4h". */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const remMin = minutes % 60;
    return remMin > 0 ? `${hours}h ${remMin}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}

const WINDOW_ORDER = new Map([
  ["5h", 0],
  ["7d", 1],
]);

/** Label + sort rank for a quota window inside a card. */
export function quotaWindowLabel(row: QuotaRow): string {
  if (row.window === "5h") return "5-hour window";
  if (row.window === "7d") return "Weekly window";
  return row.label ?? row.window;
}

function quotaSortKey(row: QuotaRow): number {
  return WINDOW_ORDER.get(row.window) ?? 2;
}

function cardKey(provider: string, authKind: string, account: string): string {
  return `${provider}\x1f${authKind}\x1f${account}`;
}

/**
 * Merge provider cost rows and quota snapshots into card models. Cost rows
 * keep their (spend-desc) order; quota rows for keys with no cost row become
 * quota-only cards appended after. Each card's quotas are ordered 5h, 7d,
 * then everything else.
 */
export function groupProviderCards(
  providers: ProviderRow[],
  quotas: QuotaRow[],
): ProviderCardModel[] {
  const cards = new Map<string, ProviderCardModel>();
  for (const row of providers) {
    const key = cardKey(row.provider, row.auth_kind, row.account);
    cards.set(key, {
      key,
      provider: row.provider,
      auth_kind: row.auth_kind,
      account: row.account,
      costs: row,
      quotas: [],
    });
  }
  for (const row of quotas) {
    const key = cardKey(row.provider, row.auth_kind, row.account);
    let card = cards.get(key);
    if (!card) {
      card = {
        key,
        provider: row.provider,
        auth_kind: row.auth_kind,
        account: row.account,
        costs: null,
        quotas: [],
      };
      cards.set(key, card);
    }
    card.quotas.push(row);
  }
  for (const card of cards.values()) {
    card.quotas.sort((a, b) => quotaSortKey(a) - quotaSortKey(b));
  }
  return [...cards.values()];
}

/**
 * Budgets that apply to a card: same provider and auth_kind, with account
 * either unset (every account) or equal to the card's.
 */
export function budgetsForCard(
  budgets: BudgetRow[],
  card: Pick<ProviderCardModel, "provider" | "auth_kind" | "account">,
): BudgetRow[] {
  return budgets.filter(
    (b) =>
      b.provider === card.provider &&
      b.auth_kind === card.auth_kind &&
      (b.account === null || b.account === card.account),
  );
}

// ---------------------------------------------------------------------------
// Provider budgets (#1927): pace state + the per-card budget editor.
// ---------------------------------------------------------------------------

export const DEFAULT_PACE_HEADROOM = 10;
export const PACE_WINDOWS = ["5h", "7d"] as const;
export type PaceWindow = (typeof PACE_WINDOWS)[number];
export const CAP_FIELDS = [
  { key: "usd_day", unit: "usd", window: "day", label: "USD cap per day" },
  { key: "usd_week", unit: "usd", window: "week", label: "USD cap per week" },
  {
    key: "tokens_day",
    unit: "tokens",
    window: "day",
    label: "Token cap per day",
  },
  {
    key: "tokens_week",
    unit: "tokens",
    window: "week",
    label: "Token cap per week",
  },
] as const;
export type CapField = (typeof CAP_FIELDS)[number]["key"];

type CardScope = Pick<ProviderCardModel, "provider" | "auth_kind" | "account">;

export type BudgetEditorState =
  | {
      kind: "subscription";
      windows: Record<
        PaceWindow,
        { pace: boolean; headroom: string; cap: string }
      >;
    }
  | { kind: "api_key"; caps: Record<CapField, string> };

function exactScope(
  b: { provider: string; auth_kind: string; account: string | null },
  card: CardScope,
) {
  return (
    b.provider === card.provider &&
    b.auth_kind === card.auth_kind &&
    b.account === card.account
  );
}

/**
 * The pace/off status governing one quota window of a card: an entry for the
 * card's own account wins over an account-less one. Implicit pace budgets are
 * reported per account, so they count as the card's own.
 */
export function paceFor(
  budgets: BudgetRow[],
  card: CardScope,
  window: string,
): BudgetRow | null {
  const candidates = budgetsForCard(budgets, card).filter(
    (b) => (b.mode === "pace" || b.mode === "off") && b.window === window,
  );
  return (
    candidates.find((b) => b.account === card.account) ?? candidates[0] ?? null
  );
}

/** "on pace" / "ahead of pace by N pts — …" / "stale" / "pacing off"; null when unknown. */
export function paceStateText(
  pace: BudgetRow | null,
  quotaIsStale: boolean,
): string | null {
  if (!pace) return null;
  if (pace.mode === "off") return "pacing off";
  if (quotaIsStale || pace.status === "stale") return "stale";
  if (pace.status === "unknown" || pace.ahead === null) return null;
  if (pace.ahead > 0 && pace.pressure > 0) {
    return `ahead of pace by ${Math.max(1, Math.round(pace.ahead))} pts — Lore is slowing background work`;
  }
  return "on pace";
}

/** Even-pace position (percent of the bar): the target without headroom. */
export function evenPacePercent(pace: BudgetRow | null): number | null {
  if (!pace || pace.mode !== "pace" || pace.target === null) return null;
  return Math.min(100, Math.max(0, pace.target - (pace.headroom ?? 0)));
}

/** The stored (explicit) budget list, stripped of status fields. */
export function explicitBudgets(budgets: BudgetRow[]): ProviderBudgetInput[] {
  const out: ProviderBudgetInput[] = [];
  for (const b of budgets) {
    if (b.implicit) continue;
    const scope = {
      provider: b.provider,
      auth_kind: b.auth_kind,
      account: b.account,
    };
    if (b.mode === "off" && (b.window === "5h" || b.window === "7d")) {
      out.push({ ...scope, mode: "off", window: b.window });
    } else if (b.mode === "pace" && (b.window === "5h" || b.window === "7d")) {
      out.push({
        ...scope,
        mode: "pace",
        window: b.window,
        headroom: b.headroom ?? DEFAULT_PACE_HEADROOM,
      });
    } else if (b.mode === "cap" && b.amount !== undefined) {
      if (b.unit === "percent" && (b.window === "5h" || b.window === "7d")) {
        out.push({
          ...scope,
          mode: "cap",
          unit: "percent",
          window: b.window,
          amount: b.amount,
        });
      } else if (
        (b.unit === "usd" || b.unit === "tokens") &&
        (b.window === "day" || b.window === "week")
      ) {
        out.push({
          ...scope,
          mode: "cap",
          unit: b.unit,
          window: b.window,
          amount: b.amount,
        });
      }
    }
  }
  return out;
}

/** Editor fields for a card, from the effective budgets in the snapshot. */
export function budgetEditorState(
  budgets: BudgetRow[],
  card: CardScope,
): BudgetEditorState {
  const own = budgets.filter(
    (b) => !b.implicit && exactScope(b, card) && b.mode === "cap",
  );
  if (card.auth_kind === "subscription") {
    const windows = {} as Record<
      PaceWindow,
      { pace: boolean; headroom: string; cap: string }
    >;
    for (const w of PACE_WINDOWS) {
      const pace = paceFor(budgets, card, w);
      const cap = own.find((b) => b.unit === "percent" && b.window === w);
      windows[w] = {
        pace: pace?.mode !== "off",
        headroom: String(
          pace?.mode === "pace"
            ? (pace.headroom ?? DEFAULT_PACE_HEADROOM)
            : DEFAULT_PACE_HEADROOM,
        ),
        cap: cap?.amount !== undefined ? String(cap.amount) : "",
      };
    }
    return { kind: "subscription", windows };
  }
  const caps = {} as Record<CapField, string>;
  for (const f of CAP_FIELDS) {
    const cap = own.find((b) => b.unit === f.unit && b.window === f.window);
    caps[f.key] = cap?.amount !== undefined ? String(cap.amount) : "";
  }
  return { kind: "api_key", caps };
}

function parseAmount(raw: string): number | null | undefined {
  const text = raw.trim();
  if (text === "") return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * The full explicit list to PUT after editing one card: every other scope's
 * stored entries are kept verbatim; this card's own account entries are
 * replaced. Returns an error message for invalid input.
 */
export function applyBudgetEditor(
  budgets: BudgetRow[],
  card: CardScope,
  state: BudgetEditorState,
): ProviderBudgetInput[] | string {
  const kept = explicitBudgets(budgets).filter((b) => !exactScope(b, card));
  const scope = {
    provider: card.provider,
    auth_kind: card.auth_kind,
    account: card.account,
  };
  const next: ProviderBudgetInput[] = [];
  if (state.kind === "subscription") {
    for (const w of PACE_WINDOWS) {
      const field = state.windows[w];
      if (field.pace) {
        const headroom = parseAmount(field.headroom);
        if (
          headroom === undefined ||
          headroom === null ||
          headroom < 0 ||
          headroom > 50
        ) {
          return `Headroom for the ${w} window must be between 0 and 50 points.`;
        }
        // The implicit default paces at 10 points, but any account-less
        // pace/off entry for this window replaces it (gateway
        // implicitBudgets), so the account then needs its own entry.
        const wildcardGoverns = kept.some(
          (b) =>
            b.mode !== "cap" &&
            b.window === w &&
            b.account === null &&
            b.provider === card.provider &&
            b.auth_kind === card.auth_kind,
        );
        if (headroom !== DEFAULT_PACE_HEADROOM || wildcardGoverns) {
          next.push({
            ...scope,
            auth_kind: "subscription",
            mode: "pace",
            window: w,
            headroom,
          });
        }
      } else {
        next.push({
          ...scope,
          auth_kind: "subscription",
          mode: "off",
          window: w,
        });
      }
      const cap = parseAmount(field.cap);
      if (cap === undefined || (cap !== null && (cap <= 0 || cap > 100))) {
        return `The ${w} quota cap must be between 0 and 100%.`;
      }
      if (cap !== null)
        next.push({
          ...scope,
          mode: "cap",
          unit: "percent",
          window: w,
          amount: cap,
        });
    }
  } else {
    for (const f of CAP_FIELDS) {
      const cap = parseAmount(state.caps[f.key]);
      if (cap === undefined || (cap !== null && cap <= 0)) {
        return `${f.label} must be a positive number.`;
      }
      if (cap !== null)
        next.push({
          ...scope,
          mode: "cap",
          unit: f.unit,
          window: f.window,
          amount: cap,
        });
    }
  }
  return [...kept, ...next];
}
