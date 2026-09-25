import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer, type ServerResponse, type Server } from "node:http";
import { createRequire } from "node:module";
import type {
  ChildMessage,
  ChildStartOptions,
  ChildStats,
  ParentMessage,
  QueuePeaks,
  ScenarioBarrier,
  ScenarioRelease,
  UpstreamMeasurement,
} from "./protocol";

if (!process.send) throw new Error("mixed-load child requires an IPC channel");
(globalThis as { require?: NodeRequire }).require = createRequire(
  import.meta.url,
);

const send = (message: ChildMessage): void => process.send?.(message);
let stopGateway: (() => Promise<void>) | undefined;
let upstreamServer: Server | undefined;
let statsReader: ((quiescent: boolean) => Promise<ChildStats>) | undefined;
let activateScenario: (() => Promise<ScenarioBarrier>) | undefined;
let releaseScenario: (() => Promise<ScenarioRelease>) | undefined;
let flushUpstream: (() => void) | undefined;
let beginMeasurement: (() => void) | undefined;
let lifecycleStage = "boot";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("local upstream did not bind a TCP port");
      resolve(address.port);
    });
  });
}

function jsonBytes(value: unknown): { bytes: number; hash: string } {
  const encoded = JSON.stringify(value);
  return { bytes: Buffer.byteLength(encoded), hash: hash(encoded) };
}

function collectProvenance(value: unknown, output: unknown[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectProvenance(item, output);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (
    record.type === "reasoning" ||
    typeof record.encrypted_content === "string"
  ) {
    output.push(record);
    return;
  }
  for (const item of Object.values(record)) collectProvenance(item, output);
}

function completedResponse(inputTokens: number): string {
  return JSON.stringify({
    id: "resp_benchmark_deterministic",
    object: "response",
    created_at: 1_795_000_000,
    model: "benchmark-mixed-load-190k",
    status: "completed",
    output: [
      {
        type: "message",
        id: "msg_benchmark_deterministic",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "deterministic benchmark response",
            annotations: [],
            logprobs: [],
          },
        ],
      },
    ],
    usage: {
      input_tokens: inputTokens,
      output_tokens: 4,
      total_tokens: inputTokens + 4,
      input_tokens_details: {
        cached_tokens: 0,
        cache_write_tokens: 0,
      },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  });
}

function sendUpstreamResponse(
  response: ServerResponse,
  inputTokens: number,
): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(completedResponse(inputTokens));
}

