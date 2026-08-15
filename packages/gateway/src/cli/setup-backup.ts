/**
 * Provenance + backup helpers for `lore setup` / `lore setup undo`.
 *
 * `lore setup` rewrites third-party config files. To make the change
 * reversible (and visible) we record what was there before:
 *
 *  - JSON agents (Claude Code, OpenCode, Pi): a sidecar *file* next to the
 *    config (`<config>.lore-backup`). Older versions stored this as a top-level
 *    `_loreBackup` key *inside* the config, but OpenCode's schema is
 *    `additionalProperties: false` and rejects unknown keys — that broke
 *    OpenCode startup ("unknown field `_loreBackup`"), so the backup now lives
 *    out-of-band. The sidecar file IO lives in setup.ts; the helpers here stay
 *    pure so the revert logic is unit-testable without touching the filesystem.
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

import { createHash } from "node:crypto";

export const LORE_BACKUP_KEY = "_loreBackup";

// ---------------------------------------------------------------------------
// JSON dot-path helpers
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const prototype = Object.getPrototypeOf(v);
  return prototype === Object.prototype || prototype === null;
}

const DANGEROUS_PATH_SEGMENTS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

function pathParts(path: string): string[] {
  const parts = path.split(".");
  if (
    parts.length === 0 ||
    parts.some((part) => part.length === 0 || DANGEROUS_PATH_SEGMENTS.has(part))
  ) {
    throw new Error(`Invalid JSON backup path: ${path}`);
  }
  return parts;
}

/** Read a dot-path (e.g. `env.ANTHROPIC_BASE_URL`). Returns undefined if any
 * segment is missing. */
export function getPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = pathParts(path);
  let cur: unknown = obj;
  for (const p of parts) {
    if (!isPlainObject(cur) || !Object.hasOwn(cur, p)) return undefined;
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
  const parts = pathParts(path);
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (!Object.hasOwn(cur, p) || !isPlainObject(cur[p])) cur[p] = {};
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

/** Delete a dot-path leaf, then prune any parent objects left empty. */
export function deletePath(obj: Record<string, unknown>, path: string): void {
  const parts = pathParts(path);
  // Walk down, remembering the chain so we can prune empties on the way back.
  const chain: Record<string, unknown>[] = [obj];
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!Object.hasOwn(cur, parts[i])) return;
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

function cloneJson<T>(value: T): T {
  return structuredClone(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
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

export interface LegacyJsonBackup {
  version: 1;
  savedAt: string;
  entries: JsonBackupEntry[];
  /** OpenCode only: lore appended `@loreai/opencode` to the `plugin` array. */
  pluginAdded?: boolean;
}

export interface JsonBackupGeneration {
  device: string;
  inode: string;
  birthtimeNs: string;
  size: string;
  mtimeNs: string;
}

/**
 * Stable crash-safe provenance. Version 2 remains reserved for a pending
 * journal; version 3 binds the committed backup to the installed config
 * generation and its managed/unmanaged semantic state.
 */
export interface BoundJsonBackup {
  version: 3;
  savedAt: string;
  entries: JsonBackupEntry[];
  pluginAdded?: boolean;
  originalExists: boolean;
  createdAncestors: string[];
  managedHash: string;
  unmanagedHash: string;
  generation: JsonBackupGeneration | null;
}

export type JsonBackup = LegacyJsonBackup | BoundJsonBackup;

export interface JsonSetupJournalProjectionEntry {
  path: string;
  present: boolean;
  value?: unknown;
}

export interface JsonSetupJournalConfigState {
  hash: string | null;
  projection: JsonSetupJournalProjectionEntry[];
}

/**
 * A prepared config/sidecar transaction. Stable sidecars are strict v1/v3
 * JsonBackup values; version 2 exists only while a replacement is pending.
 */
export interface JsonSetupJournal {
  version: 2;
  state: "prepared";
  preparedAt: string;
  oldBackup: JsonBackup | null;
  newBackup: JsonBackup | null;
  beforeConfig: JsonSetupJournalConfigState;
  afterConfig: JsonSetupJournalConfigState;
}

const JSON_BACKUP_ENV_PATHS = new Set([
  "env.ANTHROPIC_BASE_URL",
  "env.DISABLE_AUTO_COMPACT",
  "env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL",
]);
const JSON_BACKUP_PROVIDER_PATH =
  /^provider\.([a-z0-9][a-z0-9-]*)\.options\.baseURL$/;
const JSON_BACKUP_PI_PROVIDER_PATH =
  /^providers\.([a-z0-9][a-z0-9-]*)\.baseUrl$/;
const JSON_BACKUP_PROVIDER_CONTAINER_PATH =
  /^provider\.([a-z0-9][a-z0-9-]*)(?:\.options)?$/;
const JSON_BACKUP_PI_PROVIDER_CONTAINER_PATH =
  /^providers\.([a-z0-9][a-z0-9-]*)$/;
const JSON_BACKUP_CONTAINER_PATHS = new Set([
  "env",
  "provider",
  "providers",
  "compaction",
  "plugin",
]);
const JSON_BACKUP_CREATED_ANCESTOR =
  /^(?:env|compaction|provider(?:\.[a-z0-9][a-z0-9-]*(?:\.options)?)?|providers(?:\.[a-z0-9][a-z0-9-]*)?)$/;

function isManagedJsonBackupPath(path: string): boolean {
  pathParts(path);
  return (
    JSON_BACKUP_ENV_PATHS.has(path) ||
    JSON_BACKUP_CONTAINER_PATHS.has(path) ||
    JSON_BACKUP_PROVIDER_CONTAINER_PATH.test(path) ||
    JSON_BACKUP_PI_PROVIDER_CONTAINER_PATH.test(path) ||
    path === "compaction.auto" ||
    JSON_BACKUP_PROVIDER_PATH.test(path) ||
    JSON_BACKUP_PI_PROVIDER_PATH.test(path)
  );
}

function isManagedJsonJournalPath(path: string): boolean {
  return (
    path === "plugin" ||
    path === LORE_BACKUP_KEY ||
    isManagedJsonBackupPath(path)
  );
}

function isJsonValue(value: unknown, seen = new Set<object>()): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, seen))
    : isPlainObject(value) &&
      Object.keys(value).every(
        (key) =>
          !DANGEROUS_PATH_SEGMENTS.has(key) && isJsonValue(value[key], seen),
      );
  seen.delete(value);
  return valid;
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
): boolean {
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function hasExpectedLoreValue(path: string, value: unknown): boolean {
  if (path === "compaction.auto") return value === false;
  if (
    JSON_BACKUP_CONTAINER_PATHS.has(path) ||
    JSON_BACKUP_PROVIDER_CONTAINER_PATH.test(path) ||
    JSON_BACKUP_PI_PROVIDER_CONTAINER_PATH.test(path)
  ) {
    return isJsonValue(value);
  }
  return typeof value === "string";
}

function validIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function validateJsonBackupEntries(value: Record<string, unknown>): void {
  if (!Array.isArray(value.entries)) {
    throw new Error("Invalid JSON setup backup metadata.");
  }
  const seenPaths = new Set<string>();
  for (const rawEntry of value.entries) {
    if (!isPlainObject(rawEntry) || typeof rawEntry.hadPrior !== "boolean") {
      throw new Error("Invalid JSON setup backup entry.");
    }
    const required = rawEntry.hadPrior
      ? ["path", "loreValue", "hadPrior", "priorValue"]
      : ["path", "loreValue", "hadPrior"];
    const entryPath = rawEntry.path;
    if (
      !hasExactKeys(rawEntry, required) ||
      typeof entryPath !== "string" ||
      !isManagedJsonBackupPath(entryPath) ||
      seenPaths.has(entryPath) ||
      !hasExpectedLoreValue(entryPath, rawEntry.loreValue) ||
      !isJsonValue(rawEntry.loreValue) ||
      (rawEntry.hadPrior && !isJsonValue(rawEntry.priorValue)) ||
      [...seenPaths].some(
        (path) =>
          path.startsWith(`${entryPath}.`) || entryPath.startsWith(`${path}.`),
      )
    ) {
      throw new Error("Invalid JSON setup backup entry.");
    }
    seenPaths.add(entryPath);
  }
}

function parseJsonBackupGeneration(
  value: unknown,
): JsonBackupGeneration | null {
  if (value === null) return null;
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      "device",
      "inode",
      "birthtimeNs",
      "size",
      "mtimeNs",
    ]) ||
    typeof value.device !== "string" ||
    typeof value.inode !== "string" ||
    typeof value.birthtimeNs !== "string" ||
    typeof value.size !== "string" ||
    typeof value.mtimeNs !== "string" ||
    !/^\d+$/.test(value.device) ||
    !/^\d+$/.test(value.inode) ||
    !/^\d+$/.test(value.birthtimeNs) ||
    !/^\d+$/.test(value.size) ||
    !/^\d+$/.test(value.mtimeNs)
  ) {
    throw new Error("Invalid JSON setup backup generation.");
  }
  return value as unknown as JsonBackupGeneration;
}

