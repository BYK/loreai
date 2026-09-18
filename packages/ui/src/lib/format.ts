const DAY_MS = 86_400_000;

/** Core timestamps are epoch milliseconds; `0`/null mean "unknown". */
function parseDate(value: number | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Short, inbox-style timestamp: time of day for today, weekday within a
 * week, otherwise a compact date. `now` is injectable for tests.
 */
export function formatWhen(
  value: number | null | undefined,
  now: Date = new Date(),
): string {
  const date = parseDate(value);
  if (!date) return "—";
  const diff = now.getTime() - date.getTime();
  if (diff < DAY_MS && date.getDate() === now.getDate()) {
    return date.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  if (diff < 2 * DAY_MS) return "Yesterday";
  if (diff < 7 * DAY_MS) {
    return date.toLocaleDateString(undefined, { weekday: "long" });
  }
  return date.toLocaleDateString(undefined, {
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
    month: "short",
    day: "numeric",
  });
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
