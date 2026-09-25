import { fork, execFileSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { cpus, platform, arch, totalmem, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ChildMessage,
  ChildStartOptions,
  ChildStats,
  ParentMessage,
} from "./protocol";
import {
  MIXED_LOAD_PROFILES,
  MIXED_LOAD_SCENARIOS,
  REFERENCE_TARGETS,
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

class BenchmarkChild {
  readonly process: ChildProcess;
  readonly timings = new Map<
    string,
    import("../../src/benchmark-timing").BenchmarkTimingSample
  >();
  readonly timingWaiters = new Map<
    string,
    (sample: import("../../src/benchmark-timing").BenchmarkTimingSample) => void
  >();
  port = 0;
  pid = 0;
  private nextStatsId = 0;
  private readonly statsWaiters = new Map<
    number,
    (stats: ChildStats) => void
  >();
  private readyResolve: (() => void) | undefined;
  private readonly ready = new Promise<void>((resolve) => {
    this.readyResolve = resolve;
  });
  private fatal: Error | undefined;

  constructor() {
    const childPath = fileURLToPath(new URL("./child.ts", import.meta.url));
    this.process = fork(childPath, [], {
      execArgv: ["--conditions=development", "--import", "tsx"],
      env: { ...process.env, NODE_ENV: "benchmark" },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    // Child diagnostics can contain arbitrary dependency text. Drain forever
    // without inspecting or reporting it.
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
      if (message.type === "stats") {
        this.statsWaiters.get(message.id)?.(message.stats);
        this.statsWaiters.delete(message.id);
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

  async start(options: ChildStartOptions): Promise<void> {
    this.send({ type: "start", options });
    await this.ready;
    if (this.fatal) throw this.fatal;
    if (this.port === 0)
      throw new Error("benchmark child did not report a port");
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

  stats(): Promise<ChildStats> {
    const id = ++this.nextStatsId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.statsWaiters.delete(id);
        reject(new Error("benchmark child stats timed out"));
      }, 30_000);
      timeout.unref();
      this.statsWaiters.set(id, (stats) => {
        clearTimeout(timeout);
        resolve(stats);
      });
      this.send({ type: "stats", id });
    });
  }

  async stop(): Promise<void> {
    if (!this.process.connected) return;
    const exited = new Promise<void>((resolve) =>
      this.process.once("exit", () => resolve()),
    );
    this.send({ type: "stop" });
    await exited;
  }
}

function request(
  port: number,
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    cancel?: boolean;
  } = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const req = httpRequest(
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
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            elapsedMs: performance.now() - startedAt,
          }),
        );
      },
    );
    req.on("error", (error) => {
      if (
        options.cancel &&
        (error as NodeJS.ErrnoException).code === "ECONNRESET"
      )
        resolve({
          status: 0,
          body: "",
          elapsedMs: performance.now() - startedAt,
        });
      else reject(error);
    });
    if (options.body) req.write(options.body);
    if (options.cancel) {
      req.destroy();
      return;
    }
    req.end();
  });
}

function appendContinuation(
  source: ResponsesWorkloadBody,
  seed: number,
): ResponsesWorkloadBody {
  const callId = `append-${seed}`;
  return {
    ...source,
    input: [
      ...source.input,
      {
        type: "message",
        role: "user",
        content: "Inspect the deterministic appended fixture.",
      },
      {
        type: "reasoning",
        id: `append-reason-${seed}`,
        encrypted_content: "deterministic-appended-provenance",
        summary: [],
      },
      {
        type: "function_call",
        call_id: callId,
        name: "read_file",
        arguments: JSON.stringify({ path: "appended.ts" }),
      },
      {
        type: "function_call_output",
        call_id: callId,
        output: "deterministic appended output",
      },
    ],
  };
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
  };
}

