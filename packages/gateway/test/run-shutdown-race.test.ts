import { EventEmitter } from "node:events";
import { afterEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  maybeAutoImport: vi.fn(),
  startGateway: vi.fn(),
  safeExit: vi.fn((code: number) => {
    throw new Error(`__safeExit__:${code}`);
  }),
  forcedExit: vi.fn((code: number) => {
    throw new Error(`__forcedExit__:${code}`);
  }),
}));

vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("../src/cli/import-auto", () => ({
  maybeAutoImport: mocks.maybeAutoImport,
}));
vi.mock("../src/cli/exit", () => ({
  safeExit: mocks.safeExit,
  forcedExit: mocks.forcedExit,
}));
vi.mock("../src/cli/start", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/cli/start")>();
  return { ...original, startGateway: mocks.startGateway };
});

import { commandRun } from "../src/cli/run";
import { makeProcessShutdownController } from "../src/cli/shutdown";

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("commandRun shutdown ordering", () => {
  test("authenticated shutdown during auto-import prevents a later child spawn", async () => {
    const shutdown = vi.fn(async () => {});
    const controller = makeProcessShutdownController(shutdown, {
      deadlineMs: 1000,
      safeExit: mocks.safeExit,
      forcedExit: mocks.forcedExit,
    });
    let shutdownRequest: Promise<never> | undefined;
    mocks.startGateway.mockResolvedValue({
      config: {
        hosts: ["127.0.0.1"],
        port: 3207,
        debug: false,
      },
      port: 3207,
      owned: true,
      shutdown,
      processShutdown: controller,
    });
    mocks.maybeAutoImport.mockImplementation(async () => {
      // Adversarial order: publication already exposed authenticated control,
      // which starts teardown while commandRun is suspended at this await.
      shutdownRequest = controller(0);
    });
    mocks.spawn.mockReturnValue(Object.assign(new EventEmitter(), { pid: 42 }));

    await expect(commandRun({}, ["test-agent"])).rejects.toThrow(
      "__safeExit__:0",
    );
    await expect(shutdownRequest).rejects.toThrow("__safeExit__:0");
    expect(controller.isShutdownStarted()).toBe(true);
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(shutdown).toHaveBeenCalledTimes(1);
  });
});
