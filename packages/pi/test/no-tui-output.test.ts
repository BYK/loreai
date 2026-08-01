import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import lorePiExtension from "../src/index";

/**
 * Regression test for the Pi TUI-corruption bug reported by Daniel Griesser
 * (Slack, 2026-06-28): the extension "completely broke the output in the shell
 * of Pi" because it wrote routine status through raw console.* calls. Pi runs a
 * full-screen TUI, so ANY stdout/stderr write corrupts the rendered screen.
 *
 * The fix routes all routine/expected-fallback messages through the core `log`
 * module (file-based, terminal-suppressed). This test pins that invariant:
 * across extension load → session_start → a compaction that the gateway rejects
 * with 404 `session_not_found` (Daniel's "couldn't find the session"), the
 * extension must write NOTHING to stdout/stderr.
 *
 * Mutation check: revert any `console.*`→`log.*` change in src/index.ts and this
 * test fails (the spied console method is called).
 */

type AnyHandler = (...args: unknown[]) => unknown;

function createMockPi() {
  const providers: Array<{ name: string; config: unknown }> = [];
  const handlers = new Map<string, AnyHandler>();
  const pi = {
    registerProvider(name: string, config: unknown): void {
      providers.push({ name, config });
    },
    on(event: string, handler: AnyHandler): void {
      handlers.set(event, handler);
    },
  };
  return { pi, providers, handlers };
}

describe("pi extension — no TUI (stdout/stderr) output", () => {
  let server: Server;
  let baseUrl: string;
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    // Minimal fake gateway: healthy, but rejects compaction as a session that
    // never routed through Lore — the exact path that used to dump to stdout.
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      if (url.pathname === "/v1/compact") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: "session_not_found",
            message: "No active session found for the given headers.",
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    globalThis.fetch = originalFetch;
  });

  test("stays silent across load, session_start, and compaction-404", async () => {
    // Activate the otherwise-inert-in-test extension against the fake gateway.
    process.env.LORE_PI_FORCE_ACTIVE = "1";
    process.env.LORE_GATEWAY_URL = baseUrl;
    delete process.env.LORE_DISABLED;
    delete process.env.LORE_REMOTE_URL;

    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const consoleSpies = (
      ["log", "info", "warn", "error", "debug"] as const
    ).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );

    try {
      const { pi, handlers } = createMockPi();

      await lorePiExtension(
        pi as unknown as Parameters<typeof lorePiExtension>[0],
      );

      // The extension must have wired up its hooks (i.e. it went active).
      const onStart = handlers.get("session_start");
      const onCompact = handlers.get("session_before_compact");
      expect(onStart).toBeTypeOf("function");
      expect(onCompact).toBeTypeOf("function");

      // session_start: updates the session id and re-registers providers.
      await onStart?.(
        {},
        {
          cwd: process.cwd(),
          sessionManager: { getSessionFile: () => "/tmp/lore-pi-session" },
        },
      );

      // Compaction → gateway returns 404 session_not_found → graceful fallback.
      const result = await onCompact?.(
        {
          preparation: {
            previousSummary: "",
            firstKeptEntryId: "entry-1",
            tokensBefore: 100,
          },
        },
        {},
      );
      expect(result).toBeUndefined();

      // The whole point: zero raw terminal writes on success + fallback paths.
      expect(stdoutSpy).not.toHaveBeenCalled();
      expect(stderrSpy).not.toHaveBeenCalled();
      for (const spy of consoleSpies) {
        expect(spy).not.toHaveBeenCalled();
      }
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
      for (const spy of consoleSpies) {
        spy.mockRestore();
      }
    }
  });
});
