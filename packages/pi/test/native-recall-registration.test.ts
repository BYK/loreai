import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { RECALL_TOOL_NAME } from "@loreai/core";
import lorePiExtension from "../src/index";
import { shouldRegisterNativeRecallTool } from "../src/internal";

// Exercise real discovery and extension registration without installing a
// process-wide fetch interceptor or starting the actual gateway.
vi.mock("@loreai/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@loreai/core")>()),
  installFetchInterceptor: vi.fn(),
}));
vi.mock("@loreai/gateway", () => ({
  prepareSourceUiAssets: async () => ({ attempted: false }),
}));

const savedEnv = { ...process.env };
let server: Server;
let localUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(req.url === "/health" ? 200 : 404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  localUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  process.env = { ...savedEnv };
  vi.unstubAllGlobals();
});

async function register(remoteUrl?: string, gatewayUrl?: string) {
  process.env.LORE_PI_FORCE_ACTIVE = "1";
  process.env.LORE_GATEWAY_AUTH_TOKEN = "remote-access-token";
  delete process.env.LORE_DISABLED;
  delete process.env.LORE_REMOTE_URL;
  delete process.env.LORE_GATEWAY_URL;
  if (remoteUrl) process.env.LORE_REMOTE_URL = remoteUrl;
  if (gatewayUrl) process.env.LORE_GATEWAY_URL = gatewayUrl;
  const pi = {
    registerTool: vi.fn(),
    registerProvider: vi.fn(),
    on: vi.fn(),
  };
  await lorePiExtension(pi as unknown as Parameters<typeof lorePiExtension>[0]);
  // A zero-tool result must come from a live remote configuration, not an
  // inert extension or failed gateway discovery.
  expect(pi.registerProvider).toHaveBeenCalled();
  return pi;
}

test("does not expose host recall through a non-loopback LORE_GATEWAY_URL", async () => {
  const fetchMock = vi.fn(async () => new Response("ok"));
  vi.stubGlobal("fetch", fetchMock);
  const pi = await register(undefined, "https://gateway.example/lore");
  expect(fetchMock).toHaveBeenCalledWith(
    "https://gateway.example/lore/health",
    expect.anything(),
  );
  expect(pi.registerTool).not.toHaveBeenCalled();
  expect(pi.registerProvider.mock.calls[0][1].headers).not.toHaveProperty(
    "x-lore-gateway-token",
  );
});

test.each([
  ["plain", ""],
  ["userinfo", "userinfo"],
  ["query", "query"],
  ["userinfo and query", "both"],
])(
  "does not expose host recall for a %s loopback remote",
  async (_label, kind) => {
    const remote = new URL(localUrl);
    if (kind === "userinfo" || kind === "both") {
      remote.username = "user";
      remote.password = "private-userinfo";
    }
    if (kind === "query" || kind === "both")
      remote.search = "?token=private-query";
    remote.hash = "private-fragment";
    const pi = await register(remote.href);
    expect(pi.registerTool).not.toHaveBeenCalled();
    expect(pi.registerProvider.mock.calls[0][1].baseUrl).toBe(localUrl);
    // Recall ownership matching must not broaden the existing token policy.
    expect(pi.registerProvider.mock.calls[0][1].headers).not.toHaveProperty(
      "x-lore-gateway-token",
    );
  },
);

test("keeps native recall for a verified local gateway", async () => {
  const pi = await register(undefined, localUrl);
  expect(pi.registerTool).toHaveBeenCalledOnce();
  expect(pi.registerTool.mock.calls[0][0].name).toBe(RECALL_TOOL_NAME);
});

test("ignores a legacy access token while preserving remote recall ownership", async () => {
  const pi = await register(localUrl);
  expect(pi.registerTool).not.toHaveBeenCalled();
  expect(pi.registerProvider.mock.calls[0][1].headers).not.toHaveProperty(
    "x-lore-gateway-token",
  );
});

test.each(["different host", "different path"])(
  "keeps local recall after an unreachable remote at a %s falls back",
  async (kind) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unavailable", { status: 503 })),
    );
    const remoteUrl =
      kind === "different host"
        ? "https://gateway.example"
        : `${localUrl}/remote`;
    const pi = await register(remoteUrl, localUrl);
    expect(pi.registerTool).toHaveBeenCalledOnce();
    expect(pi.registerProvider.mock.calls[0][1].baseUrl).toBe(localUrl);
    expect(pi.registerProvider.mock.calls[0][1].headers).not.toHaveProperty(
      "x-lore-gateway-token",
    );
  },
);

test.each([
  ["http://localhost:3207", true],
  ["http://localhost.:3207", true],
  ["http://127.0.0.2:3207", true],
  ["http://[::1]:3207", true],
  ["https://localhost:3207", true],
  ["http://localhost.example:3207", false],
  ["http://192.168.1.2:3207", false],
  ["file://localhost/lore", false],
  ["ws://localhost:3207", false],
  ["invalid", false],
])("native recall eligibility for %s is %s", (gatewayUrl, expected) => {
  expect(shouldRegisterNativeRecallTool(gatewayUrl, {})).toBe(expected);
});
