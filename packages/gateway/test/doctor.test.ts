import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type MockInstance,
} from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandSetup } from "../src/cli/setup";
import {
  runDoctorDiagnostics,
  formatFinding,
  collectInventory,
  commandDoctor,
  type Finding,
} from "../src/cli/inventory";

let home: string;
let origHome: string | undefined;
let origXdg: string | undefined;
let origPiDir: string | undefined;
let logSpy: MockInstance;
let errSpy: MockInstance;

function logged(): string {
  return [...logSpy.mock.calls, ...errSpy.mock.calls]
    .map((c) => c.join(" "))
    .join("\n");
}

beforeEach(() => {
  origHome = process.env.HOME;
  origXdg = process.env.XDG_DATA_HOME;
  origPiDir = process.env.PI_CODING_AGENT_DIR;
  home = mkdtempSync(join(tmpdir(), "lore-doctor-"));
  process.env.HOME = home;
  process.env.XDG_DATA_HOME = join(home, "data");
  // Pin Pi's agent dir under the temp HOME so the inventory stays hermetic
  // regardless of a stray PI_CODING_AGENT_DIR in the runner's environment.
  process.env.PI_CODING_AGENT_DIR = join(home, ".pi", "agent");
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  if (origXdg === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = origXdg;
  if (origPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = origPiDir;
  rmSync(home, { recursive: true, force: true });
});

describe("lore setup status (integration)", () => {
  it("reports missing files when nothing is configured", async () => {
    await commandSetup(["status"], {});
    const out = logged();
    expect(out).toContain("Claude Code");
    expect(out).toContain("missing");
    expect(out).toContain("Codex");
    expect(out).toContain("OpenCode");
  });

  it("shows lore-routed values after setup", async () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({
        env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" },
      }),
    );
    await commandSetup(["claude-code"], { port: 3299 });
    logSpy.mockClear();
    await commandSetup(["status"], {});
    const out = logged();
    expect(out).toContain("http://127.0.0.1:3299");
    expect(out).toContain("lore");
    expect(out).toContain("backup present");
  });
});

describe("commandSetup — cloud flag conflict detection", () => {
  const origBedrock = process.env.CLAUDE_CODE_USE_BEDROCK;
  const origVertex = process.env.CLAUDE_CODE_USE_VERTEX;

  afterEach(() => {
    if (origBedrock === undefined) delete process.env.CLAUDE_CODE_USE_BEDROCK;
    else process.env.CLAUDE_CODE_USE_BEDROCK = origBedrock;
    if (origVertex === undefined) delete process.env.CLAUDE_CODE_USE_VERTEX;
    else process.env.CLAUDE_CODE_USE_VERTEX = origVertex;
  });

  it("refuses when CLAUDE_CODE_USE_BEDROCK=1 is set", async () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = "1";
    process.exitCode = 0;
    await commandSetup(["claude-code"], { port: 3299 });
    expect(process.exitCode).toBe(1);
    const out = logged();
    expect(out).toContain("CLAUDE_CODE_USE_BEDROCK");
    expect(out).toContain("Lore translates");
  });

  it("refuses when CLAUDE_CODE_USE_VERTEX=1 is set", async () => {
    process.env.CLAUDE_CODE_USE_VERTEX = "1";
    process.exitCode = 0;
    await commandSetup(["claude-code"], { port: 3299 });
    expect(process.exitCode).toBe(1);
    const out = logged();
    expect(out).toContain("CLAUDE_CODE_USE_VERTEX");
    expect(out).toContain("Lore translates");
  });

  it("proceeds when neither flag is set", async () => {
    delete process.env.CLAUDE_CODE_USE_BEDROCK;
    delete process.env.CLAUDE_CODE_USE_VERTEX;
    process.exitCode = 0;
    mkdirSync(join(home, ".claude"), { recursive: true });
    // Should not exit early with code 1 from the flag check.
    // (It may still exit 1 later if the port probe fails, but the flag
    //  detection must not fire.)
    await commandSetup(["status"], {});
    const out = logged();
    expect(out).not.toContain("Conflicting environment variable");
  });
});

