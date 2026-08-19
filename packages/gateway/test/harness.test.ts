import { afterEach, describe, expect, test } from "vitest";
import { existsSync, unlinkSync } from "node:fs";
import type { Harness } from "./helpers/harness";
import { createHarness } from "./helpers/harness";
import {
  DEFAULT_MODEL,
  DEFAULT_SYSTEM,
  STANDARD_TOOLS,
  makeConversationFixtures,
} from "./helpers/fixtures";

function isUnavailableBind(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth++) {
    if (typeof current === "object") {
      const record = current as { code?: unknown; cause?: unknown };
      if (record.code === "EADDRINUSE" || record.code === "EACCES") return true;
      current = record.cause;
      continue;
    }
    break;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /EADDRINUSE|EACCES|port\b.*\bin use|permission denied/i.test(message);
}

async function cleanupFailedHarnessAttempt(dbPath?: string): Promise<void> {
  const { close } = await import("@loreai/core");
  const { resetPipelineState, setUpstreamInterceptor } =
    await import("../src/pipeline");
  close();
  await resetPipelineState();
  setUpstreamInterceptor(undefined);
  if (!dbPath) return;
  for (const suffix of ["", "-shm", "-wal"]) {
    const file = `${dbPath}${suffix}`;
    if (existsSync(file)) unlinkSync(file);
  }
}

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

  test("loopback requests work on a WHATWG fetch-blocked port", async () => {
    const forbiddenPorts = [6667, 6666, 6668, 6669, 6697, 6566, 6000, 5060];
    const userMessage = "Test the loopback harness transport.";
    const fixtures = makeConversationFixtures([
      { userMessage, assistantText: "Loopback transport works." },
    ]);
    const unavailable: number[] = [];
    for (const candidate of forbiddenPorts) {
      try {
        harness = await createHarness({
          configOverrides: { port: candidate },
          fixtures,
        });
        break;
      } catch (error) {
        const failedDbPath = process.env.LORE_DB_PATH;
        await cleanupFailedHarnessAttempt(failedDbPath);
        if (!isUnavailableBind(error)) throw error;
        unavailable.push(candidate);
      }
    }
    if (!harness) {
      throw new Error(
        `could not bind any WHATWG forbidden port: ${unavailable.join(", ")}`,
      );
    }

    const health = await harness.request("/health");
    expect(health.status).toBe(200);

    const response = await harness.chat({
      model: DEFAULT_MODEL,
      max_tokens: 128,
      stream: false,
      system: DEFAULT_SYSTEM,
      messages: [{ role: "user", content: userMessage }],
      tools: STANDARD_TOOLS,
    });

    expect(response.status).toBe(200);
  });
});