async function timedTurn(input: {
  child: BenchmarkChild;
  body: ResponsesWorkloadBody;
  projectPath: string;
  sessionId: string;
  requestId: string;
  concurrentSessions?: number;
  acceptedStatuses?: readonly number[];
}): Promise<{ samples: BenchmarkSample[]; responses: HttpResult[] }> {
  const bodyText = JSON.stringify(input.body);
  const before = await input.child.stats();
  const count = input.concurrentSessions ?? 1;
  const responsePromises = Array.from({ length: count }, (_, index) => {
    const requestId =
      count === 1 ? input.requestId : `${input.requestId}-${index}`;
    return request(input.child.port, "/v1/responses", {
      method: "POST",
      headers: responseHeaders(
        input.projectPath,
        `${input.sessionId}-${index}`,
        requestId,
        bodyText,
      ),
      body: bodyText,
    });
  });
  const healthPromises = Array.from({ length: 3 }, () =>
    request(input.child.port, "/health"),
  );
  const [responses, health] = await Promise.all([
    Promise.all(responsePromises),
    Promise.all(healthPromises),
  ]);
  const acceptedStatuses = input.acceptedStatuses ?? [200];
  const failed = responses.find(
    (response) => !acceptedStatuses.includes(response.status),
  );
  if (failed) {
    const failedStats = await input.child.stats();
    let errorType = "unknown";
    let errorMessage = "unknown";
    try {
      const decoded = JSON.parse(failed.body) as {
        error?: { type?: unknown; message?: unknown };
      };
      if (typeof decoded.error?.type === "string")
        errorType = decoded.error.type;
      if (
        decoded.error?.message === "No trusted upstream destination" ||
        decoded.error?.message === "Gateway request failed" ||
        decoded.error?.message === "Recall continuation failed"
      )
        errorMessage = decoded.error.message;
      else if (
        typeof decoded.error?.message === "string" &&
        decoded.error.message.startsWith("Gateway pipeline error:")
      )
        errorMessage = "Gateway pipeline error";
    } catch {
      // Keep arbitrary response text private.
    }
    throw new Error(
      `benchmark request returned HTTP ${failed.status} (${errorType}, ${errorMessage}, upstream requests ${failedStats.upstream.requests})`,
    );
  }
  const timings = await Promise.all(
    Array.from({ length: count }, (_, index) =>
      input.child.timing(
        count === 1 ? input.requestId : `${input.requestId}-${index}`,
      ),
    ),
  );
  const after = await input.child.stats();
  const sortedHealthMs = health
    .map((sample) => sample.elapsedMs)
    .toSorted((a, b) => a - b);
  const healthP95 = sortedHealthMs.at(-1);
  if (healthP95 === undefined)
    throw new Error("health sampling returned empty");
  return {
    responses,
    samples: timings.map((timing) => ({
      decodeMs: timing.decodeMs,
      postDecodeToUpstreamMs: timing.postDecodeToUpstreamMs,
      healthMs: healthP95,
      processCpuMs: Math.max(0, after.cpuMs - before.cpuMs),
      retainedBytes: after.memory.heapUsed,
    })),
  };
}

