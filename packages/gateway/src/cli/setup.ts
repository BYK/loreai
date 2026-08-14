/**
 * `lore setup [app]` — configure an AI app to route through the Lore gateway.
 *
 * Currently supports:
 *   - codex: writes `openai_base_url` and `model_auto_compact_token_limit`
 *     to `~/.codex/config.toml`
 *   - opencode: writes `provider.openai.options.baseURL` to
 *     `~/.config/opencode/opencode.json` and installs the
 *     `@loreai/opencode` plugin (unless `--no-plugin`)
 *   - claude-code: writes `env.ANTHROPIC_BASE_URL` and `env.DISABLE_AUTO_COMPACT`
 *     to `~/.claude/settings.json`
 *
 * The command auto-detects installed apps when no argument is given,
 * or accepts an explicit app name (e.g. `lore setup codex`).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import {
  assertNoSymlinkPathComponents,
  atomicWriteTrustedFile,
  CommittedAtomicWriteError,
  deleteJsonConfigValue,
  ensureTrustedDirectory,
  opencodeConfigPaths,
  parseJsonConfigText,
  readJsonConfigFile,
  readJsonConfigFileIfExists,
  readTrustedTextFile,
  removeTrustedFile,
  resolveOpencodeConfigPath,
  setJsonConfigValue,
  stageTrustedFileMutation,
  trustedFileExists,
  withTrustedFileTransaction,
  type StagedTrustedFileMutation,
  type TrustedFileIdentity,
  type TrustedFileTransaction,
} from "./json-config";
import { CLAUDE_CODE_FIRST_PARTY_ENV } from "../cch";
import {
  LifecycleLockLostError,
  withLifecycleLock,
  type LifecycleLock,
} from "../lifecycle-lock";
import { readGatewayProcessFile } from "../pidfile";
import { detectAgents } from "./agents";
import {
  refreshJsonBackup,
  parseStableJsonBackup,
  parseJsonSetupJournal,
  prepareJsonSetupJournal,
  selectJsonSetupJournalState,
  applyJsonBackup,
  requireLegacyJsonBackup,
  LORE_BACKUP_KEY,
  refreshTomlBackupBlock,
  prependTomlBackupBlock,
  restoreTomlBackup,
  refreshEnvBackupBlock,
  prependEnvBackupBlock,
  restoreEnvBackup,
  setEnvValueRaw,
  retainSkippedJsonBackup,
  bindJsonBackupGeneration,
  assertJsonBackupConfigState,
  getPath,
  type RestoreSummary,
  type JsonBackup,
  type JsonSetupJournal,
} from "./setup-backup";

// ---------------------------------------------------------------------------
// Supported apps and their setup handlers
// ---------------------------------------------------------------------------

/**
 * Optional plugin install for an app. When set, `lore setup <app>` will
 * install the npm package and register it in the agent's config unless
 * the user passes `--no-plugin`.
 */
interface PluginSpec {
  /** npm package name (e.g. `@loreai/opencode`) */
  npmPackage: string;
  /**
   * Apply the plugin to the parsed config (mutates the config in place).
   * Returns true if the config was modified.
   */
  apply: (config: Record<string, unknown>) => boolean;
}

class PluginInstallFailure extends Error {}

type SetupGuard = LifecycleLock;

interface SetupExternalEffect {
  apply: (guard: LifecycleLock) => boolean;
  prepareCommit: (guard: LifecycleLock) => void;
  establishCommitPoint: (guard: LifecycleLock) => boolean;
  commit: (guard: LifecycleLock) => void;
  rollback: (guard: LifecycleLock) => void;
}

class PublishedSetupCommitError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

class SetupExternalTransaction {
  private readonly effects: SetupExternalEffect[] = [];
  private readonly commitReports: Array<() => void> = [];
  private active = true;
  private durableCommitPoint = false;

  constructor(private readonly guard: LifecycleLock) {}

  apply(effect: SetupExternalEffect): boolean {
    if (!this.active) throw new Error("Setup external transaction is closed.");
    this.effects.push(effect);
    return effect.apply(this.guard);
  }

  onCommit(report: () => void): void {
    if (!this.active) throw new Error("Setup external transaction is closed.");
    this.commitReports.push(report);
  }

  prepareCommit(): void {
    if (!this.active) return;
    for (const effect of this.effects) {
      this.guard.assertOwned();
      effect.prepareCommit(this.guard);
    }
  }

  establishCommitPoint(): void {
    if (!this.active) return;
    for (const effect of this.effects) {
      this.guard.assertOwned();
      try {
        if (effect.establishCommitPoint(this.guard)) {
          this.durableCommitPoint = true;
        }
      } catch (error) {
        if (error instanceof PublishedSetupCommitError) {
          this.durableCommitPoint = true;
        }
        throw error;
      }
    }
  }

  hasDurableCommitPoint(): boolean {
    return this.durableCommitPoint;
  }

  commit(): void {
    if (!this.active) return;
    for (const effect of this.effects) {
      this.guard.assertOwned();
      effect.commit(this.guard);
    }
    this.active = false;
    for (const report of this.commitReports) report();
  }

  rollback(): void {
    if (!this.active) return;
    if (this.durableCommitPoint) {
      throw new Error(
        "Setup external transaction crossed its durable commit point and cannot be rolled back.",
      );
    }
    const rollbackErrors: unknown[] = [];
    for (const effect of [...this.effects].reverse()) {
      try {
        this.guard.assertOwned();
        effect.rollback(this.guard);
      } catch (error) {
        rollbackErrors.push(error);
      }
    }
    this.active = false;
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        rollbackErrors,
        "Setup external side effects could not be fully rolled back.",
      );
    }
  }

  abandon(): void {
    this.active = false;
  }
}

type SetupExternalEffectTestPhase =
  | "after-installed-journal"
  | "before-prepare"
  | "before-install-mutation"
  | "before-rollback-mutation"
  | "before-journal-cleanup";
let setupExternalEffectHook:
  | ((phase: SetupExternalEffectTestPhase) => void)
  | null = null;

/** Test-only interruption/failure injection around external-effect commit. */
export function _setSetupExternalEffectHookForTest(
  hook: ((phase: SetupExternalEffectTestPhase) => void) | null,
): void {
  setupExternalEffectHook = hook;
}

interface AppSetup {
  /** Internal identifier matching AgentDef.name */
  agentName: string;
  /** Human-readable name */
  displayName: string;
  /** Run setup. Returns false only when setup stops without succeeding. */
  run: (
    baseUrl: string,
    noPlugin: boolean,
    guard: SetupGuard,
    external: SetupExternalTransaction,
  ) => boolean | void;
  /** Optional plugin install + registration */
  plugin?: PluginSpec;
  /** Validate every file/backup this undo may read without mutating anything. */
  prevalidateUndo: (stagedPaths?: readonly string[]) => void;
  /** Every persistent file this app's setup or undo may mutate. */
  undoPaths: () => string[];
  /** Undo a previous `lore setup` for this app, restoring the saved backup. */
  undo: (guard: SetupGuard, stagedPaths?: readonly string[]) => RestoreSummary;
}

/**
 * OpenCode plugin spec: installs `@loreai/opencode` and adds it to the
 * `plugin` array of `~/.config/opencode/opencode.json`.
 *
 * Defined before SUPPORTED_APPS so it can be referenced by the opencode
 * entry without a forward-reference.
 */
export const opencodePluginSpec: PluginSpec = {
  npmPackage: "@loreai/opencode",
  apply: (config) => {
    const existing = config.plugin;
    if (Array.isArray(existing) && existing.includes("@loreai/opencode")) {
      return false;
    }
    if (Array.isArray(existing)) {
      existing.push("@loreai/opencode");
    } else {
      config.plugin = ["@loreai/opencode"];
    }
    return true;
  },
};

const SUPPORTED_APPS: AppSetup[] = [
  {
    agentName: "codex",
    displayName: "Codex",
    run: (baseUrl, _noPlugin, guard) => setupCodex(baseUrl, guard),
    prevalidateUndo: prevalidateCodexUndo,
    undoPaths: () => [codexConfigPath()],
    undo: undoCodex,
    // No Lore plugin for Codex — the gateway URL + DISABLE_AUTO_COMPACT in
    // the TOML is the full integration. There's no plugin host in Codex.
  },
  {
    agentName: "opencode",
    displayName: "OpenCode",
    run: (baseUrl, noPlugin, guard, external) =>
      setupOpencode(baseUrl, noPlugin, guard, external),
    plugin: opencodePluginSpec,
    prevalidateUndo: (paths) =>
      prevalidateOpencodeUndo(paths?.filter((_path, index) => index % 2 === 0)),
    undoPaths: () =>
      opencodeConfigPaths(opencodeConfigPath()).flatMap((path) => [
        path,
        jsonBackupPath(path),
      ]),
    undo: (guard, paths) =>
      undoOpencode(
        guard,
        paths?.filter((_path, index) => index % 2 === 0),
      ),
  },
  {
    agentName: "claude-code",
    displayName: "Claude Code",
    run: (baseUrl, _noPlugin, guard) => setupClaudeCode(baseUrl, guard),
    prevalidateUndo: () => prevalidateJsonUndo(claudeCodeSettingsPath()),
    undoPaths: () => [
      claudeCodeSettingsPath(),
      jsonBackupPath(claudeCodeSettingsPath()),
    ],
    undo: undoClaudeCode,
    // No Lore plugin for Claude Code — Anthropic controls the API surface
    // and there's no plugin host. The ANTHROPIC_BASE_URL env var is the
    // only integration point.
  },
  {
    agentName: "hermes",
    displayName: "Hermes Agent",
    run: (baseUrl, _noPlugin, guard) => setupHermes(baseUrl, guard),
    prevalidateUndo: prevalidateHermesUndo,
    undoPaths: () => [hermesEnvPath()],
    undo: undoHermes,
    // No Lore plugin registered here — Hermes reads `OPENAI_BASE_URL` +
    // `HERMES_INFERENCE_PROVIDER` from `~/.hermes/.env` (python-dotenv) at
    // launch. That env pair is the whole integration; the `lore-hermes`
    // plugin is a separate `pip install` concern.
  },
  {
    agentName: "pi",
    displayName: "Pi",
    run: (baseUrl, _noPlugin, guard) => setupPi(baseUrl, guard),
    prevalidateUndo: () => prevalidateJsonUndo(piModelsConfigPath()),
    undoPaths: () => [
      piModelsConfigPath(),
      jsonBackupPath(piModelsConfigPath()),
    ],
    undo: undoPi,
    // The `@loreai/pi` extension is the richer path (dynamic per-provider
    // routing + attribution headers), but it's installed via Pi's own
    // `~/.pi/settings.json` `packages` array + `pi install`, not npm. This
    // handler writes the static `models.json` baseURL overrides — the
    // equivalent of opencode's `--no-plugin` fallback — which is all the
    // gateway can wire up without shelling out to `pi`.
  },
  {
    agentName: "copilot",
    displayName: "GitHub Copilot CLI",
    run: (baseUrl, _noPlugin, guard) => setupCopilot(baseUrl, guard),
    prevalidateUndo: () => {},
    undoPaths: () => [],
    undo: undoCopilot,
    // Copilot CLI has NO config-file endpoint override — interception is only
    // via the COPILOT_API_URL env var. `run` prints the required `lore run
    // copilot` / export guidance; there is nothing to persist, so `undo` is an
    // informational no-op. Inventory reads COPILOT_API_URL from the environment.
  },
  {
    agentName: "gemini",
    displayName: "Gemini CLI",
    run: (baseUrl, _noPlugin, guard) => setupGemini(baseUrl, guard),
    prevalidateUndo: prevalidateGeminiUndo,
    undoPaths: () => [geminiEnvPath()],
    undo: undoGemini,
    // Gemini CLI reads GOOGLE_GEMINI_BASE_URL from ~/.gemini/.env (dotenv), so
    // this persists the base URL there — the native generateContent equivalent
    // of the Hermes env writer.
  },
];

// ---------------------------------------------------------------------------
// Plugin install + registration
// ---------------------------------------------------------------------------

interface NpmPackageGeneration {
  path: string;
  device: string;
  inode: string;
  mode: string;
  uid: string;
  gid: string;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
  birthtimeNs: string;
  manifestDevice: string;
  manifestInode: string;
  manifestMode: string;
  manifestUid: string;
  manifestGid: string;
  manifestSize: string;
  manifestMtimeNs: string;
  manifestCtimeNs: string;
  manifestBirthtimeNs: string;
}

type NpmPackageSnapshot =
  | { state: "absent" }
  | {
      state: "installed";
      version: string | null;
      source: string | null;
      generation: NpmPackageGeneration;
    }
  | { state: "unknown" };

type KnownNpmPackageSnapshot = Exclude<
  NpmPackageSnapshot,
  { state: "unknown" }
>;

function inspectPackageGeneration(path: string): NpmPackageGeneration | null {
  try {
    const stats = lstatSync(path, { bigint: true });
    const manifest = lstatSync(join(path, "package.json"), { bigint: true });
    if (!manifest.isFile() || manifest.isSymbolicLink()) return null;
    return {
      path,
      device: stats.dev.toString(),
      inode: stats.ino.toString(),
      mode: stats.mode.toString(),
      uid: stats.uid.toString(),
      gid: stats.gid.toString(),
      size: stats.size.toString(),
      mtimeNs: stats.mtimeNs.toString(),
      ctimeNs: stats.ctimeNs.toString(),
      birthtimeNs: stats.birthtimeNs.toString(),
      manifestDevice: manifest.dev.toString(),
      manifestInode: manifest.ino.toString(),
      manifestMode: manifest.mode.toString(),
      manifestUid: manifest.uid.toString(),
      manifestGid: manifest.gid.toString(),
      manifestSize: manifest.size.toString(),
      manifestMtimeNs: manifest.mtimeNs.toString(),
      manifestCtimeNs: manifest.ctimeNs.toString(),
      manifestBirthtimeNs: manifest.birthtimeNs.toString(),
    };
  } catch {
    return null;
  }
}

