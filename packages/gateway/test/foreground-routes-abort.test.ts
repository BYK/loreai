import { afterEach, describe, expect, test, vi } from "vitest";
import { loadConfig } from "../src/config";
import {
  passthroughResponsesCompact,
  resetPipelineState,
} from "../src/pipeline";
import { handleModelsPassthrough, startServer } from "../src/server";
import { upstreamFetch } from "../src/fetch";

vi.mock("../src/fetch", () => ({ upstreamFetch: vi.fn() }));

const mockedFetch = vi.mocked(upstreamFetch);
const config = loadConfig();
config.remoteGateway = false;
config.hostedMode = false;

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
  test("pipeline reset aborts an actual Bedrock streaming route and unblocks listener close", async () => {
    let upstreamSignal: AbortSignal | undefined;
    let markUpstreamStarted!: () => void;
    const upstreamStarted = new Promise<void>((resolve) => {
      markUpstreamStarted = resolve;
    });
    let upstreamCancelled = false;
    mockedFetch.mockImplementation(async (_url, init) => {
      upstreamSignal = init?.signal ?? undefined;
      markUpstreamStarted();
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("partial"));
          },
          pull() {
            return new Promise(() => {});
          },
          cancel() {
            upstreamCancelled = true;
          },
        }),
        {
          headers: {
            "content-type": "application/vnd.amazon.eventstream",
          },
        },
      );
    });

    const server = await startServer({
      ...config,
      port: 0,
      hosts: ["127.0.0.1"],
      remoteGateway: false,
      hostedMode: false,
      bedrockRegion: "us-east-1",
    });
    try {
      const response = await fetch(
        `http://127.0.0.1:${server.port}/v1/model/test/converse-stream`,
        { method: "POST", body: "{}" },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "application/vnd.amazon.eventstream",
      );
      await upstreamStarted;

      const responseBody = response.body;
      if (!responseBody) throw new Error("expected a streaming response body");
      const reader = responseBody.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe(
        "partial",
      );
      const stalledRead = reader.read();

      // Match production shutdown ordering: stop accepting requests first,
      // then abort registered foreground work so server.close() can settle.
      const listenerClose = server.stop();
      await resetPipelineState({ fast: true });

      // The Web-stream AbortError crosses node:http as a terminated socket;
      // either transport surface is acceptable, but the read must settle.
      await expect(stalledRead).rejects.toBeDefined();
      await expect(listenerClose).resolves.toBeUndefined();
      expect(upstreamSignal?.aborted).toBe(true);
      expect(upstreamCancelled).toBe(true);
    } finally {
      await server.stop();
    }
  });

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
