import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type MockInstance,
} from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandSetup } from "../src/cli/setup";
import { writePortFile } from "../src/portfile";

// Integration coverage for the setup.ts IO surface (backup capture on setup,
// `lore setup undo`, liveness reporting, port detection). Everything is scoped
// to a throwaway HOME / XDG_DATA_HOME so we never touch the real config or the
// running gateway. No gateway is listening on the test port, so the liveness
// probe always reports "not reachable" — which is what we want to exercise.

let home: string;
let origHome: string | undefined;
let origXdg: string | undefined;
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
  home = mkdtempSync(join(tmpdir(), "lore-setup-io-"));
  process.env.HOME = home;
  process.env.XDG_DATA_HOME = join(home, "data");
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
  rmSync(home, { recursive: true, force: true });
});

describe("commandSetup — Claude Code", () => {
  const claudePath = () => join(home, ".claude", "settings.json");

  it("configures, writes a backup, warns when the gateway is down, then undoes", async () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      claudePath(),
      JSON.stringify({
        env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" },
      }),
    );

    await commandSetup(["claude-code"], { port: 3299 });

    const cfg = JSON.parse(readFileSync(claudePath(), "utf8"));
    expect(cfg.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:3299");
    expect(cfg.env.DISABLE_AUTO_COMPACT).toBe("1");
    expect(cfg._loreBackup).toBeDefined();
    // Liveness probe failed (no gateway) → WARN with remediation.
    expect(logged()).toContain("not reachable");
    expect(logged()).toContain("lore start --bg");

    await commandSetup(["undo", "claude-code"], {});

    const restored = JSON.parse(readFileSync(claudePath(), "utf8"));
    expect(restored.env.ANTHROPIC_BASE_URL).toBe("https://api.anthropic.com");
    expect(restored.env.DISABLE_AUTO_COMPACT).toBeUndefined();
    expect(restored._loreBackup).toBeUndefined();
  });

  it("detects the live gateway port from the port file (falls back when down)", async () => {
    // Seed a port file; the probe will fail (nothing listening) so setup falls
    // back to the default port. Exercises detectLiveGatewayPort's probe path.
    writePortFile(5673);
    await commandSetup(["claude-code"], {});
    const cfg = JSON.parse(readFileSync(claudePath(), "utf8"));
    expect(cfg.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:3207");
  });
});

describe("commandSetup — Codex", () => {
  const codexPath = () => join(home, ".codex", "config.toml");

  it("configures with an inline backup block and undoes it", async () => {
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(
      codexPath(),
      'openai_base_url = "https://api.openai.com/v1"\n',
    );

    await commandSetup(["codex"], { port: 3299 });

    let toml = readFileSync(codexPath(), "utf8");
    expect(toml).toContain("lore setup backup");
    expect(toml).toContain('openai_base_url = "http://127.0.0.1:3299/v1"');

    await commandSetup(["undo", "codex"], {});

    toml = readFileSync(codexPath(), "utf8");
    expect(toml).toContain('openai_base_url = "https://api.openai.com/v1"');
    expect(toml).not.toContain("lore setup backup");
  });
});

describe("commandSetup — OpenCode", () => {
  const ocPath = () => join(home, ".config", "opencode", "opencode.json");

  it("configures providers (no plugin) with a backup and undoes it", async () => {
    await commandSetup(["opencode"], { port: 3299, noPlugin: true });

    const cfg = JSON.parse(readFileSync(ocPath(), "utf8"));
    expect(cfg.provider.anthropic.options.baseURL).toBe(
      "http://127.0.0.1:3299/v1",
    );
    expect(cfg.compaction).toEqual({ auto: false });
    expect(cfg._loreBackup).toBeDefined();

    await commandSetup(["undo", "opencode"], {});

    const restored = JSON.parse(readFileSync(ocPath(), "utf8"));
    // Provider baseURLs + compaction were lore-set on an empty config → undo
    // removes them entirely (prunes emptied objects).
    expect(restored.provider).toBeUndefined();
    expect(restored.compaction).toBeUndefined();
    expect(restored._loreBackup).toBeUndefined();
  });

  it("does NOT remove a plugin lore never added (Seer #876)", async () => {
    // --no-plugin means lore does not add @loreai/opencode, so pluginAdded is
    // false in the backup. If the user adds it themselves afterwards, undo must
    // leave it alone.
    await commandSetup(["opencode"], { port: 3299, noPlugin: true });
    const cfg = JSON.parse(readFileSync(ocPath(), "utf8"));
    expect(cfg._loreBackup.pluginAdded).toBe(false);

    // User manually adds the plugin after setup.
    cfg.plugin = ["@loreai/opencode"];
    writeFileSync(ocPath(), JSON.stringify(cfg, null, 2));

    await commandSetup(["undo", "opencode"], {});

    const restored = JSON.parse(readFileSync(ocPath(), "utf8"));
    expect(restored.plugin).toEqual(["@loreai/opencode"]); // preserved
  });
});

describe("commandSetup — undo with nothing to restore", () => {
  it("reports nothing to undo across all apps", async () => {
    await commandSetup(["undo"], {});
    expect(logged()).toContain("No lore setup backups found");
  });

  it("reports nothing to undo for a single named app", async () => {
    await commandSetup(["undo", "claude-code"], {});
    expect(logged().toLowerCase()).toContain("no lore backup");
  });

  it("rejects an unknown app", async () => {
    await commandSetup(["undo", "bogus"], {});
    expect(logged()).toContain('Unknown app "bogus"');
    expect(process.exitCode).toBe(1);
    process.exitCode = 0; // reset for the runner
  });
});

describe("commandSetup — argument handling", () => {
  it("rejects an unknown app for setup", async () => {
    await commandSetup(["bogus"], { port: 3299 });
    expect(logged()).toContain('Unknown app "bogus"');
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it("auto-detects installed apps (or reports none) without throwing", async () => {
    // Environment-dependent: on a box with claude/codex/opencode on PATH this
    // exercises the auto-detect loop + liveness report; on a clean CI box it
    // hits the "no supported apps detected" branch. Either way it must not throw.
    await expect(
      commandSetup([], { port: 3299, noPlugin: true }),
    ).resolves.toBeUndefined();
    process.exitCode = 0;
  });
});
