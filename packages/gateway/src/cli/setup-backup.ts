/**
 * Provenance + backup helpers for `lore setup` / `lore setup undo`.
 *
 * `lore setup` rewrites third-party config files. To make the change
 * reversible (and visible) we record what was there before:
 *
 *  - JSON agents (Claude Code, OpenCode): a top-level `_loreBackup` sidecar
 *    key. We can't use literal `//` comments — the files are strict JSON and
 *    our own `readJsonConfig` does `JSON.parse`, which would throw on comments.
 *  - TOML agent (Codex): a `#`-commented backup block at the top of the file
 *    (TOML supports native comments — this is the inline-visible backup).
 *
 * Undo is **revert-only-if-unchanged** for JSON: a managed key is only reverted
 * when its current value still equals what lore wrote, so a value the user
 * changed later is never clobbered.
 *
 * All functions here are pure (string/object in, string/object out) so the
 * logic is unit-testable without touching the filesystem.
 */

export const LORE_BACKUP_KEY = "_loreBackup";

// ---------------------------------------------------------------------------
// JSON dot-path helpers
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Read a dot-path (e.g. `env.ANTHROPIC_BASE_URL`). Returns undefined if any
 * segment is missing. */
export function getPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[p];
  }
  return cur;
}

/** Set a dot-path, creating intermediate plain objects as needed. */
export function setPath(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const parts = path.split(".");
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (!isPlainObject(cur[p])) cur[p] = {};
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

/** Delete a dot-path leaf, then prune any parent objects left empty. */
export function deletePath(obj: Record<string, unknown>, path: string): void {
  const parts = path.split(".");
  // Walk down, remembering the chain so we can prune empties on the way back.
  const chain: Record<string, unknown>[] = [obj];
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = cur[parts[i]];
    if (!isPlainObject(next)) return; // path doesn't exist — nothing to delete
    cur = next;
    chain.push(cur);
  }
  delete cur[parts[parts.length - 1]];
  // Prune empty ancestor objects (e.g. a now-empty `env` lore created).
  for (let i = chain.length - 1; i >= 1; i--) {
    if (Object.keys(chain[i]).length === 0) {
      delete chain[i - 1][parts[i - 1]];
    } else {
      break;
    }
  }
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// JSON backup (Claude Code, OpenCode)
// ---------------------------------------------------------------------------

export interface JsonBackupEntry {
  path: string;
  loreValue: unknown;
  hadPrior: boolean;
  priorValue?: unknown;
}

export interface JsonBackup {
  version: 1;
  savedAt: string;
  entries: JsonBackupEntry[];
  /** OpenCode only: lore appended `@loreai/opencode` to the `plugin` array. */
  pluginAdded?: boolean;
}

/**
 * Capture a backup from the *pre-modification* config and the map of values
 * lore is about to set (path → value). Records, per path, what lore will set
 * and the prior value (if any).
 */
export function captureJsonBackup(
  existing: Record<string, unknown>,
  loreValues: Record<string, unknown>,
  opts: { pluginAdded?: boolean; now?: () => Date } = {},
): JsonBackup {
  const entries: JsonBackupEntry[] = [];
  for (const [path, loreValue] of Object.entries(loreValues)) {
    const prior = getPath(existing, path);
    entries.push(
      prior === undefined
        ? { path, loreValue, hadPrior: false }
        : { path, loreValue, hadPrior: true, priorValue: prior },
    );
  }
  const backup: JsonBackup = {
    version: 1,
    savedAt: (opts.now?.() ?? new Date()).toISOString(),
    entries,
  };
  if (opts.pluginAdded !== undefined) backup.pluginAdded = opts.pluginAdded;
  return backup;
}

/**
 * Attach a backup to a config — but only if one isn't already present, so
 * re-running setup never overwrites the *true* original with lore's own
 * values. Mutates and returns `config`.
 */
export function attachJsonBackup(
  config: Record<string, unknown>,
  backup: JsonBackup,
): Record<string, unknown> {
  if (LORE_BACKUP_KEY in config) return config;
  config[LORE_BACKUP_KEY] = backup;
  return config;
}

export interface RestoreSummary {
  hadBackup: boolean;
  restored: string[];
  skipped: string[];
}

/**
 * Restore a JSON config from its `_loreBackup` sidecar. Revert-only-if-
 * unchanged: a path is reverted only when its current value still equals what
 * lore wrote. Removes the sidecar key on completion. Mutates `config`.
 */
export function restoreJsonBackup(
  config: Record<string, unknown>,
): RestoreSummary {
  const raw = config[LORE_BACKUP_KEY];
  if (!isPlainObject(raw) || !Array.isArray(raw.entries)) {
    return { hadBackup: false, restored: [], skipped: [] };
  }
  const backup = raw as unknown as JsonBackup;
  const restored: string[] = [];
  const skipped: string[] = [];

  for (const entry of backup.entries) {
    const current = getPath(config, entry.path);
    if (!jsonEqual(current, entry.loreValue)) {
      // The user changed (or removed) this value after setup — leave it.
      skipped.push(entry.path);
      continue;
    }
    if (entry.hadPrior) {
      setPath(config, entry.path, entry.priorValue);
    } else {
      deletePath(config, entry.path);
    }
    restored.push(entry.path);
  }

  // OpenCode: drop the plugin lore appended (only if still present).
  if (backup.pluginAdded && Array.isArray(config.plugin)) {
    const arr = config.plugin as unknown[];
    const idx = arr.indexOf("@loreai/opencode");
    if (idx !== -1) {
      arr.splice(idx, 1);
      restored.push("plugin[@loreai/opencode]");
      if (arr.length === 0) delete config.plugin;
    }
  }

  // Consume the backup only when everything was reverted. If some keys were
  // skipped (the user changed them after setup), keep the sidecar so their
  // original values remain recoverable — never silently drop that metadata.
  if (skipped.length === 0) {
    delete config[LORE_BACKUP_KEY];
  }
  return { hadBackup: true, restored, skipped };
}

// ---------------------------------------------------------------------------
// TOML backup (Codex) — `#`-commented block at the top of the file
// ---------------------------------------------------------------------------

const TOML_BACKUP_HEADER =
  "# lore setup backup — original values (run `lore setup undo codex` to restore):";
const TOML_BACKUP_FOOTER = "# end lore setup backup";
const TOML_UNSET = "(was unset)";
// Separates the (uncommentable) prior value from the value lore wrote. Restore
// compares the current value against the lore-set value and only reverts when
// they still match — mirroring the JSON "revert-only-if-unchanged" guarantee.
const TOML_LORE_SET = " # lore-set ";

/** Extract the raw value text of a top-level TOML key, or null if absent. */
export function getTomlTopLevelValue(
  content: string,
  key: string,
): string | null {
  const lines = content.split("\n");
  const keyPattern = new RegExp(
    `^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*(.*?)\\s*$`,
  );
  for (let i = 0; i < lines.length; i++) {
    const m = keyPattern.exec(lines[i]);
    if (m && isTopLevelLine(lines, i)) return m[1];
  }
  return null;
}

/** Whether the line at `index` is outside any `[section]`. */
function isTopLevelLine(lines: string[], index: number): boolean {
  for (let i = index - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line === "" || line.startsWith("#")) continue;
    if (/^\[/.test(line)) return false;
  }
  return true;
}

/** Delete a top-level TOML key line. */
export function deleteTomlTopLevelKey(content: string, key: string): string {
  const lines = content.split("\n");
  const keyPattern = new RegExp(
    `^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=`,
  );
  const out: string[] = [];
  let removed = false;
  for (let i = 0; i < lines.length; i++) {
    if (!removed && keyPattern.test(lines[i]) && isTopLevelLine(lines, i)) {
      removed = true;
      continue;
    }
    out.push(lines[i]);
  }
  return out.join("\n");
}

/**
 * Build the commented backup block from the *original* content and the values
 * lore is about to write (`loreValues`: key → raw TOML value, e.g.
 * `{ openai_base_url: '"http://…/v1"' }`). Each entry records the prior value
 * (uncommentable to restore) plus the lore-set value, so undo can revert only
 * when the file still holds lore's value. Returns null if a block already
 * exists (preserve the true original) or there are no keys.
 */
export function buildTomlBackupBlock(
  content: string,
  loreValues: Record<string, string>,
): string | null {
  if (content.includes(TOML_BACKUP_HEADER)) return null;
  const keys = Object.keys(loreValues);
  if (keys.length === 0) return null;
  const lines = [TOML_BACKUP_HEADER];
  for (const key of keys) {
    const prior = getTomlTopLevelValue(content, key);
    const priorPart =
      prior === null ? `${key} ${TOML_UNSET}` : `${key} = ${prior}`;
    lines.push(`#   ${priorPart}${TOML_LORE_SET}${loreValues[key]}`);
  }
  lines.push(TOML_BACKUP_FOOTER);
  return lines.join("\n");
}

/** Prepend a backup block to the content (block already includes no trailing newline). */
export function prependTomlBackupBlock(content: string, block: string): string {
  return content ? `${block}\n${content}` : `${block}\n`;
}

/**
 * Restore a Codex TOML file from its commented backup block. For each recorded
 * key: revert to the prior value (or delete it if originally unset) **only when
 * the file still holds the value lore wrote** — a value the user changed after
 * setup is left untouched and reported as skipped. The backup block is removed
 * only when every key was reverted; if any were skipped it is kept so their
 * original values stay recoverable.
 */
export function restoreTomlBackup(content: string): {
  content: string;
  summary: RestoreSummary;
} {
  const lines = content.split("\n");
  const start = lines.findIndex((l) => l.trim() === TOML_BACKUP_HEADER);
  if (start === -1) {
    return {
      content,
      summary: { hadBackup: false, restored: [], skipped: [] },
    };
  }
  let end = start;
  while (end < lines.length && lines[end].trim() !== TOML_BACKUP_FOOTER) end++;
  if (end >= lines.length) {
    // Footer missing (block hand-edited/corrupted). Refuse to touch the file —
    // otherwise we'd treat the entire remainder as the block and delete it.
    return {
      content,
      summary: { hadBackup: false, restored: [], skipped: [] },
    };
  }

  const restored: string[] = [];
  const skipped: string[] = [];
  const entryLines = lines.slice(start + 1, end);
  // Restore against the FULL content — the block lines are comments, so they
  // never match a top-level key pattern. The block is stripped afterwards, but
  // only when nothing was skipped (see below).
  let result = content;

  for (const raw of entryLines) {
    const body = raw.replace(/^#\s*/, "");
    const sepIdx = body.indexOf(TOML_LORE_SET);
    if (sepIdx === -1) continue; // not a recognized entry line
    const priorPart = body.slice(0, sepIdx).trim();
    const loreValue = body.slice(sepIdx + TOML_LORE_SET.length).trim();

    let key: string;
    let priorValue: string | null;
    if (priorPart.endsWith(TOML_UNSET)) {
      key = priorPart.slice(0, -TOML_UNSET.length).trim();
      priorValue = null; // was unset → undo should delete it
    } else {
      const eq = priorPart.indexOf("=");
      if (eq <= 0) continue;
      key = priorPart.slice(0, eq).trim();
      priorValue = priorPart.slice(eq + 1).trim();
    }

    // Revert-only-if-unchanged: skip if the user changed the value after setup.
    if (getTomlTopLevelValue(result, key) !== loreValue) {
      skipped.push(key);
      continue;
    }
    result =
      priorValue === null
        ? deleteTomlTopLevelKey(result, key)
        : setTomlTopLevelKeyRaw(result, key, priorValue);
    restored.push(key);
  }

  // Strip the backup block only when everything was reverted. If some keys were
  // skipped (the user changed them), keep the block so their original values
  // remain recoverable — never silently drop that metadata.
  if (skipped.length === 0) {
    const out = result.split("\n");
    const s = out.findIndex((l) => l.trim() === TOML_BACKUP_HEADER);
    let e = s;
    while (e < out.length && out[e].trim() !== TOML_BACKUP_FOOTER) e++;
    result = [...out.slice(0, s), ...out.slice(e + 1)].join("\n");
  }

  return {
    content: result,
    summary: { hadBackup: true, restored, skipped },
  };
}

/**
 * Minimal top-level TOML key setter used by restore (replaces in place or
 * inserts before the first section). Kept separate from setup.ts's
 * `setTopLevelKey` to avoid a circular import; behavior matches for these
 * simple cases.
 */
function setTomlTopLevelKeyRaw(
  content: string,
  key: string,
  value: string,
): string {
  const newLine = `${key} = ${value}`;
  const lines = content.split("\n");
  const keyPattern = new RegExp(
    `^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=`,
  );
  for (let i = 0; i < lines.length; i++) {
    if (keyPattern.test(lines[i]) && isTopLevelLine(lines, i)) {
      lines[i] = newLine;
      return lines.join("\n");
    }
  }
  const firstSectionIdx = lines.findIndex((line) => /^\s*\[/.test(line));
  if (firstSectionIdx === -1) {
    const trimmed = content.trimEnd();
    return trimmed ? `${trimmed}\n${newLine}\n` : `${newLine}\n`;
  }
  const before = lines.slice(0, firstSectionIdx);
  const after = lines.slice(firstSectionIdx);
  while (before.length > 0 && before[before.length - 1].trim() === "") {
    before.pop();
  }
  const beforeStr = before.length > 0 ? `${before.join("\n")}\n` : "";
  return `${beforeStr}${newLine}\n\n${after.join("\n")}`;
}
