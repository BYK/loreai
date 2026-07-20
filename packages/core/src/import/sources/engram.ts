/**
 * Engram source adapter.
 *
 * Converts an Engram export (`engram export` / `GET /export`) into a validated
 * `LoreImportDoc`. Engram is the Go memory system at
 * github.com/Gentleman-Programming/engram.
 *
 * Export shape (verified against Engram `main`):
 *   { version, exported_at, sessions[], observations[], prompts[] }
 * with snake_case json tags. We only consume `sessions` (for the project
 * directory) and `observations` (the actual memory entries); `prompts` are raw
 * user turns, not curated knowledge, so they are ignored.
 */
import {
  parseImportDoc,
  MAX_IMPORT_CONTENT_LENGTH,
  type LoreImportDoc,
  type LoreImportEntry,
} from "../schema";

/** A session row from an Engram export (subset we use). */
type EngramSession = {
  id: string;
  project?: string;
  directory?: string;
};

/** An observation row from an Engram export (subset we use). */
type EngramObservation = {
  session_id?: string;
  type?: string;
  title?: string;
  content?: string;
  project?: string | null;
  scope?: string;
  confidence?: number;
  created_at?: string;
  deleted_at?: string | null;
  sync_id?: string;
};

type EngramExport = {
  sessions?: EngramSession[];
  observations?: EngramObservation[];
};

/**
 * Map an Engram observation `type` to a Lore category.
 * Engram's canonical set is bugfix|decision|architecture|discovery|pattern|
 * config|preference (no `gotcha` — gotchas are `discovery`).
 */
function mapCategory(type: string | undefined): LoreImportEntry["category"] {
  switch ((type ?? "").toLowerCase()) {
    case "decision":
      return "decision";
    case "architecture":
      return "architecture";
    case "config":
      return "architecture";
    case "pattern":
      return "pattern";
    case "preference":
      return "preference";
    case "bugfix":
    case "discovery":
      return "gotcha";
    default:
      return "pattern";
  }
}

/**
 * Parse a raw Engram export object into a validated `LoreImportDoc`.
 *
 * @throws ZodError if the resulting document fails schema validation.
 */
export function parseEngramExport(raw: unknown): LoreImportDoc {
  const exp = (raw ?? {}) as EngramExport;
  const sessions = Array.isArray(exp.sessions) ? exp.sessions : [];
  const observations = Array.isArray(exp.observations) ? exp.observations : [];

  // session_id → directory (real filesystem path → Lore project).
  const sessionDir = new Map<string, string>();
  for (const s of sessions) {
    if (
      s &&
      typeof s.id === "string" &&
      typeof s.directory === "string" &&
      s.directory
    ) {
      sessionDir.set(s.id, s.directory);
    }
  }

  const entries: LoreImportEntry[] = [];
  for (const obs of observations) {
    if (!obs || typeof obs.content !== "string" || obs.content.trim() === "") {
      continue;
    }
    // Skip soft-deleted observations. Engram writes NULL for live rows and a
    // timestamp string when deleted. Use a truthy check (not `!= null`) so a
    // falsy-but-present value (empty string) is treated as LIVE — never silently
    // drop a live observation because of an empty deleted_at.
    if (obs.deleted_at) continue;

    const scope = (obs.scope ?? "project").toLowerCase();
    // personal/global observations become global (cross-project) entries; we
    // signal this by leaving `project` unset so the importer's --global path or
    // the default project applies. Since the doc format has no per-entry scope,
    // we resolve project only for `project`-scoped observations.
    const isGlobalScope = scope === "personal" || scope === "global";

    const directory = obs.session_id
      ? sessionDir.get(obs.session_id)
      : undefined;
    const project = isGlobalScope ? undefined : directory;

    const entry: LoreImportEntry = {
      // Clamp to the schema ceiling so a single oversized observation is
      // truncated here rather than failing validation and aborting the entire
      // import. The importer truncates further (to 1200) downstream.
      content:
        obs.content.length > MAX_IMPORT_CONTENT_LENGTH
          ? obs.content.slice(0, MAX_IMPORT_CONTENT_LENGTH)
          : obs.content,
      category: mapCategory(obs.type),
    };
    if (typeof obs.title === "string" && obs.title.trim() !== "") {
      entry.title = obs.title;
    }
    if (project) entry.project = project;
    if (typeof obs.confidence === "number") {
      entry.confidence = Math.min(1, Math.max(0, obs.confidence));
    }
    if (typeof obs.created_at === "string" && obs.created_at) {
      entry.created_at = obs.created_at;
    }
    if (typeof obs.sync_id === "string" && obs.sync_id) {
      entry.external_id = obs.sync_id;
    }
    entries.push(entry);
  }

  return parseImportDoc({
    lore_import_version: 1,
    source: "engram",
    entries,
  });
}
