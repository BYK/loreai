import { execFileSync, fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest, type ClientRequest } from "node:http";
import { arch, cpus, platform, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseOpenAIResponsesRequest } from "../../src/translate/openai-responses";
import type {
  ChildMessage,
  ChildStartOptions,
  ChildStats,
  ParentMessage,
  ScenarioBarrier,
  ScenarioRelease,
  SessionPersistenceSnapshot,
} from "./protocol";
import {
  MIXED_LOAD_PROFILES,
  MIXED_LOAD_SCENARIOS,
  REFERENCE_TARGETS,
  appendResponsesContinuation,
  assertResponsesWorkloadParity,
  generateResponsesWorkload,
  summarizeBenchmarkSamples,
  type BenchmarkSample,
  type MixedLoadScenario,
  type ResponsesWorkloadBody,
  type WorkloadOptions,
} from "./workload";

interface RunnerOptions {
  profiles?: readonly WorkloadOptions[];
  scenarios?: readonly MixedLoadScenario[];
  warmups?: number;
  samples?: number;
  outputPath?: string;
  keepRoot?: boolean;
  nativeProviderDiagnostic?: boolean;
}

interface HttpResult {
  status: number;
  body: string;
  elapsedMs: number;
}

interface HealthMeasurement {
  status: number;
  bodyHash: string;
  bodyBytes: number;
  statusField: string | null;
  schemaValid: boolean;
  elapsedMs: number;
}

interface TurnMeasurement {
  samples: BenchmarkSample[];
  responseStatuses: number[];
  clientOutputHashes: string[];
  health: HealthMeasurement[];
  persistenceBefore: SessionPersistenceSnapshot;
  persistenceAfter: SessionPersistenceSnapshot;
  sourceInputItems: number;
  sourceNormalizedMessages: number;
}

const SANITIZED_READ_UNAVAILABLE_BODY = JSON.stringify({
  type: "error",
  error: {
    type: "server_error",
    message:
      "Memory preparation is temporarily unavailable; retry the request.",
  },
});

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

class BenchmarkChild {
  readonly process: ChildProcess;
  readonly timings = new Map<
    string,
    import("../../src/benchmark-timing").BenchmarkTimingSample
  >();
  port = 0;
  pid = 0;
  activeSequence = 0;
  private nextControlId = 0;
  private readonly timingWaiters = new Map<
    string,
    (sample: import("../../src/benchmark-timing").BenchmarkTimingSample) => void
  >();
  private readonly controlWaiters = new Map<
    number,
    (message: ChildMessage) => void
  >();
  private readonly activeWaiters = new Set<{
    after: number;
    resolve: (sequence: number) => void;
  }>();
  private readonly lifecycleEvents = new Set<string>();
  private readonly lifecycleWaiters = new Map<string, () => void>();
  private stopRequested = false;
  private readyResolve: (() => void) | undefined;
  private readonly ready = new Promise<void>((resolve) => {
    this.readyResolve = resolve;
  });
  private fatal: Error | undefined;

