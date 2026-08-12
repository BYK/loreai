import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { distillation } from "@loreai/core";
import { loadConfig } from "../src/config";
import { startIdleScheduler } from "../src/idle";
import { resetPipelineState, scheduleBackgroundWork } from "../src/pipeline";
import {
  _resetAuthForTest,
  setSessionAuth,
  type AuthCredential,
} from "../src/auth";
import type { SessionState, UpstreamSnapshot } from "../src/translate/types";

const workerModel = "bedrock/anthropic.claude-haiku-4-5-v1:0";
let previousWorkerModel: string | undefined;

function snapshot(providerID = "amazon-bedrock"): UpstreamSnapshot {
  return {
    url: "https://bedrock-alias.invalid/anthropic",
    protocol: "anthropic",
    providerID,
    model: "anthropic.claude-haiku-4-5-v1:0",
    headers: {},
  };
}

function state(sessionID: string): SessionState {
  const upstream = snapshot();
  return {
    sessionID,
    projectPath: `/tmp/${sessionID}`,
    fingerprint: "fingerprint",
    lastRequestTime: 0,
    lastUserTurnTime: 0,
    messageCount: 1,
    turnsSinceCuration: 0,
    consecutiveTextOnlyTurns: 0,
    recallStore: new Map(),
    cacheAnalytics: {
      lastRequestBody: null,
      lastRequestBodyLength: 0,
      lastCacheRead: 0,
      lastCacheCreation: 0,
      turnCount: 0,
      bustCount: 0,
    },
    lastUpstream: upstream,
    upstreamByProvider: new Map([["amazon-bedrock", upstream]]),
  };
}

function credential(value: string): AuthCredential {
  return { scheme: "api-key", value };
}

beforeEach(async () => {
  previousWorkerModel = process.env.LORE_WORKER_MODEL;
  process.env.LORE_WORKER_MODEL = workerModel;
  _resetAuthForTest();
  await resetPipelineState();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  _resetAuthForTest();
  await resetPipelineState();
  if (previousWorkerModel === undefined) delete process.env.LORE_WORKER_MODEL;
  else process.env.LORE_WORKER_MODEL = previousWorkerModel;
});

describe("alias-aware worker auth guards", () => {
  test("normal scheduling accepts amazon-bedrock auth for a bedrock worker only", async () => {
    const config = loadConfig();
    const aliasState = state("alias-normal");
    aliasState.compactionAnomalyPending = true;
    setSessionAuth(
      aliasState.sessionID,
      credential("amazon-bedrock-key"),
      "amazon-bedrock",
    );
    const unrelatedState = state("unrelated-normal");
    unrelatedState.compactionAnomalyPending = true;
    setSessionAuth(
      unrelatedState.sessionID,
      credential("deepseek-key"),
      "deepseek",
    );
    const run = vi
      .spyOn(distillation, "run")
      .mockResolvedValue({ distilled: 0, rounds: 0 });

    scheduleBackgroundWork(aliasState, config);
    scheduleBackgroundWork(unrelatedState, config);
    await Promise.resolve();

    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toMatchObject({
      sessionID: aliasState.sessionID,
      model: { providerID: "bedrock" },
    });
  });

  test("idle scheduling accepts the alias and rejects unrelated credentials", async () => {
    vi.useFakeTimers();
    const config = { ...loadConfig(), idleTimeoutSeconds: 1 };
    const aliasState = state("alias-idle");
    const unrelatedState = state("unrelated-idle");
    setSessionAuth(
      aliasState.sessionID,
      credential("amazon-bedrock-key"),
      "amazon-bedrock",
    );
    setSessionAuth(
      unrelatedState.sessionID,
      credential("deepseek-key"),
      "deepseek",
    );
    const sessions = new Map([
      [aliasState.sessionID, aliasState],
      [unrelatedState.sessionID, unrelatedState],
    ]);
    const doIdleWork = vi.fn(async () => {});
    const stop = startIdleScheduler(config, sessions, doIdleWork);

    await vi.advanceTimersByTimeAsync(30_000);
    stop();

    expect(doIdleWork).toHaveBeenCalledTimes(1);
    expect(doIdleWork).toHaveBeenCalledWith(aliasState.sessionID, aliasState);
  });
});
