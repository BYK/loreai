/**
 * @loreai/pi — Lore memory engine as a Pi coding-agent extension.
 *
 * On startup, the extension probes for an existing Lore gateway server
 * and, if none is found, starts one in-process by importing
 * @loreai/gateway. It installs a fetch-level interceptor that
 * transparently reroutes LLM API calls through the gateway (preserving
 * original auth headers and URLs), registers known providers with Pi,
 * and adds a Pi-specific compaction hook (session_before_compact).
 * All other memory features (LTM injection, gradient transforms,
 * temporal capture, recall, idle work) are handled by the gateway pipeline.
 *
 * If the gateway server cannot be reached, the extension logs an error
 * and becomes inert — no hooks are registered and Pi runs without
 * memory features.
 *
 * Routine status is logged through the core `log` module (file-based,
 * terminal-suppressed) — NEVER via console/stdout/stderr — because Pi
 * runs a full-screen TUI that any raw terminal write would corrupt.
 *
 * Installation (in user's `~/.pi/agent/extensions/`):
 *   import lore from "@loreai/pi";
 *   export default lore;
 *
 * Or as a Pi package:
 *   pi install npm:@loreai/pi
 *
 * Pure/testable logic (gateway discovery, provider-registration shaping,
 * session-id derivation, the compaction request) lives in `./internal.ts`.
 */
