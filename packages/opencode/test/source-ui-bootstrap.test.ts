import { createServer, type Server } from "node:http";
import type { PluginInput } from "@opencode-ai/plugin";
import { log } from "@loreai/core";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

const gatewayMock = vi.hoisted(() => ({
  prepareSourceUiAssets: vi.fn(),
}));

vi.mock("@loreai/gateway", () => gatewayMock);

describe("OpenCode source UI bootstrap ordering", () => {
  let server: Server;
  let gatewayUrl: string;
  let healthSawPreparation = false;
  const savedEnv = { ...process.env };

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

  test("prepares local fallback and does not log an unreachable remote URL", async () => {
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
      const { LorePlugin } = await import("../src/index");
      await LorePlugin({
        client: {
          tui: { showToast: () => Promise.resolve() },
          session: { get: () => Promise.resolve({ data: {} }) },
        } as unknown as PluginInput["client"],
        project: { id: "source-ui-order" } as unknown as PluginInput["project"],
        directory: process.cwd(),
        worktree: process.cwd(),
        serverUrl: new URL("http://localhost:0"),
        $: {} as unknown as PluginInput["$"],
      });

      expect(gatewayMock.prepareSourceUiAssets).toHaveBeenCalledOnce();
      expect(healthSawPreparation).toBe(true);
      expect(infoSpy).toHaveBeenCalledWith(
        "remote gateway is not reachable, falling through to local discovery",
      );
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
});
