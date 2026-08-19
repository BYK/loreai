/**
 * Port file management — allows plugins to discover the gateway's actual port.
 *
 * When the gateway starts (especially on a fallback or random port), it writes
 * the actual port number to `~/.local/share/lore/gateway.port`. Plugins read
 * this file to locate the gateway without hardcoding a specific port.
 *
 * The file is removed on clean shutdown. Stale files (from crashes) are
 * harmless — plugins probe `/health` after reading the port and ignore
 * unresponsive ports.
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { linkSync, renameSync, rmSync } from "node:fs";
import { dataDir } from "@loreai/core";
import { atomicWriteRuntimeFile, readRuntimeFile } from "./runtime-files";

const PORTFILE_NAME = "gateway.port";

export interface GatewayPortRecord {
  version: 1;
  port: number;
  token: string;
}

export type PortFileInspection =
  | { state: "absent" }
  | { state: "valid"; record: GatewayPortRecord }
  | { state: "invalid"; reason: string };

function portfilePath(): string {
  return join(dataDir(), PORTFILE_NAME);
}

/** Write the actual port to disk so plugins can discover it. */
export function writePortFile(port: number, token?: string): void {
  if (token === undefined) {
    atomicWriteRuntimeFile(PORTFILE_NAME, String(port));
    return;
  }
  if (!validPort(port) || !validToken(token)) {
    throw new Error("Invalid gateway port record");
  }
  atomicWriteRuntimeFile(
    PORTFILE_NAME,
    `${JSON.stringify({ version: 1, port, token })}\n`,
  );
}

/**
 * Remove the port file on shutdown — but only if it still contains the
 * port this instance wrote. This prevents a concurrent gateway instance
 * from losing its port file when a different instance shuts down.
 */
export function removePortFile(
  expectedPort: number,
  expectedToken?: string,
): void {
  const path = portfilePath();
  const claimName = `.gateway.port.cleanup-${process.pid}-${randomBytes(8).toString("hex")}`;
  const claimPath = join(dataDir(), claimName);
  try {
    renameSync(path, claimPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const claimed = inspectPortFile(claimName);
  if (expectedToken === undefined && claimed.state === "invalid") {
    try {
      const legacyPort = Number.parseInt(readRuntimeFile(claimName).trim(), 10);
      if (legacyPort === expectedPort) {
        rmSync(claimPath, { force: true });
        return;
      }
    } catch {
      // Preserve unrecognized evidence below.
    }
  }
  if (
    claimed.state === "valid" &&
    claimed.record.port === expectedPort &&
    (expectedToken === undefined || claimed.record.token === expectedToken)
  ) {
    rmSync(claimPath, { force: true });
    return;
  }
  try {
    linkSync(claimPath, path);
    rmSync(claimPath, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // Preserve the displaced unknown generation as a recovery artifact.
  }
}

/** Read the port file. Returns the port number or null if not found/invalid. */
export function readPortFile(): number | null {
  try {
    const content = readRuntimeFile(PORTFILE_NAME).trim();
    if (content.startsWith("{")) {
      const value = JSON.parse(content) as unknown;
      return validPortRecord(value) ? value.port : null;
    }
    const port = Number.parseInt(content, 10);
    return validPort(port) ? port : null;
  } catch {
    return null;
  }
}

function validPort(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= 65535
  );
}

function validToken(value: unknown): value is string {
  return typeof value === "string" && value.length >= 32 && value.length <= 256;
}

function validPortRecord(value: unknown): value is GatewayPortRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<GatewayPortRecord>;
  return (
    record.version === 1 && validPort(record.port) && validToken(record.token)
  );
}

/** Strict discovery API; unlike readPortFile it preserves invalid evidence. */
export function inspectPortFile(
  runtimeName: string = PORTFILE_NAME,
): PortFileInspection {
  try {
    let value: unknown;
    try {
      value = JSON.parse(readRuntimeFile(runtimeName, { ownerOnly: true }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { state: "absent" };
      }
      return {
        state: "invalid",
        reason: `port record is malformed, unreadable, or unsafe: ${String(error)}`,
      };
    }
    return validPortRecord(value)
      ? { state: "valid", record: value }
      : { state: "invalid", reason: "port record has invalid fields" };
  } catch (error) {
    return {
      state: "invalid",
      reason: `port record is unreadable or unsafe: ${String(error)}`,
    };
  }
}
