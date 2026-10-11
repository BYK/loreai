/**
 * Daily model-usage statistics (#2026): counts of distinct sessions per
 * (UTC day, provider/model) over `temporal_messages`, exported in the
 * model-tides "daily" document format (format/version/constants ported from
 * model-tides src/daily-usage.ts and src/weekly-snapshot.ts).
 */
import { createHash } from "node:crypto";

import { db } from "./db";
import { sql } from "./sql";
import { currentTenantId } from "./tenant";
import {
  isReadJobFailure,
  offloadAllOrTimeout,
  type ReadJobFailure,
} from "./read-offload";

// Ported from model-tides src/daily-usage.ts.
export const DAILY_FORMAT = "model-tides-daily";
export const DAILY_VERSION = 2;
export const MAX_DAILY_CELLS = 200_000;
// Ported from model-tides src/weekly-snapshot.ts.
export const MIN_WEEK_TIME = Date.UTC(1999, 11, 27);
export const FUTURE_MARGIN_MS = 7 * 86_400_000;

export interface DailyUsageDocument {
  readonly format: typeof DAILY_FORMAT;
  readonly version: typeof DAILY_VERSION;
  readonly source: "lore";
  readonly days: readonly {
    readonly day: string;
    readonly models: Readonly<Record<string, number>>;
  }[];
}

/** Ported verbatim (behaviour) from model-tides src/weekly-snapshot.ts. */
export function validWeeklyModel(model: unknown): model is string {
  return (
    typeof model === "string" &&
    model.length > 0 &&
    model.length <= 320 &&
    model === model.trim() &&
    // oxlint-disable-next-line no-control-regex -- intentional control-character validation
    !/[\u0000-\u001f\u007f\ud800-\udfff]/u.test(model)
  );
}

export class ModelUsageFilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelUsageFilterError";
  }
}

export class ModelUsageLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelUsageLimitError";
  }
}

/** The read-worker pool could not serve the aggregate scan (timeout/pressure). */
export class ModelUsageUnavailableError extends Error {
  constructor() {
    super("Model usage statistics are temporarily unavailable");
    this.name = "ModelUsageUnavailableError";
  }
}

