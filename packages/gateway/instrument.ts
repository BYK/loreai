/**
 * Sentry instrumentation.
 *
 * By default, Sentry is enabled in production builds (where esbuild
 * injects a real semver string via LORE_CLI_VERSION) and disabled in
 * dev mode (VERSION falls back to "dev").
 *
 * Explicit control via SENTRY_ENABLED env var:
 *   - SENTRY_ENABLED=1  → force on  (useful for local dev testing)
 *   - SENTRY_ENABLED=0  → force off (opt out in production)
 *
 * When force-enabled in dev mode, environment is set to "development";
 * production builds always use "production".
 *
 * This file is imported as a side-effect from both entry points:
 *   - src/cli/bin.ts  (standalone binary)
 *   - src/index.ts    (npm bundle / direct execution)
 *
 * Static imports are used (not dynamic) because the CJS npm bundle
 * does not support top-level await. The modules are loaded but
 * Sentry.init() only runs when the gate passes.
 */
// Bun's internal fetch creates a zlib.Gunzip stream for gzip-compressed
// upstream responses. The Web Streams adapter + OpenCode's Effect-TS runtime
// attach 11 listeners (1 above the default limit of 10), triggering a benign
// MaxListenersExceededWarning once per process. Raise the default slightly.
import { setMaxListeners } from "node:events";
setMaxListeners(15);

import * as Sentry from "@sentry/bun";
import { log } from "@loreai/core";
import { VERSION } from "./src/cli/version";

/**
 * Build-time debug ID for sourcemap resolution, injected by esbuild.
 *
 * During the build, esbuild's `define` replaces this identifier with a
 * placeholder UUID string literal. After esbuild finishes, the build
 * script replaces the placeholder with the real debug ID (derived from
 * the sourcemap content hash). The same-length swap keeps sourcemap
 * character positions valid.
 */
declare const __SENTRY_DEBUG_ID__: string | undefined;

/**
 * Register the build-time debug ID with the Sentry SDK's native discovery.
 *
 * The SDK reads `globalThis._sentryDebugIds` (a map of Error.stack → debugId)
 * during event processing to populate `debug_meta.images`, which the server
 * uses to match uploaded sourcemaps.
 *
 * This is the ESM-safe alternative to prepending an IIFE snippet — placing
 * the registration here (inside the module, after all imports) is valid ESM
 * and feeds the SDK's existing mechanism directly.
 */
if (typeof __SENTRY_DEBUG_ID__ !== "undefined") {
  try {
    const stack = new Error().stack;
    if (stack) {
      const g = globalThis as { _sentryDebugIds?: Record<string, string> };
      g._sentryDebugIds = g._sentryDebugIds || {};
      g._sentryDebugIds[stack] = __SENTRY_DEBUG_ID__;
    }
  } catch (_) {
    // Non-critical — sourcemap resolution degrades gracefully
  }
}

const sentryEnvVar = process.env.SENTRY_ENABLED?.trim();
const isDev = VERSION === "dev";
// Bun's test runner always sets NODE_ENV="test" — regardless of the working
// directory or whether a bunfig.toml is loaded. This guard wins over EVERYTHING
// (including an explicit SENTRY_ENABLED=1) so the SDK never installs its
// background transport during tests. The transport uses globalThis.fetch and
// would otherwise race into tests that mock fetch (call-count inflation /
// capturedInit clobber — see #527 / #529 / #530).
//
// Why this is the single, CWD-independent source of truth: the root
// bunfig.toml [test.env] SENTRY_ENABLED=0 is NOT effective when (a) tests run
// from a sub-package dir that has no bunfig, or (b) the shell already exports
// SENTRY_ENABLED — Bun's [test.env] does not override an inherited env var. A
// test process must never ship telemetry, so NODE_ENV==="test" is a hard off.
const isTestRunner = process.env.NODE_ENV === "test";
const sentryEnabled = isTestRunner
  ? false
  : sentryEnvVar === "1"
    ? true
    : sentryEnvVar === "0"
      ? false
      : !isDev;

if (sentryEnabled && !Sentry.isInitialized()) {
  // Transient network errors that are expected in a long-running LLM proxy.
  // These are not actionable bugs — they occur when clients disconnect,
  // upstreams are temporarily unavailable, or network conditions degrade.
  const TRANSIENT_ERROR_PATTERNS = [
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

  Sentry.init({
    dsn: "https://0282201d6a3df3bc46423e61012ae62b@o275100.ingest.us.sentry.io/4511355222622208",

    release: VERSION,
    environment: isDev ? "development" : "production",

    // Adds request headers and IP for users, for more info visit:
    // https://docs.sentry.io/platforms/javascript/guides/bun/configuration/options/#sendDefaultPii
    sendDefaultPii: true,

    // Capture 100% of transactions and logs
    tracesSampleRate: 1.0,
    enableLogs: true,

    // Drop transient network errors that are not actionable bugs.
    // Each exception in the chain is tested independently so a real bug
    // wrapping a transient cause isn't accidentally silenced.
    beforeSend(event) {
      const values = event.exception?.values;
      if (
        values?.some((v) => {
          const msg = `${v.type}: ${v.value}`;
          return TRANSIENT_ERROR_PATTERNS.some((re) => re.test(msg));
        })
      ) {
        return null;
      }
      return event;
    },
  });

  // Bridge core's log.* calls → Sentry structured logs + error capture.
  // Error-level logs are filtered against the same TRANSIENT_ERROR_PATTERNS
  // used by beforeSend — structured logs bypass beforeSend entirely, so
  // without this gate transient worker errors flood the Sentry Logs product.
  log.registerSink({
    info: (message, attrs) => Sentry.logger.info(message, attrs),
    warn: (message, attrs) => Sentry.logger.warn(message, attrs),
    error: (message, attrs) => {
      if (!TRANSIENT_ERROR_PATTERNS.some((re) => re.test(message))) {
        Sentry.logger.error(message, attrs);
      }
    },
    captureException: (err) => Sentry.captureException(err),
  });
}
