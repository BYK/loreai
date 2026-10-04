import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@solidjs/testing-library";
import type { JSX } from "solid-js";
import { describe, expect, it, vi } from "vitest";

import type {
  AccountStatus,
  SharingStatus,
  SyncConflict,
  SyncConflictList,
  TeamMembersResponse,
  TeamList,
} from "~/contracts";
import { ConflictsPage } from "~/components/lore/ConflictsPage";
import { SharingPanel } from "~/components/lore/SharingPanel";
import { TeamPage } from "~/components/lore/TeamPage";
import { ApiError, type ApiClient } from "~/lib/api";
import { WorkspaceProvider } from "~/routes/workspace";

const account: AccountStatus = {
  signed_in: true,
  user: { id: "user-me", email: null, display_name: "Admin" },
  provider: "github",
  expires_at: null,
  state: "signed_in",
};

const teams: TeamList = {
  hosted: false,
  teams: [{ id: "team-1", name: "Acme", role: "admin", member_count: 2 }],
};

const memberResponse: TeamMembersResponse = {
  remote: "ok",
  team: { id: "team-1", name: "Acme" },
  my_role: "admin",
  can_manage: true,
  members: [
    {
      user_id: "user-me",
      label: "Admin",
      role: "admin",
      me: true,
    },
    {
      user_id: "user-12345678-90ab-cdef",
      label: null,
      role: "viewer",
      me: false,
    },
  ],
  actions: {
    invite: "available",
    remove: "available",
    set_role: "available",
    add_by_id: "cli_only",
    offline_invite: "cli_only",
    list_invites: "unsupported",
    revoke_invite: "unsupported",
  },
};

const manualSharing: SharingStatus = {
  linked: true,
  team: { id: "team-1", name: "Acme" },
  policy: {
    effective: "manual",
    project_override: "manual",
    team_default: "auto",
  },
  state: "linked",
  detail: null,
};

const automaticSharing: SharingStatus = {
  ...manualSharing,
  policy: {
    ...manualSharing.policy,
    effective: "auto",
    project_override: null,
  },
};

const conflicts: SyncConflictList = {
  available: true,
  complete: true,
  conflicts: [
    {
      id: 17,
      table: "knowledge",
      row_id: "knowledge-1",
      detected_at: "2026-09-20T12:00:00.000Z",
      resolution: "remote_upsert_wins",
      recoverable: true,
      unrecoverable_reason: null,
      local: {
        title: "Local decision",
        content: "Keep SQLite.",
        category: "decision",
      },
      current: {
        version_id: "version-2",
        version: 2,
        title: "Remote decision",
        content: "Use another store.",
      },
    },
  ],
};

function clientWith(partial: Partial<ApiClient>): ApiClient {
  return {
    listProjects: async () => [],
    getAccount: async () => account,
    getTeams: async () => teams,
    getSyncStatus: async () => ({
      enabled: true,
      state: "idle",
      pending_changes: 0,
    }),
    getTeamMembers: async () => memberResponse,
    inviteTeamMember: async () => ({
      invite: {
        team_id: "team-1",
        role: "viewer",
        expires_in_days: 14,
        token: "invite-secret-token",
        accept_command: "lore team accept invite-secret-token",
        emailed: false,
      },
    }),
    setTeamMemberRole: async () => ({
      member: { user_id: "user-12345678-90ab-cdef", role: "editor" },
    }),
    removeTeamMember: async () => ({
      removed: "user-12345678-90ab-cdef",
      new_epoch: 2,
      rewrapped: 3,
      skipped_count: 1,
    }),
    getProjectSharing: async () => automaticSharing,
    requireProjectSharingReview: async () => manualSharing,
    listSyncConflicts: async () => conflicts,
    keepSyncConflictLocal: async () => ({
      kept: "local",
      current: {
        version_id: "version-3",
        version: 3,
        title: "Local decision",
        content: "Keep SQLite.",
      },
    }),
    discardSyncConflict: async () => ({ discarded: 17 }),
    ...partial,
  } as unknown as ApiClient;
}

function mount(component: () => JSX.Element, client: ApiClient) {
  return render(() => (
    <WorkspaceProvider client={client} db={Promise.resolve(null)}>
      {component()}
    </WorkspaceProvider>
  ));
}

