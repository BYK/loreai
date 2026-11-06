import type { GatewayConfig } from "./config";
import { syncData } from "@loreai/core";
import {
  getAuthedClient,
  loadPersistedSession,
  SESSION_REFRESH_MARGIN_SECONDS,
} from "./supabase";

/** Refresh the installation account independently of cloud sync and deployment mode. */
export function startSessionRefreshScheduler(
  _mode: Pick<GatewayConfig, "hostedMode" | "remoteGateway">,
  intervalMs = 30_000,
): () => Promise<void> {
  // A gateway may host model tenants, but only the installation lifecycle owns
  // its operator credentials. Never inherit that authority from a tenant call.
  if (!syncData.isLocalSyncContext()) return async () => {};
  const controller = new AbortController();
  let inflight: Promise<unknown> | null = null;
  const tick = () => {
    try {
      if (
        controller.signal.aborted ||
        !syncData.isLocalSyncContext() ||
        inflight
      )
        return;
      const session = loadPersistedSession();
      if (
        !session ||
        session.expires_at === undefined ||
        session.expires_at > Date.now() / 1000 + SESSION_REFRESH_MARGIN_SECONDS
      )
        return;
      inflight = getAuthedClient(controller.signal)
        // getAuthedClient classifies failures and preserves temporary failures.
        // Retrying on the next tick avoids a tight loop while the service is down.
        .catch(() => {})
        .finally(() => {
          inflight = null;
        });
    } catch {
      // Optional refresh must never crash a listener, including when SQLite
      // initialization or a synchronous session read fails. Retry next tick;
      // never export the original database or filesystem exception.
    }
  };
  const startup = setTimeout(tick, 0);
  startup.unref?.();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return async () => {
    clearTimeout(startup);
    clearInterval(timer);
    controller.abort();
    if (inflight) await inflight;
  };
}