export interface ModelUsageFilter {
  /** Inclusive UTC day bound, `YYYY-MM-DD`. */
  from?: string;
  /** Inclusive UTC day bound, `YYYY-MM-DD`. */
  to?: string;
  /** Internal project id; scopes counts to that project. */
  projectId?: string;
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function dayStartMs(day: string, field: "from" | "to"): number {
  if (!DAY_PATTERN.test(day)) {
    throw new ModelUsageFilterError(
      `${field} must be a YYYY-MM-DD date, received: ${day}`,
    );
  }
  const time = Date.parse(`${day}T00:00:00Z`);
  if (
    !Number.isSafeInteger(time) ||
    new Date(time).toISOString().slice(0, 10) !== day
  ) {
    throw new ModelUsageFilterError(
      `${field} is not a real calendar date: ${day}`,
    );
  }
  return time;
}

/**
 * Count distinct `(project_id, session_id)` pairs per (UTC day, model) for
 * stored assistant messages with provider/model metadata. Sessions are the
 * unit (matching model-tides daily counts), not messages.
 */
export async function buildDailyModelUsage(
  filter: ModelUsageFilter = {},
): Promise<DailyUsageDocument> {
  let fromMs: number | undefined;
  let toExclusiveMs: number | undefined;
  if (filter.from !== undefined) {
    fromMs = dayStartMs(filter.from, "from");
  }
  if (filter.to !== undefined) {
    toExclusiveMs = dayStartMs(filter.to, "to") + 86_400_000;
  }
  if (
    fromMs !== undefined &&
    toExclusiveMs !== undefined &&
    fromMs >= toExclusiveMs
  ) {
    throw new ModelUsageFilterError(
      `from must not be after to: ${filter.from} > ${filter.to}`,
    );
  }

  const conditions = sql.and([
    sql`t.role = ${"assistant"}`,
    sql`typeof(json_extract(t.metadata, '$.providerID')) = 'text'`,
    sql`json_extract(t.metadata, '$.providerID') <> ''`,
    sql`typeof(json_extract(t.metadata, '$.modelID')) = 'text'`,
    sql`json_extract(t.metadata, '$.modelID') <> ''`,
    sql`json_extract(t.metadata, '$.modelID') NOT IN ('unknown', 'gateway')`,
    fromMs !== undefined ? sql`t.created_at >= ${fromMs}` : undefined,
    toExclusiveMs !== undefined
      ? sql`t.created_at < ${toExclusiveMs}`
      : undefined,
    filter.projectId !== undefined
      ? sql`t.project_id = ${filter.projectId}`
      : undefined,
  ]);

  // LIMIT keeps an oversized range from materialising unbounded rows; the JS
  // side then counts exactly MAX_DAILY_CELLS + 1 cells and throws.
  const query = sql`
    SELECT date(t.created_at / 1000, 'unixepoch') AS day,
           json_extract(t.metadata, '$.providerID') || '/' ||
             json_extract(t.metadata, '$.modelID') AS model,
           COUNT(DISTINCT t.project_id || x'1f' || t.session_id) AS sessions
    FROM temporal_messages t
    JOIN projects p ON p.id = t.project_id AND p.tenant_id = ${currentTenantId()}
    WHERE ${conditions}
    GROUP BY day, model
    ORDER BY day, model
    LIMIT ${MAX_DAILY_CELLS + 1}`;

  // Offload the GROUP BY scan to the read-worker pool: on real databases the
  // unfiltered aggregate would block the gateway event loop for hundreds of
  // milliseconds. No per-call deadline exists — the pool's shared
  // vectorSearchTimeoutMs() applies (default 10s).
  const rows = (await offloadAllOrTimeout(query.text, [...query.params], {
    telemetryKind: "model-usage",
  })) as { day: string; model: string; sessions: number }[] | ReadJobFailure;
  if (isReadJobFailure(rows)) {
    throw new ModelUsageUnavailableError();
  }
  if (rows.length > MAX_DAILY_CELLS) {
    throw new ModelUsageLimitError(
      `Model usage result exceeds ${MAX_DAILY_CELLS} model-day cells`,
    );
  }

  const latest = Date.now() + FUTURE_MARGIN_MS;
  const byDay = new Map<string, Map<string, number>>();
  let cells = 0;
  for (const row of rows) {
    if (!validWeeklyModel(row.model)) continue;
    if (!Number.isSafeInteger(row.sessions) || row.sessions < 1) continue;
    const dayTime = Date.parse(`${row.day}T00:00:00Z`);
    if (
      !Number.isSafeInteger(dayTime) ||
      dayTime < MIN_WEEK_TIME ||
      dayTime > latest
    ) {
      continue;
    }
    cells++;
    if (cells > MAX_DAILY_CELLS) {
      throw new ModelUsageLimitError(
        `Model usage result exceeds ${MAX_DAILY_CELLS} model-day cells`,
      );
    }
    let models = byDay.get(row.day);
    if (!models) byDay.set(row.day, (models = new Map()));
    models.set(row.model, row.sessions);
  }

  const days = [...byDay]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, models]) => ({
      day,
      models: Object.fromEntries(
        [...models].sort(([a], [b]) => a.localeCompare(b)),
      ),
    }));
  return {
    format: DAILY_FORMAT,
    version: DAILY_VERSION,
    source: "lore",
    days,
  };
}

// ---------------------------------------------------------------------------
// Weekly snapshot + owner credential (#2026 PR3, consented Model Tides upload).
// Everything below ports model-tides src/weekly-snapshot.ts and
// scripts/contribute.mjs verbatim in behaviour.
// ---------------------------------------------------------------------------

// Ported from model-tides src/weekly-snapshot.ts.
export const WEEKLY_FORMAT = "model-tides-weekly";
export const WEEKLY_VERSION = 2;
export const MAX_WEEKS = 520;
export const MAX_WEEKLY_CELLS = 2048;
export const MAX_MODEL_COUNT = 10_000;
export const MAX_REVIEW_CELLS = 8192;
// Stored reports may predate the upload limits, which bound uploads only.
export const MAX_REVIEW_WEEKS = 2048;
const WEEK_MS = 7 * 86_400_000;
const weekPattern = /^\d{4}-\d{2}-\d{2}$/;

export interface WeeklySnapshot {
  readonly format: typeof WEEKLY_FORMAT;
  readonly version: 1 | typeof WEEKLY_VERSION;
  readonly weeks: readonly {
    readonly week: string;
    readonly models: Readonly<Record<string, number>>;
  }[];
}

export interface OwnedReport {
  readonly id: string;
  readonly published: boolean;
  readonly inAggregate: boolean | null;
  readonly revision: number;
  readonly metricVersion: 1 | typeof WEEKLY_VERSION;
  readonly snapshot: WeeklySnapshot | null;
}

/** Ported verbatim (behaviour) from model-tides src/weekly-snapshot.ts. */
export function weekStart(time: number): string {
  if (
    !Number.isSafeInteger(time) ||
    time < MIN_WEEK_TIME ||
    time > Date.now() + FUTURE_MARGIN_MS
  ) {
    throw new RangeError("The event date is outside the supported range.");
  }
  // Thursday 1970-01-01 is three days after Monday.
  return new Date(
    Math.floor((time + 3 * 86_400_000) / WEEK_MS) * WEEK_MS - 3 * 86_400_000,
  )
    .toISOString()
    .slice(0, 10);
}

