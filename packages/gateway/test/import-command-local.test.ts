import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Local-mode commandImport: mock the gateway start so no real server boots.
// `owned:true` so the command calls shutdown() on the way out. The returned
// config controls the auth pre-flight (workerApiKey).
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

// Stub the LLM client so the positive (guard-passed) paths never make a real
// network call — the curator returns [] (answered, nothing to create). Capture
// the constructor args so we can assert the upstreams map, defaultModel, and
// the dedicatedWorkerKey option that #1454 plumbs through.
const llmClientCalls: unknown[][] = [];
vi.mock("../src/llm-adapter", () => ({
  createGatewayLLMClient: (...args: unknown[]) => {
    llmClientCalls.push(args);
    return { prompt: vi.fn(async () => "[]") };
  },
}));

import { commandImport } from "../src/cli/import";
import { setLastSeenAuth, _resetAuthForTest } from "../src/auth";
import { load as loadConfig } from "@loreai/core";
import { writeFileSync } from "node:fs";

const AIDER_FIXTURE = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "..",
  "core",
  "test",
  "import",
  "fixtures",
  "aider-history.md",
);

describe("commandImport (local mode) — auth pre-flight", () => {
  let project: string;
  const logs: string[] = [];
  const errs: string[] = [];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  const prevRemote = process.env.LORE_REMOTE_URL;

  beforeEach(() => {
    delete process.env.LORE_REMOTE_URL; // force local mode
    delete process.env.LORE_WORKER_MODEL;
    _resetAuthForTest();
    startConfig = {
      upstreamAnthropic: "https://api.anthropic.com",
      upstreamOpenAI: "https://api.openai.com",
    };
    project = mkdtempSync(join(tmpdir(), "lore-cmdimport-local-"));
    copyFileSync(AIDER_FIXTURE, join(project, ".aider.chat.history.md"));
    logs.length = 0;
    errs.length = 0;
    llmClientCalls.length = 0;
    logSpy = vi.spyOn(console, "log").mockImplementation((...a) => {
      logs.push(a.join(" "));
    });
    errSpy = vi.spyOn(console, "error").mockImplementation((...a) => {
      errs.push(a.join(" "));
    });
    shutdownMock.mockClear();
  });

  afterEach(async () => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    vi.restoreAllMocks();
    rmSync(project, { recursive: true, force: true });
    _resetAuthForTest();
    // Reset process-global config to a clean empty dir so a test that wrote a
    // `.lore.json` (e.g. the workerModel case) can't leak into later tests.
    await loadConfig(tmpdir());
    delete process.env.LORE_WORKER_MODEL;
    if (prevRemote === undefined) delete process.env.LORE_REMOTE_URL;
    else process.env.LORE_REMOTE_URL = prevRemote;
  });

  test("no credential and no worker key → fails loudly, never extracts, shuts down", async () => {
    await commandImport([], { project, agent: "aider", yes: true });

    const out = errs.join("\n");
    expect(out).toContain("Can't import");
    expect(out).toContain("LORE_WORKER_API_KEY");
    // Never got past the guard to read/extract, and cleaned up the owned gateway.
    expect(logs.join("\n")).not.toContain("Reading");
    expect(shutdownMock).toHaveBeenCalled();
  });

  test("no explicit model configured → message is provider-neutral (no hardcoded 'anthropic')", async () => {
    // Regression (Kjaer #1398, Erica): with no `cfg.model` set the provider
    // falls back to a built-in default. The message must NOT tell a
    // Copilot/OpenRouter user to export an "anthropic key" they don't have, and
    // must lead with the universal `lore run` path.
    await commandImport([], { project, agent: "aider", yes: true });

    const out = errs.join("\n");
    expect(out).toContain("Can't import");
    // Neutral wording: no provider name baked into the key hint.
    expect(out).not.toContain("anthropic key");
    expect(out).toContain("<key for your provider>");
    // Leads with the universal path.
    expect(out).toContain("lore run");
  });

  test("worker key set → passes the guard and proceeds to read/extract", async () => {
    // An Anthropic-prefixed key with the default (anthropic) upstream passes
    // the pre-flight guard cleanly.
    startConfig.workerApiKey = "sk-ant-worker-test";

    await commandImport([], { project, agent: "aider", yes: true });

    expect(errs.join("\n")).not.toContain("Can't import");
    // Guard passed → proceeds to read conversations (extraction then runs
    // against the real curator; no assertion on its result here).
    expect(logs.join("\n")).toContain("Reading");
    expect(shutdownMock).toHaveBeenCalled();
  });

  test("worker key set → LLM client gets dedicatedWorkerKey + upstreams + model (#1454)", async () => {
    startConfig.workerApiKey = "sk-ant-worker-test";

    await commandImport([], { project, agent: "aider", yes: true });

    // The client must be constructed with the four-arg form: an upstreams map,
    // the resolver, the default model, and the dedicatedWorkerKey option. The
    // flag is what disables the in-adapter protocol-mismatch pre-flight for a
    // deliberately-chosen worker key.
    expect(llmClientCalls.length).toBeGreaterThan(0);
    const [upstreams, , defaultModel, opts] = llmClientCalls[0] as [
      Record<string, string>,
      unknown,
      { providerID: string; modelID: string },
      { dedicatedWorkerKey?: boolean } | undefined,
    ];
    expect(opts?.dedicatedWorkerKey).toBe(true);
    expect(upstreams.anthropic).toBe("https://api.anthropic.com");
    // No cfg.model / workerModel here → built-in anthropic default.
    expect(defaultModel.providerID).toBe("anthropic");
  });

  test("LORE_WORKER_UPSTREAM redirects the worker upstreams map (#1454)", async () => {
    startConfig.workerApiKey = "sk-ant-worker-test";
    startConfig.workerUpstream = "https://proxy.example/v1";

    await commandImport([], { project, agent: "aider", yes: true });

    expect(llmClientCalls.length).toBeGreaterThan(0);
    const [upstreams] = llmClientCalls[0] as [Record<string, string>];
    expect(upstreams.anthropic).toBe("https://proxy.example/v1");
    expect(upstreams.openai).toBe("https://proxy.example/v1");
  });

  test("cfg.workerModel is preferred over cfg.model for extraction (#1454)", async () => {
    writeFileSync(
      join(project, ".lore.json"),
      JSON.stringify({
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
        workerModel: { providerID: "openai", modelID: "gpt-5.6-luna" },
      }),
    );
    await loadConfig(project);
    startConfig.workerApiKey = "sk-worker-test";
    startConfig.workerUpstream = "https://api.openai.com/v1";

    await commandImport([], { project, agent: "aider", yes: true });

    expect(llmClientCalls.length).toBeGreaterThan(0);
    const [, , defaultModel] = llmClientCalls[0] as [
      unknown,
      unknown,
      { providerID: string; modelID: string },
    ];
    // workerModel (openai) wins over model (anthropic).
    expect(defaultModel.providerID).toBe("openai");
    expect(defaultModel.modelID).toBe("gpt-5.6-luna");
  });

  test("LORE_WORKER_MODEL env overrides the extraction model (#1398 / Kjaer)", async () => {
    // Kjaer set LORE_WORKER_API_KEY + LORE_WORKER_UPSTREAM + LORE_WORKER_MODEL
    // (all env vars, in parallel), but standalone import never read the model
    // env var → it defaulted to anthropic/claude-* and 404'd on api.openai.com.
    // The env var must win, matching the live worker path's precedence.
    process.env.LORE_WORKER_MODEL = "openai/gpt-5.4-mini";
    startConfig.workerApiKey = "sk-openai-not-anthropic";
    startConfig.workerUpstream = "https://api.openai.com/v1";

    await commandImport([], { project, agent: "aider", yes: true });

    expect(errs.join("\n")).not.toContain("Can't import");
    expect(llmClientCalls.length).toBeGreaterThan(0);
    const [, , defaultModel] = llmClientCalls[0] as [
      unknown,
      unknown,
      { providerID: string; modelID: string },
    ];
    expect(defaultModel.providerID).toBe("openai");
    expect(defaultModel.modelID).toBe("gpt-5.4-mini");
  });

  test("non-Anthropic worker key with no upstream → fails loudly pre-flight (no doomed calls)", async () => {
    // Regression guard: with dedicatedWorkerKey disabling the in-adapter
    // mismatch check, a non-`sk-ant-` key defaulting to the anthropic upstream
    // would otherwise fire N doomed requests + N Sentry captures. We must catch
    // it once, pre-flight, before ever building the client.
    startConfig.workerApiKey = "sk-openai-not-anthropic";
    // No workerUpstream, no cfg.model → defaults to anthropic upstream.

    await commandImport([], { project, agent: "aider", yes: true });

    const out = errs.join("\n");
    expect(out).toContain("Can't import");
    expect(out).toContain("sk-ant-");
    // Never built the client / read anything.
    expect(llmClientCalls.length).toBe(0);
    expect(logs.join("\n")).not.toContain("Reading");
    expect(shutdownMock).toHaveBeenCalled();
  });

  test("non-Anthropic worker key WITH upstream → passes the guard (#1454)", async () => {
    // The escape hatch: a raw OpenAI/OpenRouter/etc. key + explicit upstream is
    // exactly the supported cross-provider worker path and must NOT be blocked.
    startConfig.workerApiKey = "sk-openai-not-anthropic";
    startConfig.workerUpstream = "https://api.openai.com/v1";

    await commandImport([], { project, agent: "aider", yes: true });

    expect(errs.join("\n")).not.toContain("Can't import");
    expect(logs.join("\n")).toContain("Reading");
  });

  test("session credential present → passes the guard and proceeds to read/extract", async () => {
    setLastSeenAuth({ scheme: "bearer", value: "sk-ant-oat" }, "anthropic");

    await commandImport([], { project, agent: "aider", yes: true });

    expect(errs.join("\n")).not.toContain("Can't import");
    expect(logs.join("\n")).toContain("Reading");
  });
});
