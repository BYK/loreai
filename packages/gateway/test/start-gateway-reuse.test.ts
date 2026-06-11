/**
 * Regression test for the `lore run <agent>` EADDRINUSE reuse path.
 *
 * Bug: when a lore gateway was already listening on the target port,
 * `startGateway()` crashed with EADDRINUSE instead of detecting the running
 * gateway via its `/health` endpoint and reusing it. The probe-and-reuse logic
 * lived in a `catch` block, but the bind (`await startServer(config)`) was
 * placed *outside* the `try`, so the rejection escaped uncaught.
 *
 * These tests bind a real port first, then assert `startGateway()`:
 *   1. reuses a live lore gateway (returns `owned: false`) without throwing, and
 *   2. throws a friendly error when the port is held by a non-lore process.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  createServer as createNetServer,
  type Server as NetServer,
} from "node:net";

describe("startGateway EADDRINUSE reuse", () => {
  const teardowns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (teardowns.length) {
      const fn = teardowns.pop();
      try {
        await fn?.();
      } catch {
        /* best-effort cleanup */
      }
    }
  });

  it("reuses an existing lore gateway instead of throwing EADDRINUSE", async () => {
    const { startServer } = await import("../src/server");
    const { startGateway } = await import("../src/cli/start");
    const { loadConfig } = await import("../src/config");

    // Start a real lore gateway on an OS-assigned port. It serves `/health`,
    // which is exactly what the reuse probe looks for.
    const config = loadConfig();
    config.port = 0;
    config.hosts = ["127.0.0.1"];
    const existing = await startServer(config);
    teardowns.push(() => existing.stop());

    const port = existing.port;
    expect(port).toBeGreaterThan(0);

    // The occupied port now hosts a live gateway. startGateway() must detect it
    // via the /health probe and adopt it (owned:false) rather than crash.
    const handle = await startGateway({ port, local: true, quiet: true });
    teardowns.push(() => handle.shutdown());

    expect(handle.owned).toBe(false);
    expect(handle.port).toBe(port);
  });

  it("throws a friendly error when the port is held by a non-lore process", async () => {
    const { startGateway } = await import("../src/cli/start");

    // Occupy a port with a plain TCP server that does NOT speak HTTP. It
    // destroys incoming connections so the /health probe fails fast (rather
    // than hanging until the probe timeout).
    const net: NetServer = createNetServer((socket) => socket.destroy());
    const port: number = await new Promise((resolve, reject) => {
      net.once("error", reject);
      net.listen(0, "127.0.0.1", () => {
        const addr = net.address();
        if (addr && typeof addr === "object") resolve(addr.port);
        else reject(new Error("no OS-assigned port"));
      });
    });
    teardowns.push(
      () => new Promise<void>((resolve) => net.close(() => resolve())),
    );

    // Explicit port held by a non-lore process: probe returns false, so
    // startGateway() surfaces the actionable error instead of a raw EADDRINUSE.
    await expect(
      startGateway({ port, local: true, quiet: true }),
    ).rejects.toThrow(/not a lore gateway/i);
  });
});
