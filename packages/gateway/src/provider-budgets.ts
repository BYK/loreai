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
 * - `u ≥ 100` → maximum gap recommendation; `ρ = r / s > 1` pauses background
 *   curation; `g` is the EWMA of observed foreground-request gaps, used only to
 *   estimate the controller's held extra gap.
 *
 * The largest window recommendation wins, capped at {@link MAX_PACING_DELAY_MS}.
 * It never delays a request. Curation pauses while the account is throttling;
 * distillation and the cache warmer never do. API-key accounts have no reset
 * window and are never paced.
 */

import {
  getKV,
  setKV,
  isProviderQuotaStale,
  listProviderQuotas,
  MAX_PROVIDER_PACING_SETTINGS,
  MAX_PROVIDER_PACING_GENERATIONS,
  type ProviderAuthKind,
  type ProviderQuotaRow,
} from "@loreai/core";
import { resolveAuth, type AuthCredential } from "./auth";
import {
  cachedAnthropicAccount,
  resolveCostAttribution,
} from "./cost-attribution";

export type PacingWindow = "5h" | "7d";

export type PacingSetting = {
  provider: string;
  account: string;
  enabled: boolean;
};

type PacingGenerationEntry = {
  provider: string;
  account: string;
  generation: number;
};

type PacingState = {
  settings: PacingSetting[];
  generations: PacingGenerationEntry[];
  valid: boolean;
};

// Prime before the gateway accepts requests. Request/response pacing fences
// only consult this in-memory snapshot and never synchronously read SQLite.
let pacingStateSnapshot: PacingState | null = null;
let providerQuotaRowsSnapshot: ProviderQuotaRow[] | null = null;

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
  /** Held integral extra-gap recommendation `d_w` (ms); needs an observed rate. */
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
  /** Estimate only; provider pacing never waits this long before dispatch. */
  recommended_extra_gap_ms: number;
};

export type ProviderPacingStatus = {
  provider: string;
  account: string;
  enabled: boolean;
  throttling: boolean;
  recommended_extra_gap_ms: number;
  /** EWMA of the gaps between this account's foreground requests. */
  request_gap_ms: number | null;
  windows: PacingWindowStatus[];
};

export const PROVIDER_PACING_KV_KEY = "provider_pacing";
/** Maximum extra-gap recommendation (60 s); it is never applied as a wait. */
export const MAX_PACING_DELAY_MS = 60_000;
/** Gaps this long are idle time, not an interval induced by pacing. */
const REQUEST_GAP_IDLE_MS = 5 * 60_000;
/** Minimum Δt between quota observations that count as a rate sample. */
export const MIN_SAMPLE_INTERVAL_MS = 60_000;
/** EWMA weight of the newest sample (rates and request gaps). */
export const PACING_EWMA_ALPHA = 0.3;
const HOUR_MS = 3_600_000;
const MAX_SETTINGS = MAX_PROVIDER_PACING_SETTINGS;
const MAX_PACING_TRACKS = 512;
const PROVIDER_RE = /^[a-z0-9._-]{1,64}$/;
const ACCOUNT_RE = /^(?:\*|[A-Za-z0-9._:-]{1,128})$/;
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

function samePacingSettings(
  left: readonly PacingSetting[],
  right: readonly PacingSetting[],
): boolean {
  return (
    left.length === right.length &&
    left.every((setting) =>
      right.some(
        (candidate) =>
          candidate.provider === setting.provider &&
          candidate.account === setting.account &&
          candidate.enabled === setting.enabled,
      ),
    )
  );
}