  constructor() {
    const childPath = fileURLToPath(new URL("./child.ts", import.meta.url));
    this.process = fork(childPath, [], {
      execArgv: ["--expose-gc", "--conditions=development", "--import", "tsx"],
      env: { ...process.env, NODE_ENV: "benchmark" },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    // Child output is untrusted dependency text. Drain both streams forever
    // without reading or forwarding payloads.
    this.process.stdout?.resume();
    this.process.stderr?.resume();
    this.process.on("message", (message: ChildMessage) => {
      if (message.type === "ready") {
        this.port = message.port;
        this.pid = message.pid;
        this.readyResolve?.();
        return;
      }
      if (message.type === "timing") {
        this.timings.set(message.sample.requestId, message.sample);
        this.timingWaiters.get(message.sample.requestId)?.(message.sample);
        this.timingWaiters.delete(message.sample.requestId);
        return;
      }
      if (message.type === "scenario-active") {
        this.activeSequence = message.sequence;
        for (const waiter of this.activeWaiters)
          if (message.sequence > waiter.after) {
            this.activeWaiters.delete(waiter);
            waiter.resolve(message.sequence);
          }
        return;
      }
      if (message.type === "request-lifecycle") {
        const key = `${message.requestId}:${message.event}`;
        this.lifecycleEvents.add(key);
        this.lifecycleWaiters.get(key)?.();
        this.lifecycleWaiters.delete(key);
        return;
      }
      if (
        message.type === "stats" ||
        message.type === "barrier" ||
        message.type === "release" ||
        message.type === "ack"
      ) {
        this.controlWaiters.get(message.id)?.(message);
        this.controlWaiters.delete(message.id);
        return;
      }
      this.fatal = new Error(message.message);
      this.readyResolve?.();
    });
    this.process.once("exit", (code) => {
      if (code !== 0 && !this.fatal)
        this.fatal = new Error(`benchmark child exited with code ${code}`);
      this.readyResolve?.();
    });
  }

  private send(message: ParentMessage): void {
    if (!this.process.connected)
      throw new Error("benchmark child disconnected");
    this.process.send(message, (error) => {
      if (error && !this.fatal) this.fatal = new Error("benchmark IPC failed");
    });
  }

  private control<T extends ChildMessage>(
    build: (id: number) => ParentMessage,
    accept: (message: ChildMessage) => message is T,
  ): Promise<T> {
    const id = ++this.nextControlId;
    const outbound = build(id);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.controlWaiters.delete(id);
        reject(new Error(`benchmark child ${outbound.type} control timed out`));
      }, 30_000);
      timeout.unref();
      this.controlWaiters.set(id, (message) => {
        clearTimeout(timeout);
        if (!accept(message)) {
          reject(new Error("benchmark child returned the wrong control reply"));
          return;
        }
        resolve(message);
      });
      this.send(outbound);
    });
  }

  async start(options: ChildStartOptions): Promise<void> {
    this.send({ type: "start", options });
    await this.ready;
    if (this.fatal) throw this.fatal;
    if (this.port === 0)
      throw new Error("benchmark child did not report a port");
  }

  async beginMeasurement(): Promise<void> {
    await this.control(
      (id) => ({ type: "begin-measurement", id }),
      (message): message is Extract<ChildMessage, { type: "ack" }> =>
        message.type === "ack",
    );
  }

  async activate(): Promise<ScenarioBarrier> {
    const reply = await this.control(
      (id) => ({ type: "activate", id }),
      (message): message is Extract<ChildMessage, { type: "barrier" }> =>
        message.type === "barrier",
    );
    return reply.barrier;
  }

  async flushHeldUpstream(): Promise<void> {
    await this.control(
      (id) => ({ type: "flush-upstream", id }),
      (message): message is Extract<ChildMessage, { type: "ack" }> =>
        message.type === "ack",
    );
  }

  async release(): Promise<ScenarioRelease> {
    const reply = await this.control(
      (id) => ({ type: "release", id }),
      (message): message is Extract<ChildMessage, { type: "release" }> =>
        message.type === "release",
    );
    return reply.release;
  }

  async stats(quiescent = false): Promise<ChildStats> {
    const reply = await this.control(
      (id) => ({ type: "stats", id, quiescent }),
      (message): message is Extract<ChildMessage, { type: "stats" }> =>
        message.type === "stats",
    );
    return reply.stats;
  }

  timing(
    requestId: string,
  ): Promise<import("../../src/benchmark-timing").BenchmarkTimingSample> {
    const existing = this.timings.get(requestId);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.timingWaiters.delete(requestId);
        reject(new Error(`missing benchmark timing for ${requestId}`));
      }, 30_000);
      timeout.unref();
      this.timingWaiters.set(requestId, (sample) => {
        clearTimeout(timeout);
        resolve(sample);
      });
    });
  }

  waitForScenarioActive(after: number): Promise<number> {
    if (this.activeSequence > after)
      return Promise.resolve(this.activeSequence);
    return new Promise((resolve, reject) => {
      const waiter = { after, resolve };
      const timeout = setTimeout(() => {
        this.activeWaiters.delete(waiter);
        reject(new Error("scenario active barrier timed out"));
      }, 30_000);
      timeout.unref();
      waiter.resolve = (sequence) => {
        clearTimeout(timeout);
        resolve(sequence);
      };
      this.activeWaiters.add(waiter);
    });
  }

  waitForLifecycle(
    requestId: string,
    event: "foreground-acquired" | "foreground-released",
  ): Promise<void> {
    const key = `${requestId}:${event}`;
    if (this.lifecycleEvents.has(key)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.lifecycleWaiters.delete(key);
        reject(new Error("request lifecycle barrier timed out"));
      }, 30_000);
      timeout.unref();
      this.lifecycleWaiters.set(key, () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.stopRequested) return;
    if (this.process.exitCode !== null || !this.process.connected) return;
    this.stopRequested = true;
    this.process.kill("SIGTERM");
    this.process.disconnect();
  }
}

function startRequest(
  port: number,
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    cancellationExpected?: boolean;
  } = {},
): { request: ClientRequest; result: Promise<HttpResult>; cancel: () => void } {
  const startedAt = performance.now();
  const request = httpRequest(
    {
      host: "127.0.0.1",
      port,
      path,
      agent: false,
      method: options.method ?? "GET",
      headers: options.headers,
    },
    (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        settleResolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
          elapsedMs: performance.now() - startedAt,
        }),
      );
    },
  );
  let settleResolve: (value: HttpResult) => void = () => {};
  let settleReject: (error: Error) => void = () => {};
  const result = new Promise<HttpResult>((resolve, reject) => {
    settleResolve = resolve;
    settleReject = reject;
  });
  request.on("error", (error) => {
    if (options.cancellationExpected) {
      settleResolve({
        status: 0,
        body: "",
        elapsedMs: performance.now() - startedAt,
      });
      return;
    }
    settleReject(error);
  });
  if (options.body) request.write(options.body);
  request.end();
  return {
    request,
    result,
    cancel: () => request.destroy(),
  };
}

