import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { curator, distillation, temporal } from "@loreai/core";
import { loadConfig } from "../src/config";
import {
  getLLMClientForTest,
  resetPipelineState,
  scheduleBackgroundWork,
} from "../src/pipeline";
import { setSessionAuth, _resetAuthForTest } from "../src/auth";
import { expandQuery } from "../../core/src/search";
import { createBatchLLMClient } from "../src/batch-queue";
import { upstreamFetch } from "../src/fetch";
import {
  _resetForTest,
  _setNowForTest,
  getWorkerHealth,
  makeWorkerHealth,
} from "../src/worker-health";
import type { SessionState } from "../src/translate/types";

vi.mock("../src/fetch", () => ({ upstreamFetch: vi.fn() }));

const projectPath = "/tmp/lore-worker-recovery";
let sessionID: string;
let sequence = 0;
let previous: Record<string, string | undefined>;
let clock = 1_000_000;

function response(text: string): Response {
  return new Response(
    JSON.stringify({
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    { headers: { "content-type": "application/json" } },
  );
}

function seed(): void {
  for (let n = 0; n < 3; n++)
    temporal.store({
      projectPath,
      info: {
        id: `source-${n}`,
        sessionID,
        role: "user",
        agent: "test",
        model: { providerID: "anthropic", modelID: "claude-test" },
        time: { created: Date.now() - 60_000 },
      },
      parts: [
        {
          id: `source-text-${n}`,
          type: "text",
          text: "Preserve worker health until usable output is parsed and record which worker recovered. ".repeat(
            24,
          ),
        },
      ],
    });
}

function state(): SessionState {
  return {
    sessionID,
    projectPath,
    fingerprint: "test",
    lastRequestTime: 0,
    lastUserTurnTime: 0,
    messageCount: 1,
    turnsSinceCuration: 0,
    consecutiveTextOnlyTurns: 0,
    recallStore: new Map(),
    compactionAnomalyPending: true,
    upstreamByProvider: new Map(),
    lastUpstream: {
      url: "https://api.anthropic.com",
      protocol: "anthropic",
      providerID: "anthropic",
      model: "claude-test",
      headers: {},
    },
    cacheAnalytics: {
      lastRequestBody: null,
      lastRequestBodyLength: 0,
      lastCacheRead: 0,
      lastCacheCreation: 0,
      turnCount: 0,
      bustCount: 0,
    },
  };
}

beforeEach(async () => {
  sessionID = `worker-recovery-${sequence++}`;
  previous = Object.fromEntries(
    ["LORE_WORKER_MODEL", "LORE_BATCH_DISABLED", "LORE_MAX_RETRIES"].map(
      (key) => [key, process.env[key]],
    ),
  );
  process.env.LORE_WORKER_MODEL = "anthropic/claude-test";
  process.env.LORE_BATCH_DISABLED = "1";
  process.env.LORE_MAX_RETRIES = "1";
  await resetPipelineState();
  _resetForTest();
  _resetAuthForTest();
  clock = 1_000_000;
  _setNowForTest(() => clock);
  setSessionAuth(
    sessionID,
    { scheme: "api-key", value: "sk-ant-test-key" },
    "anthropic",
  );
  vi.mocked(upstreamFetch).mockReset();
});

afterEach(async () => {
  vi.useRealTimers();
  await resetPipelineState();
  await distillation.settleBackgroundWork();
  vi.restoreAllMocks();
  _resetForTest();
  _resetAuthForTest();
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function failAdapter(workerID = "lore-distill"): Promise<void> {
  vi.mocked(upstreamFetch).mockImplementation(async () => {
    let emitted = false;
    return new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!emitted) {
            emitted = true;
            controller.enqueue(new TextEncoder().encode('{"content":'));
          } else controller.error(new Error("private upstream read failure"));
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
  });
  await expect(
    getLLMClientForTest(loadConfig()).prompt("system", "user", {
      model: { providerID: "anthropic", modelID: "claude-test" },
      sessionID,
      workerID,
    }),
  ).resolves.toBeNull();
  expect(getWorkerHealth()[0]?.workerIDs).toContain(workerID);
}

test.each(["usable", "malformed", "no-work"])(
  "urgent scheduling records only usable recovery: %s",
  async (mode) => {
    if (mode !== "no-work") seed();
    await failAdapter();
    vi.mocked(upstreamFetch).mockImplementation(async () =>
      response(
        mode === "usable"
          ? "<observations>Worker recovery is scoped to its kind.</observations>"
          : "<observations> </observations>",
      ),
    );
    const run = vi.spyOn(distillation, "run"); // actual limiter, core parser and storage
    scheduleBackgroundWork(state(), loadConfig());
    expect(run).toHaveBeenCalledOnce();
    await run.mock.results[0].value;
    expect(run.mock.calls[0][0]).toMatchObject({ urgent: true, force: true });
    expect(getWorkerHealth().length).toBe(mode === "usable" ? 0 : 1);
    expect(distillation.loadForSession(projectPath, sessionID).length).toBe(
      mode === "usable" ? 1 : 0,
    );
  },
);

test.each([
  "not JSON",
  "null",
  "{}",
  '{"ops":"wrong"}',
  '[{"op":"bogus"}]',
  "[]",
  '{"ops":[]}',
])("curator recovery respects parse validity: %s", async (text) => {
  seed();
  await failAdapter("lore-curator");
  const prompt = vi.fn(async () => text);
  await curator.run({
    llm: { prompt },
    projectPath,
    sessionID,
    workerHealth: makeWorkerHealth(sessionID, "lore-curator"),
  });
  expect(prompt).toHaveBeenCalled();
  expect(getWorkerHealth().length).toBe(
    text === "[]" || text === '{"ops":[]}' ? 0 : 1,
  );
});

test("adapter read failure is not classified as empty output", async () => {
  await failAdapter();
  expect(getWorkerHealth()[0]?.reasons).toEqual(["transport-error"]);
});

test.each(["routed", "batch"])(
  "parsed query expansion recovers through %s wrapper",
  async (wrapper) => {
    await failAdapter("lore-query-expand");
    vi.mocked(upstreamFetch).mockImplementation(async () =>
      response('["retained worker memory"]'),
    );
    const inner = getLLMClientForTest(loadConfig());
    const batchClient =
      wrapper === "batch"
        ? createBatchLLMClient(
            inner,
            {
              anthropic: "https://api.anthropic.com",
              openai: "https://api.openai.com",
            },
            () => ({ scheme: "api-key", value: "sk-ant-test-key" }),
            { providerID: "anthropic", modelID: "claude-test" },
          )
        : undefined;
    const llm = batchClient ?? inner;
    try {
      await expect(
        expandQuery(
          llm,
          "memory",
          { providerID: "anthropic", modelID: "claude-test" },
          sessionID,
        ),
      ).resolves.toEqual(["memory", "retained worker memory"]);
      expect(getWorkerHealth()).toEqual([]);
    } finally {
      await batchClient?.shutdown();
    }
  },
);

test("urgent scheduler discards a noncooperative result after pipeline cancellation", async () => {
  seed();
  await failAdapter();
  let release!: (value: Response) => void;
  vi.mocked(upstreamFetch)
    .mockReset()
    .mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
  const run = vi.spyOn(distillation, "run");
  scheduleBackgroundWork(state(), loadConfig());
  const pending = run.mock.results[0].value as Promise<unknown>;
  const rejected = expect(pending).rejects.toBeInstanceOf(Error);
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  await resetPipelineState({ fast: true });
  release(
    response("<observations>Late result must not recover.</observations>"),
  );
  await rejected;
  expect(getWorkerHealth()[0]?.workerIDs).toEqual(["lore-distill"]);
  expect(distillation.loadForSession(projectPath, sessionID)).toHaveLength(0);
});

test("query expansion cannot recover after its own timeout", async () => {
  await failAdapter("lore-query-expand");
  const recordWorkerSuccess = vi.fn(
    getLLMClientForTest(loadConfig()).recordWorkerSuccess,
  );
  let release!: (value: string) => void;
  const deadline = new AbortController();
  vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
  const pending = expandQuery(
    {
      prompt: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      recordWorkerSuccess,
    },
    "memory",
    undefined,
    sessionID,
  );
  expect(AbortSignal.timeout).toHaveBeenCalledWith(3_000);
  deadline.abort(new DOMException("query deadline", "TimeoutError"));
  release('["late expansion"]');
  await expect(pending).resolves.toEqual(["memory"]);
  expect(recordWorkerSuccess).not.toHaveBeenCalled();
  expect(getWorkerHealth()[0]?.workerIDs).toEqual(["lore-query-expand"]);
});
