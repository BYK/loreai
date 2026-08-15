import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import {
  _resetForTest,
  checkCircuitBreaker,
  isCircuitBreakerTripped,
  isWarmingEnabled,
  resetCircuitBreaker,
  setWarmingEnabled,
} from "../src/cache-warmer";
import {
  createHarness,
  TEST_GATEWAY_AUTH_TOKEN,
  type Harness,
} from "./helpers/harness";
import { DEFAULT_MODEL } from "./helpers/fixtures";

const ACCESS_HEADER = "x-lore-gateway-token";
const TENANTS = ["tenant-a-provider-key", "tenant-b-provider-key"] as const;
const BUCKETS = [
  "tenant-a\x1fmodel\x1fupstream",
  "tenant-b\x1fmodel\x1fupstream",
];

function slashBody(command: string): Record<string, unknown> {
  return {
    model: DEFAULT_MODEL,
    max_tokens: 64,
    messages: [{ role: "user", content: command }],
  };
}

function tripBreakers(): void {
  const miss = {
    ok: true,
    cacheReadTokens: 0,
    cacheCreationTokens: 1,
  };
  for (const bucket of BUCKETS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      checkCircuitBreaker(miss, bucket, true);
    }
    expect(isCircuitBreakerTripped(bucket)).toBe(true);
  }
}

describe("remote warming administration isolation", () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness({
      fixtures: [],
      configOverrides: {
        remoteGateway: true,
        hostedMode: true,
        gatewayAuthToken: TEST_GATEWAY_AUTH_TOKEN,
      },
    });
  });

  afterEach(() => {
    setWarmingEnabled(true);
    _resetForTest();
  });

  afterAll(async () => {
    setWarmingEnabled(true);
    resetCircuitBreaker();
    await harness.teardown();
  });

  test.each([
    [TENANTS[0], TENANTS[1]],
    [TENANTS[1], TENANTS[0]],
  ])(
    "rejects two tenants in provider-key order %s then %s",
    async (first, second) => {
      setWarmingEnabled(false);
      for (const tenant of [first, second]) {
        const response = await harness.chat(
          slashBody("/lore:warm:on"),
          tenant,
          { [ACCESS_HEADER]: TEST_GATEWAY_AUTH_TOKEN },
        );
        expect(response.status).toBe(403);
        expect(await response.text()).toContain(
          "Global cache-warming administration is unavailable",
        );
        expect(isWarmingEnabled()).toBe(false);
      }

      setWarmingEnabled(true);
      for (const tenant of [first, second]) {
        const response = await harness.chat(
          slashBody("/lore:warm:off"),
          tenant,
          { [ACCESS_HEADER]: TEST_GATEWAY_AUTH_TOKEN },
        );
        expect(response.status).toBe(403);
        await response.body?.cancel();
        expect(isWarmingEnabled()).toBe(true);
      }

      tripBreakers();
      for (const tenant of [first, second]) {
        const response = await harness.chat(
          slashBody("/lore:warm:reset"),
          tenant,
          { [ACCESS_HEADER]: TEST_GATEWAY_AUTH_TOKEN },
        );
        expect(response.status).toBe(403);
        await response.body?.cancel();
        for (const bucket of BUCKETS) {
          expect(isCircuitBreakerTripped(bucket)).toBe(true);
        }
      }
    },
  );

  test.each(["/lore:warm:on", "/lore:warm:off", "/lore:warm:reset"])(
    "rejects gateway-token-only request for %s",
    async (command) => {
      setWarmingEnabled(false);
      tripBreakers();

      const response = await harness.chat(slashBody(command), null, {
        [ACCESS_HEADER]: TEST_GATEWAY_AUTH_TOKEN,
      });

      expect(response.status).toBe(403);
      expect(await response.text()).toContain(
        "Global cache-warming administration is unavailable",
      );
      expect(isWarmingEnabled()).toBe(false);
      for (const bucket of BUCKETS) {
        expect(isCircuitBreakerTripped(bucket)).toBe(true);
      }
    },
  );
});