function npmGlobalRoot(): string | null {
  const result = spawnSync("npm", ["root", "-g"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.error || result.status !== 0) return null;
  const root = result.stdout.trim();
  return root && isAbsolute(root) ? resolve(root) : null;
}

function npmPackagePath(
  npmPackage: string,
  record: Record<string, unknown>,
): string | null {
  if (typeof record.path === "string" && isAbsolute(record.path)) {
    return resolve(record.path);
  }
  const root = npmGlobalRoot();
  if (!root) return null;
  return resolve(root, ...npmPackage.split("/"));
}

/** Capture enough global npm state to restore a package without guessing. */
function inspectNpmPackage(npmPackage: string): NpmPackageSnapshot {
  const result = spawnSync(
    "npm",
    ["ls", "-g", npmPackage, "--json", "--depth=0", "--long"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  if (result.error || result.status === null) return { state: "unknown" };
  try {
    const parsed = JSON.parse(result.stdout) as {
      dependencies?: Record<string, unknown>;
      error?: unknown;
    };
    if (parsed.error !== undefined) return { state: "unknown" };
    if (parsed.dependencies !== undefined) {
      if (
        typeof parsed.dependencies !== "object" ||
        parsed.dependencies === null ||
        Array.isArray(parsed.dependencies)
      ) {
        return { state: "unknown" };
      }
      if (Object.hasOwn(parsed.dependencies, npmPackage)) {
        const dependency = parsed.dependencies[npmPackage];
        const record =
          typeof dependency === "object" &&
          dependency !== null &&
          !Array.isArray(dependency)
            ? (dependency as Record<string, unknown>)
            : {};
        const version =
          typeof record.version === "string" ? record.version : null;
        let source: string | null = null;
        for (const key of ["resolved", "_resolved", "from", "_from"]) {
          if (typeof record[key] === "string") {
            source = record[key];
            break;
          }
        }
        const packagePath = npmPackagePath(npmPackage, record);
        const generation = packagePath
          ? inspectPackageGeneration(packagePath)
          : null;
        return generation
          ? { state: "installed", version, source, generation }
          : { state: "unknown" };
      }
    }
    return result.status === 0 || result.status === 1
      ? { state: "absent" }
      : { state: "unknown" };
  } catch {
    return { state: "unknown" };
  }
}

function sameNpmPackageSnapshot(
  left: KnownNpmPackageSnapshot,
  right: KnownNpmPackageSnapshot,
): boolean {
  if (left.state !== right.state) return false;
  if (left.state === "absent" || right.state === "absent") return true;
  return (
    left.version === right.version &&
    left.source === right.source &&
    Object.keys(left.generation).every(
      (key) =>
        left.generation[key as keyof NpmPackageGeneration] ===
        right.generation[key as keyof NpmPackageGeneration],
    )
  );
}

/**
 * Run `npm install -g <package>` and stream stdout/stderr to the user.
 * Returns true on success, false on failure (with a helpful error message
 * already printed). A pre-mutation validator may throw before npm starts.
 */
function runNpmInstall(
  npmPackage: string,
  display = npmPackage,
  immediatelyBeforeMutation?: () => void,
): boolean {
  console.log(`[lore] Running: npm install -g ${display}`);
  immediatelyBeforeMutation?.();
  try {
    execFileSync("npm", ["install", "-g", npmPackage], {
      stdio: "inherit",
    });
    return true;
  } catch (e) {
    console.error(`[lore] npm install failed.`);
    if (e instanceof Error) {
      // npm exits with a non-zero status; the error message is usually
      // a generic "Command failed" without useful context, so we point
      // the user at the likely causes.
      console.error(
        `[lore] If you need to skip the plugin install (CI, air-gapped, or no npm on PATH),`,
      );
      console.error(
        `[lore] re-run with --no-plugin: lore setup <app> --no-plugin`,
      );
    }
    return false;
  }
}

function runNpmUninstall(
  npmPackage: string,
  immediatelyBeforeMutation?: () => void,
): boolean {
  console.log(`[lore] Running: npm uninstall -g ${npmPackage}`);
  immediatelyBeforeMutation?.();
  try {
    execFileSync("npm", ["uninstall", "-g", npmPackage], {
      stdio: "inherit",
    });
    return true;
  } catch {
    console.error(
      `[lore] npm uninstall failed while rolling back ${npmPackage}.`,
    );
    return false;
  }
}

const SETUP_EXTERNAL_EFFECT_JOURNAL = "setup-external-effect.json";

interface NpmExternalEffectJournal {
  version: 1;
  ownerToken: string;
  npmPackage: string;
  phase: "prepared" | "installed" | "commit-prepared" | "committed";
  priorState: KnownNpmPackageSnapshot;
  installedState?: KnownNpmPackageSnapshot;
}

interface NpmExternalEffectJournalFile {
  journal: NpmExternalEffectJournal;
  identity: TrustedFileIdentity;
}

export function setupExternalEffectJournalPath(lockPath: string): string {
  return join(dirname(lockPath), SETUP_EXTERNAL_EFFECT_JOURNAL);
}

function parsePackageGeneration(value: unknown): NpmPackageGeneration {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid setup external-effect package generation.");
  }
  const record = value as Record<string, unknown>;
  const fields: Array<keyof NpmPackageGeneration> = [
    "path",
    "device",
    "inode",
    "mode",
    "uid",
    "gid",
    "size",
    "mtimeNs",
    "ctimeNs",
    "birthtimeNs",
    "manifestDevice",
    "manifestInode",
    "manifestMode",
    "manifestUid",
    "manifestGid",
    "manifestSize",
    "manifestMtimeNs",
    "manifestCtimeNs",
    "manifestBirthtimeNs",
  ];
  for (const field of fields) {
    if (typeof record[field] !== "string" || record[field].length === 0) {
      throw new Error("Invalid setup external-effect package generation.");
    }
  }
  if (!isAbsolute(record.path as string)) {
    throw new Error("Invalid setup external-effect package path.");
  }
  return Object.fromEntries(
    fields.map((field) => [field, record[field]]),
  ) as unknown as NpmPackageGeneration;
}

function parseKnownNpmPackageSnapshot(value: unknown): KnownNpmPackageSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid setup external-effect package state.");
  }
  const record = value as Record<string, unknown>;
  if (record.state === "absent") return { state: "absent" };
  if (
    record.state !== "installed" ||
    (record.version !== null && typeof record.version !== "string") ||
    (record.source !== null && typeof record.source !== "string")
  ) {
    throw new Error("Invalid setup external-effect package state.");
  }
  return {
    state: "installed",
    version: record.version,
    source: record.source,
    generation: parsePackageGeneration(record.generation),
  };
}

function parseNpmExternalEffectJournal(
  value: unknown,
): NpmExternalEffectJournal {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid setup external-effect journal.");
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.ownerToken !== "string" ||
    record.ownerToken.length === 0 ||
    record.npmPackage !== opencodePluginSpec.npmPackage ||
    !["prepared", "installed", "commit-prepared", "committed"].includes(
      record.phase as string,
    )
  ) {
    throw new Error("Invalid setup external-effect journal.");
  }
  const phase = record.phase as NpmExternalEffectJournal["phase"];
  const installedState =
    record.installedState === undefined
      ? undefined
      : parseKnownNpmPackageSnapshot(record.installedState);
  if (phase !== "prepared" && !installedState) {
    throw new Error("Invalid setup external-effect journal.");
  }
  return {
    version: 1,
    ownerToken: record.ownerToken,
    npmPackage: opencodePluginSpec.npmPackage,
    phase,
    priorState: parseKnownNpmPackageSnapshot(record.priorState),
    installedState,
  };
}

function readNpmExternalEffectJournal(
  guard: LifecycleLock,
): NpmExternalEffectJournalFile | null {
  const path = setupExternalEffectJournalPath(guard.path);
  const file = readTrustedTextFile(path, { allowMissing: true });
  if (!file) return null;
  try {
    return {
      journal: parseNpmExternalEffectJournal(JSON.parse(file.text) as unknown),
      identity: file.identity,
    };
  } catch (error) {
    throw new Error(
      `Invalid setup external-effect journal ${path}; it was preserved.`,
      { cause: error },
    );
  }
}

function writeNpmExternalEffectJournal(
  guard: LifecycleLock,
  journal: NpmExternalEffectJournal,
  expectedIdentity: TrustedFileIdentity | null,
): TrustedFileIdentity {
  guard.assertOwned();
  return atomicWriteTrustedFile(
    setupExternalEffectJournalPath(guard.path),
    `${JSON.stringify(journal, null, 2)}\n`,
    { expectedIdentity, mode: 0o600 },
  );
}

function removeNpmExternalEffectJournal(
  guard: LifecycleLock,
  identity: TrustedFileIdentity,
): void {
  guard.assertOwned();
  removeTrustedFile(setupExternalEffectJournalPath(guard.path), identity);
}

function sameNpmPackageMetadata(
  left: KnownNpmPackageSnapshot,
  right: KnownNpmPackageSnapshot,
): boolean {
  if (left.state !== right.state) return false;
  if (left.state === "absent" || right.state === "absent") return true;
  return left.version === right.version && left.source === right.source;
}

function sameTrustedFileIdentity(
  left: TrustedFileIdentity,
  right: TrustedFileIdentity,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.birthtimeNs === right.birthtimeNs
  );
}

function externalEffectConflict(message: string): Error {
  process.exitCode = 1;
  console.error(`[lore] ${message}`);
  return new Error(message);
}

function restoreOwnedNpmPackageState(
  npmPackage: string,
  priorState: KnownNpmPackageSnapshot,
  ownedState: KnownNpmPackageSnapshot,
  guard: LifecycleLock,
): void {
  const assertStillOwned = (): void => {
    setupExternalEffectHook?.("before-rollback-mutation");
    guard.assertOwned();
    const current = inspectNpmPackage(npmPackage);
    if (
      current.state === "unknown" ||
      !sameNpmPackageSnapshot(current, ownedState)
    ) {
      throw externalEffectConflict(
        `Global package ${npmPackage} no longer matches Lore's installed generation; successor state was preserved.`,
      );
    }
    guard.assertOwned();
  };
  let commandSucceeded: boolean;
  if (priorState.state === "absent") {
    commandSucceeded = runNpmUninstall(npmPackage, assertStillOwned);
  } else {
    const restoreSpec =
      priorState.source ??
      (priorState.version ? `${npmPackage}@${priorState.version}` : null);
    if (!restoreSpec) {
      throw externalEffectConflict(
        `The prior ${npmPackage} version/source is unavailable; refusing to guess during rollback.`,
      );
    }
    commandSucceeded = runNpmInstall(
      restoreSpec,
      `${npmPackage} at its prior version/source`,
      assertStillOwned,
    );
  }

  const restored = inspectNpmPackage(npmPackage);
  if (
    !commandSucceeded ||
    restored.state === "unknown" ||
    !sameNpmPackageMetadata(restored, priorState)
  ) {
    throw externalEffectConflict(
      `Could not restore the prior global state of ${npmPackage}.`,
    );
  }
}