/** Stored switches and generations; invalid state never escapes this boundary. */
function readPacingState(): PacingState {
  let parsed: unknown;
  try {
    const raw = getKV(PROVIDER_PACING_KV_KEY);
    if (!raw) return { settings: [], generations: [], valid: true };
    parsed = JSON.parse(raw);
  } catch {
    return { settings: [], generations: [], valid: false };
  }
  let rawSettings: unknown[];
  let rawGenerations: unknown[];
  if (Array.isArray(parsed)) {
    // Read pre-v1 arrays during rolling upgrades; the next switch write
    // upgrades them to the versioned settings/generation envelope.
    if (parsed.length > MAX_SETTINGS) {
      return { settings: [], generations: [], valid: false };
    }
    rawSettings = parsed;
    rawGenerations = [];
  } else if (
    typeof parsed === "object" &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    (parsed as Record<string, unknown>).version === 1 &&
    Array.isArray((parsed as Record<string, unknown>).settings) &&
    Array.isArray((parsed as Record<string, unknown>).generations)
  ) {
    const envelope = parsed as Record<string, unknown>;
    if (
      Object.keys(envelope).some(
        (key) =>
          key !== "version" && key !== "settings" && key !== "generations",
      )
    ) {
      return { settings: [], generations: [], valid: false };
    }
    const state = parsed as { settings: unknown[]; generations: unknown[] };
    if (
      state.settings.length > MAX_SETTINGS ||
      state.generations.length > MAX_PROVIDER_PACING_GENERATIONS
    ) {
      return { settings: [], generations: [], valid: false };
    }
    rawSettings = state.settings;
    rawGenerations = state.generations;
  } else {
    return { settings: [], generations: [], valid: false };
  }

  const settings: PacingSetting[] = [];
  const seen = new Set<string>();
  for (const entry of rawSettings) {
    const setting = parseSetting(entry);
    if (typeof setting === "string") {
      return { settings: [], generations: [], valid: false };
    }
    const key = `${setting.provider}\x1f${setting.account}`;
    if (seen.has(key)) return { settings: [], generations: [], valid: false };
    seen.add(key);
    settings.push(setting);
  }
  const generations: PacingGenerationEntry[] = [];
  const generationSeen = new Set<string>();
  for (const entry of rawGenerations) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { settings: [], generations: [], valid: false };
    }
    const row = entry as Record<string, unknown>;
    if (
      Object.keys(row).some(
        (key) =>
          key !== "provider" && key !== "account" && key !== "generation",
      )
    ) {
      return { settings: [], generations: [], valid: false };
    }
    if (
      typeof row.provider !== "string" ||
      !PROVIDER_RE.test(row.provider) ||
      typeof row.account !== "string" ||
      !ACCOUNT_RE.test(row.account) ||
      !Number.isSafeInteger(row.generation) ||
      (row.generation as number) < 0
    ) {
      return { settings: [], generations: [], valid: false };
    }
    const key = `${row.provider}\x1f${row.account}`;
    if (generationSeen.has(key))
      return { settings: [], generations: [], valid: false };
    generationSeen.add(key);
    generations.push({
      provider: row.provider,
      account: row.account,
      generation: row.generation as number,
    });
  }
  return { settings, generations, valid: true };
}

function refreshPacingStateSnapshot(): PacingState {
  const state = readPacingState();
  pacingStateSnapshot = state;
  return state;
}

/** Load durable switches and generations before the gateway accepts requests. */
export function initializeProviderPacingState(): void {
  refreshPacingStateSnapshot();
  refreshProviderQuotaRowsSnapshot();
}

function refreshProviderQuotaRowsSnapshot(): void {
  try {
    providerQuotaRowsSnapshot = listProviderQuotas();
  } catch {
    // Foreground curation gates fail open when the startup snapshot is unavailable.
    providerQuotaRowsSnapshot = [];
  }
}

/** Keep the foreground curation snapshot current after an accepted quota write. */
export function recordProviderQuotaSnapshot(row: ProviderQuotaRow): void {
  const rows = providerQuotaRowsSnapshot;
  if (!rows) return;
  const index = rows.findIndex(
    (existing) =>
      existing.provider === row.provider &&
      existing.authKind === row.authKind &&
      existing.account === row.account &&
      existing.window === row.window,
  );
  if (index === -1) rows.push(row);
  else rows[index] = row;
}

/** Stored switches; invalid or duplicate state disables pacing. Never throws. */
export function getPacingSettings(): PacingSetting[] {
  return refreshPacingStateSnapshot().settings.map((setting) => ({
    ...setting,
  }));
}

function pacingGeneration(
  state: PacingState,
  provider: string,
  account: string,
): string {
  const generationFor = (target: string): number =>
    state.generations.find(
      (entry) => entry.provider === provider && entry.account === target,
    )?.generation ?? 0;
  return `${generationFor("*")}:${generationFor(account)}`;
}

