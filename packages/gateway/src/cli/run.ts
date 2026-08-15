/**
 * `lore run [command...]` — start gateway + launch an AI agent.
 *
 * If a command is given, launches it with gateway env vars injected.
 * If no command is given, auto-detects installed agents and either
 * uses the sole one found or prompts the user to pick.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { startGateway, probeGateway, type StartOptions } from "./start";
import { bracketHost } from "../server";
import { loadConfig } from "../config";
import {
  detectAgents,
  AGENTS,
  appendCustomHeader,
  captureUserUpstream,
  type AgentDef,
  type DetectedAgent,
} from "./agents";
import { providerForUpstreamOrigin } from "../config";
import { safeExit, forcedExit } from "./exit";
import {
  installSignalShutdown,
  installChildSignalForwarding,
  runShutdownWithDeadline,
  signalExitCode,
} from "./shutdown";
import { maybeAutoImport } from "./import-auto";
import { discoverWorkspaceRoot, log } from "@loreai/core";

// ---------------------------------------------------------------------------
// Interactive agent picker (TTY only)
// ---------------------------------------------------------------------------

async function promptAgent(agents: DetectedAgent[]): Promise<DetectedAgent> {
  console.log("\n[lore] Multiple AI agents detected. Which one to launch?\n");
  for (let i = 0; i < agents.length; i++) {
    console.log(`  ${i + 1}) ${agents[i].def.displayName} (${agents[i].path})`);
  }
  console.log();

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  return new Promise<DetectedAgent>((resolve) => {
    const ask = () => {
      rl.question("Launch which agent? [1]: ", (answer) => {
        const trimmed = answer.trim();
        const idx = trimmed === "" ? 0 : Number.parseInt(trimmed, 10) - 1;
        if (Number.isInteger(idx) && idx >= 0 && idx < agents.length) {
          rl.close();
          resolve(agents[idx]);
        } else {
          console.log(`  Invalid choice. Enter 1–${agents.length}.`);
          ask();
        }
      });
    };
    ask();
  });
}

// ---------------------------------------------------------------------------
// Resolve what to launch
// ---------------------------------------------------------------------------

interface LaunchTarget {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * A user-configured upstream adopted from the parent environment, plus the
 * gateway `LORE_UPSTREAM_<protocol>` var it maps to and the provider id (if the
 * host is a known one). See `applyUpstreamAdoption`.
 */
export interface AdoptedUpstream {
  url: string;
  /** Gateway env var to set so the in-process gateway defaults there. */
  gatewayEnvKey: string;
  /** Provider id if the host matches a known provider route, else undefined. */
  providerID: string | undefined;
  agentDisplayName: string;
}

/** Render an adopted base URL without exposing query-string credentials. */
export function formatUpstreamForLog(url: string): string {
  try {
    const parsed = new URL(url);
    const query = parsed.search ? "?<redacted>" : "";
    return `${parsed.origin}${parsed.pathname}${query}`;
  } catch {
    return "<invalid URL>";
  }
}

/**
 * Map an agent's wire protocol to the gateway env var that overrides the
 * default upstream for that protocol. Gemini has no such default knob.
 */
function gatewayUpstreamEnvKey(
  wireProtocol: NonNullable<AgentDef["wireProtocol"]>,
): string | undefined {
  switch (wireProtocol) {
    case "anthropic":
      return "LORE_UPSTREAM_ANTHROPIC";
    case "openai":
      return "LORE_UPSTREAM_OPENAI";
    case "gemini":
      return undefined;
  }
}

/**
 * Adopt the user's pre-existing upstream for `agent` (captured from the parent
 * env) so the gateway proxies THERE instead of the hardcoded default. Called
 * BEFORE `startGateway`/`loadConfig` so the gateway picks up the override.
 *
 * Two mechanisms, applied together where the agent supports them:
 *  1. Set the gateway's own `LORE_UPSTREAM_<protocol>` process env — the
 *     in-process gateway reads this at `loadConfig()`, so header-less agents
 *     with a configurable protocol default get routed to the user's host.
 *  2. Return an `AdoptedUpstream` so the per-agent launch env can ALSO inject
 *     `X-Lore-Upstream-URL` (+ `X-Lore-Provider` for known hosts) — this is
 *     what flips the wire protocol/auth-scheme for a known provider that
 *     differs from the ingress shape (e.g. Claude Code → OpenRouter, which is
 *     an OpenAI-protocol provider reached via an Anthropic-shape client).
 *
 * Returns null when the user hasn't overridden the agent's base URL. Throws
 * when an override exists but Lore has no safe routing mechanism for it.
 */
