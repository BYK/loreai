/**
 * Automatic subscription pacing (#2045): one on/off switch per subscription
 * account `(provider, account)`, on by default. While on, every 5h / 7d quota
 * window of the account counts:
 *
 * - sustainable rate `s = (100 - u) / T` (percent per ms, `u` = used %,
 *   `T` = ms to reset);
 * - observed rate `r` = EWMA of `Δu/Δt` over successive in-memory quota
 *   observations (samples with `Δt ≥ 60 s`, reset when `resetsAt` changes or
 *   `u` drops); with fewer than 2 samples `r = u / (L - T)`;
 * - `u ≥ 100` → maximum delay; `r ≤ s` → none; otherwise `ρ = r / s` and the
 *   request waits `g · (ρ - 1)`, `g` = EWMA of the gaps between the account's
 *   foreground requests.
 *
 * The largest window delay wins, capped at {@link MAX_PACING_DELAY_MS}.
 * Curation is paused while the account is throttling; distillation and the
 * cache warmer never are. API-key accounts have no reset window: no pacing.
 */

import {
  getKV,
  setKV,
  isProviderQuotaStale,
  listProviderQuotas,
  type ProviderAuthKind,
  type ProviderQuotaRow,
} from "@loreai/core";
import { resolveAuth } from "./auth";
import { resolveCostAttribution } from "./cost-attribution";

export type PacingWindow = "5h" | "7d";

export type PacingSetting = {
  provider: string;
  account: string;
  enabled: boolean;
};

export type BudgetMatch = {
  provider: string;
  auth_kind: ProviderAuthKind;
  account: string;
};

/** Inputs for one quota window; rates are percent per ms. */
export type PacingWindowInput = {
  window: string;
  used: number;
  resetsAt: number;
  windowMs: number;
  /** EWMA of observed Δu/Δt, or null with fewer than 2 samples. */
  observedRate: number | null;
  /** Held integral delay `d_w` (ms); applies only with an observed rate. */
  heldDelayMs: number;
};

export type PacingWindowStatus = {
  window: string;
  used: number;
  resets_at: number;
  /** `(100 - u) / T`, percent per hour. */
  sustainable_rate: number;
  /** Observed (or window-average) rate, percent per hour; null when unknown. */
  current_rate: number | null;
  rate_source: "observed" | "average" | "unknown";
  /** `r / s`; null when the rate is unknown. */
  ratio: number | null;
  throttling: boolean;
  delay_ms: number;
};

export type ProviderPacingStatus = {
  provider: string;
  account: string;
  enabled: boolean;
  throttling: boolean;
  delay_ms: number;
  /** EWMA of the gaps between this account's foreground requests. */
  request_gap_ms: number | null;
  windows: PacingWindowStatus[];
};

export const PROVIDER_PACING_KV_KEY = "provider_pacing";
/** Maximum foreground pacing delay (MAX_THROTTLE_DELAY, 60 s). */
export const MAX_PACING_DELAY_MS = 60_000;
/** Minimum Δt between quota observations that count as a rate sample. */
export const MIN_SAMPLE_INTERVAL_MS = 60_000;
/** EWMA weight of the newest sample (rates and request gaps). */
export const PACING_EWMA_ALPHA = 0.3;
const HOUR_MS = 3_600_000;
const MAX_SETTINGS = 200;
const PROVIDER_RE = /^[a-z0-9._-]{1,64}$/;
const ACCOUNT_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const PACING_WINDOWS = new Set(["5h", "7d"]);

// ---------------------------------------------------------------------------
// Settings

function parseSetting(entry: unknown): PacingSetting | string {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return "body must be an object.";
  }
  const rec = entry as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (key !== "provider" && key !== "account" && key !== "enabled") {
      return `unknown field "${key}".`;
    }
  }
  if (typeof rec.provider !== "string" || !PROVIDER_RE.test(rec.provider)) {
    return `provider must match ${PROVIDER_RE.source}.`;
  }
  if (typeof rec.account !== "string" || !ACCOUNT_RE.test(rec.account)) {
    return `account must match ${ACCOUNT_RE.source}.`;
  }
  if (typeof rec.enabled !== "boolean") return "enabled must be a boolean.";
  return { provider: rec.provider, account: rec.account, enabled: rec.enabled };
}

