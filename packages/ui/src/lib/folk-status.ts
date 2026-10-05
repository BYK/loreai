import type { AccountStatus, SyncStatus } from "~/contracts";

import { isApiError } from "./api";
import type { ConnectionState } from "./connection";

export type ShellFolkState =
  | "checking"
  | "offline"
  | "hidden"
  | "unavailable"
  | "anonymous"
  | "expired"
  | "sync_disabled"
  | "sync_on";

export type FolkTone = "muted" | "accent" | "gold" | "danger";

export interface ShellFolkSummary {
  state: ShellFolkState;
  label: string;
  tone: FolkTone;
  detail: string;
}

export interface FolkStatusInput {
  connection: ConnectionState;
  account?: AccountStatus;
  accountError?: unknown;
  sync?: SyncStatus;
  syncError?: unknown;
}

const errorKind = (error: unknown) =>
  isApiError(error) ? error.kind : undefined;

/**
 * One shell-level account/sync verdict. `idle` only means the engine is
 * enabled and not running right now — the gateway records no last-success
 * time, so this never claims "synced".
 */
export function summarizeFolkStatus(input: FolkStatusInput): ShellFolkSummary {
  const kinds = [errorKind(input.accountError), errorKind(input.syncError)];
  if (input.connection === "unreachable" || kinds.includes("unreachable")) {
    return {
      state: "offline",
      label: "Offline",
      tone: "danger",
      detail:
        "The gateway is not answering, so account and sync status are unknown.",
    };
  }
  if (input.connection === "unauthorized" || kinds.includes("unauthorized")) {
    return {
      state: "hidden",
      label: "Status hidden",
      tone: "gold",
      detail:
        "This gateway does not expose account or sync status to this browser.",
    };
  }
  if (input.accountError !== undefined) {
    return {
      state: "unavailable",
      label: "Status unavailable",
      tone: "muted",
      detail: "The gateway could not report the account status.",
    };
  }
  const account = input.account;
  if (!account) {
    return {
      state: "checking",
      label: "Checking…",
      tone: "muted",
      detail: "Reading account and sync status from the gateway.",
    };
  }
  if (account.state === "anonymous") {
    return {
      state: "anonymous",
      label: "Not signed in",
      tone: "muted",
      detail:
        "No account is signed in on this gateway, so nothing syncs. Run `lore login` to sign in.",
    };
  }
  if (account.state === "expired") {
    return {
      state: "expired",
      label: "Session expired",
      tone: "gold",
      detail: "Sync is paused until you sign in again with `lore login`.",
    };
  }
  if (input.syncError !== undefined) {
    return {
      state: "unavailable",
      label: "Sync status unavailable",
      tone: "muted",
      detail: "Signed in, but the gateway could not report the sync status.",
    };
  }
  const sync = input.sync;
  if (!sync) {
    return {
      state: "checking",
      label: "Checking…",
      tone: "muted",
      detail: "Reading the sync status from the gateway.",
    };
  }
  if (sync.state === "disabled") {
    return {
      state: "sync_disabled",
      label: "Sync off",
      tone: "muted",
      detail:
        "Signed in, but cloud sync is disabled. Run `lore sync enable` to turn it on.",
    };
  }
  const pending = sync.pending_changes ?? 0;
  return {
    state: "sync_on",
    label: pending > 0 ? `Sync on · ${pending} pending` : "Sync on",
    tone: "accent",
    detail:
      pending > 0
        ? `${pending} local ${pending === 1 ? "change is" : "changes are"} waiting to upload.`
        : "No local changes are waiting to upload.",
  };
}
