import type { ParentComponent } from "solid-js";
import { createContext, useContext } from "solid-js";

import { api, isAbortError, type ApiClient } from "~/lib/api";
import {
  ConnectionContext,
  createConnectionStore,
  type ConnectionStore,
} from "~/lib/connection";
import type { Loader } from "~/lib/loader";
import type { ProjectSummary } from "~/contracts";
import { openLoreDb, type LoreUiDb } from "~/db";
import { createAppState, type AppState } from "~/state";

export interface Workspace {
  client: ApiClient;
  /** `state.projects.list` — kept as a top-level field for existing callers. */
  projects: Loader<ProjectSummary[]>;
  connection: ConnectionStore;
  state: AppState;
  projectById: (id: string | null | undefined) => ProjectSummary | undefined;
  /** Runs a read against the gateway and mirrors its outcome into the connection state. */
  tracked: <T>(read: () => Promise<T>) => Promise<T>;
}

const WorkspaceContext = createContext<Workspace>();

export function useWorkspace(): Workspace {
  const ws = useContext(WorkspaceContext);
  if (!ws)
    throw new Error("useWorkspace must be used inside <WorkspaceProvider>");
  return ws;
}

/**
 * Loads the project list once for the whole shell and owns the connection
 * store. `client` and `db` are injectable so tests can feed canned
 * responses and a fake-indexeddb-backed (or null) cache.
 */
export const WorkspaceProvider: ParentComponent<{
  client?: ApiClient;
  db?: Promise<LoreUiDb | null>;
}> = (props) => {
  const client = props.client ?? api;
  const connection = createConnectionStore();

  const tracked = async <T,>(read: () => Promise<T>): Promise<T> => {
    try {
      const value = await read();
      connection.markReachable();
      return value;
    } catch (error) {
      if (!isAbortError(error)) connection.markError(error);
      throw error;
    }
  };

  const state = createAppState({
    client,
    db: props.db ?? openLoreDb(),
    tracked,
  });

  const ws: Workspace = {
    client,
    projects: state.projects.list,
    connection,
    state,
    projectById: state.projects.byId,
    tracked,
  };

  return (
    <ConnectionContext.Provider value={connection}>
      <WorkspaceContext.Provider value={ws}>
        {props.children}
      </WorkspaceContext.Provider>
    </ConnectionContext.Provider>
  );
};
