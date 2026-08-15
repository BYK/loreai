import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  safeExit: vi.fn(),
  forcedExit: vi.fn(),
  spawn: vi.fn(),
  startGateway: vi.fn(),
  probeGateway: vi.fn(),
}));

vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("@loreai/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@loreai/core")>();
  return {
    ...actual,
    discoverWorkspaceRoot: () => process.cwd(),
    getGitRemote: () => null,
    log: { ...actual.log, silenceStderr: vi.fn() },
  };
});
vi.mock("../src/cli/exit", () => ({
  safeExit: mocks.safeExit,
  forcedExit: mocks.forcedExit,
}));
vi.mock("../src/cli/import-auto", () => ({ maybeAutoImport: vi.fn() }));
vi.mock("../src/cli/start", () => ({
  startGateway: mocks.startGateway,
  probeGateway: mocks.probeGateway,
}));
vi.mock("../src/config", () => ({
  loadConfig: () => ({ port: 3207, hosts: ["127.0.0.1"], debug: false }),
  providerForUpstreamOrigin: () => undefined,
}));

import { commandRun } from "../src/cli/run";

describe("lore run adoption with a reused gateway", () => {
  const priorOpenAIBaseUrl = process.env.OPENAI_BASE_URL;
  const priorLoreUpstream = process.env.LORE_UPSTREAM_OPENAI;
  const priorAnthropicBaseUrl = process.env.ANTHROPIC_BASE_URL;
  const priorLoreAnthropic = process.env.LORE_UPSTREAM_ANTHROPIC;
  const priorAnthropicToken = process.env.ANTHROPIC_AUTH_TOKEN;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENAI_BASE_URL = "https://proxy.example.com/v1";
    delete process.env.LORE_UPSTREAM_OPENAI;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.LORE_UPSTREAM_ANTHROPIC;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    mocks.startGateway.mockResolvedValue({
      port: 3207,
      owned: false,
      config: { port: 3207, hosts: ["127.0.0.1"], debug: false },
      shutdown: vi.fn(),
    });
  });

  afterEach(() => {
    if (priorOpenAIBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = priorOpenAIBaseUrl;
    if (priorLoreUpstream === undefined)
      delete process.env.LORE_UPSTREAM_OPENAI;
    else process.env.LORE_UPSTREAM_OPENAI = priorLoreUpstream;
    if (priorAnthropicBaseUrl === undefined)
      delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = priorAnthropicBaseUrl;
    if (priorLoreAnthropic === undefined)
      delete process.env.LORE_UPSTREAM_ANTHROPIC;
    else process.env.LORE_UPSTREAM_ANTHROPIC = priorLoreAnthropic;
    if (priorAnthropicToken === undefined)
      delete process.env.ANTHROPIC_AUTH_TOKEN;
    else process.env.ANTHROPIC_AUTH_TOKEN = priorAnthropicToken;
  });

  test("does not launch an env-routed agent against an incompatible reused gateway", async () => {
    await commandRun({}, ["codex"]);

    expect(mocks.safeExit).toHaveBeenCalledWith(1);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  test("launches a header-routed agent against a reused gateway", async () => {
    delete process.env.OPENAI_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = "https://proxy.example.com/v1";
    mocks.spawn.mockImplementationOnce(() => {
      throw new Error("__agent_launched__");
    });

    await expect(commandRun({}, ["claude"])).rejects.toThrow(
      "__agent_launched__",
    );
    expect(mocks.safeExit).not.toHaveBeenCalled();
  });

  test.each([
    "https://user:secret@proxy.example.com/v1",
    "https://proxy.example.com/v1?api_key=secret",
  ])("fails before gateway startup for unsafe upstream %s", async (url) => {
    delete process.env.OPENAI_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = url;
    process.env.ANTHROPIC_AUTH_TOKEN = "private-proxy-token";

    await commandRun({}, ["claude"]);

    expect(mocks.safeExit).toHaveBeenCalledWith(1);
    expect(mocks.startGateway).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});
