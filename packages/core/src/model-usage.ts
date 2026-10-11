/**
 * Daily model-usage statistics (#2026): counts of distinct sessions per
 * (UTC day, provider/model) over `temporal_messages`, exported in the
 * model-tides "daily" document format (format/version/constants ported from
 * model-tides src/daily-usage.ts and src/weekly-snapshot.ts).
 */
import { db } from "./db";
import { sql } from "./sql";
import { currentTenantId } from "./tenant";

// Ported from model-tides src/daily-usage.ts.
export const DAILY_FORMAT = "model-tides-daily";
export const DAILY_VERSION = 2;
export const MAX_DAILY_CELLS = 200_000;
// Ported from model-tides src/weekly-snapshot.ts.
export const MIN_WEEK_TIME = Date.UTC(1999, 11, 27);
export const FUTURE_MARGIN_MS = 7 * 86_400_000;

// Mutable copy so tests can shrink the cap without seeding MAX_DAILY_CELLS
// rows. Production code must read `dailyCellCap`, not MAX_DAILY_CELLS.
let dailyCellCap = MAX_DAILY_CELLS;

/** Test-only — restore by passing undefined. Not part of the public API. */
export function _setMaxDailyCellsForTest(cap?: number): void {
  dailyCellCap = cap ?? MAX_DAILY_CELLS;
}

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
export function buildDailyModelUsage(
  filter: ModelUsageFilter = {},
): DailyUsageDocument {
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
    LIMIT ${dailyCellCap + 1}`;

  const rows = sql.all<{ day: string; model: string; sessions: number }>(
    db(),
    query,
  );
  if (rows.length > dailyCellCap) {
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
    if (cells > dailyCellCap) {
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
