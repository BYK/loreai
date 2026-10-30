import { afterEach, expect, test } from "vitest";
import { createHarness, type Harness } from "./helpers/harness";
import { DEFAULT_MODEL, makeFixtureEntry } from "./helpers/fixtures";
import { createGatewayApp } from "../src/app";
import { loadConfig } from "../src/config";
import {
  activePipelineRequestCountForTest,
  pendingPipelineSessionClaimCountForTest,
  setMaxDetachedPipelineRequestsForTest,
} from "../src/pipeline";

let harness: Harness | undefined;
afterEach(async () => harness?.teardown());

async function setup(remoteGateway = false, otherAccount = false) {
  const marker = `parallel-native-memory-${crypto.randomUUID()}`;
  const sessionID = `parallel-native-session-${crypto.randomUUID()}`;
  const gatewayAuthToken = "parallel-native-test-gateway-token-32-bytes";
  harness = await createHarness({
    configOverrides: { remoteGateway, gatewayAuthToken },
    fixtures: [marker, ...(otherAccount ? [`other-${marker}`] : [])].map(
      (content, seq) =>
        makeFixtureEntry({
          seq,
          model: DEFAULT_MODEL,
          requestMessages: [{ role: "user", content }],
          responseText: "remembered",
          wasStreaming: false,
        }),
    ),
  });
  const headers = {
    "content-type": "application/json",
    "x-api-key": "parallel-native-key",
    "x-lore-session-id": sessionID,
    "x-lore-project": process.cwd(),
    "x-lore-gateway-token": gatewayAuthToken,
  };
  const chat = await harness.chat(
    {
      model: DEFAULT_MODEL,
      max_tokens: 1024,
      system: "You are a coding assistant. ".repeat(30),
      messages: [{ role: "user", content: marker }],
    },
    headers["x-api-key"],
    headers,
  );
  expect(chat.status).toBe(200);
  await chat.text();
  if (otherAccount) {
    const other = await harness.chat(
      {
        model: DEFAULT_MODEL,
        max_tokens: 1024,
        system: "You are a coding assistant. ".repeat(30),
        messages: [{ role: "user", content: `other-${marker}` }],
      },
      "other-native-key",
      { ...headers, "x-api-key": "other-native-key" },
    );
    expect(other.status).toBe(200);
    await other.text();
  }
  await expect.poll(activePipelineRequestCountForTest).toBe(0);
  const app = createGatewayApp({
    ...loadConfig(),
    remoteGateway,
    gatewayAuthToken,
  });
  const call = async (
    signal?: AbortSignal,
    overrides: Record<string, string> = {},
    path = "/v1/recall",
  ) =>
    app.fetch(
      new Request(`http://gateway${path}`, {
        method: "POST",
        headers: { ...headers, ...overrides },
        body: JSON.stringify(
          path === "/v1/recall"
            ? { query: marker, scope: "session" }
            : { project_path: process.cwd() },
        ),
        signal,
      }),
      { peerAddress: "127.0.0.1" },
    );
  const consume = async (response: Response) => ({
    status: response.status,
    body: await response.text(),
  });
  const rejectOverload = async () => {
    const controller = new AbortController();
    let result: Awaited<ReturnType<typeof consume>> | undefined;
    const pending = call(controller.signal)
      .then(consume)
      .then((response) => {
        result = response;
      });
    try {
      // A capacity mutant must fail promptly, not wait for the held first
      // response to drain or pass by eventually timing out a queued request.
      await expect.poll(() => result?.status).toBe(503);
      expect(result?.body).not.toContain(marker);
    } finally {
      controller.abort();
      await pending;
    }
  };
  const runningHarness = harness;
  return {
    marker,
    call,
    consume,
    rejectOverload,
    restart: () => runningHarness.restartPipeline(),
  };
}

