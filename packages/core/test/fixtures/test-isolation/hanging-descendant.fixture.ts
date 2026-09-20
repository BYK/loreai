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
  const pendingMarker = `${marker}.pending`;
  writeFileSync(pendingMarker, JSON.stringify({ pid: descendant.pid }));
  renameSync(pendingMarker, marker);
  await new Promise<never>(() => {});
});