describe("runDoctorDiagnostics (pure)", () => {
  const emptyInventory = [
    {
      app: "Claude Code",
      file: "/x/.claude/settings.json",
      fileExists: false,
      rows: [],
      hasBackup: false,
    },
  ];

  it("reports FAIL when the gateway is down", () => {
    const findings = runDoctorDiagnostics({
      inventory: emptyInventory,
      gatewayAlive: false,
      gatewayPort: null,
      env: {},
      opencodePluginInstalled: false,
    });
    const reachability = findings.find((f) => f.label === "gateway reachable");
    expect(reachability?.level).toBe("FAIL");
    expect(reachability?.remediation).toContain("lore start --bg");
  });

  it("reports PASS when the gateway is up", () => {
    const findings = runDoctorDiagnostics({
      inventory: emptyInventory,
      gatewayAlive: true,
      gatewayPort: 3207,
      env: {},
      opencodePluginInstalled: false,
    });
    const reachability = findings.find((f) => f.label === "gateway reachable");
    expect(reachability?.level).toBe("PASS");
  });

  it("warns on a shell-env ANTHROPIC_BASE_URL override", () => {
    const findings = runDoctorDiagnostics({
      inventory: emptyInventory,
      gatewayAlive: true,
      gatewayPort: 3207,
      env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" },
      opencodePluginInstalled: false,
    });
    const env = findings.find((f) =>
      f.label.includes("ANTHROPIC_BASE_URL in shell env"),
    );
    expect(env?.level).toBe("WARN");
  });

  it("fails on a Bedrock conflict", () => {
    const findings = runDoctorDiagnostics({
      inventory: emptyInventory,
      gatewayAlive: true,
      gatewayPort: 3207,
      env: { CLAUDE_CODE_USE_BEDROCK: "1" },
      opencodePluginInstalled: false,
    });
    const bedrock = findings.find((f) => f.label === "Bedrock/Vertex conflict");
    expect(bedrock?.level).toBe("FAIL");
  });

  it("warns on a port mismatch between setup and the running gateway", () => {
    const inventory = [
      {
        app: "Claude Code",
        file: "/x/.claude/settings.json",
        fileExists: true,
        hasBackup: false,
        rows: [
          {
            app: "Claude Code",
            file: "/x/.claude/settings.json",
            fileExists: true,
            key: "env.ANTHROPIC_BASE_URL",
            routing: {
              kind: "lore" as const,
              value: "http://127.0.0.1:5673/v1",
            },
          },
        ],
      },
    ];
    const findings = runDoctorDiagnostics({
      inventory,
      gatewayAlive: true,
      gatewayPort: 3207,
      env: {},
      opencodePluginInstalled: false,
    });
    const mismatch = findings.find((f) => f.label.startsWith("port mismatch"));
    expect(mismatch?.level).toBe("WARN");
  });

  it("does NOT flag the OpenCode plugin row as a port mismatch (non-URL value)", () => {
    // The plugin row has routing.value = "@loreai/opencode" (kind: lore), which
    // is not a URL and must not trigger the port-consistency check (Seer #892).
    const inventory = [
      {
        app: "OpenCode",
        file: "/x/.config/opencode/opencode.json",
        fileExists: true,
        hasBackup: false,
        rows: [
          {
            app: "OpenCode",
            file: "/x/.config/opencode/opencode.json",
            fileExists: true,
            key: "plugin[@loreai/opencode]",
            routing: { kind: "lore" as const, value: "@loreai/opencode" },
          },
        ],
      },
    ];
    const findings = runDoctorDiagnostics({
      inventory,
      gatewayAlive: true,
      gatewayPort: 3207,
      env: {},
      opencodePluginInstalled: true,
    });
    const mismatch = findings.find((f) => f.label.startsWith("port mismatch"));
    expect(mismatch).toBeUndefined();
    // And no misleading PASS when zero URLs were checked.
    const pass = findings.find((f) => f.label === "port consistency");
    expect(pass).toBeUndefined();
  });

  it("does NOT flag a remote gateway URL as a port mismatch", () => {
    const inventory = [
      {
        app: "Claude Code",
        file: "/x/.claude/settings.json",
        fileExists: true,
        hasBackup: false,
        rows: [
          {
            app: "Claude Code",
            file: "/x/.claude/settings.json",
            fileExists: true,
            key: "env.ANTHROPIC_BASE_URL",
            routing: {
              kind: "lore" as const,
              value: "http://remote:3207/v1",
            },
          },
        ],
      },
    ];
    const findings = runDoctorDiagnostics({
      inventory,
      gatewayAlive: true,
      gatewayPort: 3207,
      env: {},
      opencodePluginInstalled: false,
    });
    const mismatch = findings.find((f) => f.label.startsWith("port mismatch"));
    expect(mismatch).toBeUndefined();
  });

  it("warns when the OpenCode plugin is registered but not installed", () => {
    const inventory = [
      {
        app: "OpenCode",
        file: "/x/.config/opencode/opencode.json",
        fileExists: true,
        hasBackup: false,
        rows: [
          {
            app: "OpenCode",
            file: "/x/.config/opencode/opencode.json",
            fileExists: true,
            key: "plugin[@loreai/opencode]",
            routing: { kind: "lore" as const, value: "@loreai/opencode" },
          },
        ],
      },
    ];
    const findings = runDoctorDiagnostics({
      inventory,
      gatewayAlive: true,
      gatewayPort: 3207,
      env: {},
      opencodePluginInstalled: false,
    });
    const plugin = findings.find((f) => f.label.startsWith("OpenCode plugin"));
    expect(plugin?.level).toBe("WARN");
  });
});

