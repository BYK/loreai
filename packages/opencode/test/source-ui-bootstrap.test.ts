import { createServer, type Server } from "node:http";
import type { PluginInput } from "@opencode-ai/plugin";
import { log } from "@loreai/core";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";

const gatewayMock = vi.hoisted(() => ({
  prepareSourceUiAssets: vi.fn(),
  readPortFile: vi.fn(),
  startGateway: vi.fn(),
  installFetchInterceptor: vi.fn(),
}));

vi.mock("@loreai/gateway", () => gatewayMock);
vi.mock("@loreai/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@loreai/core")>()),
  installFetchInterceptor: gatewayMock.installFetchInterceptor,
}));

async function activate() {
  const { LorePlugin } = await import("../src/index");
  return await LorePlugin({
    client: {
      tui: { showToast: () => Promise.resolve() },
      session: { get: () => Promise.resolve({ data: {} }) },
    } as unknown as PluginInput["client"],
    project: { id: "source-ui-order" } as unknown as PluginInput["project"],
    directory: "/synthetic/opencode-gateway-selection",
    worktree: "/synthetic/opencode-gateway-selection",
    serverUrl: new URL("http://localhost:0"),
    $: {} as unknown as PluginInput["$"],
  });
}

describe("OpenCode source UI bootstrap ordering", () => {
  let server: Server;
  let gatewayUrl: string;
  let healthSawPreparation = false;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.LORE_DISABLED;
    delete process.env.LORE_REMOTE_URL;
    delete process.env.LORE_GATEWAY_URL;
    process.env.LORE_OPENCODE_FORCE_ACTIVE = "1";
    healthSawPreparation = false;
    gatewayMock.prepareSourceUiAssets.mockResolvedValue({
      attempted: true,
      files: 17,
      buildId: "build-a",
    });
    const port = Number(new URL(gatewayUrl).port);
    gatewayMock.readPortFile.mockReturnValue(port);
    gatewayMock.startGateway.mockResolvedValue({ port, owned: false });
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    vi.restoreAllMocks();
    log.silenceStderr(false);
  });

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/health") {
        healthSawPreparation =
          gatewayMock.prepareSourceUiAssets.mock.results.some(
            (result) => result.type === "return",
          );
        res.writeHead(200);
        res.end("ok");
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    gatewayUrl = `http://127.0.0.1:${
      (server.address() as { port: number }).port
    }`;
  });

  afterAll(async () => {
    process.env = { ...savedEnv };
    gatewayMock.prepareSourceUiAssets.mockReset();
    log.silenceStderr(false);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("an unreachable remote never falls back to a healthy local gateway", async () => {
    const failedRemote = createServer((_request, response) => {
      response.writeHead(503);
      response.end();
    });
    await new Promise<void>((resolve) =>
      failedRemote.listen(0, "127.0.0.1", resolve),
    );
    const failedRemoteUrl = `http://127.0.0.1:${
      (failedRemote.address() as { port: number }).port
    }`;
    const sentinel = "remote-url-private-sentinel";
    const originalFetch = globalThis.fetch;
    const previousGateway = process.env.LORE_GATEWAY_URL;
    const previousForce = process.env.LORE_OPENCODE_FORCE_ACTIVE;
    const previousRemote = process.env.LORE_REMOTE_URL;
    const infoSpy = vi.spyOn(log, "info");
    gatewayMock.prepareSourceUiAssets.mockClear();
    healthSawPreparation = false;
    gatewayMock.prepareSourceUiAssets.mockResolvedValue({
      attempted: true,
      files: 17,
      buildId: "build-a",
    });
    process.env.LORE_GATEWAY_URL = gatewayUrl;
    process.env.LORE_OPENCODE_FORCE_ACTIVE = "1";
    process.env.LORE_REMOTE_URL = `${failedRemoteUrl}/path/${sentinel}`;

    try {
      const hooks = await activate();

      expect(hooks).toEqual({});
      expect(gatewayMock.prepareSourceUiAssets).not.toHaveBeenCalled();
      expect(healthSawPreparation).toBe(false);
      expect(gatewayMock.readPortFile).not.toHaveBeenCalled();
      expect(gatewayMock.startGateway).not.toHaveBeenCalled();
      expect(gatewayMock.installFetchInterceptor).not.toHaveBeenCalled();
      expect(infoSpy.mock.calls.flat().join(" ")).not.toContain(sentinel);
    } finally {
      infoSpy.mockRestore();
      globalThis.fetch = originalFetch;
      if (previousGateway === undefined) delete process.env.LORE_GATEWAY_URL;
      else process.env.LORE_GATEWAY_URL = previousGateway;
      if (previousForce === undefined)
        delete process.env.LORE_OPENCODE_FORCE_ACTIVE;
      else process.env.LORE_OPENCODE_FORCE_ACTIVE = previousForce;
      if (previousRemote === undefined) delete process.env.LORE_REMOTE_URL;
      else process.env.LORE_REMOTE_URL = previousRemote;
      await new Promise<void>((resolve) => failedRemote.close(() => resolve()));
    }
  });

  test.each(["LORE_REMOTE_URL", "LORE_GATEWAY_URL"])(
    "an invalid %s never selects the healthy port-file gateway",
    async (name) => {
      process.env[name] = "not a gateway URL";
      expect(await activate()).toEqual({});
      expect(gatewayMock.readPortFile).not.toHaveBeenCalled();
      expect(gatewayMock.startGateway).not.toHaveBeenCalled();
      expect(gatewayMock.installFetchInterceptor).not.toHaveBeenCalled();
    },
  );

  test("failed explicit resolution never starts an embedded gateway", async () => {
    const internal = await import("../src/internal");
    // Isolate the caller's no-running-gateway path without probing host ports.
    vi.spyOn(internal, "probeGateway").mockResolvedValue(false);
    process.env.LORE_REMOTE_URL = "https://gateway.example";
    expect(await activate()).toEqual({});
    expect(gatewayMock.startGateway).not.toHaveBeenCalled();
    expect(gatewayMock.installFetchInterceptor).not.toHaveBeenCalled();
  });

  test("a reachable remote activates without local discovery or preparation", async () => {
    process.env.LORE_REMOTE_URL = gatewayUrl;
    await activate();
    expect(gatewayMock.installFetchInterceptor).toHaveBeenCalledWith(
      expect.objectContaining({ gatewayBase: gatewayUrl }),
    );
    expect(gatewayMock.prepareSourceUiAssets).not.toHaveBeenCalled();
    expect(gatewayMock.readPortFile).not.toHaveBeenCalled();
    expect(gatewayMock.startGateway).not.toHaveBeenCalled();
  });

  test.each(["explicit", "port file"])(
    "prepares local assets before reusing a healthy %s gateway",
    async (selection) => {
      if (selection === "explicit") process.env.LORE_GATEWAY_URL = gatewayUrl;
      await activate();
      expect(gatewayMock.prepareSourceUiAssets).toHaveBeenCalledOnce();
      expect(healthSawPreparation).toBe(true);
      expect(gatewayMock.installFetchInterceptor).toHaveBeenCalledWith(
        expect.objectContaining({ gatewayBase: gatewayUrl }),
      );
      expect(gatewayMock.startGateway).not.toHaveBeenCalled();
    },
  );
});
