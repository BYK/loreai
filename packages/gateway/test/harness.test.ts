import { afterEach, describe, expect, test } from "vitest";
import type { Harness } from "./helpers/harness";
import { createHarness } from "./helpers/harness";

describe("gateway test harness", () => {
  let harness: Harness | undefined;
  const originalPort = process.env.LORE_LISTEN_PORT;

  afterEach(async () => {
    await harness?.teardown();
    if (originalPort === undefined) delete process.env.LORE_LISTEN_PORT;
    else process.env.LORE_LISTEN_PORT = originalPort;
  });

  test("pins the requested port instead of re-reading shared process state", async () => {
    harness = await createHarness({
      fixtures: [],
      beforeConfigLoad: () => {
        process.env.LORE_LISTEN_PORT = "1";
      },
    });
    const port = Number(new URL(harness.baseURL).port);
    expect(port).toBeGreaterThan(0);
    expect(port).not.toBe(1);
  });
});
