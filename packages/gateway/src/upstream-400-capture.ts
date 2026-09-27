/** Explicit, one-shot local capture of a rejected upstream request.
 *
 * The full request may contain private conversation data. Never log it or
 * include it in telemetry; write only when both a path and exact session ID
 * have been supplied by the operator. Exclusive creation prevents overwriting
 * an earlier capture (including one made by another process).
 */
import { writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { log } from "@loreai/core";

const attemptedPaths = new Set<string>();

export function captureRejectedUpstreamRequest(
  sessionID: string,
  serializedBody: string,
  localMode: boolean,
): void {
  if (!localMode) return;
  const path = process.env.LORE_UPSTREAM_400_CAPTURE_PATH;
  const targetSession = process.env.LORE_UPSTREAM_400_CAPTURE_SESSION;
  if (!path || !targetSession || targetSession !== sessionID) return;
  if (attemptedPaths.has(path)) return;
  attemptedPaths.add(path);

  if (!isAbsolute(path)) {
    log.warn("upstream 400 capture requires an absolute file path");
    return;
  }

  try {
    writeFileSync(path, serializedBody, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    log.warn("upstream 400 request captured locally (sensitive, mode 0600)");
  } catch {
    log.warn("upstream 400 capture failed; check the path and permissions");
  }
}
