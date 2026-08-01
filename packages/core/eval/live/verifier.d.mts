export interface VerifierProcessOptions {
  spawn: (...args: unknown[]) => unknown;
  verifier: string | Uint8Array;
  checkpoint: string;
  scope: string;
  project: string;
  image: string;
  facts: Record<string, unknown>;
  timeoutMs?: number;
}

export function runVerifierProcess(
  options: VerifierProcessOptions,
): Promise<{ passed: boolean; error?: string }>;
