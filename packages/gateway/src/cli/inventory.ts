/**
 * Shared read-only inventory of what `lore setup` has touched, plus helpers
 * used by `lore setup status`, `lore doctor`, and (later) uninstall.
 *
 * Nothing in this module mutates config files. Callers are expected to read
 * the app configs (via `readJsonConfig`/`readFileSync`) and pass values in,
 * so the pure helpers here are unit-testable without touching the filesystem.
 */
import { existsSync, readFileSync } from "node:fs";
import {
  claudeCodeSettingsPath,
  codexConfigPath,
  hermesEnvPath,
  opencodeConfigPath,
  piModelsConfigPath,
  readJsonConfig,
} from "./setup";
import { getPath, LORE_BACKUP_KEY } from "./setup-backup";
import { getEnvValue, getTomlTopLevelValue } from "./setup-backup";
import { readPortFile } from "../portfile";
import { probeGateway } from "./start";
import { VERSION } from "./version";

// ---------------------------------------------------------------------------
// Routing classification (pure)
// ---------------------------------------------------------------------------

/** Known first-party vendor hostnames that are definitely NOT lore. */
const VENDOR_HOSTS = new Set([
  "api.anthropic.com",
  "api.openai.com",
  "generativelanguage.googleapis.com",
  "bedrock-runtime.us-east-1.amazonaws.com", // representative; bedrock uses many regional hosts
]);

/**
 * Best-effort: does this URL point at a lore gateway?
 *
 * Lore's gateway binds to loopback (or a user-supplied `--host`) on a custom
 * port — so "lore" is "not a known vendor endpoint". We can't be exact (the
 * user can point at an arbitrary proxy), but this catches the common case
 * where setup left a first-party URL in place (or vice-versa).
 */
export function isLoreUrl(url: string | undefined): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  if (VENDOR_HOSTS.has(host)) return false;
  // Loopback / localhost → almost certainly lore (vendors never serve there).
  if (host === "127.0.0.1" || host === "localhost" || host === "::1") {
    return true;
  }
  // Anything else (LAN, Tailscale, container host) — treat as lore unless it's
  // a known vendor. This is the best we can do without a registry.
  return true;
}

export type RoutingValue =
  | { kind: "unset" }
  | { kind: "lore"; value: string }
  | { kind: "other"; value: string };

/** Classify a raw routing value (URL string or undefined). Pure. */
export function classifyRoutingValue(value: string | undefined): RoutingValue {
  if (value === undefined || value === "") return { kind: "unset" };
  return isLoreUrl(value) ? { kind: "lore", value } : { kind: "other", value };
}

// ---------------------------------------------------------------------------
// Inventory row (pure formatting)
// ---------------------------------------------------------------------------

export interface InventoryRow {
  app: string;
  file: string;
  fileExists: boolean;
  key: string;
  routing: RoutingValue;
  /** Prior value recorded by `lore setup`, if a backup sidecar/block exists. */
  priorValue?: string;
}

/**
 * Render a single inventory row as a single line. Pure.
 * Example: `  Claude Code   env.ANTHROPIC_BASE_URL   lore  http://127.0.0.1:3207`
 */
export function formatInventoryRow(row: InventoryRow): string {
  const filePart = row.fileExists ? row.file : `${row.file} (missing)`;
  let routingPart: string;
  switch (row.routing.kind) {
    case "lore":
      routingPart = `lore  ${row.routing.value}`;
      break;
    case "other":
      routingPart = `other  ${row.routing.value}`;
      break;
    case "unset":
      routingPart = "unset";
      break;
  }
  const prior =
    row.priorValue !== undefined ? `   (prior: ${row.priorValue})` : "";
  return `  ${row.app.padEnd(14)} ${row.key.padEnd(38)} ${routingPart}${prior}   [${filePart}]`;
}

// ---------------------------------------------------------------------------
// Inventory collection (does IO; thin shims over setup.ts helpers)
// ---------------------------------------------------------------------------

export interface AppInventory {
  app: string;
  file: string;
  fileExists: boolean;
  rows: InventoryRow[];
  hasBackup: boolean;
}

