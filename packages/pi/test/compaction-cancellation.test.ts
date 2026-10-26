import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test, vi } from "vitest";
import { log } from "@loreai/core";
import extension from "../src/index";
import { runCompaction } from "../src/internal";

vi.mock("@loreai/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@loreai/core")>()),
  installFetchInterceptor: vi.fn(),
}));
vi.mock("@loreai/gateway", () => ({
  prepareSourceUiAssets: async () => ({ attempted: false }),
}));

const savedEnv = { ...process.env };
const base = {
  gatewayBase: "http://127.0.0.1:3207",
  sessionID: "compaction-cancellation",
  projectPath: "/synthetic/pi-compaction",
  previousSummary: "previous summary",
  firstKeptEntryId: "entry-kept",
  tokensBefore: 4242,
};

afterEach(() => {
  process.env = { ...savedEnv };
  vi.restoreAllMocks();
  log.silenceStderr(false);
});

test.each([
  { stage: "headers", cancel: true },
  { stage: "body", cancel: true },
  { stage: "headers", cancel: false },
  { stage: "body", cancel: false },
  { stage: "pre-aborted", cancel: true },
])(
  "host cancellation at $stage (cancel=$cancel)",
  async ({ stage, cancel }) => {
    const responses: ServerResponse[] = [];
    const admitted = vi.fn();
    const reading = vi.fn();
    const settled = vi.fn();
    const controller = new AbortController();
    const hooks = new Map<string, (...args: unknown[]) => unknown>();
    const server = createServer((req, res) => {
      req.resume();
      if (req.url === "/health") {
        res.end("ok");
        return;
      }
      if (req.url !== "/v1/compact") {
        res.writeHead(404).end();
        return;
      }
      admitted();
      responses.push(res);
      if (stage === "body") {
        res.writeHead(200, { "content-type": "application/json" });
        res.write('{"summary":"');
      } else if (stage === "pre-aborted") {
        res.end(JSON.stringify({ summary: "fresh summary" }));
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const gateway = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const finish = () => {
      for (const response of responses) {
        if (!response.destroyed && !response.writableEnded)
          response.end(
            stage === "body"
              ? 'fresh summary"}'
              : JSON.stringify({ summary: "fresh summary" }),
          );
      }
    };
    const pending: Array<Promise<unknown>> = [];
    try {
      process.env.LORE_GATEWAY_URL = gateway;
      process.env.LORE_PI_FORCE_ACTIVE = "1";
      delete process.env.LORE_REMOTE_URL;
      delete process.env.LORE_DISABLED;
      const pi = {
        registerProvider: vi.fn(),
        registerTool: vi.fn(),
        on: (name: string, hook: (...args: unknown[]) => unknown) => {
          hooks.set(name, hook);
        },
      };
      await extension(pi as unknown as Parameters<typeof extension>[0]);
      expect(pi.registerProvider).toHaveBeenCalled();
      const hook = hooks.get("session_before_compact");
      if (!hook) throw new Error("Missing compaction hook");
      const nativeFetch = globalThis.fetch;
      const transport = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (input, init) => {
          const response = await nativeFetch(input, init);
          const json = response.json.bind(response);
          vi.spyOn(response, "json").mockImplementation(() => {
            reading();
            return json();
          });
          return response;
        });
      if (stage === "pre-aborted") controller.abort();
      const event: SessionBeforeCompactEvent = {
        type: "session_before_compact",
        signal: controller.signal,
        branchEntries: [],
        preparation: {
          previousSummary: base.previousSummary,
          firstKeptEntryId: base.firstKeptEntryId,
          tokensBefore: base.tokensBefore,
          messagesToSummarize: [],
          turnPrefixMessages: [],
          isSplitTurn: false,
          fileOps: {
            read: new Set<string>(),
            written: new Set<string>(),
            edited: new Set<string>(),
          },
          settings: {
            enabled: true,
            reserveTokens: 100,
            keepRecentTokens: 100,
          },
        },
      };
      const result = Promise.resolve(hook(event)).then((value) => {
        settled(value);
        return value;
      });
      pending.push(result);
      if (stage === "pre-aborted") {
        expect(await result).toBeUndefined();
        expect(transport).not.toHaveBeenCalled();
        expect(admitted).not.toHaveBeenCalled();
      } else {
        await vi.waitFor(() => expect(admitted).toHaveBeenCalledOnce());
        if (stage === "body")
          await vi.waitFor(() => expect(reading).toHaveBeenCalledOnce());
        if (cancel) {
          controller.abort();
          await vi.waitFor(
            () => expect(settled).toHaveBeenCalledWith(undefined),
            { timeout: 1000 },
          );
          expect(transport.mock.calls[0][1]?.signal).toBe(controller.signal);
        } else {
          finish();
          expect(await result).toEqual({
            compaction: {
              summary: "fresh summary",
              firstKeptEntryId: base.firstKeptEntryId,
              tokensBefore: base.tokensBefore,
            },
          });
        }
      }
    } finally {
      finish();
      await Promise.allSettled(pending);
      await hooks.get("session_shutdown")?.({ type: "session_shutdown" });
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

test("a pre-aborted helper never dispatches", async () => {
  const fetchImpl = vi.fn(async () =>
    Response.json({ summary: "fresh summary" }),
  );
  const signal = AbortSignal.abort();
  expect(await runCompaction({ ...base, signal, fetchImpl })).toBeUndefined();
  expect(fetchImpl).not.toHaveBeenCalled();
});

test.each(["headers", "body"])(
  "cancellation settles despite an abort-ignoring %s wrapper and fences late success",
  async (stage) => {
    const controller = new AbortController();
    const release = Promise.withResolvers<void>();
    const admitted = vi.fn();
    const settled = vi.fn();
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }));
    const json = vi.spyOn(response, "json").mockImplementation(async () => {
      admitted();
      await release.promise;
      return { summary: "late summary" };
    });
    const fetchImpl = vi.fn(async () => {
      if (stage === "headers") {
        admitted();
        await release.promise;
      }
      return response;
    });
    const pending = runCompaction({
      ...base,
      signal: controller.signal,
      fetchImpl,
    }).then((value) => {
      settled(value);
      return value;
    });
    try {
      await vi.waitFor(() => expect(admitted).toHaveBeenCalledOnce());
      controller.abort();
      await vi.waitFor(() => expect(settled).toHaveBeenCalledWith(undefined), {
        timeout: 1000,
      });
      release.resolve();
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
      expect(settled).toHaveBeenCalledOnce();
      if (stage === "headers") expect(json).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await pending;
      await response.body?.cancel().catch(() => {});
    }
  },
);
