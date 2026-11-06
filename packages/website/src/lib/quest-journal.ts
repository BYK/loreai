export const JOURNAL_ART = {
  journal: "journal.svg",
  expedition: "expedition-desk.svg",
  decision: "decision-note.svg",
  pattern: "pattern-routes.svg",
  gotcha: "gotcha-lantern.svg",
} as const;

export const JOURNAL_CHAPTERS = [
  {
    id: "conversation",
    name: "Conversation",
    title: "A decision is made",
    number: "01",
  },
  {
    id: "knowledge",
    name: "Project knowledge",
    title: "Keep the useful part",
    number: "02",
  },
  { id: "recall", name: "Next quest", title: "The next quest", number: "03" },
] as const;

export const JOURNAL_ENTRIES = [
  {
    id: "webhook",
    name: "webhook decision",
    category: "Decision",
    art: "decision",
    title: "Keep handlers idempotent",
    tag: "webhooks",
    task: "Add webhook retries",
    rule: "Check the event ID before applying a webhook. Reuse the existing duplicate-event guard so repeated deliveries never apply the same change twice.",
    source:
      "Keep webhook handlers idempotent. The provider can deliver the same event twice. Reuse the event-id check that’s already there.",
    session: "Session 12 · webhook delivery",
    response:
      "I’ll reuse the event-id guard before adding retry handling, so a repeated delivery won’t apply the change twice.",
  },
  {
    id: "forms",
    name: "settings pattern",
    category: "Pattern",
    art: "pattern",
    title: "Reuse the settings form",
    tag: "settings",
    task: "Add a settings field",
    rule: "Use the existing settings form and its validation pattern when adding a preference. Keep validation messages beside the field they describe.",
    source:
      "For the new notification preference, follow the current settings form. Put validation beside the field, like the other preferences.",
    session: "Session 09 · notification settings",
    response:
      "I’ll follow the current settings form and keep the new field’s validation inline, consistent with the other preferences.",
  },
  {
    id: "sqlite",
    name: "SQLite gotcha",
    category: "Gotcha",
    art: "gotcha",
    title: "SQLite allows one writer",
    tag: "imports",
    task: "Speed up an import",
    rule: "Batch imported records in a transaction and serialize writes. Starting concurrent write transactions can produce SQLITE_BUSY during a larger import.",
    source:
      "The import hit SQLITE_BUSY when we ran all writers at once. Batch the records and serialize the writes.",
    session: "Session 07 · data import",
    response:
      "I’ll batch records in a transaction and serialize writes. Running the import writers concurrently previously caused SQLITE_BUSY.",
  },
] as const;

export type JournalState = {
  chapter: (typeof JOURNAL_CHAPTERS)[number]["id"];
  entry: (typeof JOURNAL_ENTRIES)[number]["id"];
  task: (typeof JOURNAL_ENTRIES)[number]["id"];
};
export const JOURNAL_DEFAULTS: JournalState = {
  chapter: "knowledge",
  entry: "webhook",
  task: "webhook",
};
export const JOURNAL_CHOICES = {
  chapter: JOURNAL_CHAPTERS.map((chapter) => chapter.id),
  entry: JOURNAL_ENTRIES.map((entry) => entry.id),
  task: JOURNAL_ENTRIES.map((entry) => entry.id),
};

export function readJournalState(
  params: URLSearchParams,
  fallback: JournalState = JOURNAL_DEFAULTS,
): JournalState {
  const state = { ...fallback };
  for (const key of ["chapter", "entry", "task"] as const) {
    const value = params.get(key);
    if (value && (JOURNAL_CHOICES[key] as readonly string[]).includes(value))
      Object.assign(state, { [key]: value });
  }
  return state;
}
