import type { Plugin, Hooks } from "@opencode-ai/plugin";
import {
  log,
  getGitRemote,
  discoverWorkspaceRoot,
  installFetchInterceptor,
} from "@loreai/core";
// Helpers live in a separate module so they are NOT re-exported from this
// plugin entry. OpenCode's legacy plugin loader invokes every function
// exported from the entry module as a plugin; leaking these helpers pushed
// `undefined` into the host hooks array and crashed it on event dispatch
// (`undefined is not an object (evaluating 'A.event')`). See ./internal.ts.
import { applyLoreProviderConfig, probeGateway } from "./internal";

/**
 * Lore plugin for OpenCode — transparent LLM proxy routing.
 *
 * Instead of overwriting provider baseURLs (which loses original auth and
 * URL context), this plugin installs a fetch-level interceptor that
 * transparently reroutes outgoing LLM API calls through the Lore gateway.
 * The SDK builds requests normally (correct auth, correct URL for each
 * provider), and the interceptor redirects them while preserving all
 * original headers. The gateway forwards non-managed headers upstream.
 *
 * Per-request context (session ID, agent name, provider ID) is injected
 * via the `chat.headers` hook.
 */

/** Default ports to probe when looking for a running gateway (must match gateway defaults). */
const KNOWN_GATEWAY_PORTS = [3207, 5673];

/**
 * Resolve the gateway URL by probing known ports and reading the port file.
 *
 * Order: LORE_GATEWAY_URL env var → port file → known default ports (3207, 5673).
 * Returns the URL of a running gateway, or null if none found.
 */
async function resolveGatewayUrl(): Promise<string | null> {
  // 0. Remote gateway — skip local discovery/startup entirely.
  if (process.env.LORE_REMOTE_URL) {
    const url = process.env.LORE_REMOTE_URL.replace(/\/$/, "");
    if (await probeGateway(url)) return url;
    log.info(
      `remote gateway at ${url} not reachable, falling through to local discovery`,
    );
  }

  // 1. Explicit env var — probe it to verify it's actually reachable.
  if (process.env.LORE_GATEWAY_URL) {
    const url = process.env.LORE_GATEWAY_URL.replace(/\/$/, "");
    if (await probeGateway(url)) return url;
    // env var set but gateway unreachable — fall through to discovery
  }

  // 2. Build probe list: port file first (handles random port), then known defaults.
  const probePorts = new Set<number>();
  try {
    const gw = "@loreai/gateway";
    const { readPortFile } = await import(/* webpackIgnore: true */ gw);
    const portfilePort = readPortFile();
    if (portfilePort) probePorts.add(portfilePort);
  } catch {
    /* gateway package not available — skip port file */
  }
  for (const p of KNOWN_GATEWAY_PORTS) probePorts.add(p);

  // 3. Probe each port.
  for (const port of probePorts) {
    const url = `http://127.0.0.1:${port}`;
    if (await probeGateway(url)) return url;
  }

  return null;
}

/**
 * Start the gateway server in-process by importing @loreai/gateway as a library.
 *
 * Uses startGateway() which handles the full port fallback chain
 * (3207 → 5673 → random) and port file management automatically.
 * Returns the URL of the started gateway, or null on failure.
 */
async function startInProcess(): Promise<string | null> {
  try {
    // Dynamic import — the gateway may be resolved from src (workspace) or
    // dist/index.cjs (npm). Use a variable to prevent tsc from resolving the
    // module at compile time (the .d.cts only exists after building).
    const gw = "@loreai/gateway";
    const { startGateway } = await import(/* webpackIgnore: true */ gw);
    const handle = await startGateway({ quiet: true, local: true });
    const url = `http://127.0.0.1:${handle.port}`;

    if (!handle.owned) {
      log.info(`reusing existing gateway at ${url}`);
    }

    return url;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    lastGatewayStartError = msg;
    log.info("failed to start gateway in-process:", msg);
    return null;
  }
}

// Captures the underlying reason the in-process gateway failed to start so
// the user-facing error can include the real cause (port conflict, DB lock,
// stale build, etc.) instead of just "Ensure @loreai/gateway is installed."
let lastGatewayStartError: string | null = null;

// Process-wide initialization state — shared across all sessions.
// The plugin function is called once per OpenCode session/project, but
// lore init only needs to run once per process.
let processInitDone = false;
let processLoreActive = false;
let processLoreBase = "";

