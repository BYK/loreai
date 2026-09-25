import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import type {
  ChildMessage,
  ChildStartOptions,
  ParentMessage,
} from "./protocol";

if (!process.send) throw new Error("mixed-load child requires an IPC channel");
(globalThis as { require?: NodeRequire }).require = createRequire(
  import.meta.url,
);

const send = (message: ChildMessage): void => process.send?.(message);
let stopGateway: (() => Promise<void>) | undefined;
let upstreamServer: Server | undefined;
let statsReader: (() => import("./protocol").ChildStats) | undefined;
let lifecycleStage = "boot";

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

function countProvenance(value: unknown): number {
  if (Array.isArray(value))
    return value.reduce((count, item) => count + countProvenance(item), 0);
  if (!value || typeof value !== "object") return 0;
  const record = value as Record<string, unknown>;
  const own =
    record.type === "reasoning" || typeof record.encrypted_content === "string"
      ? 1
      : 0;
  return (
    own +
    Object.values(record).reduce(
      (count, item) => count + countProvenance(item),
      0,
    )
  );
}

class SlowReadWorker extends EventEmitter {
  constructor(private readonly delayMs: number) {
    super();
  }
  unref(): void {}
  postMessage(message: { type: string; id: number }): void {
    if (message.type !== "read") return;
    setTimeout(() => {
      this.emit("message", {
        type: "read-result",
        id: message.id,
        rows: [{ value: 1 }],
      });
    }, this.delayMs).unref();
  }
  terminate(): Promise<number> {
    queueMicrotask(() => this.emit("exit", 0));
    return Promise.resolve(0);
  }
}

class HungEmbeddingWorker extends EventEmitter {
  postMessage(): void {}
  ref(): void {}
  unref(): void {}
  terminate(): Promise<number> {
    queueMicrotask(() => this.emit("exit", 0));
    return Promise.resolve(0);
  }
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

