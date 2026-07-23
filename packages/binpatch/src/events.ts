/**
 * Progress events.
 *
 * The library never renders progress — it emits structured lifecycle events
 * and the consumer plugs in any indicator (a stderr bar, a spinner message,
 * a log line), or none. No handler → silent. This keeps rendering (and its
 * per-consumer incompatibilities) entirely out of the library.
 */

/** The phases of a resolve-and-apply run, in order. */
export type ProgressPhase = "resolve" | "download" | "apply" | "verify";

/** A structured progress event emitted during {@link resolveAndApply}. */
export type ProgressEvent =
  | { type: "phase"; phase: ProgressPhase }
  | {
      type: "bytes";
      phase: ProgressPhase;
      /** Bytes produced so far in this phase. */
      written: number;
      /** Total bytes for this phase, or null when not known ahead of time. */
      total: number | null;
    }
  | { type: "done"; phase: ProgressPhase };

/** A progress-event sink. Implementations must never throw. */
export type ProgressHandler = (event: ProgressEvent) => void;

/**
 * Wrap a possibly-throwing handler so a misbehaving consumer can never abort
 * the underlying operation. Progress is always cosmetic.
 */
export function safeProgress(
  handler: ProgressHandler | undefined,
): ProgressHandler {
  if (!handler) return () => {};
  return (event) => {
    try {
      handler(event);
    } catch {
      // ignore — progress is cosmetic and must never abort the operation.
    }
  };
}
