import { mkdir } from "node:fs/promises";
import {
  createOwnedRoot,
  removeOwnedPath,
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
  let initializing = true;
  let cleanupComplete = false;
  let cleanupInProgress = false;

  const onExit = (): void => {
    if (cleanupComplete) return;
    if (!owned) {
      restoreEnvironment(previousEnvironment);
      cleanupComplete = true;
      return;
    }
    try {
      removeOwnedPathSync(owned);
      restoreEnvironment(previousEnvironment);
      cleanupComplete = true;
    } catch (error) {
      reportCleanupFailure(error);
    }
  };
  const onSignal = (signal: "SIGINT" | "SIGTERM"): void => {
    if (pendingSignal || cleanupComplete) return;
    pendingSignal = signal;
    if (initializing || cleanupInProgress) return;
    process.exitCode = signal === "SIGINT" ? 130 : 143;
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
  let shouldRun = true;
  try {
    owned = await createOwnedRoot(
      options.createRoot ?? { prefix: "lore-eval-run-" },
    );
    if (pendingSignal) {
      shouldRun = false;
    }
    const databaseRoot = `${owned.path}/database`;
    await mkdir(databaseRoot);
    process.env.LORE_TEST_DB_ROOT = databaseRoot;
    process.env.LORE_DB_PATH = `${databaseRoot}/test.db`;
    process.env.XDG_DATA_HOME = `${databaseRoot}/xdg`;
    initializing = false;
    if (shouldRun) await run();
  } catch (error) {
    runFailed = true;
    runError = error;
  } finally {
    initializing = false;
  }

  cleanupInProgress = true;
  try {
    if (owned) await removeOwnedPath(owned);
    restoreEnvironment(previousEnvironment);
    cleanupComplete = true;
  } catch (error) {
    cleanupFailed = true;
    cleanupError = error;
  }
  cleanupInProgress = false;

  if (!cleanupFailed) {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    process.off("exit", onExit);
  }

  if (runFailed && cleanupFailed) {
    const error = new AggregateError(
      [runError, cleanupError],
      "eval run and cleanup failed",
    );
    if (pendingSignal) process.kill(process.pid, pendingSignal);
    throw error;
  }
  if (runFailed) {
    if (pendingSignal) process.kill(process.pid, pendingSignal);
    throw runError;
  }
  if (cleanupFailed) {
    if (pendingSignal) process.kill(process.pid, pendingSignal);
    throw cleanupError;
  }
  if (pendingSignal) process.kill(process.pid, pendingSignal);
}