function pacingEnabledInState(
  state: PacingState,
  provider: string,
  account: string,
): boolean {
  const exact = state.settings.find(
    (entry) => entry.provider === provider && entry.account === account,
  );
  if (exact) return exact.enabled;
  const providerDefault = state.settings.find(
    (entry) => entry.provider === provider && entry.account === "*",
  );
  return providerDefault ? providerDefault.enabled : true;
}

/** Snapshot the switch generation at request start for late-response fencing. */
export function capturePacingGeneration(
  match: Pick<BudgetMatch, "provider" | "account" | "auth_kind">,
): string | null {
  if (match.auth_kind !== "subscription") return null;
  const state = pacingStateSnapshot;
  if (!state?.valid) return null;
  return pacingGeneration(state, match.provider, match.account);
}

/** True only while a request's captured pacing generation is still current. */
export function isPacingGenerationCurrent(
  match: Pick<BudgetMatch, "provider" | "account" | "auth_kind">,
  generation: string | null,
): boolean {
  if (match.auth_kind !== "subscription") return true;
  if (generation === null) return false;
  const state = pacingStateSnapshot;
  return (
    state?.valid === true &&
    pacingGeneration(state, match.provider, match.account) === generation
  );
}

/** Capture a provider epoch when the response may reveal its account identity. */
export function capturePacingEpoch(
  match: Pick<BudgetMatch, "provider" | "auth_kind">,
): number | null {
  if (match.auth_kind !== "subscription") return null;
  // This runs before dispatch. Its process-local fence stays synchronous and
  // does not turn an optional database read into foreground request latency.
  return providerPacingEpochs.get(match.provider) ?? 0;
}

/** Reject late quota responses after any switch for their provider changes. */
export function isPacingEpochCurrent(
  match: Pick<BudgetMatch, "provider" | "auth_kind">,
  epoch: number | null,
): boolean {
  if (match.auth_kind !== "subscription") return true;
  if (epoch === null) return false;
  return (providerPacingEpochs.get(match.provider) ?? 0) === epoch;
}

/** Store one account's switch (a missing entry means enabled). */
export function setPacingEnabled(input: PacingSetting): boolean {
  const setting = parseSetting(input);
  if (typeof setting === "string") return false;
  const state = refreshPacingStateSnapshot();
  if (!state.valid) return false;
  const hasExactSetting = state.settings.some(
    (entry) =>
      entry.provider === setting.provider && entry.account === setting.account,
  );
  // A per-account switch that already matches its inherited provider default
  // must not spend a durable generation or a settings slot.
  if (
    setting.account !== "*" &&
    !hasExactSetting &&
    pacingEnabledInState(state, setting.provider, setting.account) ===
      setting.enabled
  ) {
    return true;
  }
  const rest = state.settings.filter(
    (s) => s.provider !== setting.provider || s.account !== setting.account,
  );
  const inheritedOptOut =
    setting.account !== "*" &&
    rest.some(
      (s) => s.provider === setting.provider && s.account === "*" && !s.enabled,
    );
  const next = setting.enabled && !inheritedOptOut ? rest : [...rest, setting];
  if (next.length > MAX_SETTINGS) return false;
  // A no-op must not consume a durable identity generation or invalidate
  // quota observations; caller-controlled accounts could otherwise exhaust
  // the bounded fence without changing any setting.
  if (samePacingSettings(next, state.settings)) return true;
  const generationIndex = state.generations.findIndex(
    (entry) =>
      entry.provider === setting.provider && entry.account === setting.account,
  );
  const currentGeneration =
    generationIndex < 0
      ? 0
      : (state.generations[generationIndex]?.generation ?? 0);
  if (!Number.isSafeInteger(currentGeneration + 1)) return false;
  if (
    generationIndex < 0 &&
    state.generations.length >= MAX_PROVIDER_PACING_GENERATIONS
  ) {
    return false;
  }
  const currentEpoch = providerPacingEpochs.get(setting.provider) ?? 0;
  if (!Number.isSafeInteger(currentEpoch + 1)) return false;
  const generation: PacingGenerationEntry = {
    provider: setting.provider,
    account: setting.account,
    generation: currentGeneration + 1,
  };
  const generations = [...state.generations];
  if (
    generationIndex < 0 &&
    generations.length < MAX_PROVIDER_PACING_GENERATIONS
  ) {
    generations.push(generation);
  } else if (generationIndex >= 0) {
    generations[generationIndex] = generation;
  }
  setKV(
    PROVIDER_PACING_KV_KEY,
    JSON.stringify({ version: 1, settings: next, generations }),
  );
  pacingStateSnapshot = { settings: next, generations, valid: true };
  providerPacingEpochs.set(setting.provider, currentEpoch + 1);
  if (!setting.enabled) {
    // Disabling pacing discards every held recommendation so toggling
    // it back on can never revive stale controller state.
    if (setting.account === "*") {
      const prefix = `${setting.provider}\x1f`;
      for (const key of rateTracks.keys()) {
        if (key.startsWith(prefix)) rateTracks.delete(key);
      }
      for (const key of requestGaps.keys()) {
        if (key.startsWith(prefix)) requestGaps.delete(key);
      }
    } else {
      for (const window of PACING_WINDOWS) {
        rateTracks.delete(trackKey(setting.provider, setting.account, window));
      }
      requestGaps.delete(trackKey(setting.provider, setting.account));
    }
  }
  return true;
}