/** Validate a `{ provider, account, enabled }` toggle. */
export function parsePacingSetting(input: unknown): PacingSetting | string {
  return parseSetting(input);
}

/** Stored switches; invalid or duplicate entries are dropped. Never throws. */
export function getPacingSettings(): PacingSetting[] {
  let parsed: unknown;
  try {
    const raw = getKV(PROVIDER_PACING_KV_KEY);
    if (!raw) return [];
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: PacingSetting[] = [];
  const seen = new Set<string>();
  for (const entry of parsed) {
    const setting = parseSetting(entry);
    if (typeof setting === "string") continue;
    const key = `${setting.provider}\x1f${setting.account}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(setting);
    if (out.length === MAX_SETTINGS) break;
  }
  return out;
}

/** Store one account's switch (a missing entry means enabled). */
export function setPacingEnabled(setting: PacingSetting): void {
  const rest = getPacingSettings().filter(
    (s) => s.provider !== setting.provider || s.account !== setting.account,
  );
  const next = setting.enabled ? rest : [...rest, setting];
  setKV(PROVIDER_PACING_KV_KEY, JSON.stringify(next.slice(-MAX_SETTINGS)));
}

export function isPacingEnabled(provider: string, account: string): boolean {
  return !getPacingSettings().some(
    (s) => s.provider === provider && s.account === account && !s.enabled,
  );
}

// ---------------------------------------------------------------------------
// In-memory rate tracker

type RateTrack = {
  resetsAt: number | null;
  lastUsed: number;
  lastAt: number;
  samples: number;
  rate: number | null;
  /** Held integral-controller delay `d_w` (ms). */
  held: number;
};

const rateTracks = new Map<string, RateTrack>();
const requestGaps = new Map<string, { lastAt: number; gap: number | null }>();

function trackKey(provider: string, account: string, window?: string): string {
  return window === undefined
    ? `${provider}\x1f${account}`
    : `${provider}\x1f${account}\x1f${window}`;
}

function ewma(previous: number | null, sample: number): number {
  return previous === null
    ? sample
    : PACING_EWMA_ALPHA * sample + (1 - PACING_EWMA_ALPHA) * previous;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function quotaPercentOf(
  row: Pick<ProviderQuotaRow, "usedPercent" | "limit" | "remaining">,
): number | null {
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

/**
 * Feed one persisted quota observation into the rate tracker. Called where
 * `provider_quotas` rows are written.
 */
export function recordQuotaObservation(row: ProviderQuotaRow): void {
  if (row.authKind !== "subscription" || !PACING_WINDOWS.has(row.window)) {
    return;
  }
  const used = quotaPercentOf(row);
  if (used === null) return;
  const key = trackKey(row.provider, row.account, row.window);
  const track = rateTracks.get(key);
  if (!track || track.resetsAt !== row.resetsAt || used < track.lastUsed) {
    rateTracks.set(key, {
      resetsAt: row.resetsAt,
      lastUsed: used,
      lastAt: row.observedAt,
      samples: 1,
      rate: null,
      held: 0,
    });
    return;
  }
  const dt = row.observedAt - track.lastAt;
  if (dt < MIN_SAMPLE_INTERVAL_MS) return;
  const rate = ewma(track.rate, (used - track.lastUsed) / dt);
  track.rate = rate;
  track.lastUsed = used;
  track.lastAt = row.observedAt;
  track.samples++;
  const T = row.resetsAt === null ? 0 : row.resetsAt - row.observedAt;
  if (used >= 100) {
    track.held = MAX_PACING_DELAY_MS;
  } else if (T > 0) {
    const gap =
      requestGaps.get(trackKey(row.provider, row.account))?.gap ?? null;
    track.held = integrateHeldDelayMs(
      track.held,
      gap,
      rate / ((100 - used) / T),
    );
  }
}

/**
 * One integral-controller step, applied per accepted rate sample:
 * `d_w ← clamp(d_w + g · (ρ − 1), 0, MAX)`. `g` already includes the delay
 * being applied, so this settles where `r = s` (a stateless `g · (ρ − 1)`
 * would settle only halfway). No gap estimate yet → unchanged; pure.
 */
export function integrateHeldDelayMs(
  held: number,
  gapMs: number | null,
  ratio: number,
): number {
  if (gapMs === null || !Number.isFinite(ratio)) return held;
  return clamp(held + gapMs * (ratio - 1), 0, MAX_PACING_DELAY_MS);
}

/** Record a foreground request start for the account's gap EWMA. */
export function recordForegroundRequest(
  match: BudgetMatch | null,
  now = Date.now(),
): void {
  if (!match || match.auth_kind !== "subscription") return;
  const key = trackKey(match.provider, match.account);
  const entry = requestGaps.get(key);
  if (!entry) {
    requestGaps.set(key, { lastAt: now, gap: null });
    return;
  }
  if (now > entry.lastAt) entry.gap = ewma(entry.gap, now - entry.lastAt);
  entry.lastAt = now;
}

export function _resetPacingTrackerForTest(): void {
  rateTracks.clear();
  requestGaps.clear();
}

// ---------------------------------------------------------------------------
// Delay

/** Per-window evaluation; pure. */
export function evaluatePacingWindow(
  input: PacingWindowInput,
  gapMs: number | null,
  now: number,
): PacingWindowStatus | null {
  const T = input.resetsAt - now;
  if (!(T > 0) || !(input.windowMs > 0)) return null;
  const u = clamp(input.used, 0, 100);
  const sustainable = (100 - u) / T;
  const elapsed = input.windowMs - T;
  const rate = input.observedRate ?? (elapsed > 0 ? u / elapsed : null);
  const source: PacingWindowStatus["rate_source"] =
    input.observedRate !== null
      ? "observed"
      : rate !== null
        ? "average"
        : "unknown";
  let delay = 0;
  let ratio: number | null = null;
  let throttling = false;
  if (u >= 100) {
    throttling = true;
    delay = MAX_PACING_DELAY_MS;
  } else if (rate !== null) {
    ratio = rate / sustainable;
    throttling = rate > sustainable;
    if (input.observedRate !== null) {
      delay = input.heldDelayMs;
    } else if (throttling) {
      delay = gapMs === null ? 0 : gapMs * (ratio - 1);
    }
  }
  return {
    window: input.window,
    used: u,
    resets_at: input.resetsAt,
    sustainable_rate: sustainable * HOUR_MS,
    current_rate: rate === null ? null : rate * HOUR_MS,
    rate_source: source,
    ratio,
    throttling,
    delay_ms: Math.min(MAX_PACING_DELAY_MS, delay),
  };
}

/** Largest window delay, capped at {@link MAX_PACING_DELAY_MS}; pure. */
export function computePacingDelayMs(
  windows: PacingWindowInput[],
  gapMs: number | null,
  now: number,
): number {
  let delay = 0;
  for (const w of windows) {
    const status = evaluatePacingWindow(w, gapMs, now);
    if (status) delay = Math.max(delay, status.delay_ms);
  }
  return delay;
}

function windowInputs(
  rows: ProviderQuotaRow[],
  provider: string,
  account: string,
  now: number,
): PacingWindowInput[] {
  const latest = new Map<string, ProviderQuotaRow>();
  for (const row of rows) {
    if (
      row.provider !== provider ||
      row.account !== account ||
      row.authKind !== "subscription" ||
      !PACING_WINDOWS.has(row.window)
    ) {
      continue;
    }
    const prev = latest.get(row.window);
    if (!prev || row.observedAt > prev.observedAt) latest.set(row.window, row);
  }
  const out: PacingWindowInput[] = [];
  for (const row of latest.values()) {
    if (isProviderQuotaStale(row, now)) continue;
    const used = quotaPercentOf(row);
    if (used === null || row.resetsAt === null || row.windowMinutes === null) {
      continue;
    }
    const track = rateTracks.get(trackKey(provider, account, row.window));
    const current =
      track && track.resetsAt === row.resetsAt && track.samples >= 2
        ? track
        : null;
    const observedRate = current?.rate ?? null;
    out.push({
      window: row.window,
      used,
      resetsAt: row.resetsAt,
      windowMs: row.windowMinutes * 60_000,
      observedRate,
      heldDelayMs: current?.held ?? 0,
    });
  }
  return out.sort((a, b) => a.window.localeCompare(b.window));
}

function statusFor(
  rows: ProviderQuotaRow[],
  provider: string,
  account: string,
  enabled: boolean,
  now: number,
): ProviderPacingStatus {
  const gap = requestGaps.get(trackKey(provider, account))?.gap ?? null;
  const windows = windowInputs(rows, provider, account, now)
    .map((w) => evaluatePacingWindow(w, gap, now))
    .filter((w): w is PacingWindowStatus => w !== null);
  return {
    provider,
    account,
    enabled,
    throttling: enabled && windows.some((w) => w.throttling),
    delay_ms: enabled
      ? windows.reduce((max, w) => Math.max(max, w.delay_ms), 0)
      : 0,
    request_gap_ms: gap,
    windows,
  };
}

/** Foreground pacing delay for an attribution; 0 when off or unpaced. */
export function pacingDelayMs(
  match: BudgetMatch | null,
  now = Date.now(),
): number {
  if (!match || match.auth_kind !== "subscription") return 0;
  if (!isPacingEnabled(match.provider, match.account)) return 0;
  return statusFor(
    listProviderQuotas(),
    match.provider,
    match.account,
    true,
    now,
  ).delay_ms;
}

/** Curation pauses while the account's pacing is throttling (ρ > 1 or u ≥ 100). */
export function isCurationPacingPaused(
  match: BudgetMatch | null,
  now = Date.now(),
): boolean {
  if (!match || match.auth_kind !== "subscription") return false;
  if (!isPacingEnabled(match.provider, match.account)) return false;
  return statusFor(
    listProviderQuotas(),
    match.provider,
    match.account,
    true,
    now,
  ).throttling;
}

/** Pacing status for every subscription account with 5h / 7d quota rows. */
export function evaluateProviderPacing(
  now = Date.now(),
): ProviderPacingStatus[] {
  const rows = listProviderQuotas();
  const disabled = new Set(
    getPacingSettings()
      .filter((s) => !s.enabled)
      .map((s) => trackKey(s.provider, s.account)),
  );
  const accounts = new Map<string, { provider: string; account: string }>();
  for (const row of rows) {
    if (row.authKind !== "subscription" || !PACING_WINDOWS.has(row.window)) {
      continue;
    }
    accounts.set(trackKey(row.provider, row.account), {
      provider: row.provider,
      account: row.account,
    });
  }
  return [...accounts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, { provider, account }]) =>
      statusFor(rows, provider, account, !disabled.has(key), now),
    );
}

/** Budget attribution for a session's last upstream; null when unknown. */
export function sessionBudgetMatch(
  sessionID: string,
  upstream?: { providerID?: string; url?: string },
  requestHeaders?: Headers | Record<string, string> | null,
): BudgetMatch | null {
  const attribution = resolveCostAttribution({
    sessionID,
    providerID: upstream?.providerID,
    upstreamURL: upstream?.url,
    credential: resolveAuth(sessionID, upstream?.providerID),
    requestHeaders,
  });
  if (attribution.provider === "unknown") return null;
  return {
    provider: attribution.provider,
    auth_kind: attribution.authKind,
    account: attribution.account,
  };
}

/**
 * {@link isCurationPacingPaused} for a session's last upstream. Never throws:
 * a DB failure must not break the caller.
 */
export function isSessionCurationPacingPaused(
  sessionID: string,
  upstream?: { providerID?: string; url?: string },
): boolean {
  try {
    return isCurationPacingPaused(sessionBudgetMatch(sessionID, upstream));
  } catch {
    return false;
  }
}