export function applyUpstreamAdoption(
  agent: AgentDef,
  gatewayUrl: string,
): AdoptedUpstream | null {
  const captured = captureUserUpstream(agent, gatewayUrl);
  if (!captured) return null;
  const gatewayEnvKey = gatewayUpstreamEnvKey(captured.wireProtocol);
  if (!gatewayEnvKey && captured.wireProtocol !== "anthropic") {
    throw new Error(
      `${agent.displayName} cannot safely route its configured upstream through Lore`,
    );
  }
  const providerID = providerForUpstreamOrigin(captured.url);
  // Set the gateway default upstream for this protocol, UNLESS the user has
  // explicitly set it already (their explicit LORE_UPSTREAM_* wins).
  if (gatewayEnvKey && !process.env[gatewayEnvKey]) {
    process.env[gatewayEnvKey] = captured.url;
  }
  // If the host maps to a known provider, also seed LORE_UPSTREAM_<PROVIDER>
  // so the injected X-Lore-Provider header resolves to the right URL even
  // when the provider route's static url is null (aggregators/self-hosted).
  if (providerID) {
    const provEnvKey = `LORE_UPSTREAM_${providerID.toUpperCase().replace(/-/g, "_")}`;
    if (!process.env[provEnvKey]) process.env[provEnvKey] = captured.url;
  }
  return {
    url: captured.url,
    gatewayEnvKey: gatewayEnvKey ?? "",
    providerID,
    agentDisplayName: agent.displayName,
  };
}

/**
 * Remote-mode adoption: the remote gateway owns its own config, so we do NOT
 * set any local `LORE_UPSTREAM_*` env. We only compute the `AdoptedUpstream`
 * so the launch env can inject `X-Lore-Upstream-URL`/`X-Lore-Provider`, which
 * the remote gateway honors per request. Returns null when nothing to adopt
 * and throws when the selected agent cannot transport those headers.
 */
export function adoptForRemote(
  agent: AgentDef,
  gatewayUrl: string,
): AdoptedUpstream | null {
  const captured = captureUserUpstream(agent, gatewayUrl);
  if (!captured) return null;
  if (captured.wireProtocol !== "anthropic") {
    throw new Error(
      `${agent.displayName} cannot safely route its configured upstream through a remote Lore gateway`,
    );
  }
  return {
    url: captured.url,
    gatewayEnvKey: "",
    providerID: providerForUpstreamOrigin(captured.url),
    agentDisplayName: agent.displayName,
  };
}

/**
 * Inject the adopted-upstream routing headers into an agent's launch env, for
 * agents that forward `ANTHROPIC_CUSTOM_HEADERS` to the gateway (Claude Code /
 * Pi). Sets `X-Lore-Upstream-URL` and, for a known host, `X-Lore-Provider`.
 *
 * Agents without a header-forwarding mechanism (Codex/Hermes/Copilot) get
 * routed only via the startup-time `LORE_UPSTREAM_<protocol>` gateway env set
 * in `applyUpstreamAdoption`; reusing a gateway is therefore rejected for
 * their adopted upstreams. Gemini has no equivalent default and fails closed.
 */
export function injectAdoptionHeaders(
  agent: AgentDef,
  env: Record<string, string>,
  adopted: AdoptedUpstream,
): void {
  // Only Anthropic-shape agents carry ANTHROPIC_CUSTOM_HEADERS to the gateway.
  if (agent.wireProtocol !== "anthropic") return;
  appendCustomHeader(
    env,
    "ANTHROPIC_CUSTOM_HEADERS",
    "X-Lore-Upstream-URL",
    adopted.url,
  );
  if (adopted.providerID) {
    appendCustomHeader(
      env,
      "ANTHROPIC_CUSTOM_HEADERS",
      "X-Lore-Provider",
      adopted.providerID,
    );
  }
}