/** Strictly validate untrusted JSON backup metadata. */
export function parseJsonBackup(value: unknown): JsonBackup {
  if (
    !isPlainObject(value) ||
    (value.version !== 1 && value.version !== 3) ||
    !validIsoTimestamp(value.savedAt) ||
    (Object.hasOwn(value, "pluginAdded") &&
      typeof value.pluginAdded !== "boolean")
  ) {
    throw new Error("Invalid JSON setup backup metadata.");
  }
  if (value.version === 1) {
    if (
      !hasExactKeys(value, ["version", "savedAt", "entries"], ["pluginAdded"])
    ) {
      throw new Error("Invalid JSON setup backup metadata.");
    }
    validateJsonBackupEntries(value);
    return value as unknown as LegacyJsonBackup;
  }

  if (
    !hasExactKeys(
      value,
      [
        "version",
        "savedAt",
        "entries",
        "originalExists",
        "createdAncestors",
        "managedHash",
        "unmanagedHash",
        "generation",
      ],
      ["pluginAdded"],
    ) ||
    typeof value.originalExists !== "boolean" ||
    !Array.isArray(value.createdAncestors) ||
    typeof value.managedHash !== "string" ||
    typeof value.unmanagedHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.managedHash) ||
    !/^[a-f0-9]{64}$/.test(value.unmanagedHash)
  ) {
    throw new Error("Invalid JSON setup backup metadata.");
  }
  validateJsonBackupEntries(value);
  parseJsonBackupGeneration(value.generation);
  const seenAncestors = new Set<string>();
  let previousAncestor: string | null = null;
  for (const ancestor of value.createdAncestors) {
    if (
      typeof ancestor !== "string" ||
      !JSON_BACKUP_CREATED_ANCESTOR.test(ancestor) ||
      seenAncestors.has(ancestor) ||
      (previousAncestor !== null && ancestor < previousAncestor) ||
      !(value.entries as JsonBackupEntry[]).some((entry) =>
        entry.path.startsWith(`${ancestor}.`),
      )
    ) {
      throw new Error("Invalid JSON setup backup created ancestors.");
    }
    seenAncestors.add(ancestor);
    previousAncestor = ancestor;
  }
  return value as unknown as BoundJsonBackup;
}

/** Stable sidecars must never contain an unbound v3 draft. */
export function parseStableJsonBackup(value: unknown): JsonBackup {
  const backup = parseJsonBackup(value);
  if (backup.version === 3 && backup.generation === null) {
    throw new Error("Unbound JSON setup backup generation.");
  }
  return backup;
}

function parseJsonSetupJournalConfigState(
  value: unknown,
): JsonSetupJournalConfigState {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ["hash", "projection"]) ||
    (value.hash !== null &&
      (typeof value.hash !== "string" || !/^[a-f0-9]{64}$/.test(value.hash))) ||
    !Array.isArray(value.projection)
  ) {
    throw new Error("Invalid JSON setup journal config state.");
  }

  const seenPaths = new Set<string>();
  let previousPath: string | null = null;
  for (const rawEntry of value.projection) {
    if (!isPlainObject(rawEntry) || typeof rawEntry.present !== "boolean") {
      throw new Error("Invalid JSON setup journal projection.");
    }
    const required = rawEntry.present
      ? ["path", "present", "value"]
      : ["path", "present"];
    if (
      !hasExactKeys(rawEntry, required) ||
      typeof rawEntry.path !== "string" ||
      !isManagedJsonJournalPath(rawEntry.path) ||
      seenPaths.has(rawEntry.path) ||
      (previousPath !== null && rawEntry.path < previousPath) ||
      (rawEntry.present && !isJsonValue(rawEntry.value)) ||
      (rawEntry.path === LORE_BACKUP_KEY &&
        rawEntry.present &&
        !isValidJsonBackup(rawEntry.value))
    ) {
      throw new Error("Invalid JSON setup journal projection.");
    }
    seenPaths.add(rawEntry.path);
    previousPath = rawEntry.path;
  }
  if (value.hash === null && value.projection.some((entry) => entry.present)) {
    throw new Error("Invalid JSON setup journal config state.");
  }
  return value as unknown as JsonSetupJournalConfigState;
}