function preserveNpmExternalEffectJournal(
  guard: LifecycleLock,
  journal: NpmExternalEffectJournal,
): Error | null {
  try {
    const existing = readNpmExternalEffectJournal(guard);
    if (!existing) writeNpmExternalEffectJournal(guard, journal, null);
    return null;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function cleanupCommittedNpmExternalEffectJournal(
  guard: LifecycleLock,
  journal: NpmExternalEffectJournal,
  identity: TrustedFileIdentity,
  invokeTestHook: boolean,
): void {
  const installedState = journal.installedState;
  if (!installedState || journal.phase !== "committed") {
    throw new Error("Setup external-effect journal is not committed.");
  }
  if (invokeTestHook) setupExternalEffectHook?.("before-journal-cleanup");
  guard.assertOwned();
  const before = inspectNpmPackage(journal.npmPackage);
  if (
    before.state === "unknown" ||
    !sameNpmPackageSnapshot(before, installedState)
  ) {
    throw externalEffectConflict(
      `Global package ${journal.npmPackage} changed before setup journal cleanup; successor state and ${setupExternalEffectJournalPath(guard.path)} were preserved.`,
    );
  }
  guard.assertOwned();
  try {
    removeNpmExternalEffectJournal(guard, identity);
  } catch (error) {
    const evidenceError = preserveNpmExternalEffectJournal(guard, journal);
    if (evidenceError) {
      throw new AggregateError(
        [error, evidenceError],
        "Committed setup journal cleanup failed and its recovery evidence could not be restored.",
      );
    }
    throw error;
  }

  const after = inspectNpmPackage(journal.npmPackage);
  if (
    after.state !== "unknown" &&
    sameNpmPackageSnapshot(after, installedState)
  ) {
    return;
  }

  const evidenceError = preserveNpmExternalEffectJournal(guard, journal);
  const conflict = externalEffectConflict(
    `Global package ${journal.npmPackage} changed during setup journal cleanup; successor state was preserved and recovery evidence was restored.`,
  );
  if (evidenceError) {
    throw new AggregateError(
      [conflict, evidenceError],
      "The package changed during committed setup journal cleanup and recovery evidence could not be restored.",
    );
  }
  throw conflict;
}

class NpmPluginInstallEffect implements SetupExternalEffect {
  private installAttempted = false;
  private changed = false;
  private installedState: KnownNpmPackageSnapshot | null = null;
  private journal: NpmExternalEffectJournal | null = null;
  private journalIdentity: TrustedFileIdentity | null = null;

  constructor(
    private readonly npmPackage: string,
    private readonly priorState: KnownNpmPackageSnapshot,
  ) {}

  apply(guard: LifecycleLock): boolean {
    guard.assertOwned();
    if (this.priorState.state === "installed") {
      const current = inspectNpmPackage(this.npmPackage);
      if (
        current.state === "unknown" ||
        !sameNpmPackageSnapshot(current, this.priorState)
      ) {
        console.error(
          `[lore] Global package state for ${this.npmPackage} changed during setup; refusing to overwrite it.`,
        );
        process.exitCode = 1;
        return false;
      }
      this.installedState = this.priorState;
      console.log(`[lore]   already installed globally.`);
      return true;
    }

    guard.assertOwned();
    const beforeInstall = inspectNpmPackage(this.npmPackage);
    if (
      beforeInstall.state === "unknown" ||
      !sameNpmPackageSnapshot(beforeInstall, this.priorState)
    ) {
      console.error(
        `[lore] Global package state for ${this.npmPackage} changed during setup; refusing to overwrite it.`,
      );
      process.exitCode = 1;
      return false;
    }

    this.journal = {
      version: 1,
      ownerToken: guard.owner.token,
      npmPackage: this.npmPackage,
      phase: "prepared",
      priorState: this.priorState,
    };
    this.journalIdentity = writeNpmExternalEffectJournal(
      guard,
      this.journal,
      null,
    );
    this.installAttempted = true;
    console.log(`[lore]   not installed globally — installing…`);
    const installed = runNpmInstall(this.npmPackage, this.npmPackage, () => {
      setupExternalEffectHook?.("before-install-mutation");
      guard.assertOwned();
      const current = inspectNpmPackage(this.npmPackage);
      if (
        current.state === "unknown" ||
        !sameNpmPackageSnapshot(current, this.priorState)
      ) {
        throw externalEffectConflict(
          `Global package state for ${this.npmPackage} changed immediately before installation; successor state was preserved.`,
        );
      }
      guard.assertOwned();
    });
    const after = inspectNpmPackage(this.npmPackage);
    if (after.state === "unknown") {
      console.error(
        `[lore] Could not verify ${this.npmPackage} after npm install.`,
      );
      process.exitCode = 1;
      return false;
    }
    this.installedState = after;
    this.changed = !sameNpmPackageSnapshot(this.priorState, after);
    this.journal = {
      ...this.journal,
      phase: "installed",
      installedState: after,
    };
    this.journalIdentity = writeNpmExternalEffectJournal(
      guard,
      this.journal,
      this.journalIdentity,
    );
    setupExternalEffectHook?.("after-installed-journal");
    if (!installed || after.state !== "installed") {
      if (installed) {
        console.error(
          `[lore] npm install completed but ${this.npmPackage} is not installed globally.`,
        );
      }
      process.exitCode = 1;
      return false;
    }
    return true;
  }

  prepareCommit(guard: LifecycleLock): void {
    guard.assertOwned();
    if (!this.installedState) return;
    const current = inspectNpmPackage(this.npmPackage);
    if (
      current.state === "unknown" ||
      !sameNpmPackageSnapshot(current, this.installedState)
    ) {
      throw externalEffectConflict(
        `Global package ${this.npmPackage} changed before setup commit; file commit was refused and successor state was preserved.`,
      );
    }
    if (this.journal && this.journalIdentity) {
      this.journal = { ...this.journal, phase: "commit-prepared" };
      this.journalIdentity = writeNpmExternalEffectJournal(
        guard,
        this.journal,
        this.journalIdentity,
      );
    }
  }

  establishCommitPoint(guard: LifecycleLock): boolean {
    if (!this.journal || !this.journalIdentity || !this.installedState) {
      return false;
    }
    guard.assertOwned();
    const current = inspectNpmPackage(this.npmPackage);
    if (
      current.state === "unknown" ||
      !sameNpmPackageSnapshot(current, this.installedState)
    ) {
      throw externalEffectConflict(
        `Global package ${this.npmPackage} changed before setup's logical commit; successor state was preserved.`,
      );
    }
    const committedJournal: NpmExternalEffectJournal = {
      ...this.journal,
      phase: "committed",
    };
    try {
      this.journalIdentity = writeNpmExternalEffectJournal(
        guard,
        committedJournal,
        this.journalIdentity,
      );
      this.journal = committedJournal;
    } catch (error) {
      if (error instanceof CommittedAtomicWriteError) {
        const published = readNpmExternalEffectJournal(guard);
        if (
          published?.journal.phase === "committed" &&
          sameTrustedFileIdentity(published.identity, error.identity)
        ) {
          this.journal = committedJournal;
          this.journalIdentity = published.identity;
          throw new PublishedSetupCommitError(error);
        }
        if (!published) this.journalIdentity = null;
      }
      throw error;
    }
    return true;
  }

  commit(guard: LifecycleLock): void {
    if (!this.journal || !this.journalIdentity) return;
    cleanupCommittedNpmExternalEffectJournal(
      guard,
      this.journal,
      this.journalIdentity,
      true,
    );
    this.journal = null;
    this.journalIdentity = null;
  }

  rollback(guard: LifecycleLock): void {
    if (!this.installAttempted) return;
    if (this.journal?.phase === "committed") {
      throw new Error("A logically committed npm setup cannot be rolled back.");
    }
    guard.assertOwned();

    if (!this.installedState) {
      const current = inspectNpmPackage(this.npmPackage);
      if (
        current.state !== "unknown" &&
        sameNpmPackageSnapshot(current, this.priorState)
      ) {
        if (this.journalIdentity) {
          removeNpmExternalEffectJournal(guard, this.journalIdentity);
        }
        this.journalIdentity = null;
        return;
      }
      throw externalEffectConflict(
        `Could not prove ownership of ${this.npmPackage} after an unverifiable npm install; it was left untouched.`,
      );
    }
    if (this.changed) {
      restoreOwnedNpmPackageState(
        this.npmPackage,
        this.priorState,
        this.installedState,
        guard,
      );
    } else {
      const current = inspectNpmPackage(this.npmPackage);
      if (
        current.state === "unknown" ||
        !sameNpmPackageSnapshot(current, this.priorState)
      ) {
        throw externalEffectConflict(
          `Global package ${this.npmPackage} changed during rollback; successor state was preserved.`,
        );
      }
    }
    if (this.journalIdentity) {
      removeNpmExternalEffectJournal(guard, this.journalIdentity);
    }
    this.journal = null;
    this.journalIdentity = null;
  }
}

/** Recover an interrupted npm setup effect while holding the lifecycle lock. */
export function reconcileSetupExternalEffects(guard: LifecycleLock): void {
  guard.assertOwned();
  const file = readNpmExternalEffectJournal(guard);
  if (!file) return;
  const { journal } = file;
  const current = inspectNpmPackage(journal.npmPackage);
  if (current.state === "unknown") {
    throw externalEffectConflict(
      `Could not inspect ${journal.npmPackage} while recovering ${setupExternalEffectJournalPath(guard.path)}; the journal was preserved.`,
    );
  }

  if (
    journal.phase !== "committed" &&
    sameNpmPackageSnapshot(current, journal.priorState)
  ) {
    removeNpmExternalEffectJournal(guard, file.identity);
    return;
  }

  if (journal.phase === "committed") {
    if (
      journal.installedState &&
      sameNpmPackageSnapshot(current, journal.installedState)
    ) {
      cleanupCommittedNpmExternalEffectJournal(
        guard,
        journal,
        file.identity,
        false,
      );
      return;
    }
    throw externalEffectConflict(
      `Global package ${journal.npmPackage} no longer matches the committed setup generation; successor state and ${setupExternalEffectJournalPath(guard.path)} were preserved.`,
    );
  }

  if (
    journal.installedState &&
    sameNpmPackageSnapshot(current, journal.installedState)
  ) {
    console.error(
      `[lore] Recovering interrupted global installation of ${journal.npmPackage}.`,
    );
    restoreOwnedNpmPackageState(
      journal.npmPackage,
      journal.priorState,
      journal.installedState,
      guard,
    );
    removeNpmExternalEffectJournal(guard, file.identity);
    return;
  }

  throw externalEffectConflict(
    `Global package ${journal.npmPackage} no longer matches the interrupted setup generation; successor state and ${setupExternalEffectJournalPath(guard.path)} were preserved.`,
  );
}

/**
 * Apply the plugin's config registration and write the result back to disk.
 * `configPath` is the path the user-facing handler writes to (so the
 * plugin registration is in the same file the user just inspected).
 */
// Plugin registration is committed with the config transaction below.

/**
 * Install a plugin (if not already installed) and register it in the
 * agent's config file. Never throws; returns true on full success,
 * false if the install or registration step failed.
 *
 * Called by `setupOpencode` after writing the gateway URL to the config.
 * The config file the user-facing handler just wrote is the one we
 * re-read, register the plugin into, and write back.
 */
// npm installation is deliberately the final transaction callback.

// ---------------------------------------------------------------------------
// Gateway URL normalization
// ---------------------------------------------------------------------------

/** Default gateway port (matches DEFAULT_PORTS[0] in start.ts) */
const DEFAULT_PORT = 3207;

/**
 * Decide which port `lore setup` should bake into the written config.
 *
 * - Remote setup ignores the port entirely (the remote URL is authoritative).
 * - An explicit `--port` always wins (the user knows what they want).
 * - Otherwise, prefer a *detected live* gateway port. This fixes the mismatch
 *   where setup hardcoded 3207 but the gateway had fallen back to 5673 or a
 *   random port (`start.ts` DEFAULT_PORTS chain).
 * - When nothing is detected, return undefined so `normalizeBaseUrl` falls
 *   back to the default port.
 */
export function chooseSetupPort(input: {
  explicitPort?: number;
  remoteUrl?: string;
  authenticatedPort?: number | null;
}): number | undefined {
  if (input.remoteUrl) return undefined;
  if (input.explicitPort !== undefined) return input.explicitPort;
  if (input.authenticatedPort != null) return input.authenticatedPort;
  return undefined;
}

/**
 * Build the post-setup liveness notice. Pure so the PASS/WARN copy is
 * unit-testable. `origin` is the gateway base URL without the `/v1` suffix
 * (what `probeGateway` hits).
 */
export function formatLivenessNotice(input: {
  alive: boolean;
  origin: string;
  remote: boolean;
}): { ok: boolean; lines: string[] } {
  if (input.alive) {
    return {
      ok: true,
      lines: [`[lore] ✓ Gateway is reachable at ${input.origin}.`],
    };
  }
  const lines = [
    `[lore] ⚠ Gateway is not reachable at ${input.origin}.`,
    `[lore]   ${input.remote ? "The agent will fail to connect until the remote gateway is running." : "The agent will fail to connect until a gateway is running."}`,
  ];
  if (input.remote) {
    lines.push(
      `[lore]   Ensure the remote gateway is up and reachable, then try again.`,
    );
  } else {
    lines.push(
      `[lore]   Start one in the background:  lore start --bg`,
      `[lore]   …then re-run this setup so the live port is written.`,
      `[lore]   Or skip the global redirect entirely and use:  lore run`,
    );
  }
  return { ok: false, lines };
}

/**
 * Post-setup guidance steering terminal users toward `lore run` (no global
 * redirect, gateway lifecycle tied to the agent) and framing `lore setup` as
 * the path for GUI/IDE agents that lore can't launch. Pure for testing.
 */
export function formatSetupGuidance(): string[] {
  return [
    `[lore] Tip: for terminal use, \`lore run\` (or just \`lore\`) launches your agent`,
    `[lore]   through the gateway with no global config, and stops it automatically`,
    `[lore]   on exit. \`lore setup\` is best for GUI/IDE agents lore can't launch`,
    `[lore]   (Claude Desktop, IDE extensions) — keep a gateway up with \`lore start --bg\`.`,
  ];
}

/**
 * Detect an owner-authenticated local gateway and return its recorded port.
 */
async function detectAuthenticatedGatewayPort(): Promise<number | null> {
  const record = readGatewayProcessFile();
  if (!record) return null;
  const { probeGatewayProcess } = await import("./start");
  return (await probeGatewayProcess(record)) ? record.port : null;
}

/**
 * Normalize a gateway URL for use as a provider base URL.
 * Ensures the URL ends with `/v1` (required by Codex). Remote values must be
 * absolute HTTP(S) URLs without credentials, a query, or a fragment.
 */
export function normalizeBaseUrl(
  remoteUrl: string | undefined,
  port: number | undefined,
): string {
  if (remoteUrl !== undefined) {
    const value = remoteUrl.trim();
    if (!value) throw new Error("Remote URL cannot be empty.");
    const parsed = parseRemoteUrl(value);
    const path = parsed.pathname.replace(/\/+$/, "");
    parsed.pathname = path.endsWith("/v1") ? path : `${path}/v1`;
    return parsed.toString();
  }
  if (port !== undefined) {
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error(`Invalid port "${port}". Must be 0–65535.`);
    }
  }
  return `http://127.0.0.1:${port ?? DEFAULT_PORT}/v1`;
}

/**
 * Parse an untrusted remote URL without including its potentially sensitive
 * value in any error. Raw delimiters are checked so empty userinfo/query/hash
 * components cannot disappear during WHATWG URL normalization.
 */
function parseRemoteUrl(value: string): URL {
  const invalid = (): never => {
    throw new Error(
      "Invalid remote URL. Only HTTP and HTTPS URLs without credentials, query parameters, or fragments are allowed.",
    );
  };
  // oxlint-disable-next-line no-control-regex -- intentional control-character sanitization
  if (/[\x00-\x1f\x7f"\\]/.test(value)) invalid();
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(value)) invalid();

  const parsed = (() => {
    try {
      return new URL(value);
    } catch {
      return invalid();
    }
  })();
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") invalid();

  const authorityStart = value.indexOf("://") + 3;
  const authorityEndOffset = value.slice(authorityStart).search(/[/?#]/);
  const authorityEnd =
    authorityEndOffset === -1
      ? value.length
      : authorityStart + authorityEndOffset;
  const authority = value.slice(authorityStart, authorityEnd);
  if (!authority || authority.includes("@") || !parsed.hostname) invalid();
  if (value.includes("?") || value.includes("#")) invalid();
  if (parsed.username || parsed.password) invalid();

  return parsed;
}

// ---------------------------------------------------------------------------
// Codex config.toml updater
// ---------------------------------------------------------------------------

/** Path to the Codex user-level config file. */
export function codexConfigPath(): string {
  return join(homedir(), ".codex", "config.toml");
}

/**
 * Token limit value large enough to effectively disable Codex auto-compaction.
 * Lore manages context via its own gradient context manager and distillation
 * pipeline, so client-side compaction is undesirable.
 */
const CODEX_COMPACT_DISABLE_LIMIT = 999999999;

/**
 * Update (or create) the Codex user-level `config.toml` to set
 * `openai_base_url` to the Lore gateway and disable auto-compaction.
 *
 * Strategy (per key):
 * - If the key already exists as a top-level key, replace it.
 * - Otherwise insert it at the top of the file (before any [section]).
 * - Preserves all other config, comments, and sections.
 * - Idempotent: running twice produces the same result.
 */
export function updateCodexConfig(content: string, baseUrl: string): string {
  let result = setTopLevelKey(content, "openai_base_url", `"${baseUrl}"`);
  result = setTopLevelKey(
    result,
    "model_auto_compact_token_limit",
    String(CODEX_COMPACT_DISABLE_LIMIT),
  );
  return result;
}

/**
 * Set a top-level TOML key to a value, replacing it if it already exists
 * at the top level, or inserting it before the first `[section]` header.
 *
 * The `value` is written literally (caller must add quotes for strings).
 */
export function setTopLevelKey(
  content: string,
  key: string,
  value: string,
): string {
  const newLine = `${key} = ${value}`;

  // Check if the key already exists as a top-level key.
  // Must match only top-level occurrences (not inside a [section]).
  const lines = content.split("\n");
  const keyPattern = new RegExp(
    `^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=`,
  );
  let replaced = false;

  for (let i = 0; i < lines.length; i++) {
    if (keyPattern.test(lines[i])) {
      // Check this is a top-level key (not inside a [section]).
      // Walk backwards to see if we're inside a section.
      if (isTopLevel(lines, i)) {
        lines[i] = newLine;
        replaced = true;
        break;
      }
    }
  }

  if (replaced) {
    return lines.join("\n");
  }

  // Insert at the top, before the first [section] or at the very start.
  // Find the first non-comment, non-blank line that starts a section.
  const firstSectionIdx = lines.findIndex((line) => /^\s*\[/.test(line));

  if (firstSectionIdx === -1) {
    // No sections — append at end (with blank line separator if needed)
    const trimmed = content.trimEnd();
    return trimmed ? `${trimmed}\n${newLine}\n` : `${newLine}\n`;
  }

  // Insert before the first section, with a blank line after if needed
  const before = lines.slice(0, firstSectionIdx);
  const after = lines.slice(firstSectionIdx);

  // Remove trailing blank lines from 'before' to avoid double-spacing
  while (before.length > 0 && before[before.length - 1].trim() === "") {
    before.pop();
  }

  const beforeStr = before.length > 0 ? `${before.join("\n")}\n` : "";
  return `${beforeStr}${newLine}\n\n${after.join("\n")}`;
}

/**
 * Check whether the line at `index` is a top-level key (not inside a [section]).
 * Walks backwards from the line; if a `[section]` header is found before
 * reaching the start of the file, the key belongs to that section.
 */
function isTopLevel(lines: string[], index: number): boolean {
  for (let i = index - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line === "" || line.startsWith("#")) continue;
    // If we hit a section header, this key is inside that section
    if (line.startsWith("[")) return false;
    // Other bare keys don't tell us anything — keep walking back
  }
  // Reached the start of the file without hitting a section header → top level
  return true;
}

// ---------------------------------------------------------------------------
// Codex setup
// ---------------------------------------------------------------------------

function setupCodex(baseUrl: string, guard: SetupGuard): void {
  guard.assertOwned();
  const configPath = codexConfigPath();
  const configDir = join(homedir(), ".codex");

  guard.assertOwned();
  ensureTrustedDirectory(configDir);

  const existingFile = readTrustedTextFile(configPath, { allowMissing: true });
  const content = existingFile?.text ?? "";

  // Capture a commented backup block from the ORIGINAL content (before lore's
  // writes), recording the values lore is about to set so undo can revert only
  // if the file still holds them. Then apply lore's changes and prepend it.
  const prepared = refreshTomlBackupBlock(content, {
    openai_base_url: `"${baseUrl}"`,
    model_auto_compact_token_limit: String(CODEX_COMPACT_DISABLE_LIMIT),
  });
  const updated = updateCodexConfig(prepared.content, baseUrl);
  const final = prependTomlBackupBlock(updated, prepared.block);
  guard.assertOwned();
  atomicWriteTrustedFile(configPath, final, {
    expectedIdentity: existingFile?.identity ?? null,
  });

  console.log(`[lore] Codex configured to use Lore gateway.`);
  console.log(`[lore]   openai_base_url = "${baseUrl}"`);
  console.log(
    `[lore]   model_auto_compact_token_limit = ${CODEX_COMPACT_DISABLE_LIMIT} (auto-compaction disabled)`,
  );
  console.log(`[lore]   Config: ${configPath}`);
}

// ---------------------------------------------------------------------------
// JSON config updater
// ---------------------------------------------------------------------------

/**
 * Parse JSON config, returning `{}` for missing files and an empty object
 * for syntactically invalid files (with a warning). Callers should
 * validate the resulting object structure before use.
 */
export function readJsonConfig(path: string): Record<string, unknown> {
  const file = readJsonConfigFileIfExists(path);
  return file?.config ?? {};
}

/**
 * Update (or create) a JSON config file by deep-merging `updates` into the
 * top-level object. Preserves all other keys, arrays, and nested objects.
 *
 * For object values, recursively merges. For primitive/array values, replaces
 * (which matches the behavior we need for `env.ANTHROPIC_BASE_URL` and
 * `provider.<id>.options.baseURL` — both should be string-typed).
 *
 * Writes a 2-space indented JSON file with a trailing newline.
 */
export function updateJsonConfig(
  path: string,
  updates: Record<string, unknown>,
): void {
  const file = readJsonConfigFileIfExists(path);
  const merged = deepMerge(file?.config ?? {}, updates);
  atomicWriteTrustedFile(path, `${JSON.stringify(merged, null, 2)}\n`, {
    expectedIdentity: file?.identity ?? null,
  });
}

/**
 * Recursively merge `b` into `a` (mutates `a` for object targets).
 * Object values are merged key-by-key; all other values are replaced.
 */
function deepMerge(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [key, bVal] of Object.entries(b)) {
    const aVal = out[key];
    if (
      aVal !== null &&
      aVal !== undefined &&
      typeof aVal === "object" &&
      !Array.isArray(aVal) &&
      bVal !== null &&
      typeof bVal === "object" &&
      !Array.isArray(bVal)
    ) {
      out[key] = deepMerge(
        aVal as Record<string, unknown>,
        bVal as Record<string, unknown>,
      );
    } else {
      out[key] = bVal;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// JSON backup sidecar file (Claude Code, OpenCode, Pi)
// ---------------------------------------------------------------------------
//
// The backup that makes `lore setup` reversible used to live as a top-level
// `_loreBackup` key inside the JSON config. OpenCode's config schema is
// `additionalProperties: false`, so that key made newer OpenCode reject the
// whole file ("unknown field `_loreBackup`") and refuse to start. The backup
// now lives in a sidecar file next to the config, so the config itself only
// ever carries schema-valid keys.

/** Path to the sidecar backup file for a JSON config (`<config>.lore-backup`). */
export function jsonBackupPath(configPath: string): string {
  return `${configPath}.lore-backup`;
}

/**
 * Read + validate the sidecar backup for a JSON config, or null if it is
 * absent, unreadable, or corrupt. Any read failure (missing file, permission
 * error, path-is-a-directory, etc.) or parse failure is treated as "no
 * backup" — never thrown — so read-only callers (`lore doctor`, `lore setup
 * status`) and `undo` degrade gracefully instead of crashing on a bad file.
 */
export function loadJsonSetupBackup(configPath: string): JsonBackup | null {
  try {
    const sidecar = requireJsonSetupSidecar(configPath);
    if (!sidecar) return null;
    return isJsonSetupJournal(sidecar.value)
      ? selectPendingJsonSetupBackup(configPath, sidecar.value)
      : sidecar.value;
  } catch {
    return null;
  }
}

interface JsonSetupSidecarFile {
  value: JsonBackup | JsonSetupJournal;
  identity: TrustedFileIdentity;
}

function backupGeneration(identity: TrustedFileIdentity): {
  device: string;
  inode: string;
  birthtimeNs: string;
  size: string;
  mtimeNs: string;
} {
  return {
    device: identity.dev.toString(),
    inode: identity.ino.toString(),
    birthtimeNs: identity.birthtimeNs.toString(),
    size: identity.size.toString(),
    mtimeNs: identity.mtimeNs.toString(),
  };
}

function requireJsonSetupSidecar(
  configPath: string,
): JsonSetupSidecarFile | null {
  const backupPath = jsonBackupPath(configPath);
  let file: ReturnType<typeof readTrustedTextFile>;
  try {
    file = readTrustedTextFile(backupPath, { allowMissing: true });
  } catch (error: unknown) {
    const detail = error instanceof Error ? ` ${error.message}` : "";
    throw new Error(
      `Could not read Lore setup backup ${backupPath}.${detail}`,
      {
        cause: error,
      },
    );
  }
  if (!file) return null;
  try {
    const value = JSON.parse(file.text) as unknown;
    return {
      value:
        typeof value === "object" &&
        value !== null &&
        "version" in value &&
        value.version === 2
          ? parseJsonSetupJournal(value)
          : parseStableJsonBackup(value),
      identity: file.identity,
    };
  } catch (error) {
    throw new Error(`Invalid Lore setup backup ${backupPath}.`, {
      cause: error,
    });
  }
}

function isJsonSetupJournal(
  value: JsonBackup | JsonSetupJournal,
): value is JsonSetupJournal {
  return value.version === 2;
}

function selectPendingJsonSetupBackup(
  configPath: string,
  journal: JsonSetupJournal,
): JsonBackup | null {
  const configFile = readJsonConfigFileIfExists(configPath);
  const state = selectJsonSetupJournalState(
    journal,
    configFile?.text ?? null,
    configFile?.config ?? {},
  );
  return state === "old" ? journal.oldBackup : journal.newBackup;
}

interface JsonSetupBackupFile {
  backup: JsonBackup | null;
  identity: TrustedFileIdentity;
}

function requireJsonSetupBackup(
  configPath: string,
): JsonSetupBackupFile | null {
  const sidecar = requireJsonSetupSidecar(configPath);
  if (!sidecar) return null;
  if (!isJsonSetupJournal(sidecar.value) && sidecar.value.version === 1) {
    const configFile = readJsonConfigFileIfExists(configPath);
    if (!configFile) {
      throw new Error(
        `Legacy Lore setup backup cannot prove whether missing config ${configPath} should be restored; provenance was preserved.`,
      );
    }
  }
  if (!isJsonSetupJournal(sidecar.value) && sidecar.value.version === 3) {
    const configFile = readJsonConfigFileIfExists(configPath);
    if (!configFile) {
      if (sidecar.value.originalExists) {
        throw new Error(
          `Current config generation is missing for Lore setup backup ${jsonBackupPath(configPath)}.`,
        );
      }
    } else {
      assertJsonBackupConfigState(
        sidecar.value,
        configFile.config,
        backupGeneration(configFile.identity),
      );
    }
  }
  return {
    backup: isJsonSetupJournal(sidecar.value)
      ? selectPendingJsonSetupBackup(configPath, sidecar.value)
      : sidecar.value,
    identity: sidecar.identity,
  };
}

/** Resolve a prepared journal to a stable, generation-bound sidecar. */
function recoverJsonSetupJournal(
  configPath: string,
  guard: SetupGuard,
): JsonSetupBackupFile | null {
  const sidecar = requireJsonSetupSidecar(configPath);
  if (!sidecar) return null;
  if (!isJsonSetupJournal(sidecar.value)) {
    const configFile = readJsonConfigFileIfExists(configPath);
    if (!configFile && sidecar.value.version === 1) {
      throw new Error(
        `Legacy Lore setup backup cannot prove whether missing config ${configPath} should be restored; provenance was preserved.`,
      );
    }
    if (
      !configFile &&
      sidecar.value.version === 3 &&
      sidecar.value.originalExists
    ) {
      throw new Error(
        `Current config generation is missing for Lore setup backup ${jsonBackupPath(configPath)}.`,
      );
    }
    if (configFile) {
      assertJsonBackupConfigState(
        sidecar.value,
        configFile.config,
        backupGeneration(configFile.identity),
      );
    }
    return { backup: sidecar.value, identity: sidecar.identity };
  }

  const configFile = readJsonConfigFileIfExists(configPath);
  const state = selectJsonSetupJournalState(
    sidecar.value,
    configFile?.text ?? null,
    configFile?.config ?? {},
  );
  const backup =
    state === "old" ? sidecar.value.oldBackup : sidecar.value.newBackup;
  let identity: TrustedFileIdentity | null = null;
  guard.assertOwned();
  withTrustedFileTransaction(
    [configPath, jsonBackupPath(configPath)],
    (transaction) => {
      transaction.assertSnapshotIdentity(
        configPath,
        configFile?.identity ?? null,
      );
      transaction.assertSnapshotIdentity(
        jsonBackupPath(configPath),
        sidecar.identity,
      );
      guard.assertOwned();
      if (backup) {
        identity = commitJsonSetupBackup(
          transaction,
          configPath,
          backup,
          configFile?.identity ?? null,
        );
      } else {
        transaction.remove(jsonBackupPath(configPath));
      }
      transaction.assertCurrentIdentity(configPath);
      transaction.assertCurrentIdentity(jsonBackupPath(configPath));
      guard.assertOwned();
    },
  );
  return backup && identity ? { backup, identity } : null;
}

/** Remove the sidecar backup file (no-op if it doesn't exist). */
function removeJsonSetupBackup(
  configPath: string,
  guard: SetupGuard,
  expectedIdentity?: TrustedFileIdentity,
): void {
  const backupPath = jsonBackupPath(configPath);
  guard.assertOwned();
  withTrustedFileTransaction([configPath, backupPath], (transaction) => {
    transaction.assertSnapshotIdentity(configPath, null);
    transaction.assertSnapshotIdentity(
      backupPath,
      expectedIdentity ?? transaction.snapshot(backupPath).identity,
    );
    guard.assertOwned();
    transaction.remove(backupPath);
    transaction.assertCurrentIdentity(configPath);
    transaction.assertCurrentIdentity(backupPath);
    guard.assertOwned();
  });
}

function commitJsonSetupBackup(
  transaction: TrustedFileTransaction,
  configPath: string,
  backup: JsonBackup,
  configIdentity: TrustedFileIdentity | null,
): TrustedFileIdentity {
  const bound =
    backup.version === 3 && configIdentity
      ? bindJsonBackupGeneration(backup, backupGeneration(configIdentity))
      : backup;
  parseStableJsonBackup(bound);
  return transaction.write(
    jsonBackupPath(configPath),
    `${JSON.stringify(bound, null, 2)}\n`,
    { mode: 0o600 },
  );
}

function commitJsonSetupJournal(
  transaction: TrustedFileTransaction,
  configPath: string,
  journal: JsonSetupJournal,
): TrustedFileIdentity {
  parseJsonSetupJournal(journal);
  return transaction.write(
    jsonBackupPath(configPath),
    `${JSON.stringify(journal, null, 2)}\n`,
    { mode: 0o600 },
  );
}

function replaceJsonConfigWithJournal(
  input: {
    configPath: string;
    configIdentity: TrustedFileIdentity | null;
    sidecarIdentity: TrustedFileIdentity | null;
    beforeText: string | null;
    beforeConfig: Record<string, unknown>;
    afterText: string | null;
    afterConfig: Record<string, unknown>;
    oldBackup: JsonBackup | null;
    newBackup: JsonBackup | null;
    projectionPaths?: readonly string[];
    afterFinalize?: () => void;
  },
  guard: SetupGuard,
): void {
  const backupPath = jsonBackupPath(input.configPath);
  if (input.beforeText === input.afterText) {
    guard.assertOwned();
    withTrustedFileTransaction(
      [input.configPath, backupPath],
      (transaction) => {
        transaction.assertSnapshotIdentity(
          input.configPath,
          input.configIdentity,
        );
        transaction.assertSnapshotIdentity(backupPath, input.sidecarIdentity);
        guard.assertOwned();
        if (input.newBackup) {
          commitJsonSetupBackup(
            transaction,
            input.configPath,
            input.newBackup,
            input.configIdentity,
          );
        } else {
          transaction.remove(backupPath);
        }
        transaction.assertCurrentIdentity(input.configPath);
        transaction.assertCurrentIdentity(backupPath);
        guard.assertOwned();
        input.afterFinalize?.();
      },
    );
    return;
  }
  const journal = prepareJsonSetupJournal({
    oldBackup: input.oldBackup,
    newBackup: input.newBackup,
    beforeText: input.beforeText,
    beforeConfig: input.beforeConfig,
    afterText: input.afterText,
    afterConfig: input.afterConfig,
    projectionPaths: input.projectionPaths,
  });
  guard.assertOwned();
  withTrustedFileTransaction([input.configPath, backupPath], (transaction) => {
    transaction.assertSnapshotIdentity(input.configPath, input.configIdentity);
    transaction.assertSnapshotIdentity(backupPath, input.sidecarIdentity);
    guard.assertOwned();
    commitJsonSetupJournal(transaction, input.configPath, journal);
    guard.assertOwned();
    const configIdentity =
      input.afterText === null
        ? (transaction.remove(input.configPath), null)
        : transaction.write(input.configPath, input.afterText);
    guard.assertOwned();
    if (input.newBackup) {
      commitJsonSetupBackup(
        transaction,
        input.configPath,
        input.newBackup,
        configIdentity,
      );
    } else {
      transaction.remove(backupPath);
    }
    try {
      transaction.assertCurrentIdentity(input.configPath);
    } catch (error) {
      transaction.assertCurrentIdentity(backupPath);
      commitJsonSetupJournal(transaction, input.configPath, journal);
      throw error;
    }
    transaction.assertCurrentIdentity(backupPath);
    guard.assertOwned();
    input.afterFinalize?.();
  });
}

// ---------------------------------------------------------------------------
// opencode setup
// ---------------------------------------------------------------------------

/** Path to the OpenCode user-level config file. */
export function opencodeConfigPath(): string {
  return join(homedir(), ".config", "opencode", "opencode.json");
}

export function activeOpencodeConfigPath(): string {
  return resolveOpencodeConfigPath(opencodeConfigPath());
}

/**
 * OpenCode provider IDs that get a pinned `baseURL` in the setup writer.
 *
 * The primary mechanism for routing opencode through the gateway is the
 * @loreai/opencode plugin's `config` hook, which iterates `cfg.provider`
 * at runtime — no hardcoded list needed, adapts to new opencode versions
 * and custom user providers. The list here is a fallback for the
 * `--no-plugin` case (user explicitly opts out of the plugin), where the
 * setup writer must inject baseURLs directly into the persisted config.
 *
 * Sourced from opencode's `BUNDLED_PROVIDERS` (provider.ts:108-135) plus
 * the `custom()` dispatch table (provider.ts:169-953). Opencode's
 * `resolveSDK()` always passes `options.baseURL` to the @ai-sdk factory,
 * so setting it here routes every chat call through the gateway.
 */
export const OPENCODE_SETUP_PROVIDER_IDS = [
  "amazon-bedrock",
  "anthropic",
  "azure",
  "google",
  "google-vertex",
  "google-vertex-anthropic",
  "openai",
  "openai-compatible",
  "openrouter",
  "xai",
  "mistral",
  "groq",
  "deepinfra",
  "cerebras",
  "cohere",
  "gateway",
  "togetherai",
  "perplexity",
  "vercel",
  "alibaba",
  "opencode",
  "azure-cognitive-services",
  "github-copilot",
  "sap-ai-core",
  "gitlab",
  "cloudflare-workers-ai",
  "cloudflare-ai-gateway",
  "snowflake-cortex",
  "llmgateway",
  "nvidia",
  "kilo",
  "zenmux",
  "venice",
] as const;

/**
 * Update (or create) the OpenCode user-level `opencode.json` to route every
 * bundled + custom provider through the Lore gateway, and disable
 * OpenCode's built-in auto-compaction.
 *
 * The provider baseURLs are the `--no-plugin` fallback — the primary
 * mechanism is the @loreai/opencode plugin's `config` hook (installed by
 * `installPlugin` when the user doesn't pass `--no-plugin`). The plugin
 * iterates `cfg.provider` at runtime, so it covers custom user providers
 * and future opencode versions without code changes here.
 *
 * Strategy:
 * - Sets `provider.<id>.options.baseURL` to the gateway URL (with `/v1`)
 *   for every provider opencode knows about. This is necessary because
 *   opencode's `resolveSDK()` always passes `options.baseURL` to the
 *   @ai-sdk factory, bypassing `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL`,
 *   and most other @ai-sdk providers have no baseURL env var at all.
 * - Sets `compaction.auto` to `false` so the Lore gradient context manager
 *   and distillation pipeline are the source of truth.
 * - Deep-merges with the existing config; preserves user-set custom
 *   providers, themes, keybinds, and other settings.
 * - Idempotent: running twice produces the same result.
 */
export function updateOpencodeConfig(
  config: Record<string, unknown>,
  baseUrl: string,
): Record<string, unknown> {
  // `baseUrl` includes the trailing `/v1` per the setup writer's contract
  // (matches `setup.ts:normalizeBaseUrl`).
  const providerConfig: Record<string, { options: { baseURL: string } }> = {};
  for (const id of OPENCODE_SETUP_PROVIDER_IDS) {
    providerConfig[id] = { options: { baseURL: baseUrl } };
  }
  return deepMerge(config, {
    provider: providerConfig,
    compaction: { auto: false },
  });
}

function setupOpencode(
  baseUrl: string,
  noPlugin: boolean,
  guard: SetupGuard,
  external: SetupExternalTransaction,
): boolean | void {
  guard.assertOwned();
  let packageState: KnownNpmPackageSnapshot | null = null;
  if (!noPlugin) {
    console.log(`[lore] Plugin: ${opencodePluginSpec.npmPackage}`);
    const state = inspectNpmPackage(opencodePluginSpec.npmPackage);
    if (state.state === "unknown") {
      console.error(
        `[lore] Could not determine whether ${opencodePluginSpec.npmPackage} is installed globally.`,
      );
      console.error(`[lore] No package or config changes were kept.`);
      process.exitCode = 1;
      return false;
    }
    packageState = state;
  }

  const configPath = activeOpencodeConfigPath();
  const configDir = join(homedir(), ".config", "opencode");

  guard.assertOwned();
  ensureTrustedDirectory(configDir);

  guard.assertOwned();
  const sidecarFile = recoverJsonSetupJournal(configPath, guard);
  const existingFile: {
    text: string;
    config: Record<string, unknown>;
    identity: TrustedFileIdentity | null;
  } = readJsonConfigFileIfExists(configPath) ?? {
    text: "{}\n",
    config: {},
    identity: null,
  };
  const beforeConfig = existingFile.config;
  // Migrate away from any legacy in-config `_loreBackup` key: capture it for the
  // sidecar, then strip it so every config we write is schema-valid for
  // OpenCode (its schema is `additionalProperties: false` and rejects unknown
  // keys — the illegal key made OpenCode refuse to start).
  const legacyBackup = requireLegacyJsonBackup(beforeConfig);
  const previousBackup = sidecarFile?.backup ?? legacyBackup;
  const existing = structuredClone(beforeConfig);
  delete existing[LORE_BACKUP_KEY];

  // Values lore is about to set (provider baseURLs + compaction), captured from
  // the ORIGINAL config for the backup's prior values.
  const loreValues: Record<string, unknown> = { "compaction.auto": false };
  for (const id of OPENCODE_SETUP_PROVIDER_IDS) {
    loreValues[`provider.${id}.options.baseURL`] = baseUrl;
  }
  const existingPlugins = existing.plugin;
  const pluginAlreadyPresent =
    Array.isArray(existingPlugins) &&
    existingPlugins.includes("@loreai/opencode");

  let updatedText = existingFile.text;
  if (
    existing.provider !== undefined &&
    (typeof existing.provider !== "object" ||
      existing.provider === null ||
      Array.isArray(existing.provider))
  ) {
    updatedText = setJsonConfigValue(updatedText, ["provider"], {});
  }
  if (
    existing.compaction !== undefined &&
    (typeof existing.compaction !== "object" ||
      existing.compaction === null ||
      Array.isArray(existing.compaction))
  ) {
    updatedText = setJsonConfigValue(updatedText, ["compaction"], {});
  }
  for (const id of OPENCODE_SETUP_PROVIDER_IDS) {
    const provider =
      typeof existing.provider === "object" &&
      existing.provider !== null &&
      !Array.isArray(existing.provider)
        ? (existing.provider as Record<string, unknown>)[id]
        : undefined;
    if (
      provider !== undefined &&
      (typeof provider !== "object" ||
        provider === null ||
        Array.isArray(provider))
    ) {
      updatedText = setJsonConfigValue(updatedText, ["provider", id], {});
    }
    const options =
      typeof provider === "object" &&
      provider !== null &&
      !Array.isArray(provider)
        ? (provider as Record<string, unknown>).options
        : undefined;
    if (
      options !== undefined &&
      (typeof options !== "object" ||
        options === null ||
        Array.isArray(options))
    ) {
      updatedText = setJsonConfigValue(
        updatedText,
        ["provider", id, "options"],
        {},
      );
    }
    updatedText = setJsonConfigValue(
      updatedText,
      ["provider", id, "options", "baseURL"],
      baseUrl,
    );
  }
  updatedText = setJsonConfigValue(updatedText, ["compaction", "auto"], false);
  let pluginRegistered = false;
  if (noPlugin) {
    console.log(
      `[lore] Skipped @loreai/opencode plugin install (--no-plugin).`,
    );
    console.log(
      `[lore] To install later: npm install -g @loreai/opencode, then add`,
    );
    console.log(
      `[lore] "@loreai/opencode" to the "plugin" array in ${configPath}.`,
    );
  } else {
    pluginRegistered = opencodePluginSpec.apply(existing);
    if (pluginRegistered) {
      loreValues.plugin = existing.plugin;
      updatedText = setJsonConfigValue(
        updatedText,
        ["plugin"],
        existing.plugin,
      );
      console.log(`[lore]   registered in: ${configPath}`);
    } else {
      console.log(
        `[lore] Plugin "${opencodePluginSpec.npmPackage}" already registered.`,
      );
    }
  }
  updatedText = deleteJsonConfigValue(updatedText, [LORE_BACKUP_KEY]);
  const finalConfig = parseJsonConfigText(updatedText, configPath);
  const backup = refreshJsonBackup(
    structuredClone(beforeConfig),
    loreValues,
    previousBackup,
    {
      pluginAdded: pluginRegistered && !pluginAlreadyPresent,
      originalExists: existingFile.identity !== null,
      afterConfig: finalConfig,
    },
  );
  try {
    replaceJsonConfigWithJournal(
      {
        configPath,
        configIdentity: existingFile.identity,
        sidecarIdentity: sidecarFile?.identity ?? null,
        beforeText: existingFile.identity ? existingFile.text : null,
        beforeConfig,
        afterText: updatedText,
        afterConfig: finalConfig,
        oldBackup: sidecarFile?.backup ?? null,
        newBackup: backup,
        projectionPaths: ["plugin", LORE_BACKUP_KEY],
        afterFinalize: () => {
          if (packageState) {
            guard.assertOwned();
            const installed = external.apply(
              new NpmPluginInstallEffect(
                opencodePluginSpec.npmPackage,
                packageState,
              ),
            );
            guard.assertOwned();
            if (!installed) {
              process.exitCode = 1;
              throw new PluginInstallFailure();
            }
          }
        },
      },
      guard,
    );
  } catch (error) {
    if (error instanceof PluginInstallFailure) return false;
    throw error;
  }

  external.onCommit(() => {
    console.log(`[lore] OpenCode configured to use Lore gateway.`);
    console.log(
      `[lore]   provider.<id>.options.baseURL = "${baseUrl}" (all ${OPENCODE_SETUP_PROVIDER_IDS.length} providers, --no-plugin fallback)`,
    );
    console.log(`[lore]   compaction.auto = false (auto-compaction disabled)`);
    console.log(`[lore]   Config: ${configPath}`);
    console.log(`[lore]`);
  });
}

// ---------------------------------------------------------------------------
// claude-code setup
// ---------------------------------------------------------------------------

/** Path to the Claude Code user-level settings file. */
export function claudeCodeSettingsPath(): string {
  return join(homedir(), ".claude", "settings.json");
}

/**
 * Update (or create) the Claude Code user-level `settings.json` to route
 * through the Lore gateway.
 *
 * Strategy:
 * - Sets `env.ANTHROPIC_BASE_URL` to the gateway URL (NOT including `/v1` —
 *   Claude Code appends `/v1/messages` itself per the Anthropic SDK
 *   convention).
 * - Sets `env.DISABLE_AUTO_COMPACT` to `"1"` so the Lore gradient
 *   context manager and distillation pipeline are the source of truth.
 * - Sets `env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL` to `"1"` so Claude Code
 *   >= 2.1.181 keeps emitting the `cch` billing field even though
 *   ANTHROPIC_BASE_URL points at the local gateway rather than
 *   `api.anthropic.com` (the gateway is a transparent proxy to the first-party
 *   API; without this the client suppresses `cch` and the gateway cannot
 *   re-sign the billing header). Mirrors the `lore run` path in
 *   `agents.ts`. See quality/CCH.md.
 * - Deep-merges with the existing settings; preserves permissions,
 *   hooks, model overrides, and other env vars.
 * - Idempotent: running twice produces the same result.
 */
export function updateClaudeCodeSettings(
  config: Record<string, unknown>,
  gatewayUrl: string,
): Record<string, unknown> {
  return deepMerge(config, {
    env: {
      ANTHROPIC_BASE_URL: gatewayUrl,
      DISABLE_AUTO_COMPACT: "1",
      [CLAUDE_CODE_FIRST_PARTY_ENV]: "1",
    },
  });
}

function setupClaudeCode(baseUrl: string, guard: SetupGuard): void {
  guard.assertOwned();
  const configPath = claudeCodeSettingsPath();
  const configDir = join(homedir(), ".claude");

  guard.assertOwned();
  ensureTrustedDirectory(configDir);

  // Strip the /v1 suffix — Claude Code appends /v1/messages itself.
  const anthropicBaseUrl = baseUrl.endsWith("/v1")
    ? baseUrl.slice(0, -3)
    : baseUrl;

  guard.assertOwned();
  const sidecarFile = recoverJsonSetupJournal(configPath, guard);
  const existingFile = readJsonConfigFileIfExists(configPath);
  const beforeConfig = existingFile?.config ?? {};
  const legacyBackup = requireLegacyJsonBackup(beforeConfig);
  const previousBackup = sidecarFile?.backup ?? legacyBackup;
  const existing = structuredClone(beforeConfig);
  delete existing[LORE_BACKUP_KEY];
  const updated = updateClaudeCodeSettings(existing, anthropicBaseUrl);
  const backup = refreshJsonBackup(
    existing,
    {
      "env.ANTHROPIC_BASE_URL": anthropicBaseUrl,
      "env.DISABLE_AUTO_COMPACT": "1",
      [`env.${CLAUDE_CODE_FIRST_PARTY_ENV}`]: "1",
    },
    previousBackup,
    {
      originalExists: existingFile !== null,
      afterConfig: updated,
    },
  );
  const updatedText = `${JSON.stringify(updated, null, 2)}\n`;
  replaceJsonConfigWithJournal(
    {
      configPath,
      configIdentity: existingFile?.identity ?? null,
      sidecarIdentity: sidecarFile?.identity ?? null,
      beforeText: existingFile?.text ?? null,
      beforeConfig,
      afterText: updatedText,
      afterConfig: updated,
      oldBackup: sidecarFile?.backup ?? null,
      newBackup: backup,
      projectionPaths: [LORE_BACKUP_KEY],
    },
    guard,
  );

  console.log(`[lore] Claude Code configured to use Lore gateway.`);
  console.log(`[lore]   env.ANTHROPIC_BASE_URL = "${anthropicBaseUrl}"`);
  console.log(
    `[lore]   env.DISABLE_AUTO_COMPACT = "1" (auto-compaction disabled)`,
  );
  console.log(
    `[lore]   env.${CLAUDE_CODE_FIRST_PARTY_ENV} = "1" (keeps cch billing flowing through the gateway)`,
  );
  console.log(`[lore]   Config: ${configPath}`);
}

// ---------------------------------------------------------------------------
// pi setup
// ---------------------------------------------------------------------------

/**
 * Path to Pi's custom-models config file.
 *
 * Pi resolves its agent dir from `PI_CODING_AGENT_DIR` (if set) or
 * `~/.pi/agent`, then reads `models.json` from it (see Pi's `getAgentDir()` /
 * `model-registry` loader). We honor the override so a user with a relocated
 * agent dir gets the file Pi actually reads.
 */
export function piModelsConfigPath(): string {
  const customDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = customDir || join(homedir(), ".pi", "agent");
  if (customDir) {
    assertNoSymlinkPathComponents(agentDir, "PI_CODING_AGENT_DIR");
  }
  return join(agentDir, "models.json");
}

/**
 * Pi providers that speak the Anthropic Messages wire format → routed to the
 * gateway ROOT (no `/v1`; the gateway exposes `/v1/messages` itself).
 * OpenAI-family providers get `${root}/v1`.
 *
 * These two lists mirror `ANTHROPIC_PROVIDERS` / `OPENAI_PROVIDERS` in
 * `packages/pi/src/internal.ts` — the exact set the `@loreai/pi` extension
 * registers at runtime. Kept in sync manually because the gateway must not
 * depend on `@loreai/pi`. Writing a bare `baseUrl` override is valid for any
 * provider id (Pi's `validateModelsConfig` allows override-only entries); it
 * only *routes* Pi's built-in providers, and is a harmless no-op for the rest
 * until the user defines models for them — same trade-off as opencode's
 * write-all fallback list.
 */
export const PI_ANTHROPIC_PROVIDERS = [
  "anthropic",
  "fireworks",
  "minimax",
  "minimax-cn",
  "kimi-coding",
] as const;

export const PI_OPENAI_PROVIDERS = [
  "github-copilot",
  "deepseek",
  "xai",
  "groq",
  "cerebras",
  "openrouter",
  "huggingface",
  "zai",
  "opencode",
  "opencode-go",
  "vercel-ai-gateway",
  "openai",
  "openai-codex",
  "vllm",
  "llamacpp",
  "ollama",
  "lmstudio",
  "jan",
  "localai",
  "tgi",
  "tabbyml",
  "litellm",
] as const;

/**
 * Deep-merge gateway `baseUrl` overrides for every Lore-routable Pi provider
 * into `models.json`, using the protocol split (Anthropic-family → `root`,
 * OpenAI-family → `${root}/v1`).
 *
 * `root` is the gateway origin WITHOUT the trailing `/v1` (the setup writer's
 * `baseUrl` always carries `/v1`, so callers strip it before passing here).
 *
 * Preserves any existing custom providers, models, and overrides; idempotent
 * (re-running produces the same object).
 */
export function updatePiModelsConfig(
  config: Record<string, unknown>,
  root: string,
): Record<string, unknown> {
  const providers: Record<string, { baseUrl: string }> = {};
  for (const id of PI_ANTHROPIC_PROVIDERS) providers[id] = { baseUrl: root };
  for (const id of PI_OPENAI_PROVIDERS) {
    providers[id] = { baseUrl: `${root}/v1` };
  }
  return deepMerge(config, { providers });
}

function setupPi(baseUrl: string, guard: SetupGuard): void {
  guard.assertOwned();
  const configPath = piModelsConfigPath();
  guard.assertOwned();
  ensureTrustedDirectory(dirname(configPath));
  if (process.env.PI_CODING_AGENT_DIR) {
    assertNoSymlinkPathComponents(dirname(configPath), "PI_CODING_AGENT_DIR");
  }

  // Anthropic-family Pi providers hit the gateway root; OpenAI-family get
  // `/v1`. `baseUrl` arrives with `/v1` (setup writer contract) so strip it
  // back to the origin first.
  const root = baseUrl.replace(/\/v1$/, "");

  guard.assertOwned();
  const sidecarFile = recoverJsonSetupJournal(configPath, guard);
  const existingFile = readJsonConfigFileIfExists(configPath);
  const beforeConfig = existingFile?.config ?? {};
  const legacyBackup = requireLegacyJsonBackup(beforeConfig);
  const previousBackup = sidecarFile?.backup ?? legacyBackup;
  const existing = structuredClone(beforeConfig);
  delete existing[LORE_BACKUP_KEY];

  // Record the exact values lore is about to set so undo reverts only if the
  // file still holds them (a value the user changed post-setup is left alone).
  const loreValues: Record<string, unknown> = {};
  for (const id of PI_ANTHROPIC_PROVIDERS) {
    loreValues[`providers.${id}.baseUrl`] = root;
  }
  for (const id of PI_OPENAI_PROVIDERS) {
    loreValues[`providers.${id}.baseUrl`] = `${root}/v1`;
  }

  const updated = updatePiModelsConfig(existing, root);
  const updatedText = `${JSON.stringify(updated, null, 2)}\n`;
  const backup = refreshJsonBackup(existing, loreValues, previousBackup, {
    originalExists: existingFile !== null,
    afterConfig: updated,
  });
  replaceJsonConfigWithJournal(
    {
      configPath,
      configIdentity: existingFile?.identity ?? null,
      sidecarIdentity: sidecarFile?.identity ?? null,
      beforeText: existingFile?.text ?? null,
      beforeConfig,
      afterText: updatedText,
      afterConfig: updated,
      oldBackup: sidecarFile?.backup ?? null,
      newBackup: backup,
      projectionPaths: [LORE_BACKUP_KEY],
    },
    guard,
  );

  const total = PI_ANTHROPIC_PROVIDERS.length + PI_OPENAI_PROVIDERS.length;
  console.log(`[lore] Pi configured to use Lore gateway.`);
  console.log(
    `[lore]   providers.<id>.baseUrl set for all ${total} gateway-routable providers`,
  );
  console.log(
    `[lore]     Anthropic-family → "${root}"; OpenAI-family → "${root}/v1"`,
  );
  console.log(`[lore]   Config: ${configPath}`);
  console.log(`[lore]`);
  console.log(
    `[lore] For dynamic per-provider routing + memory features, install the`,
  );
  console.log(
    `[lore] @loreai/pi extension: add "npm:@loreai/pi@latest" to the "packages"`,
  );
  console.log(`[lore] array in ~/.pi/settings.json, then run: pi install`);
}

// ---------------------------------------------------------------------------
// Hermes setup
// ---------------------------------------------------------------------------

/**
 * Path to Hermes's dotenv file.
 *
 * Hermes loads `${HERMES_HOME}/.env` (default `~/.hermes`) via python-dotenv at
 * startup (`load_hermes_dotenv`), so this is where a persistent gateway
 * redirect belongs. We honor `HERMES_HOME` for relocated installs.
 */
export function hermesEnvPath(): string {
  const customHome = process.env.HERMES_HOME;
  const home = customHome || join(homedir(), ".hermes");
  if (customHome) {
    assertNoSymlinkPathComponents(home, "HERMES_HOME");
  }
  return join(home, ".env");
}

/**
 * Rewrite Hermes's `.env` to route through the gateway. Sets `OPENAI_BASE_URL`
 * (the gateway URL, WITH `/v1` — Hermes speaks the OpenAI-compatible wire
 * format) and `HERMES_INFERENCE_PROVIDER=custom` so Hermes picks up the custom
 * endpoint. Mirrors exactly what `lore run hermes` injects (see `agents.ts`),
 * but persisted so a standalone `hermes` routes correctly without `lore run`.
 *
 * Prepends a `#`-commented backup block recording prior values (for
 * `lore setup undo hermes`), and upserts the two keys in place — preserving
 * every other line (comments, credentials, unrelated vars). Idempotent.
 */
export function updateHermesEnv(content: string, baseUrl: string): string {
  const loreValues: Record<string, string> = {
    // `baseUrl` already carries `/v1` (normalizeBaseUrl contract), which is
    // exactly what Hermes wants for OPENAI_BASE_URL.
    OPENAI_BASE_URL: baseUrl,
    HERMES_INFERENCE_PROVIDER: "custom",
  };
  const prepared = refreshEnvBackupBlock(content, loreValues);
  let result = prepared.content;
  for (const [key, value] of Object.entries(loreValues)) {
    result = setEnvValueRaw(result, key, value);
  }
  return prependEnvBackupBlock(result, prepared.block);
}

function setupHermes(baseUrl: string, guard: SetupGuard): void {
  guard.assertOwned();
  const configPath = hermesEnvPath();
  guard.assertOwned();
  ensureTrustedDirectory(dirname(configPath));
  if (process.env.HERMES_HOME) {
    assertNoSymlinkPathComponents(dirname(configPath), "HERMES_HOME");
  }

  const existingFile = readTrustedTextFile(configPath, { allowMissing: true });
  const content = existingFile?.text ?? "";

  const updated = updateHermesEnv(content, baseUrl);
  guard.assertOwned();
  atomicWriteTrustedFile(configPath, updated, {
    expectedIdentity: existingFile?.identity ?? null,
  });

  console.log(`[lore] Hermes Agent configured to use Lore gateway.`);
  console.log(`[lore]   OPENAI_BASE_URL=${baseUrl}`);
  console.log(
    `[lore]   HERMES_INFERENCE_PROVIDER=custom (routes to the gateway endpoint)`,
  );
  console.log(`[lore]   Config: ${configPath}`);
  console.log(`[lore]`);
  console.log(
    `[lore] Note: a named model.provider in ~/.hermes/config.yaml overrides`,
  );
  console.log(
    `[lore] these env vars — set provider: custom there too if you use one.`,
  );
}

// ---------------------------------------------------------------------------
// GitHub Copilot CLI setup
// ---------------------------------------------------------------------------

/**
 * Derive the value COPILOT_API_URL should hold from the setup base URL. Copilot
 * CLI posts to the ORIGIN's bare `/chat/completions` (its API omits the /v1
 * segment), so strip a trailing `/v1`. Pure.
 */
export function copilotApiUrlFromBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/v1") ? baseUrl.slice(0, -3) : baseUrl;
}

/**
 * "Configure" GitHub Copilot CLI to route through Lore.
 *
 * Unlike every other supported agent, Copilot CLI exposes NO config-file field
 * for its API endpoint — interception is only possible via the `COPILOT_API_URL`
 * environment variable (verified against the @github/copilot binary: it returns
 * that var verbatim as the Copilot API URL when set). There is therefore nothing
 * to persist to a config file; instead we print the exact export the user needs
 * and recommend `lore run copilot` for the zero-config path. `lore setup status`
 * / `doctor` read COPILOT_API_URL to show the current routing.
 */
function setupCopilot(baseUrl: string, guard: SetupGuard): void {
  guard.assertOwned();
  const apiUrl = copilotApiUrlFromBaseUrl(baseUrl);
  console.log(`[lore] GitHub Copilot CLI routes through Lore via an env var.`);
  console.log(
    `[lore] It has no config-file endpoint override, so either launch it with:`,
  );
  console.log(`[lore]`);
  console.log(`[lore]     lore run copilot`);
  console.log(`[lore]`);
  console.log(
    `[lore] (which sets COPILOT_API_URL for that session automatically), or add`,
  );
  console.log(
    `[lore] this to your shell profile (~/.bashrc, ~/.zshrc, …) for standalone use:`,
  );
  console.log(`[lore]`);
  console.log(`[lore]     export COPILOT_API_URL=${apiUrl}`);
  console.log(`[lore]`);
  console.log(
    `[lore] This intercepts Copilot's default GitHub-hosted models. If you use a`,
  );
  console.log(
    `[lore] BYOK provider instead, point COPILOT_PROVIDER_BASE_URL=${apiUrl}/v1`,
  );
  console.log(`[lore] at the gateway.`);
}

// ---------------------------------------------------------------------------
// Gemini CLI setup
// ---------------------------------------------------------------------------

/** Path to Gemini CLI's dotenv file (`~/.gemini/.env`). */
export function geminiEnvPath(): string {
  return join(homedir(), ".gemini", ".env");
}

/**
 * Rewrite Gemini CLI's `~/.gemini/.env` to route through the gateway. Sets
 * `GOOGLE_GEMINI_BASE_URL` to the bare gateway origin (Gemini appends
 * `/v1beta/models/...` itself, so strip a trailing `/v1`). Prepends a
 * `#`-commented backup block and upserts the key in place (preserving every
 * other line, e.g. `GEMINI_API_KEY`). Idempotent.
 */
export function updateGeminiEnv(content: string, baseUrl: string): string {
  const root = copilotApiUrlFromBaseUrl(baseUrl); // strips a trailing /v1
  const loreValues: Record<string, string> = {
    GOOGLE_GEMINI_BASE_URL: root,
  };
  const prepared = refreshEnvBackupBlock(content, loreValues);
  let result = prepared.content;
  for (const [key, value] of Object.entries(loreValues)) {
    result = setEnvValueRaw(result, key, value);
  }
  return prependEnvBackupBlock(result, prepared.block);
}

function setupGemini(baseUrl: string, guard: SetupGuard): void {
  guard.assertOwned();
  const configPath = geminiEnvPath();
  guard.assertOwned();
  ensureTrustedDirectory(dirname(configPath));

  const existingFile = readTrustedTextFile(configPath, { allowMissing: true });
  const content = existingFile?.text ?? "";

  const updated = updateGeminiEnv(content, baseUrl);
  guard.assertOwned();
  atomicWriteTrustedFile(configPath, updated, {
    expectedIdentity: existingFile?.identity ?? null,
  });

  const root = copilotApiUrlFromBaseUrl(baseUrl);
  console.log(`[lore] Gemini CLI configured to use Lore gateway.`);
  console.log(`[lore]   GOOGLE_GEMINI_BASE_URL=${root}`);
  console.log(`[lore]   Config: ${configPath}`);
  console.log(`[lore]`);
  console.log(
    `[lore] Uses GEMINI_API_KEY auth. If Gemini CLI doesn't load ~/.gemini/.env,`,
  );
  console.log(
    `[lore] export GOOGLE_GEMINI_BASE_URL in your shell, or use: lore run gemini`,
  );
}

// ---------------------------------------------------------------------------
// Undo (`lore setup undo [app]`)
// ---------------------------------------------------------------------------

/**
 * Restore a JSON-config app (Claude Code, OpenCode, Pi) from its sidecar
 * backup — falling back to a legacy in-config `_loreBackup` key, which is
 * always stripped so a schema-invalid config never lingers. The sidecar is
 * consumed only when everything was reverted; if the user changed a value
 * after setup it is kept so their prior value stays recoverable.
 */
function undoJsonApp(configPath: string, guard: SetupGuard): RestoreSummary {
  const sidecarFile = recoverJsonSetupJournal(configPath, guard);
  const configFile = readJsonConfigFileIfExists(configPath);
  if (!configFile && !sidecarFile) {
    return { hadBackup: false, restored: [], skipped: [] };
  }
  if (!configFile && sidecarFile) {
    removeJsonSetupBackup(configPath, guard, sidecarFile.identity);
    return {
      hadBackup: true,
      restored: ["orphaned setup backup"],
      skipped: [],
    };
  }
  const beforeConfig = configFile?.config ?? {};
  const cfg = structuredClone(beforeConfig);
  const backup = sidecarFile?.backup ?? requireLegacyJsonBackup(cfg);
  const hadLegacyKey = LORE_BACKUP_KEY in cfg;

  if (!backup) {
    // Nothing to restore. Still strip a stray/legacy key so a schema-invalid
    // config can't linger (e.g. a corrupt sidecar with an in-config key).
    if (hadLegacyKey) {
      delete cfg[LORE_BACKUP_KEY];
      replaceJsonConfigWithJournal(
        {
          configPath,
          configIdentity: configFile?.identity ?? null,
          sidecarIdentity: sidecarFile?.identity ?? null,
          beforeText: configFile?.text ?? null,
          beforeConfig,
          afterText: `${JSON.stringify(cfg, null, 2)}\n`,
          afterConfig: cfg,
          oldBackup: sidecarFile?.backup ?? null,
          newBackup: sidecarFile?.backup ?? null,
          projectionPaths: [LORE_BACKUP_KEY],
        },
        guard,
      );
    }
    return { hadBackup: false, restored: [], skipped: [] };
  }

  const summary = applyJsonBackup(cfg, backup);
  // Always drop any legacy in-config backup key (migration cleanup).
  delete cfg[LORE_BACKUP_KEY];
  const restoredText = `${JSON.stringify(cfg, null, 2)}\n`;
  const remaining = retainSkippedJsonBackup(backup, summary.skipped, cfg);
  const restoreAbsence =
    backup.version === 3 &&
    !backup.originalExists &&
    summary.skipped.length === 0 &&
    Object.keys(cfg).length === 0;
  replaceJsonConfigWithJournal(
    {
      configPath,
      configIdentity: configFile?.identity ?? null,
      sidecarIdentity: sidecarFile?.identity ?? null,
      beforeText: configFile?.text ?? null,
      beforeConfig,
      afterText: restoreAbsence ? null : restoredText,
      afterConfig: cfg,
      oldBackup: sidecarFile?.backup ?? null,
      newBackup: remaining,
      projectionPaths: [
        ...backup.entries.map((entry) => entry.path),
        "plugin",
        LORE_BACKUP_KEY,
      ],
    },
    guard,
  );
  return summary;
}

/** Strictly read every JSON undo input without writing it. */
function prevalidateJsonUndo(configPath: string): void {
  const configFile = readJsonConfigFileIfExists(configPath);
  const sidecarFile = requireJsonSetupBackup(configPath);
  if (!sidecarFile?.backup && configFile) {
    requireLegacyJsonBackup(configFile.config);
  }
}

function undoClaudeCode(guard: SetupGuard): RestoreSummary {
  return undoJsonApp(claudeCodeSettingsPath(), guard);
}

function undoOpencode(
  guard: SetupGuard,
  candidates: readonly string[] = opencodeUndoCandidates(),
): RestoreSummary {
  let combined: RestoreSummary = {
    hadBackup: false,
    restored: [],
    skipped: [],
  };
  for (const configPath of candidates) {
    const summary = undoOpencodeConfig(configPath, guard);
    combined = {
      hadBackup: combined.hadBackup || summary.hadBackup,
      restored: [...combined.restored, ...summary.restored],
      skipped: [...combined.skipped, ...summary.skipped],
    };
  }
  return combined;
}

function opencodeUndoCandidates(): string[] {
  return opencodeConfigPaths(opencodeConfigPath()).filter(
    (path) =>
      trustedFileExists(path) || trustedFileExists(jsonBackupPath(path)),
  );
}

function prevalidateOpencodeUndo(
  candidates: readonly string[] = opencodeUndoCandidates(),
): void {
  for (const configPath of candidates) {
    prevalidateJsonUndo(configPath);
  }
}

function undoOpencodeConfig(
  configPath: string,
  guard: SetupGuard,
): RestoreSummary {
  if (!trustedFileExists(configPath)) {
    const sidecarFile = recoverJsonSetupJournal(configPath, guard);
    if (!sidecarFile) {
      return { hadBackup: false, restored: [], skipped: [] };
    }
    removeJsonSetupBackup(configPath, guard, sidecarFile.identity);
    return {
      hadBackup: true,
      restored: ["orphaned setup backup"],
      skipped: [],
    };
  }
  if (!configPath.endsWith(".jsonc")) {
    return undoJsonApp(configPath, guard);
  }

  const sidecarFile = recoverJsonSetupJournal(configPath, guard);
  const {
    text,
    config: beforeConfig,
    identity,
  } = readJsonConfigFile(configPath);
  const config = structuredClone(beforeConfig);
  const backup = sidecarFile?.backup ?? requireLegacyJsonBackup(config);
  if (!backup) return { hadBackup: false, restored: [], skipped: [] };
  const summary = applyJsonBackup(config, backup);
  let restoredText = text;
  for (const entry of backup.entries) {
    if (!summary.restored.includes(entry.path)) continue;
    const path = entry.path.split(".");
    restoredText = entry.hadPrior
      ? setJsonConfigValue(restoredText, path, entry.priorValue)
      : deleteJsonConfigValue(restoredText, path);
  }
  if (backup.version === 3) {
    for (const ancestor of [...backup.createdAncestors].sort(
      (left, right) => right.split(".").length - left.split(".").length,
    )) {
      if (getPath(config, ancestor) === undefined) {
        restoredText = deleteJsonConfigValue(restoredText, ancestor.split("."));
      }
    }
  }
  if (summary.restored.includes("plugin[@loreai/opencode]")) {
    restoredText = config.plugin
      ? setJsonConfigValue(restoredText, ["plugin"], config.plugin)
      : deleteJsonConfigValue(restoredText, ["plugin"]);
  }
  restoredText = deleteJsonConfigValue(restoredText, [LORE_BACKUP_KEY]);
  delete config[LORE_BACKUP_KEY];
  const remaining = retainSkippedJsonBackup(backup, summary.skipped, config);
  const restoreAbsence =
    backup.version === 3 &&
    !backup.originalExists &&
    summary.skipped.length === 0 &&
    Object.keys(config).length === 0;
  replaceJsonConfigWithJournal(
    {
      configPath,
      configIdentity: identity,
      sidecarIdentity: sidecarFile?.identity ?? null,
      beforeText: text,
      beforeConfig,
      afterText: restoreAbsence ? null : restoredText,
      afterConfig: config,
      oldBackup: sidecarFile?.backup ?? null,
      newBackup: remaining,
      projectionPaths: [
        ...backup.entries.map((entry) => entry.path),
        "plugin",
        LORE_BACKUP_KEY,
      ],
    },
    guard,
  );
  return summary;
}

function undoPi(guard: SetupGuard): RestoreSummary {
  return undoJsonApp(piModelsConfigPath(), guard);
}

function undoHermes(guard: SetupGuard): RestoreSummary {
  const configPath = hermesEnvPath();
  const file = readTrustedTextFile(configPath, { allowMissing: true });
  if (!file) return { hadBackup: false, restored: [], skipped: [] };
  const { content: restored, summary } = restoreEnvBackup(file.text);
  if (summary.hadBackup) {
    guard.assertOwned();
    atomicWriteTrustedFile(configPath, restored, {
      expectedIdentity: file.identity,
    });
  }
  return summary;
}

function prevalidateHermesUndo(): void {
  const file = readTrustedTextFile(hermesEnvPath(), { allowMissing: true });
  if (file) restoreEnvBackup(file.text);
}

function undoCopilot(guard: SetupGuard): RestoreSummary {
  guard.assertOwned();
  // `lore setup copilot` never persists anything (Copilot CLI has no config-file
  // endpoint field), so there is nothing to restore. Tell the user how to stop
  // routing and return an empty summary.
  const variables = [
    process.env.COPILOT_API_URL ? "COPILOT_API_URL" : null,
    process.env.COPILOT_PROVIDER_BASE_URL ? "COPILOT_PROVIDER_BASE_URL" : null,
  ].filter((name): name is string => name !== null);
  if (variables.length > 0) {
    console.log(`[lore] GitHub Copilot CLI setup is env-var based; lore`);
    console.log(
      `[lore] wrote no config. Unset ${variables.join(" and ")} where`,
    );
    console.log(
      `[lore] your shell or service defines it to stop Lore routing.`,
    );
  } else {
    console.log(
      `[lore] GitHub Copilot CLI: no Lore routing environment variable is set.`,
    );
  }
  return { hadBackup: false, restored: [], skipped: [] };
}

function undoGemini(guard: SetupGuard): RestoreSummary {
  const configPath = geminiEnvPath();
  const file = readTrustedTextFile(configPath, { allowMissing: true });
  if (!file) return { hadBackup: false, restored: [], skipped: [] };
  const { content: restored, summary } = restoreEnvBackup(file.text);
  if (summary.hadBackup) {
    guard.assertOwned();
    atomicWriteTrustedFile(configPath, restored, {
      expectedIdentity: file.identity,
    });
  }
  return summary;
}

function prevalidateGeminiUndo(): void {
  const file = readTrustedTextFile(geminiEnvPath(), { allowMissing: true });
  if (file) restoreEnvBackup(file.text);
}

function undoCodex(guard: SetupGuard): RestoreSummary {
  const configPath = codexConfigPath();
  const file = readTrustedTextFile(configPath, { allowMissing: true });
  if (!file) return { hadBackup: false, restored: [], skipped: [] };
  const { content: restored, summary } = restoreTomlBackup(file.text);
  if (summary.hadBackup) {
    guard.assertOwned();
    atomicWriteTrustedFile(configPath, restored, {
      expectedIdentity: file.identity,
    });
  }
  return summary;
}

function prevalidateCodexUndo(): void {
  const file = readTrustedTextFile(codexConfigPath(), { allowMissing: true });
  if (file) restoreTomlBackup(file.text);
}

/** Print the result of one app's undo. */
function reportUndo(app: AppSetup, summary: RestoreSummary, explicit: boolean) {
  if (!summary.hadBackup) {
    if (explicit) {
      console.log(
        `[lore] ${app.displayName}: no lore backup found — nothing to undo.`,
      );
    }
    return;
  }
  console.log(
    `[lore] ${app.displayName}: restored ${summary.restored.length} setting(s) from backup.`,
  );
  if (summary.skipped.length > 0) {
    console.log(
      `[lore]   Left ${summary.skipped.length} value(s) you changed after setup untouched: ${summary.skipped.join(", ")}`,
    );
  }
}

async function commandUndo(args: string[], guard: SetupGuard): Promise<void> {
  const appName = args[0]?.toLowerCase();
  let targets: AppSetup[];
  if (appName) {
    const app = SUPPORTED_APPS.find(
      (a) => a.agentName === appName || a.displayName.toLowerCase() === appName,
    );
    if (!app) {
      const supported = SUPPORTED_APPS.map((a) => a.agentName).join(", ");
      console.error(
        `[lore] Unknown app "${args[0]}". Supported apps: ${supported}`,
      );
      process.exitCode = 1;
      return;
    }
    targets = [app];
  } else {
    targets = SUPPORTED_APPS.filter(
      (app) =>
        app.agentName !== "copilot" ||
        Boolean(
          process.env.COPILOT_API_URL || process.env.COPILOT_PROVIDER_BASE_URL,
        ),
    );
  }

  // Validate the complete undo set before changing the first file.
  for (const app of targets) {
    guard.assertOwned();
    app.prevalidateUndo();
  }

  let restoredAny = false;
  for (const app of targets) {
    guard.assertOwned();
    const summary = app.undo(guard);
    if (summary.hadBackup) restoredAny = true;
    reportUndo(app, summary, Boolean(appName));
  }

  if (!restoredAny && !appName) {
    console.log(`[lore] No lore setup backups found — nothing to undo.`);
  }
}

/** Validate every setup backup an integration may consume without mutation. */
export function prevalidateSetupUndo(): void {
  for (const app of SUPPORTED_APPS) app.prevalidateUndo();
}

export interface SetupUndoTransaction {
  prepareCommit: () => void;
  commit: () => void;
  rollback: () => void;
}

/**
 * Undo every persistent setup integration while retaining the exact original
 * file generations until the caller crosses its irreversible commit boundary.
 */
export function stageSetupUndo(guard: LifecycleLock): SetupUndoTransaction {
  const targets = SUPPORTED_APPS.filter(
    (app) =>
      app.agentName !== "copilot" ||
      Boolean(
        process.env.COPILOT_API_URL || process.env.COPILOT_PROVIDER_BASE_URL,
      ),
  ).map((app) => ({ app, paths: app.undoPaths() }));

  for (const { app, paths } of targets) {
    guard.assertOwned();
    app.prevalidateUndo(paths);
  }

  const transactions: Array<StagedTrustedFileMutation<RestoreSummary>> = [];
  let restoredAny = false;
  try {
    for (const { app, paths } of targets) {
      guard.assertOwned();
      const transaction =
        paths.length > 0
          ? stageTrustedFileMutation(paths, () => app.undo(guard, paths))
          : null;
      const summary = transaction?.result ?? app.undo(guard);
      if (transaction) transactions.push(transaction);
      if (summary.hadBackup) restoredAny = true;
      reportUndo(app, summary, false);
    }
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const transaction of transactions.reverse()) {
      try {
        transaction.rollback();
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        "Setup undo staging failed and could not be fully rolled back.",
      );
    }
    throw error;
  }

  if (!restoredAny) {
    console.log(`[lore] No lore setup backups found — nothing to undo.`);
  }

  return {
    prepareCommit: () => {
      guard.assertOwned();
      for (const transaction of transactions) transaction.prepareCommit();
      guard.assertOwned();
    },
    commit: () => {
      for (const transaction of transactions) transaction.commit();
    },
    rollback: () => {
      const rollbackErrors: unknown[] = [];
      for (const transaction of [...transactions].reverse()) {
        try {
          transaction.rollback();
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          rollbackErrors,
          "Setup undo could not be fully rolled back.",
        );
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Command entry point
// ---------------------------------------------------------------------------

function rollbackSetupTransaction(
  transaction: StagedTrustedFileMutation<boolean> | null,
  external: SetupExternalTransaction,
  cause?: unknown,
): void {
  const rollbackErrors: unknown[] = [];
  if (cause !== undefined && containsLifecycleLockLoss(cause)) {
    external.abandon();
    process.exitCode = 1;
    console.error(
      `[lore] Lifecycle-lock ownership was lost; external package state was not rolled back and recovery evidence was preserved.`,
    );
  } else {
    try {
      external.rollback();
    } catch (error) {
      rollbackErrors.push(error);
    }
  }
  try {
    transaction?.rollback();
  } catch (error) {
    rollbackErrors.push(error);
  }
  if (rollbackErrors.length > 0) {
    throw new AggregateError(
      cause === undefined ? rollbackErrors : [cause, ...rollbackErrors],
      "Setup failed and could not be fully rolled back.",
    );
  }
}

function containsLifecycleLockLoss(error: unknown): boolean {
  if (error instanceof LifecycleLockLostError) return true;
  if (error instanceof AggregateError) {
    return error.errors.some(containsLifecycleLockLoss);
  }
  return (
    error instanceof Error &&
    error.cause !== undefined &&
    containsLifecycleLockLoss(error.cause)
  );
}

function runSetupTargetsTransactionally(
  targets: readonly AppSetup[],
  baseUrl: string,
  noPlugin: boolean,
  lifecycleLock: LifecycleLock,
): boolean {
  const external = new SetupExternalTransaction(lifecycleLock);
  const runTargets = (): boolean => {
    for (const app of targets) {
      lifecycleLock.assertOwned();
      if (app.run(baseUrl, noPlugin, lifecycleLock, external) === false) {
        return false;
      }
    }
    return true;
  };
  const setupPaths = targets.flatMap((app) => app.undoPaths());
  let transaction: StagedTrustedFileMutation<boolean> | null = null;
  let succeeded: boolean;
  try {
    if (setupPaths.length === 0) {
      succeeded = runTargets();
    } else {
      transaction = stageTrustedFileMutation(setupPaths, runTargets);
      succeeded = transaction.result;
    }
  } catch (error) {
    // stageTrustedFileMutation already restores files when its action throws.
    rollbackSetupTransaction(null, external, error);
    throw error;
  }

  if (!succeeded) {
    rollbackSetupTransaction(transaction, external);
    return false;
  }

  try {
    lifecycleLock.assertOwned();
    transaction?.prepareCommit();
    setupExternalEffectHook?.("before-prepare");
    lifecycleLock.assertOwned();
    external.prepareCommit();
    lifecycleLock.assertOwned();
    external.establishCommitPoint();
  } catch (error) {
    if (!external.hasDurableCommitPoint()) {
      rollbackSetupTransaction(transaction, external, error);
    } else {
      external.abandon();
      process.exitCode = 1;
      console.error(
        `[lore] Setup crossed its durable commit point; committed package and config state were preserved with recovery evidence.`,
      );
    }
    throw error;
  }

  try {
    lifecycleLock.assertOwned();
    transaction?.commit();
  } catch (error) {
    if (!external.hasDurableCommitPoint()) {
      rollbackSetupTransaction(transaction, external, error);
    } else {
      external.abandon();
      process.exitCode = 1;
      console.error(
        `[lore] Setup crossed its durable commit point; committed package and config state were preserved with recovery evidence.`,
      );
    }
    throw error;
  }
  // Visible files and the package crossed one durable logical commit point
  // before rollback artifacts were released. Journal cleanup is validation and
  // evidence cleanup only; failures after this point must never compensate npm.
  external.commit();
  return true;
}

async function commandSetupLocked(
  args: string[],
  values: Record<string, unknown>,
  lifecycleLock: LifecycleLock,
): Promise<{
  baseUrl: string;
  remoteUrl: string | undefined;
  authenticatedPort: number | null;
} | null> {
  lifecycleLock.assertOwned();
  reconcileSetupExternalEffects(lifecycleLock);

  // Read-only/restore operations do not write a new gateway route and must work
  // even when the current shell has a Claude cloud-routing conflict.
  if (args[0]?.toLowerCase() === "status") {
    lifecycleLock.assertOwned();
    const { printInventoryStatus } = await import("./inventory");
    printInventoryStatus();
    return null;
  }
  if (args[0]?.toLowerCase() === "undo") {
    lifecycleLock.assertOwned();
    await commandUndo(args.slice(1), lifecycleLock);
    return null;
  }

  // Detect conflicting Claude Code native cloud flags — these break the
  // plain-Anthropic-to-lore path. The client must NOT use CLAUDE_CODE_USE_BEDROCK
  // or CLAUDE_CODE_USE_VERTEX; the gateway handles cloud translation instead.
  if (
    process.env.CLAUDE_CODE_USE_BEDROCK === "1" ||
    process.env.CLAUDE_CODE_USE_VERTEX === "1"
  ) {
    const flag =
      process.env.CLAUDE_CODE_USE_BEDROCK === "1"
        ? "CLAUDE_CODE_USE_BEDROCK"
        : "CLAUDE_CODE_USE_VERTEX";
    console.error(`[lore] Conflicting environment variable: ${flag}=1`);
    console.error(
      `[lore] Lore translates requests to Bedrock/Vertex internally — the client must speak plain Anthropic to the gateway.`,
    );
    console.error(
      `[lore] Unset ${flag} and let Lore handle the cloud provider routing.`,
    );
    process.exitCode = 1;
    return null;
  }

  const remoteUrl = values.remote as string | undefined;
  const explicitPort = values.port ? Number(values.port) : undefined;
  const noPlugin = values["no-plugin"] === true || values.noPlugin === true;

  // Authenticate local process state even when --port is explicit: explicit
  // selection still wins, but only a matching owner-authenticated record can
  // produce a successful local liveness notice.
  const authenticatedPort = remoteUrl
    ? null
    : await detectAuthenticatedGatewayPort();

  let baseUrl: string;
  try {
    baseUrl = normalizeBaseUrl(
      remoteUrl,
      chooseSetupPort({ explicitPort, remoteUrl, authenticatedPort }),
    );
  } catch (e) {
    console.error(`[lore] ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
    return null;
  }

  const appName = args[0]?.toLowerCase();

  if (appName) {
    // Explicit app name given
    const app = SUPPORTED_APPS.find(
      (a) => a.agentName === appName || a.displayName.toLowerCase() === appName,
    );

    if (!app) {
      const supported = SUPPORTED_APPS.map((a) => a.agentName).join(", ");
      console.error(
        `[lore] Unknown app "${args[0]}". Supported apps: ${supported}`,
      );
      process.exitCode = 1;
      return null;
    }

    // Warn if the binary isn't detected, but proceed anyway
    const detected = detectAgents();
    if (!detected.some((d) => d.def.name === app.agentName)) {
      console.log(
        `[lore] Warning: ${app.displayName} binary not found on PATH. Configuring anyway.`,
      );
    }

    lifecycleLock.assertOwned();
    if (
      !runSetupTargetsTransactionally([app], baseUrl, noPlugin, lifecycleLock)
    ) {
      return null;
    }
    return { baseUrl, remoteUrl, authenticatedPort };
  }

  // No app name — auto-detect
  const detected = detectAgents();
  const setupTargets = SUPPORTED_APPS.filter((app) =>
    detected.some((d) => d.def.name === app.agentName),
  );

  if (setupTargets.length === 0) {
    const supported = SUPPORTED_APPS.map(
      (a) => `${a.displayName} (lore setup ${a.agentName})`,
    ).join(", ");
    console.error(`[lore] No supported apps detected.`);
    console.error(`[lore] Supported: ${supported}`);
    console.error(
      `[lore] You can also specify an app explicitly: lore setup <app>`,
    );
    process.exitCode = 1;
    return null;
  }

  // Auto-detected setup is one operation: retain every target's pre-run file
  // generation and any owned external changes until all handlers succeed.
  if (
    !runSetupTargetsTransactionally(
      setupTargets,
      baseUrl,
      noPlugin,
      lifecycleLock,
    )
  ) {
    return null;
  }
  return { baseUrl, remoteUrl, authenticatedPort };
}

export async function commandSetup(
  args: string[],
  values: Record<string, unknown>,
): Promise<void> {
  const liveness = await withLifecycleLock("setup", (lifecycleLock) =>
    commandSetupLocked(args, values, lifecycleLock),
  );
  if (liveness) {
    await reportLiveness(
      liveness.baseUrl,
      liveness.remoteUrl,
      liveness.authenticatedPort,
    );
  }
}

/**
 * Probe remote health, or compare local configuration to the already
 * authenticated owner process record. Public local health is not identity.
 */
async function reportLiveness(
  baseUrl: string,
  remoteUrl: string | undefined,
  authenticatedPort: number | null,
): Promise<void> {
  const origin = baseUrl.replace(/\/v1$/, "");
  const expectedLocalOrigin =
    authenticatedPort === null
      ? null
      : normalizeBaseUrl(undefined, authenticatedPort).replace(/\/v1$/, "");
  const alive = remoteUrl
    ? await (async () => {
        const { probeGateway } = await import("./start");
        return probeGateway(origin);
      })()
    : origin === expectedLocalOrigin;
  const notice = formatLivenessNotice({
    alive,
    origin,
    remote: Boolean(remoteUrl),
  });
  console.log(`[lore]`);
  for (const line of notice.lines) console.log(line);
  console.log(`[lore]`);
  for (const line of formatSetupGuidance()) console.log(line);
}
