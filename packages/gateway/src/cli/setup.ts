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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { detectAgents } from "./agents";

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
   * Path to the agent's plugin array in its config (e.g. `["plugin"]`).
   * The plugin is appended if absent, kept in place if present.
   */
  registerConfigPath: string[];
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
  registerConfigPath: ["plugin"],
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
    // No Lore plugin for Codex — the gateway URL + DISABLE_AUTO_COMPACT in
    // the TOML is the full integration. There's no plugin host in Codex.
  },
  {
    agentName: "opencode",
    displayName: "OpenCode",
    run: (baseUrl, noPlugin) => setupOpencode(baseUrl, noPlugin),
    plugin: opencodePluginSpec,
  },
  {
    agentName: "claude-code",
    displayName: "Claude Code",
    run: (baseUrl) => setupClaudeCode(baseUrl),
    // No Lore plugin for Claude Code — Anthropic controls the API surface
    // and there's no plugin host. The ANTHROPIC_BASE_URL env var is the
    // only integration point.
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
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control-character sanitization
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
    if (/^\[/.test(line)) return false;
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

  const updated = updateCodexConfig(content, baseUrl);
  writeFileSync(configPath, updated, "utf8");

  console.log(`[lore] Codex configured to use Lore gateway.`);
  console.log(`[lore]   openai_base_url = "${baseUrl}"`);
  console.log(
    `[lore]   model_auto_compact_token_limit = ${CODEX_COMPACT_DISABLE_LIMIT} (auto-compaction disabled)`,
  );
  console.log(`[lore]   Config: ${configPath}`);
  console.log(`[lore]`);
  console.log(
    `[lore] Make sure the gateway is running (lore start) before using Codex.`,
  );
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
// opencode setup
// ---------------------------------------------------------------------------

/** Path to the OpenCode user-level config file. */
export function opencodeConfigPath(): string {
  return join(homedir(), ".config", "opencode", "opencode.json");
}

/**
 * Update (or create) the OpenCode user-level `opencode.json` to route the
 * built-in `openai` provider through the Lore gateway, and disable
 * OpenCode's built-in auto-compaction.
 *
 * Strategy:
 * - Sets `provider.openai.options.baseURL` to the gateway URL (must include
 *   `/v1` — OpenAI SDK convention used by OpenCode's OpenAI provider).
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
  return deepMerge(config, {
    provider: {
      openai: {
        options: {
          baseURL: baseUrl,
        },
      },
    },
    compaction: {
      auto: false,
    },
  });
}

function setupOpencode(baseUrl: string, noPlugin: boolean): void {
  const configPath = opencodeConfigPath();
  const configDir = join(homedir(), ".config", "opencode");

  mkdirSync(configDir, { recursive: true });

  const existing = readJsonConfig(configPath);
  const updated = updateOpencodeConfig(existing, baseUrl);
  writeFileSync(configPath, `${JSON.stringify(updated, null, 2)}\n`, "utf8");

  console.log(`[lore] OpenCode configured to use Lore gateway.`);
  console.log(`[lore]   provider.openai.options.baseURL = "${baseUrl}"`);
  console.log(`[lore]   compaction.auto = false (auto-compaction disabled)`);
  console.log(`[lore]   Config: ${configPath}`);
  console.log(`[lore]`);
  console.log(
    `[lore] Make sure the gateway is running (lore start) before using OpenCode.`,
  );

  if (noPlugin) {
    console.log(`[lore]`);
    console.log(
      `[lore] Skipped @loreai/opencode plugin install (--no-plugin).`,
    );
    console.log(
      `[lore] To install later: npm install -g @loreai/opencode, then add`,
    );
    console.log(
      `[lore] "@loreai/opencode" to the "plugin" array in ${configPath}.`,
    );
    return;
  }

  if (opencodePluginSpec) {
    installPlugin(opencodePluginSpec, configPath);
  }
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
  const updated = updateClaudeCodeSettings(existing, anthropicBaseUrl);
  writeFileSync(configPath, `${JSON.stringify(updated, null, 2)}\n`, "utf8");

  console.log(`[lore] Claude Code configured to use Lore gateway.`);
  console.log(`[lore]   env.ANTHROPIC_BASE_URL = "${anthropicBaseUrl}"`);
  console.log(
    `[lore]   env.DISABLE_AUTO_COMPACT = "1" (auto-compaction disabled)`,
  );
  console.log(`[lore]   Config: ${configPath}`);
  console.log(`[lore]`);
  console.log(
    `[lore] Make sure the gateway is running (lore start) before using Claude Code.`,
  );
}

// ---------------------------------------------------------------------------
// Command entry point
// ---------------------------------------------------------------------------

export async function commandSetup(
  args: string[],
  values: Record<string, unknown>,
): Promise<void> {
  const remoteUrl = values.remote as string | undefined;
  const port = values.port ? Number(values.port) : undefined;
  const noPlugin = values.noPlugin === true;

  let baseUrl: string;
  try {
    baseUrl = normalizeBaseUrl(remoteUrl, port);
  } catch (e) {
    console.error(`[lore] ${e instanceof Error ? e.message : e}`);
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
}