describe("formatFinding", () => {
  it("renders PASS/WARN/FAIL with remediation on a new line", () => {
    const f: Finding = {
      level: "FAIL",
      label: "gateway reachable",
      detail: "no gateway responding",
      remediation: "run `lore start --bg`",
    };
    const text = formatFinding(f);
    expect(text).toContain("[FAIL]");
    expect(text).toContain("gateway reachable");
    expect(text).toContain("run `lore start --bg`");
  });
});

describe("collectInventory (integration)", () => {
  it("returns all-four-apps inventory with missing files on a clean HOME", () => {
    const all = collectInventory();
    expect(all).toHaveLength(4);
    expect(all.map((i) => i.app)).toEqual([
      "Claude Code",
      "Codex",
      "OpenCode",
      "Pi",
    ]);
    for (const inv of all) {
      expect(inv.fileExists).toBe(false);
      expect(inv.rows).toEqual([]);
      expect(inv.hasBackup).toBe(false);
    }
  });

  it("collects lore-routed values after setup", async () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({
        env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" },
      }),
    );
    await commandSetup(["claude-code"], { port: 3299 });

    const all = collectInventory();
    const cc = all.find((i) => i.app === "Claude Code")!;
    expect(cc.fileExists).toBe(true);
    expect(cc.hasBackup).toBe(true);
    const urlRow = cc.rows.find((r) => r.key === "env.ANTHROPIC_BASE_URL")!;
    expect(urlRow.routing.kind).toBe("lore");
    expect(urlRow.routing).toEqual({
      kind: "lore",
      value: "http://127.0.0.1:3299",
    });
  });

  it("collects Codex TOML inventory after setup", async () => {
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(
      join(home, ".codex", "config.toml"),
      'openai_base_url = "https://api.openai.com/v1"\n',
    );
    await commandSetup(["codex"], { port: 3299 });

    const all = collectInventory();
    const codex = all.find((i) => i.app === "Codex")!;
    expect(codex.fileExists).toBe(true);
    expect(codex.hasBackup).toBe(true);
    const urlRow = codex.rows.find((r) => r.key === "openai_base_url")!;
    expect(urlRow.routing.kind).toBe("lore");
  });
});

describe("commandDoctor (integration)", () => {
  it("runs without throwing on a clean HOME (no gateway)", async () => {
    await expect(commandDoctor()).resolves.toBeUndefined();
    const out = logged();
    expect(out).toContain("lore version");
    expect(out).toContain("gateway reachable");
  });

  it("prints the inventory before the diagnostics", async () => {
    await commandDoctor();
    const out = logged();
    const invIdx = out.indexOf("Setup inventory:");
    const diagIdx = out.indexOf("Diagnostics:");
    expect(invIdx).toBeGreaterThanOrEqual(0);
    expect(diagIdx).toBeGreaterThan(invIdx);
  });
});
