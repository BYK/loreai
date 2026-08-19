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
  existsSync,
  chmodSync,
  lstatSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { commandSetup, loadJsonSetupBackup } from "../src/cli/setup";
import { writePortFile } from "../src/portfile";
import {
  readGatewayProcessFile,
  removePidFile,
  writeGatewayProcessFile,
} from "../src/pidfile";

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

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function authenticatedGateway(token: string): Promise<Server> {
  return await new Promise((resolve) => {
    const server = createServer((request, response) => {
      if (
        request.url === "/_lore/control" &&
        request.headers.authorization === `Bearer ${token}`
      ) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ status: "ok", service: "lore", pid: process.pid }),
        );
        return;
      }
      response.writeHead(404);
      response.end();
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

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
    // Backup lives in a sidecar file, NOT inside the config.
    expect(cfg._loreBackup).toBeUndefined();
    expect(existsSync(`${claudePath()}.lore-backup`)).toBe(true);
    // Liveness probe failed (no gateway) → WARN with remediation.
    expect(logged()).toContain("not reachable");
    expect(logged()).toContain("lore start --bg");

    await commandSetup(["undo", "claude-code"], {});

    const restored = JSON.parse(readFileSync(claudePath(), "utf8"));
    expect(restored.env.ANTHROPIC_BASE_URL).toBe("https://api.anthropic.com");
    expect(restored.env.DISABLE_AUTO_COMPACT).toBeUndefined();
    expect(restored._loreBackup).toBeUndefined();
    // Sidecar consumed once everything was reverted.
    expect(existsSync(`${claudePath()}.lore-backup`)).toBe(false);
  });

  it("ignores an unauthenticated stale port file", async () => {
    writePortFile(5673);
    await commandSetup(["claude-code"], {});
    const cfg = JSON.parse(readFileSync(claudePath(), "utf8"));
    expect(cfg.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:3207");
  });

  it("selects and reports an authenticated process-record port", async () => {
    const token = "setup-authenticated-token".repeat(2);
    const server = await authenticatedGateway(token);
    const port = (server.address() as { port: number }).port;
    writeGatewayProcessFile({
      version: 2,
      pid: process.pid,
      port,
      hosts: ["127.0.0.1"],
      token,
      processIdentity: "test:setup-authenticated",
    });
    try {
      await commandSetup(["claude-code"], {});
      const cfg = JSON.parse(readFileSync(claudePath(), "utf8"));
      expect(cfg.env.ANTHROPIC_BASE_URL).toBe(`http://127.0.0.1:${port}`);
      expect(logged()).toContain(
        `Gateway is reachable at http://127.0.0.1:${port}`,
      );
    } finally {
      removePidFile(process.pid);
      await closeServer(server);
    }
  });

  it("does not trust a listener that only spoofs public health", async () => {
    const server = await new Promise<Server>((resolve) => {
      const listener = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"status":"ok"}');
      });
      listener.listen(0, "127.0.0.1", () => resolve(listener));
    });
    const port = (server.address() as { port: number }).port;
    try {
      expect(readGatewayProcessFile()).toBeNull();
      await commandSetup(["claude-code"], { port });
      expect(logged()).toContain(
        `Gateway is not reachable at http://127.0.0.1:${port}`,
      );
      expect(logged()).not.toContain("Gateway is reachable at");
    } finally {
      await closeServer(server);
    }
  });

  it("restores absence after first setup created the JSON config", async () => {
    await commandSetup(["claude-code"], { port: 3299 });
    await commandSetup(["undo", "claude-code"], {});
    expect(existsSync(claudePath())).toBe(false);
    expect(existsSync(`${claudePath()}.lore-backup`)).toBe(false);
  });

  it("fails closed on a deleted and recreated matching config generation", async () => {
    await commandSetup(["claude-code"], { port: 3299 });
    const configured = readFileSync(claudePath(), "utf8");
    rmSync(claudePath());
    writeFileSync(claudePath(), configured);

    await expect(commandSetup(["undo", "claude-code"], {})).rejects.toThrow(
      "config generation",
    );
    expect(readFileSync(claudePath(), "utf8")).toBe(configured);
    expect(existsSync(`${claudePath()}.lore-backup`)).toBe(true);
  });

  it("rejects a symlinked config without overwriting its target", async () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    const target = join(home, "claude-target.json");
    writeFileSync(target, '{"secret":"untouched"}\n');
    symlinkSync(target, claudePath());

    await expect(commandSetup(["claude-code"], { port: 3299 })).rejects.toThrow(
      "symbolic links are not allowed",
    );
    expect(readFileSync(target, "utf8")).toBe('{"secret":"untouched"}\n');
  });

  it("preserves config mode and creates a private sidecar", async () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(claudePath(), "{}\n");
    chmodSync(claudePath(), 0o640);
    await commandSetup(["claude-code"], { port: 3299 });
    expect(lstatSync(claudePath()).mode & 0o777).toBe(0o640);
    expect(lstatSync(`${claudePath()}.lore-backup`).mode & 0o777).toBe(0o600);
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
    // The config must NOT carry a `_loreBackup` key — OpenCode's schema is
    // `additionalProperties: false` and rejects unknown keys (Sergiy report).
    expect(cfg._loreBackup).toBeUndefined();
    expect(Object.keys(cfg)).not.toContain("_loreBackup");
    expect(existsSync(`${ocPath()}.lore-backup`)).toBe(true);

    await commandSetup(["undo", "opencode"], {});

    // Setup created this file from absence, so undo restores absence.
    expect(existsSync(ocPath())).toBe(false);
    expect(existsSync(`${ocPath()}.lore-backup`)).toBe(false);
  });

  it("restores absence after first setup created the OpenCode config", async () => {
    await commandSetup(["opencode"], { port: 3299, noPlugin: true });
    await commandSetup(["undo", "opencode"], {});
    expect(existsSync(ocPath())).toBe(false);
  });

  it("restores overwritten provider and plugin containers exactly", async () => {
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    writeFileSync(
      ocPath(),
      '{"provider":["custom"],"plugin":"manual","compaction":null}\n',
    );
    await commandSetup(["opencode"], { port: 3299, noPlugin: true });
    await commandSetup(["undo", "opencode"], {});
    expect(JSON.parse(readFileSync(ocPath(), "utf8"))).toEqual({
      provider: ["custom"],
      plugin: "manual",
      compaction: null,
    });
  });

  it("edits and undoes active JSONC without dropping comments", async () => {
    const jsoncPath = join(home, ".config", "opencode", "opencode.jsonc");
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    writeFileSync(
      jsoncPath,
      `{
  // Keep this user comment.
  "theme": "tokyonight",
}\n`,
    );

    await commandSetup(["opencode"], { port: 3299, "no-plugin": true });
    expect(readFileSync(jsoncPath, "utf8")).toContain("Keep this user comment");
    await commandSetup(["undo", "opencode"], {});
    const restored = readFileSync(jsoncPath, "utf8");
    expect(restored).toContain("Keep this user comment");
    expect(restored).not.toContain("baseURL");
    expect(restored).not.toContain('"provider"');
  });

  it("does NOT remove a plugin lore never added (Seer #876)", async () => {
    // --no-plugin means lore does not add @loreai/opencode, so pluginAdded is
    // false in the backup. If the user adds it themselves afterwards, undo must
    // leave it alone.
    await commandSetup(["opencode"], { port: 3299, noPlugin: true });
    const backup = JSON.parse(readFileSync(`${ocPath()}.lore-backup`, "utf8"));
    expect(backup.pluginAdded).toBe(false);

    // User manually adds the plugin after setup.
    const cfg = JSON.parse(readFileSync(ocPath(), "utf8"));
    cfg.plugin = ["@loreai/opencode"];
    writeFileSync(ocPath(), JSON.stringify(cfg, null, 2));

    await commandSetup(["undo", "opencode"], {});

    const restored = JSON.parse(readFileSync(ocPath(), "utf8"));
    expect(restored.plugin).toEqual(["@loreai/opencode"]); // preserved
  });

  it("migrates a legacy in-config _loreBackup out of opencode.json (Sergiy report)", async () => {
    // Reproduce an install written by older lore: routing values PLUS the
    // illegal top-level `_loreBackup` key that newer OpenCode rejects with
    // "unknown field _loreBackup". Use port 3207 so the recorded lore-set
    // value matches what this setup run writes (revert-only-if-unchanged).
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    writeFileSync(
      ocPath(),
      JSON.stringify(
        {
          provider: {
            anthropic: { options: { baseURL: "http://127.0.0.1:3207/v1" } },
          },
          compaction: { auto: false },
          _loreBackup: {
            version: 1,
            savedAt: "2026-01-01T00:00:00.000Z",
            entries: [
              { path: "compaction.auto", loreValue: false, hadPrior: false },
              {
                path: "provider.anthropic.options.baseURL",
                loreValue: "http://127.0.0.1:3207/v1",
                hadPrior: true,
                priorValue: "https://api.anthropic.com",
              },
            ],
            pluginAdded: false,
          },
        },
        null,
        2,
      ),
    );

    await commandSetup(["opencode"], { port: 3207, noPlugin: true });

    // The illegal key is stripped → config is schema-valid for OpenCode again.
    const cfg = JSON.parse(readFileSync(ocPath(), "utf8"));
    expect(cfg._loreBackup).toBeUndefined();
    // The TRUE original was migrated to the sidecar (not overwritten by the
    // fresh capture, which would have recorded lore's own value as the prior).
    const migrated = JSON.parse(
      readFileSync(`${ocPath()}.lore-backup`, "utf8"),
    );
    const entry = migrated.entries.find(
      (e: { path: string }) => e.path === "provider.anthropic.options.baseURL",
    );
    expect(entry.priorValue).toBe("https://api.anthropic.com");

    // Undo restores the true original and removes the sidecar.
    await commandSetup(["undo", "opencode"], {});
    const restored = JSON.parse(readFileSync(ocPath(), "utf8"));
    expect(restored.provider.anthropic.options.baseURL).toBe(
      "https://api.anthropic.com",
    );
    expect(restored._loreBackup).toBeUndefined();
    expect(existsSync(`${ocPath()}.lore-backup`)).toBe(false);
  });

  it("undo restores directly from a legacy in-config _loreBackup (no sidecar)", async () => {
    // An install written by older lore that has NOT been re-run through setup:
    // the backup still lives in the config, there is no sidecar. Undo must
    // restore from it and strip the schema-invalid key.
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    writeFileSync(
      ocPath(),
      JSON.stringify(
        {
          provider: {
            anthropic: { options: { baseURL: "http://127.0.0.1:3207/v1" } },
          },
          compaction: { auto: false },
          _loreBackup: {
            version: 1,
            savedAt: "2026-01-01T00:00:00.000Z",
            entries: [
              { path: "compaction.auto", loreValue: false, hadPrior: false },
              {
                path: "provider.anthropic.options.baseURL",
                loreValue: "http://127.0.0.1:3207/v1",
                hadPrior: true,
                priorValue: "https://api.anthropic.com",
              },
            ],
            pluginAdded: false,
          },
        },
        null,
        2,
      ),
    );

    await commandSetup(["undo", "opencode"], {});

    const restored = JSON.parse(readFileSync(ocPath(), "utf8"));
    expect(restored.provider.anthropic.options.baseURL).toBe(
      "https://api.anthropic.com",
    );
    expect(restored._loreBackup).toBeUndefined();
    // No sidecar was ever created for a legacy-only install.
    expect(existsSync(`${ocPath()}.lore-backup`)).toBe(false);
  });

  it("fails closed on a corrupt sidecar before setup overwrites config", async () => {
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    writeFileSync(ocPath(), JSON.stringify({ provider: {} }, null, 2));
    writeFileSync(`${ocPath()}.lore-backup`, "{ not valid json");

    const original = readFileSync(ocPath(), "utf8");
    await expect(
      commandSetup(["opencode"], { port: 3399, noPlugin: true }),
    ).rejects.toThrow("Invalid Lore setup backup");
    expect(readFileSync(ocPath(), "utf8")).toBe(original);
  });

  it("loadJsonSetupBackup returns null for an unreadable sidecar (never throws)", () => {
    // A sidecar that exists but can't be read (permissions, or — as simulated
    // here deterministically — the path is a directory → EISDIR) must be
    // treated as "no backup", not crash read-only callers like `lore doctor`
    // (Seer[bot] r3566840253).
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    mkdirSync(`${ocPath()}.lore-backup`, { recursive: true });
    expect(loadJsonSetupBackup(ocPath())).toBeNull();
  });

  it("undo fails closed on an unreadable sidecar", async () => {
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    writeFileSync(ocPath(), JSON.stringify({ provider: {} }, null, 2));
    mkdirSync(`${ocPath()}.lore-backup`, { recursive: true });

    await expect(commandSetup(["undo", "opencode"], {})).rejects.toThrow(
      "Could not read Lore setup backup",
    );
  });

  it("re-running setup never overwrites the TRUE original backup", async () => {
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    writeFileSync(
      ocPath(),
      JSON.stringify(
        {
          provider: {
            anthropic: { options: { baseURL: "https://api.anthropic.com" } },
          },
        },
        null,
        2,
      ),
    );

    await commandSetup(["opencode"], { port: 3299, noPlugin: true });
    const first = JSON.parse(readFileSync(`${ocPath()}.lore-backup`, "utf8"));
    const firstEntry = first.entries.find(
      (e: { path: string }) => e.path === "provider.anthropic.options.baseURL",
    );
    expect(firstEntry.priorValue).toBe("https://api.anthropic.com");

    // Second run: the config now holds lore's own value. The sidecar must NOT
    // be rewritten with lore's value recorded as the "prior".
    await commandSetup(["opencode"], { port: 3299, noPlugin: true });
    const second = JSON.parse(readFileSync(`${ocPath()}.lore-backup`, "utf8"));
    expect(second).toEqual(first);
  });

  it("keeps the sidecar when the user changed a lore-set value (recoverable)", async () => {
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    writeFileSync(
      ocPath(),
      JSON.stringify(
        {
          provider: {
            anthropic: { options: { baseURL: "https://api.anthropic.com" } },
          },
        },
        null,
        2,
      ),
    );

    await commandSetup(["opencode"], { port: 3299, noPlugin: true });

    // User edits the lore-set anthropic baseURL after setup.
    const cfg = JSON.parse(readFileSync(ocPath(), "utf8"));
    cfg.provider.anthropic.options.baseURL = "http://user-changed:9999";
    writeFileSync(ocPath(), JSON.stringify(cfg, null, 2));

    await commandSetup(["undo", "opencode"], {});

    const restored = JSON.parse(readFileSync(ocPath(), "utf8"));
    // The user's change is preserved (revert-only-if-unchanged)...
    expect(restored.provider.anthropic.options.baseURL).toBe(
      "http://user-changed:9999",
    );
    // ...values the user did NOT touch were still reverted...
    expect(restored.compaction).toBeUndefined();
    // ...and the sidecar is KEPT so the untouched prior stays recoverable.
    expect(existsSync(`${ocPath()}.lore-backup`)).toBe(true);
  });
});