// Per-project state. The OpenCode plugin function can be called multiple
// times in the same process (different projects, or after a project switch),
// so we track each project's path + git remote in a Map keyed by
// `ctx.project.id`. This prevents the "last project wins" race where a
// request from project A gets attributed to project B's path because a
// sub-agent or new project init overwrote the global between turns.
//
// `currentProject` is a fallback for the fetch interceptor's `getHeaders()`
// callback, which doesn't have access to the request's session ID and so
// can't pick the right Map entry. The chat.headers hook is preferred (it sets
// the header directly per-request using the right Map entry) — `getHeaders()`
// only fires when a request bypasses the chat.headers hook.
//
// The path and git remote are stored TOGETHER as a single object so the
// fallback pair is always self-consistent: a path is never emitted with a
// remote that was resolved for a DIFFERENT project on an earlier plugin call.
// (Pairing a path with a foreign remote is how a non-repo dir acquired
// another repo's remote and became a "git-remote magnet".)
let currentProject: { path: string; gitRemote: string } | undefined;

/** project.id → { projectPath, gitRemote, lastSeenAt } */
const projectState = new Map<
  string,
  { projectPath: string; gitRemote: string; lastSeenAt: number }
>();

/** Stale-entry threshold: 24 hours. Generous to avoid re-running
 * `getGitRemote()` when a user resumes after sleep/long break.
 * Each entry is ~200 bytes — even 100 projects would be 20 KB. */
const SESSION_STATE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Drop project entries that haven't been seen in SESSION_STATE_TTL_MS to
 * prevent unbounded growth in long-lived processes. Called opportunistically
 * whenever a new entry is registered.
 */
function reapStaleProjectState(): void {
  const cutoff = Date.now() - SESSION_STATE_TTL_MS;
  for (const [id, entry] of projectState) {
    if (entry.lastSeenAt < cutoff) projectState.delete(id);
  }
}

/** Memoized lore init promise — ensures concurrent plugin calls don't race. */
let loreInitPromise: Promise<string | null> | null = null;

/**
 * Whether the plugin should stay inert (skip gateway probe/start and the
 * process-wide fetch interceptor). True under test runners — `NODE_ENV=test`
 * or a `.test.` argv entry — so unrelated package suites don't accidentally
 * spin up a gateway or patch `globalThis.fetch`.
 *
 * Tests that need the active discovery → interceptor → routing path set
 * `LORE_OPENCODE_FORCE_ACTIVE=1` and point the plugin at a controlled
 * in-process gateway via `LORE_GATEWAY_URL`. The force flag keeps
 * `NODE_ENV=test` (so `log` stays file-suppressed and the DB isolated) while
 * exercising the real wiring. Mirrors the Pi extension's `LORE_PI_FORCE_ACTIVE`.
 */
function isInertTestEnv(): boolean {
  if (process.env.LORE_OPENCODE_FORCE_ACTIVE === "1") return false;
  return (
    process.env.NODE_ENV === "test" ||
    process.argv.some((a) => a.includes(".test."))
  );
}

