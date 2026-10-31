/**
 * @loreai/pi — Lore memory engine as a Pi coding-agent extension.
 *
 * On startup, the extension probes for an existing Lore gateway server
 * and, if none is found, starts one in-process by importing
 * @loreai/gateway. It installs a fetch-level interceptor that
 * transparently reroutes LLM API calls through the gateway (preserving
 * original auth headers and URLs), registers known providers with Pi,
 * and adds a Pi-specific compaction hook (session_before_compact).
 * Recall is registered through Pi's native tool API using the shared core
 * contract; routed recall execution, LTM injection, gradient transforms,
 * temporal capture, and idle work remain owned by the gateway pipeline.
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
import {
  getGitRemote,
  discoverWorkspaceRoot,
  installFetchInterceptor,
  createGatewayRecallClient,
  NATIVE_RECALL_TURN_HEADER,
  type RecallToolContext,
  log,
} from "@loreai/core";
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
  shouldRegisterNativeRecallTool,
  startInProcess,
} from "./internal";
import { createPiRecallTool } from "./recall-tool";
import { recallOriginKey } from "./recall-origin";
import {
  piTurnGroup,
  singlePendingPiTurn,
  singlePiRequestOwner,
  trackPiRequestOwner,
  piRequestGateway,
  piGatewayRecallClient,
  observePiRequestHeaders,
  startPiOwner,
  startPiTurn,
  bindPiOrigin,
  endPiOwner,
  retirePiOwner,
} from "./recall-turns";
import { randomUUID } from "node:crypto";

/** Guard against double-installing the fetch interceptor if Pi re-initializes. */
let fetchInterceptorInstalled = false;
// The single fetch observer outlives an extension factory invocation. Reuse its
// client when Pi reloads the extension, without sharing auth across gateways.
const nativeRecallClients = new Map<
  string,
  ReturnType<typeof createGatewayRecallClient>
>();

/**
 * Pi extension entry point.
 *
 * Pi calls this function when loading the extension — either via `pi -e`
 * or after `pi install`. Detects the Lore gateway and, if available,
 * redirects provider URLs and registers compaction override.
 */
