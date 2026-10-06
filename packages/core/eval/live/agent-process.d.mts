import type { ChildProcess } from "node:child_process";

export function waitForAgentProcess(
  process: ChildProcess,
  timeoutMs: number,
): Promise<{ code: number; timedOut: boolean }>;
