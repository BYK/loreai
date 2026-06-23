import { describe, test, expect, vi, afterEach } from "vitest";
import { createServer, type Server } from "node:http";

/**
 * upstreamFetch chooses its transport by runtime:
 *  - Bun  → node:https (no hardcoded timeout cap), never undici.
 *  - Node → undici fetch with a body/header-timeout-disabled dispatcher.
 *
 * `isBun` is evaluated at module load, so each test sets `globalThis.Bun`,
 * resets the module registry, mocks the deps, and dynamically imports the
 * module fresh.
 */
describe("upstreamFetch runtime split", () => {
  const originalBun = (globalThis as { Bun?: unknown }).Bun;

  afterEach(() => {
    if (originalBun === undefined) {
      delete (globalThis as { Bun?: unknown }).Bun;
    } else {
      (globalThis as { Bun?: unknown }).Bun = originalBun;
    }
    vi.resetModules();
    vi.restoreAllMocks();
    vi.doUnmock("undici");
  });

  test("Bun: uses node:http(s) and never imports undici", async () => {
    // Stand up a tiny HTTP server that returns a known body
    const server: Server = await new Promise((resolve) => {
      const s = createServer((_req, res) => {
        res.writeHead(200, {
          "content-type": "text/plain",
          "x-test": "from-server",
        });
        res.end("hello from node:http");
      });
      s.listen(0, () => resolve(s));
    });
    const port = (server.address() as { port: number }).port;

    try {
      (globalThis as { Bun?: unknown }).Bun = { version: "1.3.14" };
      vi.resetModules();

      const undiciLoaded = vi.fn();
      vi.doMock("undici", () => {
        undiciLoaded();
        return { fetch: vi.fn(), Agent: class {} };
      });

      const { upstreamFetch } = await import("../src/fetch");
      const res = await upstreamFetch(`http://localhost:${port}/test`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "hi" }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("x-test")).toBe("from-server");
      expect(await res.text()).toBe("hello from node:http");
      // undici must never be loaded under Bun.
      expect(undiciLoaded).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  test("Bun: streams response body incrementally", async () => {
    // SSE-style streaming server
    const server: Server = await new Promise((resolve) => {
      const s = createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        let n = 0;
        const iv = setInterval(() => {
          n++;
          res.write(`event: ping\ndata: {"seq":${n}}\n\n`);
          if (n >= 3) {
            clearInterval(iv);
            res.end();
          }
        }, 50);
      });
      s.listen(0, () => resolve(s));
    });
    const port = (server.address() as { port: number }).port;

    try {
      (globalThis as { Bun?: unknown }).Bun = { version: "1.3.14" };
      vi.resetModules();
      vi.doMock("undici", () => ({
        fetch: vi.fn(),
        Agent: class {},
      }));

      const { upstreamFetch } = await import("../src/fetch");
      const res = await upstreamFetch(`http://localhost:${port}/stream`);
      expect(res.status).toBe(200);

      // Read the body incrementally via the standard ReadableStream API
      const reader = res.body!.getReader();
      const chunks: string[] = [];
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(decoder.decode(value, { stream: true }));
      }
      const body = chunks.join("");
      expect(body).toContain('{"seq":1}');
      expect(body).toContain('{"seq":3}');
    } finally {
      server.close();
    }
  });

  test("Node: uses undici fetch with a timeout-disabled dispatcher", async () => {
    delete (globalThis as { Bun?: unknown }).Bun;
    vi.resetModules();

    const undiciFetch = vi.fn(
      async (_input: unknown, _init?: { dispatcher?: unknown }) =>
        new Response("ok"),
    );
    const agentArgs: unknown[] = [];
    class FakeAgent {
      constructor(opts: unknown) {
        agentArgs.push(opts);
      }
    }
    vi.doMock("undici", () => ({ fetch: undiciFetch, Agent: FakeAgent }));

    const { upstreamFetch } = await import("../src/fetch");
    await upstreamFetch("https://api.example.com/v1/messages", {
      method: "POST",
    });
    // second call should reuse the memoized dispatcher (Agent built once).
    await upstreamFetch("https://api.example.com/v1/messages", {
      method: "POST",
    });

    expect(undiciFetch).toHaveBeenCalledTimes(2);
    expect(agentArgs).toHaveLength(1);
    expect(agentArgs[0]).toEqual({ bodyTimeout: 0, headersTimeout: 0 });
    const init = undiciFetch.mock.calls[0][1];
    expect(init?.dispatcher).toBeInstanceOf(FakeAgent);
  });
});