function isValidJsonBackup(value: unknown): boolean {
  try {
    parseJsonBackup(value);
    return true;
  } catch {
    return false;
  }
}

/** Strictly validate a pending v2 sidecar journal. */
export function parseJsonSetupJournal(value: unknown): JsonSetupJournal {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      "version",
      "state",
      "preparedAt",
      "oldBackup",
      "newBackup",
      "beforeConfig",
      "afterConfig",
    ]) ||
    value.version !== 2 ||
    value.state !== "prepared" ||
    typeof value.preparedAt !== "string" ||
    !Number.isFinite(Date.parse(value.preparedAt)) ||
    new Date(value.preparedAt).toISOString() !== value.preparedAt
  ) {
    throw new Error("Invalid JSON setup journal metadata.");
  }

  const oldBackup =
    value.oldBackup === null ? null : parseJsonBackup(value.oldBackup);
  const newBackup =
    value.newBackup === null ? null : parseJsonBackup(value.newBackup);
  const beforeConfig = parseJsonSetupJournalConfigState(value.beforeConfig);
  const afterConfig = parseJsonSetupJournalConfigState(value.afterConfig);
  const projectionPaths = new Set(
    beforeConfig.projection.map((entry) => entry.path),
  );
  const requiredPaths = [oldBackup, newBackup].flatMap(
    (backup) => backup?.entries.map((entry) => entry.path) ?? [],
  );
  if (oldBackup?.pluginAdded || newBackup?.pluginAdded) {
    requiredPaths.push("plugin");
  }
  if (
    beforeConfig.projection.length !== afterConfig.projection.length ||
    beforeConfig.projection.some(
      (entry, index) => entry.path !== afterConfig.projection[index]?.path,
    ) ||
    requiredPaths.some((path) => !projectionPaths.has(path))
  ) {
    throw new Error("Invalid JSON setup journal projections.");
  }

  return {
    version: 2,
    state: "prepared",
    preparedAt: value.preparedAt,
    oldBackup,
    newBackup,
    beforeConfig,
    afterConfig,
  };
}

function jsonConfigHash(text: string | null): string | null {
  return text === null ? null : createHash("sha256").update(text).digest("hex");
}

function captureJsonSetupProjection(
  config: Record<string, unknown>,
  paths: readonly string[],
  configExists = true,
): JsonSetupJournalProjectionEntry[] {
  if (!configExists) {
    return paths.map((path) => ({ path, present: false }));
  }
  return paths.map((path) => {
    const value = getPath(config, path);
    return value === undefined
      ? { path, present: false }
      : { path, present: true, value };
  });
}

/** Build the strict prepared journal written before the config commit. */
export function prepareJsonSetupJournal(input: {
  oldBackup: JsonBackup | null;
  newBackup: JsonBackup | null;
  beforeText: string | null;
  beforeConfig: Record<string, unknown>;
  afterText: string | null;
  afterConfig: Record<string, unknown>;
  projectionPaths?: readonly string[];
  now?: () => Date;
}): JsonSetupJournal {
  if (input.oldBackup) parseJsonBackup(input.oldBackup);
  if (input.newBackup) parseJsonBackup(input.newBackup);
  const paths = [
    ...new Set(
      [input.oldBackup, input.newBackup]
        .flatMap((backup) => backup?.entries.map((entry) => entry.path) ?? [])
        .concat(
          input.oldBackup?.pluginAdded || input.newBackup?.pluginAdded
            ? ["plugin"]
            : [],
          Object.hasOwn(input.beforeConfig, LORE_BACKUP_KEY) ||
            Object.hasOwn(input.afterConfig, LORE_BACKUP_KEY)
            ? [LORE_BACKUP_KEY]
            : [],
          input.projectionPaths ?? [],
        ),
    ),
  ].sort();
  if (paths.some((path) => !isManagedJsonJournalPath(path))) {
    throw new Error("Invalid JSON setup journal projection path.");
  }
  const journal: JsonSetupJournal = {
    version: 2,
    state: "prepared",
    preparedAt: (input.now?.() ?? new Date()).toISOString(),
    oldBackup: input.oldBackup,
    newBackup: input.newBackup,
    beforeConfig: {
      hash: jsonConfigHash(input.beforeText),
      projection: captureJsonSetupProjection(
        input.beforeConfig,
        paths,
        input.beforeText !== null,
      ),
    },
    afterConfig: {
      hash: jsonConfigHash(input.afterText),
      projection: captureJsonSetupProjection(
        input.afterConfig,
        paths,
        input.afterText !== null,
      ),
    },
  };
  return parseJsonSetupJournal(journal);
}

function sameProjection(
  left: JsonSetupJournalProjectionEntry[],
  right: JsonSetupJournalProjectionEntry[],
): boolean {
  return jsonEqual(left, right);
}

/**
 * Select the stable sidecar state for a pending journal without changing the
 * config. Exact bytes win; if unrelated config bytes changed after a crash,
 * the managed projection must identify exactly one side.
 */
export function selectJsonSetupJournalState(
  rawJournal: JsonSetupJournal,
  currentText: string | null,
  currentConfig: Record<string, unknown>,
): "old" | "new" {
  const journal = parseJsonSetupJournal(rawJournal);
  const currentHash = jsonConfigHash(currentText);
  const exact = (["old", "new"] as const).filter((state) => {
    const config = state === "old" ? journal.beforeConfig : journal.afterConfig;
    return config.hash === currentHash;
  });
  if (exact.length === 1) return exact[0];
  if (exact.length === 2) {
    throw new Error("Ambiguous Lore setup journal config state.");
  }

  const paths = journal.beforeConfig.projection.map((entry) => entry.path);
  const currentProjection = captureJsonSetupProjection(
    currentConfig,
    paths,
    currentText !== null,
  );
  const projected = (["old", "new"] as const).filter((state) => {
    const config = state === "old" ? journal.beforeConfig : journal.afterConfig;
    return sameProjection(config.projection, currentProjection);
  });
  if (projected.length === 1) return projected[0];
  throw new Error(
    projected.length === 2
      ? "Ambiguous Lore setup journal config state."
      : "Unknown Lore setup journal config state.",
  );
}

