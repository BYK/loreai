import { afterEach, describe, expect, test, vi } from "vitest";
import { loadConfig } from "../src/config";
import {
  passthroughResponsesCompact,
  resetPipelineState,
} from "../src/pipeline";
import { handleModelsPassthrough } from "../src/server";
import { upstreamFetch } from "../src/fetch";

vi.mock("../src/fetch", () => ({ upstreamFetch: vi.fn() }));

const mockedFetch = vi.mocked(upstreamFetch);
const config = loadConfig();

function fetchUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function modelsRequest(signal?: AbortSignal): Request {
  return new Request("http://gateway.test/v1/models", { signal });
}

const ROUTES = [
  {
    name: "POST /v1/responses/compact fallback",
    target: "/v1/responses/compact",
    invoke: (signal?: AbortSignal) =>
      passthroughResponsesCompact(
        JSON.stringify({ model: "gpt-test", input: [] }),
        { authorization: "Bearer test-key" },
        config,
        signal,
      ),
  },
  {
    name: "GET /v1/models",
    target: "/v1/models",
    invoke: (signal?: AbortSignal) =>
      handleModelsPassthrough(modelsRequest(signal), config),
  },
] as const;

afterEach(async () => {
  vi.useRealTimers();
  mockedFetch.mockReset();
  await resetPipelineState({ fast: true });
});

describe("foreground passthrough route aborts", () => {
  test.each(ROUTES)(
    "caller abort settles $name when fetch ignores signal",
    async ({ invoke, target }) => {
      mockedFetch.mockImplementation((url) =>
        fetchUrl(url).endsWith(target)
          ? new Promise(() => {})
          : Promise.resolve(new Response("{}")),
      );
      const caller = new AbortController();
      const pending = invoke(caller.signal);
      await Promise.resolve();
      caller.abort(new DOMException("caller aborted", "AbortError"));
      const response = await pending;
      expect(response.status).toBe(502);
      const init = mockedFetch.mock.calls.find(([url]) =>
        fetchUrl(url).endsWith(target),
      )?.[1];
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.signal?.aborted).toBe(true);
    },
  );

  test.each(ROUTES)(
    "300s deadline settles $name when fetch ignores signal",
    async ({ invoke, target }) => {
      vi.useFakeTimers();
      mockedFetch.mockImplementation((url) =>
        fetchUrl(url).endsWith(target)
          ? new Promise(() => {})
          : Promise.resolve(new Response("{}")),
      );
      const pending = invoke();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(300_000);
      const response = await pending;
      expect(response.status).toBe(502);
      expect(
        mockedFetch.mock.calls.find(([url]) =>
          fetchUrl(url).endsWith(target),
        )?.[1]?.signal?.aborted,
      ).toBe(true);
    },
  );

  test.each(ROUTES)(
    "preserves $name response metadata and aborts a hostile body",
    async ({ invoke, target }) => {
      let cancelled = false;
      const upstream = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("partial"));
          },
          pull() {
            return new Promise(() => {});
          },
          cancel() {
            cancelled = true;
            return new Promise<void>(() => {});
          },
        }),
        {
          status: 207,
          statusText: "Multi-Status",
          headers: { "x-upstream": "kept" },
        },
      );
      mockedFetch.mockImplementation((url) =>
        fetchUrl(url).endsWith(target)
          ? Promise.resolve(upstream)
          : Promise.resolve(new Response("{}")),
      );
      const caller = new AbortController();
      const response = await invoke(caller.signal);
      expect(response.status).toBe(207);
      expect(response.statusText).toBe("Multi-Status");
      expect(response.headers.get("x-upstream")).toBe("kept");
      const pending = response.text();
      await new Promise((resolve) => setImmediate(resolve));
      caller.abort(new DOMException("caller aborted", "AbortError"));
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(cancelled).toBe(true);
      expect(upstream.body?.locked).toBe(false);
    },
  );
});
