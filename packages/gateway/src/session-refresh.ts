import type { GatewayConfig } from "./config";
import {
  getAuthedClient,
  loadPersistedSession,
  SESSION_REFRESH_MARGIN_SECONDS,
} from "./supabase";

/** Refresh local account sessions even when cloud sync is off or no agent is active. */
export function startSessionRefreshScheduler(
  mode: Pick<GatewayConfig, "hostedMode" | "remoteGateway">,
  intervalMs = 30_000,
): () => Promise<void> {
  if (mode.hostedMode || mode.remoteGateway) return async () => {};
  const controller = new AbortController();
  let inflight: Promise<unknown> | null = null;
  const tick = () => {
    if (
      controller.signal.aborted ||
      mode.hostedMode ||
      mode.remoteGateway ||
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
