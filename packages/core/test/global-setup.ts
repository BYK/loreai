import { lstatSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";

interface RootIdentity {
  dev: bigint;
  ino: bigint;
}

function ownedRootExists(root: string, identity: RootIdentity): boolean {
  try {
    const current = lstatSync(root, { bigint: true });
    return (
      current.isDirectory() &&
      current.dev === identity.dev &&
      current.ino === identity.ino
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function removeOwnedRoot(root: string, identity: RootIdentity): void {
  if (!ownedRootExists(root, identity)) return;
  rmSync(root, {
    recursive: true,
    force: true,
    maxRetries: process.platform === "win32" ? 5 : 0,
    retryDelay: 100,
  });
}

export default async function setup(
  project: TestProject,
): Promise<() => Promise<void>> {
  const root = await mkdtemp(join(tmpdir(), "lore-test-run-"));
  project.provide("loreTestRoot", root);
  const created = lstatSync(root, { bigint: true });
  const identity: RootIdentity = Object.freeze({
    dev: created.dev,
    ino: created.ino,
  });
  const removeOwnedRootBestEffort = () => {
    try {
      removeOwnedRoot(root, identity);
    } catch {
      // Exit and unhandled-signal cleanup cannot recover or report through the
      // coordinator. Per-file and fixture-owned cleanup report failures earlier.
    }
  };
  const onExit = () => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    removeOwnedRootBestEffort();
  };
  const onSignal = (signal: "SIGINT" | "SIGTERM") => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);

    // Vitest normally owns worker shutdown through another signal handler. Test
    // the live listener set after removing Lore's handlers: a handler captured
    // during setup may have been removed before the signal arrives.
    if (process.listenerCount(signal) === 0) {
      removeOwnedRootBestEffort();
      process.kill(process.pid, signal);
    }
  };
  const onSigint = () => onSignal("SIGINT");
  const onSigterm = () => onSignal("SIGTERM");

  // Arm final cleanup immediately. Global teardown runs before Vitest closes
  // its worker pool, so registering these callbacks there leaves an early-exit
  // window in which database, WAL, and SHM files survive.
  process.once("exit", onExit);
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  // Vitest runs global teardown before closing its worker pool. Deleting here
  // would race live workers; onExit performs the exact-root cleanup after the
  // pool has closed.
  return async () => {};
}