async function start(options: ChildStartOptions): Promise<void> {
  lifecycleStage = "environment";
  process.env.LORE_DB_PATH = `${options.root}/fixture.db`;
  process.env.XDG_DATA_HOME = options.root;
  process.env.LORE_CONFIG_DIR = `${options.root}/config`;
  process.env.LORE_LISTEN_HOST = "127.0.0.1";
  process.env.LORE_LISTEN_PORT = "0";
  process.env.LORE_DEBUG = "false";
  delete process.env.VOYAGE_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.LORE_DISABLE_VEC_WORKER;

  lifecycleStage = "imports";
  const core = await import("@loreai/core");
  const ltm = await import("../../../core/src/ltm");
  const admission =
    await import("../../../core/src/temporal-embedding-admission");
  const temporalQueue =
    await import("../../../core/src/temporal-embedding-queue");
  const embedding = await import("../../../core/src/embedding");
  const vectorPool = await import("../../../core/src/vector-pool");
  const { runReadJob } = await import("../../../core/src/read-job");
  const { parseOpenAIResponsesRequest } =
    await import("../../src/translate/openai-responses");
  const { gatewayMessagesToLore } = await import("../../src/temporal-adapter");
  const { nodeHttpFetch, setUpstreamFetchOverrideForTest } =
    await import("../../src/fetch");
  const { CANNED_MODELS_DEV, offlineModelsDevResponse } =
    await import("../../test/helpers/models-dev-dispatcher");
  const {
    setBenchmarkFailureObserver,
    setBenchmarkLifecycleObserver,
    setBenchmarkTimingObserver,
  } = await import("../../src/benchmark-timing");
  const { setUpstreamInterceptor, settleStreamingPostResponseForBenchmark } =
    await import("../../src/pipeline");
  const { loadConfig } = await import("../../src/config");
  const { startServer } = await import("../../src/server");

  const upstreamMeasurements: UpstreamMeasurement[] = [];
  const pendingUpstreamResponses: Array<{
    response: ServerResponse;
    inputTokens: number;
  }> = [];
  let holdUpstream = false;
  let upstreamHoldThreshold = 0;
  let activeSequence = 0;
  let activeNotifiedAtPendingCount = 0;

  upstreamServer = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const bodyText = Buffer.concat(chunks).toString("utf8");
      const body = JSON.parse(bodyText) as {
        input?: Array<Record<string, unknown>>;
      };
      const input = body.input ?? [];
      const parsed = parseOpenAIResponsesRequest(body, {});
      const estimatedInputTokens = core.estimateMessages(
        gatewayMessagesToLore(parsed.messages, "benchmark-upstream"),
      );
      const tools = input.filter(
        (item) =>
          item.type === "function_call" || item.type === "function_call_output",
      );
      const calls = tools.filter((item) => item.type === "function_call");
      const outputs = tools.filter(
        (item) => item.type === "function_call_output",
      );
      const provenance: unknown[] = [];
      collectProvenance(input, provenance);
      const toolEncoding = jsonBytes(tools);
      const provenanceEncoding = jsonBytes(provenance);
      const currentTurnStatuses = Array.from(
        { length: options.parameters.currentTurnToolPairs },
        (_, pair) => {
          const callId = `current-${options.parameters.seed}-${pair}`;
          const callIndex = tools.findIndex(
            (item) => item.type === "function_call" && item.call_id === callId,
          );
          const resultIndex = tools.findIndex(
            (item) =>
              item.type === "function_call_output" && item.call_id === callId,
          );
          const call = callIndex < 0 ? undefined : tools[callIndex];
          const result = resultIndex < 0 ? undefined : tools[resultIndex];
          return {
            callId,
            callIndex,
            resultIndex,
            callStatus: typeof call?.status === "string" ? call.status : null,
            resultStatus:
              typeof result?.status === "string" ? result.status : null,
          };
        },
      );
      upstreamMeasurements.push({
        bodyHash: hash(bodyText),
        inputItems: input.length,
        normalizedMessages: parsed.messages.length,
        estimatedInputTokens,
        toolCalls: calls.length,
        toolOutputs: outputs.length,
        toolSequenceBytes: toolEncoding.bytes,
        toolSequenceHash: toolEncoding.hash,
        provenanceItems: provenance.length,
        provenanceBytes: provenanceEncoding.bytes,
        provenanceHash: provenanceEncoding.hash,
        currentTurnOrderHash: hash(JSON.stringify(currentTurnStatuses)),
        currentTurnStatuses,
        reportedProviderUsage: estimatedInputTokens,
        usageSource: "authoritative-local-estimate",
      });

      if (!holdUpstream) {
        sendUpstreamResponse(response, estimatedInputTokens);
        return;
      }
      pendingUpstreamResponses.push({
        response,
        inputTokens: estimatedInputTokens,
      });
      if (
        pendingUpstreamResponses.length >= upstreamHoldThreshold &&
        activeNotifiedAtPendingCount !== pendingUpstreamResponses.length
      ) {
        activeNotifiedAtPendingCount = pendingUpstreamResponses.length;
        activeSequence++;
        precondition = { ...precondition, reached: true };
        send({ type: "scenario-active", sequence: activeSequence });
      }
    });
  });
  const upstreamPort = await listen(upstreamServer);

  setUpstreamFetchOverrideForTest((input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method =
      init?.method ?? (input instanceof Request ? input.method : "GET");
    if (url !== "https://models.dev/api.json" || method.toUpperCase() !== "GET")
      return offlineModelsDevResponse(input, init);
    return Response.json({
      ...CANNED_MODELS_DEV,
      openai: {
        ...CANNED_MODELS_DEV.openai,
        models: {
          ...CANNED_MODELS_DEV.openai.models,
          "benchmark-mixed-load-190k": {
            id: "benchmark-mixed-load-190k",
            cost: { input: 3, output: 15, cache_read: 0.3 },
            // Layer-1's stable raw window targets 75% of rawBudget. Derive the
            // model window so 0.75 * 0.4 / 1.68 of usable context is ~190K.
            limit: { context: 1_164_000, output: 100_000 },
          },
        },
      },
    });
  });
  setUpstreamInterceptor((body, _model, _stream, _makeReal) =>
    nodeHttpFetch(`http://127.0.0.1:${upstreamPort}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

  let measurementActive = false;
  let statsProbe = false;
  let queryExecutionCount = 0;
  const readQueueMs: number[] = [];
  const readServiceMs: number[] = [];
  const fallbackCounts: Record<string, number> = {};
  const requestLifecycle: ChildStats["requestLifecycle"] = {};
  const queuePeaks: QueuePeaks = {
    temporalDepth: 0,
    temporalOldestAgeMs: 0,
    readPendingCount: 0,
    readPendingBytes: 0,
    readRunningCount: 0,
    readOldestPendingMs: 0,
  };
  const embeddingState = {
    workerInstances: 0,
    executions: 0,
    completions: 0,
    running: 0,
    peakRunning: 0,
    duplicateExecutions: 0,
    replacementWorkers: 0,
  };
  const executionKeys = new Set<string>();
  const controlledEmbeddingWorkers = new Set<ControlledEmbeddingWorker>();
  let precondition: ScenarioBarrier = {
    armed: false,
    reached: false,
    held: false,
    kind: options.scenario,
    evidence: {},
  };
  let release: ScenarioRelease = {
    requested: false,
    settled: false,
    returnedToBaseline: false,
  };

  core.log.registerSink({
    info() {},
    warn() {},
    error() {},
    captureException() {},
    withDbSpan(_sql, fn) {
      if (measurementActive && !statsProbe) queryExecutionCount++;
      return fn();
    },
  });

  const observeReadPool = (
    sample: import("@loreai/core").ReadPoolTelemetry,
  ) => {
    if (
      sample.outcome === "pressure" ||
      sample.outcome === "error" ||
      sample.outcome === "timeout" ||
      sample.outcome === "cancelled" ||
      sample.outcome === "unavailable"
    )
      fallbackCounts[`read-${sample.outcome}`] =
        (fallbackCounts[`read-${sample.outcome}`] ?? 0) + 1;
    if (sample.queueMs !== undefined) readQueueMs.push(sample.queueMs);
    if (sample.serviceMs !== undefined) readServiceMs.push(sample.serviceMs);
    queuePeaks.readPendingCount = Math.max(
      queuePeaks.readPendingCount,
      sample.pendingCount,
    );
    queuePeaks.readPendingBytes = Math.max(
      queuePeaks.readPendingBytes,
      sample.pendingBytes,
    );
    queuePeaks.readRunningCount = Math.max(
      queuePeaks.readRunningCount,
      sample.runningCount,
    );
    queuePeaks.readOldestPendingMs = Math.max(
      queuePeaks.readOldestPendingMs,
      sample.oldestPendingMs,
    );
  };
  vectorPool.setReadPoolTelemetryHook(observeReadPool);

  setBenchmarkTimingObserver((sample) => send({ type: "timing", sample }));
  setBenchmarkFailureObserver((sample) => {
    fallbackCounts["pipeline-failure"] =
      (fallbackCounts["pipeline-failure"] ?? 0) + 1;
    send({
      type: "timing",
      sample: {
        requestId: sample.requestId,
        decodeMs: sample.decodeMs,
        postDecodeToUpstreamMs: sample.postDecodeToFailureMs,
        activeWindowTokens: null,
        rawWindowTokens: null,
        outcome: "failure",
      },
    });
  });
  setBenchmarkLifecycleObserver(({ requestId, event }) => {
    const state = (requestLifecycle[requestId] ??= {
      foregroundAcquired: 0,
      foregroundReleased: 0,
    });
    if (event === "foreground-acquired") state.foregroundAcquired++;
    else state.foregroundReleased++;
    send({ type: "request-lifecycle", requestId, event });
  });

  lifecycleStage = "fixture-seed";
  await core.load(options.projectPath);
  const projectId = core.ensureProject(options.projectPath);
  await embedding._shutdownAndDisable();
  temporalQueue.stopTemporalEmbeddingScheduler();

  if (options.seedPersistentState) {
    for (let index = 0; index < options.parameters.knowledgeEntries; index++)
      ltm.create({
        projectPath: options.projectPath,
        category: "pattern",
        title: `Benchmark knowledge ${index}`,
        content: `Deterministic benchmark knowledge ${index}.`,
        scope: "project",
      });

    const temporalEntries =
      options.parameters.vectorEntries + options.parameters.backlogEntries;
    const insertTemporal = core.db().query(
      `INSERT INTO temporal_messages
         (id, source_id, project_id, session_id, role, content, tokens, distilled, created_at, metadata)
       VALUES (?, ?, ?, ?, 'user', ?, 8, 0, ?, NULL)`,
    );
    for (let index = 0; index < temporalEntries; index++) {
      const id = `benchmark-temporal-${index}`;
      const content =
        `Deterministic queued embedding ${index}. ` +
        "This synthetic content is long enough to require a vector. ".repeat(
          32,
        );
      insertTemporal.run(
        id,
        id,
        projectId,
        "benchmark-backlog",
        content,
        1_795_000_000_000 + index,
      );
      admission.enqueueTemporalEmbedding(id, content);
    }
  }

  class ControlledEmbeddingWorker extends EventEmitter {
    private readonly pending = new Map<
      number,
      { texts: string[]; key: string }
    >();

    constructor() {
      super();
      embeddingState.workerInstances++;
      embeddingState.replacementWorkers = Math.max(
        0,
        embeddingState.workerInstances - 1,
      );
      controlledEmbeddingWorkers.add(this);
    }

    postMessage(message: {
      type: string;
      id?: number;
      texts?: string[];
    }): void {
      if (message.type !== "embed" || message.id === undefined) return;
      const texts = message.texts ?? [];
      const key = hash(JSON.stringify(texts));
      if (executionKeys.has(key)) embeddingState.duplicateExecutions++;
      executionKeys.add(key);
      this.pending.set(message.id, { texts, key });
      embeddingState.executions++;
      embeddingState.running++;
      embeddingState.peakRunning = Math.max(
        embeddingState.peakRunning,
        embeddingState.running,
      );
      embeddingActiveResolve?.();
      embeddingActiveResolve = undefined;
    }

    releaseAll(dimensions: number): void {
      for (const [id, pending] of this.pending) {
        this.pending.delete(id);
        embeddingState.running--;
        embeddingState.completions++;
        this.emit("message", {
          type: "result",
          id,
          vectors: pending.texts.map(() =>
            new Float32Array(dimensions).fill(0.01),
          ),
        });
      }
    }

    ref(): void {}
    unref(): void {}
    terminate(): Promise<number> {
      controlledEmbeddingWorkers.delete(this);
      queueMicrotask(() => this.emit("exit", 0));
      return Promise.resolve(0);
    }
  }

  class DelayedSqlReadWorker extends EventEmitter {
    constructor(private readonly delayMs: number) {
      super();
      queueMicrotask(() =>
        this.emit("message", { type: "ready", vecAvailable: false }),
      );
    }

    unref(): void {}
    postMessage(message: {
      type: string;
      id?: number;
      spec?: import("../../../core/src/read-job").ReadJobSpec;
    }): void {
      if (
        message.type !== "read" ||
        message.id === undefined ||
        message.spec === undefined
      )
        return;
      const spec = message.spec;
      setTimeout(() => {
        try {
          const rows = runReadJob(core.db(), spec);
          this.emit("message", { type: "read-result", id: message.id, rows });
        } catch {
          this.emit("message", {
            type: "error",
            id: message.id,
            error: "benchmark read failed",
          });
        }
      }, this.delayMs).unref();
    }
    terminate(): Promise<number> {
      queueMicrotask(() => this.emit("exit", 0));
      return Promise.resolve(0);
    }
  }

  const updateQueuePeaks = (): void => {
    statsProbe = true;
    try {
      const queue = core
        .db()
        .query(
          `SELECT COUNT(*) AS depth,
                  COALESCE(MAX(0, ? - enqueued_at), 0) AS oldest_age
             FROM temporal_embedding_queue`,
        )
        .get(Date.now()) as { depth: number; oldest_age: number };
      const read = vectorPool.readPoolStats();
      queuePeaks.temporalDepth = Math.max(
        queuePeaks.temporalDepth,
        queue.depth,
      );
      queuePeaks.temporalOldestAgeMs = Math.max(
        queuePeaks.temporalOldestAgeMs,
        queue.oldest_age,
      );
      queuePeaks.readPendingCount = Math.max(
        queuePeaks.readPendingCount,
        read.pendingCount,
      );
      queuePeaks.readPendingBytes = Math.max(
        queuePeaks.readPendingBytes,
        read.pendingBytes,
      );
      queuePeaks.readRunningCount = Math.max(
        queuePeaks.readRunningCount,
        read.runningCount,
      );
      queuePeaks.readOldestPendingMs = Math.max(
        queuePeaks.readOldestPendingMs,
        read.oldestPendingMs,
      );
    } finally {
      statsProbe = false;
    }
  };
  const peakTimer = setInterval(updateQueuePeaks, 10);
  peakTimer.unref();

  const currentQueue = () => {
    statsProbe = true;
    try {
      const queue = core
        .db()
        .query(
          `SELECT COUNT(*) AS depth,
                  COALESCE(MAX(0, ? - enqueued_at), 0) AS oldest_age
             FROM temporal_embedding_queue`,
        )
        .get(Date.now()) as { depth: number; oldest_age: number };
      return {
        temporalDepth: queue.depth,
        temporalOldestAgeMs: queue.oldest_age,
        read: vectorPool.readPoolStats(),
      };
    } finally {
      statsProbe = false;
    }
  };

  const sessionPersistence = () => {
    statsProbe = true;
    try {
      const temporal = core
        .db()
        .query(
          "SELECT COUNT(*) AS count FROM temporal_messages WHERE project_id = ? AND session_id != 'benchmark-backlog'",
        )
        .get(projectId) as { count: number };
      const checkpoint = core
        .db()
        .query(
          "SELECT revision, checksum, payload IS NOT NULL AS published FROM source_windows WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1",
        )
        .get(projectId) as
        | { revision: number; checksum: string | null; published: number }
        | undefined;
      return {
        temporalMessages: temporal.count,
        checkpointRevision: checkpoint?.revision ?? null,
        checkpointChecksum: checkpoint?.checksum ?? null,
        checkpointPublished: checkpoint?.published === 1,
      };
    } finally {
      statsProbe = false;
    }
  };

  const installReadTelemetry = (): void =>
    vectorPool.setReadPoolTelemetryHook(observeReadPool);

  let embeddingActiveResolve: (() => void) | undefined;
  const waitForEmbeddingActive = (): Promise<void> => {
    if (embeddingState.running > 0) return Promise.resolve();
    return new Promise((resolve) => {
      embeddingActiveResolve = resolve;
    });
  };
  let activeDrain: Promise<number> | undefined;
  const suspendAutomaticTemporalEmbeddings = async (): Promise<void> => {
    temporalQueue.stopTemporalEmbeddingScheduler();
    const settled =
      await temporalQueue.settleTemporalEmbeddingScheduler(30_000);
    if (!settled)
      throw new Error("automatic temporal embedding drain did not settle");
  };

  activateScenario = async () => {
    precondition = {
      armed: true,
      reached: false,
      held: true,
      kind: options.scenario,
      evidence: {},
    };
    updateQueuePeaks();
    switch (options.scenario) {
      case "idle-backlog":
      case "foreground-during-backlog":
      case "embeddings-hung": {
        temporalQueue.stopTemporalEmbeddingScheduler();
        embedding._resetLocalProviderProbe();
        embedding._saveAndClearProvider();
        if (!options.nativeProviderDiagnostic) {
          embedding._setTestWorkerFactory(
            (() => new ControlledEmbeddingWorker()) as never,
          );
          temporalQueue._setTemporalEmbeddingRequestTimeoutForTest(30_000);
          const active = waitForEmbeddingActive();
          activeDrain = temporalQueue.drainTemporalEmbeddingQueueOnce();
          const activation = await Promise.race([
            active.then(() => ({ kind: "active" as const, processed: 0 })),
            activeDrain.then((processed) => ({
              kind: "settled" as const,
              processed,
            })),
          ]);
          const observedIdleSchedulerWork =
            options.scenario === "idle-backlog" &&
            activation.kind === "settled" &&
            activation.processed > 0 &&
            currentQueue().temporalDepth > 0;
          precondition = {
            ...precondition,
            reached: activation.kind === "active" || observedIdleSchedulerWork,
            evidence: {
              embeddingExecutions: embeddingState.executions,
              runningEmbeddingOperations: embeddingState.running,
              drainSettledBeforeExecution: activation.kind === "settled",
              processedBeforeExecution: activation.processed,
            },
          };
        } else {
          const processed =
            await temporalQueue.drainTemporalEmbeddingQueueOnce();
          precondition = {
            ...precondition,
            reached: processed > 0,
            held: false,
            evidence: { nativeProcessed: processed },
          };
        }
        break;
      }
      case "embeddings-unavailable": {
        await embedding._shutdownAndDisable();
        const before = currentQueue().temporalDepth;
        const processed = await temporalQueue.drainTemporalEmbeddingQueueOnce();
        const after = currentQueue().temporalDepth;
        const unavailable = !embedding.isAvailable();
        if (unavailable && processed === 0 && after === before)
          fallbackCounts["embedding-provider-unavailable"] = 1;
        precondition = {
          ...precondition,
          reached: unavailable && processed === 0 && after === before,
          evidence: {
            providerAvailable: !unavailable,
            processed,
            durableQueueBefore: before,
            durableQueueAfter: after,
          },
        };
        break;
      }
      case "read-workers-unavailable": {
        process.env.LORE_DISABLE_VEC_WORKER = "1";
        vectorPool._resetVectorPoolForTest();
        installReadTelemetry();
        const result = await vectorPool.tryPoolRead({
          sql: "SELECT COUNT(*) AS count FROM projects",
          params: [],
          mode: "get",
        });
        precondition = {
          ...precondition,
          reached: result === null,
          evidence: { deterministicReadUnavailable: result === null },
        };
        break;
      }
      case "read-workers-slow": {
        vectorPool._resetVectorPoolForTest();
        vectorPool._setTestVectorWorkerFactory(
          (() => new DelayedSqlReadWorker(50)) as never,
        );
        installReadTelemetry();
        precondition = {
          ...precondition,
          reached: true,
          evidence: { delayMs: 50, realSqlExecution: true },
        };
        break;
      }
      case "cancellation":
        holdUpstream = true;
        upstreamHoldThreshold = 1;
        precondition.evidence = { upstreamHoldThreshold };
        break;
      case "concurrent-sessions":
        holdUpstream = true;
        upstreamHoldThreshold = 2;
        precondition.evidence = { upstreamHoldThreshold };
        break;
    }
    return precondition;
  };

  flushUpstream = () => {
    const pending = pendingUpstreamResponses.splice(0);
    activeNotifiedAtPendingCount = 0;
    for (const item of pending)
      sendUpstreamResponse(item.response, item.inputTokens);
  };

  releaseScenario = async () => {
    release = { requested: true, settled: false, returnedToBaseline: false };
    holdUpstream = false;
    flushUpstream?.();
    await settleStreamingPostResponseForBenchmark(options.sessionId);
    const embeddingExecutionsBeforeRelease = embeddingState.executions;
    for (const worker of controlledEmbeddingWorkers)
      worker.releaseAll(core.config().search.embeddings.dimensions);
    // A successful temporal write can admit a follow-up document embed while
    // the original drain settles. Drain every operation that was spawned by
    // this release; never leave a hidden provider call behind the barrier.
    for (;;) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (embeddingState.running === 0) break;
      for (const worker of controlledEmbeddingWorkers)
        worker.releaseAll(core.config().search.embeddings.dimensions);
    }
    if (activeDrain) {
      try {
        await activeDrain;
      } catch {
        fallbackCounts["embedding-operation-failed"] =
          (fallbackCounts["embedding-operation-failed"] ?? 0) + 1;
      }
      activeDrain = undefined;
    }
    temporalQueue.stopTemporalEmbeddingScheduler();
    if (
      options.scenario === "read-workers-unavailable" ||
      options.scenario === "read-workers-slow"
    ) {
      delete process.env.LORE_DISABLE_VEC_WORKER;
      vectorPool._resetVectorPoolForTest();
      vectorPool._setTestVectorWorkerFactory(null);
      installReadTelemetry();
    }
    updateQueuePeaks();
    const read = vectorPool.readPoolStats();
    release = {
      requested: true,
      settled: true,
      returnedToBaseline:
        pendingUpstreamResponses.length === 0 &&
        embeddingState.running === 0 &&
        read.pendingCount === 0 &&
        read.runningCount === 0 &&
        read.retiringCount === 0,
    };
    release = {
      ...release,
      returnedToBaseline:
        release.returnedToBaseline &&
        embeddingState.executions >= embeddingExecutionsBeforeRelease,
    };
    return release;
  };

  const config = {
    ...loadConfig(),
    port: 0,
    portExplicit: false,
    remoteGateway: false,
    hostedMode: false,
    upstreamOpenAI: `http://127.0.0.1:${upstreamPort}`,
    upstreamAnthropic: `http://127.0.0.1:${upstreamPort}`,
  };
  lifecycleStage = "gateway-start";
  const gateway = await startServer(config);
  stopGateway = () => gateway.stop();
  await suspendAutomaticTemporalEmbeddings();

  beginMeasurement = () => {
    measurementActive = true;
    queryExecutionCount = 0;
    readQueueMs.length = 0;
    readServiceMs.length = 0;
    for (const key of Object.keys(fallbackCounts)) delete fallbackCounts[key];
    updateQueuePeaks();
  };

  statsReader = async (quiescent) => {
    await settleStreamingPostResponseForBenchmark(options.sessionId);
    updateQueuePeaks();
    let explicitGc = false;
    if (quiescent) {
      const gc = (globalThis as { gc?: () => void }).gc;
      if (gc) {
        gc();
        explicitGc = true;
      }
    }
    return {
      cpuMs: (() => {
        const cpu = process.cpuUsage();
        return (cpu.user + cpu.system) / 1_000;
      })(),
      memory: process.memoryUsage(),
      explicitGc,
      queues: currentQueue(),
      queuePeaks: { ...queuePeaks },
      fallbackCounts: { ...fallbackCounts },
      queryExecutionCount,
      readQueueMs: [...readQueueMs],
      readServiceMs: [...readServiceMs],
      upstreamMeasurements: structuredClone(upstreamMeasurements),
      upstreamRequests: upstreamMeasurements.length,
      sessionPersistence: sessionPersistence(),
      embedding: { ...embeddingState },
      requestLifecycle: structuredClone(requestLifecycle),
      precondition: structuredClone(precondition),
      release: { ...release },
      seededPersistentState: options.seedPersistentState,
    };
  };
  lifecycleStage = "ready";
  send({ type: "ready", port: gateway.port, pid: process.pid });
}

