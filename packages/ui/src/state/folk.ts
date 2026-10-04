import { createSignal } from "solid-js";

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
  const teams = createLoader(
    () => (teamsWanted() ? true : null),
    async (_key, signal) => client.getTeams(signal),
  );
  return {
    account,
    sync,
    teams,
    /** Re-read account, sync and (once requested) teams; current data stays visible. */
    refresh() {
      account.reload();
      sync.reload();
      if (teamsWanted()) teams.reload();
      else setTeamsWanted(true);
    },
  };
}

export type FolkState = ReturnType<typeof createFolkState>;