function captureJsonEntry(
  existing: Record<string, unknown>,
  path: string,
  loreValue: unknown,
): JsonBackupEntry {
  if (
    !isManagedJsonBackupPath(path) ||
    !hasExpectedLoreValue(path, loreValue)
  ) {
    throw new Error(`Invalid JSON backup path or Lore value: ${path}`);
  }
  const prior = getPath(existing, path);
  return prior === undefined
    ? { path, loreValue, hadPrior: false }
    : { path, loreValue, hadPrior: true, priorValue: prior };
}

function deriveAfterConfig(
  existing: Record<string, unknown>,
  loreValues: Record<string, unknown>,
): Record<string, unknown> {
  const after = cloneJson(existing);
  for (const [path, value] of Object.entries(loreValues)) {
    setPath(after, path, cloneJson(value));
  }
  return after;
}

function blockingPath(
  existing: Record<string, unknown>,
  path: string,
): string | null {
  const parts = pathParts(path);
  let current: unknown = existing;
  const traversed: string[] = [];
  for (const part of parts.slice(0, -1)) {
    if (!isPlainObject(current) || !Object.hasOwn(current, part)) return null;
    traversed.push(part);
    current = current[part];
    if (!isPlainObject(current)) return traversed.join(".");
  }
  return null;
}

function captureBackupEntries(
  existing: Record<string, unknown>,
  after: Record<string, unknown>,
  loreValues: Record<string, unknown>,
): JsonBackupEntry[] {
  const captured = new Map<string, JsonBackupEntry>();
  for (const [path, loreValue] of Object.entries(loreValues)) {
    const blocker = blockingPath(existing, path);
    const entryPath = blocker ?? path;
    if (captured.has(entryPath)) continue;
    const installedValue = blocker ? getPath(after, blocker) : loreValue;
    captured.set(
      entryPath,
      captureJsonEntry(existing, entryPath, cloneJson(installedValue)),
    );
  }
  return [...captured.values()];
}

function captureCreatedAncestors(
  existing: Record<string, unknown>,
  entries: readonly JsonBackupEntry[],
): string[] {
  const created = new Set<string>();
  for (const entry of entries) {
    const parts = pathParts(entry.path);
    let current: unknown = existing;
    const traversed: string[] = [];
    for (const part of parts.slice(0, -1)) {
      traversed.push(part);
      const present = isPlainObject(current) && Object.hasOwn(current, part);
      if (!present) created.add(traversed.join("."));
      current = present && isPlainObject(current) ? current[part] : undefined;
    }
  }
  return [...created].sort();
}

function deleteLeaf(obj: Record<string, unknown>, path: string): void {
  const parts = pathParts(path);
  let current: unknown = obj;
  for (const part of parts.slice(0, -1)) {
    if (!isPlainObject(current) || !Object.hasOwn(current, part)) return;
    current = current[part];
  }
  if (isPlainObject(current)) delete current[parts.at(-1) as string];
}

function pruneCreatedAncestors(
  obj: Record<string, unknown>,
  ancestors: readonly string[],
): void {
  for (const path of [...ancestors].sort(
    (left, right) => pathParts(right).length - pathParts(left).length,
  )) {
    const value = getPath(obj, path);
    if (isPlainObject(value) && Object.keys(value).length === 0) {
      deleteLeaf(obj, path);
    }
  }
}

function managedProjection(
  config: Record<string, unknown>,
  backup: Pick<JsonBackup, "entries" | "pluginAdded">,
): unknown[] {
  const projection = backup.entries.map((entry) => {
    const value = getPath(config, entry.path);
    return value === undefined
      ? { path: entry.path, present: false }
      : { path: entry.path, present: true, value };
  });
  if (
    Object.hasOwn(backup, "pluginAdded") &&
    !backup.entries.some((entry) => entry.path === "plugin")
  ) {
    projection.push({
      path: "plugin[@loreai/opencode]",
      present:
        Array.isArray(config.plugin) &&
        config.plugin.includes("@loreai/opencode"),
    });
  }
  return projection;
}

function unmanagedProjection(
  config: Record<string, unknown>,
  backup: Pick<BoundJsonBackup, "entries" | "pluginAdded" | "createdAncestors">,
): Record<string, unknown> {
  const unmanaged = cloneJson(config);
  for (const entry of backup.entries) deleteLeaf(unmanaged, entry.path);
  if (
    Object.hasOwn(backup, "pluginAdded") &&
    !backup.entries.some((entry) => entry.path === "plugin") &&
    Array.isArray(unmanaged.plugin)
  ) {
    const plugins = unmanaged.plugin;
    unmanaged.plugin = plugins.filter((item) => item !== "@loreai/opencode");
    if ((unmanaged.plugin as unknown[]).length === 0) delete unmanaged.plugin;
  }
  pruneCreatedAncestors(unmanaged, backup.createdAncestors);
  return unmanaged;
}

export function jsonBackupConfigHashes(
  config: Record<string, unknown>,
  backup: JsonBackup,
): { managedHash: string; unmanagedHash: string } {
  const createdAncestors = backup.version === 3 ? backup.createdAncestors : [];
  return {
    managedHash: hashJson(managedProjection(config, backup)),
    unmanagedHash: hashJson(
      unmanagedProjection(config, { ...backup, createdAncestors }),
    ),
  };
}

function boundBackupDraft(input: {
  savedAt: string;
  entries: JsonBackupEntry[];
  pluginAdded?: boolean;
  originalExists: boolean;
  createdAncestors: string[];
  afterConfig: Record<string, unknown>;
}): BoundJsonBackup {
  const draft: BoundJsonBackup = {
    version: 3,
    savedAt: input.savedAt,
    entries: input.entries,
    originalExists: input.originalExists,
    createdAncestors: input.createdAncestors,
    managedHash: "0".repeat(64),
    unmanagedHash: "0".repeat(64),
    generation: null,
  };
  if (input.pluginAdded !== undefined) draft.pluginAdded = input.pluginAdded;
  Object.assign(draft, jsonBackupConfigHashes(input.afterConfig, draft));
  return draft;
}

