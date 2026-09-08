import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  db,
  distillation,
  distillLimiter,
  loadSessionTracking,
  temporal,
} from "@loreai/core";
import { loadConfig } from "../src/config";
import { getSessionAuth } from "../src/auth";
import {
  evictIdlePipelineSessionsForTest,
  getActiveSessions,
  handleRequest,
  isPipelineSessionActiveForTest,
  pendingPipelineSessionClaimCountForTest,
  resetPipelineState,
  scheduleBackgroundWork,
  scheduleStreamingPostResponseForTest,
  setMaxActivePipelineRequestsForTest,
  setPipelinePreUpstreamPauseForTest,
  setUpstreamInterceptor,
  singleFlightStableLtm,
  streamingPostResponsePendingForTest,
} from "../src/pipeline";
import {
  _setConcurrencyForTest,
  runBackground,
  drainBackground,
} from "../src/background-limiter";
import type { GatewayRequest } from "../src/translate/types";

const HOUR = 3_600_000;
const config = () => ({
  ...loadConfig(),
  remoteGateway: false,
  hostedMode: false,
});
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function request(header = "retention-session"): GatewayRequest {
  return {
    protocol: "openai-responses",
    model: "gpt-5.4-mini",
    system: "You are a coding agent.",
    messages: [
      { role: "user", content: [{ type: "text", text: "Read the file" }] },
    ],
    tools: [{ name: "read", description: "Read a file", inputSchema: {} }],
    stream: true,
    maxTokens: 1024,
    metadata: {},
    rawHeaders: {
      authorization: "Bearer retention-test-key",
      "x-lore-agent": "coder",
      "x-lore-session-id": header,
      "x-lore-project": process.cwd(),
      "x-lore-provider": "openai",
      "x-lore-upstream-url": "https://api.openai.com/v1",
    },
  };
}
function toolResponse() {
  const item = {
    type: "function_call",
    id: "fc_retention",
    call_id: "call_retention",
    name: "read",
    arguments: JSON.stringify({ path: "README.md" }),
    status: "completed",
  };
  const event = (type: string, data: Record<string, unknown>) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  return new Response(
    event("response.created", {
      response: {
        id: "resp_retention",
        model: "gpt-5.4-mini",
        status: "in_progress",
      },
    }) +
      event("response.output_item.added", {
        output_index: 0,
        item: { ...item, arguments: "", status: "in_progress" },
      }) +
      event("response.function_call_arguments.done", {
        output_index: 0,
        item_id: item.id,
        arguments: item.arguments,
      }) +
      event("response.output_item.done", { output_index: 0, item }) +
      event("response.completed", {
        response: {
          id: "resp_retention",
          model: "gpt-5.4-mini",
          status: "completed",
          output: [item],
          usage: { input_tokens: 100, output_tokens: 10 },
        },
      }),
    { headers: { "content-type": "text/event-stream" } },
  );
}
async function startSession() {
  expect(await (await handleRequest(request(), config())).text()).toContain(
    "call_retention",
  );
  await vi.waitFor(() => expect(streamingPostResponsePendingForTest()).toBe(0));
  const state = [...getActiveSessions().values()].find(
    (s) => s.headerSessionId === "retention-session",
  );
  expect(state).toBeDefined();
  expect(state!.lastStopReason).toBe("tool_use");
  return state!;
}

beforeEach(async () => {
  await resetPipelineState();
  setUpstreamInterceptor(async () => toolResponse());
});
afterEach(async () => {
  vi.useRealTimers();
  setUpstreamInterceptor(undefined);
  await resetPipelineState();
  vi.restoreAllMocks();
});

it("gives a slow tool response a full grace period, releases snapshots, and resumes the durable session", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const start = Date.now();
  setUpstreamInterceptor(async () => {
    vi.setSystemTime(start + 2 * HOUR);
    return toolResponse();
  });
  const state = await startSession();
  expect(state.lastRequestTime).toBe(start);
  expect(state.lastResponseTime).toBeGreaterThanOrEqual(start + 2 * HOUR);
  const completed = state.lastResponseTime!;
  expect(state.cacheAnalytics.lastRequestBody).not.toBeNull();
  expect(state.lastUpstream).toBeDefined();
  expect(getSessionAuth(state.sessionID, "openai")).not.toBeNull();
  const tracking = loadSessionTracking(state.sessionID);
  const before = db()
    .query("SELECT id FROM temporal_messages WHERE session_id = ? ORDER BY id")
    .all(state.sessionID);
  expect(before.length).toBeGreaterThan(0);
  // Warm the actual stable-LTM cache, then prove eviction removes it.
  await singleFlightStableLtm(state.sessionID, async () => ({
    formatted: "old",
    tokenCount: 1,
  }));
  expect(evictIdlePipelineSessionsForTest(config(), completed + HOUR - 1)).toBe(
    0,
  );
  expect(evictIdlePipelineSessionsForTest(config(), completed + HOUR)).toBe(1);
  expect(getActiveSessions().has(state.sessionID)).toBe(false);
  expect(state.cacheAnalytics.lastRequestBody).toBeNull();
  expect(state.cacheAnalytics.lastNormalizedBody).toBeNull();
  expect(state.lastUpstream).toBeUndefined();
  expect(state.upstreamByProvider.size).toBe(0);
  expect(getSessionAuth(state.sessionID, "openai")).toBeNull();
  expect(loadSessionTracking(state.sessionID)?.headerSessionId).toBe(
    tracking?.headerSessionId,
  );
  expect(
    db()
      .query(
        "SELECT id FROM temporal_messages WHERE session_id = ? ORDER BY id",
      )
      .all(state.sessionID),
  ).toEqual(before);
  const recompute = vi.fn(async () => ({ formatted: "new", tokenCount: 1 }));
  expect(await singleFlightStableLtm(state.sessionID, recompute)).toEqual({
    formatted: "new",
    tokenCount: 1,
  });
  expect(recompute).toHaveBeenCalledOnce();

  vi.setSystemTime(start + 3 * HOUR + 1);
  setUpstreamInterceptor(async () => toolResponse());
  const resumed = request();
  resumed.messages.push(
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "call_retention",
          name: "read",
          input: { path: "README.md" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolUseId: "call_retention",
          content: [{ type: "text", text: "file contents" }],
        },
      ],
    },
  );
  const response = await handleRequest(resumed, config());
  expect(response.status).toBe(200);
  await response.text();
  await vi.waitFor(() => expect(streamingPostResponsePendingForTest()).toBe(0));
  const live = getActiveSessions().get(state.sessionID);
  expect(live).toBeDefined();
  expect(live).not.toBe(state);
  expect(live?.headerSessionId).toBe("retention-session");
  expect(getActiveSessions().size).toBe(1);
  const after = db()
    .query("SELECT id FROM temporal_messages WHERE session_id = ? ORDER BY id")
    .all(state.sessionID);
  expect(after).toEqual(expect.arrayContaining(before));
});

