/**
 * Deferred conversation-import hook.
 *
 * `lore run` offers to import prior agent conversations at startup, but at that
 * point the gateway has NOT yet proxied a single turn — so no client credential
 * has been captured. Running the import immediately makes every extraction call
 * fail with `no-auth` (session=_unknown), burning through the whole backlog and
 * producing zero knowledge (see the import-auto no-auth storm).
 *
 * Instead, `maybeAutoImport` registers a one-shot job here, and the pipeline
 * calls {@link flushPendingImport} once the first authenticated turn binds a
 * credential. The job then runs with a real credential available to the worker.
 *
 * A dedicated worker key (`LORE_WORKER_API_KEY`) is always available, so in that
 * setup the import can run immediately without waiting for a turn — the caller
 * decides (it passes `runImmediately`).
 */

/** A registered import job: runs the extraction and resolves when done. */
type PendingImportJob = () => Promise<void>;

let pending: PendingImportJob | null = null;
let running = false;

/**
 * Register a deferred import job. Replaces any previously-registered job (there
 * is only ever one auto-import per `lore run` invocation).
 */
export function registerPendingImport(job: PendingImportJob): void {
  pending = job;
}

/** Whether a deferred import is currently registered (and not yet started). */
export function hasPendingImport(): boolean {
  return pending !== null;
}

/**
 * Run the registered import job, if any. One-shot: the job is cleared before it
 * runs so a second concurrent turn (or a re-entrant call) never double-fires it.
 * The `running` guard covers the async window between clear and completion.
 *
 * Safe to call on every turn — a no-op when nothing is registered. Never throws
 * (the job is expected to swallow its own errors; this is defensive).
 */
export async function flushPendingImport(): Promise<void> {
  if (!pending || running) return;
  const job = pending;
  pending = null;
  running = true;
  try {
    await job();
  } catch {
    // Non-fatal — the job owns user-facing error reporting.
  } finally {
    running = false;
  }
}

/** Test-only: clear all deferred-import state. */
export function _resetPendingImportForTest(): void {
  pending = null;
  running = false;
}
