import { existsSync } from "node:fs";
import { afterEach, describe, expect, test } from "vitest";
import { MockAgent } from "undici";
import { db } from "../../core/src/db";
import { setUpstreamDispatcherForTest, upstreamFetch } from "../src/fetch";
import { fetchModelData } from "../src/worker-model";
import { resetPipelineState } from "../src/pipeline";
import { createHarness, type Harness } from "./helpers/harness";
import { makeConversationFixtures } from "./helpers/fixtures";
import {
  installOfflineModelsDevDispatcher,
  offlineModelsDevRequestCount,
  resetOfflineModelsDevRequestCount,
  uninstallOfflineModelsDevDispatcher,
} from "./helpers/models-dev-dispatcher";

describe("models.dev test isolation", () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.teardown();
    harness = undefined;
    await resetPipelineState();
  });

  test("the real pipeline pre-warm uses canned data with network disabled", async () => {
    resetOfflineModelsDevRequestCount();
    harness = await createHarness({
      fixtures: makeConversationFixtures([
        { userMessage: "hello", assistantText: "hello from fixture" },
      ]),
    });

    const response = await harness.chat({
      model: "claude-sonnet-4-20250514",
      system: "test",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 16,
      stream: false,
    });
    expect(response.ok).toBe(true);

    const models = await fetchModelData();
    expect(models.get("offline-isolation-model")).toMatchObject({
      id: "offline-isolation-model",
      limit: { context: 300_000, output: 32_000 },
    });
    expect(offlineModelsDevRequestCount()).toBe(1);
  });

  test("the models.dev guard preserves route-specific upstream dispatchers", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    mock
      .get("https://upstream.example")
      .intercept({ path: "/models", method: "GET" })
      .reply(200, { data: [{ id: "routed-model" }] });
    setUpstreamDispatcherForTest(mock);

    try {
      const response = await upstreamFetch("https://upstream.example/models");
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        data: [{ id: "routed-model" }],
      });
    } finally {
      setUpstreamDispatcherForTest(null);
      await mock.close();
    }
  });

  test("dispatcher teardown does not replace a newer route owner", async () => {
    await installOfflineModelsDevDispatcher();
    const replacement = new MockAgent();
    replacement.disableNetConnect();
    replacement
      .get("https://upstream.example")
      .intercept({ path: "/models", method: "GET" })
      .reply(200, { data: [{ id: "replacement-model" }] });
    const { setUpstreamDispatcherForTest } = await import("../src/fetch");
    setUpstreamDispatcherForTest(replacement);

    try {
      await uninstallOfflineModelsDevDispatcher();
      const response = await upstreamFetch("https://upstream.example/models");
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        data: [{ id: "replacement-model" }],
      });
    } finally {
      setUpstreamDispatcherForTest(null);
      await replacement.close();
    }
  });

  test("nested models.dev installations keep the shared owner alive", async () => {
    await installOfflineModelsDevDispatcher();
    await installOfflineModelsDevDispatcher();

    try {
      await uninstallOfflineModelsDevDispatcher();
      const response = await upstreamFetch("https://models.dev/api.json");
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        anthropic: { models: { "offline-isolation-model": expect.anything() } },
      });
    } finally {
      await uninstallOfflineModelsDevDispatcher();
    }
  });

  test("a fixture gateway connection failure closes and removes its database", async () => {
    await expect(
      createHarness({
        fixtures: [],
        beforeConfigLoad() {
          db();
          throw new Error("intentional fixture startup failure");
        },
      }),
    ).rejects.toThrow("intentional fixture startup failure");

    const failedDatabase = process.env.LORE_DB_PATH;
    if (!failedDatabase) throw new Error("failed database path was not set");
    for (const suffix of ["", "-shm", "-wal"]) {
      expect(existsSync(`${failedDatabase}${suffix}`)).toBe(false);
    }

    harness = await createHarness({ fixtures: [] });
  });
});