/**
 * The agent that `lore run` will actually launch, resolved BEFORE the gateway
 * starts so we can adopt the user's upstream (which requires setting gateway
 * env before `loadConfig`). `command` is the binary/command to exec; `def` is
 * the matching registry entry (null for an explicit command with no known
 * agent — e.g. `lore run some-other-tool`).
 */
export interface AgentSelection {
  command: string;
  def: AgentDef | null;
}

/**
 * Resolve which agent will run, without needing the gateway URL. For an
 * explicit command, matches the binary to a known agent. For auto-detect,
 * uses the sole agent or prompts (TTY). Returns null when nothing runnable.
 *
 * Runs before `startGateway` so upstream adoption can set gateway env in time.
 */
export async function resolveAgentSelection(
  cmdArgs: string[],
): Promise<AgentSelection | null> {
  if (cmdArgs.length > 0) {
    const def = AGENTS.find((a) => a.binary === cmdArgs[0]) ?? null;
    return { command: cmdArgs[0], def };
  }

  const detected = detectAgents();
  if (detected.length === 0) {
    console.error("[lore] No known AI agents found on PATH.");
    console.error(
      "[lore] Install one of: Claude Code (claude), Codex (codex), Pi (pi), OpenCode (opencode), Hermes (hermes), GitHub Copilot CLI (copilot), Gemini CLI (gemini)",
    );
    console.error(`[lore] Or run with an explicit command: lore run <command>`);
    console.error(
      `[lore] Using a GUI/IDE agent (Claude Desktop, an IDE extension)? Run`,
    );
    console.error(
      `[lore]   \`lore setup <app>\` and keep a gateway up with \`lore start --bg\`.`,
    );
    return null;
  }

  let agent: DetectedAgent;
  if (detected.length === 1) {
    agent = detected[0];
    console.log(`[lore] Detected ${agent.def.displayName} at ${agent.path}`);
  } else if (process.stdin.isTTY) {
    agent = await promptAgent(detected);
  } else {
    console.error("[lore] Multiple agents detected but stdin is not a TTY.");
    console.error("[lore] Specify which agent to run: lore run <command>");
    for (const a of detected) {
      console.error(`  - ${a.def.displayName}: lore run ${a.def.binary}`);
    }
    return null;
  }
  return { command: agent.def.binary, def: agent.def };
}

export function resolveLaunchTarget(
  selection: AgentSelection,
  gatewayUrl: string,
  cmdArgs: string[],
  extraArgs: string[],
  adopted: AdoptedUpstream | null,
): LaunchTarget {
  // Resolve workspace root once — walks up from cwd looking for monorepo
  // markers (.lore.json with workspaces, .git, pnpm-workspace.yaml, etc.)
  const projectDir = discoverWorkspaceRoot(process.cwd());
  if (projectDir !== process.cwd()) {
    console.log(`[lore] Workspace root: ${projectDir}`);
  }

  // --- Explicit command given: inject all known env vars + matching CLI args ---
  if (cmdArgs.length > 0) {
    const env: Record<string, string> = {};
    const prependArgs: string[] = [];
    for (const agent of AGENTS) {
      // Env vars are safe to merge from all agents (unused vars are harmless).
      Object.assign(env, agent.envVars(gatewayUrl, projectDir));
      // CLI args are agent-specific (e.g. Codex's `-c` flag) — only inject
      // them for the agent that matches the explicit command to avoid passing
      // unrecognized flags to other agents.
      if (agent.cliArgs && agent.binary === cmdArgs[0]) {
        prependArgs.push(...agent.cliArgs(gatewayUrl, projectDir));
      }
    }
    if (selection.def && adopted) {
      injectAdoptionHeaders(selection.def, env, adopted);
    }
    return {
      command: cmdArgs[0],
      args: [...prependArgs, ...cmdArgs.slice(1), ...extraArgs],
      env,
    };
  }

  // --- Auto-detected agent: selection.def is guaranteed non-null here
  //     (the explicit-command branch above handles the def===null case). ---
  const def = selection.def;
  if (!def) {
    // Unreachable in practice, but keep the type sound without an assertion:
    // an explicit command with no matching agent takes the branch above.
    return {
      command: selection.command,
      args: [...extraArgs],
      env: {},
    };
  }
  const agentCliArgs = def.cliArgs?.(gatewayUrl, projectDir) ?? [];
  const env = def.envVars(gatewayUrl, projectDir);
  if (adopted) injectAdoptionHeaders(def, env, adopted);
  return {
    command: def.binary,
    args: [...agentCliArgs, ...extraArgs],
    env,
  };
}