function exactKeys(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}

function parseSnapshotWithLimits(
  input: unknown,
  maxWeeks: number,
  maxCells: number,
): WeeklySnapshot {
  if (
    !exactKeys(input, ["format", "version", "weeks"]) ||
    input.format !== WEEKLY_FORMAT ||
    (input.version !== 1 && input.version !== WEEKLY_VERSION) ||
    !Array.isArray(input.weeks) ||
    input.weeks.length < 1 ||
    input.weeks.length > maxWeeks
  ) {
    throw new TypeError("Invalid weekly snapshot.");
  }
  const seen = new Set<string>();
  const weeks: { week: string; models: Record<string, number> }[] = [];
  const latest = Date.now() + FUTURE_MARGIN_MS;
  const cells = input.weeks.reduce<number>((total, item: unknown) => {
    if (
      !exactKeys(item, ["week", "models"]) ||
      typeof item.week !== "string" ||
      !weekPattern.test(item.week) ||
      seen.has(item.week) ||
      !item.models ||
      typeof item.models !== "object" ||
      Array.isArray(item.models)
    ) {
      throw new TypeError("Invalid weekly snapshot.");
    }
    const date = Date.parse(`${item.week}T00:00:00Z`);
    if (
      !Number.isFinite(date) ||
      date < MIN_WEEK_TIME ||
      date > latest ||
      weekStart(date) !== item.week
    ) {
      throw new TypeError("Invalid weekly snapshot.");
    }
    const entries = Object.entries(item.models);
    if (
      entries.length > maxCells ||
      entries.some(
        ([model, count]) =>
          !validWeeklyModel(model) ||
          !Number.isSafeInteger(count) ||
          (count as number) < 1 ||
          (count as number) > MAX_MODEL_COUNT,
      )
    ) {
      throw new TypeError("Invalid weekly snapshot.");
    }
    seen.add(item.week);
    weeks.push({ week: item.week, models: Object.fromEntries(entries) });
    return total + entries.length;
  }, 0);
  if (cells < 1 || cells > maxCells)
    throw new TypeError("Invalid weekly snapshot.");
  return { format: WEEKLY_FORMAT, version: input.version, weeks };
}

export function parseSnapshot(input: unknown): WeeklySnapshot {
  return parseSnapshotWithLimits(input, MAX_WEEKS, MAX_WEEKLY_CELLS);
}

export function parseOwnedReport(input: unknown, id: string): OwnedReport {
  const hasAggregate =
    input !== null && typeof input === "object" && "inAggregate" in input;
  const hasMetric =
    input !== null && typeof input === "object" && "metricVersion" in input;
  const fields = [
    ...(hasAggregate ? ["inAggregate"] : []),
    ...(hasMetric ? ["metricVersion"] : []),
  ];
  const oversized =
    exactKeys(input, ["id", "published", "revision", "tooLarge", ...fields]) &&
    input.tooLarge === true;
  if (
    (!oversized &&
      !exactKeys(input, [
        "id",
        "counts",
        "published",
        "revision",
        ...fields,
      ])) ||
    input.id !== id ||
    typeof input.published !== "boolean" ||
    !Number.isSafeInteger(input.revision) ||
    (input.revision as number) < 0 ||
    (hasAggregate && typeof input.inAggregate !== "boolean")
  ) {
    throw new TypeError("Invalid personal report.");
  }
  const inAggregate = hasAggregate ? (input.inAggregate as boolean) : null;
  const version = hasMetric ? input.metricVersion : 1;
  if (version !== 1 && version !== WEEKLY_VERSION)
    throw new TypeError("Invalid report metric.");
  if (oversized)
    return {
      id,
      published: input.published,
      inAggregate,
      revision: input.revision as number,
      metricVersion: version,
      snapshot: null,
    };
  if (
    !Array.isArray(input.counts) ||
    input.counts.length < 1 ||
    input.counts.length > MAX_REVIEW_CELLS
  ) {
    throw new TypeError("Invalid personal report.");
  }
  const weeks = new Map<string, Map<string, number>>();
  for (const row of input.counts) {
    if (
      !exactKeys(row, ["week", "model", "count"]) ||
      typeof row.week !== "string" ||
      !validWeeklyModel(row.model) ||
      !Number.isSafeInteger(row.count) ||
      (row.count as number) < 1 ||
      (row.count as number) > MAX_MODEL_COUNT
    ) {
      throw new TypeError("Invalid personal report.");
    }
    const models = weeks.get(row.week) ?? new Map<string, number>();
    if (models.has(row.model)) throw new TypeError("Invalid personal report.");
    models.set(row.model, row.count as number);
    weeks.set(row.week, models);
  }
  const snapshot = parseSnapshotWithLimits(
    {
      format: WEEKLY_FORMAT,
      version,
      weeks: [...weeks]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([week, models]) => ({
          week,
          models: Object.fromEntries(
            [...models].sort(([a], [b]) => a.localeCompare(b)),
          ),
        })),
    },
    MAX_REVIEW_WEEKS,
    MAX_REVIEW_CELLS,
  );
  return {
    id,
    published: input.published,
    inAggregate,
    revision: input.revision as number,
    metricVersion: version,
    snapshot,
  };
}

