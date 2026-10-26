import {
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
} from "solid-js";

import { isApiError, type ApiClient } from "~/lib/api";
import type { AccountStatus, SyncRunReceipt, SyncStatus } from "~/contracts";
import { createLoader } from "~/lib/loader";

/**
 * Folk Lore (team sync) status for the shell: account and sync load once per
 * workspace; the team list loads only once something asks for it. Reads do
 * not go through `tracked` — a failed status read is reported by the status
 * surface itself and must not redefine the gateway connection state.
 */
export function createFolkState({ client }: { client: ApiClient }) {
  const always = () => true as const;
  const account = createLoader(always, async (_key, signal) =>
    client.getAccount(signal),
  );
  const sync = createLoader(always, async (_key, signal) =>
    client.getSyncStatus(signal),
  );
  const confirmedSync = createMemo<SyncStatus | undefined>((previous) => {
    if (sync.error() !== undefined) return undefined;
    return sync.loading() ? previous : sync.data();
  });
  // Keep the last confirmed account during healthy background reads, including
  // drawer remounts. A failed read invalidates it: clearing the loader's error
  // for a retry must not revive its retained (now unverified) data.
  const confirmedAccount = createMemo<AccountStatus | undefined>((previous) => {
    if (account.error() !== undefined) return undefined;
    if (account.loading()) return previous;
    return account.data();
  });
  const [teamsWanted, setTeamsWanted] = createSignal(false);
  const teamIdentity = createMemo<string | null>(() => {
    const current = confirmedAccount();
    if (current?.state === "anonymous") return "anonymous";
    return current?.signed_in && current.state === "signed_in" && current.user
      ? `user:${current.user.id}`
      : null;
  });
  const teams = createLoader(
    () => (teamsWanted() ? teamIdentity() : null),
    async (_key, signal) => client.getTeams(signal),
  );
  // CLI login/logout and background token rotation happen outside this tab.
  // Keep the shell current without requiring a popover click or page reload.
  onMount(() => {
    const refreshAccount = () => {
      if (document.visibilityState === "hidden" || account.loading()) return;
      account.reload();
      sync.reload();
    };
    const timer = window.setInterval(refreshAccount, 30_000);
    window.addEventListener("focus", refreshAccount);
    onCleanup(() => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshAccount);
    });
  });
  const refreshStatus = () => {
    account.reload();
    sync.reload();
    if (teamsWanted()) teams.reload();
    else setTeamsWanted(true);
  };
  // Navigation can unmount the account surface while a sync is in flight.
  // Keep its guard and result on the workspace, alongside the status reads.
  const [syncing, setSyncing] = createSignal(false);
  const [syncBlocker, setSyncBlocker] = createSignal<
    | "encryption_locked"
    | "sync_disabled"
    | "unauthorized"
    | "gateway_access"
    | null
  >(null);
  const [syncError, setSyncError] = createSignal<string | null>(null);
  const [syncReceipt, setSyncReceipt] = createSignal<string | null>(null);
  const [syncResult, setSyncResult] = createSignal<SyncRunReceipt | null>(null);
  const syncAttention = createMemo(() => {
    const result = syncResult();
    return (
      !!result &&
      (result.conflicts > 0 || result.skipped > 0 || !!result.quotaHit)
    );
  });
  let syncGeneration = 0;
  const syncOwner = createMemo(() => {
    const current = confirmedAccount();
    return current?.signed_in && current.state === "signed_in"
      ? (current.user?.id ?? null)
      : null;
  });
  createEffect(
    on(syncOwner, () => {
      syncGeneration++;
      setSyncReceipt(null);
      setSyncError(null);
      setSyncResult(null);
      setSyncBlocker(null);
    }),
  );
  onCleanup(() => {
    syncGeneration++;
  });
  const runSync = async () => {
    if (syncing()) return;
    const generation = syncGeneration;
    setSyncing(true);
    setSyncResult(null);
    setSyncBlocker(null);
    setSyncError(null);
    setSyncReceipt(null);
    try {
      const result = await client.runSync();
      if (generation !== syncGeneration) return;
      if (result.notAuthed) {
        setSyncBlocker("unauthorized");
        setSyncError("Sign in again before syncing.");
        refreshStatus();
        return;
      }
      setSyncResult(result);
      const issues = [
        result.conflicts > 0
          ? `${result.conflicts} ${result.conflicts === 1 ? "conflict needs" : "conflicts need"} review`
          : null,
        result.skipped > 0
          ? `${result.skipped} ${result.skipped === 1 ? "change" : "changes"} skipped`
          : null,
        result.quotaHit ? "Uploads paused by your sync quota" : null,
      ].filter(Boolean);
      setSyncReceipt(
        `${issues.length ? "Sync needs attention" : "Sync complete"}: pushed ${result.pushed}, pulled ${result.pulled}.${issues.length ? ` ${issues.join(". ")}.` : ""}`,
      );
      refreshStatus();
    } catch (error) {
      if (generation !== syncGeneration) return;
      const code = isApiError(error) ? error.code : null;
      if (
        code === "encryption_locked" ||
        code === "sync_disabled" ||
        code === "unauthorized"
      )
        setSyncBlocker(code);
      else if (isApiError(error) && error.kind === "unauthorized")
        setSyncBlocker("gateway_access");
      setSyncError(error instanceof Error ? error.message : "Sync failed.");
    } finally {
      setSyncing(false);
    }
  };
  return {
    account,
    confirmedAccount,
    confirmedSync,
    sync,
    teams,
    syncing,
    syncError,
    syncBlocker,
    syncReceipt,
    syncResult,
    syncAttention,
    runSync,
    loadTeams() {
      if (!teamsWanted()) setTeamsWanted(true);
    },
    /** Recheck settings after external recovery; the next sync verifies them. */
    refresh() {
      setSyncBlocker(null);
      setSyncError(null);
      refreshStatus();
    },
  };
}

export type FolkState = ReturnType<typeof createFolkState>;
