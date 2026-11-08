import { afterEach, expect, test, vi } from "vitest";
import { installFetchInterceptor } from "../src/fetch-interceptor";
import { NATIVE_RECALL_TURN_HEADER } from "../src/recall-turn";

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  vi.unstubAllGlobals();
});

test("observes native turn identity locally and strips it from gateway and passthrough network requests", async () => {
  const received: Headers[] = [];
  const observed: Headers[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      received.push(
        new Headers(
          init?.headers ??
            (input instanceof Request ? input.headers : undefined),
        ),
      );
      return Response.json({});
    }),
  );
  cleanup = installFetchInterceptor({
    gatewayBase: "http://127.0.0.1:3207",
    getHeaders: () => ({}),
    onRequestHeaders: (headers) => observed.push(new Headers(headers)),
  });
  const headers = {
    "content-type": "application/json",
    "x-api-key": "key",
    "x-lore-session-id": "session",
    [NATIVE_RECALL_TURN_HEADER]: "private-user-message-id",
  };
  await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "model", messages: [] }),
  });
  await fetch("http://127.0.0.1:3207/v1/messages", {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "model", messages: [] }),
  });
  await fetch("https://unrelated.example/file", {
    headers: { [NATIVE_RECALL_TURN_HEADER]: "private-user-message-id" },
  });
  expect(observed).toHaveLength(2);
  expect(
    observed.every(
      (entry) =>
        entry.get(NATIVE_RECALL_TURN_HEADER) === "private-user-message-id",
    ),
  ).toBe(true);
  expect(received).toHaveLength(3);
  expect(received.every((entry) => !entry.has(NATIVE_RECALL_TURN_HEADER))).toBe(
    true,
  );
  expect(headers[NATIVE_RECALL_TURN_HEADER]).toBe("private-user-message-id");
});
