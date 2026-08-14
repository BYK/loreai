import { createServer as createHttpServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import {
  createServer as createNetServer,
  type AddressInfo,
  type Server as NetServer,
} from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readPortFile, removePortFile } from "../src/portfile";
import {
  readGatewayProcessFile,
  removePidFile,
  writeGatewayProcessFile,
} from "../src/pidfile";

describe("startGateway authenticated reuse", () => {
  const teardowns: Array<() => void | Promise<void>> = [];
  let base: string;
  let previousXdg: string | undefined;

  beforeEach(() => {
    previousXdg = process.env.XDG_DATA_HOME;
    base = mkdtempSync(join(tmpdir(), "lore-start-reuse-test-"));
    process.env.XDG_DATA_HOME = base;
  });

  afterEach(async () => {
    while (teardowns.length) {
      try {
        await teardowns.pop()?.();
      } catch {
        // Best-effort listener cleanup after an assertion failure.
      }
    }
    const port = readPortFile();
    if (port) removePortFile(port);
    const record = readGatewayProcessFile();
    if (record) removePidFile(record.pid);
    if (previousXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousXdg;
    rmSync(base, { recursive: true, force: true });
  });

  it("reuses an existing authenticated gateway instead of EADDRINUSE", async () => {
    const { startGateway } = await import("../src/cli/start");
    const existing = await startGateway({ port: 0, local: true, quiet: true });
    teardowns.push(() => existing.shutdown());
    const handle = await startGateway({
      port: existing.port,
      local: true,
      quiet: true,
    });
    expect(handle.owned).toBe(false);
    expect(handle.port).toBe(existing.port);
    expect(handle.managementToken).toBe(existing.managementToken);
  });

  it("authenticates and reuses an owned gateway on forbidden port 6669", async () => {
    const { loadConfig } = await import("../src/config");
    const { currentProcessIdentity } = await import("../src/lifecycle-lock");
    const { startServer } = await import("../src/server");
    const { probeGatewayIdentityDetailed, probeGatewayStatus, startGateway } =
      await import("../src/cli/start");
    const { fetchMemoryHealth } = await import("../src/cli/inventory");
    const token = "forbidden-port-control-token".padEnd(32, "x");
    const config = loadConfig();
    config.port = 6669;
    config.portExplicit = true;
    config.hosts = ["127.0.0.1"];
    config.remoteGateway = false;
    config.hostedMode = false;
    const existing = await startServer(config, { controlToken: token });
    teardowns.push(() => existing.stop());
    const record = {
      version: 2 as const,
      pid: process.pid,
      port: 6669,
      hosts: ["127.0.0.1"],
      token,
      processIdentity:
        currentProcessIdentity() ?? `unverified:${"x".repeat(32)}`,
    };
    const baseURL = "http://127.0.0.1:6669";

    await expect(probeGatewayStatus(baseURL)).resolves.toBe("healthy");
    await expect(
      probeGatewayIdentityDetailed(baseURL, "wrong-token"),
    ).resolves.toEqual({ kind: "rejected" });
    await expect(probeGatewayIdentityDetailed(baseURL, token)).resolves.toEqual(
      {
        kind: "authenticated",
        identity: { pid: process.pid },
      },
    );
    await expect(fetchMemoryHealth(baseURL)).resolves.not.toBeNull();

    const handle = await startGateway(
      { port: 6669, local: true, quiet: true },
      { readProcess: () => record },
    );
    expect(handle.owned).toBe(false);
    expect(handle.port).toBe(6669);
  });

  it("preserves Fetch transport for non-loopback probes", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok", { status: 200 }));
    try {
      const { probeGatewayStatus } = await import("../src/cli/start");
      await expect(
        probeGatewayStatus("https://gateway.example.test"),
      ).resolves.toBe("healthy");
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://gateway.example.test/health",
        expect.anything(),
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("preserves the deadline classification for loopback probes", async () => {
    const hanging = createHttpServer(() => {});
    await new Promise<void>((resolve, reject) => {
      hanging.once("error", reject);
      hanging.listen(0, "127.0.0.1", resolve);
    });
    teardowns.push(
      () => new Promise<void>((resolve) => hanging.close(() => resolve())),
    );
    const port = (hanging.address() as AddressInfo).port;
    const { probeGatewayStatus } = await import("../src/cli/start");

    await expect(
      probeGatewayStatus(`http://127.0.0.1:${port}`, 10),
    ).resolves.toBe("timeout");
  });

  it("reuses the authenticated record's random port when no port is explicit", async () => {
    const { startGateway } = await import("../src/cli/start");
    const record = {
      version: 1 as const,
      pid: 4242,
      port: 49152,
      hosts: ["0.0.0.0", "127.0.0.1"],
      token: "a".repeat(32),
    };
    const handle = await startGateway(
      { local: true, quiet: true },
      {
        readProcess: () => record,
        authenticate: async () => "0.0.0.0",
      },
    );
    expect(handle).toMatchObject({
      owned: false,
      port: 49152,
      managementToken: record.token,
    });
    expect(handle.config.hosts).toEqual(["0.0.0.0"]);
  });

  it("reuses a gateway on a non-overlapping interface", async () => {
    const { startGateway } = await import("../src/cli/start");
    const existing = await startGateway({ port: 0, local: true, quiet: true });
    teardowns.push(() => existing.shutdown());
    const handle = await startGateway({
      port: existing.port,
      hosts: ["127.0.0.2"],
      local: true,
      quiet: true,
    });
    expect(handle.owned).toBe(false);
    expect(handle.config.hosts).toEqual(["127.0.0.1"]);
  });

  it("treats a public /health spoof as foreign", async () => {
    const { probeGateway, startGateway } = await import("../src/cli/start");
    const fake = createHttpServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "lore" }));
    });
    await new Promise<void>((resolve, reject) => {
      fake.once("error", reject);
      fake.listen(0, "127.0.0.1", resolve);
    });
    teardowns.push(
      () => new Promise<void>((resolve) => fake.close(() => resolve())),
    );
    const port = (fake.address() as AddressInfo).port;
    expect(await probeGateway(`http://127.0.0.1:${port}`)).toBe(true);
    await expect(
      startGateway({ port, local: true, quiet: true }),
    ).rejects.toThrow(/not an authenticated lore gateway/i);
  });

  it("reports a friendly error for a non-HTTP foreign process", async () => {
    const { startGateway } = await import("../src/cli/start");
    const net: NetServer = createNetServer((socket) => socket.destroy());
    const port = await new Promise<number>((resolve, reject) => {
      net.once("error", reject);
      net.listen(0, "127.0.0.1", () => {
        const address = net.address();
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("no OS-assigned port"));
      });
    });
    teardowns.push(
      () => new Promise<void>((resolve) => net.close(() => resolve())),
    );
    await expect(
      startGateway({ port, local: true, quiet: true }),
    ).rejects.toThrow(/not an authenticated lore gateway/i);
  });

  it("removes port and PID state when process-record publication fails", async () => {
    const { startGateway } = await import("../src/cli/start");
    await expect(
      startGateway(
        { port: 0, local: true, quiet: true },
        {
          writeProcess: (record) => {
            writeGatewayProcessFile(record);
            throw new Error("injected process-record write failure");
          },
        },
      ),
    ).rejects.toThrow("injected process-record write failure");
    expect(readPortFile()).toBeNull();
    expect(readGatewayProcessFile()).toBeNull();
  });

  it("retains discovery evidence if publication cleanup cannot close listener", async () => {
    const { startGateway } = await import("../src/cli/start");
    let processRecord: ReturnType<typeof readGatewayProcessFile> = null;
    let portPublished = false;
    let removed = false;
    const fakeServer = {
      ready: Promise.resolve(),
      port: 49321,
      hosts: ["127.0.0.1"],
      stop: async () => {
        throw new Error("injected listener close failure");
      },
    };
    await expect(
      startGateway(
        { port: 0, local: true, quiet: true },
        {
          readProcess: () => processRecord,
          authenticate: async () => null,
          startServer: async () => fakeServer,
          writePort: () => {
            portPublished = true;
          },
          removePort: () => {
            removed = true;
          },
          writeProcess: (record) => {
            processRecord = record;
            throw new Error("injected publication failure");
          },
          removeProcess: () => {
            removed = true;
          },
        },
      ),
    ).rejects.toThrow(/discovery evidence was retained/);
    expect(portPublished).toBe(true);
    expect((processRecord as unknown as { port: number }).port).toBe(49321);
    expect(removed).toBe(false);
  });

  it("serializes concurrent starts through process-record publication", async () => {
    const { startGateway } = await import("../src/cli/start");
    let processRecord: ReturnType<typeof readGatewayProcessFile> = {
      version: 1,
      pid: 9191,
      port: 49191,
      hosts: ["127.0.0.1"],
      token: "stale-owner-token".repeat(3),
    };
    let releaseProbe!: () => void;
    let markProbe!: () => void;
    const probeStarted = new Promise<void>((resolve) => (markProbe = resolve));
    const probeGate = new Promise<void>((resolve) => (releaseProbe = resolve));
    const io = {
      readProcess: () => processRecord,
      authenticate: async (record: NonNullable<typeof processRecord>) => {
        if (record.pid === 9191) {
          markProbe();
          await probeGate;
          return null;
        }
        return record.hosts[0];
      },
      writePort: () => {},
      removePort: () => {},
      writeProcess: (record: NonNullable<typeof processRecord>) => {
        processRecord = record;
      },
      removeProcess: (pid: number) => {
        if (processRecord?.pid === pid) processRecord = null;
      },
    };
    const firstPromise = startGateway({ local: true, quiet: true }, io);
    await probeStarted;
    const secondPromise = startGateway({ local: true, quiet: true }, io);
    releaseProbe();
    const first = await firstPromise;
    teardowns.push(() => first.shutdown());
    const second = await secondPromise;
    expect(first.owned).toBe(true);
    expect(second.owned).toBe(false);
    expect(second.port).toBe(first.port);
    expect(second.managementToken).toBe(first.managementToken);
  });

  it("makes a successor wait until shutdown removes predecessor records", async () => {
    const { startGateway } = await import("../src/cli/start");
    let processRecord: ReturnType<typeof readGatewayProcessFile> = null;
    let recordsRemoved = false;
    const sharedIO = {
      readProcess: () => processRecord,
      authenticate: async (record: NonNullable<typeof processRecord>) =>
        record.hosts[0],
      writePort: () => {},
      removePort: () => {},
      writeProcess: (record: NonNullable<typeof processRecord>) => {
        processRecord = record;
      },
      removeProcess: (pid: number) => {
        if (processRecord?.pid === pid) processRecord = null;
        recordsRemoved = true;
      },
    };
    const first = await startGateway(
      { port: 0, local: true, quiet: true },
      sharedIO,
    );
    const readsAfterRemoval: boolean[] = [];
    const shutdownPromise = first.shutdown();
    const secondPromise = startGateway(
      { port: first.port, local: true, quiet: true },
      {
        ...sharedIO,
        readProcess: () => {
          readsAfterRemoval.push(recordsRemoved);
          return processRecord;
        },
      },
    );
    await shutdownPromise;
    const second = await secondPromise;
    teardowns.push(() => second.shutdown());
    expect(readsAfterRemoval.length).toBeGreaterThan(0);
    expect(readsAfterRemoval.every(Boolean)).toBe(true);
    expect(second.owned).toBe(true);
  });
});
