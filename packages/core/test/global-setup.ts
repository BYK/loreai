import {
  createOwnedRoot,
  removeOwnedPathSync,
  type CreateOwnedRootOptions,
  type OwnedPath,
} from "./helpers/owned-path";
import type { TestProject } from "vitest/node";

function reportCleanupFailure(error: unknown): void {
  process.exitCode = 1;
  if (process.env.LORE_DEBUG === "1" || process.env.LORE_DEBUG === "true") {
    process.stderr.write(
      `test database cleanup failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
    );
  }
}

export interface GlobalSetupDependencies {
  createRoot?: (options: CreateOwnedRootOptions) => Promise<OwnedPath>;
}

export default async function setup(
  project: TestProject,
  dependencies: GlobalSetupDependencies = {},
): Promise<() => Promise<void>> {
  let owned: OwnedPath | undefined;
  let pendingSignal: "SIGINT" | "SIGTERM" | undefined;
  let initializing = true;
  let cleaned = false;

  const removeOwnedRootSync = (): void => {
    if (cleaned) return;
    if (!owned) return;
    try {
      removeOwnedPathSync(owned);
      cleaned = true;
    } catch (error) {
      reportCleanupFailure(error);
    }
  };
  const onExit = (): void => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    removeOwnedRootSync();
  };
  const onSignal = (signal: "SIGINT" | "SIGTERM"): void => {
    if (initializing) {
      pendingSignal ??= signal;
      return;
    }
    if (pendingSignal && pendingSignal !== signal) return;
    pendingSignal = signal;
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);

    // Vitest may own worker shutdown through another signal handler. Inspect the
    // live listener set after removing Lore's handlers, not a setup-time snapshot.
    if (process.listenerCount(signal) === 0) {
      removeOwnedRootSync();
      process.kill(process.pid, signal);
    }
  };
  const onSigint = (): void => onSignal("SIGINT");
  const onSigterm = (): void => onSignal("SIGTERM");

  // Global teardown runs before Vitest closes its worker pool. Keep cleanup on
  // process exit so live workers cannot race recursive removal.
  process.once("exit", onExit);
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  try {
    owned = await (dependencies.createRoot ?? createOwnedRoot)({
      prefix: "lore-test-run-",
    });
    project.provide("loreTestRoot", owned.path);
    initializing = false;
    if (pendingSignal) {
      const signal = pendingSignal;
      pendingSignal = undefined;
      onSignal(signal);
    }
  } catch (error) {
    initializing = false;
    const signal = pendingSignal;
    pendingSignal = undefined;
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    process.off("exit", onExit);
    if (owned) removeOwnedRootSync();
    if (signal) process.kill(process.pid, signal);
    throw error;
  }

  // Keep the root until process exit: Vitest global-setup teardown functions
  // run in reverse order, and later teardown functions may recreate artifacts
  // that the coordinator must sweep before the process exits.
  return async () => {};
}