export function bindJsonBackupGeneration(
  backup: JsonBackup,
  generation: JsonBackupGeneration,
): JsonBackup {
  parseJsonBackup(backup);
  if (backup.version === 1) return backup;
  return parseStableJsonBackup({ ...backup, generation });
}

/** Verify that a stable sidecar still belongs to the current config. */
export function assertJsonBackupConfigState(
  backup: JsonBackup,
  config: Record<string, unknown>,
  generation: JsonBackupGeneration,
): void {
  parseJsonBackup(backup);
  if (backup.version === 1) return;
  if (!backup.generation) {
    throw new Error("Unbound JSON setup backup generation.");
  }
  const current = jsonBackupConfigHashes(config, backup);
  const sameGeneration =
    backup.generation.device === generation.device &&
    backup.generation.inode === generation.inode &&
    (backup.generation.birthtimeNs !== "0"
      ? backup.generation.birthtimeNs === generation.birthtimeNs
      : backup.generation.size === generation.size &&
        backup.generation.mtimeNs === generation.mtimeNs);
  if (sameGeneration) return;
  if (current.unmanagedHash !== backup.unmanagedHash) {
    throw new Error(
      "Current unmanaged config state does not match Lore setup provenance.",
    );
  }
  if (current.managedHash === backup.managedHash) {
    throw new Error(
      "Current config generation was replaced without a distinguishable managed-key edit.",
    );
  }
}

/**
 * Capture a backup from the *pre-modification* config and the map of values
 * lore is about to set (path → value). Records, per path, what lore will set
 * and the prior value (if any).
 */
export function captureJsonBackup(
  existing: Record<string, unknown>,
  loreValues: Record<string, unknown>,
  opts: {
    pluginAdded?: boolean;
    now?: () => Date;
    originalExists?: boolean;
    afterConfig?: Record<string, unknown>;
  } = {},
): JsonBackup {
  const afterConfig =
    opts.afterConfig ?? deriveAfterConfig(existing, loreValues);
  const entries = captureBackupEntries(existing, afterConfig, loreValues);
  return boundBackupDraft({
    savedAt: (opts.now?.() ?? new Date()).toISOString(),
    entries,
    pluginAdded: opts.pluginAdded,
    originalExists: opts.originalExists ?? true,
    createdAncestors: captureCreatedAncestors(existing, entries),
    afterConfig,
  });
}

/** Refresh provenance for a repeated setup while retaining the true prior. */
export function refreshJsonBackup(
  existing: Record<string, unknown>,
  loreValues: Record<string, unknown>,
  previous: JsonBackup | null,
  opts: {
    pluginAdded?: boolean;
    now?: () => Date;
    originalExists?: boolean;
    afterConfig?: Record<string, unknown>;
  } = {},
): JsonBackup {
  if (!previous) return captureJsonBackup(existing, loreValues, opts);
  parseJsonBackup(previous);

  const afterConfig =
    opts.afterConfig ?? deriveAfterConfig(existing, loreValues);
  let desiredEntries = captureBackupEntries(existing, afterConfig, loreValues);
  for (const previousEntry of previous.entries) {
    if (
      (!JSON_BACKUP_CONTAINER_PATHS.has(previousEntry.path) &&
        !JSON_BACKUP_PROVIDER_CONTAINER_PATH.test(previousEntry.path) &&
        !JSON_BACKUP_PI_PROVIDER_CONTAINER_PATH.test(previousEntry.path)) ||
      !Object.keys(loreValues).some(
        (path) =>
          path === previousEntry.path ||
          path.startsWith(`${previousEntry.path}.`),
      )
    ) {
      continue;
    }
    desiredEntries = desiredEntries.filter(
      (entry) =>
        entry.path === previousEntry.path ||
        !entry.path.startsWith(`${previousEntry.path}.`),
    );
    const current = getPath(existing, previousEntry.path);
    const loreValue = getPath(afterConfig, previousEntry.path);
    desiredEntries.push(
      jsonEqual(current, previousEntry.loreValue)
        ? { ...previousEntry, loreValue: cloneJson(loreValue) }
        : captureJsonEntry(existing, previousEntry.path, cloneJson(loreValue)),
    );
  }
  const previousByPath = new Map(
    previous.entries.map((entry) => [entry.path, entry]),
  );
  const entries: JsonBackupEntry[] = [];
  for (const desired of desiredEntries) {
    const priorEntry = previousByPath.get(desired.path);
    if (
      priorEntry &&
      jsonEqual(getPath(existing, desired.path), priorEntry.loreValue)
    ) {
      entries.push({ ...priorEntry, loreValue: desired.loreValue });
    } else {
      entries.push(desired);
    }
    previousByPath.delete(desired.path);
    for (const previousPath of previousByPath.keys()) {
      if (previousPath.startsWith(`${desired.path}.`)) {
        previousByPath.delete(previousPath);
      }
    }
  }
  entries.push(...previousByPath.values());

  const pluginAdded = previous.pluginAdded || opts.pluginAdded;
  return boundBackupDraft({
    savedAt: previous.savedAt,
    entries,
    pluginAdded,
    originalExists:
      previous.version === 3
        ? previous.originalExists
        : (opts.originalExists ?? true),
    createdAncestors:
      previous.version === 3
        ? [
            ...new Set([
              ...previous.createdAncestors,
              ...captureCreatedAncestors(existing, desiredEntries),
            ]),
          ].sort()
        : captureCreatedAncestors(existing, desiredEntries),
    afterConfig,
  });
}

export interface RestoreSummary {
  hadBackup: boolean;
  restored: string[];
  skipped: string[];
}

/**
 * Read a *legacy* in-config `_loreBackup` key, if present and valid.
 *
 * Older lore versions stored the JSON backup as a top-level key inside the
 * config itself. OpenCode's config schema is `additionalProperties: false`, so
 * that key makes newer OpenCode reject the whole file ("unknown field
 * `_loreBackup`") and refuse to start. Backups now live in a sidecar *file*
 * (see `loadJsonSetupBackup` in setup.ts); this reader exists only so `lore
 * setup` / `lore setup undo` can migrate (and clean up) installs written by the
 * old scheme. Pure — does not mutate `config`.
 */
