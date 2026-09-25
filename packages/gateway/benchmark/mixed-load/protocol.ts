import type { BenchmarkTimingSample } from "../../src/benchmark-timing";
import type { MixedLoadScenario, WorkloadParameters } from "./workload";

export interface ChildStartOptions {
  root: string;
  projectPath: string;
  scenario: MixedLoadScenario;
  parameters: WorkloadParameters;
}

export type ParentMessage =
  | { type: "start"; options: ChildStartOptions }
  | { type: "stats"; id: number }
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

export interface ChildStats {
  cpuMs: number;
  memory: NodeJS.MemoryUsage;
  queues: QueueSnapshot;
  fallbackCounts: Record<string, number>;
  queryExecutionCount: number;
  readQueueMs: number[];
  readServiceMs: number[];
  upstream: {
    requests: number;
    currentToolPairMismatches: number;
    provenanceItems: number;
    toolOutputs: number;
    projectionHashes: string[];
  };
  storedTemporalMessages: number;
}

export type ChildMessage =
  | { type: "ready"; port: number; pid: number }
  | { type: "timing"; sample: BenchmarkTimingSample }
  | { type: "stats"; id: number; stats: ChildStats }
  | { type: "fatal"; message: string };
