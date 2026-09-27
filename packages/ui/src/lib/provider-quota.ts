/** Pure helpers for the per-provider cost cards (#1926 UI half). */

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
};

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
  vertex: "Vertex AI",
  openrouter: "OpenRouter",
  "github-copilot": "GitHub Copilot",
  bedrock: "Amazon Bedrock",
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
  const seconds = Math.floor(delta / 1000);
  if (seconds < 60) return `resets in ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `resets in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const remMin = minutes % 60;
    return remMin > 0
      ? `resets in ${hours}h ${remMin}m`
      : `resets in ${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0
    ? `resets in ${days}d ${remHours}h`
    : `resets in ${days}d`;
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
