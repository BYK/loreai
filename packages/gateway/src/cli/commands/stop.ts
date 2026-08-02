/**
 * `lore stop` — stop a background gateway.
 *
 * Phase 3B: typed Stricli command. The real work lives in `commandStop` and
 * `runStop` in `../stop.ts`; the adapter surfaces the lifecycle outcome as
 * a typed `StopResult` so the output pipeline can render human or JSON
 * and emit hints only in human mode.
 *
 * Exit codes:
 *   0 — stopped or nothing running
 *   1 — foreground gateway (can't signal by PID) or deadline exceeded
 */
import { buildOutputCommand } from "../lib/command";
import { commandStop as legacyCommandStop } from "../stop";

interface StopResult {
  /** What the command actually did. */
  action: "stopped" | "foreground" | "stale" | "none";
  /** PID of the stopped/stale gateway, if known. */
  pid: number | null;
  /** Listening port of a foreground gateway, if any. */
  port: number | null;
  /** Whether the operation succeeded. */
  ok: boolean;
}

function renderHuman(data: StopResult): string {
  switch (data.action) {
    case "stopped":
      return `[lore] Gateway stopped (pid ${data.pid ?? "?"}).`;
    case "foreground":
      return [
        `[lore] A gateway is running on port ${data.port ?? "?"} but no PID file was found.`,
        `[lore] It's likely a foreground \`lore start\` — stop it with Ctrl+C in its terminal.`,
      ].join("\n");
    case "stale":
      return `[lore] No running gateway found (cleaned up stale PID file).`;
    case "none":
      return "[lore] No running gateway found.";
  }
}

function toJson(data: StopResult): unknown {
  return data;
}

/**
 * Adapt the legacy `commandStop` to the typed result path. The legacy
 * implementation prints "[lore] ..." lines via `console.log`. We sink
 * those into a local buffer so the typed envelope is the only thing
 * the wrapper renders — both human and JSON mode stay clean.
 */
async function runLegacyAndCollect(): Promise<{
  exitCode: number;
  captured: string;
}> {
  const captured: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  const priorExitCode = process.exitCode;
  process.exitCode = 0;
  console.log = (...args: unknown[]) => {
    for (const a of args) {
      captured.push(typeof a === "string" ? a : String(a));
    }
  };
  console.error = (...args: unknown[]) => {
    for (const a of args) {
      captured.push(typeof a === "string" ? a : String(a));
    }
  };
  try {
    await legacyCommandStop();
  } finally {
    console.log = realLog;
    console.error = realError;
  }
  const exitCode = process.exitCode ?? 0;
  process.exitCode = priorExitCode;
  return { exitCode, captured: captured.join("") };
}

function parseLegacyOutput(joined: string): {
  action: StopResult["action"];
  pid: number | null;
  port: number | null;
} {
  let action: StopResult["action"] = "none";
  if (/Gateway stopped/.test(joined)) action = "stopped";
  else if (/foreground/i.test(joined)) action = "foreground";
  else if (/stale PID file/.test(joined)) action = "stale";
  const pidMatch = joined.match(/pid (\d+)/);
  const portMatch = joined.match(/port (\d+)/);
  return {
    action,
    pid: pidMatch ? Number(pidMatch[1]) : null,
    port: portMatch ? Number(portMatch[1]) : null,
  };
}

export const stopCommand = buildOutputCommand<StopResult, { json: boolean }, []>({
  brief: "Stop a background gateway started with `lore start --bg`",
  fullDescription:
    "Stop a Lore gateway started with `lore start --bg` (or any " +
    "`lore start` that wrote a PID file). Resolution order: a live PID " +
    "file is signaled, a foreground gateway without a PID file is reported " +
    "for Ctrl+C, stale PID files are cleaned, nothing running is a no-op.",
  parameters: {
    flags: {
      json: {
        kind: "boolean",
        brief: "Emit a stable JSON payload (ok, action, pid, port)",
        default: false,
      },
    },
  },
  config: { renderHuman, toJson },
  async handler() {
    const { exitCode, captured } = await runLegacyAndCollect();
    const parsed = parseLegacyOutput(captured);
    const result: StopResult = {
      action: parsed.action,
      pid: parsed.pid,
      port: parsed.port,
      ok: exitCode === 0,
    };
    const hint =
      result.action === "foreground"
        ? "Use Ctrl-C in the terminal running `lore start`."
        : result.action === "stopped"
          ? "Run `lore start --bg` to restart, or `lore stop` again if it didn't exit."
          : undefined;
    return { kind: "value" as const, data: result, hint };
  },
});