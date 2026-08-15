import { dirname, join } from "node:path";
import { rmSync } from "node:fs";
import { afterEach, describe, expect, test, vi } from "vitest";
import { startGateway } from "../src/cli/start";
import {
  acquireLifecycleLock,
  createUninstallTombstone,
  LifecycleLockBusyError,
} from "../src/lifecycle-lock";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("gateway lifecycle production wiring", () => {
  test("active uninstall blocks gateway start before listener creation", async () => {
    const lock = await acquireLifecycleLock("uninstall");
    vi.useFakeTimers();
    try {
      const pending = startGateway({ port: 0, local: true, quiet: true });
      const rejection = expect(pending).rejects.toBeInstanceOf(
        LifecycleLockBusyError,
      );
      await vi.advanceTimersByTimeAsync(5000);
      await rejection;
    } finally {
      lock.release();
    }
  });

  test("a persisted uninstall generation blocks a fresh gateway start", async () => {
    const lock = await acquireLifecycleLock("uninstall");
    const marker = join(dirname(lock.path), "uninstalled.json");
    createUninstallTombstone(lock);
    lock.release();
    try {
      await expect(
        startGateway({ port: 0, local: true, quiet: true }),
      ).rejects.toThrow(/Lore is uninstalled/);
    } finally {
      rmSync(marker, { force: true });
    }
  });
});