/**
 * Sum a daily document into Monday-UTC weekly counts — model-tides
 * buildActiveWeeklySnapshot. Limit breaches throw `ModelUsageLimitError`
 * naming the limit and the actual value (the gateway maps it to 422).
 */
export function buildWeeklySnapshot(doc: DailyUsageDocument): WeeklySnapshot {
  const weeks = new Map<string, Map<string, number>>();
  for (const { day, models: daily } of doc.days) {
    const week = weekStart(Date.parse(`${day}T00:00:00Z`));
    const models = weeks.get(week) ?? new Map<string, number>();
    for (const [model, count] of Object.entries(daily)) {
      models.set(model, (models.get(model) ?? 0) + count);
    }
    weeks.set(week, models);
  }
  if (weeks.size > MAX_WEEKS) {
    throw new ModelUsageLimitError(
      `Weekly snapshot has ${weeks.size} weeks; Model Tides accepts at most ${MAX_WEEKS}`,
    );
  }
  const cells = [...weeks.values()].reduce(
    (sum, models) => sum + models.size,
    0,
  );
  if (cells > MAX_WEEKLY_CELLS) {
    throw new ModelUsageLimitError(
      `Weekly snapshot has ${cells} model-week cells; Model Tides accepts at most ${MAX_WEEKLY_CELLS}`,
    );
  }
  // No usage yet → an empty snapshot (parseSnapshot requires >=1 week, which
  // is a server-side bound, not a reason to 500 on first-time users).
  if (weeks.size === 0) {
    return { format: WEEKLY_FORMAT, version: WEEKLY_VERSION, weeks: [] };
  }
  const peak = Math.max(
    0,
    ...[...weeks.values()].flatMap((models) => [...models.values()]),
  );
  if (peak > MAX_MODEL_COUNT) {
    throw new ModelUsageLimitError(
      `Weekly snapshot has a model count of ${peak}; Model Tides accepts at most ${MAX_MODEL_COUNT}`,
    );
  }
  return parseSnapshot({
    format: WEEKLY_FORMAT,
    version: WEEKLY_VERSION,
    weeks: [...weeks]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([week, models]) => ({
        week,
        models: Object.fromEntries(
          [...models].sort(([a], [b]) => a.localeCompare(b)),
        ),
      })),
  });
}

/** sha256 hex over exactly the bytes that get brotli-compressed for upload. */
export function snapshotSha256(snapshot: WeeklySnapshot): string {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

// ---------------------------------------------------------------------------
// Owner credential in kv_meta — model-tides' contribution.json, keyed per
// tenant because kv_meta itself is not tenant-scoped. The token is never
// logged and never leaves the gateway.
// ---------------------------------------------------------------------------

const OWNER_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OWNER_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export interface ModelTidesOwner {
  readonly id: string;
  readonly token: string;
}

const ownerKey = (): string => `model-tides.owner:${currentTenantId()}`;

function parseOwner(input: unknown): ModelTidesOwner {
  if (
    !exactKeys(input, ["id", "token"]) ||
    typeof input.id !== "string" ||
    !OWNER_ID_RE.test(input.id) ||
    typeof input.token !== "string" ||
    !OWNER_TOKEN_RE.test(input.token)
  ) {
    throw new Error("Invalid local private key.");
  }
  return { id: input.id, token: input.token };
}

export function loadOwner(): ModelTidesOwner | null {
  const row = db()
    .query("SELECT value FROM kv_meta WHERE key = ?")
    .get(ownerKey()) as { value: string } | null;
  if (row === null) return null;
  return parseOwner(JSON.parse(row.value));
}

export function saveOwner(owner: ModelTidesOwner): void {
  const parsed = parseOwner(owner);
  db()
    .query(
      "INSERT INTO kv_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(ownerKey(), JSON.stringify(parsed));
}

export function deleteOwner(): void {
  db().query("DELETE FROM kv_meta WHERE key = ?").run(ownerKey());
}

/**
 * Plain INSERT — throws (SQLite UNIQUE constraint) when an owner already
 * exists. Used only by the create path, mirroring the CLI's
 * `writeFileSync(..., { flag: "wx" })`.
 */
export function createOwner(owner: ModelTidesOwner): void {
  const parsed = parseOwner(owner);
  db()
    .query("INSERT INTO kv_meta (key, value) VALUES (?, ?)")
    .run(ownerKey(), JSON.stringify(parsed));
}
