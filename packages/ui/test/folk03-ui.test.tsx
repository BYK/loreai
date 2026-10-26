import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@solidjs/testing-library";
import { createSignal, type JSX } from "solid-js";
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
import { TeamParityActions } from "~/components/lore/TeamParityActions";
import { TeamPage } from "~/components/lore/TeamPage";
import { ApiError, type ApiClient } from "~/lib/api";
import { WorkspaceProvider, useWorkspace } from "~/routes/workspace";
import type { FolkState } from "~/state/folk";

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
      label: "Jordan",
      role: "viewer",
      me: false,
    },
  ],
  actions: {
    invite: "available",
    remove: "available",
    set_role: "available",
    add_by_id: "available",
    offline_invite: "available",
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
  auto_share: false,
  review_required: false,
  state: "linked",
  detail: null,
};

const automaticSharing: SharingStatus = {
  ...manualSharing,
  policy: {
    ...manualSharing.policy,
    effective: "auto",
    project_override: "auto",
  },
  auto_share: true,
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
    runSync: async () => ({
      pushed: 0,
      pulled: 0,
      conflicts: 0,
      skipped: 0,
    }),
    getTeamReviewPolicy: async () => ({ policy: "required" }),
    setTeamReviewPolicy: async (
      _teamId: string,
      policy: "required" | "optional",
    ) => ({ policy }),
    createTeam: async () => ({ team: { id: "team-2", name: "Team" } }),
    addTeamMemberById: async (
      _teamId: string,
      userId: string,
      role: "admin" | "editor" | "viewer",
    ) => ({
      member: { user_id: userId, role, wrapped: true },
    }),
    acceptTeamInvite: async () => ({
      joined: { scope_id: "team-1", role: "editor" },
    }),
    getOrganizations: async () => ({ organizations: [] }),
    discoverTeamContributors: async () => ({ repos: [] }),
    getDomainJoinRequests: async () => ({ requests: [] }),
    claimOrganizationDomain: async () => ({ claimed: "example.test" }),
    requestOrganizationJoin: async () => ({ request_id: "request-1" }),
    decideDomainJoinRequest: async (
      _orgId: string,
      requestId: string,
      decision: "approve" | "reject",
    ) => ({
      request_id: requestId,
      status: decision === "approve" ? "approved" : "rejected",
    }),
    linkProjectToTeam: async () => automaticSharing,
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
      unlinked_projects: 0,
    }),
    getProjectSharing: async () => automaticSharing,
    setProjectAutoShare: async () => manualSharing,
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

function mount(
  component: () => JSX.Element,
  client: ApiClient,
  path = "/team",
) {
  const history = createMemoryHistory();
  history.set({ value: path });
  const view = render(() => (
    <MemoryRouter history={history}>
      <Route
        path="*"
        component={() => (
          <WorkspaceProvider client={client} db={Promise.resolve(null)}>
            {component()}
          </WorkspaceProvider>
        )}
      />
    </MemoryRouter>
  ));
  return { ...view, history };
}

function deferred<T>() {
  let resolvePromise: (value: T) => void = () => {
    throw new Error("deferred promise was not initialized");
  };
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: (value: T) => resolvePromise(value) };
}

