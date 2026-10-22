import { createMemo, createSignal, onCleanup, onMount } from "solid-js";

import type { ApiClient } from "~/lib/api";
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
  const [teamsWanted, setTeamsWanted] = createSignal(false);
  const teamIdentity = createMemo<string | null>((previous) => {
    // A pending poll has not changed the account. Retain its options until
    // the result confirms an identity change or a failure.
    if (account.loading()) return previous;
    if (account.error() !== undefined) return null;
    const current = account.data();
    if (current?.state === "anonymous") return "anonymous";
    return current?.signed_in && current.state === "signed_in" && current.user
      ? `user:${current.user.id}`
      : null;
  }, null);
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
  const refresh = () => {
    account.reload();
    sync.reload();
    if (teamsWanted()) teams.reload();
    else setTeamsWanted(true);
  };
  // Navigation can unmount the account surface while a sync is in flight.
  // Keep its guard and result on the workspace, alongside the status reads.
  const [syncing, setSyncing] = createSignal(false);
  const [syncError, setSyncError] = createSignal<string | null>(null);
  const [syncReceipt, setSyncReceipt] = createSignal<string | null>(null);
  const runSync = async () => {
    if (syncing()) return;
    setSyncing(true);
    setSyncError(null);
    setSyncReceipt(null);
    try {
      const result = await client.runSync();
      setSyncReceipt(
        `Sync complete: pushed ${result.pushed}, pulled ${result.pulled}.`,
      );
      refresh();
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : "Sync failed.");
    } finally {
      setSyncing(false);
    }
  };
  return {
    account,
    sync,
    teams,
    syncing,
    syncError,
    syncReceipt,
    runSync,
    loadTeams() {
      if (!teamsWanted()) setTeamsWanted(true);
    },
    /** Re-read account, sync and (once requested) teams; current data stays visible. */
    refresh,
  };
}

export type FolkState = ReturnType<typeof createFolkState>;
