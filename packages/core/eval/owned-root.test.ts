import { EventEmitter } from "node:events";
import {
  lstat,
  mkdir,
  mkdtemp as makeTemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { afterEach, describe, expect, test, vi } from "vitest";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { startLiveGateway, type LiveGatewayDependencies } from "./harness";
import { withOwnedDatabaseRoot } from "./owned-root";

const roots = new Set<string>();

afterEach(async () => {
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
  }
  roots.clear();
});

describe("standalone eval database ownership", () => {
  test("restores the environment and removes the root after setup failure", async () => {
    const previous = {
      LORE_TEST_DB_ROOT: process.env.LORE_TEST_DB_ROOT,
      LORE_DB_PATH: process.env.LORE_DB_PATH,
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    };

    await expect(
      withOwnedDatabaseRoot(async () => {
        const databaseRoot = process.env.LORE_TEST_DB_ROOT;
        if (!databaseRoot) throw new Error("database root was not set");
        const runRoot = dirname(databaseRoot);
        roots.add(runRoot);
        await writeFile(`${databaseRoot}/marker`, "created");
        throw new Error("intentional setup failure");
      }),
    ).rejects.toThrow("intentional setup failure");

    expect(process.env.LORE_TEST_DB_ROOT).toBe(previous.LORE_TEST_DB_ROOT);
    expect(process.env.LORE_DB_PATH).toBe(previous.LORE_DB_PATH);
    expect(process.env.XDG_DATA_HOME).toBe(previous.XDG_DATA_HOME);

    for (const root of roots) {
      await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  test("does not remove a replacement at the owned path", async () => {
    let runRoot = "";
    await withOwnedDatabaseRoot(async () => {
      const databaseRoot = process.env.LORE_TEST_DB_ROOT;
      if (!databaseRoot) throw new Error("database root was not set");
      runRoot = dirname(databaseRoot);
      roots.add(runRoot);
      await rm(runRoot, { recursive: true, force: true });
      await mkdir(runRoot);
      await writeFile(`${runRoot}/replacement`, "preserve");
    });

    await expect(readdir(runRoot)).resolves.toContain("replacement");
  });

  test("cleans up and re-raises a signal received during root creation", async () => {
    const realProcess = process;
    const fakeProcess = new EventEmitter() as unknown as typeof process;
    Object.assign(fakeProcess, {
      env: realProcess.env,
      pid: 1234,
      kill: vi.fn(),
    });
    vi.stubGlobal("process", fakeProcess);

    let createdRoot = "";
    let signalReady = () => {};
    let releaseCreation = () => {};
    const signalReadyPromise = new Promise<void>((resolve) => {
      signalReady = resolve;
    });
    const creationRelease = new Promise<void>((resolve) => {
      releaseCreation = resolve;
    });
    let ran = false;

    try {
      const running = withOwnedDatabaseRoot(
        async () => {
          ran = true;
        },
        {
          createRoot: {
            prefix: "lore-eval-signal-",
            mkdtemp: async (prefix) => {
              createdRoot = await makeTemp(prefix);
              signalReady();
              await creationRelease;
              return createdRoot;
            },
          },
        },
      );
      await signalReadyPromise;
      fakeProcess.emit("SIGTERM");
      releaseCreation();
      await running;

      expect(ran).toBe(false);
      expect(fakeProcess.kill).toHaveBeenCalledWith(1234, "SIGTERM");
      await expect(lstat(createdRoot)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      vi.unstubAllGlobals();
      if (createdRoot) await rm(createdRoot, { recursive: true, force: true });
    }
  });

  test("aborts active eval work before it performs cleanup", async () => {
    const realProcess = process;
    const fakeProcess = new EventEmitter() as unknown as typeof process;
    Object.assign(fakeProcess, {
      env: realProcess.env,
      pid: 1234,
      kill: vi.fn(),
    });
    vi.stubGlobal("process", fakeProcess);

    let signal: AbortSignal | undefined;
    let release = () => {};
    let running: Promise<void> | undefined;
    const started = new Promise<void>((resolve) => {
      running = withOwnedDatabaseRoot(async (abortSignal) => {
        signal = abortSignal;
        resolve();
        await new Promise<void>((finish) => {
          release = finish;
        });
        abortSignal.throwIfAborted();
      });
    });

    try {
      await started;
      if (!running) throw new Error("eval did not start");
      fakeProcess.emit("SIGTERM");
      expect(signal?.aborted).toBe(true);
      release();
      await expect(running).rejects.toThrow("eval interrupted by SIGTERM");
      expect(fakeProcess.kill).toHaveBeenCalledWith(1234, "SIGTERM");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("cleans the live root when gateway startup fails", async () => {
    const parent = await makeTemp(join(tmpdir(), "lore-live-gateway-test-"));
    roots.add(parent);
    const previousRoot = process.env.LORE_TEST_DB_ROOT;
    process.env.LORE_TEST_DB_ROOT = parent;

    try {
      const dependencies: LiveGatewayDependencies = {
        loadConfig: () => ({}),
        closeDB: () => {},
        resetPipelineState: async () => {},
        startServer: async () => {
          throw new Error("intentional gateway startup failure");
        },
      };
      await expect(startLiveGateway(dependencies)).rejects.toThrow(
        "intentional gateway startup failure",
      );
      await expect(readdir(parent)).resolves.toEqual([]);
    } finally {
      if (previousRoot === undefined) delete process.env.LORE_TEST_DB_ROOT;
      else process.env.LORE_TEST_DB_ROOT = previousRoot;
    }
  });

  test("direct live startup owns a root without injected test setup", async () => {
    const previousEnvironment = {
      LORE_TEST_DB_ROOT: process.env.LORE_TEST_DB_ROOT,
      LORE_DB_PATH: process.env.LORE_DB_PATH,
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    };
    delete process.env.LORE_TEST_DB_ROOT;
    let ownedRoot = "";

    try {
      const dependencies: LiveGatewayDependencies = {
        loadConfig: () => ({}),
        closeDB: () => {},
        resetPipelineState: async () => {},
        startServer: async () => ({
          port: 32124,
          async stop() {},
        }),
      };
      const gateway = await startLiveGateway(dependencies);
      ownedRoot = process.env.LORE_TEST_DB_ROOT ?? "";
      expect(ownedRoot).toMatch(/\/lore-eval-live-/);
      expect(process.env.XDG_DATA_HOME).toBe(join(ownedRoot, "xdg"));
      await gateway.teardown?.();
      await expect(lstat(ownedRoot)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (previousEnvironment.LORE_TEST_DB_ROOT === undefined) {
        delete process.env.LORE_TEST_DB_ROOT;
      } else {
        process.env.LORE_TEST_DB_ROOT = previousEnvironment.LORE_TEST_DB_ROOT;
      }
      if (previousEnvironment.LORE_DB_PATH === undefined) {
        delete process.env.LORE_DB_PATH;
      } else {
        process.env.LORE_DB_PATH = previousEnvironment.LORE_DB_PATH;
      }
      if (previousEnvironment.XDG_DATA_HOME === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = previousEnvironment.XDG_DATA_HOME;
      }
    }
  });

  test("restores live environment after teardown failure and remains retryable", async () => {
    const parent = await makeTemp(join(tmpdir(), "lore-live-gateway-test-"));
    roots.add(parent);
    const previousRoot = process.env.LORE_TEST_DB_ROOT;
    process.env.LORE_TEST_DB_ROOT = parent;
    let stopCalls = 0;
    let closeCalls = 0;
    let resetCalls = 0;

    try {
      const dependencies: LiveGatewayDependencies = {
        loadConfig: () => ({}),
        closeDB: () => {
          closeCalls++;
        },
        resetPipelineState: async () => {
          resetCalls++;
        },
        startServer: async () => ({
          port: 32123,
          async stop() {
            stopCalls++;
            if (stopCalls === 1) throw new Error("intentional stop failure");
          },
        }),
      };
      const gateway = await startLiveGateway(dependencies);
      const teardown = gateway.teardown;
      if (!teardown) throw new Error("live gateway teardown is missing");
      let teardownError: unknown;
      try {
        await teardown();
      } catch (error) {
        teardownError = error;
      }
      expect(teardownError).toBeInstanceOf(AggregateError);
      expect((teardownError as AggregateError).errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ message: "intentional stop failure" }),
        ]),
      );
      await expect(readdir(parent)).resolves.toHaveLength(1);
      expect(process.env.LORE_TEST_DB_ROOT).toMatch(
        new RegExp(`^${parent}/lore-eval-live-`),
      );
      expect(closeCalls).toBe(1);
      expect(resetCalls).toBe(1);

      await teardown();
      expect(stopCalls).toBe(2);
      expect(closeCalls).toBe(2);
      expect(resetCalls).toBe(2);
      await expect(readdir(parent)).resolves.toEqual([]);
    } finally {
      if (previousRoot === undefined) delete process.env.LORE_TEST_DB_ROOT;
      else process.env.LORE_TEST_DB_ROOT = previousRoot;
    }
  });
});
