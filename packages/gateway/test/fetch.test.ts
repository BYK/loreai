import { describe, test, expect, vi, afterEach } from "vitest";

/**
 * upstreamFetch chooses its transport by runtime:
 *  - Bun  → native fetch (getOriginalFetch) + `timeout: false`, never undici.
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
    vi.doUnmock("@loreai/core");
    vi.doUnmock("undici");
  });

  test("Bun: uses native fetch with timeout:false and never imports undici", async () => {
    (globalThis as { Bun?: unknown }).Bun = { version: "1.3.14" };
    vi.resetModules();

    const nativeFetch = vi.fn(
      async (
        _input: RequestInfo | URL,
        _init?: RequestInit & { timeout?: unknown },
      ) => new Response("ok"),
    );
    vi.doMock("@loreai/core", () => ({ getOriginalFetch: () => nativeFetch }));

    const undiciLoaded = vi.fn();
    vi.doMock("undici", () => {
      undiciLoaded();
      return { fetch: vi.fn(), Agent: class {} };
    });

    const { upstreamFetch } = await import("../src/fetch");
    const res = await upstreamFetch("https://api.example.com/v1/messages", {
      method: "POST",
      body: "{}",
    });

    expect(await res.text()).toBe("ok");
    expect(nativeFetch).toHaveBeenCalledTimes(1);
    const init = nativeFetch.mock.calls[0][1];
    expect(init?.method).toBe("POST");
    expect(init?.timeout).toBe(false);
    // undici must never be loaded under Bun.
    expect(undiciLoaded).not.toHaveBeenCalled();
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
    vi.doMock("@loreai/core", () => ({
      getOriginalFetch: () => {
        throw new Error("Node path must not use native fetch");
      },
    }));

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
