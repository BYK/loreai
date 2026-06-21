/**
 * PID file management — lets `lore stop` find a gateway started in the
 * background (`lore start --bg`) or foreground.
 *
 * When the gateway starts and owns the server, it writes its own PID to
 * `~/.local/share/lore/gateway.pid`. `lore stop` reads this file to send the
 * process a SIGTERM. The file is removed on clean shutdown; a stale file (from
 * a crash) is harmless — `lore stop` verifies the process is actually alive
 * before signalling, and treats a dead PID as "nothing running."
 *
 * Mirrors `portfile.ts` semantics (write/read/remove-if-matches).
 */
import { join } from "node:path";
import { writeFileSync, unlinkSync, readFileSync, mkdirSync } from "node:fs";
import { dataDir } from "@loreai/core";

const PIDFILE_NAME = "gateway.pid";

function pidfilePath(): string {
  return join(dataDir(), PIDFILE_NAME);
}

/** Write the current process PID to disk so `lore stop` can find us. */
export function writePidFile(pid: number = process.pid): void {
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(pidfilePath(), String(pid), "utf8");
}

/**
 * Remove the PID file on shutdown — but only if it still contains the PID
 * this instance wrote. Prevents a concurrent gateway from losing its PID file
 * when a different instance shuts down.
 */
export function removePidFile(expectedPid: number = process.pid): void {
  try {
    const current = readPidFile();
    if (current === expectedPid) {
      unlinkSync(pidfilePath());
    }
  } catch {
    /* already gone or unreadable */
  }
}

/** Read the PID file. Returns the PID or null if not found/invalid. */
export function readPidFile(): number | null {
  try {
    const content = readFileSync(pidfilePath(), "utf8").trim();
    const pid = Number.parseInt(content, 10);
    return pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Check whether a process with the given PID is alive. Uses signal 0, which
 * performs error checking without actually sending a signal. Returns false for
 * a dead PID (ESRCH) and true for a live one (including EPERM — the process
 * exists but we lack permission to signal it).
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
