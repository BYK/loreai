import { describe, expect, it } from "vitest";

import type { AccountStatus, SyncStatus } from "~/contracts";
import { ApiError } from "~/lib/api";
import { summarizeFolkStatus, type FolkStatusInput } from "~/lib/folk-status";

const signedIn: AccountStatus = {
  signed_in: true,
  user: null,
  provider: null,
  expires_at: null,
  state: "signed_in",
};

const anonymous: AccountStatus = {
  signed_in: false,
  user: null,
  provider: null,
  expires_at: null,
  state: "anonymous",
};

const idle = (pending_changes: number | null = null): SyncStatus => ({
  enabled: true,
  state: "idle",
  pending_changes,
});

const cases: Array<{
  name: string;
  input: FolkStatusInput;
  state: string;
  label: string;
  detail?: string;
}> = [
  {
    name: "an unreachable connection wins over a signed-in account",
    input: { connection: "unreachable", account: signedIn },
    state: "offline",
    label: "Offline",
  },
  {
    name: "an unreachable account error is offline",
    input: {
      connection: "reachable",
      accountError: new ApiError("unreachable", "/api/v1/account", "down"),
    },
    state: "offline",
    label: "Offline",
  },
  {
    name: "an unauthorized connection hides status",
    input: { connection: "unauthorized" },
    state: "hidden",
    label: "Status hidden",
  },
  {
    name: "an unauthorized account error hides status",
    input: {
      connection: "reachable",
      accountError: new ApiError("unauthorized", "/api/v1/account", "hidden"),
    },
    state: "hidden",
    label: "Status hidden",
  },
  {
    name: "an unauthorized sync error hides status",
    input: {
      connection: "reachable",
      account: signedIn,
      syncError: new ApiError("unauthorized", "/api/v1/sync/status", "hidden"),
    },
    state: "hidden",
    label: "Status hidden",
  },
  {
    name: "a generic account error is unavailable",
    input: { connection: "reachable", accountError: new Error("down") },
    state: "unavailable",
    label: "Status unavailable",
  },
  {
    name: "an account that has not loaded is checking",
    input: { connection: "reachable" },
    state: "checking",
    label: "Checking…",
  },
  {
    name: "anonymous accounts explain how to sign in",
    input: { connection: "reachable", account: anonymous },
    state: "anonymous",
    label: "Not signed in",
    detail: "lore login",
  },
  {
    name: "expired accounts show their session state",
    input: {
      connection: "reachable",
      account: { ...signedIn, state: "expired" },
    },
    state: "expired",
    label: "Session expired",
  },
  {
    name: "sync errors for signed-in accounts are unavailable",
    input: {
      connection: "reachable",
      account: signedIn,
      syncError: new Error("down"),
    },
    state: "unavailable",
    label: "Sync status unavailable",
  },
  {
    name: "a signed-in account without sync data is checking",
    input: { connection: "reachable", account: signedIn },
    state: "checking",
    label: "Checking…",
  },
  {
    name: "disabled sync is off",
    input: {
      connection: "reachable",
      account: signedIn,
      sync: { enabled: false, state: "disabled", pending_changes: null },
    },
    state: "sync_disabled",
    label: "Sync off",
  },
  {
    name: "idle sync with no pending changes is on",
    input: {
      connection: "reachable",
      account: signedIn,
      sync: idle(0),
    },
    state: "sync_on",
    label: "Sync on",
    detail: "No local changes are waiting to upload.",
  },
  {
    name: "three pending changes are pluralized",
    input: {
      connection: "reachable",
      account: signedIn,
      sync: idle(3),
    },
    state: "sync_on",
    label: "Sync on · 3 pending",
    detail: "3 local changes are waiting",
  },
  {
    name: "one pending change is singular",
    input: {
      connection: "reachable",
      account: signedIn,
      sync: idle(1),
    },
    state: "sync_on",
    label: "Sync on · 1 pending",
    detail: "1 local change is waiting",
  },
  {
    name: "unknown pending count does not claim a count",
    input: {
      connection: "reachable",
      account: signedIn,
      sync: idle(null),
    },
    state: "sync_on",
    label: "Sync on",
  },
];

describe("summarizeFolkStatus", () => {
  it.each(cases)("$name", ({ input, state, label, detail }) => {
    const summary = summarizeFolkStatus(input);

    expect(summary.state).toBe(state);
    expect(summary.label).toBe(label);
    expect(summary.label).not.toMatch(/synced/i);
    if (detail) expect(summary.detail).toContain(detail);
  });
});