  const upstream = {
    requests: 0,
    currentToolPairMismatches: 0,
    provenanceItems: 0,
    toolOutputs: 0,
    projectionHashes: [] as string[],
  };
  upstreamServer = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      upstream.requests++;
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        input?: Array<Record<string, unknown>>;
      };
      const input = body.input ?? [];
      upstream.provenanceItems += countProvenance(input);
      upstream.toolOutputs += input.filter(
        (item) => item.type === "function_call_output",
      ).length;
      const projection = input.filter(
        (item) =>
          item.type === "function_call" || item.type === "function_call_output",
      );
      upstream.projectionHashes.push(
        createHash("sha256").update(JSON.stringify(projection)).digest("hex"),
      );
      for (
        let pair = 0;
        pair < options.parameters.currentTurnToolPairs;
        pair++
      ) {
        const id = `current-${options.parameters.seed}-${pair}`;
        const call = input.some(
          (item) => item.type === "function_call" && item.call_id === id,
        );
        const output = input.some(
          (item) => item.type === "function_call_output" && item.call_id === id,
        );
        if (!call || !output) upstream.currentToolPairMismatches++;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: `resp_benchmark_${upstream.requests}`,
          object: "response",
          created_at: 1_795_000_000,
          model: "gpt-5.4-mini",
          status: "completed",
          output: [
            {
              type: "message",
              id: `msg_benchmark_${upstream.requests}`,
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
            input_tokens: options.parameters.activeWindowTokens,
            output_tokens: 4,
            total_tokens: options.parameters.activeWindowTokens + 4,
            input_tokens_details: {
              cached_tokens: 0,
              cache_write_tokens: 0,
            },
            output_tokens_details: { reasoning_tokens: 0 },
          },
        }),
      );
    });
  });
  const upstreamPort = await listen(upstreamServer);

  lifecycleStage = "imports";
  const core = await import("@loreai/core");
  const ltm = await import("../../../core/src/ltm");
  const admission =
    await import("../../../core/src/temporal-embedding-admission");
  const temporalQueue =
    await import("../../../core/src/temporal-embedding-queue");
  const embedding = await import("../../../core/src/embedding");
  const vectorPool = await import("../../../core/src/vector-pool");
  const { nodeHttpFetch, setUpstreamFetchOverrideForTest } =
    await import("../../src/fetch");
  const { offlineModelsDevResponse } =
    await import("../../test/helpers/models-dev-dispatcher");
  const { setBenchmarkFailureObserver, setBenchmarkTimingObserver } =
    await import("../../src/benchmark-timing");
  const { setUpstreamInterceptor } = await import("../../src/pipeline");
  const { loadConfig } = await import("../../src/config");
  const { startServer } = await import("../../src/server");

  // Keep metadata discovery deterministic and offline. Provider traffic is
  // routed through the loopback interceptor below.
  setUpstreamFetchOverrideForTest(offlineModelsDevResponse);
  setUpstreamInterceptor((body, _model, _stream, _makeReal) =>
    nodeHttpFetch(`http://127.0.0.1:${upstreamPort}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

  let queryExecutionCount = 0;
  const readQueueMs: number[] = [];
  const readServiceMs: number[] = [];
  const fallbackCounts: Record<string, number> = {};
  core.log.registerSink({
    info() {},
    warn() {},
    error() {
      fallbackCounts["logged-errors"] =
        (fallbackCounts["logged-errors"] ?? 0) + 1;
    },
    captureException() {},
    withDbSpan(_sql, fn) {
      queryExecutionCount++;
      return fn();
    },
  });
  core.setReadPoolTelemetryHook((sample) => {
    fallbackCounts[`read-${sample.outcome}`] =
      (fallbackCounts[`read-${sample.outcome}`] ?? 0) + 1;
    if (sample.queueMs !== undefined) readQueueMs.push(sample.queueMs);
    if (sample.serviceMs !== undefined) readServiceMs.push(sample.serviceMs);
  });
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
        outcome: "failure",
      },
    });
  });

  lifecycleStage = "fixture-seed";
  await core.load(options.projectPath);
  const projectId = core.ensureProject(options.projectPath);
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
    `INSERT OR IGNORE INTO temporal_messages
       (id, source_id, project_id, session_id, role, content, tokens, distilled, created_at, metadata)
     VALUES (?, ?, ?, ?, 'user', ?, 8, 0, ?, NULL)`,
  );
  for (let index = 0; index < temporalEntries; index++) {
    const id = `benchmark-temporal-${index}`;
    const content =
      `Deterministic queued embedding ${index}. ` +
      "This synthetic content is long enough to require a vector.";
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

  const drainHungEmbedding = (): Promise<number> => {
    embedding._resetLocalProviderProbe();
    embedding._saveAndClearProvider();
    embedding._setTestWorkerFactory((() => new HungEmbeddingWorker()) as never);
    temporalQueue._setTemporalEmbeddingRequestTimeoutForTest(100);
    return temporalQueue.drainTemporalEmbeddingQueueOnce();
  };

  if (options.scenario === "embeddings-unavailable") {
    await embedding._shutdownAndDisable();
    const processed = await temporalQueue.drainTemporalEmbeddingQueueOnce();
    fallbackCounts["embedding-unavailable"] = processed === 0 ? 1 : 0;
  } else if (options.scenario === "embeddings-hung") {
    void drainHungEmbedding().catch(() => {
      fallbackCounts["embedding-timeout"] = 1;
    });
  } else if (options.scenario === "foreground-during-backlog") {
    void drainHungEmbedding().catch(() => {
      fallbackCounts["embedding-timeout"] = 1;
    });
  }

  lifecycleStage = "scenario-setup";
  if (options.scenario === "read-workers-unavailable") {
    process.env.LORE_DISABLE_VEC_WORKER = "1";
    const result = await vectorPool.tryPoolRead({
      sql: "SELECT 1 AS value",
      params: [],
      mode: "get",
    });
    fallbackCounts["read-unavailable-result"] = result === null ? 1 : 0;
  } else if (options.scenario === "read-workers-slow") {
    vectorPool._setTestVectorWorkerFactory(
      (() => new SlowReadWorker(50)) as never,
    );
    await vectorPool.tryPoolRead({
      sql: "SELECT 1 AS value",
      params: [],
      mode: "get",
    });
  }

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

  statsReader = () => {
    const queue = core
      .db()
      .query(
        `SELECT COUNT(*) AS depth,
                COALESCE(MAX(0, ? - enqueued_at), 0) AS oldest_age
           FROM temporal_embedding_queue`,
      )
      .get(Date.now()) as { depth: number; oldest_age: number };
    const cpu = process.cpuUsage();
    const stored = core
      .db()
      .query("SELECT COUNT(*) AS count FROM temporal_messages")
      .get() as { count: number };
    return {
      cpuMs: (cpu.user + cpu.system) / 1_000,
      memory: process.memoryUsage(),
      queues: {
        temporalDepth: queue.depth,
        temporalOldestAgeMs: queue.oldest_age,
        read: vectorPool.readPoolStats(),
      },
      fallbackCounts: { ...fallbackCounts },
      queryExecutionCount,
      readQueueMs: [...readQueueMs],
      readServiceMs: [...readServiceMs],
      upstream: { ...upstream },
      storedTemporalMessages: stored.count,
    };
  };
  lifecycleStage = "ready";
  send({ type: "ready", port: gateway.port, pid: process.pid });
}

async function stop(): Promise<void> {
  const failures: unknown[] = [];
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
    if (message.type === "stats") {
      if (!statsReader) throw new Error("stats requested before child startup");
      send({ type: "stats", id: message.id, stats: statsReader() });
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
