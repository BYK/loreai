import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, watch } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const REPO_ROOT = resolve(__dirname, "../../..");
const VITEST = join(REPO_ROOT, "node_modules/vitest/vitest.mjs");
const FIXTURE_CONFIG = join(
  REPO_ROOT,
  "packages/core/test/fixtures/test-isolation/vitest.config.ts",
);
const FIXTURE_DIR = join(
  REPO_ROOT,
  "packages/core/test/fixtures/test-isolation",
);
const CHILD_TIMEOUT_MS = 30_000;
const PROCESS_EXIT_TIMEOUT_MS = 5_000;
const KILL_GRACE_MS = 2_000;
const MAX_CAPTURED_OUTPUT_BYTES = 256 * 1024;

interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

interface RootSnapshot {
  providedRoot: string | null;
  roots: Array<{ path: string; entries: string[] }>;
}

interface FixtureMarker {
  root?: string;
  directory?: string;
  database: string;
  databaseExists?: boolean;
  directoryWasRemoved?: boolean;
}

interface StartFixtureOptions {
  timeoutMs?: number;
  readyPath?: string;
  descendantPidPath?: string;
}

interface ActiveFixture {
  result: Promise<ChildResult>;
  terminate: (error: Error) => Promise<void>;
}

interface BoundedCapture {
  chunks: Buffer[];
  bytes: number;
  truncated: boolean;
}

const children = new Map<ChildProcess, ActiveFixture>();
const tempDirs = new Set<string>();

const INHERITED_CHILD_ENV_KEYS = [
  "APPDATA",
  "CI",
  "ComSpec",
  "FORCE_COLOR",
  "HOME",
  "LANG",
  "LC_ALL",
  "LOCALAPPDATA",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NO_COLOR",
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "TERM",
  "TZ",
  "USERPROFILE",
  "WINDIR",
] as const;

