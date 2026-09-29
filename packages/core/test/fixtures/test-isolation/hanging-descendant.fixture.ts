import { spawn } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";
import { test } from "vitest";

test("starts a hanging descendant that inherits the coordinator pipes", async () => {
  const descendant = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1_000)"],
    { stdio: "inherit" },
  );
  if (!descendant.pid) throw new Error("descendant PID is unavailable");

  const marker = process.env.LORE_TEST_ISOLATION_MARKER;
  if (!marker) throw new Error("LORE_TEST_ISOLATION_MARKER is required");
  const readyDelayMs = Number(
    process.env.LORE_TEST_ISOLATION_READY_DELAY_MS ?? "0",
  );
  if (!Number.isSafeInteger(readyDelayMs) || readyDelayMs < 0) {
    throw new Error("invalid fixture readiness delay");
  }
  if (readyDelayMs) {
    await new Promise<void>((resolve) => setTimeout(resolve, readyDelayMs));
  }
  const pendingMarker = `${marker}.pending`;
  writeFileSync(pendingMarker, JSON.stringify({ pid: descendant.pid }));
  renameSync(pendingMarker, marker);
  await new Promise<never>(() => {});
});
