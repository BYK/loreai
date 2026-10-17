import { beforeEach, describe, expect, it, vi } from "vitest";
import { keystore, syncData } from "@loreai/core";
import { loadConfig, type GatewayConfig } from "../src/config";
import { handleSyncRunRequest } from "../src/sync-run";

const syncMocks = vi.hoisted(() => ({
  syncOnce: vi.fn(),
}));

vi.mock("../src/sync", () => ({
  syncOnce: syncMocks.syncOnce,
}));

vi.mock("../src/supabase", () => ({
  getAuthedClient: vi.fn(async () => ({})),
  loadPersistedSession: vi.fn(() => ({
    user_id: "11111111-1111-4111-8111-111111111111",
    access_token: "access",
  })),
}));

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    ...loadConfig(),
    port: 0,
    remoteGateway: false,
    hostedMode: false,
    allowRemoteManagement: false,
    ...overrides,
  };
}

async function request(
  body?: string,
  config = makeConfig(),
): Promise<Response> {
  const url = new URL("/api/v1/sync/run", "http://127.0.0.1");
  return (
    (await handleSyncRunRequest(
      new Request(url, {
        method: "POST",
        ...(body === undefined
          ? {}
          : {
              headers: { "Content-Type": "application/json" },
              body,
            }),
      }),
      url.pathname,
      config,
    )) ?? new Response(null, { status: 404 })
  );
}

beforeEach(() => {
  if (syncData.isSyncEnabled()) syncData.disableSync();
  keystore.lock();
  syncMocks.syncOnce.mockReset();
  syncMocks.syncOnce.mockResolvedValue({
    pushed: 2,
    pulled: 3,
    conflicts: 1,
    skipped: 0,
  });
});

describe("POST /api/v1/sync/run", () => {
  it("rejects hosted writes before parsing the body", async () => {
    const response = await request("{", makeConfig({ hostedMode: true }));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { type: "forbidden" },
    });
  });

  it("strictly accepts only an empty JSON object", async () => {
    const malformed = await request("{");
    expect(malformed.status).toBe(400);
    const extra = await request(JSON.stringify({ force: true }));
    expect(extra.status).toBe(400);
    expect(syncMocks.syncOnce).not.toHaveBeenCalled();
  });

  it("requires sync and encryption to be ready", async () => {
    const disabled = await request("{}");
    expect(disabled.status).toBe(409);
    expect(await disabled.json()).toMatchObject({
      error: { type: "sync_disabled" },
    });

    syncData.enableSync();
    const locked = await request("{}");
    expect(locked.status).toBe(409);
    expect(await locked.json()).toMatchObject({
      error: { type: "encryption_locked" },
    });
    expect(syncMocks.syncOnce).not.toHaveBeenCalled();
  });

  it("runs one sync cycle and returns its structured receipt", async () => {
    syncData.enableSync();
    keystore.setPassphrase("test-passphrase", {
      params: { t: 1, m: 256, p: 1 },
    });
    const response = await request("{}");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      pushed: 2,
      pulled: 3,
      conflicts: 1,
      skipped: 0,
    });
    expect(syncMocks.syncOnce).toHaveBeenCalledTimes(1);
  });
});