export function isPacingEnabled(provider: string, account: string): boolean {
  const state = pacingStateSnapshot;
  return (
    state?.valid === true && pacingEnabledInState(state, provider, account)
  );
}

// ---------------------------------------------------------------------------
// In-memory rate tracker

type RateTrack = {
  generation: string;
  resetsAt: number | null;
  lastUsed: number;
  lastAt: number;
  samples: number;
  rate: number | null;
  /** Held integral-controller extra-gap recommendation `d_w` (ms). */
  held: number;
};

const rateTracks = new Map<string, RateTrack>();
const requestGaps = new Map<
  string,
  { generation: string; lastAt: number; gap: number | null }
>();
const providerPacingEpochs = new Map<string, number>();

function trackKey(provider: string, account: string, window?: string): string {
  return window === undefined
    ? `${provider}\x1f${account}`
    : `${provider}\x1f${account}\x1f${window}`;
}

function requestGapForGeneration(
  provider: string,
  account: string,
  generation: string | null,
): number | null {
  if (generation === null) return null;
  const entry = requestGaps.get(trackKey(provider, account));
  return entry?.generation === generation ? entry.gap : null;
}

function ewma(previous: number | null, sample: number): number {
  return previous === null
    ? sample
    : PACING_EWMA_ALPHA * sample + (1 - PACING_EWMA_ALPHA) * previous;
}