describe("TeamPage", () => {
  it("shows hosted mode before the anonymous state", async () => {
    mount(
      () => <TeamPage />,
      clientWith({
        getAccount: async () => ({
          ...account,
          signed_in: false,
          user: null,
          provider: null,
          state: "anonymous",
        }),
        getTeams: async () => ({ hosted: true, teams: [] }),
      }),
    );
    expect(
      await screen.findByText(
        "Team membership changes are not available in hosted mode.",
      ),
    ).toBeVisible();
    expect(screen.queryByText("Sign in with `lore login`")).toBeNull();
  });

  it("shows fallback teammate identity and applies the role receipt", async () => {
    const setTeamMemberRole = vi.fn<ApiClient["setTeamMemberRole"]>(
      async () => ({
        member: { user_id: "user-12345678-90ab-cdef", role: "editor" },
      }),
    );
    mount(() => <TeamPage />, clientWith({ setTeamMemberRole }));

    await screen.findByTestId("team-members");
    expect(screen.getByText("Teammate user-123")).toHaveAttribute(
      "title",
      "user-12345678-90ab-cdef",
    );
    const role = screen.getByRole("combobox", {
      name: "Role for Teammate user-123",
    });
    fireEvent.change(role, { target: { value: "editor" } });
    await screen.findByText("user-12345678-90ab-cdef is now editor.");
    expect(setTeamMemberRole).toHaveBeenCalledWith(
      "team-1",
      "user-12345678-90ab-cdef",
      "editor",
      "viewer",
    );
  });

  it("restores the server-known role after a failed role change", async () => {
    const setTeamMemberRole = vi.fn<ApiClient["setTeamMemberRole"]>(
      async () => {
        throw new ApiError(
          "forbidden",
          "/teams/team-1/members/user-12345678-90ab-cdef/role",
          "Only team admins can change or remove members.",
          403,
          "not_admin",
        );
      },
    );
    mount(() => <TeamPage />, clientWith({ setTeamMemberRole }));

    const role = await screen.findByRole("combobox", {
      name: "Role for Teammate user-123",
    });
    expect(role).toHaveValue("viewer");
    fireEvent.change(role, { target: { value: "editor" } });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Only team admins can change or remove members.",
    );
    expect(role).toHaveValue("viewer");
  });

  it("keeps a stale-member role notice after reloading the team", async () => {
    const userId = "user-12345678-90ab-cdef";
    const updatedMembers: TeamMembersResponse = {
      ...memberResponse,
      members: memberResponse.members.map((member) =>
        member.user_id === userId ? { ...member, role: "editor" } : member,
      ),
    };
    const getTeamMembers = vi
      .fn<ApiClient["getTeamMembers"]>()
      .mockResolvedValueOnce(memberResponse)
      .mockResolvedValueOnce(updatedMembers);
    const setTeamMemberRole = vi.fn<ApiClient["setTeamMemberRole"]>(
      async () => {
        throw new ApiError(
          "http",
          "/teams/team-1/members/user-12345678-90ab-cdef/role",
          "Team member role changed; reload the team.",
          409,
          "stale_member",
        );
      },
    );
    mount(
      () => <TeamPage />,
      clientWith({ getTeamMembers, setTeamMemberRole }),
    );

    const role = await screen.findByRole("combobox", {
      name: "Role for Teammate user-123",
    });
    fireEvent.change(role, { target: { value: "editor" } });
    const notice = await screen.findByTestId("team-stale-member-notice");
    expect(notice).toHaveTextContent(
      "Teammate user-123's role changed to Editor since you loaded the team.",
    );
    expect(notice).toHaveTextContent("The list has been reloaded.");
    expect(
      screen.getByRole("combobox", {
        name: "Role for Teammate user-123",
      }),
    ).toHaveValue("editor");
    expect(getTeamMembers).toHaveBeenCalledTimes(2);
  });

  it("confirms removal and keeps the invite token only inside its receipt dialog", async () => {
    const inviteTeamMember = vi.fn<ApiClient["inviteTeamMember"]>(async () => ({
      invite: {
        team_id: "team-1",
        role: "viewer",
        expires_in_days: 14,
        token: "invite-secret-token",
        accept_command: "lore team accept invite-secret-token",
        emailed: false,
      },
    }));
    const removeTeamMember = vi.fn<ApiClient["removeTeamMember"]>(async () => ({
      removed: "user-12345678-90ab-cdef",
      new_epoch: 2,
      rewrapped: 3,
      skipped_count: 1,
    }));
    mount(
      () => <TeamPage />,
      clientWith({ inviteTeamMember, removeTeamMember }),
    );
    await screen.findByTestId("team-members");

    const row = screen
      .getAllByTestId("team-member-row")
      .find((item) =>
        item.getAttribute("data-user-id")?.startsWith("user-123"),
      );
    if (!row) throw new Error("teammate row missing");
    fireEvent.click(within(row).getByRole("button", { name: "Remove" }));
    const removeDialog = await screen.findByTestId("team-remove-confirmation");
    expect(removeDialog).toHaveTextContent("team key");
    expect(removeDialog).toHaveTextContent("cannot be revoked");
    fireEvent.click(
      within(removeDialog).getByRole("button", { name: "Remove member" }),
    );
    expect(await screen.findByTestId("team-removal-receipt")).toHaveTextContent(
      "1 member(s) without a published key",
    );
    expect(removeTeamMember).toHaveBeenCalledWith(
      "team-1",
      "user-12345678-90ab-cdef",
      "viewer",
    );

    fireEvent.click(screen.getByRole("button", { name: "Create invite" }));
    const inviteDialog = await screen.findByTestId("team-invite-receipt");
    expect(inviteDialog).toHaveTextContent("invite-secret-token");
    expect(inviteDialog).toHaveTextContent(
      "lore team accept invite-secret-token",
    );
    expect(inviteTeamMember).toHaveBeenCalledWith("team-1", {
      role: "viewer",
    });
    fireEvent.click(within(inviteDialog).getByRole("button", { name: "Done" }));
    await waitFor(() =>
      expect(screen.queryByText("invite-secret-token")).not.toBeInTheDocument(),
    );
  });

  it("keeps retryable removal errors inside the open dialog", async () => {
    const removeTeamMember = vi.fn<ApiClient["removeTeamMember"]>(async () => {
      throw new ApiError(
        "http",
        "/teams/team-1/members/user-12345678-90ab-cdef/remove",
        "The last team admin cannot be removed.",
        409,
        "last_admin",
      );
    });
    mount(() => <TeamPage />, clientWith({ removeTeamMember }));

    await screen.findByTestId("team-members");
    const row = screen
      .getAllByTestId("team-member-row")
      .find(
        (item) =>
          item.getAttribute("data-user-id") === "user-12345678-90ab-cdef",
      );
    if (!row) throw new Error("teammate row missing");
    fireEvent.click(within(row).getByRole("button", { name: "Remove" }));
    const dialog = await screen.findByTestId("team-remove-confirmation");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Remove member" }),
    );

    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("last team admin");
    expect(alert).toHaveFocus();
    expect(
      within(dialog).getByRole("button", { name: "Remove member" }),
    ).toBeEnabled();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("reloads stale removal errors from the dialog and preserves the role notice", async () => {
    const userId = "user-12345678-90ab-cdef";
    const updatedMembers: TeamMembersResponse = {
      ...memberResponse,
      members: memberResponse.members.map((member) =>
        member.user_id === userId ? { ...member, role: "editor" } : member,
      ),
    };
    const getTeamMembers = vi
      .fn<ApiClient["getTeamMembers"]>()
      .mockResolvedValueOnce(memberResponse)
      .mockResolvedValueOnce(updatedMembers);
    const removeTeamMember = vi.fn<ApiClient["removeTeamMember"]>(async () => {
      throw new ApiError(
        "http",
        "/teams/team-1/members/user-12345678-90ab-cdef/remove",
        "Team member role changed; reload the team.",
        409,
        "stale_member",
      );
    });
    mount(() => <TeamPage />, clientWith({ getTeamMembers, removeTeamMember }));

    await screen.findByTestId("team-members");
    const row = screen
      .getAllByTestId("team-member-row")
      .find((item) => item.getAttribute("data-user-id") === userId);
    if (!row) throw new Error("teammate row missing");
    fireEvent.click(within(row).getByRole("button", { name: "Remove" }));
    const dialog = await screen.findByTestId("team-remove-confirmation");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Remove member" }),
    );

    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveFocus();
    expect(
      within(dialog).getByRole("button", { name: "Remove member" }),
    ).toBeDisabled();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Reload team" }),
    );
    expect(
      await screen.findByTestId("team-stale-member-notice"),
    ).toHaveTextContent("Teammate user-123's role changed to Editor");
    expect(screen.queryByTestId("team-remove-confirmation")).toBeNull();
    expect(getTeamMembers).toHaveBeenCalledTimes(2);
  });

  it("shows sync-disabled messaging and the action error", async () => {
    mount(
      () => <TeamPage />,
      clientWith({
        getSyncStatus: async () => ({
          enabled: false,
          state: "disabled",
          pending_changes: null,
        }),
        setTeamMemberRole: async () => {
          throw new ApiError(
            "http",
            "/teams/team-1/members/user-12345678-90ab-cdef/role",
            "Sync is not enabled.",
            409,
            "sync_disabled",
          );
        },
      }),
    );
    await screen.findByTestId("team-sync-disabled");
    fireEvent.change(
      screen.getByRole("combobox", { name: "Role for Teammate user-123" }),
      { target: { value: "editor" } },
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Enable sync with `lore sync enable`",
    );
  });
});

