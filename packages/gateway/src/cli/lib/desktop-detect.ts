/**
 * Claude Code Desktop app detection.
 *
 * The Desktop app is an Electron app (macOS + Windows only) that spawns
 * the same `claude` CLI binary as a child process for local Code sessions.
 * It reads `ANTHROPIC_BASE_URL` from `~/.claude/settings.json` (the same
 * file the CLI uses) — that is the documented, plaintext, user-writable
 * surface Lore automates via `lore setup claude-code-desktop`.
 *
 * 🔴 The Desktop's in-app Local environment editor stores its values via
 * Electron `safeStorage` (encrypted under Claude.app's OS-keychain identity
 * on macOS / DPAPI on Windows). It CANNOT be written by an external tool, so
 * Lore never targets it — it remains a manual fallback only.
 *
 * No Linux build: the function returns null unconditionally on Linux.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

/** macOS launcher path (Electron's `Contents/MacOS/<Name>`). */
const MACOS_APP_PATH = "/Applications/Claude.app/Contents/MacOS/Claude";

/** Windows launcher candidates under %LOCALAPPDATA%\Programs\Claude. */
function getWindowsLauncherPaths(): string[] {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return [];
  const base = join(localAppData, "Programs", "Claude");
  return [join(base, "Claude.exe"), join(base, "claude.exe")];
}

/**
 * Returns the absolute path to the Claude Code Desktop launcher, suitable
 * for `spawn()`. Returns null when the desktop app is not installed or is
 * not supported on the current platform.
 *
 * Sync to match `whichSync` (lib/which.ts); both run on the CLI hot path
 * and are called once per agent detection.
 */
export function isClaudeDesktopInstalled(): string | null {
  if (process.platform === "darwin") {
    return existsSync(MACOS_APP_PATH) ? MACOS_APP_PATH : null;
  }
  if (process.platform === "win32") {
    for (const candidate of getWindowsLauncherPaths()) {
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }
  // Linux (and any future platform without a desktop build) → not installed.
  return null;
}