function request(
  port: number,
  path: string,
  options: Parameters<typeof startRequest>[2] = {},
): Promise<HttpResult> {
  return startRequest(port, path, options).result;
}

function responseHeaders(
  projectPath: string,
  sessionId: string,
  requestId: string,
  body: string,
): Record<string, string> {
  return {
    authorization: "Bearer benchmark-local-token",
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body)),
    "x-lore-project": projectPath,
    "x-lore-session-id": sessionId,
    "x-lore-benchmark-id": requestId,
    "x-lore-context-boundary-capability": "v1",
  };
}

function healthMeasurement(result: HttpResult): HealthMeasurement {
  let statusField: string | null = null;
  let schemaValid = false;
  try {
    const parsed = JSON.parse(result.body) as Record<string, unknown>;
    statusField = typeof parsed.status === "string" ? parsed.status : null;
    schemaValid =
      statusField === "ok" &&
      typeof parsed.version === "string" &&
      parsed.embeddings !== null &&
      typeof parsed.embeddings === "object" &&
      parsed.worker !== null &&
      typeof parsed.worker === "object";
  } catch {
    // The report records a fixed invalid classification, never response text.
  }
  return {
    status: result.status,
    bodyHash: hash(result.body),
    bodyBytes: Buffer.byteLength(result.body),
    statusField,
    schemaValid,
    elapsedMs: result.elapsedMs,
  };
}

async function sampleHealth(
  child: BenchmarkChild,
): Promise<HealthMeasurement[]> {
  return Promise.all(
    Array.from({ length: 3 }, async () =>
      healthMeasurement(await request(child.port, "/health")),
    ),
  );
}

function assertExpectedResponse(
  scenario: MixedLoadScenario,
  response: HttpResult,
): void {
  if (scenario === "read-workers-unavailable") {
    if (
      response.status !== 503 ||
      response.body !== SANITIZED_READ_UNAVAILABLE_BODY
    )
      throw new Error(
        "read-workers-unavailable did not return the fixed sanitized 503",
      );
    return;
  }
  if (response.status !== 200)
    throw new Error(`${scenario} request returned HTTP ${response.status}`);
}

async function timedTurn(input: {
  child: BenchmarkChild;
  body: ResponsesWorkloadBody;
  projectPath: string;
  sessionId: string;
  requestId: string;
  scenario: MixedLoadScenario;
  concurrentSessions?: number;
  coordinateHeldUpstream?: boolean;
}): Promise<TurnMeasurement> {
  const bodyText = JSON.stringify(input.body);
  const before = await input.child.stats();
  const count = input.concurrentSessions ?? 1;
  const activeBefore = input.child.activeSequence;
  const requestIds = Array.from({ length: count }, (_, index) =>
    count === 1 ? input.requestId : `${input.requestId}-${index}`,
  );
  const responsePromises = requestIds.map((requestId, index) =>
    request(input.child.port, "/v1/responses", {
      method: "POST",
      headers: responseHeaders(
        input.projectPath,
        index === 0 ? input.sessionId : `${input.sessionId}-peer-${index}`,
        requestId,
        bodyText,
      ),
      body: bodyText,
    }),
  );
  if (input.coordinateHeldUpstream) {
    await input.child.waitForScenarioActive(activeBefore);
  }
  const health = await sampleHealth(input.child);
  if (input.coordinateHeldUpstream) await input.child.flushHeldUpstream();
  const responses = await Promise.all(responsePromises);
  responses.forEach((response) =>
    assertExpectedResponse(input.scenario, response),
  );
  const timings = await Promise.all(
    requestIds.map((requestId) => input.child.timing(requestId)),
  );
  const after = await input.child.stats();
  const parsed = parseOpenAIResponsesRequest(input.body, {});
  return {
    samples: timings.map((timing) => ({
      decodeMs: timing.decodeMs,
      postDecodeToUpstreamMs: timing.postDecodeToUpstreamMs,
      healthMs: Math.max(...health.map((sample) => sample.elapsedMs)),
    })),
    responseStatuses: responses.map((response) => response.status),
    clientOutputHashes: responses.map((response) => hash(response.body)),
    health,
    persistenceBefore: before.sessionPersistence,
    persistenceAfter: after.sessionPersistence,
    sourceInputItems: input.body.input.length,
    sourceNormalizedMessages: parsed.messages.length,
  };
}