test.each([false, true])(
  "parallel native calls queue in order without changing credential/project isolation (remote=%s)",
  async (remoteGateway) => {
    const { marker, call, consume } = await setup(remoteGateway);
    // Leaving the first response unread faithfully holds the session claim,
    // making every subsequent tool call contend before the first completes.
    const first = await call();
    expect(first.status).toBe(200);
    const order: number[] = [];
    const queued = Array.from({ length: 4 }, (_, index) =>
      call()
        .then(consume)
        .then((result) => {
          order.push(index);
          return result;
        }),
    );
    try {
      await expect.poll(pendingPipelineSessionClaimCountForTest).toBe(4);
      for (const [overrides, status] of [
        [{ "x-api-key": "wrong-key" }, 404],
        [{ "x-lore-project": "/other-project" }, 403],
      ] as const) {
        const rejected = await consume(await call(undefined, overrides));
        expect(rejected.status).toBe(status);
        expect(rejected.body).not.toContain(marker);
      }
    } finally {
      await first.text();
      await Promise.allSettled(queued);
    }
    const results = await Promise.all(queued);
    expect(
      results.every(
        (result) => result.status === 200 && result.body.includes(marker),
      ),
    ).toBe(true);
    expect(order).toEqual([0, 1, 2, 3]);
    await expect.poll(pendingPipelineSessionClaimCountForTest).toBe(0);
    await expect.poll(activePipelineRequestCountForTest).toBe(0);
  },
);

test("aborting a middle waiter preserves FIFO, remaining work and the generation queue contract", async () => {
  const { marker, call, consume } = await setup();
  const first = await call();
  const controller = new AbortController();
  const before = call().then(consume);
  const middle = call(controller.signal).then(consume);
  const after = call().then(consume);
  try {
    await expect.poll(pendingPipelineSessionClaimCountForTest).toBe(3);
    controller.abort();
    expect((await middle).body).not.toContain(marker);
    await expect.poll(pendingPipelineSessionClaimCountForTest).toBe(2);
    // Compaction retains its existing one-waiter contract; the native route
    // cannot silently widen queue capacity for generation/control operations.
    const compact = await consume(await call(undefined, {}, "/v1/compact"));
    expect(compact.status).toBe(503);
    expect(pendingPipelineSessionClaimCountForTest()).toBe(2);
  } finally {
    await first.text();
    await Promise.allSettled([before, middle, after]);
  }
  for (const result of await Promise.all([before, after])) {
    expect(result.status).toBe(200);
    expect(result.body).toContain(marker);
  }
  await expect.poll(pendingPipelineSessionClaimCountForTest).toBe(0);
  await expect.poll(activePipelineRequestCountForTest).toBe(0);
});

test("all queued calls count toward the credential budget without blocking another tenant", async () => {
  const { marker, call, consume, rejectOverload } = await setup(true, true);
  const first = await call();
  const queued = Array.from({ length: 15 }, () => call().then(consume));
  try {
    await expect.poll(pendingPipelineSessionClaimCountForTest).toBe(15);
    await rejectOverload();
    expect(pendingPipelineSessionClaimCountForTest()).toBe(15);
    const other = await consume(
      await call(undefined, { "x-api-key": "other-native-key" }),
    );
    expect(other.status).toBe(200);
    expect(other.body).toContain(`other-${marker}`);
  } finally {
    await first.text();
    await Promise.allSettled(queued);
  }
  for (const result of await Promise.all(queued)) {
    expect(result.status).toBe(200);
    expect(result.body).toContain(marker);
    expect(result.body).not.toContain(`other-${marker}`);
  }
  await expect.poll(activePipelineRequestCountForTest).toBe(0);
});

test("the global outstanding budget includes every queued native call", async () => {
  const { call, consume, rejectOverload } = await setup();
  setMaxDetachedPipelineRequestsForTest(4);
  const first = await call();
  const queued = Array.from({ length: 3 }, () => call().then(consume));
  try {
    await expect.poll(pendingPipelineSessionClaimCountForTest).toBe(3);
    await rejectOverload();
    expect(pendingPipelineSessionClaimCountForTest()).toBe(3);
  } finally {
    await first.text();
    await Promise.allSettled(queued);
  }
  expect(
    (await Promise.all(queued)).every((result) => result.status === 200),
  ).toBe(true);
  await expect.poll(activePipelineRequestCountForTest).toBe(0);
});

test("reset cancels all native waiters and releases their claims", async () => {
  const { marker, call, consume, restart } = await setup();
  const first = await call();
  const queued = Array.from({ length: 4 }, () => call().then(consume));
  await expect.poll(pendingPipelineSessionClaimCountForTest).toBe(4);
  await restart();
  await first.body?.cancel().catch(() => {});
  for (const result of await Promise.all(queued)) {
    expect(result.status).not.toBe(200);
    expect(result.body).not.toContain(marker);
  }
  expect(pendingPipelineSessionClaimCountForTest()).toBe(0);
  expect(activePipelineRequestCountForTest()).toBe(0);
  const resumed = await consume(await call());
  expect(resumed.status).toBe(200);
  expect(resumed.body).toContain(marker);
});
