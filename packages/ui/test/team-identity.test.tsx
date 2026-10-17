import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import type { AccountStatus, TeamList, TeamMembersResponse } from "~/contracts";
import type { ApiClient } from "~/lib/api";
import { TeamPage } from "~/components/lore/TeamPage";
import { WorkspaceProvider } from "~/routes/workspace";

const account = (id: string): AccountStatus => ({
  signed_in: true,
  state: "signed_in",
  provider: "github",
  expires_at: null,
  user: { id, email: null, display_name: id },
});
const teamList = (admin: boolean): TeamList => ({
  hosted: false,
  teams: [
    {
      id: "shared-team",
      name: "Shared",
      role: admin ? "admin" : "viewer",
      member_count: 2,
    },
  ],
});
const members = (id: string): TeamMembersResponse => ({
  remote: "ok",
  team: { id: "shared-team", name: "Shared" },
  my_role: id === "user-a" ? "admin" : "viewer",
  can_manage: id === "user-a",
  members: [
    { user_id: "user-a", label: "User A", role: "admin", me: id === "user-a" },
    { user_id: "user-b", label: "User B", role: "viewer", me: id === "user-b" },
  ],
  actions: {
    invite: id === "user-a" ? "available" : "admin_only",
    remove: id === "user-a" ? "available" : "admin_only",
    set_role: id === "user-a" ? "available" : "admin_only",
    add_by_id: id === "user-a" ? "available" : "admin_only",
    offline_invite: "available",
    list_invites: "unsupported",
    revoke_invite: "unsupported",
  },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup(overrides: Partial<ApiClient> = {}) {
  let current: AccountStatus = account("user-a");
  const api = {
    listProjects: async () => [],
    getAccount: async () => current,
    getTeams: async () => teamList(current.user?.id === "user-a"),
    getSyncStatus: async () => ({
      enabled: true,
      state: "idle",
      pending_changes: 0,
    }),
    getTeamMembers: async () => members(current.user!.id),
    getTeamReviewPolicy: async () => ({ policy: "required" }),
    getOrganizations: async () => ({ organizations: [] }),
    ...overrides,
  } as unknown as ApiClient;
  render(() => (
    <WorkspaceProvider client={api} db={Promise.resolve(null)}>
      <TeamPage />
    </WorkspaceProvider>
  ));
  return {
    api,
    switchTo(value: AccountStatus) {
      current = value;
      fireEvent(window, new Event("focus"));
    },
  };
}

describe("TeamPage account identity", () => {
  it("invalidates admin permissions immediately when another account shares the same team", async () => {
    const nextTeams = deferred<TeamList>();
    const nextMembers = deferred<TeamMembersResponse>();
    let switched = false;
    const getTeamMembers = vi.fn(async () =>
      switched ? nextMembers.promise : members("user-a"),
    );
    const view = setup({
      getTeams: async () => (switched ? nextTeams.promise : teamList(true)),
      getTeamMembers,
    });
    expect(await screen.findByLabelText("Role for User B")).toBeEnabled();
    switched = true;
    view.switchTo(account("user-b"));
    await waitFor(() =>
      expect(screen.queryByTestId("team-members")).not.toBeInTheDocument(),
    );
    nextTeams.resolve(teamList(false));
    await waitFor(() => expect(getTeamMembers).toHaveBeenCalledTimes(2));
    nextMembers.resolve(members("user-b"));
    await waitFor(() =>
      expect(screen.getByLabelText("Role for User B")).toBeDisabled(),
    );
    const row = screen
      .getAllByTestId("team-member-row")
      .find((element) => element.dataset.userId === "user-b")!;
    expect(within(row).getByText("You")).toBeInTheDocument();
  });

  it("waits for the new account's team list before reading members of a different team", async () => {
    const nextTeams = deferred<TeamList>();
    const obsolete = deferred<TeamMembersResponse>();
    let switched = false;
    const getTeamMembers = vi.fn(async (id: string) => {
      if (!switched) return members("user-a");
      if (id === "shared-team") return obsolete.promise;
      return { ...members("user-b"), team: { id: "team-b", name: "B team" } };
    });
    const view = setup({
      getTeams: async () => (switched ? nextTeams.promise : teamList(true)),
      getTeamMembers,
    });
    await screen.findByLabelText("Role for User B");
    switched = true;
    view.switchTo(account("user-b"));
    await waitFor(() =>
      expect(screen.queryByTestId("team-members")).not.toBeInTheDocument(),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getTeamMembers).toHaveBeenCalledTimes(1);
    nextTeams.resolve({
      hosted: false,
      teams: [
        { id: "team-b", name: "B team", role: "viewer", member_count: 2 },
      ],
    });
    await waitFor(() =>
      expect(getTeamMembers).toHaveBeenLastCalledWith("team-b"),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Role for User B")).toBeDisabled(),
    );
    expect(screen.getByText("B team · your role: viewer")).toBeInTheDocument();
    obsolete.resolve(members("user-a"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByText("B team · your role: viewer")).toBeInTheDocument();
  });

  it("ignores an old account's pending member response after the new account loaded", async () => {
    const previous = deferred<TeamMembersResponse>();
    const getTeamMembers = vi
      .fn()
      .mockReturnValueOnce(previous.promise)
      .mockResolvedValue(members("user-b"));
    const view = setup({ getTeamMembers });
    await waitFor(() => expect(getTeamMembers).toHaveBeenCalledTimes(1));
    view.switchTo(account("user-b"));
    await waitFor(() => expect(getTeamMembers).toHaveBeenCalledTimes(2));
    expect(await screen.findByLabelText("Role for User B")).toBeDisabled();
    previous.resolve(members("user-a"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await waitFor(() =>
      expect(screen.getByLabelText("Role for User B")).toBeDisabled(),
    );
    const row = screen
      .getAllByTestId("team-member-row")
      .find((element) => element.dataset.userId === "user-b")!;
    expect(within(row).getByText("You")).toBeInTheDocument();
  });

  it("keeps same-account form DOM and drafts while a poll disables mutation submission", async () => {
    const pending = deferred<AccountStatus>();
    let polling = false;
    const invite = vi.fn();
    const getTeamMembers = vi.fn(async () => members("user-a"));
    const view = setup({
      getAccount: async () => (polling ? pending.promise : account("user-a")),
      inviteTeamMember: invite,
      getTeamMembers,
      getTeams: async () => {
        const list = teamList(true);
        return {
          ...list,
          teams: [...list.teams, { ...list.teams[0]!, id: "other-team" }],
        };
      },
    });
    const input = await screen.findByLabelText("Invite email");
    fireEvent.input(input, { target: { value: "draft@example.com" } });
    polling = true;
    view.switchTo(account("user-a"));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Create invite" }),
      ).toBeDisabled(),
    );
    expect(screen.getByLabelText("Invite email")).toBe(input);
    expect(input).toHaveValue("draft@example.com");
    fireEvent.submit(input.closest("form")!);
    expect(invite).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("combobox", { name: "Team" }), {
      target: { value: "shared-team" },
    });
    expect(getTeamMembers).toHaveBeenCalledTimes(1);
    pending.resolve(account("user-a"));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Create invite" }),
      ).toBeEnabled(),
    );
    expect(screen.getByLabelText("Invite email")).toBe(input);
    expect(input).toHaveValue("draft@example.com");
  });

  it("preserves a portal draft while the same account is being checked and guards its submit", async () => {
    const pending = deferred<AccountStatus>();
    let polling = false;
    const accept = vi.fn();
    const view = setup({
      getAccount: async () => (polling ? pending.promise : account("user-a")),
      acceptTeamInvite: accept,
    });
    await screen.findByLabelText("Invite email");
    const join = await screen.findByTestId("team-join");
    await waitFor(() => expect(join).toBeEnabled());
    fireEvent.click(join);
    const input = await screen.findByTestId("team-invite-token");
    fireEvent.input(input, { target: { value: "invitation-draft" } });
    polling = true;
    view.switchTo(account("user-a"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Join team" })).toBeDisabled(),
    );
    expect(screen.getByTestId("team-invite-token")).toBe(input);
    fireEvent.submit(input.closest("form")!);
    expect(accept).not.toHaveBeenCalled();
    pending.resolve(account("user-a"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Join team" })).toBeEnabled(),
    );
    expect(input).toHaveValue("invitation-draft");
  });

  it("ignores a join completion after its account-owned portal has unmounted", async () => {
    const pending =
      deferred<Awaited<ReturnType<ApiClient["acceptTeamInvite"]>>>();
    const getTeams = vi.fn(async () => teamList(true));
    const accept = vi.fn(() => pending.promise);
    const view = setup({ getTeams, acceptTeamInvite: accept });
    const join = await screen.findByTestId("team-join");
    await waitFor(() => expect(join).toBeEnabled());
    fireEvent.click(join);
    const input = await screen.findByTestId("team-invite-token");
    fireEvent.input(input, { target: { value: "invitation-draft" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(accept).toHaveBeenCalledTimes(1));
    view.switchTo(account("user-b"));
    await waitFor(() =>
      expect(screen.queryByTestId("team-join-dialog")).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Role for User B")).toBeDisabled(),
    );
    const calls = getTeams.mock.calls.length;
    pending.resolve({} as Awaited<ReturnType<ApiClient["acceptTeamInvite"]>>);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getTeams).toHaveBeenCalledTimes(calls);
  });

  it("discards a pending policy mutation receipt after an account switch", async () => {
    const mutation = deferred<{ policy: "optional" }>();
    const update = vi.fn(() => mutation.promise);
    const view = setup({ setTeamReviewPolicy: update });
    const toggle = await screen.findByTestId("team-require-review");
    await waitFor(() => expect(toggle).toBeEnabled());
    fireEvent.click(toggle);
    const dialog = await screen.findByTestId("team-review-policy-confirmation");
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "Turn off review",
      }),
    );
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    view.switchTo(account("user-b"));
    await waitFor(() =>
      expect(
        screen.queryByTestId("team-review-policy-confirmation"),
      ).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.getByTestId("team-require-review")).toBeDisabled(),
    );
    mutation.resolve({ policy: "optional" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await waitFor(() =>
      expect(screen.getByTestId("team-require-review")).toBeChecked(),
    );
  });
});
