import { createServer } from "node:http";
import type { PluginInput } from "@opencode-ai/plugin";
import { log } from "@loreai/core";
import { expect, test, vi } from "vitest";

const gatewayMock = vi.hoisted(() => ({
  prepareSourceUiAssets: vi.fn(),
}));

vi.mock("@loreai/gateway", () => gatewayMock);

test("redacts sensitive gateway URL components from logger and sink", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200);
    response.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const savedEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  const pathSecret = "gateway-path-private-sentinel";
  const querySecret = "gateway-query-private-sentinel";
  const fragmentSecret = "gateway-fragment-private-sentinel";
  const userSecret = "gateway-user-private-sentinel";
  const passwordSecret = "gateway-password-private-sentinel";
  const port = (server.address() as { port: number }).port;
  const remoteUrl =
    `http://${userSecret}:${passwordSecret}@127.0.0.1:${port}/` +
    `${pathSecret}?token=${querySecret}#${fragmentSecret}`;
  const infoSpy = vi.spyOn(log, "info");
  const sinkMessages: string[] = [];
  log.registerSink({
    info: (message) => sinkMessages.push(message),
    warn: () => {},
    error: () => {},
    captureException: () => {},
  });
  process.env.LORE_OPENCODE_FORCE_ACTIVE = "1";
  process.env.LORE_REMOTE_URL = remoteUrl;
  delete process.env.LORE_GATEWAY_URL;
  delete process.env.LORE_DISABLED;

  try {
    const { LorePlugin } = await import("../src/index");
    await LorePlugin({
      client: {
        tui: { showToast: () => Promise.resolve() },
        session: { get: () => Promise.resolve({ data: {} }) },
      } as unknown as PluginInput["client"],
      project: {
        id: "gateway-url-log-redaction",
      } as unknown as PluginInput["project"],
      directory: process.cwd(),
      worktree: process.cwd(),
      serverUrl: new URL("http://localhost:0"),
      $: {} as unknown as PluginInput["$"],
    });

    const logged = infoSpy.mock.calls.flat().join(" ");
    const emitted = sinkMessages.join(" ");
    for (const secret of [
      pathSecret,
      querySecret,
      fragmentSecret,
      userSecret,
      passwordSecret,
    ]) {
      expect(logged).not.toContain(secret);
      expect(emitted).not.toContain(secret);
    }
    expect(logged).toContain("gateway detected at");
    expect(emitted).toContain("routing through");
  } finally {
    infoSpy.mockRestore();
    globalThis.fetch = originalFetch;
    process.env = { ...savedEnv };
    log.registerSink({
      info: () => {},
      warn: () => {},
      error: () => {},
      captureException: () => {},
    });
    log.silenceStderr(false);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