it("expires a failed continuation after its owner settles", async () => {
  const state = await startSession();
  setUpstreamInterceptor(async () => {
    throw new Error("upstream transport failed");
  });
  const failed = await handleRequest(request(), config());
  expect(failed.status).toBe(502);
  await failed.text();
  await tick();
  expect(state.lastStopReason).toBe("tool_use");
  expect(isPipelineSessionActiveForTest(state.sessionID)).toBe(false);
  expect(evictIdlePipelineSessionsForTest(config(), Date.now() + HOUR)).toBe(1);
});

it("keeps cancellation-racing request preparation alive until its producer settles", async () => {
  const state = await startSession();
  const entered = deferred();
  const release = deferred();
  const caller = new AbortController();
  setPipelinePreUpstreamPauseForTest(release.promise, entered.resolve);
  const req = request();
  req.signal = caller.signal;
  const pending = handleRequest(req, config());
  try {
    await entered.promise;
    caller.abort(new DOMException("client disconnected", "AbortError"));
    expect(isPipelineSessionActiveForTest(state.sessionID)).toBe(true);
    expect(
      evictIdlePipelineSessionsForTest(config(), Date.now() + 2 * HOUR),
    ).toBe(0);
  } finally {
    release.resolve();
    await pending;
    setPipelinePreUpstreamPauseForTest(undefined);
    await tick();
  }
  expect(isPipelineSessionActiveForTest(state.sessionID)).toBe(false);
  expect(
    evictIdlePipelineSessionsForTest(config(), Date.now() + 2 * HOUR),
  ).toBe(1);
});

it("retains a queued continuation when global admission remains full after its finalizer settles", async () => {
  const state = await startSession();
  const finalizer = deferred();
  const entered = deferred();
  const transport = deferred();
  scheduleStreamingPostResponseForTest(
    state.sessionID,
    () => finalizer.promise,
  );
  setMaxActivePipelineRequestsForTest(2);
  const caller = new AbortController();
  const queuedReq = request();
  queuedReq.signal = caller.signal;
  const queued = handleRequest(queuedReq, config());
  await vi.waitFor(() =>
    expect(pendingPipelineSessionClaimCountForTest()).toBe(1),
  );
  setUpstreamInterceptor(async () => {
    entered.resolve();
    await transport.promise;
    return toolResponse();
  });
  const other = handleRequest(request("other-retention-session"), config());
  try {
    await entered.promise;
    // Lowering capacity models an already full global queue at hand-off.
    setMaxActivePipelineRequestsForTest(1);
    finalizer.resolve();
    await tick();
    expect(streamingPostResponsePendingForTest()).toBe(0);
    expect(pendingPipelineSessionClaimCountForTest()).toBe(1);
    expect(isPipelineSessionActiveForTest(state.sessionID)).toBe(true);
    expect(
      evictIdlePipelineSessionsForTest(config(), Date.now() + 2 * HOUR),
    ).toBe(0);
    caller.abort();
    await queued;
    expect(
      evictIdlePipelineSessionsForTest(config(), Date.now() + 2 * HOUR),
    ).toBe(1);
  } finally {
    caller.abort();
    finalizer.resolve();
    transport.resolve();
    await queued;
    await (await other).text();
    await tick();
  }
});

it("protects incremental distillation while it waits outside the per-session limiter", async () => {
  const state = await startSession();
  _setConcurrencyForTest(1);
  const entered = deferred();
  const release = deferred();
  const blocker = runBackground(async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  // Eligibility is fixed; scheduling and queue ownership are real.
  vi.spyOn(temporal, "undistilledTokens").mockReturnValue(100_000);
  const distill = vi
    .spyOn(distillation, "run")
    .mockResolvedValue({ rounds: 0, distilled: 0 });
  try {
    scheduleBackgroundWork(state, config());
    await tick();
    expect(distill).not.toHaveBeenCalled();
    expect(distillLimiter.isBusy(state.sessionID)).toBe(false);
    expect(
      evictIdlePipelineSessionsForTest(config(), Date.now() + 2 * HOUR),
    ).toBe(0);
  } finally {
    release.resolve();
    await blocker;
    await vi.waitFor(() => expect(distill).toHaveBeenCalledOnce());
    await drainBackground();
    await tick();
  }
  expect(distill).toHaveBeenCalledOnce();
  expect(
    evictIdlePipelineSessionsForTest(config(), Date.now() + 2 * HOUR),
  ).toBe(1);
});
