import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// End-to-end coverage of the REAL `commandImport` decision loop across multiple
// agents with mixed credential outcomes (success / needsModel / no-cred). Every
// scenario here maps to a bug Seer or the adversarial review caught on the
// env-credential feature (PRs #1466), so a regression re-breaks a named test
// instead of shipping-then-catching in review.
//
// Injection seams (no real filesystem/network):
//  1. registerProvider/clearProviders — fake agents named after real AgentDefs
//     (claude-code, codex) so the real per-agent auth chain still runs. Restore
//     the real registry in afterEach so this suite never poisons others.
//  2. Auth via env vars (ANTHROPIC_AUTH_TOKEN / OPENAI_API_KEY) under a tmp HOME
//     with no on-disk auth — the auth readers resolve homedir() lazily.
//  3. createGatewayLLMClient — mocked; captures (upstreams, getAuth, model) and
//     returns a canned curator answer, so extraction "succeeds" without network.

const shutdownMock = vi.fn(async () => {});
let startConfig: Record<string, unknown> = {
  upstreamAnthropic: "https://api.anthropic.com",
  upstreamOpenAI: "https://api.openai.com",
};
vi.mock("../src/cli/start", () => ({
  startGateway: vi.fn(async () => ({
    config: startConfig,
    owned: true,
    shutdown: shutdownMock,
  })),
}));

// Capture every LLM client construction: [upstreams, getAuth, model, opts].
const llmClientCalls: unknown[][] = [];
vi.mock("../src/llm-adapter", () => ({
  createGatewayLLMClient: (...args: unknown[]) => {
    llmClientCalls.push(args);
    // "[]" = a valid curator answer with no ops → chunk counts as answered.
    return { prompt: vi.fn(async () => "[]") };
  },
}));

import { commandImport } from "../src/cli/import";
import { _resetAuthForTest } from "../src/auth";
import { load as loadConfig } from "@loreai/core";
import { conversationImport } from "@loreai/core";
import type { conversationImport as CI } from "@loreai/core";

const { registerProvider, clearProviders, getProviders } = conversationImport;

type FakeSpec = {
  name: string;
  displayName: string;
  messageCount?: number;
};

/**
 * A minimal AgentHistoryProvider returning one canned session + chunk for the
 * project path. `name` must match a real AgentDef when we want the real auth
 * chain (env creds) to resolve for it.
 */
function fakeProvider(spec: FakeSpec): CI.AgentHistoryProvider {
  const messageCount = spec.messageCount ?? 5;
  return {
    name: spec.name,
    displayName: spec.displayName,
    detect(): CI.DetectedSession[] {
      return [
        {
          id: `${spec.name}-sess-1`,
          label: `2026-07-24 (${messageCount} messages)`,
          startedAt: 1_700_000_000_000,
          lastActivityAt: 1_700_000_001_000,
          estimatedTokens: 100,
          messageCount,
        } satisfies CI.DetectedSession,
      ];
    },
    readChunks(): CI.ConversationChunk[] {
      return [
        {
          label: `${spec.displayName} session (1 of 1)`,
          text: "[user] hello\n[assistant] hi there",
          estimatedTokens: 10,
          timestamp: 1_700_000_001_000,
        },
      ];
    },
  };
}