async function stop(): Promise<void> {
  const failures: unknown[] = [];
  try {
    const embedding = await import("../../../core/src/embedding");
    await embedding.shutdownProvider(5_000);
  } catch (error) {
    failures.push(error);
  }
  try {
    await stopGateway?.();
  } catch (error) {
    failures.push(error);
  }
  try {
    await new Promise<void>((resolve, reject) => {
      if (!upstreamServer?.listening) return resolve();
      upstreamServer.close((error) => (error ? reject(error) : resolve()));
    });
  } catch (error) {
    failures.push(error);
  }
  try {
    const core = await import("@loreai/core");
    core.close();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) throw new AggregateError(failures);
}

process.on("message", (message: ParentMessage) => {
  void (async () => {
    if (message.type === "start") {
      await start(message.options);
      return;
    }
    if (message.type === "begin-measurement") {
      if (!beginMeasurement)
        throw new Error("measurement requested before startup");
      beginMeasurement();
      send({ type: "ack", id: message.id });
      return;
    }
    if (message.type === "activate") {
      if (!activateScenario)
        throw new Error("activation requested before startup");
      send({
        type: "barrier",
        id: message.id,
        barrier: await activateScenario(),
      });
      return;
    }
    if (message.type === "flush-upstream") {
      flushUpstream?.();
      send({ type: "ack", id: message.id });
      return;
    }
    if (message.type === "release") {
      if (!releaseScenario) throw new Error("release requested before startup");
      send({
        type: "release",
        id: message.id,
        release: await releaseScenario(),
      });
      return;
    }
    if (message.type === "stats") {
      if (!statsReader) throw new Error("stats requested before child startup");
      send({
        type: "stats",
        id: message.id,
        stats: await statsReader(message.quiescent),
      });
      return;
    }
    await stop();
    process.exit(0);
  })().catch(() => {
    send({
      type: "fatal",
      message: `mixed-load child failed at ${lifecycleStage}`,
    });
    process.exit(1);
  });
});
