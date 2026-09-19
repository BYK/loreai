import type { ParentComponent } from "solid-js";
import { createContext, useContext } from "solid-js";

import { api, isAbortError, type ApiClient } from "~/lib/api";
import {
  ConnectionContext,
  createConnectionStore,
  type ConnectionStore,
} from "~/lib/connection";
import { createLoader, type Loader } from "~/lib/loader";
import type { ProjectSummary } from "~/lib/schemas";

export interface Workspace {
  client: ApiClient;
  projects: Loader<ProjectSummary[]>;
  connection: ConnectionStore;
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
 * store. `client` is injectable so tests can feed canned responses.
 */
export const WorkspaceProvider: ParentComponent<{ client?: ApiClient }> = (
  props,
) => {
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

  const projects = createLoader(
    () => true,
    (_, signal) => tracked(() => client.listProjects(signal)),
  );

  const ws: Workspace = {
    client,
    projects,
    connection,
    projectById: (id) =>
      id ? projects.data()?.find((p) => p.id === id) : undefined,
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