describe("ConflictsPage", () => {
  it("confirms local recovery and updates from the recovery receipt", async () => {
    const keepSyncConflictLocal = vi.fn<ApiClient["keepSyncConflictLocal"]>(
      async () => ({
        kept: "local",
        current: {
          version_id: "version-3",
          version: 3,
          title: "Local decision",
          content: "Keep SQLite.",
        },
      }),
    );
    mount(() => <ConflictsPage />, clientWith({ keepSyncConflictLocal }));

    const card = await screen.findByTestId("conflict-card");
    expect(card).toHaveTextContent("Your discarded version");
    expect(card).toHaveTextContent("Current version");
    fireEvent.click(within(card).getByRole("button", { name: "Keep mine" }));
    const dialog = await screen.findByTestId("conflict-action-confirmation");
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep mine" }));
    expect(
      await screen.findByTestId("conflict-recovery-receipt"),
    ).toHaveTextContent("version-3");
    expect(screen.queryByTestId("conflict-card")).not.toBeInTheDocument();
    expect(keepSyncConflictLocal).toHaveBeenCalledWith(17, "version-2");
  });

  it("keeps stale keep errors in the dialog and reloads from there", async () => {
    const listSyncConflicts = vi
      .fn<ApiClient["listSyncConflicts"]>()
      .mockResolvedValue(conflicts);
    mount(
      () => <ConflictsPage />,
      clientWith({
        listSyncConflicts,
        keepSyncConflictLocal: async () => {
          throw new ApiError(
            "http",
            "/sync/conflicts/17/keep-local",
            "Knowledge entry changed",
            409,
            "stale_version",
          );
        },
      }),
    );
    const card = await screen.findByTestId("conflict-card");
    fireEvent.click(within(card).getByRole("button", { name: "Keep mine" }));
    const dialog = await screen.findByTestId("conflict-action-confirmation");
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep mine" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("Knowledge entry changed");
    expect(alert).toHaveFocus();
    expect(
      within(dialog).getByRole("button", { name: "Keep mine" }),
    ).toBeDisabled();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Reload conflicts" }),
    );
    expect(
      screen.queryByTestId("conflict-action-confirmation"),
    ).not.toBeInTheDocument();
    await waitFor(() => expect(listSyncConflicts).toHaveBeenCalledTimes(2));
  });

  it("keeps a missing discarded conflict in the dialog and reloads the list", async () => {
    const listSyncConflicts = vi
      .fn<ApiClient["listSyncConflicts"]>()
      .mockResolvedValueOnce(conflicts)
      .mockResolvedValueOnce({
        available: true,
        complete: true,
        conflicts: [],
      });
    mount(
      () => <ConflictsPage />,
      clientWith({
        listSyncConflicts,
        discardSyncConflict: async () => {
          throw new ApiError(
            "not_found",
            "/sync/conflicts/17/discard",
            "Sync conflict 17 not found",
            404,
            "not_found",
          );
        },
      }),
    );
    const card = await screen.findByTestId("conflict-card");
    fireEvent.click(within(card).getByRole("button", { name: "Discard mine" }));
    const dialog = await screen.findByTestId("conflict-action-confirmation");
    fireEvent.click(within(dialog).getByRole("button", { name: "Discard" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("already resolved elsewhere");
    expect(alert).toHaveFocus();
    expect(
      within(dialog).getByRole("button", { name: "Discard" }),
    ).toBeDisabled();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Reload conflicts" }),
    );
    expect(
      screen.queryByTestId("conflict-action-confirmation"),
    ).not.toBeInTheDocument();
    expect(await screen.findByText("No sync conflicts")).toBeVisible();
    expect(listSyncConflicts).toHaveBeenCalledTimes(2);
  });

  it("explains non-knowledge conflicts and confirms discard when truncated", async () => {
    const nonKnowledgeConflict: SyncConflict = {
      ...conflicts.conflicts[0]!,
      id: 18,
      table: "sessions",
      row_id: "session-1",
      recoverable: false,
      unrecoverable_reason: "not_knowledge",
      local: null,
      current: null,
    };
    const discardSyncConflict = vi.fn<ApiClient["discardSyncConflict"]>(
      async () => ({ discarded: 18 }),
    );
    mount(
      () => <ConflictsPage />,
      clientWith({
        listSyncConflicts: async () => ({
          available: true,
          complete: false,
          conflicts: [nonKnowledgeConflict],
        }),
        discardSyncConflict,
      }),
    );
    expect(await screen.findByTestId("conflicts-truncated")).toBeVisible();
    const card = await screen.findByTestId("conflict-card");
    expect(card).toHaveTextContent(
      "This conflict affects sessions, not knowledge.",
    );
    expect(
      within(card).queryByRole("button", { name: "Keep mine" }),
    ).not.toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: "Discard mine" }));
    const dialog = await screen.findByTestId("conflict-action-confirmation");
    fireEvent.click(within(dialog).getByRole("button", { name: "Discard" }));
    await screen.findByText("No sync conflicts");
    expect(discardSyncConflict).toHaveBeenCalledWith(18);
  });
});