describe("commandSetup — Pi", () => {
  const piPath = () => join(home, ".pi", "agent", "models.json");
  let origPiDir: string | undefined;

  beforeEach(() => {
    // The path helper honors PI_CODING_AGENT_DIR; ensure the test uses the
    // temp HOME's ~/.pi/agent, not a stray override from the environment.
    origPiDir = process.env.PI_CODING_AGENT_DIR;
    delete process.env.PI_CODING_AGENT_DIR;
  });
  afterEach(() => {
    if (origPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = origPiDir;
  });

  it("writes provider baseURLs (protocol split) with a backup and undoes it", async () => {
    // Seed an existing custom provider to prove deep-merge preservation.
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(
      piPath(),
      JSON.stringify({
        providers: { myllm: { baseUrl: "http://localhost:8000", models: [] } },
      }),
    );

    await commandSetup(["pi"], { port: 3299 });

    const cfg = JSON.parse(readFileSync(piPath(), "utf8"));
    // Anthropic-family → gateway root; OpenAI-family → root + /v1.
    expect(cfg.providers.anthropic.baseUrl).toBe("http://127.0.0.1:3299");
    expect(cfg.providers.openai.baseUrl).toBe("http://127.0.0.1:3299/v1");
    expect(cfg.providers.openrouter.baseUrl).toBe("http://127.0.0.1:3299/v1");
    // Pre-existing custom provider preserved.
    expect(cfg.providers.myllm).toEqual({
      baseUrl: "http://localhost:8000",
      models: [],
    });
    expect(cfg._loreBackup).toBeUndefined();
    expect(existsSync(`${piPath()}.lore-backup`)).toBe(true);

    await commandSetup(["undo", "pi"], {});

    const restored = JSON.parse(readFileSync(piPath(), "utf8"));
    // Lore-set providers on a config that had none of them → undo removes them.
    expect(restored.providers.anthropic).toBeUndefined();
    expect(restored.providers.openai).toBeUndefined();
    // The user's own provider survives the undo.
    expect(restored.providers.myllm).toEqual({
      baseUrl: "http://localhost:8000",
      models: [],
    });
    expect(restored._loreBackup).toBeUndefined();
    expect(existsSync(`${piPath()}.lore-backup`)).toBe(false);
  });
});

describe("commandSetup — Hermes", () => {
  const hermesPath = () => join(home, ".hermes", ".env");
  let origHermesHome: string | undefined;

  beforeEach(() => {
    // hermesEnvPath honors HERMES_HOME; keep the test on the temp HOME's
    // ~/.hermes rather than a stray override from the environment.
    origHermesHome = process.env.HERMES_HOME;
    delete process.env.HERMES_HOME;
  });
  afterEach(() => {
    if (origHermesHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = origHermesHome;
  });

  it("writes the env pair with a backup block and undoes it", async () => {
    // Seed a pre-existing OPENAI_BASE_URL + an unrelated secret.
    mkdirSync(join(home, ".hermes"), { recursive: true });
    writeFileSync(
      hermesPath(),
      "NOUS_API_KEY=sk-abc\nOPENAI_BASE_URL=https://nous/v1\n",
    );

    await commandSetup(["hermes"], { port: 3299 });

    const env = readFileSync(hermesPath(), "utf8");
    expect(env).toContain("OPENAI_BASE_URL=http://127.0.0.1:3299/v1");
    expect(env).toContain("HERMES_INFERENCE_PROVIDER=custom");
    expect(env).toContain("lore setup backup");
    expect(env).toContain("NOUS_API_KEY=sk-abc"); // preserved

    await commandSetup(["undo", "hermes"], {});

    const restored = readFileSync(hermesPath(), "utf8");
    // Prior base URL restored; the provider key (unset before) removed.
    expect(restored).toContain("OPENAI_BASE_URL=https://nous/v1");
    expect(restored).not.toContain("HERMES_INFERENCE_PROVIDER");
    expect(restored).toContain("NOUS_API_KEY=sk-abc");
    expect(restored).not.toContain("lore setup backup");
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
  it("does not print a rejected remote URL secret", async () => {
    await commandSetup(["codex"], {
      remote: "https://user:super-secret@gateway.example/lore",
    });
    expect(process.exitCode).toBe(1);
    expect(logged()).toContain("Invalid remote URL");
    expect(logged()).not.toContain("super-secret");
    expect(existsSync(join(home, ".codex"))).toBe(false);
    process.exitCode = 0;
  });

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

describe("commandSetup — GitHub Copilot CLI", () => {
  it("prints COPILOT_API_URL guidance (no config file) and undoes cleanly", async () => {
    // Copilot has no config-file endpoint field; setup is guidance-only. It must
    // not throw and must surface the bare-origin export + the `lore run` path.
    await commandSetup(["copilot"], { port: 3299 });
    const out = logged();
    expect(out).toContain("export COPILOT_API_URL=http://127.0.0.1:3299");
    expect(out).toContain("lore run copilot");
    // No config file is written for Copilot.

    // Undo is an informational no-op (nothing was persisted).
    await commandSetup(["undo", "copilot"], {});
    expect(logged()).toContain("COPILOT_API_URL");
  });
});

describe("commandSetup — Gemini CLI", () => {
  const geminiPath = () => join(home, ".gemini", ".env");

  it("writes GOOGLE_GEMINI_BASE_URL to ~/.gemini/.env with a backup, then undoes", async () => {
    mkdirSync(join(home, ".gemini"), { recursive: true });
    writeFileSync(geminiPath(), "GEMINI_API_KEY=sk-abc\n");

    await commandSetup(["gemini"], { port: 3299 });

    const env = readFileSync(geminiPath(), "utf8");
    // Bare origin (no /v1) — Gemini appends /v1beta/models/... itself.
    expect(env).toContain("GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:3299");
    expect(env).not.toContain("http://127.0.0.1:3299/v1");
    expect(env).toContain("GEMINI_API_KEY=sk-abc"); // preserved
    expect(env).toContain("lore setup backup");

    await commandSetup(["undo", "gemini"], {});

    const restored = readFileSync(geminiPath(), "utf8");
    expect(restored).not.toContain("GOOGLE_GEMINI_BASE_URL");
    expect(restored).toContain("GEMINI_API_KEY=sk-abc");
    expect(restored).not.toContain("lore setup backup");
  });
});