import { getGitRemote, installFetchInterceptor, log } from "@loreai/core";
import type {
  ExtensionAPI,
  SessionBeforeCompactEvent,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import {
  buildProviderRegistrations,
  resolveGatewayUrl,
  runCompaction,
  type SessionBeforeCompactResult,
  sessionIDFor,
  startInProcess,
} from "./internal";

/** Guard against double-installing the fetch interceptor if Pi re-initializes. */
let fetchInterceptorInstalled = false;

/**
 * Pi extension entry point.
 *
 * Pi calls this function when loading the extension — either via `pi -e`
 * or after `pi install`. Detects the Lore gateway and, if available,
 * redirects provider URLs and registers compaction override.
 */
export default async function lorePiExtension(pi: ExtensionAPI): Promise<void> {
  let gatewayBase = "";
  let loreActive = false;
  const loreDisabled =
    process.env.LORE_DISABLED === "1" || process.env.LORE_DISABLED === "true";
  // The extension is inert under `NODE_ENV=test` so unrelated package test
  // suites don't accidentally probe/start a gateway. Tests that need the
  // extension active set `LORE_PI_FORCE_ACTIVE=1` and point it at a controlled
  // in-process gateway via `LORE_GATEWAY_URL`. This keeps `NODE_ENV=test` (so
  // `log` stays file-suppressed and the DB stays isolated) while exercising the
  // real wiring.
  const inTestEnv =
    process.env.NODE_ENV === "test" && process.env.LORE_PI_FORCE_ACTIVE !== "1";

  // We're being loaded by a real Pi process, which owns a full-screen TUI: any
  // byte on stdout/stderr corrupts the render. Flip the core logger's
  // process-global silence flag — which the in-process gateway's own (bundled)
  // copy of `core` reads off `globalThis` too — so NOTHING (not even
  // `log.error` or gateway warnings) can reach the terminal. Everything still
  // lands in the log file and Sentry sink; read it with `lore logs`. Skipped
  // under inert test mode so unrelated suites in the same worker keep their
  // console.
  if (!inTestEnv) log.silenceStderr();

  if (!loreDisabled && !inTestEnv) {
    // Try to find a running gateway first (probes port file + known ports).
    const existingUrl = await resolveGatewayUrl();
    if (existingUrl) {
      log.info(`pi: gateway detected at ${existingUrl}`);
      gatewayBase = existingUrl;
      loreActive = true;
    } else {
      // No running gateway — start one in-process (handles fallback chain).
      log.info("pi: starting gateway in-process…");
      const startedUrl = await startInProcess();
      if (startedUrl) {
        log.info(`pi: gateway started in-process at ${startedUrl}`);
        gatewayBase = startedUrl;
        loreActive = true;
      }
    }
  }

  if (!loreActive && !inTestEnv && !loreDisabled) {
    const msg =
      "Lore failed to start — memory features are unavailable. " +
      "Ensure @loreai/gateway is installed.";
    log.error("pi:", msg);
    return;
  }

  if (!loreActive) return;

  log.info(`pi: routing providers through ${gatewayBase}`);

  // ---------------------------------------------------------------------------
  // Session tracking — used for provider header injection and compaction.
  // ---------------------------------------------------------------------------

  let projectPath = process.cwd();
  let currentSessionID = sessionIDFor(undefined);

  // Cache git remote once at init — avoid spawning `git remote -v` on every
  // intercepted fetch call.
  const cachedGitRemote = getGitRemote(projectPath) ?? "";

  // Install fetch-level interceptor — transparently reroutes LLM API calls
  // through the gateway while preserving original auth headers and URLs.
  // This complements registerProviders() which tells Pi about available
  // providers but overrides their baseUrl to the gateway. The interceptor
  // catches any providers Pi discovers on its own (not in our list) and
  // ensures X-Lore-Upstream-URL is always set from the original URL.
  // Guard: only install once per process to avoid stacking interceptors
  // if Pi re-initializes.
  if (!fetchInterceptorInstalled) {
    installFetchInterceptor({
      gatewayBase,
      getHeaders: () => {
        const headers: Record<string, string> = {
          "x-lore-session-id": currentSessionID,
          "x-lore-project": projectPath,
        };
        if (cachedGitRemote) headers["x-lore-git-remote"] = cachedGitRemote;
        return headers;
      },
    });
    fetchInterceptorInstalled = true;
  }

  /**
   * Register (or re-register) all gateway-compatible providers with the
   * current session header. Called on startup and again on session_start
   * once the real session ID is known.
   */
  function registerProviders(): void {
    const registrations = buildProviderRegistrations({
      gatewayBase,
      sessionID: currentSessionID,
      projectPath,
      // Resolve the git remote for the CURRENT project path so worktrees that
      // switch on session_start get the right remote.
      gitRemote: getGitRemote(projectPath) ?? undefined,
    });
    for (const { provider, baseUrl, headers } of registrations) {
      pi.registerProvider(provider, { baseUrl, headers });
    }
  }

  // Initial registration with ephemeral session ID.
  registerProviders();

  pi.on("session_start", async (_event: SessionStartEvent, ctx) => {
    projectPath = ctx.cwd;
    const newID = sessionIDFor(ctx.sessionManager.getSessionFile());
    if (newID !== currentSessionID) {
      currentSessionID = newID;
      // Re-register with the real session ID so all subsequent provider
      // requests carry the correct x-lore-session-id header.
      registerProviders();
    }
  });

  // ---------------------------------------------------------------------------
  // Compaction override — session_before_compact
  //
  // Pi's compaction goes through its extension API, not HTTP. The gateway
  // intercepts compaction via HTTP request patterns (Claude Code-specific),
  // which don't match Pi's internal compaction flow. This hook calls the
  // gateway's POST /v1/compact endpoint to get a full LLM-synthesized
  // compaction summary (force-distill + knowledge + compact prompt).
  // ---------------------------------------------------------------------------

  pi.on(
    "session_before_compact",
    async (
      event: SessionBeforeCompactEvent,
      _ctx,
    ): Promise<SessionBeforeCompactResult | undefined> =>
      runCompaction({
        gatewayBase,
        sessionID: currentSessionID,
        projectPath,
        previousSummary: event.preparation.previousSummary,
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
      }),
  );
}

/** Named export for users who prefer `import { LorePiExtension }` style. */
export { lorePiExtension as LorePiExtension };
