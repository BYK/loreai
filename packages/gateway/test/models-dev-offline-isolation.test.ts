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

  test("overlapping models.dev installations share one live owner", async () => {
    await Promise.all([
      installOfflineModelsDevDispatcher(),
      installOfflineModelsDevDispatcher(),
    ]);

    try {
      const response = await upstreamFetch("https://models.dev/api.json");
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        anthropic: { models: { "offline-isolation-model": expect.anything() } },
      });
    } finally {
      await Promise.all([
        uninstallOfflineModelsDevDispatcher(),
        uninstallOfflineModelsDevDispatcher(),
      ]);
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

  test("an invalid bound port uses the complete harness cleanup path", async () => {
    let stopCalls = 0;
    await expect(
      createHarness({
        fixtures: [],
        beforeConfigLoad() {
          db();
        },
        startServer: async () => ({
          port: 0,
          async stop() {
            stopCalls++;
          },
        }),
      }),
    ).rejects.toThrow("resolved invalid port 0");
    expect(stopCalls).toBe(1);
  });

  test("an invalid port reports stop failure without skipping cleanup", async () => {
    let stopCalls = 0;
    let failure: unknown;
    try {
      await createHarness({
        fixtures: [],
        beforeConfigLoad() {
          db();
        },
        startServer: async () => ({
          port: Number.NaN,
          async stop() {
            stopCalls++;
            throw new Error("intentional invalid-port stop failure");
          },
        }),
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError))
      throw new Error("missing failure");
    const cleanupFailure = failure.errors.find(
      (error): error is AggregateError => error instanceof AggregateError,
    );
    expect(cleanupFailure).toBeDefined();
    expect(cleanupFailure?.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "intentional invalid-port stop failure",
        }),
      ]),
    );
    expect(stopCalls).toBe(1);
    const failedDatabase = process.env.LORE_DB_PATH;
    if (!failedDatabase) throw new Error("failed database path was not set");
    expect(existsSync(failedDatabase)).toBe(true);
  });
});
