import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { createConnection, type AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { embedding, log } from "@loreai/core";
import type { GatewayProcessRecord } from "../src/pidfile";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("startGateway active-stream shutdown", () => {
  it("bounds authenticated shutdown when a socket sends incomplete headers", async () => {
    const core = await import("@loreai/core");
    vi.spyOn(embedding, "settleDocumentEmbeds").mockResolvedValue(undefined);
    vi.spyOn(embedding, "resetProvider").mockResolvedValue(undefined);
    vi.spyOn(core, "shutdownVectorPoolAsync").mockResolvedValue(undefined);
    vi.spyOn(core, "close").mockImplementation(() => {});

    const { startServer } = await import("../src/server");
    const { requestGatewayShutdown, startGateway } =
      await import("../src/cli/start");
    let processRecord: GatewayProcessRecord | null = null;
    let markRemoved!: () => void;
    const removed = new Promise<void>((resolve) => {
      markRemoved = resolve;
    });
    const handle = await startGateway(
      { port: 0, local: true, quiet: true },
      {
        readProcess: () => processRecord,
        authenticate: async () => null,
        writePort: () => {},
        removePort: () => {},
        writeProcess: (record) => {
          processRecord = record;
        },
        removeProcess: () => {
          processRecord = null;
          markRemoved();
        },
        startServer: (config, options) =>
          startServer(config, { ...options, shutdownDeadlineMs: 75 }),
      },
    );
    const partialSocket = createConnection(handle.port, "127.0.0.1");

    try {
      await once(partialSocket, "connect");
      partialSocket.write("GET /health HTTP/1.1\r\nHost: localhost\r\n");

      const record = processRecord;
      expect(record).not.toBeNull();
      if (!record) throw new Error("gateway process record was not published");
      const requestResult = await requestGatewayShutdown(record, 500);
      expect(requestResult).toBe("accepted");

      await expect(
        Promise.race([
          removed,
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("gateway shutdown did not settle")),
              500,
            ),
          ),
        ]),
      ).resolves.toBeUndefined();
      if (!partialSocket.destroyed) await once(partialSocket, "close");
      expect(partialSocket.destroyed).toBe(true);
      expect(processRecord).toBeNull();
      await expect(handle.shutdown()).resolves.toBeUndefined();
    } finally {
      partialSocket.destroy();
      await handle.shutdown().catch(() => {});
    }
  });

  it("force-exits nonzero when authenticated control teardown never settles", async () => {
    const { startServer } = await import("../src/server");
    const { requestGatewayShutdown, startGateway } =
      await import("../src/cli/start");
    const { makeProcessShutdownController } =
      await import("../src/cli/shutdown");
    let processRecord: GatewayProcessRecord | null = null;
    let markForced!: (code: number) => void;
    const forced = new Promise<number>((resolve) => {
      markForced = resolve;
    });
    let releaseReset!: () => void;
    const resetGate = new Promise<void>((resolve) => {
      releaseReset = resolve;
    });
    const reset = vi.fn(() => resetGate);
    let allowTestCleanup!: () => void;
    const testCleanupAllowed = new Promise<void>((resolve) => {
      allowTestCleanup = resolve;
    });
    let markRemoved!: () => void;
    const removed = new Promise<void>((resolve) => {
      markRemoved = resolve;
    });
    const safeExit = vi.fn((_code: number): never => {
      throw new Error("safe exit must not run");
    });
    const forcedExit = vi.fn((code: number): never => {
      markForced(code);
      throw new Error(`__forcedExit__:${code}`);
    });

    const handle = await startGateway(
      { port: 0, local: true, quiet: true, processBoundary: true },
      {
        readProcess: () => processRecord,
        authenticate: async () => null,
        writePort: () => {},
        removePort: () => {},
        writeProcess: (record) => {
          processRecord = record;
        },
        removeProcess: () => {
          processRecord = null;
          markRemoved();
        },
        resetPipelineState: reset,
        startServer: (config, options) =>
          startServer(config, { ...options, shutdownDeadlineMs: 20 }),
        createProcessShutdownController: (shutdown) => {
          const controller = makeProcessShutdownController(shutdown, {
            deadlineMs: 20,
            safeExit,
            forcedExit,
          });
          return Object.assign(
            async (code: number, signal?: NodeJS.Signals): Promise<never> => {
              try {
                return await controller(code, signal);
              } catch {
                await testCleanupAllowed;
                releaseReset();
                return await new Promise<never>(() => {});
              }
            },
            {
              attachChild: controller.attachChild,
              childExited: controller.childExited,
              isShutdownStarted: controller.isShutdownStarted,
              killChildAndWait: controller.killChildAndWait,
            },
          );
        },
      },
    );

    const record = processRecord;
    expect(record).not.toBeNull();
    if (!record) throw new Error("gateway process record was not published");

    // The accepted response must arrive before process teardown starts.
    await expect(requestGatewayShutdown(record, 500)).resolves.toBe("accepted");
    await expect(forced).resolves.toBe(1);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(forcedExit).toHaveBeenCalledWith(1);
    expect(safeExit).not.toHaveBeenCalled();
    // Teardown never reached safe closure, so live-generation evidence remains.
    expect(processRecord).toEqual(record);

    // A concurrent signal/control request shares the same teardown attempt.
    void handle.processShutdown?.(143);
    expect(reset).toHaveBeenCalledTimes(1);
    allowTestCleanup();
    await removed;
  });

  it("starts listener close, cancels the stream, then awaits listener completion", async () => {
    const order: string[] = [];
    const core = await import("@loreai/core");
    vi.spyOn(embedding, "settleDocumentEmbeds").mockImplementation(async () => {
      order.push("embed-drain");
    });
    vi.spyOn(embedding, "resetProvider").mockResolvedValue(undefined);
    vi.spyOn(core, "shutdownVectorPoolAsync").mockResolvedValue(undefined);
    vi.spyOn(core, "close").mockImplementation(() => {});

    const { createForegroundAbortScope } = await import("../src/pipeline");
    const { startGateway } = await import("../src/cli/start");
    const caller = new AbortController();
    const stream = createForegroundAbortScope(caller.signal);
    let markCloseStarted!: () => void;
    const closeStarted = new Promise<void>((resolve) => {
      markCloseStarted = resolve;
    });
    let processRecord: GatewayProcessRecord | null = null;
    let activeServer: Server | undefined;
    const handle = await startGateway(
      { port: 0, local: true, quiet: true },
      {
        readProcess: () => processRecord,
        authenticate: async () => null,
        writePort: () => {},
        removePort: () => {},
        writeProcess: (record) => {
          processRecord = record;
        },
        removeProcess: () => {
          processRecord = null;
        },
        startServer: async () => {
          activeServer = createServer((_request, response) => {
            response.writeHead(200, {
              "content-type": "text/event-stream",
            });
            response.write("data: active\n\n");
            stream.signal.addEventListener(
              "abort",
              () => {
                order.push("stream-cancelled");
                response.end();
              },
              { once: true },
            );
          });
          await new Promise<void>((resolve, reject) => {
            activeServer?.once("error", reject);
            activeServer?.listen(0, "127.0.0.1", resolve);
          });
          const port = (activeServer.address() as AddressInfo).port;
          return {
            ready: Promise.resolve(),
            port,
            hosts: ["127.0.0.1"],
            stop: () => {
              order.push("listener-close-started");
              markCloseStarted();
              return new Promise<void>((resolve, reject) => {
                activeServer?.close((error) => {
                  if (error) reject(error);
                  else {
                    order.push("listener-closed");
                    resolve();
                  }
                });
              });
            },
          };
        },
      },
    );

    let shutdown: Promise<void> | undefined;
    let cancelledByShutdown = false;
    try {
      const response = await fetch(`http://127.0.0.1:${handle.port}/stream`);
      const reader = response.body?.getReader();
      expect((await reader?.read())?.done).toBe(false);
      shutdown = handle.shutdown();
      await closeStarted;
      await new Promise<void>((resolve) => setImmediate(resolve));
      cancelledByShutdown = stream.signal.aborted;
    } finally {
      if (!stream.signal.aborted) caller.abort();
      await shutdown;
      stream.dispose();
      if (activeServer?.listening) {
        await new Promise<void>((resolve) =>
          activeServer?.close(() => resolve()),
        );
      }
    }

    expect(cancelledByShutdown).toBe(true);
    expect(order).toEqual([
      "listener-close-started",
      "stream-cancelled",
      "listener-closed",
      "embed-drain",
    ]);
  });

  it("runs the published remote callback through the same shutdown cleanup", async () => {
    const core = await import("@loreai/core");
    vi.spyOn(embedding, "settleDocumentEmbeds").mockResolvedValue(undefined);
    vi.spyOn(embedding, "resetProvider").mockResolvedValue(undefined);
    vi.spyOn(core, "shutdownVectorPoolAsync").mockResolvedValue(undefined);
    vi.spyOn(core, "close").mockImplementation(() => {});
    const { startGateway } = await import("../src/cli/start");
    let processRecord: GatewayProcessRecord | null = null;
    let requestRemoteShutdown: (() => void | Promise<void>) | undefined;
    let stopCalls = 0;
    let markRemoved!: () => void;
    const removed = new Promise<void>((resolve) => {
      markRemoved = resolve;
    });
    await startGateway(
      { port: 0, local: true, quiet: true },
      {
        readProcess: () => processRecord,
        authenticate: async () => null,
        writePort: () => {},
        removePort: () => {},
        writeProcess: (record) => {
          processRecord = record;
        },
        removeProcess: () => {
          processRecord = null;
          markRemoved();
        },
        startServer: async (_config, options) => {
          requestRemoteShutdown = options?.onShutdown;
          return {
            ready: Promise.resolve(),
            port: 49322,
            hosts: ["127.0.0.1"],
            stop: async () => {
              stopCalls += 1;
            },
          };
        },
      },
    );

    expect(requestRemoteShutdown).toBeTypeOf("function");
    void requestRemoteShutdown?.();
    await removed;
    expect(stopCalls).toBe(1);
    expect(processRecord).toBeNull();
  });

  it("reports remote shutdown rejection and sets a nonzero exit code", async () => {
    const core = await import("@loreai/core");
    vi.spyOn(embedding, "settleDocumentEmbeds").mockResolvedValue(undefined);
    vi.spyOn(embedding, "resetProvider").mockResolvedValue(undefined);
    vi.spyOn(core, "shutdownVectorPoolAsync").mockResolvedValue(undefined);
    vi.spyOn(core, "close").mockImplementation(() => {});
    const { startGateway } = await import("../src/cli/start");
    let processRecord: GatewayProcessRecord | null = null;
    let requestRemoteShutdown: (() => void | Promise<void>) | undefined;
    let markReported!: () => void;
    const reported = new Promise<void>((resolve) => {
      markReported = resolve;
    });
    const warnings: string[] = [];
    vi.spyOn(log, "warn").mockImplementation((message) => {
      warnings.push(String(message));
      if (String(message).includes("Remote shutdown failed")) markReported();
    });
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await startGateway(
        { port: 0, local: true, quiet: true },
        {
          readProcess: () => processRecord,
          authenticate: async () => null,
          writePort: () => {},
          removePort: () => {},
          writeProcess: (record) => {
            processRecord = record;
          },
          removeProcess: () => {
            processRecord = null;
          },
          startServer: async (_config, options) => {
            requestRemoteShutdown = options?.onShutdown;
            return {
              ready: Promise.resolve(),
              port: 49323,
              hosts: ["127.0.0.1"],
              stop: async () => {
                throw new Error("injected listener close failure");
              },
            };
          },
        },
      );

      void requestRemoteShutdown?.();
      await reported;
      expect(process.exitCode).toBe(1);
      expect(warnings.join("\n")).toContain(
        "Remote shutdown failed: injected listener close failure",
      );
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});
