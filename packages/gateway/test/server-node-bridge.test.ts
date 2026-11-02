import { EventEmitter } from "node:events";
import { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { Duplex } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import { handleForegroundBodyRoute, handleNodeRequest } from "../src/server";
import { decodeRequestBody } from "../src/http-body";
import type { GatewayRequest } from "../src/translate/types";
import {
  handleRequest,
  resetPipelineState,
  setPostResponseStartObserverForTest,
  setUpstreamInterceptor,
} from "../src/pipeline";
import { FOREGROUND_REQUEST_TIMEOUT_MS } from "../src/sse-inactivity";
import { loadConfig } from "../src/config";
import { responseCompletionCallbacks } from "../src/response-completion";

class FakeRequest extends EventEmitter {
  method = "GET";
  url = "/test";
  headers: Record<string, string> = {};
  complete = false;
  socket = new EventEmitter();
}

class FakeResponse extends EventEmitter {
  writableEnded = false;
  writableFinished = false;
  destroyed = false;
  headersSent = false;
  status = 0;
  headers: Record<string, string> = {};
  chunks: Uint8Array[] = [];
  writeResults: boolean[] = [];
  backpressureOnText?: string;
  backpressureTriggered = false;
  autoCloseOnEnd = true;

  writeHead(status: number, headers: Record<string, string> = {}): this {
    this.status = status;
    this.headers = headers;
    this.headersSent = true;
    return this;
  }

  write(chunk: Uint8Array): boolean {
    this.chunks.push(chunk);
    if (
      !this.backpressureTriggered &&
      this.backpressureOnText &&
      Buffer.from(chunk).toString("utf8").includes(this.backpressureOnText)
    ) {
      this.backpressureTriggered = true;
      return false;
    }
    return this.writeResults.shift() ?? true;
  }

  end(chunk?: string): this {
    if (chunk) this.chunks.push(new TextEncoder().encode(chunk));
    this.writableEnded = true;
    if (this.autoCloseOnEnd) {
      this.writableFinished = true;
      this.emit("finish");
      this.emit("close");
    }
    return this;
  }

  destroy(): this {
    this.destroyed = true;
    this.emit("close");
    return this;
  }
}

function asRequest(req: FakeRequest): IncomingMessage {
  return req as unknown as IncomingMessage;
}

function asResponse(res: FakeResponse): ServerResponse {
  return res as unknown as ServerResponse;
}

function expectListenersCleaned(req: FakeRequest, res: FakeResponse): void {
  expect(req.listenerCount("aborted")).toBe(0);
  expect(req.listenerCount("close")).toBe(0);
  expect(req.listenerCount("error")).toBe(0);
  expect(res.listenerCount("close")).toBe(0);
  expect(res.listenerCount("error")).toBe(0);
  expect(res.listenerCount("drain")).toBe(0);
  expect(res.listenerCount("finish")).toBe(0);
  expect(req.socket.listenerCount("close")).toBe(0);
  expect(req.socket.listenerCount("error")).toBe(0);
}

function responsesEvent(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

function terminalResponsesSSE(id: string): string {
  return (
    responsesEvent("response.created", {
      response: { id, model: "gpt-5.6-sol", status: "in_progress" },
    }) +
    responsesEvent("response.completed", {
      response: {
        id,
        model: "gpt-5.6-sol",
        status: "completed",
        output: [],
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    })
  );
}

function loadLocalConfig() {
  const config = loadConfig();
  config.remoteGateway = false;
  config.hostedMode = false;
  return config;
}

describe("node:http ingress lifecycle branches", () => {
  test.each([false, true])(
    "a response body failure before output returns a retryable JSON error (empty chunk: %s)",
    async (emptyChunk) => {
      const req = new FakeRequest();
      req.complete = true;
      const res = new FakeResponse();
      const source = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            if (emptyChunk) controller.enqueue(new Uint8Array());
          },
          pull(controller) {
            controller.error(new Error("private upstream transport detail"));
          },
        }),
        {
          headers: {
            "content-type": "text/event-stream",
            "content-length": "999",
          },
        },
      );
      const onDiscard = vi.fn();
      const onComplete = vi.fn();
      const onResponseFinished = vi.fn();
      responseCompletionCallbacks.set(source, {
        onDiscard,
        onComplete,
        onResponseFinished,
      });
      await handleNodeRequest(
        asRequest(req),
        asResponse(res),
        () => source,
        "127.0.0.1",
        3207,
      );
      expect(res.status).toBe(502);
      expect(res.writableFinished).toBe(true);
      expect(res.destroyed).toBe(false);
      expect(res.headers).toEqual({
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      const body = Buffer.concat(res.chunks).toString("utf8");
      expect(JSON.parse(body)).toEqual({
        type: "error",
        error: {
          type: "api_error",
          message:
            "Gateway response stream failed before output; retry the request.",
        },
      });
      expect(body).not.toContain("private upstream");
      expect(source.body?.locked).toBe(false);
      expect(onDiscard).toHaveBeenCalledTimes(1);
      await new Promise((resolve) => setImmediate(resolve));
      expect(onComplete).not.toHaveBeenCalled();
      expect(onResponseFinished).not.toHaveBeenCalled();
      expectListenersCleaned(req, res);
    },
  );

  test("real Node HTTP response sends error headers and body instead of closing an unflushed socket", async () => {
    const wire: Buffer[] = [];
    const socket = new Duplex({
      read() {},
      write(chunk, _encoding, callback) {
        wire.push(Buffer.from(chunk));
        callback();
      },
    }) as Socket;
    const req = new IncomingMessage(socket);
    req.method = "GET";
    req.url = "/test";
    req.complete = true;
    const res = new ServerResponse(req);
    res.assignSocket(socket);
    try {
      await handleNodeRequest(
        req,
        res,
        () =>
          new Response(
            new ReadableStream({
              pull(controller) {
                controller.error(new Error("first read failed"));
              },
            }),
          ),
        "127.0.0.1",
        3207,
      );
      const response = Buffer.concat(wire).toString("utf8");
      expect(response).toMatch(/^HTTP\/1\.1 502 /);
      expect(response).toContain("application/json");
      expect(response).toContain(
        "Gateway response stream failed before output",
      );
      expect(res.writableFinished).toBe(true);
    } finally {
      socket.destroy();
    }
  });

  test("a body failure after output closes the socket without appending JSON", async () => {
    const req = new FakeRequest();
    req.complete = true;
    const res = new FakeResponse();
    let sent = false;
    await handleNodeRequest(
      asRequest(req),
      asResponse(res),
      () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              if (sent) controller.error(new Error("later read failed"));
              else {
                sent = true;
                controller.enqueue(new TextEncoder().encode("partial"));
              }
            },
          }),
        ),
      "127.0.0.1",
      3207,
    );
    expect(res.status).toBe(200);
    expect(res.destroyed).toBe(true);
    expect(Buffer.concat(res.chunks).toString("utf8")).toBe("partial");
    expectListenersCleaned(req, res);
  });

  test.each([200, 204])(
    "a clean empty body preserves HTTP %s",
    async (status) => {
      const req = new FakeRequest();
      req.complete = true;
      const res = new FakeResponse();
      await handleNodeRequest(
        asRequest(req),
        asResponse(res),
        () => new Response(null, { status }),
        "127.0.0.1",
        3207,
      );
      expect(res.status).toBe(status);
      expect(res.writableFinished).toBe(true);
      expect(res.destroyed).toBe(false);
      expect(res.chunks).toHaveLength(0);
      expectListenersCleaned(req, res);
    },
  );

  test.each(["aborted", "incomplete-close", "request-error"] as const)(
    "%s aborts pending handler work and removes listeners",
    async (branch) => {
      const req = new FakeRequest();
      const res = new FakeResponse();
      let requestSignal: AbortSignal | undefined;
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => (markStarted = resolve));
      const handling = handleNodeRequest(
        asRequest(req),
        asResponse(res),
        (request) => {
          requestSignal = request.signal;
          markStarted();
          return new Promise(() => {});
        },
        "127.0.0.1",
        3207,
      );
      await started;
      if (branch === "aborted") req.emit("aborted");
      else if (branch === "incomplete-close") req.emit("close");
      else req.emit("error", new Error("request failed"));
      await handling;
      expect(requestSignal?.aborted).toBe(true);
      expectListenersCleaned(req, res);
    },
  );

  test("a normal-complete request close does not abort", async () => {
    const req = new FakeRequest();
    const res = new FakeResponse();
    let requestSignal: AbortSignal | undefined;
    await handleNodeRequest(
      asRequest(req),
      asResponse(res),
      (request) => {
        requestSignal = request.signal;
        req.complete = true;
        req.emit("close");
        return new Response("ok");
      },
      "127.0.0.1",
      3207,
    );
    expect(requestSignal?.aborted).toBe(false);
    expect(res.writableEnded).toBe(true);
    expectListenersCleaned(req, res);
  });

  test("a premature ServerResponse close aborts and cancels the response reader", async () => {
    const req = new FakeRequest();
    req.complete = true;
    const res = new FakeResponse();
    let requestSignal: AbortSignal | undefined;
    let sourceCancelled = false;
    let markReading!: () => void;
    const reading = new Promise<void>((resolve) => (markReading = resolve));
    const source = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("partial"));
        },
        pull() {
          markReading();
          return new Promise(() => {});
        },
        cancel() {
          sourceCancelled = true;
          return new Promise<void>(() => {});
        },
      }),
    );
    const handling = handleNodeRequest(
      asRequest(req),
      asResponse(res),
      (request) => {
        requestSignal = request.signal;
        return source;
      },
      "127.0.0.1",
      3207,
    );
    await reading;
    while (res.chunks.length === 0) await Promise.resolve();
    res.emit("close");
    await handling;
    expect(requestSignal?.aborted).toBe(true);
    expect(sourceCancelled).toBe(true);
    expect(source.body?.locked).toBe(false);
    expectListenersCleaned(req, res);
  });

  test("an independently emitted ServerResponse error aborts and cancels exactly once", async () => {
    const req = new FakeRequest();
    req.complete = true;
    const res = new FakeResponse();
    let requestSignal: AbortSignal | undefined;
    let cancelCount = 0;
    let markReading!: () => void;
    const reading = new Promise<void>((resolve) => (markReading = resolve));
    const source = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("partial"));
        },
        pull() {
          markReading();
          return new Promise(() => {});
        },
        cancel() {
          cancelCount++;
          return new Promise<void>(() => {});
        },
      }),
    );
    const handling = handleNodeRequest(
      asRequest(req),
      asResponse(res),
      (request) => {
        requestSignal = request.signal;
        return source;
      },
      "127.0.0.1",
      3207,
    );
    await reading;
    while (res.chunks.length === 0) await Promise.resolve();
    expect(() => res.emit("error", new Error("response failed"))).not.toThrow();
    await handling;
    expect(requestSignal?.aborted).toBe(true);
    expect(cancelCount).toBe(1);
    expect(source.body?.locked).toBe(false);
    expect(res.destroyed).toBe(true);
    expect(Buffer.concat(res.chunks).toString("utf8")).toBe("partial");
    expectListenersCleaned(req, res);
  });

  test("a late response error after end but before finish remains owned and adds no JSON suffix", async () => {
    const req = new FakeRequest();
    req.complete = true;
    const res = new FakeResponse();
    res.autoCloseOnEnd = false;
    let requestSignal: AbortSignal | undefined;
    const handling = handleNodeRequest(
      asRequest(req),
      asResponse(res),
      (request) => {
        requestSignal = request.signal;
        return new Response("one-chunk");
      },
      "127.0.0.1",
      3207,
    );
    while (!res.writableEnded) await Promise.resolve();
    const chunksBeforeError = res.chunks.map((chunk) => Buffer.from(chunk));
    expect(() =>
      res.emit("error", new Error("late write failure")),
    ).not.toThrow();
    await handling;
    expect(requestSignal?.aborted).toBe(true);
    expect(res.destroyed).toBe(true);
    expect(res.chunks).toEqual(chunksBeforeError);
    expect(Buffer.concat(res.chunks).toString("utf8")).toBe("one-chunk");
    expectListenersCleaned(req, res);
  });

  test("response backpressure pauses Web body reads until drain", async () => {
    const req = new FakeRequest();
    req.complete = true;
    const res = new FakeResponse();
    res.writeResults.push(false, true);
    let pulls = 0;
    const chunks = [
      new TextEncoder().encode("one"),
      new TextEncoder().encode("two"),
    ];
    const source = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls++;
          const chunk = chunks.shift();
          if (chunk) controller.enqueue(chunk);
          else controller.close();
        },
      }),
    );
    const handling = handleNodeRequest(
      asRequest(req),
      asResponse(res),
      () => source,
      "127.0.0.1",
      3207,
    );
    while (res.listenerCount("drain") === 0) await Promise.resolve();
    const pullsWhilePaused = pulls;
    await new Promise((resolve) => setImmediate(resolve));
    expect(pulls).toBe(pullsWhilePaused);
    expect(res.chunks).toHaveLength(1);
    res.emit("drain");
    await handling;
    expect(res.chunks).toHaveLength(2);
    expect(res.writableEnded).toBe(true);
    expectListenersCleaned(req, res);
  });

  test("deferred streaming work starts after end despite terminal backpressure", async () => {
    const req = new FakeRequest();
    req.complete = true;
    const res = new FakeResponse();
    res.backpressureOnText = "event: response.completed";
    let postResponseSawEnd: boolean | undefined;
    setPostResponseStartObserverForTest(() => {
      postResponseSawEnd = res.writableEnded;
    });
    setUpstreamInterceptor(
      async () =>
        new Response(terminalResponsesSSE("resp_node_backpressure"), {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    const gatewayRequest: GatewayRequest = {
      protocol: "openai-responses",
      model: "gpt-5.6-sol",
      system: "You are a coding agent.",
      messages: [
        { role: "user", content: [{ type: "text", text: "continue" }] },
      ],
      tools: [{ name: "read", description: "Read a file", inputSchema: {} }],
      stream: true,
      maxTokens: 1024,
      metadata: {},
      rawHeaders: {
        authorization: "Bearer test-key",
        "x-lore-agent": "coder",
        "x-lore-project": process.cwd(),
        "x-lore-provider": "openai",
        "x-lore-upstream-url": "https://api.openai.com/v1",
        "x-lore-session-id": "node-backpressure-session",
      },
    };

    try {
      const handling = handleNodeRequest(
        asRequest(req),
        asResponse(res),
        () => handleRequest(gatewayRequest, loadLocalConfig()),
        "127.0.0.1",
        3207,
      );
      await vi.waitFor(
        () => {
          expect(res.backpressureTriggered).toBe(true);
          expect(res.listenerCount("drain")).toBeGreaterThan(0);
        },
        { timeout: 10_000 },
      );

      expect(Buffer.concat(res.chunks).toString("utf8")).toContain(
        "event: response.completed",
      );
      expect(res.writableEnded).toBe(false);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(postResponseSawEnd).toBeUndefined();

      res.emit("drain");
      await handling;
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(res.writableEnded).toBe(true);
      expect(postResponseSawEnd).toBe(true);
      expectListenersCleaned(req, res);
    } finally {
      setPostResponseStartObserverForTest(undefined);
      setUpstreamInterceptor(undefined);
      await resetPipelineState();
    }
  });

  test("disconnect while waiting for drain cancels without reading more", async () => {
    const req = new FakeRequest();
    req.complete = true;
    const res = new FakeResponse();
    res.writeResults.push(false);
    let cancelCount = 0;
    let pulls = 0;
    const source = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls++;
          if (pulls === 1) {
            controller.enqueue(new TextEncoder().encode("one"));
          }
          return new Promise(() => {});
        },
        cancel() {
          cancelCount++;
          return new Promise<void>(() => {});
        },
      }),
    );
    const handling = handleNodeRequest(
      asRequest(req),
      asResponse(res),
      () => source,
      "127.0.0.1",
      3207,
    );
    while (res.listenerCount("drain") === 0) await Promise.resolve();
    const pullsWhilePaused = pulls;
    res.emit("close");
    await handling;
    expect(pulls).toBe(pullsWhilePaused);
    expect(cancelCount).toBe(1);
    expect(source.body?.locked).toBe(false);
    expectListenersCleaned(req, res);
  });

  test("normal response close after end does not abort", async () => {
    const req = new FakeRequest();
    req.complete = true;
    const res = new FakeResponse();
    let requestSignal: AbortSignal | undefined;
    await handleNodeRequest(
      asRequest(req),
      asResponse(res),
      (request) => {
        requestSignal = request.signal;
        return new Response("complete");
      },
      "127.0.0.1",
      3207,
    );
    expect(res.writableEnded).toBe(true);
    expect(requestSignal?.aborted).toBe(false);
    expectListenersCleaned(req, res);
  });
});

test("the application foreground deadline starts before request body decoding", async () => {
  vi.useFakeTimers();
  let cancelled = false;
  let markPull!: () => void;
  const pulling = new Promise<void>((resolve) => (markPull = resolve));
  const source = new ReadableStream<Uint8Array>({
    pull() {
      markPull();
      return new Promise(() => {});
    },
    cancel() {
      cancelled = true;
      return new Promise<void>(() => {});
    },
  });
  const req = new Request("http://gateway.test/v1/messages", {
    method: "POST",
    body: source,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  try {
    const pending = handleForegroundBodyRoute(req, async (scoped) => {
      await decodeRequestBody(scoped);
      return new Response("should not complete");
    });
    const rejected = expect(pending).rejects.toMatchObject({
      name: "TimeoutError",
    });
    await pulling;
    await vi.advanceTimersByTimeAsync(FOREGROUND_REQUEST_TIMEOUT_MS);
    await rejected;
    expect(cancelled).toBe(true);
    expect(source.locked).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});
