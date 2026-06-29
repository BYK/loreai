/**
 * Regression test for the `startGateway({ quiet })` flag.
 *
 * In-process callers (the OpenCode plugin and the Pi extension) start the
 * gateway with `{ quiet: true, local: true }` because they run inside the host
 * agent's full-screen TUI, where ANY stdout/stderr write corrupts the rendered
 * screen. Before the fix, `startGateway()` ignored `quiet` entirely and printed
 * its startup/shutdown notices via `console.error`, leaking into the TUI (part
 * of the Pi breakage Daniel Griesser reported).
 *
 * These tests pin the contract:
 *   - quiet:true  → no `[lore] Shutting down…` on stderr (routed to file log).
 *   - quiet:false → the message is still printed (preserves `lore start` CLI).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("startGateway quiet flag", () => {
  const teardowns: Array<() => void | Promise<void>> = [];
  const savedXdg = process.env.XDG_DATA_HOME;

  afterEach(async () => {
    while (teardowns.length) {
      const fn = teardowns.pop();
      try {
        await fn?.();
      } catch {
        /* best-effort cleanup */
      }
    }
    if (savedXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = savedXdg;
  });

  /** Start an owned gateway with port/pid/log files isolated to a temp dir. */
  async function startOwned(quiet: boolean) {
    // Isolate gateway.port / lore.pid writes so we never clobber a real
    // running gateway's discovery files.
    const dataHome = mkdtempSync(join(tmpdir(), "lore-quiet-test-"));
    process.env.XDG_DATA_HOME = dataHome;
    teardowns.push(() => rmSync(dataHome, { recursive: true, force: true }));

    const { startGateway } = await import("../src/cli/start");
    const handle = await startGateway({ port: 0, local: true, quiet });
    expect(handle.owned).toBe(true);
    return handle;
  }

  it("does not print the shutdown notice to stderr when quiet", async () => {
    const handle = await startOwned(true);
    const errSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      await handle.shutdown();
    } finally {
      const printedShutdown = errSpy.mock.calls.some((args) =>
        args.some((a) => typeof a === "string" && a.includes("Shutting down")),
      );
      errSpy.mockRestore();
      expect(printedShutdown).toBe(false);
    }
  });

  it("prints the shutdown notice to stderr when not quiet", async () => {
    const handle = await startOwned(false);
    const errSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      await handle.shutdown();
    } finally {
      const printedShutdown = errSpy.mock.calls.some((args) =>
        args.some((a) => typeof a === "string" && a.includes("Shutting down")),
      );
      errSpy.mockRestore();
      expect(printedShutdown).toBe(true);
    }
  });
});