export function readLegacyJsonBackup(
  config: Record<string, unknown>,
): JsonBackup | null {
  try {
    return requireLegacyJsonBackup(config);
  } catch {
    return null;
  }
}

/** Strict legacy reader for setup/undo paths that may overwrite config. */
export function requireLegacyJsonBackup(
  config: Record<string, unknown>,
): JsonBackup | null {
  if (!Object.hasOwn(config, LORE_BACKUP_KEY)) return null;
  try {
    return parseJsonBackup(config[LORE_BACKUP_KEY]);
  } catch (error) {
    throw new Error("Invalid legacy Lore setup backup metadata.", {
      cause: error,
    });
  }
}

/**
 * Apply a captured backup to a config, reverting lore's changes. Pure: mutates
 * and reports on `config`, but never reads or removes any `_loreBackup` key
 * (backups are stored out-of-band in a sidecar file, and the caller owns that).
 *
 * Revert-only-if-unchanged: a path is reverted only when its current value
 * still equals what lore wrote, so a value the user changed after setup is left
 * untouched and reported as skipped. `hadBackup` is always true — the caller
 * supplies a real backup.
 */
export function applyJsonBackup(
  config: Record<string, unknown>,
  backup: JsonBackup,
): RestoreSummary {
  parseJsonBackup(backup);
  const restored: string[] = [];
  const skipped: string[] = [];

  for (const entry of backup.entries) {
    const current = getPath(config, entry.path);
    if (!jsonEqual(current, entry.loreValue)) {
      const alreadyRestored = entry.hadPrior
        ? jsonEqual(current, entry.priorValue)
        : current === undefined;
      if (alreadyRestored) continue;
      // The user changed (or removed) this value after setup — leave it.
      skipped.push(entry.path);
      continue;
    }
    if (entry.hadPrior) {
      setPath(config, entry.path, entry.priorValue);
    } else {
      deleteLeaf(config, entry.path);
    }
    restored.push(entry.path);
  }

  if (backup.version === 3) {
    pruneCreatedAncestors(config, backup.createdAncestors);
  }

  // OpenCode: drop the plugin lore appended (only if still present).
  if (
    backup.pluginAdded &&
    !backup.entries.some((entry) => entry.path === "plugin") &&
    Array.isArray(config.plugin)
  ) {
    const arr = config.plugin as unknown[];
    const idx = arr.indexOf("@loreai/opencode");
    if (idx !== -1) {
      arr.splice(idx, 1);
      restored.push("plugin[@loreai/opencode]");
      if (arr.length === 0) delete config.plugin;
    }
  }

  return { hadBackup: true, restored, skipped };
}