export const LorePlugin: Plugin = async (ctx) => {
  // Initialize lore — only probe/start once per process.
  const loreDisabled =
    process.env.LORE_DISABLED === "1" || process.env.LORE_DISABLED === "true";
  let loreActive = processLoreActive;
  let gatewayBase = processLoreBase;
  if (!processInitDone) {
    const inTestEnv = isInertTestEnv();

    if (!loreDisabled && !inTestEnv) {
      // Memoize so concurrent LorePlugin calls don't race on probe→spawn.
      if (!loreInitPromise) {
        loreInitPromise = (async () => {
          // Try to find a running gateway first (probes port file + known ports).
          const existingUrl = await resolveGatewayUrl();
          if (existingUrl) {
            log.info(`gateway detected at ${existingUrl}`);
            return existingUrl;
          }
          // No running gateway — start one in-process (handles fallback chain).
          log.info("starting gateway in-process…");
          const startedUrl = await startInProcess();
          if (startedUrl) {
            log.info(`gateway started in-process at ${startedUrl}`);
            return startedUrl;
          }
          return null;
        })();
      }
      const result = await loreInitPromise;
      if (result) {
        loreActive = true;
        gatewayBase = result;
      }
    }
    processLoreActive = loreActive;
    processLoreBase = gatewayBase;
  }

  if (!loreActive && !loreDisabled) {
    const inTestEnv = isInertTestEnv();
    if (!inTestEnv) {
      const base = "Lore failed to start — memory features are unavailable.";
      const msg = lastGatewayStartError
        ? `${base} Gateway error: ${lastGatewayStartError}` +
          (/not found|not exported|cannot find module/i.test(
            lastGatewayStartError,
          )
            ? " — this looks like a stale build; rebuild with" +
              " `pnpm --filter @loreai/gateway run bundle`" +
              " (or `run build` for a dev checkout)."
            : "")
        : `${base} Ensure @loreai/gateway is installed.`;
      process.stderr.write(`[lore] ERROR: ${msg}\n`);
      log.error(msg);
    }
  }

  // Compute and register THIS project's state. The Map is keyed by
  // `ctx.project.id` so concurrent projects in the same process (e.g.,
  // worktrees opened in parallel) don't clobber each other.
  const thisProjectPath = discoverWorkspaceRoot(ctx.worktree || ctx.directory);

  // Resolve git remote per-project. Re-use the cached value when the same
  // project is seen again (avoids spawning `git remote -v` every turn).
  const existingState = projectState.get(ctx.project.id);
  const thisGitRemote =
    existingState?.projectPath === thisProjectPath
      ? existingState.gitRemote
      : (getGitRemote(thisProjectPath) ?? "");

  projectState.set(ctx.project.id, {
    projectPath: thisProjectPath,
    gitRemote: thisGitRemote,
    lastSeenAt: Date.now(),
  });
  reapStaleProjectState();

  // Module-level fallback (used only when chat.headers is bypassed).
  // Updated on every plugin call so the most-recently-active project wins
  // for fetches that arrive without a known session ID (e.g., direct
  // SDK fetches that skip the plugin's chat.headers hook).
  currentProject = { path: thisProjectPath, gitRemote: thisGitRemote };

  try {
    const hooks: Hooks = {
      // Disable built-in compaction (gateway handles it), register hidden
      // worker agents, and redirect all provider baseURLs through the gateway.
      config: async (input) => {
        const cfg = input as Record<string, unknown>;
        cfg.compaction = { auto: false, prune: false };
        // `mode: "subagent"` is REQUIRED for `hidden` to take effect: OpenCode
        // defaults agents to `mode: "all"` (visible in BOTH the primary Tab
        // picker and the @-mention/skill list) and only honors `hidden: true`
        // for subagent-mode agents. Without it these internal workers leak into
        // every host project's agent/skill picker.
        cfg.agent = {
          ...(cfg.agent as Record<string, unknown> | undefined),
          "lore-distill": {
            mode: "subagent",
            hidden: true,
            description: "Lore memory distillation worker",
          },
          "lore-curator": {
            mode: "subagent",
            hidden: true,
            description: "Lore knowledge curator worker",
          },
          "lore-query-expand": {
            mode: "subagent",
            hidden: true,
            description: "Lore query expansion worker",
          },
        };
        // Pin the Anthropic provider's baseURL to the gateway. See
        // applyLoreProviderConfig in ./internal.ts for the full rationale.
        applyLoreProviderConfig(cfg, gatewayBase);
      },

      tool: {},

      // Inject per-request identifiers so the gateway can distinguish meta
      // requests (title generation, summary agents, etc.) from real
      // conversation turns and route by provider.
      // Project path, git remote, and upstream URL are injected by the
      // fetch interceptor (installed once per process).
      "chat.headers": async (input, output) => {
        // Inject stable session ID — OpenCode's DB session ID survives restarts,
        // unlike x-session-affinity (nanoid regenerated per process).
        output.headers["x-lore-session-id"] = input.sessionID;
        output.headers["x-lore-agent"] = input.agent;
        // Inject project path + git remote for THIS request based on the
        // current plugin's project. Setting it here (rather than relying on
        // the fetch interceptor's getHeaders() global) ensures that
        // concurrent sub-agents or sibling projects in the same OpenCode
        // process don't have their paths clobbered. The fetch interceptor
        // still sets a fallback via getHeaders() for requests that bypass
        // this hook (e.g., embedding/image generation).
        if (thisProjectPath) {
          output.headers["x-lore-project"] = thisProjectPath;
        }
        if (thisGitRemote) {
          output.headers["x-lore-git-remote"] = thisGitRemote;
        }
        // Inject provider ID so the gateway uses provider-based routing
        // (correct protocol + upstream URL) instead of model-prefix guessing.
        // OpenCode's plugin SDK types don't expose `.id` on the provider
        // object, but it IS present at runtime. Cast around incomplete typedef.
        const providerID = (
          input.provider as Record<string, unknown> | undefined
        )?.id as string | undefined;
        if (providerID) {
          output.headers["x-lore-provider"] = providerID;
        }
        // For local/self-hosted providers (vllm, ollama, llamacpp, etc.),
        // forward LORE_UPSTREAM_<PROVIDER> as the x-lore-upstream-url header
        // so the gateway can route the request to the user's local server.
        // Convention matches the Pi plugin's registerProviders() block.
        if (providerID) {
          const envKey = `LORE_UPSTREAM_${providerID.toUpperCase().replace(/-/g, "_")}`;
          const upstream = process.env[envKey];
          if (upstream && !output.headers["x-lore-upstream-url"]) {
            output.headers["x-lore-upstream-url"] = upstream;
          }
        }
        // Forward LORE_UPSTREAM_EXTRA_HEADERS values as literal headers so
        // corporate proxies / LiteLLM / Cloudflare AI Gateway get the
        // required auth/team-routing tokens on every call. The gateway
        // applies the same env var on its side as a safety net (so the
        // headers are present even when the plugin is bypassed).
        const extrasRaw = process.env.LORE_UPSTREAM_EXTRA_HEADERS;
        if (extrasRaw) {
          for (const rawLine of extrasRaw.split(/\r?\n/)) {
            const line = rawLine.trim();
            if (!line) continue;
            const colonIdx = line.indexOf(":");
            if (colonIdx <= 0) continue;
            const name = line.slice(0, colonIdx).trim();
            const value = line.slice(colonIdx + 1).trim();
            if (name) {
              // Don't clobber headers the gateway already manages.
              const lower = name.toLowerCase();
              if (
                !lower.startsWith("x-lore-") &&
                lower !== "x-api-key" &&
                lower !== "authorization"
              ) {
                output.headers[name] = value;
              }
            }
          }
        }
      },
    };

    // Startup banner — visible in stderr so silent failures are obvious.
    // Suppressed in test env to keep vitest output clean.
    if (!processInitDone) {
      const projectPath = discoverWorkspaceRoot(ctx.worktree || ctx.directory);
      if (process.env.NODE_ENV !== "test") {
        process.stderr.write(`[lore] active: ${projectPath}\n`);
      }

      if (loreActive) {
        // Install the fetch interceptor once per process. It transparently
        // reroutes outgoing LLM API calls through the gateway while
        // preserving original auth headers and URLs.
        installFetchInterceptor({
          gatewayBase,
          getHeaders: () => {
            const headers: Record<string, string> = {};
            const cur = currentProject;
            if (cur?.path) {
              headers["x-lore-project"] = cur.path;
              // Only emit the remote paired with the path it was resolved FOR,
              // never a remote left over from a different project's plugin call.
              if (cur.gitRemote) headers["x-lore-git-remote"] = cur.gitRemote;
            }
            return headers;
          },
        });
        // Suppressed in test env (mirrors the `[lore] active:` banner above)
        // so the force-active e2e path doesn't pollute vitest output.
        if (process.env.NODE_ENV !== "test") {
          process.stderr.write(`[lore] routing through ${gatewayBase}\n`);
          process.stderr.write(`[lore] dashboard: ${gatewayBase}/ui\n`);
        }
      }

      processInitDone = true;
    }

    return hooks;
  } catch (e) {
    // Log the full error before re-throwing so OpenCode's plugin loader
    // (which catches and swallows the error) doesn't hide the root cause.
    const detail = e instanceof Error ? e.stack || e.message : String(e);
    process.stderr.write(`[lore] init failed: ${detail}\n`);
    throw e;
  }
};

// WARNING: do NOT add any other export to this module. OpenCode's legacy
// plugin loader invokes every FUNCTION export as a plugin (pushing its return
// value into the host hooks array) and THROWS on any non-function export,
// dropping the plugin entirely. Keep helpers in ./internal.ts. This module
// must export only LorePlugin + this same-reference default. Guarded by the
// "plugin entry module export shape" test in test/index.test.ts.
export default LorePlugin;