function rememberTrack<T>(map: Map<string, T>, key: string, value: T): void {
  // Caller-controlled identities must never grow process memory without bound,
  // and a new identity must never evict an established account's pacing state.
  if (!map.has(key) && map.size >= MAX_PACING_TRACKS) return;
  map.delete(key);
  map.set(key, value);
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
export function recordQuotaObservation(
  row: ProviderQuotaRow,
  observedGeneration?: string | null,
): void {
  if (row.authKind !== "subscription" || !PACING_WINDOWS.has(row.window)) {
    return;
  }
  if (row.account === "*") return;
  const match: BudgetMatch = {
    provider: row.provider,
    auth_kind: row.authKind,
    account: row.account,
  };
  const generation =
    observedGeneration === undefined
      ? capturePacingGeneration(match)
      : observedGeneration;
  if (generation === null || !isPacingGenerationCurrent(match, generation)) {
    return;
  }
  if (!isPacingEnabled(row.provider, row.account)) return;
  const used = quotaPercentOf(row);
  if (used === null) return;
  const key = trackKey(row.provider, row.account, row.window);
  const previousTrack = rateTracks.get(key);
  const track =
    previousTrack?.generation === generation ? previousTrack : undefined;
  if (track && row.observedAt < track.lastAt) return;
  if (!track || track.resetsAt !== row.resetsAt || used < track.lastUsed) {
    rememberTrack(rateTracks, key, {
      generation,
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
  if (dt < MIN_SAMPLE_INTERVAL_MS) {
    rememberTrack(rateTracks, key, track);
    return;
  }
  const rate = ewma(track.rate, (used - track.lastUsed) / dt);
  track.rate = rate;
  track.lastUsed = used;
  track.lastAt = row.observedAt;
  track.samples++;
  const T = row.resetsAt === null ? 0 : row.resetsAt - row.observedAt;
  if (used >= 100) {
    track.held = MAX_PACING_DELAY_MS;
  } else if (T > 0) {
    const gap = requestGapForGeneration(row.provider, row.account, generation);
    track.held = integrateHeldDelayMs(
      track.held,
      gap,
      rate / ((100 - used) / T),
    );
  }
  rememberTrack(rateTracks, key, track);
}

/**
 * Update the status-only extra-gap recommendation per accepted rate sample:
 * `d_w ← clamp(d_w + g · (ρ − 1), 0, MAX)`. No gap estimate yet → unchanged.
 */
export function integrateHeldDelayMs(
  held: number,
  gapMs: number | null,
  ratio: number,
): number {
  if (gapMs === null || !Number.isFinite(ratio)) return held;
  return clamp(held + gapMs * (ratio - 1), 0, MAX_PACING_DELAY_MS);
}

/** Record a foreground request start for the status-only gap EWMA. */
export function recordForegroundRequest(
  match: BudgetMatch | null,
  now = Date.now(),
  observedGeneration?: string | null,
): void {
  if (!match || match.auth_kind !== "subscription") return;
  if (match.account === "*") return;
  const generation =
    observedGeneration === undefined
      ? capturePacingGeneration(match)
      : observedGeneration;
  if (generation === null || !isPacingGenerationCurrent(match, generation)) {
    return;
  }
  if (!isPacingEnabled(match.provider, match.account)) return;
  const key = trackKey(match.provider, match.account);
  const entry = requestGaps.get(key);
  if (!entry) {
    rememberTrack(requestGaps, key, { generation, lastAt: now, gap: null });
    return;
  }
  if (entry.generation !== generation) {
    rememberTrack(requestGaps, key, { generation, lastAt: now, gap: null });
    return;
  }
  if (now > entry.lastAt) {
    // A resumed session starts a fresh cadence; never treat the idle pause as
    // a pacing interval, or the integral controller can jump to its 60 s cap.
    const gap = now - entry.lastAt;
    entry.gap = gap >= REQUEST_GAP_IDLE_MS ? null : ewma(entry.gap, gap);
    entry.lastAt = now;
    rememberTrack(requestGaps, key, entry);
  }
}

export function _resetPacingTrackerForTest(): void {
  rateTracks.clear();
  requestGaps.clear();
  providerPacingEpochs.clear();
  refreshPacingStateSnapshot();
  refreshProviderQuotaRowsSnapshot();
}

export function _pacingTrackerSizesForTest(): {
  rateTracks: number;
  requestGaps: number;
} {
  return { rateTracks: rateTracks.size, requestGaps: requestGaps.size };
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
  if (u >= 100) {
    delay = MAX_PACING_DELAY_MS;
  } else if (rate !== null) {
    ratio = rate / sustainable;
    if (input.observedRate !== null) {
      delay = input.heldDelayMs;
    } else if (ratio > 1) {
      delay = gapMs === null ? 0 : gapMs * (ratio - 1);
    }
  }
  delay = Math.min(MAX_PACING_DELAY_MS, delay);
  // A held delay counts too: at equilibrium ρ hovers around 1 while d_w > 0.
  const throttling = u >= 100 || delay > 0 || (ratio !== null && ratio > 1);
  return {
    window: input.window,
    used: u,
    resets_at: input.resetsAt,
    sustainable_rate: sustainable * HOUR_MS,
    current_rate: rate === null ? null : rate * HOUR_MS,
    rate_source: source,
    ratio,
    throttling,
    recommended_extra_gap_ms: delay,
  };
}

/** Largest recommended request-gap increase; never delays a request. */
export function computePacingDelayMs(
  windows: PacingWindowInput[],
  gapMs: number | null,
  now: number,
): number {
  let delay = 0;
  for (const w of windows) {
    const status = evaluatePacingWindow(w, gapMs, now);
    if (status) delay = Math.max(delay, status.recommended_extra_gap_ms);
  }
  return delay;
}

function windowInputs(
  rows: ProviderQuotaRow[],
  provider: string,
  account: string,
  now: number,
  generation: string | null,
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
      generation !== null &&
      track?.generation === generation &&
      track.resetsAt === row.resetsAt &&
      track.samples >= 2
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
  let generation: string | null = null;
  try {
    generation = capturePacingGeneration({
      provider,
      account,
      auth_kind: "subscription",
    });
  } catch {
    // Pacing is optional: a closed database disables its status only.
  }
  const gap = requestGapForGeneration(provider, account, generation);
  const evaluatedWindows = windowInputs(
    rows,
    provider,
    account,
    now,
    generation,
  )
    .map((w) => evaluatePacingWindow(w, gap, now))
    .filter((w): w is PacingWindowStatus => w !== null);
  // Disabled accounts keep quota rates visible, but never report an active
  // curation pause or a recommended gap.
  const windows = enabled
    ? evaluatedWindows
    : evaluatedWindows.map((window) => ({
        ...window,
        throttling: false,
        recommended_extra_gap_ms: 0,
      }));
  return {
    provider,
    account,
    enabled,
    throttling: windows.some((w) => w.throttling),
    recommended_extra_gap_ms: windows.reduce(
      (max, w) => Math.max(max, w.recommended_extra_gap_ms),
      0,
    ),
    request_gap_ms: gap,
    windows,
  };
}

/** Estimated request-gap increase for diagnostics; never delays a request. */
export function pacingDelayMs(
  match: BudgetMatch | null,
  now = Date.now(),
): number {
  if (!match || match.auth_kind !== "subscription") return 0;
  try {
    if (!isPacingEnabled(match.provider, match.account)) return 0;
    return statusFor(
      listProviderQuotas(),
      match.provider,
      match.account,
      true,
      now,
    ).recommended_extra_gap_ms;
  } catch {
    return 0;
  }
}

/** Curation pauses while the account's pacing is throttling (ρ > 1 or u ≥ 100). */
export function isCurationPacingPaused(
  match: BudgetMatch | null,
  now = Date.now(),
): boolean {
  if (!match || match.auth_kind !== "subscription") return false;
  try {
    if (!isPacingEnabled(match.provider, match.account)) return false;
    return statusFor(
      listProviderQuotas(),
      match.provider,
      match.account,
      true,
      now,
    ).throttling;
  } catch {
    return false;
  }
}

/** Pacing status for every subscription account with 5h / 7d quota rows. */
export function evaluateProviderPacing(
  now = Date.now(),
): ProviderPacingStatus[] {
  const rows = listProviderQuotas();
  const state = readPacingState();
  const settings = state.settings;
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
  for (const setting of settings) {
    if (setting.account === "*") continue;
    accounts.set(trackKey(setting.provider, setting.account), {
      provider: setting.provider,
      account: setting.account,
    });
  }
  return [...accounts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([_key, { provider, account }]) =>
      statusFor(
        rows,
        provider,
        account,
        state.valid && pacingEnabledInState(state, provider, account),
        now,
      ),
    );
}

/** Budget attribution for a session's last upstream; null when unknown. */
export function sessionBudgetMatch(
  sessionID: string,
  upstream?: { providerID?: string; url?: string },
  requestHeaders?: Headers | Record<string, string> | null,
  credentialOverride?: AuthCredential | null,
): BudgetMatch | null {
  const credential =
    credentialOverride ?? resolveAuth(sessionID, upstream?.providerID);
  const attribution = resolveCostAttribution({
    sessionID,
    providerID: upstream?.providerID,
    upstreamURL: upstream?.url,
    credential,
    requestHeaders,
  });
  if (attribution.provider === "unknown") return null;
  return {
    provider: attribution.provider,
    auth_kind: attribution.authKind,
    account:
      attribution.provider === "anthropic"
        ? (cachedAnthropicAccount(credential, sessionID) ?? attribution.account)
        : attribution.account,
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
    const match = sessionBudgetMatch(sessionID, upstream);
    if (!match || match.auth_kind !== "subscription") return false;
    if (!isPacingEnabled(match.provider, match.account)) return false;
    return statusFor(
      providerQuotaRowsSnapshot ?? [],
      match.provider,
      match.account,
      true,
      Date.now(),
    ).throttling;
  } catch {
    return false;
  }
}
