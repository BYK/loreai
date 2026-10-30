import type { PluginInput } from "@opencode-ai/plugin";
import { RECALL_TOOL_NAME } from "@loreai/core";
import { afterEach, expect, test, vi } from "vitest";

const gatewayMock = vi.hoisted(() => ({
  prepareSourceUiAssets: vi.fn(),
  startGateway: vi.fn(),
}));

const internalMock = vi.hoisted(() => ({
  probeGateway: vi.fn(),
  prepareLocalUiAssets: vi.fn(),
  surfaceGatewayUnavailable: vi.fn(),
}));

vi.mock("@loreai/gateway", () => gatewayMock);
vi.mock("../src/internal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/internal")>();
  return {
    ...actual,
    probeGateway: internalMock.probeGateway,
    prepareLocalUiAssets: internalMock.prepareLocalUiAssets,
    surfaceGatewayUnavailable: internalMock.surfaceGatewayUnavailable,
  };
});

const savedEnv = { ...process.env };

afterEach(() => {
  process.env = { ...savedEnv };
  gatewayMock.prepareSourceUiAssets.mockReset();
  gatewayMock.startGateway.mockReset();
  internalMock.probeGateway.mockReset();
  internalMock.prepareLocalUiAssets.mockReset();
  internalMock.surfaceGatewayUnavailable.mockReset();
});

test("does not expose local recall when remote and embedded gateways fail", async () => {
  process.env.LORE_OPENCODE_FORCE_ACTIVE = "1";
  process.env.LORE_REMOTE_URL = "https://remote-gateway.example";
  process.env.LORE_GATEWAY_URL = "http://127.0.0.1:3207";
  delete process.env.LORE_DISABLED;
  internalMock.probeGateway.mockResolvedValue(false);
  internalMock.prepareLocalUiAssets.mockResolvedValue(undefined);
  internalMock.surfaceGatewayUnavailable.mockResolvedValue(undefined);
  gatewayMock.prepareSourceUiAssets.mockResolvedValue({
    attempted: false,
    files: 0,
    buildId: null,
  });
  gatewayMock.startGateway.mockRejectedValue(new Error("startup failed"));

  vi.resetModules();
  const { LorePlugin } = await import("../src/index");
  const hooks = await LorePlugin({
    client: {
      tui: { showToast: () => Promise.resolve() },
      session: { get: () => Promise.resolve({ data: {} }) },
    } as unknown as PluginInput["client"],
    project: {
      id: "remote-recall-fallback",
    } as unknown as PluginInput["project"],
    directory: process.cwd(),
    worktree: process.cwd(),
    serverUrl: new URL("http://localhost:0"),
    $: {} as unknown as PluginInput["$"],
  });

  expect(internalMock.probeGateway).toHaveBeenCalled();
  expect(gatewayMock.startGateway).toHaveBeenCalledOnce();
  expect(hooks.tool?.[RECALL_TOOL_NAME]).toBeUndefined();
});