describe("SharingPanel review action", () => {
  it("confirms the change and replaces policy data from the receipt", async () => {
    const requireProjectSharingReview = vi.fn<
      ApiClient["requireProjectSharingReview"]
    >(async () => manualSharing);
    mount(
      () => <SharingPanel projectId="project-1" />,
      clientWith({ requireProjectSharingReview }),
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Require review" }),
    );
    expect(
      await screen.findByTestId("sharing-policy-confirmation"),
    ).toHaveTextContent("only be enabled from the CLI");
    fireEvent.click(
      within(screen.getByTestId("sharing-policy-confirmation")).getByRole(
        "button",
        { name: "Require review" },
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId("sharing-summary")).toHaveTextContent(
        "policy: manual",
      ),
    );
    expect(requireProjectSharingReview).toHaveBeenCalledWith("project-1", null);
    expect(
      screen.queryByRole("button", { name: "Require review" }),
    ).not.toBeInTheDocument();
  });

  it("keeps stale policy errors in the dialog and reloads from there", async () => {
    const getProjectSharing = vi
      .fn<ApiClient["getProjectSharing"]>()
      .mockResolvedValueOnce(automaticSharing)
      .mockResolvedValueOnce(manualSharing);
    const requireProjectSharingReview = vi.fn<
      ApiClient["requireProjectSharingReview"]
    >(async () => {
      throw new ApiError(
        "http",
        "/projects/project-1/sharing/policy",
        "Project sharing policy changed; reload the project.",
        409,
        "stale_policy",
      );
    });
    const client = clientWith({
      getProjectSharing,
      requireProjectSharingReview,
    });
    mount(() => <SharingPanel projectId="project-1" />, client);

    fireEvent.click(
      await screen.findByRole("button", { name: "Require review" }),
    );
    fireEvent.click(
      within(screen.getByTestId("sharing-policy-confirmation")).getByRole(
        "button",
        { name: "Require review" },
      ),
    );
    const dialog = screen.getByTestId("sharing-policy-confirmation");
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("Project sharing policy changed");
    expect(alert).toHaveFocus();
    expect(
      within(dialog).getByRole("button", { name: "Require review" }),
    ).toBeDisabled();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Reload status" }),
    );
    expect(
      screen.queryByTestId("sharing-policy-confirmation"),
    ).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId("sharing-summary")).toHaveTextContent(
        "policy: manual",
      ),
    );
    expect(getProjectSharing).toHaveBeenCalledTimes(2);
    expect(requireProjectSharingReview).toHaveBeenCalledTimes(1);
  });
});
