/**
 * `lore setup [app]` — configure an AI app to route through the Lore gateway.
 *
 * Currently supports:
 *   - codex: writes `openai_base_url` and `model_auto_compact_token_limit`
 *     to `~/.codex/config.toml`
 *
 * The command auto-detects installed apps when no argument is given,
 * or accepts an explicit app name (e.g. `lore setup codex`).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { detectAgents } from "./agents";

// ---------------------------------------------------------------------------
// Supported apps and their setup handlers
// ---------------------------------------------------------------------------

interface AppSetup {
  /** Internal identifier matching AgentDef.name */
  agentName: string;
  /** Human-readable name */
  displayName: string;
  /** Run the setup for this app */
  run: (baseUrl: string) => void;
}

const SUPPORTED_APPS: AppSetup[] = [
  {
    agentName: "codex",
    displayName: "Codex",
    run: (baseUrl) => setupCodex(baseUrl),
  },
];

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
// Command entry point
// ---------------------------------------------------------------------------

export async function commandSetup(
  args: string[],
  values: Record<string, unknown>,
): Promise<void> {
  const remoteUrl = values.remote as string | undefined;
  const port = values.port ? Number(values.port) : undefined;

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

    app.run(baseUrl);
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
    app.run(baseUrl);
  }
}