function fixtureEnvironment(
  parent: string,
  overrides: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(
    INHERITED_CHILD_ENV_KEYS.flatMap((key) => {
      const value = process.env[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
  return {
    ...inherited,
    ...overrides,
    TMPDIR: parent,
    TMP: parent,
    TEMP: parent,
  };
}

function captureOutput(capture: BoundedCapture, chunk: Buffer): void {
  const remaining = MAX_CAPTURED_OUTPUT_BYTES - capture.bytes;
  if (remaining <= 0) {
    capture.truncated = true;
    return;
  }
  const retained = chunk.subarray(0, remaining);
  capture.chunks.push(retained);
  capture.bytes += retained.byteLength;
  if (retained.byteLength !== chunk.byteLength) capture.truncated = true;
}

function renderOutput(capture: BoundedCapture): string {
  const content = Buffer.concat(capture.chunks, capture.bytes);
  if (!capture.truncated) return content.toString("utf8");
  const marker = Buffer.from("\n[output truncated]\n", "utf8");
  const retainedBytes = Math.max(0, MAX_CAPTURED_OUTPUT_BYTES - marker.length);
  return Buffer.concat([content.subarray(0, retainedBytes), marker]).toString(
    "utf8",
  );
}

afterEach(async () => {
  const activeChildren = [...children.values()];
  const terminationResults = await Promise.allSettled(
    activeChildren.map((fixture) =>
      fixture.terminate(new Error("fixture cleanup terminated the child")),
    ),
  );
  const childResults = await Promise.all(
    activeChildren.map(({ result }) =>
      settleWithin(result, PROCESS_EXIT_TIMEOUT_MS),
    ),
  );
  children.clear();
  const cleanupResults = await Promise.allSettled(
    [...tempDirs].map((dir) => rm(dir, { recursive: true, force: true })),
  );
  tempDirs.clear();
  const cleanupFailure = cleanupResults.find(
    (result) => result.status === "rejected",
  );
  const terminationFailure = terminationResults.find(
    (result) => result.status === "rejected",
  );
  const unsettledChild = childResults.find(
    (result) => result.status === "timeout",
  );
  if (cleanupFailure?.status === "rejected") throw cleanupFailure.reason;
  if (terminationFailure?.status === "rejected") {
    throw terminationFailure.reason;
  }
  if (unsettledChild) {
    throw new Error("fixture child did not settle after forced termination");
  }
});

async function makeParent(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "lore-test-isolation-harness-"));
  tempDirs.add(parent);
  return parent;
}

function startFixture(
  fixture: string | readonly string[],
  parent: string,
  env: NodeJS.ProcessEnv = {},
  options: StartFixtureOptions = {},
): {
  child: ChildProcess;
  ready: Promise<void>;
  result: Promise<ChildResult>;
  registerDescendant: (pid: number) => void;
} {
  const fixtures = typeof fixture === "string" ? [fixture] : fixture;
  const fixtureLabel = fixtures.join(", ");
  const child = spawn(
    process.execPath,
    [
      VITEST,
      "run",
      "--config",
      FIXTURE_CONFIG,
      ...fixtures.map((entry) => join(FIXTURE_DIR, entry)),
      "--reporter=dot",
    ],
    {
      cwd: REPO_ROOT,
      detached: process.platform !== "win32",
      env: fixtureEnvironment(parent, env),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const stdout: BoundedCapture = { chunks: [], bytes: 0, truncated: false };
  const stderr: BoundedCapture = { chunks: [], bytes: 0, truncated: false };
  child.stdout?.on("data", (chunk: Buffer) => {
    captureOutput(stdout, chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    captureOutput(stderr, chunk);
  });

  const knownDescendants = new Set<number>();
  const closeSignal = new Promise<void>((resolveClose) => {
    child.once("close", () => resolveClose());
  });
  const readySignal = options.readyPath
    ? waitForFile(options.readyPath)
    : Promise.resolve();
  const ready = readySignal.then(async () => {
    if (!options.descendantPidPath) return;
    const { pid } = await readJson<{ pid: number }>(options.descendantPidPath);
    registerDescendant(pid);
  });
  const state: {
    error?: Error;
    reject?: (reason: unknown) => void;
    termination?: Promise<void>;
  } = {};
  const result = new Promise<ChildResult>((resolveResult, reject) => {
    state.reject = reject;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const armTimeout = () => {
      timeout = setTimeout(() => {
        const error = new Error(`fixture ${fixtureLabel} did not exit`);
        void terminate(error).catch(() => {});
      }, options.timeoutMs ?? CHILD_TIMEOUT_MS);
    };
    void ready.then(armTimeout, (reason: unknown) => {
      const error = new Error(`fixture ${fixtureLabel} did not exit`);
      if (reason instanceof Error) error.cause = reason;
      void terminate(error).catch(() => {});
    });
    child.once("error", (error) => {
      if (timeout) clearTimeout(timeout);
      children.delete(child);
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (timeout) clearTimeout(timeout);
      if (state.termination) return;
      if ([...knownDescendants].some(processExists)) {
        void terminate(
          new Error(`fixture ${fixtureLabel} exited with a live descendant`),
        ).catch(() => {});
        return;
      }
      children.delete(child);
      if (state.error) {
        reject(state.error);
      } else {
        resolveResult({
          code,
          signal,
          stdout: renderOutput(stdout),
          stderr: renderOutput(stderr),
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
        });
      }
    });
  });
  const terminate = (error: Error): Promise<void> => {
    if (state.termination) return state.termination;
    state.error = error;
    state.termination = (async () => {
      try {
        const killResult = killFixtureTree(child, knownDescendants);
        const [killOutcome, closeOutcome] = await Promise.all([
          settleWithin(killResult, KILL_GRACE_MS),
          settleWithin(closeSignal, KILL_GRACE_MS),
        ]);
        if (killOutcome.status === "rejected") throw killOutcome.reason;
        if (killOutcome.status === "timeout") {
          throw new Error(`fixture tree kill exceeded ${KILL_GRACE_MS}ms`);
        }
        if (closeOutcome.status === "timeout") {
          child.stdout?.destroy();
          child.stderr?.destroy();
          throw new Error(
            `fixture child did not exit within ${KILL_GRACE_MS}ms`,
          );
        }
        state.reject?.(error);
      } catch (cleanupError) {
        const observableError =
          cleanupError instanceof Error
            ? cleanupError
            : new Error("fixture cleanup failed", { cause: cleanupError });
        state.error = observableError;
        state.reject?.(observableError);
        throw observableError;
      } finally {
        children.delete(child);
      }
    })();
    return state.termination;
  };
  children.set(child, { result, terminate });

  function registerDescendant(pid: number): void {
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      throw new Error("fixture descendant PID must be a positive integer");
    }
    knownDescendants.add(pid);
    if (child.exitCode !== null || child.signalCode !== null) {
      void terminate(
        new Error(`fixture ${fixtureLabel} exited with a live descendant`),
      ).catch(() => {});
    }
  }

  return {
    child,
    ready,
    result,
    registerDescendant,
  };
}

async function killFixtureTree(
  child: ChildProcess,
  knownDescendants: ReadonlySet<number>,
): Promise<void> {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }

  if (process.platform === "win32") {
    if (
      child.pid !== undefined &&
      child.exitCode === null &&
      child.signalCode === null
    ) {
      await runTaskkill(child.pid);
    }
    await killKnownWindowsDescendants(knownDescendants);
  } else if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }

  if (process.platform !== "win32") {
    const descendantKillResults = await Promise.allSettled(
      [...knownDescendants].map(async (pid) => {
        if (!processExists(pid)) return;
        try {
          process.kill(pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }),
    );
    const descendantKillFailures = descendantKillResults.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (descendantKillFailures.length > 0) {
      throw new AggregateError(
        descendantKillFailures,
        "failed to stop every owned Unix descendant",
      );
    }
    await Promise.all([...knownDescendants].map(waitForProcessExit));
  }
}

type TaskkillSpawn = typeof spawn;

async function runTaskkill(
  pid: number,
  spawnTaskkill: TaskkillSpawn = spawn,
): Promise<void> {
  const killer = spawnTaskkill(
    "taskkill.exe",
    ["/PID", String(pid), "/T", "/F"],
    {
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    },
  );
  const killerResult = new Promise<void>((resolveKiller, rejectKiller) => {
    killer.once("error", rejectKiller);
    killer.once("close", (code, signal) => {
      if (code === 0 && signal === null) {
        resolveKiller();
        return;
      }
      rejectKiller(
        new Error(
          `taskkill failed for owned process ${pid}: code=${String(code)} signal=${String(signal)}`,
        ),
      );
    });
  });
  const outcome = await settleWithin(killerResult, KILL_GRACE_MS);
  if (outcome.status === "fulfilled") return;
  if (outcome.status === "rejected") throw outcome.reason;
  killer.kill("SIGKILL");
  throw new Error(`taskkill exceeded ${KILL_GRACE_MS}ms`);
}

async function killKnownWindowsDescendants(
  knownDescendants: ReadonlySet<number>,
  taskkill: (pid: number) => Promise<void> = runTaskkill,
  exists: (pid: number) => boolean = processExists,
  waitForExit: (pid: number) => Promise<void> = waitForProcessExit,
): Promise<void> {
  const pids = [...knownDescendants];
  const killResults = await Promise.allSettled(
    pids.map(async (pid) => {
      if (exists(pid)) await taskkill(pid);
    }),
  );
  const exitResults = await Promise.allSettled(pids.map(waitForExit));
  const failures = [...killResults, ...exitResults].flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "failed to stop every owned Windows descendant",
    );
  }
}

async function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; reason: unknown }
  | { status: "timeout" }
> {
  return new Promise((resolveOutcome) => {
    const timeout = setTimeout(
      () => resolveOutcome({ status: "timeout" }),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolveOutcome({ status: "fulfilled", value });
      },
      (reason: unknown) => {
        clearTimeout(timeout);
        resolveOutcome({ status: "rejected", reason });
      },
    );
  });
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  for (const delayMs of [0, 10, 25, 50, 100, 200, 400, 800]) {
    if (!processExists(pid)) return;
    await new Promise<void>((resolveDelay) =>
      setTimeout(resolveDelay, delayMs),
    );
  }
  throw new Error(`process ${pid} did not exit`);
}