/** Collect inventory for Claude Code (JSON). Reads `~/.claude/settings.json`. */
export function collectClaudeCodeInventory(): AppInventory {
  const file = claudeCodeSettingsPath();
  const fileExists = existsSync(file);
  const rows: InventoryRow[] = [];
  let hasBackup = false;
  if (fileExists) {
    const cfg = readJsonConfig(file);
    const backup = cfg[LORE_BACKUP_KEY] as
      | {
          entries?: {
            path: string;
            priorValue?: unknown;
            hadPrior?: boolean;
          }[];
        }
      | undefined;
    hasBackup = backup !== undefined;
    for (const key of ["env.ANTHROPIC_BASE_URL", "env.DISABLE_AUTO_COMPACT"]) {
      const v = getPath(cfg, key);
      const entry = backup?.entries?.find((e) => e.path === key);
      const priorValue =
        entry?.hadPrior && typeof entry.priorValue === "string"
          ? entry.priorValue
          : undefined;
      rows.push({
        app: "Claude Code",
        file,
        fileExists,
        key,
        routing:
          typeof v === "string" ? classifyRoutingValue(v) : { kind: "unset" },
        priorValue,
      });
    }
  }
  return { app: "Claude Code", file, fileExists, rows, hasBackup };
}

/** Strip surrounding TOML quotes (basic string literal) from a raw value. */
function stripTomlQuotes(v: string): string {
  if (v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1);
  return v;
}

/** Collect inventory for Codex (TOML). Reads `~/.codex/config.toml`. */
export function collectCodexInventory(): AppInventory {
  const file = codexConfigPath();
  const fileExists = existsSync(file);
  const rows: InventoryRow[] = [];
  let hasBackup = false;
  if (fileExists) {
    const content = readFileSync(file, "utf8");
    hasBackup = content.includes("lore setup backup");
    for (const key of ["openai_base_url"]) {
      const raw = getTomlTopLevelValue(content, key);
      const v = raw === null ? undefined : stripTomlQuotes(raw);
      rows.push({
        app: "Codex",
        file,
        fileExists,
        key,
        routing: v === undefined ? { kind: "unset" } : classifyRoutingValue(v),
      });
    }
  }
  return { app: "Codex", file, fileExists, rows, hasBackup };
}

/** Collect inventory for OpenCode (JSON). Reads `~/.config/opencode/opencode.json`. */
export function collectOpencodeInventory(): AppInventory {
  const file = opencodeConfigPath();
  const fileExists = existsSync(file);
  const rows: InventoryRow[] = [];
  let hasBackup = false;
  if (fileExists) {
    const cfg = readJsonConfig(file);
    hasBackup = LORE_BACKUP_KEY in cfg;
    const url = getPath(cfg, "provider.anthropic.options.baseURL");
    rows.push({
      app: "OpenCode",
      file,
      fileExists,
      key: "provider.anthropic.options.baseURL",
      routing:
        typeof url === "string" ? classifyRoutingValue(url) : { kind: "unset" },
    });
    const plugins = cfg.plugin;
    const pluginInstalled =
      Array.isArray(plugins) && plugins.includes("@loreai/opencode");
    rows.push({
      app: "OpenCode",
      file,
      fileExists,
      key: "plugin[@loreai/opencode]",
      routing: pluginInstalled
        ? { kind: "lore", value: "@loreai/opencode" }
        : { kind: "unset" },
    });
  }
  return { app: "OpenCode", file, fileExists, rows, hasBackup };
}

/** Collect inventory for Pi (JSON). Reads `~/.pi/agent/models.json`. */
export function collectPiInventory(): AppInventory {
  const file = piModelsConfigPath();
  const fileExists = existsSync(file);
  const rows: InventoryRow[] = [];
  let hasBackup = false;
  if (fileExists) {
    const cfg = readJsonConfig(file);
    hasBackup = LORE_BACKUP_KEY in cfg;
    // `anthropic` is the representative provider (gateway root). If setup ran,
    // every gateway-routable provider carries a baseUrl; probing one is enough.
    const url = getPath(cfg, "providers.anthropic.baseUrl");
    rows.push({
      app: "Pi",
      file,
      fileExists,
      key: "providers.anthropic.baseUrl",
      routing:
        typeof url === "string" ? classifyRoutingValue(url) : { kind: "unset" },
    });
  }
  return { app: "Pi", file, fileExists, rows, hasBackup };
}

/** Collect inventory for Hermes (dotenv). Reads `~/.hermes/.env`. */
export function collectHermesInventory(): AppInventory {
  const file = hermesEnvPath();
  const fileExists = existsSync(file);
  const rows: InventoryRow[] = [];
  let hasBackup = false;
  if (fileExists) {
    const content = readFileSync(file, "utf8");
    hasBackup = content.includes("lore setup backup");
    const url = getEnvValue(content, "OPENAI_BASE_URL");
    rows.push({
      app: "Hermes",
      file,
      fileExists,
      key: "OPENAI_BASE_URL",
      routing: url === null ? { kind: "unset" } : classifyRoutingValue(url),
    });
  }
  return { app: "Hermes", file, fileExists, rows, hasBackup };
}

/** Collect inventory for all supported apps. */
export function collectInventory(): AppInventory[] {
  return [
    collectClaudeCodeInventory(),
    collectCodexInventory(),
    collectOpencodeInventory(),
    collectPiInventory(),
    collectHermesInventory(),
  ];
}

