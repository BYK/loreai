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
 * credential. The pipeline passes the provider that just authenticated so the
 * job can decide whether the credential is usable for its extraction model.
 *
 * A dedicated worker key (`LORE_WORKER_API_KEY`) is always available, so in that
 * setup the import can run immediately without waiting for a turn — the caller
 * decides (it runs the job directly instead of registering it).
 */

/**
 * A registered import job. Receives the provider ID that just authenticated
 * (or `undefined` when the trigger is provider-agnostic), so the job can skip
 * when the credential belongs to a provider its extraction model can't use.
 */
type PendingImportJob = (authedProviderID?: string) => Promise<void>;

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
 *
 * @param authedProviderID - Provider ID of the credential that just landed,
 *   forwarded to the job so it can gate on provider compatibility.
 */
export async function flushPendingImport(
  authedProviderID?: string,
): Promise<void> {
  if (!pending || running) return;
  const job = pending;
  pending = null;
  running = true;
  try {
    await job(authedProviderID);
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
