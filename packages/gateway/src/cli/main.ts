/**
 * CLI entry point — argument parsing and command dispatch.
 *
 * Uses Node.js built-in `parseArgs` from `node:util`.
 *
 * Commands:
 *   (none) / run   → start gateway + launch agent
 *   start          → start gateway server (no agent auto-launch)
 *   setup          → configure an AI app to route through lore
 *   data           → inspect and manage stored data
 *   recall         → search project memory from the terminal
 *   upgrade        → self-update
 *   help           → print usage
 */
import { parseArgs } from "node:util";
import { printHelp, printVersion } from "./help";
import { commandStart, type StartOptions } from "./start";
import {
  abortPendingVersionCheck,
  getUpdateNotification,
  maybeCheckForUpdateInBackground,
  shouldSuppressNotification,
} from "./lib/version-check";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

/** Token from `parseArgs` with `tokens: true`. */
interface ParseToken {
  kind: "option" | "positional" | "option-terminator";
  index: number;
  name?: string;
  rawName?: string;
  value?: string;
  inlineValue?: boolean;
}

/** Set of option names defined in OPTIONS — used to detect unknown flags. */
const KNOWN_OPTIONS = new Set<string>();

/**
 * Extract arguments that should be forwarded to the launched agent.
 *
 * Strategy:
 * 1. If `--` is present, everything after it is the agent's.
 * 2. If an agent/command positional is found, slice raw `argv` from one past
 *    it — everything after the agent name is the agent's. This avoids
 *    parseArgs's inability to handle unknown value-bearing flags
 *    (e.g. `--model gpt-4`).
 * 3. In auto-detect mode (no agent name, no `--`), reconstruct unknown option
 *    tokens (flags not in OPTIONS) and forward them. This handles cases like
 *    `lore --dangerously-skip-permissions` where the flag should reach the
 *    auto-detected agent.
 *
 * Caveat: lore's own known options (--port, --debug, etc.) are consumed by
 * parseArgs regardless of position. Place them before the agent name, or use
 * `--` to prevent lore from consuming them.
 */
function extractAgentArgs(argv: string[], tokens: ParseToken[]): string[] {
  // 1. If there is a `--` (option-terminator), everything after it is for the agent.
  const terminator = tokens.find((t) => t.kind === "option-terminator");
  if (terminator) {
    return argv.slice(terminator.index + 1);
  }

  // 2. Find the agent/command positional — the first positional that is NOT "run".
  const positionalTokens = tokens.filter((t) => t.kind === "positional");
  for (const pt of positionalTokens) {
    if (pt.value === "run") continue;
    // This is the agent/command name. Everything after it in raw argv is the agent's.
    return argv.slice(pt.index + 1);
  }

  // 3. Auto-detect with no agent name — collect unknown option tokens.
  //    Unknown flags (not in OPTIONS) are reconstructed from their rawName
  //    and forwarded to the agent. parseArgs treats all unknown flags as
  //    booleans, so value-bearing flags like `--model gpt-4` cannot be
  //    reconstructed here — use `--` for those cases.
  const unknownArgs: string[] = [];
  for (const t of tokens) {
    if (t.kind === "option" && t.name && !KNOWN_OPTIONS.has(t.name)) {
      unknownArgs.push(t.rawName ?? `--${t.name}`);
    }
  }
  return unknownArgs;
}