// ---------------------------------------------------------------------------
// `lore setup status` — print the inventory
// ---------------------------------------------------------------------------

export function printInventoryStatus(inventory?: AppInventory[]): void {
  const all = inventory ?? collectInventory();
  for (const inv of all) {
    console.log(`[lore] ${inv.app}  (${inv.file})`);
    if (!inv.fileExists) {
      console.log(`[lore]   file missing — not configured.`);
      continue;
    }
    if (inv.rows.length === 0) {
      console.log(`[lore]   no lore-managed keys found.`);
    }
    for (const row of inv.rows) {
      console.log(`[lore]   ${formatInventoryRow(row).trim()}`);
    }
    if (inv.hasBackup) {
      console.log(
        `[lore]   backup present (run \`lore setup undo ${inv.app.toLowerCase().replace(/\s+/g, "-")}\` to revert).`,
      );
    }
    console.log();
  }
}

// ---------------------------------------------------------------------------
// `lore doctor` — inventory + live diagnostics
// ---------------------------------------------------------------------------

export type FindingLevel = "PASS" | "WARN" | "FAIL";

export interface Finding {
  level: FindingLevel;
  label: string;
  detail: string;
  remediation?: string;
}

function urlOrigin(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return url;
  }
}

/**
 * Run the doctor diagnostics. Pure-ish: takes injected inputs so it's
 * unit-testable. The thin `commandDoctor` shell wires real IO.
 */
export function runDoctorDiagnostics(input: {
  inventory: AppInventory[];
  gatewayAlive: boolean;
  gatewayPort: number | null;
  /** Shell env values that can silently override settings.json. */
  env: {
    ANTHROPIC_BASE_URL?: string;
    OPENAI_BASE_URL?: string;
    CLAUDE_CODE_USE_BEDROCK?: string;
    CLAUDE_CODE_USE_VERTEX?: string;
    ANTHROPIC_BEDROCK_BASE_URL?: string;
  };
  opencodePluginInstalled: boolean;
}): Finding[] {
  const findings: Finding[] = [];

  // 1. Version.
  findings.push({
    level: "PASS",
    label: "lore version",
    detail: VERSION,
  });

  // 2. Gateway reachability.
  findings.push(
    input.gatewayAlive
      ? {
          level: "PASS",
          label: "gateway reachable",
          detail: input.gatewayPort
            ? `responding on port ${input.gatewayPort}`
            : "responding",
        }
      : {
          level: "FAIL",
          label: "gateway reachable",
          detail: "no gateway responding",
          remediation:
            "run `lore start --bg` (or `lore run` to launch an agent through the gateway)",
        },
  );

  // 3. Port consistency: does any setup-routed LOCAL URL match the running port?
  if (input.gatewayAlive && input.gatewayPort !== null) {
    const expected = `127.0.0.1:${input.gatewayPort}`;
    let mismatch = false;
    let checked = 0;
    for (const inv of input.inventory) {
      for (const row of inv.rows) {
        // Only check URL-valued rows — the OpenCode plugin row has
        // routing.value = "@loreai/opencode", which is lore-routed but not a URL.
        if (row.routing.kind !== "lore") continue;
        if (!row.routing.value.startsWith("http")) continue;
        // Skip remote gateway URLs — a remote setup intentionally points at a
        // different host and is not a port mismatch against the local gateway.
        try {
          const u = new URL(row.routing.value);
          if (u.hostname !== "127.0.0.1" && u.hostname !== "localhost") {
            continue;
          }
        } catch {
          continue;
        }
        checked++;
        if (!row.routing.value.includes(expected)) {
          mismatch = true;
          findings.push({
            level: "WARN",
            label: `port mismatch (${inv.app}: ${row.key})`,
            detail: `setup wrote ${urlOrigin(row.routing.value)} but the gateway is on port ${input.gatewayPort}`,
            remediation:
              "re-run `lore setup <app>` so the live port is written, or start the gateway on the configured port",
          });
        }
      }
    }
    if (!mismatch && checked > 0) {
      findings.push({
        level: "PASS",
        label: "port consistency",
        detail: `all ${checked} lore-routed local URL(s) target port ${input.gatewayPort}`,
      });
    }
  }

  // 4. Conflicting shell env (Claude Code).
  const shellAnthropic = input.env.ANTHROPIC_BASE_URL;
  if (shellAnthropic && !isLoreUrl(shellAnthropic)) {
    findings.push({
      level: "WARN",
      label: "ANTHROPIC_BASE_URL in shell env",
      detail: `shell env overrides settings.json with ${shellAnthropic}`,
      remediation:
        "unset ANTHROPIC_BASE_URL in your shell, or run `lore run` which injects the gateway URL directly",
    });
  }

  // 5. Bedrock/Vertex conflict.
  if (
    input.env.CLAUDE_CODE_USE_BEDROCK ||
    input.env.CLAUDE_CODE_USE_VERTEX ||
    input.env.ANTHROPIC_BEDROCK_BASE_URL
  ) {
    findings.push({
      level: "FAIL",
      label: "Bedrock/Vertex conflict",
      detail:
        "CLAUDE_CODE_USE_BEDROCK / CLAUDE_CODE_USE_VERTEX / ANTHROPIC_BEDROCK_BASE_URL is set; lore proxies the first-party Anthropic protocol and cannot proxy Bedrock/Vertex",
      remediation:
        "unset the Bedrock/Vertex env vars, or use a direct Bedrock/Vertex setup without lore",
    });
  }

  // 6. OpenCode plugin.
  const oc = input.inventory.find((i) => i.app === "OpenCode");
  if (oc?.fileExists) {
    const row = oc.rows.find((r) => r.key === "plugin[@loreai/opencode]");
    const registered = row?.routing.kind === "lore";
    if (registered && !input.opencodePluginInstalled) {
      findings.push({
        level: "WARN",
        label: "OpenCode plugin registered but not installed",
        detail:
          "@loreai/opencode is in the plugin array but not installed globally",
        remediation: "run `npm install -g @loreai/opencode`",
      });
    } else if (!registered && input.opencodePluginInstalled) {
      findings.push({
        level: "WARN",
        label: "OpenCode plugin installed but not registered",
        detail:
          "@loreai/opencode is installed globally but not in the plugin array",
        remediation: "re-run `lore setup opencode`",
      });
    } else if (registered && input.opencodePluginInstalled) {
      findings.push({
        level: "PASS",
        label: "OpenCode plugin",
        detail: "installed and registered",
      });
    }
  }

  return findings;
}

