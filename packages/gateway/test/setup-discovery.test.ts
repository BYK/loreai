import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { commandSetup } from "../src/cli/setup";
import { detectAgents } from "../src/cli/agents";

vi.mock("node:os", { spy: true });

let home: string;
let output: string[];

beforeEach(() => {
  home = mkdtempSync(join(realpathSync(os.tmpdir()), "lore-setup-discovery-"));
  vi.spyOn(os, "homedir").mockReturnValue(home);
  vi.spyOn(os, "platform").mockReturnValue("linux");
  vi.stubEnv("XDG_DATA_HOME", join(home, "data"));
  vi.stubEnv("PATH", home);
  output = [];
  vi.spyOn(console, "log").mockImplementation((...args) =>
    output.push(args.join(" ")),
  );
  vi.spyOn(console, "error").mockImplementation((...args) =>
    output.push(args.join(" ")),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = 0;
  rmSync(home, { recursive: true, force: true });
});

const configPath = () => join(home, ".codex", "config.toml");
const setup = () => commandSetup([], { port: 3299, noPlugin: true });

describe("automatic setup discovery", () => {
  it.each(["darwin", "win32", "linux"] as const)(
    "configures an existing Codex config without a PATH executable on %s",
    async (platform) => {
      vi.mocked(os.platform).mockReturnValue(platform);
      mkdirSync(join(home, ".codex"));
      writeFileSync(configPath(), 'model = "existing-model"\n');
      await setup();
      const config = readFileSync(configPath(), "utf8");
      expect(config).toContain('openai_base_url = "http://127.0.0.1:3299/v1"');
      expect(config).toContain('model = "existing-model"');
      expect(config).toContain('model_provider = "lore_http"');
      expect(output.join("\n")).toContain(configPath());
      expect(process.exitCode ?? 0).toBe(0);
    },
  );

  it.each([
    ["Codex.app", "Contents"],
    ["ChatGPT.app", "Contents/Resources/codex-cli"],
  ])(
    "configures a fresh desktop installation in %s without a CLI",
    async (app, marker) => {
      vi.mocked(os.platform).mockReturnValue("darwin");
      const appPath = join(home, "Applications", app);
      mkdirSync(join(appPath, marker), { recursive: true });
      writeFileSync(join(appPath, "Contents", "Info.plist"), "fixture");
      await setup();
      expect(existsSync(configPath())).toBe(true);
      expect(readFileSync(configPath(), "utf8")).toContain(
        'model_provider = "lore_http"',
      );
      expect(output.join("\n")).toContain(appPath);
      expect(detectAgents().some((agent) => agent.def.name === "codex")).toBe(
        false,
      );
      expect(process.exitCode ?? 0).toBe(0);
    },
  );

  it("reports every skipped agent with an explicit setup command when none are found", async () => {
    await setup();
    const text = output.join("\n");
    for (const [name, command] of [
      ["Codex", "codex"],
      ["OpenCode", "opencode"],
      ["Claude Code", "claude-code"],
      ["Hermes Agent", "hermes"],
      ["Pi", "pi"],
      ["GitHub Copilot CLI", "copilot"],
      ["Gemini CLI", "gemini"],
    ]) {
      expect(text).toContain(`Skipped ${name}:`);
      expect(text).toContain(`lore setup ${command}`);
    }
    expect(text).toContain("not found on PATH");
    expect(process.exitCode).toBe(1);
    expect(existsSync(configPath())).toBe(false);
  });

  it("reports skipped agents when another target is configured successfully", async () => {
    mkdirSync(join(home, ".codex"));
    writeFileSync(configPath(), "");
    await setup();
    const text = output.join("\n");
    expect(text).toContain("Codex configured");
    expect(text).not.toContain("Skipped Codex:");
    expect(text).toContain("Skipped OpenCode:");
    expect(text).toContain("lore setup opencode");
  });

  it.skipIf(process.platform === "win32")(
    "continues to configure a CLI-only Codex installation",
    async () => {
      writeFileSync(join(home, "codex"), "#!/bin/sh\nexit 0\n", {
        mode: 0o755,
      });
      await setup();
      expect(existsSync(configPath())).toBe(true);
      expect(output.join("\n")).toContain("Codex configured");
      expect(output.join("\n")).not.toContain("without a CLI on PATH");
    },
  );

  it("does not treat an empty Codex directory as an installed client", async () => {
    mkdirSync(join(home, ".codex"));
    await setup();
    expect(existsSync(configPath())).toBe(false);
    expect(output.join("\n")).toContain("Skipped Codex:");
  });

  it.skipIf(process.platform === "win32")(
    "discovers a trusted symlinked Codex config and preserves its link",
    async () => {
      mkdirSync(join(home, ".codex"));
      const managed = join(home, "managed-codex.toml");
      writeFileSync(managed, 'model = "dotfile-model"\n');
      symlinkSync(managed, configPath());
      await setup();
      expect(readFileSync(managed, "utf8")).toContain(
        'model_provider = "lore_http"',
      );
      expect(realpathSync(configPath())).toBe(managed);
      expect(output.join("\n")).not.toContain("Skipped Codex:");
    },
  );
});
