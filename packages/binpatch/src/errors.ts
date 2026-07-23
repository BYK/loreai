/**
 * binpatch error types.
 *
 * A slim, product-neutral error hierarchy for the delta-update engine. No
 * telemetry/SDK coupling — just typed reasons for programmatic handling.
 * Generalized from Lore's `UpgradeError`.
 */

export type BinpatchErrorReason =
  | "network_error"
  | "execution_failed"
  | "version_not_found"
  | "offline_cache_miss";

/** A binpatch error carrying a typed reason. */
export class BinpatchError extends Error {
  readonly reason: BinpatchErrorReason;

  constructor(reason: BinpatchErrorReason, message?: string) {
    const defaultMessages: Record<BinpatchErrorReason, string> = {
      network_error: "Failed to fetch update information.",
      execution_failed: "Applying the update failed.",
      version_not_found: "The specified version was not found.",
      offline_cache_miss:
        "Cannot update offline — no pre-downloaded patch is available.",
    };
    super(message ?? defaultMessages[reason]);
    this.name = "BinpatchError";
    this.reason = reason;
  }
}