/** Render findings as lines. Pure. */
export function formatFinding(f: Finding): string {
  const tag =
    f.level === "PASS" ? "PASS" : f.level === "WARN" ? "WARN" : "FAIL";
  const line = `[${tag}] ${f.label}: ${f.detail}`;
  return f.remediation ? `${line}\n      → ${f.remediation}` : line;
}

/**
 * `lore doctor` — collect inventory, probe the gateway, check env, and print
 * findings. Thin shell; the logic lives in `runDoctorDiagnostics` (testable).
 */
export async function commandDoctor(): Promise<void> {
  const inventory = collectInventory();
  const gatewayPort = readPortFile();
  const gatewayAlive = gatewayPort
    ? await probeGateway(`http://127.0.0.1:${gatewayPort}`)
    : false;

  const findings = runDoctorDiagnostics({
    inventory,
    gatewayAlive,
    gatewayPort,
    env: {
      ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
      OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
      CLAUDE_CODE_USE_BEDROCK: process.env.CLAUDE_CODE_USE_BEDROCK,
      CLAUDE_CODE_USE_VERTEX: process.env.CLAUDE_CODE_USE_VERTEX,
      ANTHROPIC_BEDROCK_BASE_URL: process.env.ANTHROPIC_BEDROCK_BASE_URL,
    },
    opencodePluginInstalled: isNpmPackageInstalledSafe("@loreai/opencode"),
  });

  // Print inventory first, then findings. Reuse the already-collected
  // inventory so diagnostics and display see the same data.
  console.log("[lore] Setup inventory:");
  printInventoryStatus(inventory);
  console.log("[lore] Diagnostics:");
  for (const f of findings) {
    console.log(`[lore]   ${formatFinding(f).split("\n").join("\n[lore]   ")}`);
  }
  const fails = findings.filter((f) => f.level === "FAIL").length;
  const warns = findings.filter((f) => f.level === "WARN").length;
  console.log(
    `[lore] ${findings.length} finding(s): ${fails} FAIL, ${warns} WARN, ${
      findings.length - fails - warns
    } PASS.`,
  );
  if (fails > 0) process.exitCode = 1;
}

// Local copy to avoid importing the private isNpmPackageInstalled from setup.ts.
// Mirrors its behavior; kept here so doctor doesn't grow setup.ts's surface.
function isNpmPackageInstalledSafe(pkg: string): boolean {
  try {
    // Lazy require so this file loads even if npm isn't on PATH.
    const { execFileSync } =
      require("node:child_process") as typeof import("node:child_process");
    const out = execFileSync("npm", ["ls", "-g", pkg, "--json", "--depth=0"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const parsed = JSON.parse(out) as {
      dependencies?: Record<string, unknown>;
    };
    return Boolean(parsed.dependencies?.[pkg]);
  } catch {
    return false;
  }
}