// ---------------------------------------------------------------------------
// Child process management
// ---------------------------------------------------------------------------

function launchChild(target: LaunchTarget): ChildProcess {
  const env = { ...process.env, ...target.env };

  const child = spawn(target.command, target.args, {
    env,
    stdio: "inherit",
  });

  return child;
}

// ---------------------------------------------------------------------------
// Command entry point
// ---------------------------------------------------------------------------

export async function commandRun(
  opts: StartOptions,
  cmdArgs: string[],
  extraArgs: string[] = [],
): Promise<void> {
  // 1. Resolve which agent will run BEFORE starting the gateway, so we can
  //    adopt the user's pre-existing upstream (which requires setting gateway
  //    env before loadConfig/startGateway — the config is captured once at
  //    startup and reused per request).
  const selection = await resolveAgentSelection(cmdArgs);

  const config = loadConfig();
  let gatewayUrl: string;
  let owned: boolean;
  let shutdown: () => Promise<void>;
  // The config actually in effect for the running gateway. In local mode
  // startGateway() re-runs loadConfig() AFTER upstream adoption has set
  // LORE_UPSTREAM_*, so handle.config reflects the adopted upstream while the
  // `config` captured above is stale (pre-adoption). maybeAutoImport must use
  // the effective config or its worker calls route to the pre-adoption default
  // upstream (e.g. api.anthropic.com) and fail auth against the adopted key.
  let effectiveConfig = config;

  // 2. Adopt the user's existing upstream (local mode only — a remote gateway
  //    owns its own config; header injection below still routes it there).
  //    Done before startGateway so LORE_UPSTREAM_* is read by loadConfig.
  let adopted: AdoptedUpstream | null = null;
  const isLocal = !(opts.remoteUrl || config.remoteUrl);
  if (isLocal && selection?.def) {
    // Prospective local gateway URL for the self-pointing guard. The port may
    // shift on conflict, but the user's ANTHROPIC_BASE_URL points at their own
    // provider host, not loopback, so the guard just needs a loopback origin.
    const prospectiveUrl = `http://127.0.0.1:${config.port}`;
    try {
      adopted = applyUpstreamAdoption(selection.def, prospectiveUrl);
    } catch (err) {
      console.error(
        `[lore] ${err instanceof Error ? err.message : String(err)}.`,
      );
      console.error(
        "[lore] Remove the agent's custom base URL or configure Lore's upstream explicitly.",
      );
      return safeExit(1);
    }
    if (adopted) {
      console.log(
        `[lore] Adopting your ${adopted.agentDisplayName} upstream: ${formatUpstreamForLog(adopted.url)}` +
          (adopted.providerID ? ` (provider: ${adopted.providerID})` : ""),
      );
    }
  }

  if (opts.remoteUrl || config.remoteUrl) {
    // Remote mode: delegate to an existing remote gateway.
    // The local CLI still runs on the developer's machine, so it can
    // safely compute the git remote and inject it as a header.
    const remoteUrl = opts.remoteUrl || config.remoteUrl;
    if (!remoteUrl) {
      console.error("[lore] Remote gateway URL is not configured.");
      return safeExit(1);
    }
    const alive = await probeGateway(remoteUrl);
    if (!alive) {
      console.error(`[lore] Remote gateway at ${remoteUrl} is not reachable.`);
      console.error(
        `[lore] Check LORE_REMOTE_URL and ensure the gateway is running.`,
      );
      return safeExit(1);
    }
    gatewayUrl = remoteUrl;
    owned = false;
    shutdown = async () => {};
    console.log(`[lore] Using remote gateway at ${gatewayUrl}`);
    // In remote mode, adopt via header injection only (no local gateway env).
    if (selection?.def) {
      try {
        adopted = adoptForRemote(selection.def, gatewayUrl);
      } catch (err) {
        console.error(
          `[lore] ${err instanceof Error ? err.message : String(err)}.`,
        );
        console.error(
          "[lore] Remove the agent's custom base URL or configure the remote gateway's upstream.",
        );
        return safeExit(1);
      }
    }
  } else {
    // Local mode: start (or reuse) a local gateway.
    // `lore run` always runs locally — agent is on the same machine.
    const handle = await startGateway({ ...opts, local: true });
    gatewayUrl = `http://${bracketHost(handle.config.hosts[0])}:${handle.port}`;
    owned = handle.owned;
    shutdown = handle.shutdown;
    // Post-adoption config (LORE_UPSTREAM_* now reflected). Used for autoImport.
    effectiveConfig = handle.config;

    if (owned) {
      console.log(`[lore] Gateway listening on ${gatewayUrl}`);
    } else {
      console.log(`[lore] Reusing existing gateway at ${gatewayUrl}`);
      if (
        adopted?.gatewayEnvKey &&
        selection?.def?.wireProtocol !== "anthropic"
      ) {
        console.error(
          `[lore] Cannot adopt your ${adopted.agentDisplayName} upstream when reusing an existing gateway.`,
        );
        console.error(
          `[lore] Stop the existing gateway or start it with ${adopted.gatewayEnvKey} configured.`,
        );
        return safeExit(1);
      }
    }
  }
  console.log(`[lore] Dashboard: ${gatewayUrl}/ui`);

  // 3. Auto-detect prior conversations (per newly-detected agent)
  if (owned) {
    await maybeAutoImport(effectiveConfig);
  }

  // 4. Build the launch target (env + args) now that we have the URL.
  const target = selection
    ? resolveLaunchTarget(selection, gatewayUrl, cmdArgs, extraArgs, adopted)
    : null;

  if (!target) {
    // No agent found — start server without launching an agent
    console.log(
      "[lore] No agent detected. Point your agent at the gateway manually.",
    );
    console.log(`[lore]   export ANTHROPIC_BASE_URL=${gatewayUrl}`);

    if (owned) {
      installSignalShutdown(shutdown);
    }

    // Block forever
    return new Promise(() => {});
  }

  // 4. Launch agent child process
  console.log(
    `[lore] Launching: ${target.command} ${target.args.join(" ")}`.trimEnd(),
  );

  // Silence the in-process gateway's stderr before handing the terminal to the
  // agent. `lore run` starts the gateway in THIS process, so its `[lore]` log
  // lines (worker-health, background-import, upstream warnings) write to the
  // same stderr the interactive agent renders into — corrupting its TUI, the
  // same failure the Pi/OpenCode plugins avoid via silenceStderr(). We only do
  // this for an owned gateway feeding an interactive TTY; nothing is lost —
  // the file sink + Sentry sink keep everything (read with `lore logs`).
  // `LORE_DEBUG=1` opts back into full stderr for troubleshooting.
  if (owned && !config.debug && process.stderr.isTTY) {
    log.silenceStderr();
  }

  const child = launchChild(target);

  // Forward the first signal to the child (its `exit` handler then drives
  // gateway teardown); a second interrupt forces an immediate exit so the user
  // is never stuck waiting on a hung child or shutdown.
  installChildSignalForwarding(child);

  // Wait for child to exit, then tear down gateway (only if we own it)
  return new Promise<void>((_resolve) => {
    child.on("exit", (code, signal) => {
      void (async () => {
        // Deadline-bounded so a slow shutdown step can't hang the process.
        // Use forcedExit on this path: the bounded shutdown may have timed out
        // (4000ms) and the embedding worker may still be mid-inference in a
        // native call — safeExit → process.exit() would walk NAPI destructors
        // under it and SIGABRT (the "💣 Program crashed" report).
        if (owned) await runShutdownWithDeadline(shutdown);
        if (signal) {
          forcedExit(signalExitCode(signal));
        }
        forcedExit(code ?? 0);
      })();
    });

    child.on("error", (err) => {
      void (async () => {
        console.error(
          `[lore] Failed to launch ${target.command}: ${err.message}`,
        );
        if (owned) await runShutdownWithDeadline(shutdown);
        forcedExit(1);
      })();
    });
  });
}