async function expectSuccess(
  result: Promise<ChildResult>,
): Promise<ChildResult> {
  const outcome = await result;
  expect(outcome, outcome.stderr || outcome.stdout).toMatchObject({
    code: 0,
    signal: null,
  });
  return outcome;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function required<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) {
    throw new Error(`${label} was not recorded`);
  }
  return value;
}

function waitForFile(path: string): Promise<void> {
  if (existsSync(path)) return Promise.resolve();
  return new Promise((resolveFile, reject) => {
    const watcher = watch(dirname(path));
    const timeout = setTimeout(() => {
      watcher.close();
      reject(new Error(`timed out waiting for ${path}`));
    }, CHILD_TIMEOUT_MS - 1_000);
    const resolveIfPresent = () => {
      if (!existsSync(path)) return;
      clearTimeout(timeout);
      watcher.close();
      resolveFile();
    };
    watcher.on("change", resolveIfPresent);
    watcher.on("rename", resolveIfPresent);
    watcher.once("error", (error) => {
      clearTimeout(timeout);
      watcher.close();
      reject(error);
    });
    resolveIfPresent();
  });
}

describe("Vitest database isolation harness", () => {
  test("a wholly skipped file creates no per-file directory or residue", async () => {
    const parent = await makeParent();
    const observer = join(parent, "observer.json");
    const { result } = startFixture("skipped.fixture.ts", parent, {
      LORE_TEST_ISOLATION_OBSERVER: observer,
    });

    await expectSuccess(result);
    const snapshot = await readJson<RootSnapshot>(observer);
    const root = required(snapshot.providedRoot, "provided root");
    expect(snapshot.roots).toEqual([{ path: root, entries: [] }]);
    expect(existsSync(root)).toBe(false);
  });

  test("a normal fixture creates and promptly cleans its database", async () => {
    const parent = await makeParent();
    const marker = join(parent, "fixture.json");
    const observer = join(parent, "observer.json");
    const { result } = startFixture("normal.fixture.ts", parent, {
      LORE_TEST_ISOLATION_MARKER: marker,
      LORE_TEST_ISOLATION_OBSERVER: observer,
    });

    await expectSuccess(result);
    const fixture = await readJson<FixtureMarker>(marker);
    const snapshot = await readJson<RootSnapshot>(observer);
    const root = required(snapshot.providedRoot, "provided root");
    expect(fixture.databaseExists).toBe(true);
    expect(snapshot.roots).toEqual([{ path: root, entries: [] }]);
    expect(existsSync(fixture.database)).toBe(false);
    expect(existsSync(root)).toBe(false);
  });

  test("the eval setup keeps its database inside the owned run root", async () => {
    const parent = await makeParent();
    const marker = join(parent, "eval-setup.json");
    const { result } = startFixture("normal.fixture.ts", parent, {
      LORE_TEST_ISOLATION_EVAL_SETUP: "1",
      LORE_TEST_ISOLATION_MARKER: marker,
    });

    await expectSuccess(result);
    const fixture = await readJson<FixtureMarker>(marker);
    const directory = required(fixture.directory, "database directory");
    const root = dirname(directory);
    expect(basename(directory)).toMatch(/^[0-9a-f-]{36}$/);
    expect(existsSync(root)).toBe(false);
  });

  test("global teardown removes a database reopened after file cleanup", async () => {
    const parent = await makeParent();
    const marker = join(parent, "fixture.json");
    const observer = join(parent, "observer.json");
    const { result } = startFixture("late-reopen.fixture.ts", parent, {
      LORE_TEST_ISOLATION_HOOKS: "list",
      LORE_TEST_ISOLATION_MARKER: marker,
      LORE_TEST_ISOLATION_OBSERVER: observer,
    });

    await expectSuccess(result);
    const fixture = await readJson<FixtureMarker>(marker);
    const snapshot = await readJson<RootSnapshot>(observer);
    const root = required(snapshot.providedRoot, "provided root");
    const directory = required(fixture.directory, "fixture directory");
    expect(fixture.directoryWasRemoved).toBe(true);
    expect(fixture.databaseExists).toBe(true);
    expect(snapshot.roots).toHaveLength(1);
    expect(snapshot.roots[0]?.entries).toEqual([basename(directory)]);
    expect(existsSync(directory)).toBe(false);
    expect(existsSync(root)).toBe(false);
  });

  test("the final coordinator sweep removes artifacts recreated after global teardown", async () => {
    const parent = await makeParent();
    const marker = join(parent, "fixture.json");
    const recreateMarker = join(parent, "recreated.json");
    const { result } = startFixture("normal.fixture.ts", parent, {
      LORE_TEST_ISOLATION_MARKER: marker,
      LORE_TEST_ISOLATION_RECREATE_MARKER: recreateMarker,
    });

    await expectSuccess(result);
    const recreated = await readJson<{
      root: string;
      artifact: string;
      artifactExists: boolean;
    }>(recreateMarker);
    expect(recreated.artifactExists).toBe(true);
    expect(existsSync(recreated.artifact)).toBe(false);
    expect(existsSync(recreated.root)).toBe(false);
  });

  test("two files in one worker receive distinct database directories", async () => {
    const parent = await makeParent();
    const marker = join(parent, "per-file");
    const { result } = startFixture(
      ["per-file-a.fixture.ts", "per-file-b.fixture.ts"],
      parent,
      { LORE_TEST_ISOLATION_MARKER: marker },
    );

    await expectSuccess(result);
    const first = await readJson<{ directory: string }>(`${marker}.a`);
    const second = await readJson<{ directory: string }>(`${marker}.b`);
    expect(first.directory).not.toBe(second.directory);
  });

  test("mutable isolation environment never crosses a test boundary", async () => {
    const parent = await makeParent();
    const { result } = startFixture("environment-reset.fixture.ts", parent);

    await expectSuccess(result);
  });

  test("mutable isolation environment never crosses a list-ordered hook boundary", async () => {
    const parent = await makeParent();
    const { result } = startFixture("environment-reset.fixture.ts", parent, {
      LORE_TEST_ISOLATION_HOOKS: "list",
    });

    await expectSuccess(result);
  });

  test.each(["SIGTERM", "SIGINT"] as const)(
    "%s before normal teardown removes the root and preserves the exit status",
    async (signal) => {
      const parent = await makeParent();
      const marker = join(parent, "early-termination.json");
      const { child, result } = startFixture(
        "early-termination.fixture.ts",
        parent,
        { LORE_TEST_ISOLATION_MARKER: marker },
      );
      await waitForFile(marker);
      const fixture = await readJson<FixtureMarker>(marker);
      const root = required(fixture.root, "run root");

      child.kill(signal);
      const outcome = await settleWithin(result, 15_000);
      if (outcome.status !== "fulfilled") {
        throw new Error(`${signal} fixture did not settle normally`);
      }
      expect(outcome.value).toMatchObject({
        code: signal === "SIGINT" ? 130 : 143,
        signal: null,
      });
      expect(existsSync(root)).toBe(false);
    },
  );

  test("process.exit before normal teardown removes the owned run root", async () => {
    const parent = await makeParent();
    const marker = join(parent, "process-exit.json");
    const { result } = startFixture("normal.fixture.ts", parent, {
      LORE_TEST_ISOLATION_PROCESS_EXIT_MARKER: marker,
    });

    const outcome = await result;
    expect(outcome).toMatchObject({ code: 37, signal: null });
    const fixture = await readJson<{ root: string; artifact: string }>(marker);
    expect(existsSync(fixture.artifact)).toBe(false);
    expect(existsSync(fixture.root)).toBe(false);
  });

  test("a replacement at the owned root pathname is never deleted", async () => {
    const parent = await makeParent();
    const marker = join(parent, "replacement.json");
    const { result } = startFixture("root-replacement.fixture.ts", parent, {
      LORE_TEST_ISOLATION_MARKER: marker,
    });

    await expectSuccess(result);
    const fixture = await readJson<{
      root: string;
      ownedRoot: string;
      replacementFileRoot: string;
      sentinel: string;
    }>(marker);
    expect(existsSync(fixture.root)).toBe(true);
    expect(existsSync(fixture.replacementFileRoot)).toBe(true);
    expect(existsSync(fixture.sentinel)).toBe(true);
    expect(existsSync(fixture.ownedRoot)).toBe(true);
  });

  test("fixture timeout kills descendants and rejects without waiting for inherited pipes", async () => {
    const parent = await makeParent();
    const marker = join(parent, "descendant.json");
    const { child, ready, result } = startFixture(
      "hanging-descendant.fixture.ts",
      parent,
      { LORE_TEST_ISOLATION_MARKER: marker },
      {
        timeoutMs: 2_000,
        readyPath: marker,
        descendantPidPath: marker,
      },
    );
    await ready;
    const { pid } = await readJson<{ pid: number }>(marker);

    const outcome = await settleWithin(result, 10_000);
    if (outcome.status === "timeout") {
      if (processExists(pid)) process.kill(pid, "SIGKILL");
      await killFixtureTree(child, new Set([pid]));
      await settleWithin(result, PROCESS_EXIT_TIMEOUT_MS);
    }

    expect(outcome.status).toBe("rejected");
    await waitForProcessExit(pid);
  });

  test("an exited coordinator cannot orphan its registered descendant", async () => {
    const parent = await makeParent();
    const marker = join(parent, "orphaned-descendant.json");
    const { child, ready, result } = startFixture(
      "orphaned-descendant.fixture.ts",
      parent,
      { LORE_TEST_ISOLATION_MARKER: marker },
      {
        timeoutMs: 2_000,
        readyPath: marker,
        descendantPidPath: marker,
      },
    );
    await ready;
    const { pid } = await readJson<{ pid: number }>(marker);
    await new Promise<void>((resolveExit, rejectExit) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolveExit();
        return;
      }
      child.once("exit", () => resolveExit());
      child.once("error", rejectExit);
    });

    const outcome = await settleWithin(result, 10_000);
    expect(outcome.status).toBe("rejected");
    await waitForProcessExit(pid);
  });

  test("a nonzero taskkill exit is an observable cleanup failure", async () => {
    const fakeSpawn = vi.fn(() => {
      const killer = new EventEmitter() as ChildProcess;
      killer.kill = vi.fn(() => true);
      queueMicrotask(() => killer.emit("close", 5, null));
      return killer;
    }) as unknown as typeof spawn;

    await expect(runTaskkill(4242, fakeSpawn)).rejects.toThrow(
      "taskkill failed for owned process 4242: code=5 signal=null",
    );
    expect(fakeSpawn).toHaveBeenCalledWith(
      "taskkill.exe",
      ["/PID", "4242", "/T", "/F"],
      expect.objectContaining({ shell: false, stdio: "ignore" }),
    );
  });

  test("an exited Windows coordinator retains every known descendant cleanup target", async () => {
    const killed: number[] = [];
    const waited: number[] = [];
    const knownDescendants = new Set([101, 202]);

    await killKnownWindowsDescendants(
      knownDescendants,
      async (pid) => {
        killed.push(pid);
      },
      () => true,
      async (pid) => {
        waited.push(pid);
      },
    );

    expect(killed).toEqual([101, 202]);
    expect(waited).toEqual([101, 202]);
  });

  test("one Windows cleanup failure cannot skip another known descendant", async () => {
    const killed: number[] = [];
    const waited: number[] = [];

    await expect(
      killKnownWindowsDescendants(
        new Set([101, 202]),
        async (pid) => {
          killed.push(pid);
          if (pid === 101) throw new Error("taskkill failed");
        },
        () => true,
        async (pid) => {
          waited.push(pid);
        },
      ),
    ).rejects.toThrow("failed to stop every owned Windows descendant");
    expect(killed).toEqual([101, 202]);
    expect(waited).toEqual([101, 202]);
  });

  test("fixture output capture stays bounded while both pipes are drained", async () => {
    const parent = await makeParent();
    const { result } = startFixture("noisy-output.fixture.ts", parent);

    const outcome = await expectSuccess(result);
    expect(outcome.stdoutTruncated).toBe(true);
    expect(outcome.stderrTruncated).toBe(true);
    expect(Buffer.byteLength(outcome.stdout)).toBeLessThanOrEqual(
      MAX_CAPTURED_OUTPUT_BYTES,
    );
    expect(Buffer.byteLength(outcome.stderr)).toBeLessThanOrEqual(
      MAX_CAPTURED_OUTPUT_BYTES,
    );
  });

  test("fixture children do not inherit an unrelated parent secret", async () => {
    const parent = await makeParent();
    const previousSecret = process.env.LORE_TEST_ISOLATION_INHERITED_SECRET;
    process.env.LORE_TEST_ISOLATION_INHERITED_SECRET = "must-not-cross";
    try {
      const { result } = startFixture(
        "environment-sanitization.fixture.ts",
        parent,
      );
      await expectSuccess(result);
    } finally {
      if (previousSecret === undefined) {
        delete process.env.LORE_TEST_ISOLATION_INHERITED_SECRET;
      } else {
        process.env.LORE_TEST_ISOLATION_INHERITED_SECRET = previousSecret;
      }
    }
  });

  test("concurrent runs own distinct roots and cannot remove each other", async () => {
    const parent = await makeParent();
    const heldMarker = join(parent, "held.json");
    const release = join(parent, "release");
    const held = startFixture("concurrent.fixture.ts", parent, {
      LORE_TEST_ISOLATION_MARKER: heldMarker,
      LORE_TEST_ISOLATION_RELEASE: release,
    });
    await waitForFile(heldMarker);
    const heldFixture = await readJson<FixtureMarker>(heldMarker);

    const quickMarker = join(parent, "quick.json");
    const quick = startFixture("concurrent.fixture.ts", parent, {
      LORE_TEST_ISOLATION_MARKER: quickMarker,
    });
    await expectSuccess(quick.result);
    const quickFixture = await readJson<FixtureMarker>(quickMarker);
    const quickRoot = required(quickFixture.root, "quick run root");
    const heldRoot = required(heldFixture.root, "held run root");

    expect(quickRoot).not.toBe(heldRoot);
    expect(basename(quickRoot)).toMatch(/^lore-test-run-/);
    expect(basename(heldRoot)).toMatch(/^lore-test-run-/);
    expect(existsSync(quickRoot)).toBe(false);
    expect(existsSync(heldRoot)).toBe(true);
    expect(held.child.exitCode).toBe(null);

    await writeFile(release, "release");
    await expectSuccess(held.result);
    expect(existsSync(heldRoot)).toBe(false);
  });
});
