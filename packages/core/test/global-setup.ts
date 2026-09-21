import { createOwnedRoot, removeOwnedPathSync } from "./helpers/owned-path";
import type { TestProject } from "vitest/node";

function reportCleanupFailure(error: unknown): void {
  process.exitCode = 1;
  if (process.env.LORE_DEBUG === "1" || process.env.LORE_DEBUG === "true") {
    process.stderr.write(
      `test database cleanup failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
    );
  }
}

export default async function setup(
  project: TestProject,
): Promise<() => Promise<void>> {
  const owned = await createOwnedRoot({ prefix: "lore-test-run-" });
  project.provide("loreTestRoot", owned.path);

  const removeOwnedRoot = (): void => {
    try {
      removeOwnedPathSync(owned);
    } catch (error) {
      reportCleanupFailure(error);
    }
  };
  const onExit = (): void => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    removeOwnedRoot();
  };
  const onSignal = (signal: "SIGINT" | "SIGTERM"): void => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);

    // Vitest may own worker shutdown through another signal handler. Inspect the
    // live listener set after removing Lore's handlers, not a setup-time snapshot.
    if (process.listenerCount(signal) === 0) {
      try {
        removeOwnedPathSync(owned);
      } catch (error) {
        reportCleanupFailure(error);
      } finally {
        process.kill(process.pid, signal);
      }
    }
  };
  const onSigint = (): void => onSignal("SIGINT");
  const onSigterm = (): void => onSignal("SIGTERM");

  // Global teardown runs before Vitest closes its worker pool. Keep cleanup on
  // process exit so live workers cannot race recursive removal.
  process.once("exit", onExit);
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  return async () => {};
}