export default async function lorePiExtension(pi: ExtensionAPI): Promise<void> {
  const factoryEnv = { ...process.env };
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

  let projectPath = discoverWorkspaceRoot(process.cwd());
  let currentSessionID = sessionIDFor(undefined);
  // The harness's own session name (user-set via /name) — forwarded as
  // x-lore-session-title so the gateway can persist it (#1921).
  let currentSessionTitle = "";
  let compactAuthHeaders: Record<string, string> = {};
  let currentTurn: RecallToolContext | undefined;
  // null means overlapping requests cannot yet be assigned to an assistant.
  // A later message must never be attributed to whichever turn started last.
  let pendingAssistantTurn: RecallToolContext | null | undefined;
  const turnOwnerID = randomUUID();
  let retired = false;
  let removeAbortListener: (() => void) | undefined;
  const retireCurrentOwnership = () => {
    removeAbortListener?.();
    removeAbortListener = undefined;
    retirePiOwner(gatewayBase, turnOwnerID);
    currentTurn = undefined;
    pendingAssistantTurn = undefined;
  };
  const nativeRecallClient =
    nativeRecallClients.get(gatewayBase) ??
    piGatewayRecallClient(gatewayBase) ??
    createGatewayRecallClient(gatewayBase);
  nativeRecallClients.set(gatewayBase, nativeRecallClient);
  if (nativeRecallClients.size > 4) {
    const oldest = nativeRecallClients.keys().next().value;
    if (oldest !== undefined) nativeRecallClients.delete(oldest);
  }

  if (shouldRegisterNativeRecallTool(gatewayBase)) {
    pi.registerTool(
      createPiRecallTool(
        () => ({
          projectPath,
          sessionID: currentSessionID,
        }),
        nativeRecallClient.execute,
        (origin, context) => {
          if (retired) return undefined;
          const turn = piTurnGroup(
            gatewayBase,
            discoverWorkspaceRoot(context.cwd),
            sessionIDFor(context.sessionManager.getSessionFile()),
          )?.origins.get(recallOriginKey(origin));
          if (
            !turn ||
            turn.sessionID !==
              sessionIDFor(context.sessionManager.getSessionFile()) ||
            turn.projectPath !== discoverWorkspaceRoot(context.cwd)
          )
            return undefined;
          return turn;
        },
      ),
    );
  }

  let cachedGitRemote = getGitRemote(projectPath) ?? "";
  const requestMetadata = () => ({
    projectPath,
    sessionID: currentSessionID,
    gitRemote: cachedGitRemote,
    sessionTitle: currentSessionTitle,
    recallClient: nativeRecallClient,
    observeHeaders: (headers: Headers) => {
      const apiKey = headers.get("x-api-key");
      const googleApiKey = headers.get("x-goog-api-key");
      const authorization = headers.get("authorization");
      compactAuthHeaders = apiKey
        ? { "x-api-key": apiKey }
        : googleApiKey
          ? { "x-goog-api-key": googleApiKey }
          : authorization
            ? { authorization }
            : {};
    },
  });
  const requestOwner = trackPiRequestOwner(
    gatewayBase,
    turnOwnerID,
    requestMetadata(),
  );

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
      resolveGateway: piRequestGateway,
      getHeaders: (requestHeaders, selectedGateway = gatewayBase) => {
        const owner = singlePiRequestOwner(selectedGateway, requestHeaders);
        if (!owner) return {};
        const metadata = owner.metadata;
        const scope = new Headers({
          "x-lore-project": metadata.projectPath,
          "x-lore-session-id": metadata.sessionID,
        });
        const turn = singlePendingPiTurn(selectedGateway, scope, owner.ownerID);
        const headers: Record<string, string> = {
          "x-lore-session-id": metadata.sessionID,
          "x-lore-project": metadata.projectPath,
          ...(turn?.turnID ? { [NATIVE_RECALL_TURN_HEADER]: turn.turnID } : {}),
        };
        if (metadata.gitRemote)
          headers["x-lore-git-remote"] = metadata.gitRemote;
        if (metadata.sessionTitle)
          headers["x-lore-session-title"] = encodeURIComponent(
            metadata.sessionTitle,
          );
        return headers;
      },
      onRequestHeaders: (headers, selectedGateway = gatewayBase) => {
        (
          piGatewayRecallClient(selectedGateway) ??
          nativeRecallClients.get(selectedGateway)
        )?.observeRequestHeaders(headers);
        observePiRequestHeaders(selectedGateway, headers);
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
      env: factoryEnv,
    });
    for (const { provider, baseUrl, headers } of registrations) {
      if (currentTurn?.turnID)
        headers[NATIVE_RECALL_TURN_HEADER] = currentTurn.turnID;
      pi.registerProvider(provider, { baseUrl, headers });
    }
  }

  // Initial registration with ephemeral session ID.
  registerProviders();

  pi.on("session_start", async (_event: SessionStartEvent, ctx) => {
    if (retired) return;
    currentSessionTitle = ctx.sessionManager.getSessionName?.()?.trim() ?? "";
    const nextProjectPath = discoverWorkspaceRoot(ctx.cwd);
    const newID = sessionIDFor(ctx.sessionManager.getSessionFile());
    if (newID !== currentSessionID || nextProjectPath !== projectPath) {
      retireCurrentOwnership();
      currentSessionID = newID;
      projectPath = nextProjectPath;
      cachedGitRemote = getGitRemote(projectPath) ?? "";
      compactAuthHeaders = {};
      currentTurn = undefined;
      // Re-register with the real session ID so all subsequent provider
      // requests carry the correct x-lore-session-id header.
      registerProviders();
    }
    requestOwner.update(requestMetadata());
  });

  pi.on("agent_start", (_event, context) => {
    if (retired) return;
    const group = piTurnGroup(
      gatewayBase,
      discoverWorkspaceRoot(context.cwd),
      sessionIDFor(context.sessionManager.getSessionFile()),
      true,
    );
    if (group) startPiOwner(group, turnOwnerID);
    removeAbortListener?.();
    const signal = context.signal;
    if (signal?.aborted) retireCurrentOwnership();
    else if (signal) {
      const onAbort = () => retireCurrentOwnership();
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    }
  });
  pi.on("turn_start", (_event, context) => {
    if (retired || context.signal?.aborted) return;
    currentSessionID = sessionIDFor(context.sessionManager.getSessionFile());
    const nextProjectPath = discoverWorkspaceRoot(context.cwd);
    if (projectPath !== nextProjectPath) {
      projectPath = nextProjectPath;
      cachedGitRemote = getGitRemote(projectPath) ?? "";
    }
    requestOwner.update(requestMetadata());
    currentTurn = {
      projectPath,
      sessionID: currentSessionID,
      turnID: randomUUID(),
    };
    const group = piTurnGroup(gatewayBase, projectPath, currentSessionID, true);
    const tracked = group && startPiTurn(group, turnOwnerID, currentTurn);
    pendingAssistantTurn =
      !group || !tracked || group.ambiguous ? null : currentTurn;
    registerProviders();
  });

  pi.on("message_start", (event, context) => {
    if (
      event.message.role !== "assistant" ||
      retired ||
      !pendingAssistantTurn ||
      pendingAssistantTurn.sessionID !==
        sessionIDFor(context.sessionManager.getSessionFile()) ||
      pendingAssistantTurn.projectPath !== discoverWorkspaceRoot(context.cwd)
    )
      return;
    const message = event.message;
    const group = piTurnGroup(
      gatewayBase,
      pendingAssistantTurn.projectPath,
      pendingAssistantTurn.sessionID,
    );
    if (
      !group ||
      group.ambiguous ||
      group.pending.size !== 1 ||
      !group.pending.has(pendingAssistantTurn.turnID!)
    )
      return;
    const key = recallOriginKey({
      timestamp: message.timestamp,
      providerID: message.provider,
      modelID: message.model,
    });
    const previous = group.origins.get(key);
    if (
      previous === undefined ||
      previous?.turnID === pendingAssistantTurn.turnID
    )
      bindPiOrigin(group, turnOwnerID, key, pendingAssistantTurn);
    else group.origins.set(key, null);
    pendingAssistantTurn = undefined;
  });
  pi.on("agent_end", (_event, context) => {
    if (retired) return;
    removeAbortListener?.();
    removeAbortListener = undefined;
    const group = piTurnGroup(
      gatewayBase,
      discoverWorkspaceRoot(context.cwd),
      sessionIDFor(context.sessionManager.getSessionFile()),
    );
    if (group) endPiOwner(group, turnOwnerID);
    pendingAssistantTurn = undefined;
  });
  pi.on("session_shutdown", () => {
    retired = true;
    requestOwner.retire();
    retireCurrentOwnership();
    compactAuthHeaders = {};
  });

  // Refresh the session title per turn so a /name issued mid-session is
  // picked up without waiting for the next session_start.
  pi.on("before_agent_start", async (_event, ctx) => {
    if (retired) return;
    currentSessionTitle = ctx.sessionManager.getSessionName?.()?.trim() ?? "";
    requestOwner.update(requestMetadata());
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
    ): Promise<SessionBeforeCompactResult | undefined> => {
      if (retired) return undefined;
      retireCurrentOwnership();
      return runCompaction({
        gatewayBase,
        sessionID: currentSessionID,
        projectPath,
        previousSummary: event.preparation.previousSummary,
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        authHeaders: { ...compactAuthHeaders },
      });
    },
  );
}

/** Named export for users who prefer `import { LorePiExtension }` style. */
export { lorePiExtension as LorePiExtension };
