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
import { loadConfig } from "../config";
import { detectAgents, AGENTS, type DetectedAgent } from "./agents";
import { safeExit } from "./exit";
import {
  installSignalShutdown,
  installChildSignalForwarding,
  runShutdownWithDeadline,
  signalExitCode,
} from "./shutdown";
import { maybeAutoImport } from "./import-auto";
import { discoverWorkspaceRoot } from "@loreai/core";

// ---------------------------------------------------------------------------
// Interactive agent picker (TTY only)
// ---------------------------------------------------------------------------

async function promptAgent(agents: DetectedAgent[]): Promise<DetectedAgent> {
  console.log("\n[lore] Multiple AI agents detected:\n");
  for (let i = 0; i < agents.length; i++) {
    console.log(`  ${i + 1}) ${agents[i].def.displayName} (${agents[i].path})`);
  }
  console.log();

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  return new Promise<DetectedAgent>((resolve) => {
    const ask = () => {
      rl.question("Choose an agent [1]: ", (answer) => {
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

async function resolveLaunchTarget(
  gatewayUrl: string,
  cmdArgs: string[],
  extraArgs: string[],
): Promise<LaunchTarget | null> {
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
    return {
      command: cmdArgs[0],
      args: [...prependArgs, ...cmdArgs.slice(1), ...extraArgs],
      env,
    };
  }

  // --- No command: auto-detect agents ---
  const detected = detectAgents();

  if (detected.length === 0) {
    console.error("[lore] No known AI agents found on PATH.");
    console.error(
      "[lore] Install one of: Claude Code (claude), Codex (codex), Pi (pi), OpenCode (opencode), Hermes (hermes)",
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
    // Non-TTY with multiple agents — can't prompt
    console.error("[lore] Multiple agents detected but stdin is not a TTY.");
    console.error("[lore] Specify which agent to run: lore run <command>");
    for (const a of detected) {
      console.error(`  - ${a.def.displayName}: lore run ${a.def.binary}`);
    }
    return null;
  }

  const agentCliArgs = agent.def.cliArgs?.(gatewayUrl, projectDir) ?? [];
  return {
    command: agent.def.binary,
    args: [...agentCliArgs, ...extraArgs],
    env: agent.def.envVars(gatewayUrl, projectDir),
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
  // 1. Start gateway (or delegate to a remote one)
  const config = loadConfig();
  let gatewayUrl: string;
  let owned: boolean;
  let shutdown: () => Promise<void>;

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
  } else {
    // Local mode: start (or reuse) a local gateway.
    // `lore run` always runs locally — agent is on the same machine.
    const handle = await startGateway({ ...opts, local: true });
    gatewayUrl = `http://${handle.config.hosts[0]}:${handle.port}`;
    owned = handle.owned;
    shutdown = handle.shutdown;

    if (owned) {
      console.log(`[lore] Gateway listening on ${gatewayUrl}`);
    } else {
      console.log(`[lore] Reusing existing gateway at ${gatewayUrl}`);
    }
  }
  console.log(`[lore] Dashboard: ${gatewayUrl}/ui`);

  // 2. Auto-detect prior conversations (per newly-detected agent)
  if (owned) {
    await maybeAutoImport(config);
  }

  // 3. Resolve what to launch
  const target = await resolveLaunchTarget(gatewayUrl, cmdArgs, extraArgs);

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

  const child = launchChild(target);

  // Forward the first signal to the child (its `exit` handler then drives
  // gateway teardown); a second interrupt forces an immediate exit so the user
  // is never stuck waiting on a hung child or shutdown.
  installChildSignalForwarding(child);

  // Wait for child to exit, then tear down gateway (only if we own it)
  return new Promise<void>((_resolve) => {
    child.on("exit", async (code, signal) => {
      // Deadline-bounded so a slow shutdown step can't hang the process.
      if (owned) await runShutdownWithDeadline(shutdown);
      // Exit with the child's code (or 128 + signal number for signal deaths)
      if (signal) {
        safeExit(signalExitCode(signal));
      }
      safeExit(code ?? 0);
    });

    child.on("error", async (err) => {
      console.error(
        `[lore] Failed to launch ${target.command}: ${err.message}`,
      );
      if (owned) await runShutdownWithDeadline(shutdown);
      safeExit(1);
    });
  });
}
