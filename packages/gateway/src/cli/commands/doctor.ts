/**
 * `lore doctor` — run inventory + diagnostics.
 *
 * Phase 3A.5: typed Stricli command. The typed handler delegates to the
 * legacy `runDoctorDiagnostics` (pure, takes injected inputs) and adds
 * a `collectDoctorInput` shim that gathers the IO it needs. The legacy
 * `commandDoctor` remains in place for programmatic callers that
 * import it directly (tests, library users).
 *
 * Output shape:
 *   - human: inventory + findings (matches legacy format byte-for-byte)
 *   - JSON:  { inventory, findings, summary }
 *
 * Exit codes:
 *   - 0  no FAIL findings
 *   - 1  one or more FAIL findings
 */
import { buildOutputCommand } from "../lib/command";
import { probeGateway } from "../start";
import { readPortFile } from "../../portfile";
import {
  collectInventory,
  fetchMemoryHealth,
  isNpmPackageInstalledSafe,
  runDoctorDiagnostics,
  type Finding,
  type AppInventory,
  formatFinding,
  formatInventoryRow,
} from "../inventory";

type DoctorFlags = Record<string, never>;

interface DoctorSummary {
  total: number;
  fail: number;
  warn: number;
  pass: number;
}

interface DoctorResult {
  inventory: AppInventory[];
  findings: Finding[];
  summary: DoctorSummary;
}

function summarize(findings: Finding[]): DoctorSummary {
  let fail = 0;
  let warn = 0;
  for (const f of findings) {
    if (f.level === "FAIL") fail++;
    else if (f.level === "WARN") warn++;
  }
  return {
    total: findings.length,
    fail,
    warn,
    pass: findings.length - fail - warn,
  };
}

function renderInventory(inventory: AppInventory[]): string[] {
  // Mirror of the legacy `printInventoryStatus` (packages/gateway/src/cli/inventory.ts:331)
  // but rendered as strings so we can emit them through buildOutputCommand's
  // stdout/stderr pipeline. Format is intentionally byte-for-byte identical
  // to the legacy command so consumers that grep `lore doctor` output keep
  // working. Uses the exported `formatInventoryRow` so the legacy and
  // typed paths stay in lockstep (Seer finding #1 on this PR).
  const lines: string[] = [];
  for (const inv of inventory) {
    lines.push(`[lore] ${inv.app}  (${inv.file})`);
    if (!inv.fileExists) {
      lines.push(`[lore]   file missing — not configured.`);
      continue;
    }
    if (inv.rows.length === 0) {
      lines.push(`[lore]   no lore-managed keys found.`);
    }
    for (const row of inv.rows) {
      const trimmed = formatInventoryRow(row).trim();
      lines.push(`[lore]   ${trimmed}`);
    }
    if (inv.hasBackup) {
      const appSlug = inv.app.toLowerCase().replace(/\s+/g, "-");
      lines.push(
        `[lore]   backup present (run \`lore setup undo ${appSlug}\` to revert).`,
      );
    }
    lines.push("");
  }
  return lines;
}

function renderHuman(data: DoctorResult): string {
  const lines: string[] = [];
  lines.push("[lore] Setup inventory:");
  lines.push(...renderInventory(data.inventory));
  lines.push("[lore] Diagnostics:");
  for (const f of data.findings) {
    const formatted = formatFinding(f);
    for (const line of formatted.split("\n")) {
      lines.push(`[lore]   ${line}`);
    }
  }
  const s = data.summary;
  lines.push(
    `[lore] ${s.total} finding(s): ${s.fail} FAIL, ${s.warn} WARN, ${s.pass} PASS.`,
  );
  return lines.join("\n");
}

function toJson(data: DoctorResult): unknown {
  return data;
}

export const doctorCommand = buildOutputCommand<DoctorResult, DoctorFlags, []>({
  brief: "Diagnose lore setup (inventory + gateway + memory health)",
  fullDescription:
    "Print setup inventory for every supported agent, then run live " +
    "diagnostics on the gateway, gateway-side memory health, and shell " +
    "environment overrides. Exit code is 1 when any FAIL finding is " +
    "present, 0 otherwise. JSON output is { inventory, findings, summary }.",
  parameters: { flags: {} },
  config: { renderHuman, toJson },
  async handler() {
    const inventory = collectInventory();
    const gatewayPort = readPortFile();
    const gatewayAlive = gatewayPort
      ? await probeGateway(`http://127.0.0.1:${gatewayPort}`)
      : false;
    const memoryHealth =
      gatewayAlive && gatewayPort
        ? await fetchMemoryHealth(`http://127.0.0.1:${gatewayPort}`)
        : null;
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
      memoryHealth,
    });
    const summary = summarize(findings);
    if (summary.fail > 0) {
      process.exitCode = 1;
    }
    return {
      kind: "value" as const,
      data: { inventory, findings, summary },
    };
  },
});
