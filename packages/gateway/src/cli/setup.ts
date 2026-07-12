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
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { CLAUDE_CODE_FIRST_PARTY_ENV } from "../cch";
import { readPortFile } from "../portfile";
import { detectAgents } from "./agents";
import { probeGateway } from "./start";
import {
  captureJsonBackup,
  applyJsonBackup,
  readLegacyJsonBackup,
  LORE_BACKUP_KEY,
  buildTomlBackupBlock,
  prependTomlBackupBlock,
  restoreTomlBackup,
  buildEnvBackupBlock,
  prependEnvBackupBlock,
  restoreEnvBackup,
  setEnvValueRaw,
  type RestoreSummary,
  type JsonBackup,
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

interface AppSetup {
  /** Internal identifier matching AgentDef.name */
  agentName: string;
  /** Human-readable name */
  displayName: string;
  /** Run the setup for this app. `noPlugin` is true when the user passed --no-plugin. */
  run: (baseUrl: string, noPlugin: boolean) => void;
  /** Optional plugin install + registration */
  plugin?: PluginSpec;
  /** Undo a previous `lore setup` for this app, restoring the saved backup. */
  undo: () => RestoreSummary;
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
    run: (baseUrl) => setupCodex(baseUrl),
    undo: undoCodex,
    // No Lore plugin for Codex — the gateway URL + DISABLE_AUTO_COMPACT in
    // the TOML is the full integration. There's no plugin host in Codex.
  },
  {
    agentName: "opencode",
    displayName: "OpenCode",
    run: (baseUrl, noPlugin) => setupOpencode(baseUrl, noPlugin),
    plugin: opencodePluginSpec,
    undo: undoOpencode,
  },
  {
    agentName: "claude-code",
    displayName: "Claude Code",
    run: (baseUrl) => setupClaudeCode(baseUrl),
    undo: undoClaudeCode,
    // No Lore plugin for Claude Code — Anthropic controls the API surface
    // and there's no plugin host. The ANTHROPIC_BASE_URL env var is the
    // only integration point.
  },
  {
    agentName: "hermes",
    displayName: "Hermes Agent",
    run: (baseUrl) => setupHermes(baseUrl),
    undo: undoHermes,
    // No Lore plugin registered here — Hermes reads `OPENAI_BASE_URL` +
    // `HERMES_INFERENCE_PROVIDER` from `~/.hermes/.env` (python-dotenv) at
    // launch. That env pair is the whole integration; the `lore-hermes`
    // plugin is a separate `pip install` concern.
  },
  {
    agentName: "pi",
    displayName: "Pi",
    run: (baseUrl) => setupPi(baseUrl),
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
    run: (baseUrl) => setupCopilot(baseUrl),
    undo: undoCopilot,
    // Copilot CLI has NO config-file endpoint override — interception is only
    // via the COPILOT_API_URL env var. `run` prints the required `lore run
    // copilot` / export guidance; there is nothing to persist, so `undo` is an
    // informational no-op. Inventory reads COPILOT_API_URL from the environment.
  },
  {
    agentName: "gemini",
    displayName: "Gemini CLI",
    run: (baseUrl) => setupGemini(baseUrl),
    undo: undoGemini,
    // Gemini CLI reads GOOGLE_GEMINI_BASE_URL from ~/.gemini/.env (dotenv), so
    // this persists the base URL there — the native generateContent equivalent
    // of the Hermes env writer.
  },
];

// ---------------------------------------------------------------------------
// Plugin install + registration
// ---------------------------------------------------------------------------

/**
 * Check whether an npm package is already installed globally.
 * Uses `npm ls -g --json` and looks for the package in the dependency tree.
 * Returns true if installed at any version, false otherwise.
 */
