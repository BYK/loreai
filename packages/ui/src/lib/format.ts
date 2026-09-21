import { formatRelative } from "date-fns";

/** Core timestamps are epoch milliseconds; `0`/null mean "unknown". */
function parseDate(value: number | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Relative timestamp via date-fns `formatRelative`: "today at 10:00 AM",
 * "yesterday at …", "last Friday at …", otherwise a plain date. Calendar-day
 * bucketing (incl. DST and future dates) is the library's. `now` is
 * injectable for tests.
 */
export function formatWhen(
  value: number | null | undefined,
  now: Date = new Date(),
): string {
  const date = parseDate(value);
  if (!date) return "—";
  return formatRelative(date, now);
}

export function formatFullDate(value: number | null | undefined): string {
  const date = parseDate(value);
  return date ? date.toLocaleString() : "unknown";
}

export function formatConfidence(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

/** First line of the content, trimmed to a preview length. */
export function previewOf(content: string, max = 120): string {
  const firstLine = content.split(/\r?\n/).find((l) => l.trim()) ?? "";
  const flat = firstLine.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function pluralize(count: number, singular: string, plural?: string) {
  return `${count} ${count === 1 ? singular : (plural ?? `${singular}s`)}`;
}

export function recordedWriter(value: {
  updated_by?: string | null;
  source_refs?: {
    updated_by?: string | null;
    worker_model_id?: string | null;
  } | null;
}): string | null | undefined {
  return (
    value.updated_by ??
    value.source_refs?.updated_by ??
    value.source_refs?.worker_model_id
  );
}

/** Two-letter avatar initials from a display name or id. */
export function initials(name: string): string {
  const [first, second] = name
    .replace(/[^\p{L}\p{N}\s_-]/gu, " ")
    .split(/[\s_-]+/)
    .filter(Boolean);
  if (!first) return "?";
  if (!second) return first.slice(0, 2).toUpperCase();
  return `${first.charAt(0)}${second.charAt(0)}`.toUpperCase();
}