/** Options shared by all commands. */
const OPTIONS = {
  port: { type: "string" as const, short: "p" },
  host: { type: "string" as const, short: "H", multiple: true },
  debug: { type: "boolean" as const, short: "d" },
  remote: { type: "string" as const, short: "r" },
  version: { type: "boolean" as const, short: "v" },
  help: { type: "boolean" as const, short: "h" },
  yes: { type: "boolean" as const, short: "y" },
  interactive: { type: "boolean" as const, short: "i" },
  noPlugin: { type: "boolean" as const },
  // `lore logs` flags
  follow: { type: "boolean" as const, short: "f" },
  n: { type: "string" as const },
  lines: { type: "string" as const },
  path: { type: "boolean" as const },
  // `lore data move` flags
  to: { type: "string" as const },
  project: { type: "string" as const },
  limit: { type: "string" as const },
  json: { type: "boolean" as const },
  "dry-run": { type: "boolean" as const },
  "no-children": { type: "boolean" as const },
  "min-confidence": { type: "string" as const },
  "no-backup": { type: "boolean" as const },
  // `lore data clear` flags
  knowledge: { type: "boolean" as const },
  temporal: { type: "boolean" as const },
  distillations: { type: "boolean" as const },
  all: { type: "boolean" as const },
  // `lore start --local` — disable hosted mode (keep FS ops active)
  local: { type: "boolean" as const, short: "l" },
  // `lore start --bg` / `--daemon` — run the gateway detached in the background
  bg: { type: "boolean" as const },
  daemon: { type: "boolean" as const },
  // `lore login` / `lore whoami` flags
  email: { type: "string" as const },
  verify: { type: "boolean" as const },
  "no-browser": { type: "boolean" as const },
  // Hidden diagnostic: prints the vendored-model registration set by
  // the binary build wrapper (or "none" in npm mode). Used by CI to verify
  // the embed-asset pipeline actually wired up. Not in help text.
  "print-vendor-info": { type: "boolean" as const },
  // Hidden diagnostic: actually exercises the local embedding provider
  // (loads transformers.js → embeds a sample string) and prints success
  // or the failure reason. Used by CI to catch model-load regressions
  // that --print-vendor-info alone wouldn't surface.
  "check-embeddings": { type: "boolean" as const },
  // Hidden diagnostic: verifies the native sqlite-vec extension actually
  // loaded (prints `ok vec_version=...`) or that the binary fell back to the
  // JS brute-force path (`fallback ...`). Used by CI to confirm the SEA binary
  // embeds + loads the vec0 extension.
  "check-vec": { type: "boolean" as const },
  // Hidden diagnostic: round-trips a trivial generic read job through the
  // off-thread read-worker pool (prints `ok read-offload via worker`) to prove
  // the embedded vector-worker asset + read-job seam works inside the SEA
  // binary — the path recall/forSession fan-out rides on (#1029).
  "check-read-offload": { type: "boolean" as const },
} as const;

// Populate the set used by extractAgentArgs to distinguish lore's own flags
// from unknown flags that should be forwarded to the agent.
for (const [name, def] of Object.entries(OPTIONS)) {
  KNOWN_OPTIONS.add(name);
  if ("short" in def && def.short) KNOWN_OPTIONS.add(def.short);
}

function parsePort(value: string): number {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n) || n < 0 || n > 65535) {
    console.error(`Error: Invalid port "${value}". Must be 0–65535.`);
    process.exit(1);
  }
  return n;
}

