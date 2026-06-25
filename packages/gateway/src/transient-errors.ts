/**
 * Transient error classification for Sentry.
 *
 * A long-running LLM proxy routinely hits network and runtime conditions that
 * are expected and not actionable bugs: clients disconnect, upstreams close
 * sockets, DNS blips, ONNX/embedding init fails on exotic hosts, etc. Reporting
 * these to Sentry creates noise that buries real bugs.
 *
 * These patterns are shared by `instrument.ts`'s Sentry `beforeSend` filter
 * (which inspects each exception in an event's chain) and its structured-log
 * error gate (which inspects the log message string). They live in their own
 * module so the classification is unit-testable without importing
 * `instrument.ts`, which runs `Sentry.init()` as an import side effect.
 */

/**
 * Messages matching any of these are considered transient and dropped.
 *
 * NOTE: prefer matching the *inner* network cause (e.g. `ECONNRESET`,
 * `ENETUNREACH`, `other side closed`) over the generic undici wrapper
 * (`fetch failed` / `terminated`). `beforeSend` tests every exception in the
 * chain, so matching the inner cause is sufficient to drop the event — while
 * leaving the generic wrapper unmatched ensures a genuine bug that merely wraps
 * a fetch is never silenced.
 */
export const TRANSIENT_ERROR_PATTERNS: RegExp[] = [
  /\bEPIPE\b/,
  /socket connection was closed unexpectedly/i,
  /ZlibError/,
  /The operation timed out/i,
  /Worker upstream exhausted \d+ retries/,
  /Worker upstream auth error/,
  /embedding worker/i,
  /WASM fatal error/,
  /LocalProviderUnavailableError/,
  /ECONNRESET\b/,
  /ECONNREFUSED\b/,
  // Connection-layer transients to upstream LLM providers. These surface as
  // undici `TypeError: fetch failed` / `TypeError: terminated` wrapping a
  // network cause; matching the inner cause drops the whole event.
  /\bENETUNREACH\b/,
  /\bETIMEDOUT\b/,
  /\bEHOSTUNREACH\b/,
  /\bEAI_AGAIN\b/, // DNS resolution timeout
  /other side closed/i, // undici SocketError behind "terminated"
  // Remote embedding fallback with invalid/placeholder API key (OpenAI SDK format)
  /Incorrect API key provided/i,
  // ONNX runtime init failures on various platforms
  /Cannot find package 'onnxruntime-node'/,
  /LoadLibrary failed/,
  /Protobuf parsing failed/,
  // Bun doesn't implement getSystemErrorMap from node:util —
  // this crashes the Sentry SDK itself during error processing
  /getSystemErrorMap/,
];

/** True if `text` matches any transient-error pattern. */
export function isTransientErrorMessage(text: string): boolean {
  return TRANSIENT_ERROR_PATTERNS.some((re) => re.test(text));
}

/** Minimal shape of the Sentry event fields this module inspects. */
export interface TransientCheckEvent {
  exception?: {
    values?: Array<{ type?: string; value?: string }>;
  };
}

/**
 * True if any exception in the event's chain is transient. Each exception is
 * tested independently (as `"<type>: <value>"`) so a real bug wrapping a
 * transient cause is only dropped if the real bug *itself* matches.
 */
export function eventHasTransientError(event: TransientCheckEvent): boolean {
  const values = event.exception?.values;
  if (!values) return false;
  return values.some((v) => isTransientErrorMessage(`${v.type}: ${v.value}`));
}