/** Keep only provenance that a partial restore still needs. */
export function retainSkippedJsonBackup(
  backup: JsonBackup,
  skipped: string[],
  currentConfig?: Record<string, unknown>,
): JsonBackup | null {
  parseJsonBackup(backup);
  const skippedPaths = new Set(skipped);
  const entries = backup.entries.filter((entry) =>
    skippedPaths.has(entry.path),
  );
  if (entries.length === 0) return null;
  if (backup.version === 1) {
    return { version: 1, savedAt: backup.savedAt, entries };
  }
  if (!currentConfig) {
    currentConfig = {};
    for (const entry of entries) {
      setPath(currentConfig, entry.path, cloneJson(entry.loreValue));
    }
  }
  return boundBackupDraft({
    savedAt: backup.savedAt,
    entries,
    originalExists: backup.originalExists,
    createdAncestors: backup.createdAncestors.filter((ancestor) =>
      entries.some(
        (entry) =>
          entry.path === ancestor || entry.path.startsWith(`${ancestor}.`),
      ),
    ),
    afterConfig: currentConfig,
  });
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
const TOML_BACKUP_KEYS = new Set([
  "openai_base_url",
  "model_auto_compact_token_limit",
]);

interface TextBackupEntry {
  key: string;
  priorValue: string | null;
  loreValue: string;
}

function stripBackupBlock(content: string, start: number, end: number): string {
  const lines = content.split("\n");
  return [...lines.slice(0, start), ...lines.slice(end + 1)].join("\n");
}

function readTomlBackupBlock(content: string): {
  content: string;
  entries: TextBackupEntry[];
} | null {
  const lines = content.split("\n");
  const starts = lines.flatMap((line, index) =>
    line.trim() === TOML_BACKUP_HEADER ? [index] : [],
  );
  if (starts.length === 0) {
    if (lines.some((line) => line.trim() === TOML_BACKUP_FOOTER)) {
      throw new Error("Invalid Codex Lore backup block.");
    }
    return null;
  }
  if (starts.length !== 1) throw new Error("Invalid Codex Lore backup block.");
  const start = starts[0];
  const end = lines.findIndex(
    (line, index) => index > start && line.trim() === TOML_BACKUP_FOOTER,
  );
  if (
    end === -1 ||
    lines.some(
      (line, index) => index !== end && line.trim() === TOML_BACKUP_FOOTER,
    )
  ) {
    throw new Error("Invalid Codex Lore backup block.");
  }

  const entries: TextBackupEntry[] = [];
  const seen = new Set<string>();
  for (const raw of lines.slice(start + 1, end)) {
    const body = raw.replace(/^#\s*/, "");
    const sepIdx = body.lastIndexOf(TOML_LORE_SET);
    if (!/^#\s+/.test(raw) || sepIdx === -1) {
      throw new Error("Invalid Codex Lore backup entry.");
    }
    const priorPart = body.slice(0, sepIdx).trim();
    const loreValue = body.slice(sepIdx + TOML_LORE_SET.length).trim();
    let key: string;
    let priorValue: string | null;
    const eq = priorPart.indexOf("=");
    if (eq > 0) {
      key = priorPart.slice(0, eq).trim();
      priorValue = priorPart.slice(eq + 1).trim();
    } else if (priorPart.endsWith(TOML_UNSET)) {
      key = priorPart.slice(0, -TOML_UNSET.length).trim();
      priorValue = null;
    } else {
      throw new Error("Invalid Codex Lore backup entry.");
    }
    if (
      !TOML_BACKUP_KEYS.has(key) ||
      seen.has(key) ||
      loreValue.length === 0 ||
      (priorValue !== null && priorValue.length === 0)
    ) {
      throw new Error("Invalid Codex Lore backup entry.");
    }
    seen.add(key);
    entries.push({ key, priorValue, loreValue });
  }
  if (entries.length === 0) throw new Error("Empty Codex Lore backup block.");
  return { content: stripBackupBlock(content, start, end), entries };
}

function formatTomlBackupBlock(entries: TextBackupEntry[]): string {
  const lines = [TOML_BACKUP_HEADER];
  for (const entry of entries) {
    const priorPart =
      entry.priorValue === null
        ? `${entry.key} ${TOML_UNSET}`
        : `${entry.key} = ${entry.priorValue}`;
    lines.push(`#   ${priorPart}${TOML_LORE_SET}${entry.loreValue}`);
  }
  lines.push(TOML_BACKUP_FOOTER);
  return lines.join("\n");
}

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
    if (line.startsWith("[")) return false;
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

/** Prepare a backup block for a repeated Codex setup. */
export function refreshTomlBackupBlock(
  content: string,
  loreValues: Record<string, string>,
): { content: string; block: string } {
  const previous = readTomlBackupBlock(content);
  const config = previous?.content ?? content;
  const previousByKey = new Map(
    previous?.entries.map((entry) => [entry.key, entry]) ?? [],
  );
  const entries: TextBackupEntry[] = [];
  for (const [key, loreValue] of Object.entries(loreValues)) {
    if (!TOML_BACKUP_KEYS.has(key) || loreValue.length === 0) {
      throw new Error(`Invalid Codex Lore backup key or value: ${key}`);
    }
    const old = previousByKey.get(key);
    const current = getTomlTopLevelValue(config, key);
    entries.push({
      key,
      priorValue: old && current === old.loreValue ? old.priorValue : current,
      loreValue,
    });
    previousByKey.delete(key);
  }
  entries.push(...previousByKey.values());
  if (entries.length === 0) throw new Error("Empty Codex Lore backup block.");
  return { content: config, block: formatTomlBackupBlock(entries) };
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
  const backup = readTomlBackupBlock(content);
  if (!backup) {
    return {
      content,
      summary: { hadBackup: false, restored: [], skipped: [] },
    };
  }

  const restored: string[] = [];
  const skipped: string[] = [];
  const skippedEntries: TextBackupEntry[] = [];
  let result = backup.content;

  for (const entry of backup.entries) {
    const { key, loreValue, priorValue } = entry;
    // Revert-only-if-unchanged: skip if the user changed the value after setup.
    if (getTomlTopLevelValue(result, key) !== loreValue) {
      skipped.push(key);
      skippedEntries.push(entry);
      continue;
    }
    result =
      priorValue === null
        ? deleteTomlTopLevelKey(result, key)
        : setTomlTopLevelKeyRaw(result, key, priorValue);
    restored.push(key);
  }

  if (skippedEntries.length > 0) {
    result = prependTomlBackupBlock(
      result,
      formatTomlBackupBlock(skippedEntries),
    );
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

// ---------------------------------------------------------------------------
// dotenv backup (Hermes) — `#`-commented block at the top of `~/.hermes/.env`
// ---------------------------------------------------------------------------
//
// Hermes has no config-file base-URL setting the gateway can write; it reads
// `OPENAI_BASE_URL` + `HERMES_INFERENCE_PROVIDER` from `~/.hermes/.env` (loaded
// via python-dotenv at startup). `.env` is a flat `KEY=value` file with `#`
// comments and no `[section]` nesting, so this mirrors the Codex TOML backup
// (commented block + revert-only-if-unchanged) minus the section handling and
// with bare (unquoted) values written as `KEY=value`.

const ENV_BACKUP_HEADER =
  "# lore setup backup — original values (run `lore setup undo hermes` to restore):";
const ENV_BACKUP_FOOTER = "# end lore setup backup";
const ENV_UNSET = "(was unset)";
const ENV_LORE_SET = " # lore-set ";
const ENV_BACKUP_KEYS = new Set([
  "OPENAI_BASE_URL",
  "HERMES_INFERENCE_PROVIDER",
  "GOOGLE_GEMINI_BASE_URL",
]);

function readEnvBackupBlock(content: string): {
  content: string;
  entries: TextBackupEntry[];
} | null {
  const lines = content.split("\n");
  const starts = lines.flatMap((line, index) =>
    line.trim() === ENV_BACKUP_HEADER ? [index] : [],
  );
  if (starts.length === 0) {
    if (lines.some((line) => line.trim() === ENV_BACKUP_FOOTER)) {
      throw new Error("Invalid Lore env backup block.");
    }
    return null;
  }
  if (starts.length !== 1) throw new Error("Invalid Lore env backup block.");
  const start = starts[0];
  const end = lines.findIndex(
    (line, index) => index > start && line.trim() === ENV_BACKUP_FOOTER,
  );
  if (
    end === -1 ||
    lines.some(
      (line, index) => index !== end && line.trim() === ENV_BACKUP_FOOTER,
    )
  ) {
    throw new Error("Invalid Lore env backup block.");
  }

  const entries: TextBackupEntry[] = [];
  const seen = new Set<string>();
  for (const raw of lines.slice(start + 1, end)) {
    const body = raw.replace(/^#\s*/, "");
    const sepIdx = body.lastIndexOf(ENV_LORE_SET);
    if (!/^#\s+/.test(raw) || sepIdx === -1) {
      throw new Error("Invalid Lore env backup entry.");
    }
    const priorPart = body.slice(0, sepIdx).trim();
    const loreValue = body.slice(sepIdx + ENV_LORE_SET.length).trim();
    let key: string;
    let priorValue: string | null;
    const eq = priorPart.indexOf("=");
    if (eq > 0) {
      key = priorPart.slice(0, eq).trim();
      priorValue = priorPart.slice(eq + 1).trim();
    } else if (priorPart.endsWith(ENV_UNSET)) {
      key = priorPart.slice(0, -ENV_UNSET.length).trim();
      priorValue = null;
    } else {
      throw new Error("Invalid Lore env backup entry.");
    }
    if (!ENV_BACKUP_KEYS.has(key) || seen.has(key) || loreValue.length === 0) {
      throw new Error("Invalid Lore env backup entry.");
    }
    seen.add(key);
    entries.push({ key, priorValue, loreValue });
  }
  if (entries.length === 0) throw new Error("Empty Lore env backup block.");
  return { content: stripBackupBlock(content, start, end), entries };
}

function formatEnvBackupBlock(entries: TextBackupEntry[]): string {
  const lines = [ENV_BACKUP_HEADER];
  for (const entry of entries) {
    const priorPart =
      entry.priorValue === null
        ? `${entry.key} ${ENV_UNSET}`
        : `${entry.key}=${entry.priorValue}`;
    lines.push(`#   ${priorPart}${ENV_LORE_SET}${entry.loreValue}`);
  }
  lines.push(ENV_BACKUP_FOOTER);
  return lines.join("\n");
}

/** Match `KEY=`, `KEY =`, or `export KEY=` (dotenv-style), capturing nothing. */
function envAssignPattern(key: string): RegExp {
  return new RegExp(
    `^\\s*(?:export\\s+)?${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=`,
  );
}

/** Split off a single trailing newline so we don't carry an empty last line. */
function envLines(content: string): string[] {
  const c = content.endsWith("\n") ? content.slice(0, -1) : content;
  return c === "" ? [] : c.split("\n");
}

/** Re-join lines to a file body with exactly one trailing newline (or ""). */
function envJoin(lines: string[]): string {
  return lines.length ? `${lines.join("\n")}\n` : "";
}

/** Read the effective final live dotenv value, or null if absent. */
export function getEnvValue(content: string, key: string): string | null {
  const valuePattern = new RegExp(
    `^\\s*(?:export\\s+)?${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*(.*?)\\s*$`,
  );
  let value: string | null = null;
  for (const line of envLines(content)) {
    if (/^\s*#/.test(line)) continue;
    const m = valuePattern.exec(line);
    if (m) value = m[1];
  }
  return value;
}

/** Upsert one canonical `KEY=value`, removing shadowing live duplicates. */
export function setEnvValueRaw(
  content: string,
  key: string,
  value: string,
): string {
  const lines = envLines(content);
  const pattern = envAssignPattern(key);
  const out: string[] = [];
  let replaced = false;
  for (const line of lines) {
    if (!/^\s*#/.test(line) && pattern.test(line)) {
      if (!replaced) {
        out.push(`${key}=${value}`);
        replaced = true;
      }
      continue;
    }
    out.push(line);
  }
  if (!replaced) out.push(`${key}=${value}`);
  return envJoin(out);
}

/** Delete every live (non-comment) assignment of `key`. */
export function deleteEnvKey(content: string, key: string): string {
  const pattern = envAssignPattern(key);
  const out = envLines(content).filter(
    (l) => /^\s*#/.test(l) || !pattern.test(l),
  );
  return envJoin(out);
}

/**
 * Build the commented `.env` backup block from the *original* content and the
 * values lore is about to write (`loreValues`: KEY → bare value). Returns null
 * if a block already exists (preserve the true original) or there are no keys.
 */
export function buildEnvBackupBlock(
  content: string,
  loreValues: Record<string, string>,
): string | null {
  if (content.includes(ENV_BACKUP_HEADER)) return null;
  const keys = Object.keys(loreValues);
  if (keys.length === 0) return null;
  const lines = [ENV_BACKUP_HEADER];
  for (const key of keys) {
    const prior = getEnvValue(content, key);
    const priorPart =
      prior === null ? `${key} ${ENV_UNSET}` : `${key}=${prior}`;
    lines.push(`#   ${priorPart}${ENV_LORE_SET}${loreValues[key]}`);
  }
  lines.push(ENV_BACKUP_FOOTER);
  return lines.join("\n");
}

/** Refresh a Hermes/Gemini backup block for another setup write. */
export function refreshEnvBackupBlock(
  content: string,
  loreValues: Record<string, string>,
): { content: string; block: string } {
  const previous = readEnvBackupBlock(content);
  const config = previous?.content ?? content;
  const previousByKey = new Map(
    previous?.entries.map((entry) => [entry.key, entry]) ?? [],
  );
  const entries: TextBackupEntry[] = [];
  for (const [key, loreValue] of Object.entries(loreValues)) {
    if (!ENV_BACKUP_KEYS.has(key) || loreValue.length === 0) {
      throw new Error(`Invalid Lore env backup key or value: ${key}`);
    }
    const old = previousByKey.get(key);
    const current = getEnvValue(config, key);
    entries.push({
      key,
      priorValue: old && current === old.loreValue ? old.priorValue : current,
      loreValue,
    });
    previousByKey.delete(key);
  }
  entries.push(...previousByKey.values());
  if (entries.length === 0) throw new Error("Empty Lore env backup block.");
  return { content: config, block: formatEnvBackupBlock(entries) };
}

/** Prepend a backup block to the content (block carries no trailing newline). */
export function prependEnvBackupBlock(content: string, block: string): string {
  return content ? `${block}\n${content}` : `${block}\n`;
}

/**
 * Restore a Hermes `.env` from its commented backup block. Per recorded key:
 * revert to the prior value (or delete if originally unset) **only when the
 * file still holds the value lore wrote** — a value the user changed after
 * setup is left untouched and reported as skipped. The block is removed only
 * when every key was reverted.
 */
export function restoreEnvBackup(content: string): {
  content: string;
  summary: RestoreSummary;
} {
  const backup = readEnvBackupBlock(content);
  if (!backup) {
    return {
      content,
      summary: { hadBackup: false, restored: [], skipped: [] },
    };
  }

  const restored: string[] = [];
  const skipped: string[] = [];
  const skippedEntries: TextBackupEntry[] = [];
  let result = backup.content;

  for (const entry of backup.entries) {
    const { key, loreValue, priorValue } = entry;
    // Revert-only-if-unchanged: skip if the user changed the value after setup.
    if (getEnvValue(result, key) !== loreValue) {
      skipped.push(key);
      skippedEntries.push(entry);
      continue;
    }
    result =
      priorValue === null
        ? deleteEnvKey(result, key)
        : setEnvValueRaw(result, key, priorValue);
    restored.push(key);
  }

  if (skippedEntries.length > 0) {
    result = prependEnvBackupBlock(
      result,
      formatEnvBackupBlock(skippedEntries),
    );
  }

  return { content: result, summary: { hadBackup: true, restored, skipped } };
}
