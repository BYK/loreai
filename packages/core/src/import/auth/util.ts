/**
 * Shared helpers for harness on-disk auth readers.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** XDG_DATA_HOME or ~/.local/share. */
export function xdgDataHome(): string {
  return process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
}

/** XDG_CONFIG_HOME or ~/.config. */
export function xdgConfigHome(): string {
  return process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
}

/**
 * Read and JSON-parse a file. Returns null on any missing/unreadable/invalid
 * file — auth readers must never throw.
 */
export function readJsonFile<T = unknown>(path: string): T | null {
  try {
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Whether an OAuth-style credential is still valid. API keys (no `expiresAt`)
 * are always valid. A small negative skew avoids using a token that is about to
 * expire mid-extraction.
 */
const EXPIRY_SKEW_MS = 60_000;

export function isUnexpired(
  expiresAt: number | undefined,
  now = Date.now(),
): boolean {
  if (expiresAt === undefined) return true;
  return expiresAt - EXPIRY_SKEW_MS > now;
}