function workloadConfig(
  activeWindowTokens: number,
  scenario: MixedLoadScenario,
  nativeProviderDiagnostic: boolean,
): string {
  return JSON.stringify({
    budget: { maxLayer0Tokens: activeWindowTokens },
    search: {
      embeddings: {
        enabled:
          (nativeProviderDiagnostic && scenario === "idle-backlog") ||
          scenario === "embeddings-hung" ||
          scenario === "foreground-during-backlog",
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

export async function runMixedLoadBenchmark(options: RunnerOptions = {}) {
  const profiles =
    options.profiles ??
    MIXED_LOAD_PROFILES.map((profile, index) => ({
      ...profile,
      seed: 1_733 + index,
    }));
  const scenarios = options.scenarios ?? MIXED_LOAD_SCENARIOS;
  const warmups = options.warmups ?? 1;
  const samplesPerMode = options.samples ?? 3;
  const reportScenarios: unknown[] = [];

  for (const profile of profiles) {
    const workload = generateResponsesWorkload(profile);
    const continuation = appendContinuation(
      workload.body,
      workload.parameters.seed,
    );
    assertResponsesWorkloadParity(
      workload.body,
      workload.parameters.currentTurnToolPairs,
    );
    for (const scenario of scenarios) {
      const acceptedStatuses =
        scenario === "read-workers-unavailable" ? [503] : [200];
      const root = mkdtempSync(join(tmpdir(), "lore-mixed-load-"));
      const projectPath = join(root, "project");
      mkdirSync(projectPath, { recursive: true });
      writeFileSync(
        join(projectPath, ".lore.json"),
        workloadConfig(
          workload.parameters.activeWindowTokens,
          scenario,
          options.nativeProviderDiagnostic === true,
        ),
      );
      const childOptions = {
        root,
        projectPath,
        scenario,
        parameters: workload.parameters,
      } satisfies ChildStartOptions;
      const allSamples: BenchmarkSample[] = [];
      const processIds: number[] = [];
      let cancellationBounded = true;
      let firstStats: ChildStats | undefined;
      let restartStats: ChildStats | undefined;
      let first: BenchmarkChild | undefined;
      let restarted: BenchmarkChild | undefined;
      try {
        first = new BenchmarkChild();
        await first.start(childOptions);
        processIds.push(first.pid);
        // Populate the durable source checkpoint before measuring a genuine
        // append. This is setup, not a timing warmup.
        await timedTurn({
          child: first,
          body: workload.body,
          projectPath,
          sessionId: `${scenario}-append`,
          requestId: `${scenario}-base`,
          acceptedStatuses,
        });
        for (let warmup = 0; warmup < warmups; warmup++)
          await timedTurn({
            child: first,
            body: workload.body,
            projectPath,
            sessionId: `${scenario}-warmup-${warmup}`,
            requestId: `${scenario}-warmup-${warmup}`,
            acceptedStatuses,
          });
        if (scenario === "cancellation") {
          const bodyText = JSON.stringify(workload.body);
          const cancelled = await request(first.port, "/v1/responses", {
            method: "POST",
            headers: responseHeaders(
              projectPath,
              `${scenario}-cancelled`,
              `${scenario}-cancelled`,
              bodyText,
            ),
            body: bodyText,
            cancel: true,
          });
          cancellationBounded = cancelled.status === 0;
        }
        for (let sample = 0; sample < samplesPerMode; sample++) {
          const turn = await timedTurn({
            child: first,
            body: continuation,
            projectPath,
            sessionId: `${scenario}-append`,
            requestId: `${scenario}-append-${sample}`,
            concurrentSessions: scenario === "concurrent-sessions" ? 2 : 1,
            acceptedStatuses,
          });
          if (
            turn.responses.some(
              (response) => !acceptedStatuses.includes(response.status),
            )
          )
            throw new Error(`${scenario} append request failed`);
          allSamples.push(...turn.samples);
        }
        firstStats = await first.stats();
        await first.stop();
        first = undefined;

        restarted = new BenchmarkChild();
        await restarted.start(childOptions);
        processIds.push(restarted.pid);
        for (let sample = 0; sample < samplesPerMode; sample++) {
          const turn = await timedTurn({
            child: restarted,
            body: continuation,
            projectPath,
            sessionId: `${scenario}-append`,
            requestId: `${scenario}-restart-${sample}`,
            acceptedStatuses,
          });
          if (
            turn.responses.some(
              (response) => !acceptedStatuses.includes(response.status),
            )
          )
            throw new Error(`${scenario} restart request failed`);
          allSamples.push(...turn.samples);
        }
        restartStats = await restarted.stats();
        await restarted.stop();
        restarted = undefined;

        const maxExpectedQueue =
          workload.parameters.vectorEntries +
          workload.parameters.backlogEntries +
          (warmups + samplesPerMode * 3 + 4);
        const unavailableReadScenario = scenario === "read-workers-unavailable";
        const seededTemporalMessages =
          workload.parameters.vectorEntries +
          workload.parameters.backlogEntries;
        const scenarioBehavior = (() => {
          switch (scenario) {
            case "idle-backlog":
              return firstStats.queues.temporalDepth > 0;
            case "foreground-during-backlog":
              return (
                firstStats.queues.temporalDepth > 0 &&
                firstStats.upstream.requests === 1 + warmups + samplesPerMode
              );
            case "embeddings-hung":
              return firstStats.queues.temporalDepth > 0;
            case "embeddings-unavailable":
              return firstStats.fallbackCounts["embedding-unavailable"] === 1;
            case "read-workers-unavailable":
              return firstStats.fallbackCounts["read-unavailable-result"] === 1;
            case "read-workers-slow":
              return firstStats.readServiceMs.some((value) => value >= 40);
            case "cancellation":
              return (
                firstStats.upstream.requests === 1 + warmups + samplesPerMode
              );
            case "concurrent-sessions":
              return (
                firstStats.upstream.requests ===
                1 + warmups + samplesPerMode * 2
              );
          }
        })();
        const invariants = {
          distinctServingProcesses:
            processIds.length === 2 && processIds[0] !== processIds[1],
          boundedTemporalQueue:
            firstStats.queues.temporalDepth <= maxExpectedQueue &&
            restartStats.queues.temporalDepth <= maxExpectedQueue,
          boundedReadQueue:
            firstStats.queues.read.pendingCount <= 128 &&
            restartStats.queues.read.pendingCount <= 128,
          cancellationBounded,
          scenarioBehavior,
          currentToolPairsPreserved:
            unavailableReadScenario ||
            (firstStats.upstream.currentToolPairMismatches === 0 &&
              restartStats.upstream.currentToolPairMismatches === 0),
          outputParity:
            unavailableReadScenario ||
            (firstStats.upstream.toolOutputs > 0 &&
              restartStats.upstream.toolOutputs > 0 &&
              firstStats.upstream.projectionHashes.at(-1) ===
                restartStats.upstream.projectionHashes.at(-1)),
          provenanceParity:
            workload.body.input.some((item) => item.type === "reasoning") &&
            (unavailableReadScenario ||
              firstStats.upstream.provenanceItems ===
                restartStats.upstream.provenanceItems),
          sanitizedUnavailableRead:
            !unavailableReadScenario ||
            (firstStats.upstream.requests === 0 &&
              restartStats.upstream.requests === 0 &&
              firstStats.fallbackCounts["read-unavailable-result"] === 1 &&
              restartStats.fallbackCounts["read-unavailable-result"] === 1),
          durableWriteOrdering:
            unavailableReadScenario ||
            (firstStats.storedTemporalMessages > seededTemporalMessages &&
              restartStats.storedTemporalMessages >=
                firstStats.storedTemporalMessages),
        };
        const failedInvariants = Object.entries(invariants)
          .filter(([, value]) => !value)
          .map(([name]) => name);
        if (failedInvariants.length > 0)
          throw new Error(
            `${scenario} invariant failed: ${failedInvariants.join(",")} (outputs ${firstStats.upstream.toolOutputs}/${restartStats.upstream.toolOutputs}, provenance ${firstStats.upstream.provenanceItems}/${restartStats.upstream.provenanceItems}, fallbacks ${JSON.stringify(firstStats.fallbackCounts)})`,
          );
        reportScenarios.push({
          profile: workload.parameters.name,
          scenario,
          processIds,
          summary: summarizeBenchmarkSamples(allSamples),
          queue: {
            beforeRestart: firstStats.queues,
            afterRestart: restartStats.queues,
          },
          readWaitMs: {
            queue: [...firstStats.readQueueMs, ...restartStats.readQueueMs],
            service: [
              ...firstStats.readServiceMs,
              ...restartStats.readServiceMs,
            ],
          },
          fallbackCounts: {
            beforeRestart: firstStats.fallbackCounts,
            afterRestart: restartStats.fallbackCounts,
          },
          queryExecutionCounts: {
            beforeRestart: firstStats.queryExecutionCount,
            afterRestart: restartStats.queryExecutionCount,
          },
          retainedMemory: {
            beforeRestart: firstStats.memory,
            afterRestart: restartStats.memory,
          },
          invariants,
        });
      } finally {
        await first?.stop();
        await restarted?.stop();
        if (!options.keepRoot) rmSync(root, { recursive: true, force: true });
      }
    }
  }

  const report = {
    schemaVersion: 1,
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
      profiles,
      scenarios,
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
      referenceTargets: report.referenceTargets,
      reportHash: createHash("sha256")
        .update(JSON.stringify(report.scenarios))
        .digest("hex"),
    })}\n`,
  );
}