describe("commandImport (local mode) — multi-agent e2e decision matrix", () => {
  let project: string;
  let fakeHome: string;
  const logs: string[] = [];
  const errs: string[] = [];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  const prevRemote = process.env.LORE_REMOTE_URL;
  const prevHome = process.env.HOME;
  const prevXdgData = process.env.XDG_DATA_HOME;
  const prevXdgConfig = process.env.XDG_CONFIG_HOME;
  const prevWorkerModel = process.env.LORE_WORKER_MODEL;
  const envKeys = [
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
  ];
  const savedEnv: Record<string, string | undefined> = {};
  // Snapshot the real provider registry so we can restore it after each test.
  let realProviders: readonly CI.AgentHistoryProvider[];

  beforeEach(() => {
    delete process.env.LORE_REMOTE_URL; // force local mode
    delete process.env.LORE_WORKER_MODEL;
    for (const k of envKeys) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    _resetAuthForTest();
    startConfig = {
      upstreamAnthropic: "https://api.anthropic.com",
      upstreamOpenAI: "https://api.openai.com",
    };
    project = mkdtempSync(join(tmpdir(), "lore-e2e-project-"));
    // Fresh HOME with no on-disk agent auth → forces the env-credential tier.
    fakeHome = mkdtempSync(join(tmpdir(), "lore-e2e-home-"));
    process.env.HOME = fakeHome;
    process.env.XDG_DATA_HOME = join(fakeHome, ".local", "share");
    process.env.XDG_CONFIG_HOME = join(fakeHome, ".config");

    // Snapshot + clear the real registry; register fakes per-test.
    realProviders = [...getProviders()];
    clearProviders();

    logs.length = 0;
    errs.length = 0;
    llmClientCalls.length = 0;
    logSpy = vi.spyOn(console, "log").mockImplementation((...a) => {
      logs.push(a.join(" "));
    });
    errSpy = vi.spyOn(console, "error").mockImplementation((...a) => {
      errs.push(a.join(" "));
    });
    // Swallow the progress \r writes.
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    shutdownMock.mockClear();
  });

  afterEach(async () => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    stderrSpy.mockRestore();
    vi.restoreAllMocks();
    rmSync(project, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
    // Restore the real provider registry so sibling suites see the real agents.
    clearProviders();
    for (const p of realProviders) registerProvider(p);
    _resetAuthForTest();
    // Restore env.
    if (prevRemote === undefined) delete process.env.LORE_REMOTE_URL;
    else process.env.LORE_REMOTE_URL = prevRemote;
    if (prevWorkerModel === undefined) delete process.env.LORE_WORKER_MODEL;
    else process.env.LORE_WORKER_MODEL = prevWorkerModel;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevXdgData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prevXdgData;
    if (prevXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdgConfig;
    for (const k of envKeys) {
      const v = savedEnv[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    // Reset process-global config to a clean dir.
    await loadConfig(mkdtempSync(join(tmpdir(), "lore-e2e-cfg-")));
  });

  const out = () => errs.join("\n");
  const info = () => logs.join("\n");

  test("1. single agent with a real (anthropic) env credential → extraction runs, success, no 'Can't import'", async () => {
    registerProvider(
      fakeProvider({ name: "claude-code", displayName: "Claude Code" }),
    );
    process.env.ANTHROPIC_API_KEY = "sk-ant-real";

    await commandImport([], { project, yes: true });

    expect(out()).not.toContain("Can't import");
    expect(info()).toContain("Reading Claude Code conversations");
    // Extraction client built with an anthropic model (anthropic HAS a default).
    expect(llmClientCalls.length).toBe(1);
    const model = llmClientCalls[0][2] as {
      providerID: string;
      modelID: string;
    };
    expect(model.providerID).toBe("anthropic");
    expect(model.modelID).toBeTruthy();
  });

  test("2. env credential for a defaultless provider (OpenRouter) WITH a matching LORE_WORKER_MODEL → override honored, correct upstream", async () => {
    registerProvider(
      fakeProvider({ name: "claude-code", displayName: "Claude Code" }),
    );
    process.env.ANTHROPIC_BASE_URL = "https://openrouter.ai/api";
    process.env.ANTHROPIC_AUTH_TOKEN = "sk-or-live";
    process.env.LORE_WORKER_MODEL = "openrouter/some-model";

    await commandImport([], { project, yes: true });

    expect(out()).not.toContain("Can't import");
    expect(llmClientCalls.length).toBe(1);
    const [upstreams, , model] = llmClientCalls[0] as [
      { anthropic: string; openai: string },
      unknown,
      { providerID: string; modelID: string },
    ];
    expect(model).toEqual({ providerID: "openrouter", modelID: "some-model" });
    // Extraction routed at the captured upstream, not api.anthropic.com.
    expect(upstreams.anthropic).toBe("https://openrouter.ai/api");
    expect(upstreams.openai).toBe("https://openrouter.ai/api");
  });

  test("3. env credential for a defaultless provider (OpenRouter) with NO model → needsModel guidance, extraction never runs", async () => {
    registerProvider(
      fakeProvider({ name: "claude-code", displayName: "Claude Code" }),
    );
    process.env.ANTHROPIC_BASE_URL = "https://openrouter.ai/api";
    process.env.ANTHROPIC_AUTH_TOKEN = "sk-or-live";

    await commandImport([], { project, yes: true });

    // Never sent an empty model to an upstream.
    expect(llmClientCalls.length).toBe(0);
    // Per-agent skip line + consolidated guidance both mention openrouter.
    expect(info()).toContain("found your openrouter");
    expect(out()).toContain("export LORE_WORKER_MODEL=openrouter/<model>");
  });

  test("4. multi-agent: A (anthropic, ok) + B (openrouter, needsModel) → A imports AND B's guidance still prints (the '(see below)' promise)", async () => {
    registerProvider(
      fakeProvider({ name: "claude-code", displayName: "Claude Code" }),
    );
    registerProvider(fakeProvider({ name: "codex", displayName: "Codex" }));
    // claude-code → real anthropic key (succeeds).
    process.env.ANTHROPIC_API_KEY = "sk-ant-real";
    // codex → OpenRouter-style env with no model (needsModel). Codex reads
    // OPENAI_* env; point it at openrouter via OPENAI_BASE_URL.
    process.env.OPENAI_BASE_URL = "https://openrouter.ai/api";
    process.env.OPENAI_API_KEY = "sk-or-codex";

    await commandImport([], { project, yes: true });

    // A's extraction ran (exactly one — codex was skipped pre-extraction).
    expect(llmClientCalls.length).toBe(1);
    const model = llmClientCalls[0][2] as { providerID: string };
    expect(model.providerID).toBe("anthropic");
    // B's guidance is NOT suppressed even though A succeeded.
    expect(out()).toContain("export LORE_WORKER_MODEL=openrouter/<model>");
    expect(out()).toContain("some agents");
  });

  test("5. multi-agent: two DIFFERENT defaultless providers both needsModel → guidance lists BOTH, one export line each", async () => {
    registerProvider(
      fakeProvider({ name: "claude-code", displayName: "Claude Code" }),
    );
    registerProvider(fakeProvider({ name: "codex", displayName: "Codex" }));
    process.env.ANTHROPIC_BASE_URL = "https://openrouter.ai/api";
    process.env.ANTHROPIC_AUTH_TOKEN = "sk-or-claude";
    process.env.OPENAI_BASE_URL = "https://api.deepseek.com";
    process.env.OPENAI_API_KEY = "sk-deepseek";

    await commandImport([], { project, yes: true });

    expect(llmClientCalls.length).toBe(0);
    // Both distinct providers appear, each with its own export line (Seer #3:
    // the summary must not collapse to just the last provider seen).
    expect(out()).toContain("export LORE_WORKER_MODEL=openrouter/<model>");
    expect(out()).toContain("export LORE_WORKER_MODEL=deepseek/<model>");
  });

  test("6. no agent has any usable credential → generic 'Ways forward' guidance, no extraction, gateway shut down", async () => {
    registerProvider(
      fakeProvider({ name: "claude-code", displayName: "Claude Code" }),
    );
    // No env creds, no on-disk auth, no worker key.

    await commandImport([], { project, yes: true });

    expect(llmClientCalls.length).toBe(0);
    expect(out()).toContain("Can't import");
    expect(out()).toContain("Ways forward");
    expect(shutdownMock).toHaveBeenCalled();
  });

  test.each([
    { name: "initial auth resolution", onDisk: false },
    { name: "fallback-chain construction", onDisk: true },
  ])(
    "reports an invalid env upstream without throwing during $name",
    async ({ onDisk }) => {
      registerProvider(
        fakeProvider({ name: "claude-code", displayName: "Claude Code" }),
      );
      if (onDisk) {
        mkdirSync(join(fakeHome, ".claude"), { recursive: true });
        writeFileSync(
          join(fakeHome, ".claude", ".credentials.json"),
          JSON.stringify({
            claudeAiOauth: { accessToken: "disk-oauth", expiresAt: null },
          }),
          "utf8",
        );
      }
      process.env.ANTHROPIC_AUTH_TOKEN = "private-proxy-token";
      process.env.ANTHROPIC_BASE_URL =
        "https://proxy.example/v1?api_key=secret";
      const priorExitCode = process.exitCode;

      try {
        await expect(
          commandImport([], { project, yes: true }),
        ).resolves.toBeUndefined();

        expect(out()).toContain("Can't import Claude Code");
        expect(out()).toContain("ANTHROPIC_BASE_URL");
        expect(out()).toContain("Fix or unset");
        expect(out()).not.toContain("private-proxy-token");
        expect(out()).not.toContain("api_key=secret");
        expect(llmClientCalls).toHaveLength(0);
        expect(shutdownMock).toHaveBeenCalled();
        expect(process.exitCode).toBe(1);
      } finally {
        process.exitCode = priorExitCode;
      }
    },
  );
});