async function cancellationProbe(input: {
  child: BenchmarkChild;
  body: ResponsesWorkloadBody;
  projectPath: string;
  sessionId: string;
  requestId: string;
}) {
  const bodyText = JSON.stringify(input.body);
  const before = await input.child.stats();
  const activeBefore = input.child.activeSequence;
  const started = startRequest(input.child.port, "/v1/responses", {
    method: "POST",
    headers: responseHeaders(
      input.projectPath,
      input.sessionId,
      input.requestId,
      bodyText,
    ),
    body: bodyText,
    cancellationExpected: true,
  });
  await input.child.waitForScenarioActive(activeBefore);
  await input.child.waitForLifecycle(input.requestId, "foreground-acquired");
  const health = await sampleHealth(input.child);
  const held = await input.child.stats();
  started.cancel();
  await input.child.flushHeldUpstream();
  const response = await started.result;
  await input.child.waitForLifecycle(input.requestId, "foreground-released");
  const after = await input.child.stats();
  return {
    callerDisconnected: response.status === 0,
    callerInterestReleased:
      after.requestLifecycle[input.requestId]?.foregroundAcquired === 1 &&
      after.requestLifecycle[input.requestId]?.foregroundReleased === 1,
    runningOccupancyObserved:
      held.precondition.reached &&
      held.upstreamRequests === before.upstreamRequests + 1,
    duplicateExecutions: after.upstreamRequests - before.upstreamRequests - 1,
    servingProcessReplacements: 0,
    durableQueueRetained:
      after.queues.temporalDepth >= before.queues.temporalDepth,
    durableSessionUnchanged:
      after.sessionPersistence.temporalMessages ===
        before.sessionPersistence.temporalMessages &&
      after.sessionPersistence.checkpointChecksum ===
        before.sessionPersistence.checkpointChecksum,
    health,
  };
}

function workloadConfig(activeWindowTokens: number): string {
  return JSON.stringify({
    budget: { maxLayer0Tokens: activeWindowTokens },
    search: {
      embeddings: {
        enabled: true,
        provider: "local",
        workerOffload: true,
        queryTimeoutMs: 100,
      },
    },
  });
}