function buildStartOptions(values: {
  port?: string;
  host?: string[];
  debug?: boolean;
  remote?: string;
  local?: boolean;
  bg?: boolean;
  daemon?: boolean;
}): StartOptions {
  // Flatten: each --host value may itself be comma-separated
  const hosts = values.host?.flatMap((h) =>
    h
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return {
    port: values.port ? parsePort(values.port) : undefined,
    hosts: hosts?.length ? hosts : undefined,
    debug: values.debug ?? undefined,
    remoteUrl: values.remote ?? undefined,
    local: values.local ?? undefined,
    bg: values.bg || values.daemon || undefined,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function _cli(): Promise<void> {
  // Parse known options, allow positional args for command + pass-through.
  // `tokens: true` gives us index information needed to extract agent args.
  let values: ReturnType<typeof parseArgs>["values"];
  let positionals: string[];
  let tokens: ParseToken[];
  const argv = process.argv.slice(2);

  try {
    const parsed = parseArgs({
      args: argv,
      options: OPTIONS,
      allowPositionals: true,
      strict: false,
      tokens: true,
    });
    values = parsed.values;
    positionals = parsed.positionals;
    tokens = parsed.tokens as ParseToken[];
  } catch (e) {
    console.error(`Error: ${e instanceof Error ? e.message : e}`);
    printHelp();
    process.exit(1);
  }

  // --version / -v (only when no subcommand is given)
  if (values.version && positionals.length === 0) {
    printVersion();
    return;
  }

  // --print-vendor-info (hidden; used by CI to verify the binary's
  // vendor wrapper ran before any other code and registered the model
  // path on globalThis). Lazy-import so the npm-mode bundle doesn't pay
  // the cost.
  if (values["print-vendor-info"]) {
    const { embeddingVendor } = await import("@loreai/core");
    const reg = embeddingVendor.vendorRegistration();
    console.log(reg ? JSON.stringify(reg) : "none");
    return;
  }

  // --check-embeddings (hidden). End-to-end smoke for the embedding
  // pipeline: loads transformers.js + the model, runs one embedding
  // through the local provider, prints `ok dim=N` or a clear failure
  // message. Used by CI to catch regressions in the model load path
  // that --print-vendor-info wouldn't surface.
  if (values["check-embeddings"]) {
    const { embedding } = await import("@loreai/core");
    try {
      const [vec] = await embedding.embed(["hello world"], "query");
      if (!vec || vec.length === 0) {
        console.error("✗ embed returned empty vector");
        process.exit(1);
      }
      console.log(`ok dim=${vec.length}`);
      // Force-exit to avoid potential ONNX Runtime teardown issues.
      const { safeExit } = await import("./exit");
      safeExit(0);
    } catch (err: unknown) {
      const cause = (err as Error & { cause?: unknown })?.cause;
      console.error(
        `✗ embed failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (cause)
        console.error(
          `  cause: ${cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)}`,
        );
      process.exit(1);
    }
    return;
  }

  // --check-vec (hidden). Confirms the native sqlite-vec extension loads on
  // BOTH connection paths — inside the SEA each is extracted from the embedded
  // per-target asset by native-loader.cjs.
  //
  //   1. Main DB connection: prints `ok vec_version=<v>` when native search is
  //      active, or `fallback (...)` when the JS brute-force path is in use.
  //   2. Off-thread read-worker pool (the path production vector search runs
  //      on): spawns one probe worker that opens its OWN reader connection in
  //      its OWN worker_threads thread and loads the extension there. Prints
  //      `ok worker vec_available=true` / `worker fallback (...)`. A green
  //      main-thread line does NOT prove this worker-thread chain — #1033.
  //
  // The exit code stays tied only to an unexpected throw (matching the
  // main-thread `fallback` being exit 0); CI greps these lines per platform.
  if (values["check-vec"]) {
    const { db, isVecAvailable, checkVecWorker } = await import("@loreai/core");
    const { safeExit } = await import("./exit");
    let ok = false;
    try {
      const conn = db();
      if (!isVecAvailable()) {
        console.log(
          "fallback (native sqlite-vec not loaded — using JS brute-force)",
        );
      } else {
        const row = conn.query("SELECT vec_version() AS v").get() as
          | { v?: string }
          | undefined;
        console.log(`ok vec_version=${row?.v ?? "unknown"}`);
      }

      // Independently verify the off-thread read-pool path (#1033). `db()` above
      // has created/migrated the file, so the worker's reader open will find it.
      const w = await checkVecWorker();
      if (w.status === "ready" && w.vecAvailable) {
        console.log("ok worker vec_available=true");
      } else if (w.status === "ready") {
        console.log(
          "worker fallback (native sqlite-vec not loaded in worker — using JS brute-force)",
        );
      } else {
        // Structural probe failure (spawn/init/timeout). Surface it on stdout so
        // the captured `--check-vec` output shows why the worker assertion fails,
        // without changing the exit code — CI's grep is the per-platform gate.
        console.log(
          `worker check failed: ${w.status}${w.error ? ` (${w.error})` : ""}`,
        );
      }
      ok = true;
    } catch (err: unknown) {
      console.error(
        `✗ check-vec failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // Exit outside the try so a throw on the success path can't be mis-reported
    // as a check failure; safeExit (not process.exit) on both paths avoids the
    // Bun NAPI teardown hang.
    safeExit(ok ? 0 : 1);
    return;
  }

  // --check-read-offload (hidden). Proves the off-thread read-worker seam works
  // end-to-end inside a built binary: spawns one read-pool worker exactly the
  // way production does (embedded `vector-worker.cjs` asset), boots its reader
  // connection, and round-trips a trivial `SELECT 1` read job back off the main
  // thread. Unlike --check-vec (native sqlite-vec may legitimately be absent →
  // JS fallback is OK), the read seam is pure JS + node:sqlite and MUST work on
  // every platform, so anything but a worker round-trip is a hard failure. CI
  // greps `^ok read-offload via worker` per platform AND checks the exit code.
  if (values["check-read-offload"]) {
    const { db, checkReadOffload } = await import("@loreai/core");
    const { safeExit } = await import("./exit");
    let ok = false;
    try {
      // Create/migrate the DB file so the worker's reader connection can open it.
      db();
      const r = await checkReadOffload();
      if (r.status === "ok") {
        console.log("ok read-offload via worker");
        ok = true;
      } else {
        // Surface the failing status on stdout so the captured output shows why
        // the assertion failed; the exit code is the gate.
        console.log(
          `read-offload failed: ${r.status}${r.error ? ` (${r.error})` : ""}`,
        );
      }
    } catch (err: unknown) {
      console.error(
        `✗ check-read-offload failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    safeExit(ok ? 0 : 1);
    return;
  }

  // --help / -h (no command)
  if (values.help && positionals.length === 0) {
    printHelp();
    return;
  }

  // Determine command (first positional, or "run" as default)
  const command = positionals[0] ?? "run";
  const rest = positionals.slice(1);

  const startOpts = buildStartOptions(
    values as {
      port?: string;
      host?: string[];
      debug?: boolean;
      remote?: string;
      local?: boolean;
      bg?: boolean;
      daemon?: boolean;
    },
  );

  // Start background update check (non-blocking).
  // Suppressed for commands where the banner would be confusing or redundant.
  const suppressNotification = shouldSuppressNotification(positionals);
  if (!suppressNotification) {
    maybeCheckForUpdateInBackground();
  }

  try {
    switch (command) {
      case "start":
        await commandStart(startOpts);
        break;

      case "stop": {
        const { commandStop } = await import("./stop");
        await commandStop();
        break;
      }

      case "run": {
        // Lazy-import to avoid pulling in child_process + agent detection
        // when only `lore start` or `lore help` is needed.
        const { commandRun } = await import("./run");
        const agentArgs = extractAgentArgs(argv, tokens);
        // Pass only the agent name (if any) as cmdArgs; extra flags go via agentArgs.
        const agentName = rest.length > 0 ? [rest[0]] : [];
        await commandRun(startOpts, agentName, agentArgs);
        break;
      }

      case "setup": {
        const { commandSetup } = await import("./setup");
        await commandSetup(rest, values as Record<string, unknown>);
        break;
      }

      case "doctor": {
        const { commandDoctor } = await import("./inventory");
        await commandDoctor();
        break;
      }

      case "data": {
        const { commandData } = await import("./data");
        await commandData(rest, values as Record<string, unknown>);
        break;
      }

      case "recall": {
        const { commandRecall } = await import("./recall-cmd");
        await commandRecall(rest, values as Record<string, unknown>);
        break;
      }

      case "log": {
        const { commandLog } = await import("./history-cmd");
        await commandLog(rest, values as Record<string, unknown>);
        break;
      }

      case "diff": {
        const { commandDiff } = await import("./history-cmd");
        await commandDiff(rest, values as Record<string, unknown>);
        break;
      }

      case "login": {
        const { commandLogin } = await import("./login");
        await commandLogin(rest, values as Record<string, unknown>);
        break;
      }

      case "logout": {
        const { commandLogout } = await import("./login");
        await commandLogout();
        break;
      }

      case "whoami": {
        const { commandWhoami } = await import("./login");
        await commandWhoami(rest, values as Record<string, unknown>);
        break;
      }

      case "sync": {
        const { commandSync } = await import("./sync-cmd");
        await commandSync(rest, values as Record<string, unknown>);
        break;
      }

      case "logs": {
        const { commandLogs } = await import("./logs");
        await commandLogs(rest, values as Record<string, unknown>);
        break;
      }

      case "import": {
        const { commandImport } = await import("./import");
        await commandImport(rest, values as Record<string, unknown>);
        break;
      }

      case "entity": {
        const { commandEntity } = await import("./entity");
        await commandEntity(rest, values as Record<string, unknown>);
        break;
      }

      case "upgrade": {
        const { commandUpgrade } = await import("./upgrade");
        // Pass raw args so upgrade's own parseArgs handles --version, --channel etc.
        // Start search at index 2 to skip the binary/script path entries.
        const rawUpgradeArgs = process.argv.slice(
          process.argv.indexOf("upgrade", 2) + 1,
        );
        await commandUpgrade(rawUpgradeArgs);
        break;
      }

      case "help":
        printHelp();
        break;

      default:
        // Check if the unknown command matches a known agent binary.
        // This allows `lore claude` as shorthand for `lore run claude`.
        {
          const { AGENTS } = await import("./agents");
          const knownBinaries = AGENTS.map((a) => a.binary);
          if (!knownBinaries.includes(command)) {
            // Not a known agent — likely a typo. Show a helpful error.
            const knownCommands = [
              "start",
              "stop",
              "run",
              "setup",
              "doctor",
              "data",
              "recall",
              "log",
              "diff",
              "login",
              "logout",
              "whoami",
              "sync",
              "logs",
              "import",
              "entity",
              "upgrade",
              "help",
              ...knownBinaries,
            ];
            // "Did you mean?" — use Levenshtein distance for robust matching
            function levenshtein(a: string, b: string): number {
              const m = a.length,
                n = b.length;
              const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
                Array.from({ length: n + 1 }, (_, j) =>
                  i === 0 ? j : j === 0 ? i : 0,
                ),
              );
              for (let i = 1; i <= m; i++)
                for (let j = 1; j <= n; j++)
                  dp[i][j] =
                    a[i - 1] === b[j - 1]
                      ? dp[i - 1][j - 1]
                      : 1 +
                        Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
              return dp[m][n];
            }
            let suggestion: string | undefined;
            let bestDist = Infinity;
            for (const c of knownCommands) {
              const dist = levenshtein(command, c);
              if (
                dist < bestDist &&
                dist <= Math.max(2, Math.floor(command.length / 2))
              ) {
                bestDist = dist;
                suggestion = c;
              }
            }
            const hint = suggestion
              ? ` Did you mean "lore ${suggestion}"?`
              : "";
            console.error(
              `Unknown command "${command}".${hint}\nRun "lore help" for available commands.`,
            );
            process.exitCode = 1;
            break;
          }
          const { commandRun } = await import("./run");
          const agentArgs = extractAgentArgs(argv, tokens);
          await commandRun(startOpts, [command], agentArgs);
        }
        break;
    }
  } finally {
    // Abort any pending version check to allow clean exit
    abortPendingVersionCheck();
  }

  // Show update notification after command completes
  if (!suppressNotification) {
    const notification = getUpdateNotification();
    if (notification) {
      process.stderr.write(notification);
    }
  }
}
