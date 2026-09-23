import { EventEmitter } from "node:events";
import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import setup, { type GlobalSetupDependencies } from "./global-setup";

type FakeProcess = EventEmitter & {
  pid: number;
  platform: NodeJS.Platform;
  kill: ReturnType<typeof vi.fn>;
};

const ownedRoots = new Set<string>();

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    [...ownedRoots].map((root) => rm(root, { recursive: true, force: true })),
  );
  ownedRoots.clear();
});

function fakeProcess(): FakeProcess {
  const emitter = new EventEmitter() as FakeProcess;
  emitter.pid = 1234;
  emitter.platform = process.platform;
  emitter.kill = vi.fn(() => true);
  return emitter;
}

async function initialize(fake: FakeProcess): Promise<{
  root: string;
  teardown: () => Promise<void>;
}> {
  vi.stubGlobal("process", fake);
  const context: { loreTestRoot?: string } = {};
  const teardown = await setup({
    provide(key: "loreTestRoot", value: string) {
      context[key] = value;
    },
  } as never);
  const root = context.loreTestRoot;
  if (!root) throw new Error("global setup did not provide loreTestRoot");
  ownedRoots.add(root);
  return { root, teardown };
}

function ownedRootDependencies(
  createRoot: GlobalSetupDependencies["createRoot"],
): GlobalSetupDependencies {
  return { createRoot };
}

describe("database isolation signal cleanup", () => {
  test.each(["SIGINT", "SIGTERM"] as const)(
    "%s removes the owned root and re-raises when no other handler exists",
    async (signal) => {
      const fake = fakeProcess();
      const { root } = await initialize(fake);
      mkdirSync(join(root, "db"));
      writeFileSync(join(root, "db", "test.db-wal"), "data");

      fake.emit(signal);

      expect(fake.kill).toHaveBeenCalledExactlyOnceWith(fake.pid, signal);
      expect(() => lstatSync(root)).toThrow();
    },
  );

  test("a signal during root allocation is handled after allocation", async () => {
    const fake = fakeProcess();
    vi.stubGlobal("process", fake);
    let createdRoot = "";
    let release = () => {};
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const allocation = new Promise<void>((resolve) => {
      const originalRelease = release;
      release = () => {
        originalRelease();
        resolve();
      };
    });

    const setupPromise = setup(
      {
        provide() {},
      } as never,
      ownedRootDependencies(async (options) => {
        const { createOwnedRoot } = await import("./helpers/owned-path");
        const owned = await createOwnedRoot(options);
        createdRoot = owned.path;
        await ready;
        return owned;
      }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    fake.emit("SIGTERM");
    release();
    await allocation;
    await setupPromise;

    expect(fake.kill).toHaveBeenCalledExactlyOnceWith(fake.pid, "SIGTERM");
    expect(() => lstatSync(createdRoot)).toThrow();
  });

  test("a project provision failure cleans the allocated root", async () => {
    const fake = fakeProcess();
    vi.stubGlobal("process", fake);
    let createdRoot = "";

    await expect(
      setup(
        {
          provide() {
            throw new Error("intentional provision failure");
          },
        } as never,
        ownedRootDependencies(async (options) => {
          const { createOwnedRoot } = await import("./helpers/owned-path");
          const owned = await createOwnedRoot(options);
          createdRoot = owned.path;
          return owned;
        }),
      ),
    ).rejects.toThrow("intentional provision failure");

    expect(() => lstatSync(createdRoot)).toThrow();
  });

  test("a later one-shot listener retains the root until exit", async () => {
    const fake = fakeProcess();
    const { root } = await initialize(fake);
    const called = vi.fn();
    const artifact = join(root, "test.db-wal");
    writeFileSync(artifact, "data");
    fake.once("SIGTERM", called);

    fake.emit("SIGTERM");

    expect(called).toHaveBeenCalledOnce();
    expect(fake.kill).not.toHaveBeenCalled();
    expect(lstatSync(root).isDirectory()).toBe(true);
    expect(lstatSync(artifact).isFile()).toBe(true);

    fake.emit("exit", 143);
    expect(() => lstatSync(root)).toThrow();
  });

  test("an existing persistent handler retains the root until exit", async () => {
    const fake = fakeProcess();
    const called = vi.fn();
    fake.on("SIGTERM", called);
    const { root } = await initialize(fake);
    const artifact = join(root, "test.db-wal");
    writeFileSync(artifact, "data");

    fake.emit("SIGTERM");

    expect(called).toHaveBeenCalledOnce();
    expect(fake.kill).not.toHaveBeenCalled();
    expect(lstatSync(root).isDirectory()).toBe(true);
    expect(lstatSync(artifact).isFile()).toBe(true);

    fake.emit("exit", 143);
    expect(() => lstatSync(root)).toThrow();
  });

  test.each(["SIGINT", "SIGTERM"] as const)(
    "a %s handler removed after setup cannot make the signal look handled",
    async (signal) => {
      const fake = fakeProcess();
      const removedHandler = vi.fn();
      fake.on(signal, removedHandler);
      const { root } = await initialize(fake);
      const artifact = join(root, "test.db-wal");
      writeFileSync(artifact, "data");
      fake.off(signal, removedHandler);

      fake.emit(signal);

      expect(removedHandler).not.toHaveBeenCalled();
      expect(fake.kill).toHaveBeenCalledExactlyOnceWith(fake.pid, signal);
      expect(() => lstatSync(root)).toThrow();
    },
  );

  test("normal teardown leaves the owned root untouched until exit", async () => {
    const fake = fakeProcess();
    const { root, teardown } = await initialize(fake);
    const artifact = join(root, "test.db");
    await writeFile(artifact, "data");

    await teardown();

    expect(lstatSync(root).isDirectory()).toBe(true);

    fake.emit("exit", 0);
    expect(() => lstatSync(root)).toThrow();
    expect(fake.listenerCount("SIGINT")).toBe(0);
    expect(fake.listenerCount("SIGTERM")).toBe(0);
  });
});
