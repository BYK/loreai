// Re-export for convenience
export type { LLMClient } from "./types";

// ---------------------------------------------------------------------------
// Shared worker session tracking
// ---------------------------------------------------------------------------

/** Set of ALL worker session IDs across distillation, curator, and query expansion.
 *  Used by shouldSkip() in host adapters to avoid storing/distilling worker messages. */
export const workerSessionIDs = new Set<string>();

export function isWorkerSession(sessionID: string): boolean {
  return workerSessionIDs.has(sessionID);
}