function buildIdentity(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

function profileSamples(turns: TurnMeasurement[]): BenchmarkSample[] {
  return turns.flatMap((turn) => turn.samples);
}

function strictPersistenceChange(
  turn: TurnMeasurement,
  expectedStatus: number,
): boolean {
  if (expectedStatus !== 200)
    return (
      turn.persistenceAfter.temporalMessages ===
        turn.persistenceBefore.temporalMessages &&
      turn.persistenceAfter.checkpointChecksum ===
        turn.persistenceBefore.checkpointChecksum
    );
  return (
    turn.persistenceAfter.temporalMessages >
      turn.persistenceBefore.temporalMessages &&
    turn.persistenceAfter.checkpointPublished &&
    turn.persistenceAfter.checkpointChecksum !== null &&
    turn.persistenceAfter.checkpointChecksum !==
      turn.persistenceBefore.checkpointChecksum
  );
}

function mergeFallbackCounts(...counts: Array<Record<string, number>>) {
  const merged: Record<string, number> = {};
  for (const values of counts)
    for (const [key, value] of Object.entries(values))
      merged[key] = (merged[key] ?? 0) + value;
  return merged;
}

function median(values: number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  const value = sorted[Math.floor(sorted.length / 2)];
  if (value === undefined) throw new Error("median requires a sample");
  return value;
}

function currentTurnOrderIsExact(
  measurement: ChildStats["upstreamMeasurements"][number],
): boolean {
  const statuses = measurement.currentTurnStatuses;
  const callIndices = statuses.map((status) => status.callIndex);
  const resultIndices = statuses.map((status) => status.resultIndex);
  const maxCall = Math.max(...callIndices);
  return (
    statuses.length > 0 &&
    callIndices.every((index) => index >= 0) &&
    resultIndices.every((index) => index > maxCall) &&
    callIndices.every(
      (index, offset) => offset === 0 || index > callIndices[offset - 1],
    ) &&
    resultIndices.every(
      (index, offset) => offset === 0 || index > resultIndices[offset - 1],
    )
  );
}

export async function runMixedLoadBenchmark(options: RunnerOptions = {}) {
  const requestedProfiles =
    options.profiles ??
    MIXED_LOAD_PROFILES.map((profile, index) => ({
      ...profile,
      seed: 1_733 + index,
    }));
  const scenarios = options.scenarios ?? MIXED_LOAD_SCENARIOS;
  const warmups = options.warmups ?? 1;
  const samplesPerMode = options.samples ?? 3;
  const reportScenarios: unknown[] = [];
  const resolvedProfiles = requestedProfiles.map((profile) =>
    generateResponsesWorkload(profile),
  );

  for (const workload of resolvedProfiles) {
    assertResponsesWorkloadParity(
      workload.body,
      workload.parameters.currentTurnToolPairs,
    );
    for (const scenario of scenarios) {
      const root = mkdtempSync(join(tmpdir(), "lore-mixed-load-"));
      const projectPath = join(root, "project");
      const sessionId = `${scenario}-session`;
      mkdirSync(projectPath, { recursive: true });
      writeFileSync(
        join(projectPath, ".lore.json"),
        workloadConfig(workload.parameters.activeWindowTargetTokens),
      );
      const childOptions = (seedPersistentState: boolean) =>
        ({
          root,
          projectPath,
          sessionId,
          scenario,
          parameters: workload.parameters,
          seedPersistentState,
          nativeProviderDiagnostic:
            options.nativeProviderDiagnostic === true &&
            scenario === "idle-backlog",
        }) satisfies ChildStartOptions;
      const processIds: number[] = [];
      const warmTurns: TurnMeasurement[] = [];
      const restartTurns: TurnMeasurement[] = [];
      const allHealth: HealthMeasurement[] = [];
      const allClientOutputHashes: string[] = [];
      const processBaselines: ChildStats[] = [];
      const processPlateaus: ChildStats[][] = [];
      const timingSamples: Array<
        import("../../src/benchmark-timing").BenchmarkTimingSample
      > = [];
      const heldStats: ChildStats[] = [];
      const releases: ScenarioRelease[] = [];
      const barriers: ScenarioBarrier[] = [];
      let cancellation:
        | Awaited<ReturnType<typeof cancellationProbe>>
        | undefined;
      let first: BenchmarkChild | undefined;
      let restarted: BenchmarkChild | undefined;
      let currentBody = workload.body;
      let continuationOrdinal = 0;
      let firstFinalPersistence: SessionPersistenceSnapshot | undefined;
      let restartInitialPersistence: SessionPersistenceSnapshot | undefined;
      try {
        first = new BenchmarkChild();
        await first.start(childOptions(true));
        processIds.push(first.pid);

        const base = await timedTurn({
          child: first,
          body: currentBody,
          projectPath,
          sessionId,
          requestId: `${scenario}-base`,
          scenario: "idle-backlog",
        });
        if (!base.persistenceAfter.checkpointPublished)
          throw new Error(
            `${scenario} base checkpoint was not published: ${JSON.stringify(base.persistenceAfter)}`,
          );
        processBaselines.push(await first.stats(true));
        await first.beginMeasurement();
        barriers.push(await first.activate());

        if (scenario === "cancellation") {
          currentBody = appendResponsesContinuation(
            currentBody,
            workload.parameters.seed,
            continuationOrdinal++,
          );
          cancellation = await cancellationProbe({
            child: first,
            body: currentBody,
            projectPath,
            sessionId,
            requestId: `${scenario}-cancelled`,
          });
          allHealth.push(...cancellation.health);
          heldStats.push(await first.stats());
          releases.push(await first.release());
        }

        for (let warmup = 0; warmup < warmups; warmup++) {
          currentBody = appendResponsesContinuation(
            currentBody,
            workload.parameters.seed,
            continuationOrdinal++,
          );
          await timedTurn({
            child: first,
            body: currentBody,
            projectPath,
            sessionId,
            requestId: `${scenario}-warmup-${warmup}`,
            scenario,
            concurrentSessions: scenario === "concurrent-sessions" ? 2 : 1,
            coordinateHeldUpstream: scenario === "concurrent-sessions",
          });
        }
        for (let sample = 0; sample < samplesPerMode; sample++) {
          currentBody = appendResponsesContinuation(
            currentBody,
            workload.parameters.seed,
            continuationOrdinal++,
          );
          const turn = await timedTurn({
            child: first,
            body: currentBody,
            projectPath,
            sessionId,
            requestId: `${scenario}-append-${sample}`,
            scenario,
            concurrentSessions: scenario === "concurrent-sessions" ? 2 : 1,
            coordinateHeldUpstream: scenario === "concurrent-sessions",
          });
          warmTurns.push(turn);
          allHealth.push(...turn.health);
          allClientOutputHashes.push(...turn.clientOutputHashes);
        }
        if (scenario !== "cancellation") {
          heldStats.push(await first.stats());
          releases.push(await first.release());
        }
        const firstPlateau = await Promise.all([
          first.stats(true),
          first.stats(true),
          first.stats(true),
        ]);
        processPlateaus.push(firstPlateau);
        firstFinalPersistence = firstPlateau.at(-1)?.sessionPersistence;
        timingSamples.push(...first.timings.values());
        await first.stop();
        first = undefined;

        restarted = new BenchmarkChild();
        await restarted.start(childOptions(false));
        processIds.push(restarted.pid);
        const restartInitial = await restarted.stats(true);
        restartInitialPersistence = restartInitial.sessionPersistence;
        processBaselines.push(restartInitial);
        await restarted.beginMeasurement();
        barriers.push(await restarted.activate());

        if (scenario === "cancellation") {
          currentBody = appendResponsesContinuation(
            currentBody,
            workload.parameters.seed,
            continuationOrdinal++,
          );
          const restartCancellation = await cancellationProbe({
            child: restarted,
            body: currentBody,
            projectPath,
            sessionId,
            requestId: `${scenario}-restart-cancelled`,
          });
          cancellation = {
            callerDisconnected:
              cancellation?.callerDisconnected === true &&
              restartCancellation.callerDisconnected,
            callerInterestReleased:
              cancellation?.callerInterestReleased === true &&
              restartCancellation.callerInterestReleased,
            runningOccupancyObserved:
              cancellation?.runningOccupancyObserved === true &&
              restartCancellation.runningOccupancyObserved,
            duplicateExecutions:
              (cancellation?.duplicateExecutions ?? 0) +
              restartCancellation.duplicateExecutions,
            servingProcessReplacements:
              (cancellation?.servingProcessReplacements ?? 0) +
              restartCancellation.servingProcessReplacements,
            durableQueueRetained:
              cancellation?.durableQueueRetained === true &&
              restartCancellation.durableQueueRetained,
            durableSessionUnchanged:
              cancellation?.durableSessionUnchanged === true &&
              restartCancellation.durableSessionUnchanged,
            health: [
              ...(cancellation?.health ?? []),
              ...restartCancellation.health,
            ],
          };
          allHealth.push(...restartCancellation.health);
          heldStats.push(await restarted.stats());
          releases.push(await restarted.release());
        }

        for (let warmup = 0; warmup < warmups; warmup++) {
          currentBody = appendResponsesContinuation(
            currentBody,
            workload.parameters.seed,
            continuationOrdinal++,
          );
          await timedTurn({
            child: restarted,
            body: currentBody,
            projectPath,
            sessionId,
            requestId: `${scenario}-restart-warmup-${warmup}`,
            scenario,
            concurrentSessions: scenario === "concurrent-sessions" ? 2 : 1,
            coordinateHeldUpstream: scenario === "concurrent-sessions",
          });
        }
        for (let sample = 0; sample < samplesPerMode; sample++) {
          currentBody = appendResponsesContinuation(
            currentBody,
            workload.parameters.seed,
            continuationOrdinal++,
          );
          const turn = await timedTurn({
            child: restarted,
            body: currentBody,
            projectPath,
            sessionId,
            requestId: `${scenario}-restart-append-${sample}`,
            scenario,
            concurrentSessions: scenario === "concurrent-sessions" ? 2 : 1,
            coordinateHeldUpstream: scenario === "concurrent-sessions",
          });
          restartTurns.push(turn);
          allHealth.push(...turn.health);
          allClientOutputHashes.push(...turn.clientOutputHashes);
        }
        if (scenario !== "cancellation") {
          heldStats.push(await restarted.stats());
          releases.push(await restarted.release());
        }
        const restartPlateau = await Promise.all([
          restarted.stats(true),
          restarted.stats(true),
          restarted.stats(true),
        ]);
        processPlateaus.push(restartPlateau);
        timingSamples.push(...restarted.timings.values());
        await restarted.stop();
        restarted = undefined;

        const finalStats = processPlateaus.map((plateau) => {
          const stats = plateau.at(-1);
          if (!stats) throw new Error("missing quiescent plateau");
          return stats;
        });
        const allStats = [...heldStats, ...finalStats];
        const upstreamMeasurements = allStats.flatMap(
          (stats) => stats.upstreamMeasurements,
        );
        const expectedStatus =
          scenario === "read-workers-unavailable" ? 503 : 200;
        const phasePersistenceExact = [...warmTurns, ...restartTurns].every(
          (turn) => strictPersistenceChange(turn, expectedStatus),
        );
        const activeWindowSamples = timingSamples.filter(
          (sample) =>
            sample.rawWindowTokens !== null &&
            !sample.requestId.includes("-base"),
        );
        const measuredActiveWindowTokens = activeWindowSamples
          .map((sample) => sample.rawWindowTokens)
          .filter((tokens): tokens is number => tokens !== null);
        const activeWindowLowerBoundTokens =
          workload.parameters.activeWindowLowerBoundTokens;
        const activeWindowUpperBoundTokens =
          workload.parameters.activeWindowUpperBoundTokens;
        const activeWindowExact =
          !workload.parameters.enforceActiveWindow ||
          scenario === "read-workers-unavailable" ||
          (measuredActiveWindowTokens.length > 0 &&
            measuredActiveWindowTokens.every(
              (tokens) =>
                tokens >= activeWindowLowerBoundTokens &&
                tokens <= activeWindowUpperBoundTokens,
            ));
        const currentToolPairsExact = upstreamMeasurements.every(
          currentTurnOrderIsExact,
        );
        const healthExact = allHealth.every(
          (sample) =>
            sample.status === 200 &&
            sample.statusField === "ok" &&
            sample.schemaValid,
        );
        const queuePeaks = {
          temporalDepth: Math.max(
            ...allStats.map((stats) => stats.queuePeaks.temporalDepth),
          ),
          temporalOldestAgeMs: Math.max(
            ...allStats.map((stats) => stats.queuePeaks.temporalOldestAgeMs),
          ),
          readPendingCount: Math.max(
            ...allStats.map((stats) => stats.queuePeaks.readPendingCount),
          ),
          readPendingBytes: Math.max(
            ...allStats.map((stats) => stats.queuePeaks.readPendingBytes),
          ),
          readRunningCount: Math.max(
            ...allStats.map((stats) => stats.queuePeaks.readRunningCount),
          ),
          readOldestPendingMs: Math.max(
            ...allStats.map((stats) => stats.queuePeaks.readOldestPendingMs),
          ),
        };
        const initialTemporalDepth = Math.max(
          ...processBaselines.map((stats) => stats.queues.temporalDepth),
        );
        const requestCount =
          warmups * 2 +
          samplesPerMode * 2 +
          (scenario === "cancellation" ? 2 : 0);
        const queueBound = initialTemporalDepth + requestCount * 4;
        const memoryPlateauValues = processPlateaus.map((plateau) =>
          plateau.map((stats) => stats.memory.heapUsed),
        );
        const explicitGc = processPlateaus
          .flat()
          .every((stats) => stats.explicitGc);
        const quiescentDeltaBytes = Math.max(
          ...memoryPlateauValues.map(
            (values, index) =>
              median(values) - processBaselines[index].memory.heapUsed,
          ),
        );
        const plateauSpreadBytes = Math.max(
          ...memoryPlateauValues.map(
            (values) => Math.max(...values) - Math.min(...values),
          ),
        );
        const processCpuMs = finalStats.reduce(
          (sum, stats, index) =>
            sum + Math.max(0, stats.cpuMs - processBaselines[index].cpuMs),
          0,
        );
        const readScenarioExact = (() => {
          if (scenario === "read-workers-unavailable")
            return [...warmTurns, ...restartTurns].every((turn) =>
              turn.responseStatuses.every((status) => status === 503),
            );
          if (scenario === "read-workers-slow")
            return allStats.some((stats) =>
              stats.readServiceMs.some((value) => value >= 40),
            );
          return true;
        })();
        const cancellationExact =
          scenario !== "cancellation" ||
          (cancellation?.callerDisconnected === true &&
            cancellation.callerInterestReleased &&
            cancellation.runningOccupancyObserved &&
            cancellation.duplicateExecutions === 0 &&
            cancellation.servingProcessReplacements === 0 &&
            cancellation.durableQueueRetained &&
            cancellation.durableSessionUnchanged);
        const embeddingOwnershipExact = finalStats.every(
          (stats) =>
            stats.embedding.duplicateExecutions === 0 &&
            stats.embedding.peakRunning <= 1 &&
            stats.embedding.running === 0,
        );
        const processPersistenceExact =
          firstFinalPersistence !== undefined &&
          restartInitialPersistence !== undefined &&
          firstFinalPersistence.temporalMessages ===
            restartInitialPersistence.temporalMessages &&
          firstFinalPersistence.checkpointRevision ===
            restartInitialPersistence.checkpointRevision &&
          firstFinalPersistence.checkpointChecksum ===
            restartInitialPersistence.checkpointChecksum &&
          firstFinalPersistence.checkpointPublished ===
            restartInitialPersistence.checkpointPublished;
        const invariants = {
          normalizedSourceCount:
            workload.parameters.sourceNormalizedMessages ===
            workload.parameters.messageCount,
          activeWindowMeasured: activeWindowExact,
          distinctServingProcesses:
            processIds.length === 2 && processIds[0] !== processIds[1],
          processTwoDidNotReseed:
            finalStats[0].seededPersistentState &&
            !finalStats[1].seededPersistentState,
          barriersReached:
            barriers.length === 2 &&
            heldStats.every((stats) => stats.precondition.reached),
          faultsHeldDuringForeground: heldStats.every(
            (stats) => stats.precondition.held,
          ),
          releasesSettled: releases.every(
            (item) => item.settled && item.returnedToBaseline,
          ),
          boundedTemporalQueue: queuePeaks.temporalDepth <= queueBound,
          boundedReadQueue: queuePeaks.readPendingCount <= 128,
          healthExact,
          phasePersistenceExact,
          processPersistenceExact,
          currentToolPairsExact,
          exactUpstreamHashes: upstreamMeasurements.every(
            (measurement) =>
              /^[0-9a-f]{64}$/.test(measurement.bodyHash) &&
              /^[0-9a-f]{64}$/.test(measurement.toolSequenceHash) &&
              /^[0-9a-f]{64}$/.test(measurement.provenanceHash),
          ),
          noFabricatedProviderUsage: upstreamMeasurements.every(
            (measurement) =>
              measurement.reportedProviderUsage ===
                measurement.estimatedInputTokens &&
              measurement.usageSource === "authoritative-local-estimate",
          ),
          readScenarioExact,
          cancellationExact,
          embeddingOwnershipExact,
        };
        const failedInvariants = Object.entries(invariants)
          .filter(([, value]) => !value)
          .map(([name]) => name);
        if (failedInvariants.length > 0)
          throw new Error(
            `${scenario} invariant failed: ${failedInvariants.join(",")} precondition=${JSON.stringify(heldStats.map((stats) => stats.precondition))} queues=${JSON.stringify(heldStats.map((stats) => stats.queues))} releases=${JSON.stringify(releases)} embedding=${JSON.stringify(heldStats.map((stats) => stats.embedding))} final_embedding=${JSON.stringify(finalStats.map((stats) => stats.embedding))} statuses=${JSON.stringify([...warmTurns, ...restartTurns].flatMap((turn) => turn.responseStatuses))} active_windows=${JSON.stringify(activeWindowSamples.map((sample) => sample.rawWindowTokens))} upstream=${upstreamMeasurements.length} cancellation=${JSON.stringify(cancellation)}`,
          );

        reportScenarios.push({
          profile: workload.parameters.name,
          scenario,
          processIds,
          processLifecycle: {
            seedPersistentState: finalStats.map(
              (stats) => stats.seededPersistentState,
            ),
            sameOwnedDatabase: processPersistenceExact,
          },
          source: {
            inputItems: workload.parameters.sourceInputItems,
            normalizedMessages: workload.parameters.sourceNormalizedMessages,
            estimatedSourceTokens: workload.parameters.sourceEstimatedTokens,
            activeWindowRangeTokens: [
              activeWindowLowerBoundTokens,
              activeWindowUpperBoundTokens,
            ],
            measuredActiveWindowTokens,
          },
          phases: {
            base: {
              accepted: true,
              checkpointPublished: base.persistenceAfter.checkpointPublished,
              persistence: base.persistenceAfter,
            },
            warmAppend: {
              samples: warmTurns,
              summary: summarizeBenchmarkSamples(profileSamples(warmTurns)),
            },
            restartAppend: {
              samples: restartTurns,
              summary: summarizeBenchmarkSamples(profileSamples(restartTurns)),
              observedPersistedBase: processPersistenceExact,
            },
          },
          precondition: {
            reached: heldStats.every((stats) => stats.precondition.reached),
            heldDuringForeground: heldStats.every(
              (stats) => stats.precondition.held,
            ),
            processes: heldStats.map((stats) => stats.precondition),
          },
          release: {
            requested: releases.every((item) => item.requested),
            settled: releases.every((item) => item.settled),
            returnedToBaseline: releases.every(
              (item) => item.returnedToBaseline,
            ),
          },
          health: allHealth,
          queuePeaks,
          memory: {
            label: explicitGc
              ? "quiescent-post-gc-plateau-delta"
              : "quiescent-heap-plateau-delta-no-explicit-gc",
            explicitGc,
            quiescentDeltaBytes,
            plateauSpreadBytes,
            samples: memoryPlateauValues,
          },
          cpu: {
            scope: "serving-process",
            processCpuMs,
          },
          queries: {
            scope: "serving-process-main-thread",
            excludesSeedingAndStats: true,
            workerThreadCoverage: "not-observed",
            counts: finalStats.map((stats) => stats.queryExecutionCount),
          },
          readWaitMs: {
            queue: allStats.flatMap((stats) => stats.readQueueMs),
            service: allStats.flatMap((stats) => stats.readServiceMs),
          },
          fallbackCounts: mergeFallbackCounts(
            ...finalStats.map((stats) => stats.fallbackCounts),
          ),
          upstreamMeasurements,
          clientOutputHashes: allClientOutputHashes,
          cancellation: cancellation ?? null,
          invariants,
        });
      } finally {
        await first?.stop();
        await restarted?.stop();
        if (!options.keepRoot) rmSync(root, { recursive: true, force: true });
      }
    }
  }

  const completedScenarios = scenarios.filter((scenario) =>
    reportScenarios.some(
      (entry) =>
        (entry as { scenario: MixedLoadScenario }).scenario === scenario,
    ),
  );
  const allAcceptanceScenariosCompleted =
    scenarios.length === MIXED_LOAD_SCENARIOS.length &&
    MIXED_LOAD_SCENARIOS.every((scenario) =>
      completedScenarios.includes(scenario),
    );
  const report = {
    schemaVersion: 2,
    measurement: {
      kind: "measured-quick-reference",
      syntheticProvider: true,
      paidProvider: false,
      nativeProviderDiagnostic: options.nativeProviderDiagnostic === true,
    },
    generatedAt: new Date().toISOString(),
    buildIdentity: buildIdentity(),
    runtime: {
      node: process.version,
      versions: process.versions,
      platform: platform(),
      arch: arch(),
    },
    hardware: {
      cpu: cpus()[0]?.model ?? "unknown",
      logicalCpus: cpus().length,
      totalMemoryBytes: totalmem(),
    },
    parameters: {
      profiles: resolvedProfiles.map((workload) => workload.parameters),
      requestedScenarios: scenarios,
      completedScenarios,
      allAcceptanceScenariosCompleted,
      warmups,
      samplesPerMode,
      nativeProviderDiagnostic: options.nativeProviderDiagnostic === true,
    },
    referenceTargets: REFERENCE_TARGETS,
    scenarios: reportScenarios,
  };
  if (options.outputPath)
    writeFileSync(options.outputPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

function parseArgs(args: string[]): RunnerOptions {
  const outputIndex = args.indexOf("--output");
  return {
    outputPath: outputIndex === -1 ? undefined : args[outputIndex + 1],
    warmups: args.includes("--quick") ? 0 : 1,
    samples: args.includes("--quick") ? 1 : 3,
    keepRoot: args.includes("--keep-root"),
    nativeProviderDiagnostic: args.includes("--native-provider"),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = await runMixedLoadBenchmark(parseArgs(process.argv.slice(2)));
  process.stdout.write(
    `${JSON.stringify({
      buildIdentity: report.buildIdentity,
      scenarioCount: report.scenarios.length,
      allAcceptanceScenariosCompleted:
        report.parameters.allAcceptanceScenariosCompleted,
      referenceTargets: report.referenceTargets,
      reportHash: hash(JSON.stringify(report.scenarios)),
    })}\n`,
  );
}
