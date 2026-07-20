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
// network call — the curator returns [] (answered, nothing to create).
vi.mock("../src/llm-adapter", () => ({
  createGatewayLLMClient: () => ({
    prompt: vi.fn(async () => "[]"),
  }),
}));

import { commandImport } from "../src/cli/import";
import { setLastSeenAuth, _resetAuthForTest } from "../src/auth";

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
    _resetAuthForTest();
    startConfig = {
      upstreamAnthropic: "https://api.anthropic.com",
      upstreamOpenAI: "https://api.openai.com",
    };
    project = mkdtempSync(join(tmpdir(), "lore-cmdimport-local-"));
    copyFileSync(AIDER_FIXTURE, join(project, ".aider.chat.history.md"));
    logs.length = 0;
    errs.length = 0;
    logSpy = vi.spyOn(console, "log").mockImplementation((...a) => {
      logs.push(a.join(" "));
    });
    errSpy = vi.spyOn(console, "error").mockImplementation((...a) => {
      errs.push(a.join(" "));
    });
    shutdownMock.mockClear();
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    vi.restoreAllMocks();
    rmSync(project, { recursive: true, force: true });
    _resetAuthForTest();
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

  test("worker key set → passes the guard and proceeds to read/extract", async () => {
    startConfig.workerApiKey = "sk-worker-test";

    await commandImport([], { project, agent: "aider", yes: true });

    expect(errs.join("\n")).not.toContain("Can't import");
    // Guard passed → proceeds to read conversations (extraction then runs
    // against the real curator; no assertion on its result here).
    expect(logs.join("\n")).toContain("Reading");
    expect(shutdownMock).toHaveBeenCalled();
  });

  test("session credential present → passes the guard and proceeds to read/extract", async () => {
    setLastSeenAuth({ scheme: "bearer", value: "sk-ant-oat" }, "anthropic");

    await commandImport([], { project, agent: "aider", yes: true });

    expect(errs.join("\n")).not.toContain("Can't import");
    expect(logs.join("\n")).toContain("Reading");
  });
});
