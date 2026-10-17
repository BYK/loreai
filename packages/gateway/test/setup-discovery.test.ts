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
import * as fs from "node:fs";
import { join } from "node:path";
import { commandSetup } from "../src/cli/setup";
import { detectAgents } from "../src/cli/agents";

vi.mock("node:os", { spy: true });
vi.mock("node:fs", { spy: true });

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

  it("reports an unreadable optional app and discovers the next desktop candidate", async () => {
    vi.mocked(os.platform).mockReturnValue("darwin");
    const denied = join(home, "Applications", "Codex.app");
    const available = join(home, "Applications", "ChatGPT.app");
    mkdirSync(join(available, "Contents", "Resources", "codex-cli"), {
      recursive: true,
    });
    writeFileSync(join(available, "Contents", "Info.plist"), "fixture");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.spyOn(fs, "lstatSync").mockImplementation((...args) => {
      if (String(args[0]) === join(denied, "Contents")) {
        throw Object.assign(new Error("denied optional app"), {
          code: "EACCES",
        });
      }
      return Reflect.apply(actualFs.lstatSync, actualFs, args);
    });
    await setup();
    expect(existsSync(configPath())).toBe(true);
    expect(output.join("\n")).toContain(denied);
    expect(output.join("\n")).toContain("EACCES");
    expect(output.join("\n")).toContain(available);
  });

  it.skipIf(process.platform === "win32")(
    "configures another agent despite an optional desktop symlink loop",
    async () => {
      vi.mocked(os.platform).mockReturnValue("darwin");
      symlinkSync("Applications", join(home, "Applications"));
      writeFileSync(join(home, "claude"), "#!/bin/sh\nexit 0\n", {
        mode: 0o755,
      });
      await setup();
      const claudeConfig = JSON.parse(
        readFileSync(join(home, ".claude", "settings.json"), "utf8"),
      );
      expect(claudeConfig.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:3299");
      expect(output.join("\n")).toContain("ELOOP");
      expect(output.join("\n")).toContain("Could not inspect");
      expect(process.exitCode ?? 0).toBe(0);
    },
  );

  it
    .skipIf(process.platform === "win32")
    .each(["directory", "symlinked parent", "different owner"])(
    "skips a Codex config with %s and configures another agent",
    async (kind) => {
      vi.mocked(os.platform).mockReturnValue("darwin");
      // Desktop evidence must not reselect Codex after its config is rejected.
      const appPath = join(home, "Applications", "Codex.app", "Contents");
      mkdirSync(appPath, { recursive: true });
      writeFileSync(join(appPath, "Info.plist"), "fixture");
      if (kind === "directory") {
        mkdirSync(configPath(), { recursive: true });
      } else if (kind === "symlinked parent") {
        const target = join(home, "managed-codex");
        mkdirSync(target);
        writeFileSync(join(target, "config.toml"), 'model = "untouched"\n');
        symlinkSync(target, join(home, ".codex"));
      } else {
        mkdirSync(join(home, ".codex"));
        writeFileSync(configPath(), 'model = "untouched"\n');
        const unownedParent = join(home, ".codex");
        const actualFs =
          await vi.importActual<typeof import("node:fs")>("node:fs");
        vi.spyOn(fs, "lstatSync").mockImplementation((...args) => {
          const stat = Reflect.apply(actualFs.lstatSync, actualFs, args);
          if (stat && String(args[0]) === unownedParent) {
            return Object.assign(stat, {
              uid: typeof stat.uid === "bigint" ? stat.uid + 1n : stat.uid + 1,
            });
          }
          return stat;
        });
      }
      writeFileSync(join(home, "claude"), "#!/bin/sh\nexit 0\n", {
        mode: 0o755,
      });
      await setup();
      const claude = JSON.parse(
        readFileSync(join(home, ".claude", "settings.json"), "utf8"),
      );
      expect(claude.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:3299");
      const text = output.join("\n");
      expect(text).toContain("Skipped Codex: could not safely inspect config");
      expect(text).toContain(configPath());
      expect(text).toContain("lore setup codex");
      expect(text).not.toContain("Codex configured");
      expect(text).not.toContain("Detected Codex");
      expect(existsSync(`${configPath()}.lore-backup`)).toBe(false);
      if (kind !== "directory") {
        expect(readFileSync(configPath(), "utf8")).toBe(
          'model = "untouched"\n',
        );
      }
      expect(process.exitCode ?? 0).toBe(0);
    },
  );

  it("reports an unsafe Codex config and fails when there are no viable targets", async () => {
    mkdirSync(configPath(), { recursive: true });
    await setup();
    expect(output.join("\n")).toContain(
      "Skipped Codex: could not safely inspect config",
    );
    expect(output.join("\n")).toContain("No supported apps detected");
    expect(process.exitCode).toBe(1);
    expect(fs.lstatSync(configPath()).isDirectory()).toBe(true);
  });

  it("still rejects unsafe config paths for explicit Codex setup", async () => {
    mkdirSync(configPath(), { recursive: true });
    await expect(
      commandSetup(["codex"], { port: 3299, noPlugin: true }),
    ).rejects.toThrow("expected a regular file");
    expect(fs.lstatSync(configPath()).isDirectory()).toBe(true);
    expect(output.join("\n")).not.toContain("Codex configured");
  });

  it
    .skipIf(process.platform === "win32")
    .each([
      ['api_key = "secret-do-not-print\n'],
      ['[model_providers.lore_http]\nenv_key = "secret-do-not-print"\n'],
      ['profile = "custom"\n[profiles.custom]\nmodel_provider = "custom"\n'],
      ["# end lore setup backup\n"],
    ])(
    "skips unconfigurable Codex content and configures another agent (%#)",
    async (content) => {
      mkdirSync(join(home, ".codex"));
      writeFileSync(configPath(), content);
      writeFileSync(join(home, "claude"), "#!/bin/sh\nexit 0\n", {
        mode: 0o755,
      });
      await setup();
      const claude = JSON.parse(
        readFileSync(join(home, ".claude", "settings.json"), "utf8"),
      );
      expect(claude.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:3299");
      expect(readFileSync(configPath(), "utf8")).toBe(content);
      const text = output.join("\n");
      expect(text).toContain("Skipped Codex:");
      expect(text).toContain("invalid or conflicting config");
      expect(text).toContain("lore setup codex");
      expect(text).not.toContain("secret-do-not-print");
      expect(text).not.toContain("Codex configured");
      expect(process.exitCode ?? 0).toBe(0);
    },
  );

  it.skipIf(process.platform === "win32").each([
    ["lstatSync", "EIO"],
    ["openSync", "EACCES"],
  ] as const)(
    "reports %s config errors without leaking exception details",
    async (operation, code) => {
      mkdirSync(join(home, ".codex"));
      writeFileSync(configPath(), 'model = "untouched"\n');
      const deniedConfig = configPath();
      const actualFs =
        await vi.importActual<typeof import("node:fs")>("node:fs");
      vi.spyOn(fs, operation).mockImplementation((...args: unknown[]) => {
        if (String(args[0]) === deniedConfig) {
          throw Object.assign(new Error("secret-do-not-print"), { code });
        }
        return Reflect.apply(actualFs[operation], actualFs, args);
      });
      writeFileSync(join(home, "claude"), "#!/bin/sh\nexit 0\n", {
        mode: 0o755,
      });
      await setup();
      expect(output.join("\n")).toContain("Claude Code configured");
      expect(output.join("\n")).toContain("Skipped Codex:");
      expect(output.join("\n")).toContain(code);
      expect(output.join("\n")).not.toContain("secret-do-not-print");
      expect(process.exitCode ?? 0).toBe(0);
    },
  );
});
