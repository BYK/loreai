/**
 * Gateway connection state, derived from the outcome of API calls rather
 * than a dedicated probe: the shell reports what the last read actually
 * experienced. There is no auth/sync REST surface yet (docs/api-inventory.md),
 * so "unauthorized" means the gateway refused or hid the management API from
 * this browser (remote peer without LORE_ALLOW_REMOTE_MANAGEMENT, or a token
 * requirement), not a per-user login.
 */
import {
  createContext,
  createSignal,
  useContext,
  type Accessor,
} from "solid-js";

import { isApiError } from "./api";

export type ConnectionState =
  | "checking"
  | "reachable"
  | "unreachable"
  | "unauthorized";

export interface ConnectionStore {
  state: Accessor<ConnectionState>;
  detail: Accessor<string | null>;
  /** Record a successful read. */
  markReachable(): void;
  /** Record a failed read; only connectivity-class failures change the state. */
  markError(error: unknown): void;
}

export function createConnectionStore(): ConnectionStore {
  const [state, setState] = createSignal<ConnectionState>("checking");
  const [detail, setDetail] = createSignal<string | null>(null);
  return {
    state,
    detail,
    markReachable() {
      setState("reachable");
      setDetail(null);
    },
    markError(error) {
      if (!isApiError(error)) {
        setState("unreachable");
        setDetail(error instanceof Error ? error.message : String(error));
        return;
      }
      switch (error.kind) {
        case "unreachable":
          setState("unreachable");
          setDetail(error.message);
          return;
        case "unauthorized":
          setState("unauthorized");
          setDetail(error.message);
          return;
        default:
          // A 404 for a single record or a validation failure means the
          // gateway answered — the connection itself is fine.
          setState("reachable");
          setDetail(null);
      }
    },
  };
}

export const ConnectionContext = createContext<ConnectionStore>();

export function useConnection(): ConnectionStore {
  const store = useContext(ConnectionContext);
  if (!store) {
    throw new Error("useConnection must be used inside <ConnectionProvider>");
  }
  return store;
}

export const CONNECTION_LABEL: Record<ConnectionState, string> = {
  checking: "Connecting to memory…",
  reachable: "Memory connected",
  unreachable: "Gateway unreachable",
  unauthorized: "Management not authorized",
};