describe("TeamPage", () => {
  it("starts with members and uses URL-backed invitation and settings sections", async () => {
    const view = mount(
      () => <TeamPage />,
      clientWith({ getTeamMembers: async () => memberResponse }),
    );
    await screen.findByTestId("team-members");
    expect(screen.getByRole("link", { name: "Members" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.queryByRole("switch", { name: "Require review" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Create invite" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Invite teammate" }));
    expect(
      await screen.findByRole("button", { name: "Create invite" }),
    ).toBeInTheDocument();
    expect(view.history.get()).toBe("/team?section=invitations");
    expect(
      screen.getByRole("heading", { name: "Invite a teammate" }),
    ).toHaveFocus();
    expect(screen.getByRole("link", { name: "Invitations" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    fireEvent.click(screen.getByRole("link", { name: "Settings" }));
    expect(
      await screen.findByRole("switch", { name: "Require review" }),
    ).toBeInTheDocument();
  });

  it("restores the invitations URL section", async () => {
    mount(
      () => <TeamPage />,
      clientWith({ getTeamMembers: async () => memberResponse }),
      "/team?section=invitations",
    );
    expect(
      await screen.findByRole("button", { name: "Create invite" }),
    ).toBeInTheDocument();
  });

  it("treats an unknown URL section as members without exposing advanced controls", async () => {
    mount(
      () => <TeamPage />,
      clientWith({ getTeamMembers: async () => memberResponse }),
      "/team?section=%3Cscript%3Esettings",
    );
    expect(await screen.findByTestId("team-members")).toBeVisible();
    expect(screen.getByRole("link", { name: "Members" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.queryByRole("switch", { name: "Require review" })).toBeNull();
  });

  it("keeps invitation failure visible after navigating while the request is pending", async () => {
    let reject!: (reason: Error) => void;
    const inviteTeamMember = vi.fn<ApiClient["inviteTeamMember"]>(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    const view = mount(
      () => <TeamPage />,
      clientWith({
        getTeamMembers: async () => memberResponse,
        inviteTeamMember,
      }),
      "/team?section=invitations",
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Create invite" }),
    );
    expect(inviteTeamMember).toHaveBeenCalledTimes(1);
    view.history.set({ value: "/team?section=settings" });
    expect(
      await screen.findByRole("switch", { name: "Require review" }),
    ).toBeInTheDocument();
    reject(new Error("Invitation service unavailable"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Invitation service unavailable",
    );
    expect(screen.getByRole("alert")).toBeVisible();
    expect(inviteTeamMember).toHaveBeenCalledTimes(1);
  });

  it("keeps an invite receipt open across history navigation and restores section focus", async () => {
    const view = mount(
      () => <TeamPage />,
      clientWith({ getTeamMembers: async () => memberResponse }),
      "/team?section=invitations",
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Create invite" }),
    );
    const dialog = await screen.findByTestId("team-invite-receipt");
    view.history.set({ value: "/team?section=settings" });
    expect(dialog).toBeVisible();
    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    await waitFor(() =>
      expect(screen.getByRole("link", { name: "Settings" })).toHaveFocus(),
    );
  });

  it("keeps advanced-tool errors visible after navigating away from settings", async () => {
    let reject!: (reason: Error) => void;
    const discoverTeamContributors = vi.fn<
      ApiClient["discoverTeamContributors"]
    >(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    const view = mount(
      () => <TeamPage />,
      clientWith({
        getTeamMembers: async () => memberResponse,
        discoverTeamContributors,
      }),
      "/team?section=settings",
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Find contributors" }),
    );
    expect(discoverTeamContributors).toHaveBeenCalledTimes(1);
    view.history.set({ value: "/team" });
    reject(new Error("Contributor discovery unavailable"));
    await waitFor(() =>
      expect(
        screen
          .getAllByRole("alert")
          .some((element) =>
            element.textContent?.includes("Contributor discovery unavailable"),
          ),
      ).toBe(true),
    );
  });

  it("restores active-section focus when a settings dialog closes after history navigation", async () => {
    const view = mount(
      () => <TeamPage />,
      clientWith({ getTeamMembers: async () => memberResponse }),
      "/team?section=settings",
    );
    fireEvent.click(await screen.findByRole("button", { name: "Join a team" }));
    const dialog = await screen.findByTestId("team-join-dialog");
    view.history.set({ value: "/team" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.getByRole("link", { name: "Members" })).toHaveFocus(),
    );
  });

  it("keeps no-team create and join recovery visible while advanced settings require disclosure", async () => {
    mount(
      () => <TeamPage />,
      clientWith({ getTeams: async () => ({ hosted: false, teams: [] }) }),
    );
    await screen.findByText("No team memberships");
    expect(screen.getByTestId("team-create-form")).toBeVisible();
    expect(screen.getByRole("button", { name: "Join a team" })).toBeVisible();
    expect(screen.getByTestId("organization-domains")).not.toBeVisible();
    const settings = screen.getByRole("button", { name: "Team settings" });
    settings.focus();
    fireEvent.click(settings);
    expect(settings).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("organization-domains")).toBeVisible();
    expect(settings).toHaveFocus();
    fireEvent.click(settings);
    expect(screen.getByTestId("organization-domains")).not.toBeVisible();
    expect(screen.getByTestId("team-create-form")).toBeVisible();
  });

  it.each(["/team", "/team?section=settings"])(
    "surfaces a no-team organization failure above closed settings at %s and clears it",
    async (path) => {
      mount(
        () => <TeamPage />,
        clientWith({
          getTeams: async () => ({ hosted: false, teams: [] }),
          getOrganizations: async () => {
            throw new Error("Organization service unavailable");
          },
        }),
        path,
      );
      await screen.findByText("No team memberships");
      await waitFor(() =>
        expect(
          screen
            .getAllByRole("alert")
            .some(
              (alert) =>
                alert.textContent?.includes(
                  "Organization service unavailable",
                ) && !alert.closest("[hidden]"),
            ),
        ).toBe(true),
      );
      expect(
        screen.queryByRole("link", { name: "Open team settings" }),
      ).toBeNull();
      expect(screen.getByTestId("organization-domains")).not.toBeVisible();
      expect(screen.getByTestId("team-create-form")).toBeVisible();
      expect(screen.getByRole("button", { name: "Join a team" })).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "Team settings" }));
      fireEvent.input(
        screen.getByLabelText("Organization ID for a join request"),
        { target: { value: "org-1" } },
      );
      fireEvent.input(screen.getByLabelText("Verified email domain"), {
        target: { value: "example.test" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Request to join" }));
      await waitFor(() =>
        expect(
          screen.queryByText("Organization service unavailable"),
        ).toBeNull(),
      );
    },
  );

  it("hides prior members when a team reload fails and ignores late responses", async () => {
    const firstTeamResponse: TeamMembersResponse = {
      ...memberResponse,
      team: { id: "team-1", name: "Acme" },
      members: memberResponse.members.map((member) => ({
        ...member,
        label: member.me ? "Admin A" : "Alice",
      })),
    };
    const firstRequest = deferred<TeamMembersResponse>();
    const getTeamMembers = vi
      .fn<ApiClient["getTeamMembers"]>()
      .mockImplementationOnce(() => firstRequest.promise)
      .mockRejectedValueOnce(new Error("Beta is unavailable"));
    mount(
      () => <TeamPage />,
      clientWith({
        getTeams: async () => ({
          hosted: false,
          teams: [
            { id: "team-1", name: "Acme", role: "admin", member_count: 2 },
            { id: "team-2", name: "Beta", role: "admin", member_count: 2 },
          ],
        }),
        getTeamMembers,
      }),
    );

    await waitFor(() => expect(getTeamMembers).toHaveBeenCalledWith("team-1"));
    fireEvent.change(screen.getByRole("combobox", { name: "Team" }), {
      target: { value: "team-2" },
    });
    await waitFor(() => expect(getTeamMembers).toHaveBeenCalledWith("team-2"));
    expect(
      await screen.findByText("The team could not be loaded"),
    ).toBeVisible();
    expect(screen.queryByText("Alice")).toBeNull();
    expect(screen.queryByText("Admin A")).toBeNull();
    expect(screen.queryByTestId("team-members")).toBeNull();

    firstRequest.resolve(firstTeamResponse);
    await firstRequest.promise;
    await Promise.resolve();
    await Promise.resolve();

    expect(screen.getByRole("combobox", { name: "Team" })).toHaveValue(
      "team-2",
    );
    expect(screen.queryByText("Alice")).toBeNull();
    expect(screen.queryByText("Admin A")).toBeNull();
    expect(screen.queryByTestId("team-members")).toBeNull();
  });

  it("ignores a pending roster response after membership disappears", async () => {
    const emptyTeams: TeamList = { hosted: false, teams: [] };
    const refreshedTeams = deferred<TeamList>();
    const lateMembers = deferred<TeamMembersResponse>();
    const getTeams = vi
      .fn<ApiClient["getTeams"]>()
      .mockResolvedValueOnce(teams)
      .mockImplementationOnce(() => refreshedTeams.promise);
    const getTeamMembers = vi.fn<ApiClient["getTeamMembers"]>(
      () => lateMembers.promise,
    );
    const Page = () => {
      const ws = useWorkspace();
      return (
        <>
          <TeamPage />
          <button onClick={() => ws.state.folk.refresh()}>
            Refresh team test
          </button>
        </>
      );
    };
    mount(() => <Page />, clientWith({ getTeams, getTeamMembers }));
    await waitFor(() => expect(getTeamMembers).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Refresh team test" }));
    await waitFor(() => expect(getTeams).toHaveBeenCalledTimes(2));
    refreshedTeams.resolve(emptyTeams);
    expect(await screen.findByText("No team memberships")).toBeVisible();
    lateMembers.resolve(memberResponse);
    await lateMembers.promise;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(screen.getByText("No team memberships")).toBeVisible();
    expect(screen.queryByTestId("team-members")).toBeNull();
  });

  it("reloads the same team after joining from the no-team state", async () => {
    const emptyTeams: TeamList = { hosted: false, teams: [] };
    const refreshedTeams = deferred<TeamList>();
    const getTeams = vi
      .fn<ApiClient["getTeams"]>()
      .mockResolvedValueOnce(teams)
      .mockImplementationOnce(() => refreshedTeams.promise)
      .mockResolvedValueOnce(teams);
    const getTeamMembers = vi
      .fn<ApiClient["getTeamMembers"]>()
      .mockResolvedValueOnce(memberResponse)
      .mockResolvedValueOnce(memberResponse);
    mount(() => <TeamPage />, clientWith({ getTeams, getTeamMembers }));

    await screen.findByTestId("team-members");
    fireEvent.click(await screen.findByRole("link", { name: "Settings" }));
    fireEvent.click(await screen.findByRole("button", { name: "Join a team" }));
    const firstDialog = await screen.findByTestId("team-join-dialog");
    fireEvent.input(screen.getByTestId("team-invite-token"), {
      target: { value: "invite-token" },
    });
    fireEvent.click(
      within(firstDialog).getByRole("button", { name: "Join team" }),
    );
    await waitFor(() => expect(getTeams).toHaveBeenCalledTimes(2));
    // A joined account's roster must wait for its updated memberships.
    expect(getTeamMembers).toHaveBeenCalledTimes(1);

    refreshedTeams.resolve(emptyTeams);
    expect(await screen.findByText("No team memberships")).toBeVisible();
    fireEvent.click(await screen.findByRole("button", { name: "Join a team" }));
    const secondDialog = await screen.findByTestId("team-join-dialog");
    fireEvent.input(screen.getByTestId("team-invite-token"), {
      target: { value: "invite-token" },
    });
    fireEvent.click(
      within(secondDialog).getByRole("button", { name: "Join team" }),
    );

    await waitFor(() => expect(getTeams).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(getTeamMembers).toHaveBeenCalledTimes(2));
    fireEvent.click(await screen.findByRole("link", { name: "Members" }));
    await waitFor(() =>
      expect(screen.getByTestId("team-members")).toBeVisible(),
    );
  });

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

  it("shows the server member identity and applies the role receipt", async () => {
    const setTeamMemberRole = vi.fn<ApiClient["setTeamMemberRole"]>(
      async () => ({
        member: { user_id: "user-12345678-90ab-cdef", role: "editor" },
      }),
    );
    mount(() => <TeamPage />, clientWith({ setTeamMemberRole }));

    await screen.findByTestId("team-members");
    expect(screen.getByText("Jordan")).not.toHaveAttribute("title");
    expect(
      screen.getByText("Jordan").closest("[data-user-id]"),
    ).toHaveAttribute("data-user-id", "user-12345678-90ab-cdef");
    const role = screen.getByRole("combobox", {
      name: "Role for Jordan",
    });
    fireEvent.change(role, { target: { value: "editor" } });
    await screen.findByText("Jordan is now editor.");
    expect(setTeamMemberRole).toHaveBeenCalledWith(
      "team-1",
      "user-12345678-90ab-cdef",
      "editor",
      "viewer",
    );
  });

  it("confirms both team review changes and makes cancel and Escape inert", async () => {
    let policy: "required" | "optional" = "optional";
    const setTeamReviewPolicy = vi.fn<ApiClient["setTeamReviewPolicy"]>(
      async (_teamId, next) => {
        policy = next;
        return { policy };
      },
    );
    mount(
      () => <TeamPage />,
      clientWith({
        getTeamReviewPolicy: async () => ({ policy }),
        setTeamReviewPolicy,
      }),
    );
    fireEvent.click(await screen.findByRole("link", { name: "Settings" }));
    const toggle = await screen.findByRole("switch", {
      name: "Require review",
    });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    expect(toggle).not.toBeChecked();
    const firstDialog = await screen.findByTestId(
      "team-review-policy-confirmation",
    );
    expect(firstDialog).toHaveTextContent("Require review?");
    expect(setTeamReviewPolicy).not.toHaveBeenCalled();
    fireEvent.keyDown(firstDialog, { key: "Escape" });
    await waitFor(() =>
      expect(
        screen.queryByTestId("team-review-policy-confirmation"),
      ).not.toBeInTheDocument(),
    );
    expect(toggle).not.toBeChecked();
    expect(setTeamReviewPolicy).not.toHaveBeenCalled();

    fireEvent.click(toggle);
    const enableDialog = await screen.findByTestId(
      "team-review-policy-confirmation",
    );
    fireEvent.click(
      within(enableDialog).getByRole("button", { name: "Require review" }),
    );
    await waitFor(() => expect(toggle).toBeChecked());
    await waitFor(() =>
      expect(setTeamReviewPolicy).toHaveBeenCalledWith(
        "team-1",
        "required",
        "optional",
      ),
    );

    fireEvent.click(toggle);
    const disableDialog = await screen.findByTestId(
      "team-review-policy-confirmation",
    );
    expect(toggle).toBeChecked();
    expect(disableDialog).toHaveTextContent("Turn off review?");
    fireEvent.click(
      within(disableDialog).getByRole("button", { name: "Cancel" }),
    );
    expect(toggle).toBeChecked();
    expect(setTeamReviewPolicy).toHaveBeenCalledTimes(1);

    fireEvent.click(toggle);
    const confirmDisable = await screen.findByTestId(
      "team-review-policy-confirmation",
    );
    fireEvent.click(
      within(confirmDisable).getByRole("button", { name: "Turn off review" }),
    );
    await waitFor(() => expect(toggle).not.toBeChecked());
    expect(setTeamReviewPolicy).toHaveBeenNthCalledWith(
      2,
      "team-1",
      "optional",
      "required",
    );
  });

  it("reloads the server policy after a stale review-policy response", async () => {
    let reads = 0;
    const getTeamReviewPolicy = vi.fn<ApiClient["getTeamReviewPolicy"]>(
      async () => ({
        policy: reads++ === 0 ? "optional" : "optional",
      }),
    );
    const setTeamReviewPolicy = vi.fn<ApiClient["setTeamReviewPolicy"]>(
      async () => {
        throw new ApiError(
          "http",
          "/teams/team-1/review-policy",
          "Team review policy changed; reload and try again.",
          409,
          "stale_policy",
        );
      },
    );
    mount(
      () => <TeamPage />,
      clientWith({
        getTeamReviewPolicy,
        setTeamReviewPolicy,
      }),
    );
    fireEvent.click(await screen.findByRole("link", { name: "Settings" }));
    const toggle = await screen.findByRole("switch", {
      name: "Require review",
    });
    fireEvent.click(toggle);
    expect(toggle).not.toBeChecked();
    const dialog = await screen.findByTestId("team-review-policy-confirmation");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Require review" }),
    );

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Team review policy changed",
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Reload review policy" }),
    );
    await waitFor(() => expect(toggle).not.toBeChecked());
    expect(getTeamReviewPolicy).toHaveBeenCalledTimes(2);
    expect(setTeamReviewPolicy).toHaveBeenCalledWith(
      "team-1",
      "required",
      "optional",
    );
  });

  it("disables team review policy for non-admins with an explanation", async () => {
    const memberOnly: TeamMembersResponse = {
      ...memberResponse,
      can_manage: false,
      my_role: "viewer",
    };
    mount(
      () => <TeamPage />,
      clientWith({
        getTeamMembers: async () => memberOnly,
        getTeamReviewPolicy: async () => ({ policy: "required" }),
      }),
    );
    fireEvent.click(await screen.findByRole("link", { name: "Settings" }));
    expect(
      await screen.findByRole("switch", { name: "Require review" }),
    ).toBeDisabled();
    expect(
      screen.getByText("Only team admins can change the review policy."),
    ).toBeVisible();
  });

  it("uses Former member when the server has no member label", async () => {
    const members: TeamMembersResponse = {
      ...memberResponse,
      members: memberResponse.members.map((member) =>
        member.me ? member : { ...member, label: null },
      ),
    };
    mount(
      () => <TeamPage />,
      clientWith({ getTeamMembers: async () => members }),
    );

    const unknownMember = await screen.findByText("Former member");
    expect(unknownMember).toBeVisible();
    expect(unknownMember).not.toHaveAttribute("title");
    expect(
      screen.getByRole("combobox", { name: "Role for Former member" }),
    ).toBeVisible();
  });

  it("reports a role change with the member label instead of the account ID", async () => {
    const userId = "user-12345678-90ab-cdef";
    const setTeamMemberRole = vi.fn<ApiClient["setTeamMemberRole"]>(
      async () => ({
        member: { user_id: userId, role: "editor" },
      }),
    );
    mount(() => <TeamPage />, clientWith({ setTeamMemberRole }));

    const identity = await screen.findByText("Jordan");
    expect(identity).not.toHaveAttribute("title", userId);
    fireEvent.change(
      screen.getByRole("combobox", { name: "Role for Jordan" }),
      { target: { value: "editor" } },
    );

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Jordan is now editor.",
    );
    expect(screen.getByRole("status")).not.toHaveTextContent(userId);
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
      name: "Role for Jordan",
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
      name: "Role for Jordan",
    });
    fireEvent.change(role, { target: { value: "editor" } });
    const notice = await screen.findByTestId("team-stale-member-notice");
    await waitFor(() =>
      expect(notice).toHaveTextContent(
        "Jordan's role changed to Editor since you loaded the team.",
      ),
    );
    expect(notice).toHaveTextContent("The list has been reloaded.");
    expect(
      screen.getByRole("combobox", {
        name: "Role for Jordan",
      }),
    ).toHaveValue("editor");
    expect(getTeamMembers).toHaveBeenCalledTimes(2);
  });

  it("allows an admin to change their own role", async () => {
    const twoAdmins: TeamMembersResponse = {
      ...memberResponse,
      members: memberResponse.members.map((member) =>
        member.user_id === "user-12345678-90ab-cdef"
          ? { ...member, role: "admin" }
          : member,
      ),
    };
    const setTeamMemberRole = vi.fn<ApiClient["setTeamMemberRole"]>(
      async () => ({
        member: { user_id: "user-me", role: "viewer" },
      }),
    );
    mount(
      () => <TeamPage />,
      clientWith({
        getTeamMembers: async () => twoAdmins,
        setTeamMemberRole,
      }),
    );

    const role = await screen.findByRole("combobox", {
      name: "Role for Admin",
    });
    expect(role).toBeEnabled();
    fireEvent.change(role, { target: { value: "viewer" } });
    await waitFor(() =>
      expect(setTeamMemberRole).toHaveBeenCalledWith(
        "team-1",
        "user-me",
        "viewer",
        "admin",
      ),
    );
    expect(role).toHaveValue("viewer");
    expect(await screen.findByRole("status")).toHaveTextContent(
      "You are now viewer.",
    );
  });

  it("keeps sole-admin leave available and shows the server last-admin message", async () => {
    const message =
      "cannot remove the last admin; promote another member to admin first";
    const removeTeamMember = vi.fn<ApiClient["removeTeamMember"]>(async () => {
      throw new ApiError(
        "http",
        "/teams/team-1/members/user-me/remove",
        message,
        409,
        "last_admin",
      );
    });
    mount(() => <TeamPage />, clientWith({ removeTeamMember }));

    expect(await screen.findByTestId("team-only-admin-hint")).toHaveTextContent(
      "You're the only admin. Promote another member to admin first.",
    );
    const selfRow = (await screen.findAllByTestId("team-member-row")).find(
      (row) => row.getAttribute("data-user-id") === "user-me",
    );
    if (!selfRow) throw new Error("current-user row missing");
    fireEvent.click(
      within(selfRow).getByRole("button", { name: "Leave team" }),
    );
    const dialog = await screen.findByTestId("team-remove-confirmation");
    const confirm = within(dialog).getByRole("button", { name: "Leave team" });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(message);
    expect(confirm).toBeEnabled();
  });

  it("keeps member removal admin-only, including self-leave", async () => {
    const editorResponse: TeamMembersResponse = {
      ...memberResponse,
      my_role: "editor",
      can_manage: false,
      actions: {
        ...memberResponse.actions,
        remove: "admin_only",
        set_role: "admin_only",
      },
      members: memberResponse.members.map((member) =>
        member.me ? { ...member, role: "editor" } : member,
      ),
    };
    const removeTeamMember = vi.fn<ApiClient["removeTeamMember"]>(async () => ({
      removed: "user-me",
      new_epoch: 2,
      rewrapped: 2,
      skipped_count: 0,
      unlinked_projects: 1,
    }));
    mount(
      () => <TeamPage />,
      clientWith({
        getTeamMembers: async () => editorResponse,
        removeTeamMember,
      }),
    );

    const selfRow = (await screen.findAllByTestId("team-member-row")).find(
      (row) => row.getAttribute("data-user-id") === "user-me",
    );
    if (!selfRow) throw new Error("current-user row missing");
    const leave = within(selfRow).getByRole("button", { name: "Leave team" });
    expect(leave).toBeDisabled();
    expect(
      within(selfRow).getByText("Only team admins can leave this team."),
    ).toBeInTheDocument();
    const otherRow = screen
      .getAllByTestId("team-member-row")
      .find((row) => row.getAttribute("data-user-id") !== "user-me");
    if (!otherRow) throw new Error("other-member row missing");
    expect(
      within(otherRow).getByRole("button", { name: "Remove" }),
    ).toBeDisabled();

    expect(removeTeamMember).not.toHaveBeenCalled();
  });

  it("confirms removal, supports offline invites, and keeps the token in its receipt", async () => {
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
      unlinked_projects: 0,
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

    fireEvent.click(screen.getByRole("link", { name: "Invitations" }));
    fireEvent.click(screen.getByTestId("team-offline-invite"));
    const createInvite = await screen.findByRole("button", {
      name: "Create invite",
    });
    await waitFor(() => expect(createInvite).toBeEnabled());
    fireEvent.click(createInvite);
    const inviteDialog = await screen.findByTestId("team-invite-receipt");
    expect(inviteDialog).toHaveTextContent("invite-secret-token");
    expect(inviteDialog).toHaveTextContent(
      "lore team accept invite-secret-token",
    );
    expect(inviteTeamMember).toHaveBeenCalledWith("team-1", {
      role: "viewer",
      offline: true,
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
    await waitFor(() =>
      expect(screen.getByTestId("team-stale-member-notice")).toHaveTextContent(
        "Jordan's role changed to Editor",
      ),
    );
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
      screen.getByRole("combobox", { name: "Role for Jordan" }),
      { target: { value: "editor" } },
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Enable sync with `lore sync enable`",
    );
  });
});

describe("ConflictsPage", () => {
  it("compares the current text to keeping the local snapshot and preserves full text", async () => {
    mount(() => <ConflictsPage />, clientWith({}));
    const card = await screen.findByTestId("conflict-card");
    const changes = within(card).getByTestId("conflict-changes");
    const before = within(changes).getByTestId("conflict-current-text");
    const after = within(changes).getByTestId("conflict-local-text");
    expect(before).toHaveTextContent("Remote decisionUse another store.");
    expect(after).toHaveTextContent("Local decisionKeep SQLite.");
    expect(before.querySelector("del")).toHaveTextContent("Remote");
    expect(before.querySelector("ins")).toBeNull();
    expect(after.querySelector("ins")).toHaveTextContent("Local");
    expect(after.querySelector("del")).toBeNull();
    const full = within(card)
      .getByText("Full local and current text")
      .closest("details");
    if (!full) throw new Error("Missing details disclosure");
    expect(full).not.toHaveAttribute("open");
    fireEvent.click(within(full).getByText("Full local and current text"));
    expect(full).toHaveTextContent("Use another store.");
    expect(card).toHaveTextContent(
      "Discard mine permanently removes this saved snapshot",
    );
    expect(card).toHaveTextContent("Keep mine creates a new current version");
  });

  it.each(["title-only", "unchanged", "large", "missing-current"])(
    "handles %s recovery comparisons",
    async (kind) => {
      const original = conflicts.conflicts[0];
      if (!original?.local || !original.current)
        throw new Error("Missing complete recovery fixture");
      const local = {
        ...original.local,
        content: kind === "large" ? "a".repeat(20_001) : "same content",
      };
      const current =
        kind === "missing-current"
          ? null
          : {
              ...original.current,
              title: kind === "unchanged" ? local.title : "Old title",
              content: kind === "large" ? "different" : local.content,
            };
      mount(
        () => <ConflictsPage />,
        clientWith({
          listSyncConflicts: async () => ({
            ...conflicts,
            conflicts: [{ ...original, local, current }],
          }),
        }),
      );
      const card = await screen.findByTestId("conflict-card");
      if (kind === "unchanged")
        expect(card).toHaveTextContent("No title or content changes");
      else if (kind === "large") {
        expect(card).toHaveTextContent(
          "Changes too large to compare. Showing full text.",
        );
        expect(
          within(card)
            .getByText("Full local and current text")
            .closest("details"),
        ).toHaveAttribute("open");
        expect(card.querySelector("pre")?.textContent).toBe(local.content);
      } else if (kind === "missing-current") {
        expect(card).toHaveTextContent(
          "Current version unavailable. Showing the saved local text.",
        );
        expect(
          within(card)
            .getByText("Full local and current text")
            .closest("details"),
        ).toHaveAttribute("open");
        expect(card.querySelector("pre")?.textContent).toBe(local.content);
      } else
        expect(
          within(card).getByTestId("conflict-changes").querySelector("del"),
        ).toHaveTextContent("Old");
    },
  );

  it("separates empty conflict recovery from its explanation", async () => {
    mount(
      () => <ConflictsPage />,
      clientWith({
        listSyncConflicts: async () => ({
          available: true,
          complete: true,
          conflicts: [],
        }),
      }),
    );
    const action = await screen.findByRole("link", {
      name: "Browse knowledge",
    });
    expect(action).toHaveAttribute("href", "/knowledge");
    expect(action.parentElement).not.toHaveTextContent(
      "No replaced local versions",
    );
  });

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

  it("offers Keep mine for a remote-deleted entry and restores it", async () => {
    const deletedConflicts: SyncConflictList = {
      ...conflicts,
      conflicts: [
        {
          ...conflicts.conflicts[0]!,
          resolution: "remote_delete_wins",
          current: {
            ...conflicts.conflicts[0]!.current!,
            version_id: "death-cert-3",
            version: 3,
            deleted: true,
          },
        },
      ],
    };
    const keepSyncConflictLocal = vi.fn<ApiClient["keepSyncConflictLocal"]>(
      async () => ({
        kept: "local",
        current: {
          version_id: "restored-4",
          version: 4,
          title: "Local decision",
          content: "Keep SQLite.",
        },
      }),
    );
    mount(
      () => <ConflictsPage />,
      clientWith({
        listSyncConflicts: async () => deletedConflicts,
        keepSyncConflictLocal,
      }),
    );

    const card = await screen.findByTestId("conflict-card");
    expect(card).toHaveTextContent("The remote entry was deleted.");
    expect(card).toHaveTextContent("deleted remotely");
    fireEvent.click(within(card).getByRole("button", { name: "Keep mine" }));
    const dialog = await screen.findByTestId("conflict-action-confirmation");
    expect(dialog).toHaveTextContent(
      "restores the saved local snapshot as a new current version",
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep mine" }));

    expect(
      await screen.findByTestId("conflict-recovery-receipt"),
    ).toHaveTextContent("restored-4");
    expect(keepSyncConflictLocal).toHaveBeenCalledWith(17, "death-cert-3");
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

describe("TeamParityActions", () => {
  it("keeps required team-name constraints and retains the controlled draft on cancel and reopen", async () => {
    const createTeam = vi.fn<ApiClient["createTeam"]>();
    mount(
      () => (
        <TeamParityActions
          selectedTeamId="team-1"
          canManage
          hasTeams
          onChanged={() => undefined}
        />
      ),
      clientWith({ createTeam }),
    );
    fireEvent.click(screen.getByRole("button", { name: "New team" }));
    const dialog = await screen.findByTestId("team-create-dialog");
    const name = within(dialog).getByLabelText("Team name") as HTMLInputElement;
    expect(name).toBeRequired();
    expect(name).toHaveAttribute("maxlength", "120");
    expect(name.validity.valueMissing).toBe(true);
    fireEvent.input(name, { target: { value: "Draft team" } });
    expect(name).toHaveValue("Draft team");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(createTeam).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "New team" }));
    expect(await screen.findByTestId("team-create-name")).toHaveValue(
      "Draft team",
    );
  });

  it("keeps New team errors in its dialog", async () => {
    const createTeam = vi.fn<ApiClient["createTeam"]>(async () => {
      throw new ApiError(
        "http",
        "/teams",
        "Team name is already in use.",
        409,
        "conflict",
      );
    });
    mount(
      () => (
        <TeamParityActions
          selectedTeamId="team-1"
          canManage
          hasTeams
          onChanged={() => undefined}
        />
      ),
      clientWith({ createTeam }),
    );

    fireEvent.click(screen.getByRole("button", { name: "New team" }));
    const dialog = await screen.findByTestId("team-create-dialog");
    fireEvent.input(screen.getByTestId("team-create-name"), {
      target: { value: "Acme" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Create team" }),
    );
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Team name is already in use.",
    );
  });

  it("shows an inline team-creation form when no teams exist", async () => {
    const emptyTeamCreate = vi.fn<ApiClient["createTeam"]>(async (name) => ({
      team: { id: "team-2", name },
    }));
    mount(
      () => (
        <TeamParityActions
          selectedTeamId="team-1"
          canManage={false}
          hasTeams={false}
          onChanged={() => undefined}
        />
      ),
      clientWith({ createTeam: emptyTeamCreate }),
    );
    fireEvent.input(screen.getByLabelText("Team name"), {
      target: { value: "First team" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create team" }));
    await waitFor(() =>
      expect(emptyTeamCreate).toHaveBeenCalledWith("First team"),
    );
  });

  it("sends a pasted invite link as a token body and keeps failures in the dialog", async () => {
    const acceptTeamInvite = vi.fn<ApiClient["acceptTeamInvite"]>(async () => {
      throw new ApiError(
        "http",
        "/teams/accept",
        "Invitation expired.",
        404,
        "not_found",
      );
    });
    mount(
      () => (
        <TeamParityActions
          selectedTeamId="team-1"
          canManage
          hasTeams
          onChanged={() => undefined}
        />
      ),
      clientWith({ acceptTeamInvite }),
    );

    fireEvent.click(await screen.findByRole("button", { name: "Join a team" }));
    const dialog = await screen.findByTestId("team-join-dialog");
    fireEvent.input(screen.getByTestId("team-invite-token"), {
      target: {
        value: "https://lore.example/accept?token=secret-body-token",
      },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Join team" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Invitation expired.",
    );
    expect(acceptTeamInvite).toHaveBeenCalledWith("secret-body-token");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByTestId("team-join-dialog")).not.toBeInTheDocument(),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Join a team" }));
    expect(await screen.findByTestId("team-invite-token")).toHaveValue("");
  });

  it("keeps Add by account ID errors in its open admin dialog", async () => {
    const addTeamMemberById = vi.fn<ApiClient["addTeamMemberById"]>(
      async () => {
        throw new ApiError(
          "forbidden",
          "/teams/team-1/members",
          "Only team admins can add members.",
          403,
          "forbidden",
        );
      },
    );
    mount(
      () => (
        <TeamParityActions
          selectedTeamId="team-1"
          canManage
          hasTeams
          onChanged={() => undefined}
        />
      ),
      clientWith({ addTeamMemberById }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Add by account ID" }));
    const dialog = await screen.findByTestId("team-add-by-id-dialog");
    fireEvent.input(screen.getByTestId("team-account-id"), {
      target: { value: "user-2" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add member" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "You don't have permission to perform this action.",
    );
    expect(addTeamMemberById).toHaveBeenCalledWith(
      "team-1",
      "user-2",
      "editor",
    );
  });

  it("only calls GitHub discovery after the explicit click", async () => {
    const discoverTeamContributors = vi.fn<
      ApiClient["discoverTeamContributors"]
    >(async () => ({
      repos: [
        {
          repo: "acme/app",
          contributors: [{ login: "ada", githubId: 17, onLore: false }],
        },
      ],
    }));
    mount(
      () => (
        <TeamParityActions
          selectedTeamId="team-1"
          canManage
          hasTeams
          onChanged={() => undefined}
        />
      ),
      clientWith({ discoverTeamContributors }),
    );
    await screen.findByTestId("organization-domains");
    expect(discoverTeamContributors).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Find contributors" }));
    const contributor = await screen.findByLabelText("@ada");
    fireEvent.click(contributor);
    fireEvent.click(screen.getByRole("button", { name: "Invite selected" }));
    await waitFor(() =>
      expect(discoverTeamContributors).toHaveBeenCalledTimes(2),
    );
    expect(discoverTeamContributors).toHaveBeenLastCalledWith("team-1", {
      invite_role: "editor",
      invite_logins: ["ada"],
    });
  });

  it("shows organization requests and surfaces forbidden domain claims", async () => {
    const decideDomainJoinRequest = vi.fn<ApiClient["decideDomainJoinRequest"]>(
      async (_orgId, requestId, decision) => ({
        request_id: requestId,
        status: decision === "approve" ? "approved" : "rejected",
      }),
    );
    const claimOrganizationDomain = vi.fn<ApiClient["claimOrganizationDomain"]>(
      async () => {
        throw new ApiError(
          "forbidden",
          "/orgs/org-1/domains/claim",
          "Only organization admins can claim domains.",
          403,
          "forbidden",
        );
      },
    );
    const getDomainJoinRequests = vi.fn<ApiClient["getDomainJoinRequests"]>(
      async () => ({
        requests: [
          {
            id: "request-1",
            domain: "example.test",
            user_id: "user-2",
            label: "Ada Lovelace",
            status: "pending",
            requested_at: "2026-01-01T00:00:00Z",
          },
          {
            id: "request-2",
            domain: "approved.test",
            user_id: "user-3",
            label: "@grace",
            status: "approved",
            requested_at: "2026-01-02T00:00:00Z",
          },
          {
            id: "request-3",
            domain: "rejected.test",
            user_id: "user-4",
            label: null,
            status: "rejected",
            requested_at: "2026-01-03T00:00:00Z",
          },
        ],
      }),
    );
    mount(
      () => (
        <TeamParityActions
          selectedTeamId="team-1"
          canManage
          hasTeams
          onChanged={() => undefined}
        />
      ),
      clientWith({
        getOrganizations: async () => ({
          organizations: [{ id: "org-1", name: "Acme", role: "admin" }],
        }),
        getDomainJoinRequests,
        decideDomainJoinRequest,
        claimOrganizationDomain,
      }),
    );

    await screen.findByTestId("organization-domains");
    fireEvent.click(
      await screen.findByRole("button", { name: "Load join requests" }),
    );
    const rows = await screen.findAllByTestId("domain-join-request");
    expect(rows[0]).toHaveTextContent("example.test · Ada Lovelace");
    expect(rows[0]).not.toHaveTextContent("user-2");
    expect(rows[1]).toHaveTextContent("Approved");
    expect(within(rows[1]!).queryByRole("button")).not.toBeInTheDocument();
    expect(rows[2]).toHaveTextContent("rejected.test · Unknown requester");
    expect(rows[2]).toHaveTextContent("Rejected");
    expect(rows[2]).not.toHaveTextContent("user-4");
    expect(within(rows[2]!).queryByRole("button")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(decideDomainJoinRequest).toHaveBeenCalledWith(
        "org-1",
        "request-1",
        "approve",
      ),
    );

    fireEvent.input(screen.getByLabelText("Verified email domain"), {
      target: { value: "example.test" },
    });
    const claimButton = screen.getByRole("button", { name: "Claim domain" });
    await waitFor(() => expect(claimButton).toBeEnabled());
    fireEvent.click(claimButton);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "You don't have permission to perform this action.",
    );
    expect(claimOrganizationDomain).toHaveBeenCalledWith(
      "org-1",
      "example.test",
      "member",
    );
  });

  it("asks for an organization ID before requesting to join by domain", async () => {
    const requestOrganizationJoin = vi.fn<ApiClient["requestOrganizationJoin"]>(
      async () => ({ request_id: "request-1" }),
    );
    mount(
      () => (
        <TeamParityActions
          selectedTeamId="team-1"
          canManage
          hasTeams
          onChanged={() => undefined}
        />
      ),
      clientWith({ requestOrganizationJoin }),
    );

    await screen.findByTestId("organization-domains");
    fireEvent.input(screen.getByLabelText("Verified email domain"), {
      target: { value: "example.test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Request to join" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Enter the organization ID you want to join.",
    );
    expect(requestOrganizationJoin).not.toHaveBeenCalled();
  });
});

describe("SharingPanel auto-share control", () => {
  it("does not restore compact sharing from retained data while a failed read is retrying", async () => {
    const pendingSharing = deferred<SharingStatus>();
    const getProjectSharing = vi
      .fn<ApiClient["getProjectSharing"]>()
      .mockResolvedValueOnce(automaticSharing)
      .mockRejectedValueOnce(new Error("Sharing unavailable"))
      .mockImplementation(() => pendingSharing.promise);
    const getSyncStatus = vi
      .fn<ApiClient["getSyncStatus"]>()
      .mockResolvedValueOnce({
        enabled: false,
        state: "disabled",
        pending_changes: null,
      })
      .mockResolvedValue({ enabled: true, state: "idle", pending_changes: 0 });
    mount(
      () => <SharingPanel projectId="p-1" />,
      clientWith({ getProjectSharing, getSyncStatus }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Check again" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Sharing status could not be refreshed",
    );
    expect(screen.getByLabelText("Sharing setup")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(getProjectSharing).toHaveBeenCalledTimes(3));
    expect(screen.getByLabelText("Sharing setup")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Manage sharing" })).toBeNull();
    expect(
      screen.getByRole("switch", { name: "Share automatically" }),
    ).toBeDisabled();
    pendingSharing.resolve(manualSharing);
    expect(
      await screen.findByRole("button", { name: "Manage sharing" }),
    ).toBeVisible();
  });

  it("hands focused link action to compact sharing after success without focusing background refreshes", async () => {
    const pendingLink = deferred<SharingStatus>();
    const unlinked: SharingStatus = {
      ...manualSharing,
      linked: false,
      team: null,
      state: "not_linked",
    };
    const getAccount = vi.fn<ApiClient["getAccount"]>(async () => account);
    mount(
      () => (
        <>
          <button type="button">Elsewhere</button>
          <SharingPanel projectId="p-1" />
        </>
      ),
      clientWith({
        getAccount,
        getProjectSharing: async () => unlinked,
        linkProjectToTeam: async () => pendingLink.promise,
      }),
    );
    fireEvent.change(
      await screen.findByRole("combobox", { name: "Link to team" }),
      { target: { value: "team-1" } },
    );
    const link = screen.getByRole("button", { name: "Link to team" });
    link.focus();
    fireEvent.click(link);
    pendingLink.resolve(manualSharing);
    const manage = await screen.findByRole("button", {
      name: "Manage sharing",
    });
    await waitFor(() => expect(manage).toHaveFocus());
    expect(screen.getByText("Project linked to team.")).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Sync now" })).toBeEnabled(),
    );
    const beforeRefresh = getAccount.mock.calls.length;
    const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
    elsewhere.focus();
    fireEvent(window, new Event("focus"));
    await waitFor(() =>
      expect(getAccount).toHaveBeenCalledTimes(beforeRefresh + 1),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Sync now" })).toBeEnabled(),
    );
    expect(elsewhere).toHaveFocus();
  });

  it("keeps focus elsewhere if the user leaves a pending link action", async () => {
    const pendingLink = deferred<SharingStatus>();
    const unlinked: SharingStatus = {
      ...manualSharing,
      linked: false,
      team: null,
      state: "not_linked",
    };
    mount(
      () => (
        <>
          <button type="button">Elsewhere</button>
          <SharingPanel projectId="p-1" />
        </>
      ),
      clientWith({
        getProjectSharing: async () => unlinked,
        linkProjectToTeam: async () => pendingLink.promise,
      }),
    );
    fireEvent.change(
      await screen.findByRole("combobox", { name: "Link to team" }),
      { target: { value: "team-1" } },
    );
    const link = screen.getByRole("button", { name: "Link to team" });
    link.focus();
    fireEvent.click(link);
    const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
    elsewhere.focus();
    pendingLink.resolve(manualSharing);
    await screen.findByRole("button", { name: "Manage sharing" });
    expect(elsewhere).toHaveFocus();
  });

  it("compacts configured sharing with explicit expansion and keeps sync visible", async () => {
    mount(
      () => <SharingPanel projectId="p-1" />,
      clientWith({ getProjectSharing: async () => manualSharing }),
    );
    const expand = await screen.findByRole("button", {
      name: "Manage sharing",
    });
    expect(
      screen.queryByRole("switch", { name: "Share automatically" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Sync now" }),
    ).toBeInTheDocument();
    fireEvent.click(expand);
    expect(
      screen.getByRole("switch", { name: "Share automatically" }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Hide sharing settings" }),
    );
    expect(
      screen.queryByRole("switch", { name: "Share automatically" }),
    ).toBeNull();
  });

  it("keeps configured sharing compact through a healthy account and sync refresh while gating writes", async () => {
    const nextAccount = deferred<AccountStatus>();
    const nextSync =
      deferred<Awaited<ReturnType<ApiClient["getSyncStatus"]>>>();
    const getAccount = vi
      .fn<ApiClient["getAccount"]>()
      .mockResolvedValueOnce(account)
      .mockImplementation(() => nextAccount.promise);
    const getSyncStatus = vi
      .fn<ApiClient["getSyncStatus"]>()
      .mockResolvedValueOnce({
        enabled: true,
        state: "idle",
        pending_changes: 0,
      })
      .mockImplementation(() => nextSync.promise);
    const setProjectAutoShare = vi.fn<ApiClient["setProjectAutoShare"]>();
    mount(
      () => <SharingPanel projectId="p-1" />,
      clientWith({ getAccount, getSyncStatus, setProjectAutoShare }),
    );
    await screen.findByRole("button", { name: "Manage sharing" });
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(getAccount).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText("Sharing setup")).not.toBeVisible();
    expect(
      screen.getByRole("button", { name: "Manage sharing" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sync now" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Manage sharing" }));
    expect(
      screen.getByRole("switch", { name: "Share automatically" }),
    ).toBeDisabled();
    expect(setProjectAutoShare).not.toHaveBeenCalled();
    nextAccount.resolve(account);
    nextSync.resolve({ enabled: true, state: "idle", pending_changes: 0 });
    await waitFor(() =>
      expect(
        screen.getByRole("switch", { name: "Share automatically" }),
      ).toBeEnabled(),
    );
  });

  it("expands setup when the account changes until sharing is confirmed for that owner", async () => {
    const nextSharing = deferred<SharingStatus>();
    const getAccount = vi
      .fn<ApiClient["getAccount"]>()
      .mockResolvedValueOnce(account)
      .mockResolvedValue({
        ...account,
        user: { id: "other-user", email: null, display_name: "Other" },
      });
    const getProjectSharing = vi
      .fn<ApiClient["getProjectSharing"]>()
      .mockResolvedValueOnce(automaticSharing)
      .mockImplementation(() => nextSharing.promise);
    mount(
      () => <SharingPanel projectId="p-1" />,
      clientWith({ getAccount, getProjectSharing }),
    );
    await screen.findByRole("button", { name: "Manage sharing" });
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(getProjectSharing).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText("Sharing setup")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Manage sharing" })).toBeNull();
    nextSharing.resolve(manualSharing);
    expect(
      await screen.findByRole("button", { name: "Manage sharing" }),
    ).toBeInTheDocument();
  });

  it("shows team review policy and confirms disabling automatic sharing", async () => {
    const setProjectAutoShare = vi.fn<ApiClient["setProjectAutoShare"]>(
      async () => manualSharing,
    );
    mount(
      () => <SharingPanel projectId="project-1" />,
      clientWith({ setProjectAutoShare }),
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Manage sharing" }),
    );
    const toggle = await screen.findByRole("switch", {
      name: "Share automatically",
    });
    expect(toggle).toBeChecked();
    expect(screen.getByTestId("sharing-team-review")).toHaveTextContent(
      "Team review: optional",
    );
    expect(screen.getByTestId("sharing-panel")).toHaveTextContent(
      "Your team’s review rules still apply.",
    );
    fireEvent.click(toggle);
    const dialog = await screen.findByTestId("sharing-policy-confirmation");
    expect(dialog).toHaveTextContent("Turn off automatic sharing?");
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "Turn off automatic sharing",
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("sharing-summary")).toHaveTextContent(
        "policy: manual",
      ),
    );
    expect(setProjectAutoShare).toHaveBeenCalledWith(
      "project-1",
      "manual",
      "auto",
    );
  });

  it("confirms enabling automatic sharing for a review-required team", async () => {
    const reviewRequired: SharingStatus = {
      ...manualSharing,
      policy: { ...manualSharing.policy, team_default: "manual" },
      review_required: true,
    };
    const setProjectAutoShare = vi.fn<ApiClient["setProjectAutoShare"]>(
      async () => automaticSharing,
    );
    mount(
      () => <SharingPanel projectId="project-1" />,
      clientWith({
        getProjectSharing: async () => reviewRequired,
        setProjectAutoShare,
      }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Manage sharing" }),
    );
    const toggle = await screen.findByRole("switch", {
      name: "Share automatically",
    });
    expect(toggle).not.toBeChecked();
    expect(screen.getByTestId("sharing-team-review")).toHaveTextContent(
      "Team review: required",
    );
    fireEvent.click(toggle);
    const dialog = await screen.findByTestId("sharing-policy-confirmation");
    expect(dialog).toHaveTextContent(
      "New team knowledge in this project is sent to Acme as review requests on the next sync.",
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Share automatically" }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("sharing-summary")).toHaveTextContent(
        "policy: auto",
      ),
    );
    expect(setProjectAutoShare).toHaveBeenCalledWith(
      "project-1",
      "auto",
      "manual",
    );
  });

  it("keeps the confirmation open while the policy update is saving", async () => {
    let resolvePolicy!: (status: SharingStatus) => void;
    const pendingPolicy = new Promise<SharingStatus>((resolve) => {
      resolvePolicy = resolve;
    });
    const setProjectAutoShare = vi.fn<ApiClient["setProjectAutoShare"]>(
      () => pendingPolicy,
    );
    mount(
      () => <SharingPanel projectId="project-1" />,
      clientWith({ setProjectAutoShare }),
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Manage sharing" }),
    );
    fireEvent.click(
      await screen.findByRole("switch", { name: "Share automatically" }),
    );
    const dialog = await screen.findByTestId("sharing-policy-confirmation");
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "Turn off automatic sharing",
      }),
    );

    expect(setProjectAutoShare).toHaveBeenCalledWith(
      "project-1",
      "manual",
      "auto",
    );
    expect(
      within(dialog).getByRole("button", { name: "Saving…" }),
    ).toBeDisabled();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(
      screen.getByTestId("sharing-policy-confirmation"),
    ).toBeInTheDocument();

    resolvePolicy(manualSharing);
    await waitFor(() =>
      expect(
        screen.queryByTestId("sharing-policy-confirmation"),
      ).not.toBeInTheDocument(),
    );
  });

  it("keeps the auto-share switch at the server value when cancelled", async () => {
    const setProjectAutoShare = vi.fn<ApiClient["setProjectAutoShare"]>(
      async () => manualSharing,
    );
    mount(
      () => <SharingPanel projectId="project-1" />,
      clientWith({ setProjectAutoShare }),
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Manage sharing" }),
    );
    const toggle = await screen.findByRole("switch", {
      name: "Share automatically",
    });
    fireEvent.click(toggle);
    expect(toggle).toBeChecked();
    const dialog = await screen.findByTestId("sharing-policy-confirmation");
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() =>
      expect(
        screen.queryByTestId("sharing-policy-confirmation"),
      ).not.toBeInTheDocument(),
    );
    expect(toggle).toBeChecked();
    expect(setProjectAutoShare).not.toHaveBeenCalled();

    fireEvent.click(toggle);
    const cancelDialog = await screen.findByTestId(
      "sharing-policy-confirmation",
    );
    fireEvent.click(
      within(cancelDialog).getByRole("button", { name: "Cancel" }),
    );
    expect(toggle).toBeChecked();
    expect(setProjectAutoShare).not.toHaveBeenCalled();
  });

  it("keeps stale policy errors in the dialog and reloads from there", async () => {
    const getProjectSharing = vi
      .fn<ApiClient["getProjectSharing"]>()
      .mockResolvedValueOnce(automaticSharing)
      .mockResolvedValueOnce(manualSharing);
    const setProjectAutoShare = vi.fn<ApiClient["setProjectAutoShare"]>(
      async () => {
        throw new ApiError(
          "http",
          "/projects/project-1/sharing/policy",
          "Project sharing policy changed; reload the project.",
          409,
          "stale_policy",
        );
      },
    );
    mount(
      () => <SharingPanel projectId="project-1" />,
      clientWith({ getProjectSharing, setProjectAutoShare }),
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Manage sharing" }),
    );
    fireEvent.click(
      await screen.findByRole("switch", { name: "Share automatically" }),
    );
    const dialog = await screen.findByTestId("sharing-policy-confirmation");
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "Turn off automatic sharing",
      }),
    );
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("Project sharing policy changed");
    expect(alert).toHaveFocus();
    expect(
      within(dialog).getByRole("button", {
        name: "Turn off automatic sharing",
      }),
    ).toBeDisabled();
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
    expect(setProjectAutoShare).toHaveBeenCalledTimes(1);
  });
});

describe("SharingPanel team link control", () => {
  it("keeps a persistent visible link and unlink status while configured settings collapse", async () => {
    const unlinked: SharingStatus = {
      ...manualSharing,
      linked: false,
      team: null,
      policy: {
        effective: "manual",
        project_override: null,
        team_default: null,
      },
      auto_share: false,
      review_required: null,
      state: "not_linked",
    };
    const linkProjectToTeam = vi
      .fn<ApiClient["linkProjectToTeam"]>()
      .mockResolvedValueOnce(automaticSharing)
      .mockResolvedValueOnce(unlinked);
    mount(
      () => <SharingPanel projectId="project-1" />,
      clientWith({
        getProjectSharing: async () => unlinked,
        linkProjectToTeam,
      }),
    );

    await screen.findByRole("option", { name: "Acme" });
    const picker = await screen.findByRole("combobox", {
      name: "Link to team",
    });
    const panel = screen.getByTestId("sharing-panel");
    const receipt = within(panel).getByRole("status");
    expect(receipt).toBeEmptyDOMElement();
    expect(receipt).toHaveAttribute("aria-live", "polite");
    expect(receipt).toHaveAttribute("aria-atomic", "true");
    fireEvent.change(picker, { target: { value: "team-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Link to team" }));
    await waitFor(() =>
      expect(linkProjectToTeam).toHaveBeenNthCalledWith(
        1,
        "project-1",
        "team-1",
        null,
      ),
    );

    const manage = await screen.findByRole("button", {
      name: "Manage sharing",
    });
    expect(manage).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByLabelText("Sharing setup")).not.toBeVisible();
    expect(within(panel).getByRole("status")).toBe(receipt);
    expect(receipt).toHaveTextContent("Project linked to team.");
    expect(receipt).toBeVisible();
    fireEvent.click(manage);
    const unlink = await screen.findByRole("button", { name: "Unlink" });
    await waitFor(() => expect(unlink).toBeEnabled());
    fireEvent.click(unlink);
    const unlinkDialog = await screen.findByTestId(
      "sharing-unlink-confirmation",
    );
    fireEvent.click(
      within(unlinkDialog).getByRole("button", { name: "Unlink project" }),
    );
    await waitFor(() =>
      expect(linkProjectToTeam).toHaveBeenNthCalledWith(
        2,
        "project-1",
        null,
        "team-1",
      ),
    );
    await waitFor(() => expect(receipt).toHaveTextContent("Project unlinked."));
    expect(within(panel).getByRole("status")).toBe(receipt);
    expect(receipt).toBeVisible();
  });

  it.each(["account", "project"] as const)(
    "clears completed receipts and ignores late link success after a %s change",
    async (context) => {
      const unlinked: SharingStatus = {
        ...manualSharing,
        linked: false,
        team: null,
        state: "not_linked",
      };
      let currentAccount = account;
      const pendingLink = deferred<SharingStatus>();
      const linkProjectToTeam = vi
        .fn<ApiClient["linkProjectToTeam"]>()
        .mockResolvedValueOnce(manualSharing)
        .mockImplementation(() => pendingLink.promise);
      const getProjectSharing = vi.fn<ApiClient["getProjectSharing"]>(
        async () => unlinked,
      );
      mount(
        () => {
          const ws = useWorkspace();
          const [projectId, setProjectId] = createSignal("project-1");
          return (
            <>
              <button
                onClick={() => {
                  if (context === "project")
                    setProjectId((current) =>
                      current === "project-1" ? "project-2" : "project-1",
                    );
                  else {
                    currentAccount =
                      currentAccount.user?.id === account.user?.id
                        ? {
                            ...account,
                            user: {
                              id: "other-user",
                              email: null,
                              display_name: "Other",
                            },
                          }
                        : account;
                    ws.state.folk.refresh();
                  }
                }}
              >
                Change context
              </button>
              <SharingPanel projectId={projectId()} />
            </>
          );
        },
        clientWith({
          getAccount: async () => currentAccount,
          getProjectSharing,
          linkProjectToTeam,
        }),
      );
      const panel = screen.getByTestId("sharing-panel");
      const picker = await screen.findByRole("combobox", {
        name: "Link to team",
      });
      const receipt = within(panel).getByRole("status");
      fireEvent.change(picker, {
        target: { value: "team-1" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Link to team" }));
      await waitFor(() =>
        expect(receipt).toHaveTextContent("Project linked to team."),
      );
      fireEvent.click(screen.getByRole("button", { name: "Change context" }));
      await waitFor(() => expect(receipt).toBeEmptyDOMElement());
      expect(receipt).toBeInTheDocument();
      fireEvent.change(
        await screen.findByRole("combobox", { name: "Link to team" }),
        {
          target: { value: "team-1" },
        },
      );
      fireEvent.click(screen.getByRole("button", { name: "Link to team" }));
      await waitFor(() => expect(linkProjectToTeam).toHaveBeenCalledTimes(2));
      // Move away again before the pending mutation settles.
      const readsBeforeChange = getProjectSharing.mock.calls.length;
      fireEvent.click(screen.getByRole("button", { name: "Change context" }));
      await waitFor(() =>
        expect(getProjectSharing.mock.calls.length).toBeGreaterThan(
          readsBeforeChange,
        ),
      );
      pendingLink.resolve(manualSharing);
      await waitFor(() =>
        expect(
          screen.getByRole("combobox", { name: "Link to team" }),
        ).toBeEnabled(),
      );
      expect(receipt).toBeEmptyDOMElement();
      expect(within(panel).getByRole("status")).toBe(receipt);
      expect(screen.getByLabelText("Sharing setup")).toBeVisible();
    },
  );
});

describe("guided project sharing", () => {
  const unlinked: SharingStatus = {
    linked: false,
    team: null,
    policy: { effective: "manual", project_override: null, team_default: null },
    auto_share: false,
    review_required: null,
    state: "not_linked",
    detail: null,
  };

  it("shows compact device-wide background sync and can expand setup", async () => {
    const runSync = vi.fn<ApiClient["runSync"]>(async () => ({
      pushed: 2,
      pulled: 1,
      conflicts: 0,
      skipped: 0,
    }));
    mount(
      () => <SharingPanel projectId="project-1" />,
      clientWith({ runSync }),
    );
    expect(
      await screen.findByRole("heading", { name: "Connected to Acme" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Sharing setup")).not.toBeVisible();
    fireEvent.click(
      await screen.findByRole("button", { name: "Manage sharing" }),
    );
    expect(screen.getByLabelText("Sharing setup")).toHaveTextContent(
      "Connect team",
    );
    expect(screen.getByLabelText("Sharing setup")).toHaveTextContent(
      "Choose sharing",
    );
    expect(screen.getByLabelText("Sharing setup")).toHaveTextContent(
      "Keep in sync",
    );
    expect(screen.getByTestId("sharing-sync")).toHaveTextContent(
      "Background sync configured",
    );
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    expect(
      await screen.findByText("Sync complete: pushed 2, pulled 1."),
    ).toBeInTheDocument();
    expect(runSync).toHaveBeenCalledTimes(1);
  });

  it("requires explicit unlink confirmation and allows cancelling without a write", async () => {
    const linkProjectToTeam = vi.fn<ApiClient["linkProjectToTeam"]>(
      async () => unlinked,
    );
    mount(
      () => <SharingPanel projectId="project-1" />,
      clientWith({ linkProjectToTeam }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Manage sharing" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Unlink" }));
    let dialog = await screen.findByTestId("sharing-unlink-confirmation");
    expect(dialog).toHaveTextContent("copies already on teammates’ devices");
    expect(linkProjectToTeam).not.toHaveBeenCalled();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Keep connected" }),
    );
    expect(linkProjectToTeam).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Unlink" }));
    dialog = await screen.findByTestId("sharing-unlink-confirmation");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Unlink project" }),
    );
    await waitFor(() =>
      expect(linkProjectToTeam).toHaveBeenCalledWith(
        "project-1",
        null,
        "team-1",
      ),
    );
  });

  it("explains disabled sync with an actionable setup command", async () => {
    mount(
      () => <SharingPanel projectId="project-1" />,
      clientWith({
        getProjectSharing: async () => ({
          ...automaticSharing,
          state: "degraded",
          detail: "Sync is disabled",
        }),
        getSyncStatus: async () => ({
          enabled: false,
          state: "disabled",
          pending_changes: null,
        }),
      }),
    );
    expect(await screen.findByText("lore sync enable")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Sync now" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Check again" }),
    ).toBeInTheDocument();
  });

  it("explains an empty team list instead of leaving an inert picker", async () => {
    mount(
      () => <SharingPanel projectId="project-1" />,
      clientWith({
        getProjectSharing: async () => unlinked,
        getTeams: async () => ({ hosted: false, teams: [] }),
      }),
    );
    expect(
      await screen.findByRole("link", { name: "Find or create a team" }),
    ).toHaveAttribute("href", "/ui/team");
    expect(
      screen.queryByRole("combobox", { name: "Link to team" }),
    ).not.toBeInTheDocument();
  });

  it("does not allow connecting a viewer-only team", async () => {
    const linkProjectToTeam = vi.fn<ApiClient["linkProjectToTeam"]>(
      async () => automaticSharing,
    );
    mount(
      () => <SharingPanel projectId="project-1" />,
      clientWith({
        getProjectSharing: async () => unlinked,
        getTeams: async () => ({
          hosted: false,
          teams: [{ ...teams.teams[0]!, role: "viewer" }],
        }),
        linkProjectToTeam,
      }),
    );
    expect(
      await screen.findByText(
        "An editor or admin can connect this project to a team.",
      ),
    ).toBeInTheDocument();
    expect(linkProjectToTeam).not.toHaveBeenCalled();
  });

  it("explains the consequence of turning automatic sharing off", async () => {
    mount(() => <SharingPanel projectId="project-1" />, clientWith({}));
    fireEvent.click(
      await screen.findByRole("button", { name: "Manage sharing" }),
    );
    fireEvent.click(
      await screen.findByRole("switch", { name: "Share automatically" }),
    );
    const dialog = await screen.findByTestId("sharing-policy-confirmation");
    expect(dialog).toHaveTextContent(
      "You’ll choose which new entries to propose",
    );
  });
});

describe("sharing sync status recovery", () => {
  it("does not revive a stale enabled status while a failed read is retrying", async () => {
    const pending = deferred<Awaited<ReturnType<ApiClient["getSyncStatus"]>>>();
    const getSyncStatus = vi
      .fn<ApiClient["getSyncStatus"]>()
      .mockResolvedValueOnce({
        enabled: true,
        state: "idle",
        pending_changes: 2,
      })
      .mockRejectedValueOnce(false)
      .mockImplementationOnce(() => pending.promise);
    const Harness = () => {
      const ws = useWorkspace();
      return (
        <>
          <SharingPanel projectId="project-1" />
          <button onClick={() => ws.state.folk.refresh()}>
            Refresh sync status
          </button>
        </>
      );
    };
    mount(Harness, clientWith({ getSyncStatus }));
    await screen.findByRole("button", { name: "Sync now" });
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh sync status" }),
    );
    await screen.findByRole("heading", { name: "Sync status unavailable" });
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(getSyncStatus).toHaveBeenCalledTimes(3));
    expect(
      screen.queryByRole("button", { name: "Sync now" }),
    ).not.toBeInTheDocument();
    pending.resolve({ enabled: true, state: "idle", pending_changes: 0 });
    await screen.findByRole("button", { name: "Sync now" });
  });
});

describe("sharing consent and locked device recovery", () => {
  const unlinked: SharingStatus = {
    linked: false,
    team: null,
    policy: { effective: "manual", project_override: null, team_default: null },
    auto_share: false,
    review_required: null,
    state: "not_linked",
    detail: null,
  };
  it("connecting does not silently opt into automatic proposals", async () => {
    const setProjectAutoShare = vi.fn<ApiClient["setProjectAutoShare"]>();
    const linkProjectToTeam = vi.fn<ApiClient["linkProjectToTeam"]>(
      async () => manualSharing,
    );
    mount(
      () => <SharingPanel projectId="project-1" />,
      clientWith({
        getProjectSharing: async () => unlinked,
        linkProjectToTeam,
        setProjectAutoShare,
      }),
    );
    const picker = await screen.findByRole("combobox", {
      name: "Link to team",
    });
    expect(screen.getByTestId("sharing-panel")).toHaveTextContent(
      "New entries stay private",
    );
    expect(linkProjectToTeam).not.toHaveBeenCalled();
    fireEvent.change(picker, { target: { value: "team-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Link to team" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Manage sharing" }),
    );
    expect(
      await screen.findByRole("switch", { name: "Share automatically" }),
    ).not.toBeChecked();
    expect(setProjectAutoShare).not.toHaveBeenCalled();
  });

  it("offers encryption unlock and retry when an enabled unlinked device cannot sync", async () => {
    const runSync = vi
      .fn<ApiClient["runSync"]>()
      .mockRejectedValueOnce(
        new ApiError(
          "http",
          "/sync/run",
          "Unlock encryption before syncing.",
          409,
          "encryption_locked",
        ),
      )
      .mockResolvedValueOnce({
        pushed: 1,
        pulled: 0,
        conflicts: 0,
        skipped: 0,
      });
    mount(
      () => <SharingPanel projectId="project-1" />,
      clientWith({ getProjectSharing: async () => unlinked, runSync }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Sync now" }));
    expect(
      await screen.findByRole("heading", {
        name: "Unlock sync on this device",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("lore sync enable")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try sync again" }));
    expect(
      await screen.findByText("Sync complete: pushed 1, pulled 0."),
    ).toBeInTheDocument();
    expect(runSync).toHaveBeenCalledTimes(2);
  });
});

it("explains how to restart an already-running hosted gateway", async () => {
  mount(
    () => <SharingPanel projectId="project-1" />,
    clientWith({
      getAccount: async () => ({
        signed_in: false,
        user: null,
        provider: null,
        expires_at: null,
        state: "hosted",
      }),
    }),
  );
  expect(
    await screen.findByText("lore stop && lore start --local --bg"),
  ).toBeInTheDocument();
  expect(screen.getByTestId("sharing-sync")).toHaveTextContent("Ctrl+C");
});

it("uses a newer sync-disabled result instead of checking the setup step from a stale status read", async () => {
  mount(
    () => <SharingPanel projectId="project-1" />,
    clientWith({
      runSync: async () => {
        throw new ApiError(
          "http",
          "/sync/run",
          "Enable sync before running it.",
          409,
          "sync_disabled",
        );
      },
    }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Sync now" }));
  await screen.findByRole("heading", { name: "Enable background sync" });
  expect(screen.getByLabelText("Sharing setup")).not.toHaveTextContent(
    "Enabled on this device",
  );
});

it.each([403, 404])(
  "distinguishes a browser gateway denial (%s) from cloud sign-in",
  async (status) => {
    mount(
      () => <SharingPanel projectId="project-1" />,
      clientWith({
        runSync: async () => {
          throw new ApiError(
            "unauthorized",
            "/sync/run",
            "Gateway refused this browser",
            status,
          );
        },
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Sync now" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Gateway refused this browser",
    );
    expect(screen.queryByText("lore login")).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Restore browser access" }),
    ).toBeInTheDocument();
  },
);

it.each([
  "encryption_locked",
  "sync_disabled",
  "unauthorized",
  "gateway_access",
] as const)(
  "lets Check again recover from a stale %s sync blocker",
  async (blocker) => {
    const message = "Previous sync could not run";
    const runSync = vi
      .fn<ApiClient["runSync"]>()
      .mockRejectedValueOnce(
        new ApiError(
          blocker === "gateway_access" ? "unauthorized" : "http",
          "/sync/run",
          message,
          403,
          blocker === "gateway_access" ? undefined : blocker,
        ),
      )
      .mockResolvedValueOnce({
        pushed: 1,
        pulled: 0,
        conflicts: 0,
        skipped: 0,
      });
    const getSyncStatus = vi.fn<ApiClient["getSyncStatus"]>(async () => ({
      enabled: true,
      state: "idle",
      pending_changes: 0,
    }));
    mount(
      () => <SharingPanel projectId="project-1" />,
      clientWith({ runSync, getSyncStatus }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Sync now" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      blocker === "unauthorized" ? "Sign in again before syncing." : message,
    );
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(getSyncStatus).toHaveBeenCalledTimes(2));
    const retry = await screen.findByRole("button", { name: "Sync now" });
    await waitFor(() => expect(retry).toBeEnabled());
    fireEvent.click(retry);
    expect(
      await screen.findByText("Sync complete: pushed 1, pulled 0."),
    ).toBeVisible();
    expect(screen.queryByText(message)).not.toBeInTheDocument();
  },
);

it("keeps a notAuthed receipt blocked during its automatic status refresh", async () => {
  const getSyncStatus = vi.fn<ApiClient["getSyncStatus"]>(async () => ({
    enabled: true,
    state: "idle",
    pending_changes: 0,
  }));
  mount(
    () => <SharingPanel projectId="project-1" />,
    clientWith({
      getSyncStatus,
      runSync: async () => ({
        pushed: 0,
        pulled: 0,
        conflicts: 0,
        skipped: 0,
        notAuthed: true,
      }),
    }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Sync now" }));
  await waitFor(() => expect(getSyncStatus).toHaveBeenCalledTimes(2));
  expect(await screen.findByText("lore login")).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Sync now" }),
  ).not.toBeInTheDocument();
});

it("preserves a newer sync failure when a settings refresh finishes later", async () => {
  const refreshedAccount = deferred<AccountStatus>();
  let accountReads = 0;
  let rejectSync!: (reason: unknown) => void;
  mount(
    () => {
      const folk = useWorkspace().state.folk;
      return (
        <>
          <SharingPanel projectId="project-1" />
          <button onClick={() => folk.refresh()}>Refresh settings</button>
        </>
      );
    },
    clientWith({
      getAccount: async () =>
        ++accountReads > 1 ? refreshedAccount.promise : account,
      runSync: () =>
        new Promise((_resolve, reject) => {
          rejectSync = reject;
        }),
    }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Sync now" }));
  fireEvent.click(screen.getByRole("button", { name: "Refresh settings" }));
  await waitFor(() => expect(accountReads).toBe(2));
  rejectSync(
    new ApiError(
      "http",
      "/sync/run",
      "Encryption is still locked",
      409,
      "encryption_locked",
    ),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Encryption is still locked",
  );
  refreshedAccount.resolve(account);
  await waitFor(() =>
    expect(
      screen.getByRole("heading", { name: "Unlock sync on this device" }),
    ).toBeVisible(),
  );
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Encryption is still locked",
  );
});

it.each([
  ["success", "same"],
  ["failure", "same"],
  ["success", "other"],
  ["failure", "other"],
  ["success", "signed_out"],
  ["failure", "signed_out"],
] as const)(
  "quarantines an in-flight sync %s during an account outage before %s account recovery",
  async (outcome, recovery) => {
    let accountUnavailable = false;
    let recoveredAccount = account;
    let folk!: FolkState;
    let resolveSync!: (
      value: Awaited<ReturnType<ApiClient["runSync"]>>,
    ) => void;
    let rejectSync!: (error: unknown) => void;
    let syncCalls = 0;
    mount(
      () => {
        folk = useWorkspace().state.folk;
        return <SharingPanel projectId="project-1" />;
      },
      clientWith({
        getAccount: async () => {
          if (accountUnavailable)
            throw new Error("Temporary account read failure");
          return recoveredAccount;
        },
        runSync: () => {
          syncCalls++;
          return new Promise((resolve, reject) => {
            resolveSync = resolve;
            rejectSync = reject;
          });
        },
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Sync now" }));
    accountUnavailable = true;
    folk.refresh();
    await waitFor(() => expect(folk.account.error()).toBeDefined());
    if (outcome === "success")
      resolveSync({ pushed: 7, pulled: 2, conflicts: 0, skipped: 0 });
    else
      rejectSync(
        new ApiError(
          "http",
          "/sync/run",
          "Unlock encryption before syncing.",
          409,
          "encryption_locked",
        ),
      );
    await waitFor(() => expect(folk.syncing()).toBe(false));
    expect(folk.syncReceipt()).toBeNull();
    expect(folk.syncError()).toBeNull();
    expect(folk.syncResult()).toBeNull();
    await folk.runSync();
    expect(syncCalls).toBe(1);
    // Check again must not discard an unseen failure while restoring identity.
    accountUnavailable = false;
    if (recovery === "other")
      recoveredAccount = {
        ...account,
        user: { ...account.user!, id: "other-user" },
      };
    if (recovery === "signed_out")
      recoveredAccount = {
        ...account,
        signed_in: false,
        state: "anonymous",
        user: null,
      };
    folk.refresh();
    await waitFor(() =>
      expect(folk.confirmedAccount()).toEqual(recoveredAccount),
    );
    if (recovery !== "same") {
      expect(folk.syncReceipt()).toBeNull();
      expect(folk.syncError()).toBeNull();
      expect(folk.syncResult()).toBeNull();
      expect(folk.syncBlocker()).toBeNull();
      return;
    }
    if (outcome === "success")
      expect(
        await screen.findByText("Sync complete: pushed 7, pulled 2."),
      ).toBeVisible();
    else
      expect(
        await screen.findByText("Unlock encryption before syncing."),
      ).toBeVisible();
  },
);

it("uses cloud sign-in guidance for an explicit unauthorized 401 sync response", async () => {
  mount(
    () => <SharingPanel projectId="project-1" />,
    clientWith({
      runSync: async () => {
        throw new ApiError(
          "unauthorized",
          "/sync/run",
          "Gateway refused this browser",
          401,
          "unauthorized",
        );
      },
    }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Sync now" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Sign in again before syncing.",
  );
  expect(
    screen.queryByText("Gateway refused this browser"),
  ).not.toBeInTheDocument();
  expect(screen.getByText("lore login")).toBeVisible();
});

it("does not revive an old sync after a different user appears during account recovery", async () => {
  let currentAccount = account;
  let folk!: FolkState;
  let resolveSync!: (value: Awaited<ReturnType<ApiClient["runSync"]>>) => void;
  mount(
    () => {
      folk = useWorkspace().state.folk;
      return <SharingPanel projectId="project-1" />;
    },
    clientWith({
      getAccount: async () => currentAccount,
      runSync: () =>
        new Promise((resolve) => {
          resolveSync = resolve;
        }),
    }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Sync now" }));
  currentAccount = {
    ...account,
    signed_in: false,
    state: "refreshing",
    user: { ...account.user!, id: "other-user" },
  };
  folk.account.reload();
  await waitFor(() =>
    expect(folk.confirmedAccount()?.user?.id).toBe("other-user"),
  );
  resolveSync({ pushed: 7, pulled: 2, conflicts: 0, skipped: 0 });
  await waitFor(() => expect(folk.syncing()).toBe(false));
  currentAccount = account;
  folk.account.reload();
  await waitFor(() => expect(folk.confirmedAccount()?.state).toBe("signed_in"));
  expect(folk.syncReceipt()).toBeNull();
  expect(folk.syncResult()).toBeNull();
});
