import type { BenchmarkTimingSample } from "../../src/benchmark-timing";
import type { MixedLoadScenario, WorkloadParameters } from "./workload";

export interface ChildStartOptions {
  root: string;
  projectPath: string;
  sessionId: string;
  scenario: MixedLoadScenario;
  parameters: WorkloadParameters;
  seedPersistentState: boolean;
  nativeProviderDiagnostic: boolean;
}

export type ParentMessage =
  | { type: "start"; options: ChildStartOptions }
  | { type: "begin-measurement"; id: number }
  | { type: "activate"; id: number }
  | { type: "flush-upstream"; id: number }
  | { type: "release"; id: number }
  | { type: "stats"; id: number; quiescent: boolean }
  | { type: "stop" };

export interface QueueSnapshot {
  temporalDepth: number;
  temporalOldestAgeMs: number;
  read: {
    pendingCount: number;
    pendingBytes: number;
    runningCount: number;
    retiringCount: number;
    oldestPendingMs: number;
  };
}

export interface QueuePeaks {
  temporalDepth: number;
  temporalOldestAgeMs: number;
  readPendingCount: number;
  readPendingBytes: number;
  readRunningCount: number;
  readOldestPendingMs: number;
}

export interface ScenarioBarrier {
  armed: boolean;
  reached: boolean;
  held: boolean;
  kind: MixedLoadScenario;
  evidence: Record<string, number | boolean | string>;
}

export interface ScenarioRelease {
  requested: boolean;
  settled: boolean;
  returnedToBaseline: boolean;
}

export interface UpstreamMeasurement {
  bodyHash: string;
  inputItems: number;
  normalizedMessages: number;
  estimatedInputTokens: number;
  toolCalls: number;
  toolOutputs: number;
  toolSequenceBytes: number;
  toolSequenceHash: string;
  provenanceItems: number;
  provenanceBytes: number;
  provenanceHash: string;
  currentTurnOrderHash: string;
  currentTurnStatuses: Array<{
    callId: string;
    callIndex: number;
    resultIndex: number;
    callStatus: string | null;
    resultStatus: string | null;
  }>;
  reportedProviderUsage: number;
  usageSource: "authoritative-local-estimate";
}

export interface SessionPersistenceSnapshot {
  temporalMessages: number;
  checkpointRevision: number | null;
  checkpointChecksum: string | null;
  checkpointPublished: boolean;
}

export interface ChildStats {
  cpuMs: number;
  memory: NodeJS.MemoryUsage;
  explicitGc: boolean;
  queues: QueueSnapshot;
  queuePeaks: QueuePeaks;
  fallbackCounts: Record<string, number>;
  queryExecutionCount: number;
  readQueueMs: number[];
  readServiceMs: number[];
  upstreamMeasurements: UpstreamMeasurement[];
  upstreamRequests: number;
  sessionPersistence: SessionPersistenceSnapshot;
  embedding: {
    workerInstances: number;
    executions: number;
    completions: number;
    running: number;
    peakRunning: number;
    duplicateExecutions: number;
    replacementWorkers: number;
  };
  requestLifecycle: Record<
    string,
    { foregroundAcquired: number; foregroundReleased: number }
  >;
  precondition: ScenarioBarrier;
  release: ScenarioRelease;
  seededPersistentState: boolean;
}

export type ChildMessage =
  | { type: "ready"; port: number; pid: number }
  | { type: "timing"; sample: BenchmarkTimingSample }
  | { type: "stats"; id: number; stats: ChildStats }
  | { type: "barrier"; id: number; barrier: ScenarioBarrier }
  | { type: "release"; id: number; release: ScenarioRelease }
  | { type: "ack"; id: number }
  | { type: "scenario-active"; sequence: number }
  | {
      type: "request-lifecycle";
      requestId: string;
      event: "foreground-acquired" | "foreground-released";
    }
  | { type: "fatal"; message: string };