function isNpmPackageInstalled(npmPackage: string): boolean {
  try {
    const out = execFileSync(
      "npm",
      ["ls", "-g", npmPackage, "--json", "--depth=0"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const parsed = JSON.parse(out) as {
      dependencies?: Record<string, unknown>;
    };
    return Boolean(parsed.dependencies?.[npmPackage]);
  } catch {
    // `npm ls` exits non-zero when the package isn't found. That's the
    // common case here, so we treat any error as "not installed."
    return false;
  }
}

/**
 * Run `npm install -g <package>` and stream stdout/stderr to the user.
 * Returns true on success, false on failure (with a helpful error message
 * already printed). Never throws.
 */
function runNpmInstall(npmPackage: string): boolean {
  console.log(`[lore] Running: npm install -g ${npmPackage}`);
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

/**
 * Apply the plugin's config registration and write the result back to disk.
 * `configPath` is the path the user-facing handler writes to (so the
 * plugin registration is in the same file the user just inspected).
 */
function applyPluginRegistration(
  spec: PluginSpec,
  configPath: string,
  config: Record<string, unknown>,
): boolean {
  const modified = spec.apply(config);
  if (!modified) {
    console.log(`[lore] Plugin "${spec.npmPackage}" already registered.`);
    return false;
  }
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return true;
}

/**
 * Install a plugin (if not already installed) and register it in the
 * agent's config file. Never throws; returns true on full success,
 * false if the install or registration step failed.
 *
 * Called by `setupOpencode` after writing the gateway URL to the config.
 * The config file the user-facing handler just wrote is the one we
 * re-read, register the plugin into, and write back.
 */
function installPlugin(spec: PluginSpec, configPath: string): boolean {
  console.log(`[lore] Plugin: ${spec.npmPackage}`);

  if (!isNpmPackageInstalled(spec.npmPackage)) {
    console.log(`[lore]   not installed globally — installing…`);
    if (!runNpmInstall(spec.npmPackage)) {
      return false;
    }
  } else {
    console.log(`[lore]   already installed globally.`);
  }

  // Re-read the config the user-facing handler just wrote, register the
  // plugin, and write it back. We do this AFTER the install so a failed
  // install doesn't leave the user with a half-configured setup.
  const config = readJsonConfig(configPath);
  const registered = applyPluginRegistration(spec, configPath, config);
  if (registered) {
    console.log(`[lore]   registered in: ${configPath}`);
  }
  return true;
}

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
  livePort?: number | null;
}): number | undefined {
  if (input.remoteUrl) return undefined;
  if (input.explicitPort !== undefined) return input.explicitPort;
  if (input.livePort != null) return input.livePort;
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
 * Detect a running local gateway and return its port, or null. Reads the port
 * file written by a running gateway, then verifies it actually answers.
 */
async function detectLiveGatewayPort(): Promise<number | null> {
  const port = readPortFile();
  if (!port) return null;
  return (await probeGateway(`http://127.0.0.1:${port}`)) ? port : null;
}

/**
 * Normalize a gateway URL for use as a provider base URL.
 * Ensures the URL ends with `/v1` (required by Codex).
 * Rejects URLs with characters that would break TOML string embedding.
 */
export function normalizeBaseUrl(
  remoteUrl: string | undefined,
  port: number | undefined,
): string {
  if (remoteUrl) {
    const stripped = remoteUrl.trim().replace(/\/+$/, "");
    if (!stripped) throw new Error("Remote URL cannot be empty.");
    validateUrl(stripped);
    return stripped.endsWith("/v1") ? stripped : `${stripped}/v1`;
  }
  if (port !== undefined) {
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error(`Invalid port "${port}". Must be 0–65535.`);
    }
  }
  return `http://127.0.0.1:${port ?? DEFAULT_PORT}/v1`;
}

/**
 * Reject URLs containing characters that would produce malformed TOML
 * or could be used for injection (double-quotes, backslashes, control chars).
 */
function validateUrl(url: string): void {
  // oxlint-disable-next-line no-control-regex -- intentional control-character sanitization
  if (/[\x00-\x1f"\\]/.test(url)) {
    throw new Error(`Invalid characters in URL: ${url}`);
  }
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

function setupCodex(baseUrl: string): void {
  const configPath = codexConfigPath();
  const configDir = join(homedir(), ".codex");

  // Ensure ~/.codex/ exists (recursive: true is a no-op when it already exists)
  mkdirSync(configDir, { recursive: true });

  // Read existing config or start fresh
  let content = "";
  try {
    content = readFileSync(configPath, "utf8");
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }

  // Capture a commented backup block from the ORIGINAL content (before lore's
  // writes), recording the values lore is about to set so undo can revert only
  // if the file still holds them. Then apply lore's changes and prepend it.
  const backupBlock = buildTomlBackupBlock(content, {
    openai_base_url: `"${baseUrl}"`,
    model_auto_compact_token_limit: String(CODEX_COMPACT_DISABLE_LIMIT),
  });
  const updated = updateCodexConfig(content, baseUrl);
  const final = backupBlock
    ? prependTomlBackupBlock(updated, backupBlock)
    : updated;
  writeFileSync(configPath, final, "utf8");

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
  try {
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return {};
    console.warn(
      `[lore] Warning: could not parse ${path} as JSON (${err.message}). Starting with empty config.`,
    );
    return {};
  }
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
  const existing = readJsonConfig(path);
  const merged = deepMerge(existing, updates);
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
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
 * absent or corrupt. A corrupt sidecar is treated as absent (rather than
 * throwing) so undo degrades to a no-op and setup won't overwrite it.
 */
export function loadJsonSetupBackup(configPath: string): JsonBackup | null {
  let raw: string;
  try {
    raw = readFileSync(jsonBackupPath(configPath), "utf8");
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      Array.isArray((parsed as { entries?: unknown }).entries)
    ) {
      return parsed as JsonBackup;
    }
  } catch {
    // Corrupt sidecar — fall through and report "no backup".
  }
  return null;
}

/** Remove the sidecar backup file (no-op if it doesn't exist). */
function removeJsonSetupBackup(configPath: string): void {
  try {
    rmSync(jsonBackupPath(configPath));
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

/**
 * Persist the backup for a JSON config to its sidecar file. Preserves the TRUE
 * original: if a sidecar already exists it is kept (re-running setup never
 * overwrites the original with lore's own values); otherwise a migrated
 * `legacyBackup` (from an old in-config `_loreBackup` key) is written, else the
 * freshly-captured `freshBackup`.
 */
function persistJsonSetupBackup(
  configPath: string,
  legacyBackup: JsonBackup | null,
  freshBackup: JsonBackup,
): void {
  if (existsSync(jsonBackupPath(configPath))) return;
  writeFileSync(
    jsonBackupPath(configPath),
    `${JSON.stringify(legacyBackup ?? freshBackup, null, 2)}\n`,
    "utf8",
  );
}

// ---------------------------------------------------------------------------
// opencode setup
// ---------------------------------------------------------------------------

/** Path to the OpenCode user-level config file. */
export function opencodeConfigPath(): string {
  return join(homedir(), ".config", "opencode", "opencode.json");
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
const OPENCODE_SETUP_PROVIDER_IDS = [
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

function setupOpencode(baseUrl: string, noPlugin: boolean): void {
  const configPath = opencodeConfigPath();
  const configDir = join(homedir(), ".config", "opencode");

  mkdirSync(configDir, { recursive: true });

  const existing = readJsonConfig(configPath);
  // Migrate away from any legacy in-config `_loreBackup` key: capture it for the
  // sidecar, then strip it so every config we write is schema-valid for
  // OpenCode (its schema is `additionalProperties: false` and rejects unknown
  // keys — the illegal key made OpenCode refuse to start).
  const legacyBackup = readLegacyJsonBackup(existing);
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

  // Write the provider/compaction config first WITHOUT a backup. The backup is
  // finalized at the end, after the plugin install, so `pluginAdded` reflects
  // what actually happened (a failed install must NOT later cause undo to
  // remove a plugin the user added themselves).
  const updated = updateOpencodeConfig(existing, baseUrl);
  writeFileSync(configPath, `${JSON.stringify(updated, null, 2)}\n`, "utf8");

  console.log(`[lore] OpenCode configured to use Lore gateway.`);
  console.log(
    `[lore]   provider.<id>.options.baseURL = "${baseUrl}" (all ${OPENCODE_SETUP_PROVIDER_IDS.length} providers, --no-plugin fallback)`,
  );
  console.log(`[lore]   compaction.auto = false (auto-compaction disabled)`);
  console.log(`[lore]   Config: ${configPath}`);
  console.log(`[lore]`);

  let pluginInstalled = false;
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
    pluginInstalled = installPlugin(opencodePluginSpec, configPath);
    if (!pluginInstalled) process.exitCode = 1;
  }

  // Finalize the backup now that the (possibly config-rewriting) plugin install
  // has run. `installPlugin` returns true on full success (both npm install and
  // registration of the plugin in the config), so `pluginInstalled && !pluginAlreadyPresent`
  // accurately reflects whether lore actually added the plugin.
  const finalConfig = readJsonConfig(configPath);
  // Defensive: never let the schema-invalid key reach OpenCode's config, even
  // if some earlier write reintroduced it.
  delete finalConfig[LORE_BACKUP_KEY];
  const backup = captureJsonBackup(existing, loreValues, {
    pluginAdded: pluginInstalled && !pluginAlreadyPresent,
  });
  persistJsonSetupBackup(configPath, legacyBackup, backup);
  writeFileSync(
    configPath,
    `${JSON.stringify(finalConfig, null, 2)}\n`,
    "utf8",
  );
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

function setupClaudeCode(baseUrl: string): void {
  const configPath = claudeCodeSettingsPath();
  const configDir = join(homedir(), ".claude");

  mkdirSync(configDir, { recursive: true });

  // Strip the /v1 suffix — Claude Code appends /v1/messages itself.
  const anthropicBaseUrl = baseUrl.endsWith("/v1")
    ? baseUrl.slice(0, -3)
    : baseUrl;

  const existing = readJsonConfig(configPath);
  const legacyBackup = readLegacyJsonBackup(existing);
  delete existing[LORE_BACKUP_KEY];
  const backup = captureJsonBackup(existing, {
    "env.ANTHROPIC_BASE_URL": anthropicBaseUrl,
    "env.DISABLE_AUTO_COMPACT": "1",
    [`env.${CLAUDE_CODE_FIRST_PARTY_ENV}`]: "1",
  });
  const updated = updateClaudeCodeSettings(existing, anthropicBaseUrl);
  persistJsonSetupBackup(configPath, legacyBackup, backup);
  writeFileSync(configPath, `${JSON.stringify(updated, null, 2)}\n`, "utf8");

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
  const agentDir =
    process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
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
const PI_ANTHROPIC_PROVIDERS = [
  "anthropic",
  "fireworks",
  "minimax",
  "minimax-cn",
  "kimi-coding",
] as const;

const PI_OPENAI_PROVIDERS = [
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

function setupPi(baseUrl: string): void {
  const configPath = piModelsConfigPath();
  mkdirSync(dirname(configPath), { recursive: true });

  // Anthropic-family Pi providers hit the gateway root; OpenAI-family get
  // `/v1`. `baseUrl` arrives with `/v1` (setup writer contract) so strip it
  // back to the origin first.
  const root = baseUrl.replace(/\/v1$/, "");

  const existing = readJsonConfig(configPath);
  const legacyBackup = readLegacyJsonBackup(existing);
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

  const backup = captureJsonBackup(existing, loreValues);
  const updated = updatePiModelsConfig(existing, root);
  persistJsonSetupBackup(configPath, legacyBackup, backup);
  writeFileSync(configPath, `${JSON.stringify(updated, null, 2)}\n`, "utf8");

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
  const home = process.env.HERMES_HOME || join(homedir(), ".hermes");
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
  // Build the backup from the ORIGINAL content (prior values) before we edit.
  const block = buildEnvBackupBlock(content, loreValues);
  let result = content;
  for (const [key, value] of Object.entries(loreValues)) {
    result = setEnvValueRaw(result, key, value);
  }
  return block ? prependEnvBackupBlock(result, block) : result;
}

function setupHermes(baseUrl: string): void {
  const configPath = hermesEnvPath();
  mkdirSync(dirname(configPath), { recursive: true });

  let content = "";
  try {
    content = readFileSync(configPath, "utf8");
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }

  const updated = updateHermesEnv(content, baseUrl);
  writeFileSync(configPath, updated, "utf8");

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
function setupCopilot(baseUrl: string): void {
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
  const block = buildEnvBackupBlock(content, loreValues);
  let result = content;
  for (const [key, value] of Object.entries(loreValues)) {
    result = setEnvValueRaw(result, key, value);
  }
  return block ? prependEnvBackupBlock(result, block) : result;
}

function setupGemini(baseUrl: string): void {
  const configPath = geminiEnvPath();
  mkdirSync(dirname(configPath), { recursive: true });

  let content = "";
  try {
    content = readFileSync(configPath, "utf8");
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }

  const updated = updateGeminiEnv(content, baseUrl);
  writeFileSync(configPath, updated, "utf8");

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
function undoJsonApp(configPath: string): RestoreSummary {
  const cfg = readJsonConfig(configPath);
  const backup = loadJsonSetupBackup(configPath) ?? readLegacyJsonBackup(cfg);
  const hadLegacyKey = LORE_BACKUP_KEY in cfg;

  if (!backup) {
    // Nothing to restore. Still strip a stray/legacy key so a schema-invalid
    // config can't linger (e.g. a corrupt sidecar with an in-config key).
    if (hadLegacyKey) {
      delete cfg[LORE_BACKUP_KEY];
      writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
    }
    return { hadBackup: false, restored: [], skipped: [] };
  }

  const summary = applyJsonBackup(cfg, backup);
  // Always drop any legacy in-config backup key (migration cleanup).
  delete cfg[LORE_BACKUP_KEY];
  writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
  if (summary.skipped.length === 0) removeJsonSetupBackup(configPath);
  return summary;
}

function undoClaudeCode(): RestoreSummary {
  return undoJsonApp(claudeCodeSettingsPath());
}

function undoOpencode(): RestoreSummary {
  return undoJsonApp(opencodeConfigPath());
}

function undoPi(): RestoreSummary {
  return undoJsonApp(piModelsConfigPath());
}

function undoHermes(): RestoreSummary {
  const configPath = hermesEnvPath();
  let content: string;
  try {
    content = readFileSync(configPath, "utf8");
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { hadBackup: false, restored: [], skipped: [] };
    }
    throw e;
  }
  const { content: restored, summary } = restoreEnvBackup(content);
  if (summary.hadBackup) writeFileSync(configPath, restored, "utf8");
  return summary;
}

function undoCopilot(): RestoreSummary {
  // `lore setup copilot` never persists anything (Copilot CLI has no config-file
  // endpoint field), so there is nothing to restore. Tell the user how to stop
  // routing and return an empty summary.
  console.log(
    `[lore] GitHub Copilot CLI setup is env-var based (COPILOT_API_URL); lore`,
  );
  console.log(
    `[lore] wrote no config. Remove the COPILOT_API_URL export from your shell`,
  );
  console.log(`[lore] profile to stop routing through the gateway.`);
  return { hadBackup: false, restored: [], skipped: [] };
}

function undoGemini(): RestoreSummary {
  const configPath = geminiEnvPath();
  let content: string;
  try {
    content = readFileSync(configPath, "utf8");
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { hadBackup: false, restored: [], skipped: [] };
    }
    throw e;
  }
  const { content: restored, summary } = restoreEnvBackup(content);
  if (summary.hadBackup) writeFileSync(configPath, restored, "utf8");
  return summary;
}

function undoCodex(): RestoreSummary {
  const configPath = codexConfigPath();
  let content: string;
  try {
    content = readFileSync(configPath, "utf8");
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { hadBackup: false, restored: [], skipped: [] };
    }
    throw e;
  }
  const { content: restored, summary } = restoreTomlBackup(content);
  if (summary.hadBackup) writeFileSync(configPath, restored, "utf8");
  return summary;
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

async function commandUndo(args: string[]): Promise<void> {
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
    targets = SUPPORTED_APPS;
  }

  let restoredAny = false;
  for (const app of targets) {
    const summary = app.undo();
    if (summary.hadBackup) restoredAny = true;
    reportUndo(app, summary, Boolean(appName));
  }

  if (!restoredAny && !appName) {
    console.log(`[lore] No lore setup backups found — nothing to undo.`);
  }
}

// ---------------------------------------------------------------------------
// Command entry point
// ---------------------------------------------------------------------------

export async function commandSetup(
  args: string[],
  values: Record<string, unknown>,
): Promise<void> {
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
    return;
  }

  // `lore setup undo [app]` — restore the backup written by a prior setup.
  if (args[0]?.toLowerCase() === "undo") {
    await commandUndo(args.slice(1));
    return;
  }

  // `lore setup status` — read-only inventory of what setup has touched.
  if (args[0]?.toLowerCase() === "status") {
    const { printInventoryStatus } = await import("./inventory");
    printInventoryStatus();
    return;
  }

  const remoteUrl = values.remote as string | undefined;
  const explicitPort = values.port ? Number(values.port) : undefined;
  const noPlugin = values.noPlugin === true;

  // Detect a running local gateway so we write its actual port (handles the
  // 3207 → 5673 → random fallback chain) rather than blindly assuming 3207.
  const livePort =
    remoteUrl || explicitPort !== undefined
      ? null
      : await detectLiveGatewayPort();

  let baseUrl: string;
  try {
    baseUrl = normalizeBaseUrl(
      remoteUrl,
      chooseSetupPort({ explicitPort, remoteUrl, livePort }),
    );
  } catch (e) {
    console.error(`[lore] ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
    return;
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
      return;
    }

    // Warn if the binary isn't detected, but proceed anyway
    const detected = detectAgents();
    if (!detected.some((d) => d.def.name === app.agentName)) {
      console.log(
        `[lore] Warning: ${app.displayName} binary not found on PATH. Configuring anyway.`,
      );
    }

    app.run(baseUrl, noPlugin);
    await reportLiveness(baseUrl, remoteUrl, livePort);
    return;
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
    return;
  }

  for (const app of setupTargets) {
    app.run(baseUrl, noPlugin);
  }
  await reportLiveness(baseUrl, remoteUrl, livePort);
}

/**
 * Probe the configured gateway and print a PASS/WARN notice. Reuses the
 * already-probed `livePort` result for the default-local case to avoid a
 * second network round-trip.
 */
async function reportLiveness(
  baseUrl: string,
  remoteUrl: string | undefined,
  livePort: number | null,
): Promise<void> {
  const origin = baseUrl.replace(/\/v1$/, "");
  // If we already confirmed a live local port, we know it's reachable.
  const alive = livePort != null ? true : await probeGateway(origin);
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
