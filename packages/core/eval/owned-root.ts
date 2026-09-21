import { mkdir } from "node:fs/promises";
import {
  createOwnedRoot,
  removeOwnedPathSync,
} from "../test/helpers/owned-path";
import type {
  CreateOwnedRootOptions,
  OwnedPath,
} from "../test/helpers/owned-path";

interface PreviousEnvironment {
  LORE_TEST_DB_ROOT: string | undefined;
  LORE_DB_PATH: string | undefined;
  XDG_DATA_HOME: string | undefined;
}

export interface OwnedDatabaseRootOptions {
  createRoot?: CreateOwnedRootOptions;
}

function captureEnvironment(): PreviousEnvironment {
  return {
    LORE_TEST_DB_ROOT: process.env.LORE_TEST_DB_ROOT,
    LORE_DB_PATH: process.env.LORE_DB_PATH,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  };
}

function restoreEnvironment(previous: PreviousEnvironment): void {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function cleanupOwnedRoot(
  owned: OwnedPath,
  previous: PreviousEnvironment,
): void {
  restoreEnvironment(previous);
  removeOwnedPathSync(owned);
}

function reportCleanupFailure(error: unknown): void {
  process.exitCode = 1;
  if (process.env.LORE_DEBUG === "1" || process.env.LORE_DEBUG === "true") {
    process.stderr.write(
      `eval database cleanup failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
    );
  }
}

/**
 * Run work with an isolated database root and clean it up on every exit path.
 * Cleanup is synchronous after the work completes so a signal cannot interrupt
 * an async pathname check between validation and removal.
 */
export async function withOwnedDatabaseRoot(
  run: () => Promise<void>,
  options: OwnedDatabaseRootOptions = {},
): Promise<void> {
  const previousEnvironment = captureEnvironment();
  let owned: OwnedPath | undefined;
  let pendingSignal: "SIGINT" | "SIGTERM" | undefined;
  let signalHandling = false;

  const onExit = (): void => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    if (!owned) {
      restoreEnvironment(previousEnvironment);
      return;
    }
    try {
      cleanupOwnedRoot(owned, previousEnvironment);
    } catch (error) {
      reportCleanupFailure(error);
    }
  };
  const onSignal = (signal: "SIGINT" | "SIGTERM"): void => {
    if (signalHandling) return;
    signalHandling = true;
    if (!owned) {
      pendingSignal = signal;
      return;
    }
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    try {
      cleanupOwnedRoot(owned, previousEnvironment);
    } catch (error) {
      reportCleanupFailure(error);
    } finally {
      process.kill(process.pid, signal);
    }
  };
  const onSigint = (): void => onSignal("SIGINT");
  const onSigterm = (): void => onSignal("SIGTERM");

  process.once("exit", onExit);
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  let runFailed = false;
  let runError: unknown;
  let cleanupFailed = false;
  let cleanupError: unknown;
  try {
    owned = await createOwnedRoot(
      options.createRoot ?? { prefix: "lore-eval-run-" },
    );
    if (pendingSignal) {
      const signal = pendingSignal;
      pendingSignal = undefined;
      signalHandling = false;
      try {
        onSignal(signal);
      } finally {
        process.off("exit", onExit);
      }
      return;
    }
    const databaseRoot = `${owned.path}/database`;
    await mkdir(databaseRoot);
    process.env.LORE_TEST_DB_ROOT = databaseRoot;
    process.env.LORE_DB_PATH = `${databaseRoot}/test.db`;
    process.env.XDG_DATA_HOME = `${databaseRoot}/xdg`;
    await run();
  } catch (error) {
    runFailed = true;
    runError = error;
  }

  try {
    if (owned) cleanupOwnedRoot(owned, previousEnvironment);
    else restoreEnvironment(previousEnvironment);
  } catch (error) {
    cleanupFailed = true;
    cleanupError = error;
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    process.off("exit", onExit);
  }

  if (runFailed && cleanupFailed) {
    throw new AggregateError(
      [runError, cleanupError],
      "eval run and cleanup failed",
    );
  }
  if (runFailed) throw runError;
  if (cleanupFailed) throw cleanupError;
}
