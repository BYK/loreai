import type { Component } from "solid-js";
import {
  createEffect,
  createSignal,
  For,
  Match,
  onMount,
  Show,
  Switch,
} from "solid-js";
import {
  createColumnHelper,
  createTable,
  flexRender,
  tableFeatures,
} from "@tanstack/solid-table";

import type {
  TeamInviteReceipt,
  TeamMembersResponse,
  TeamRemovalReceipt,
  TeamRoleReceipt,
} from "~/contracts";
import { ApiError } from "~/lib/api";
import { useWorkspace } from "~/routes/workspace";
import { Button } from "~/components/ui/button";
import { requiresMutationReload } from "./mutation-errors";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { StateCard } from "./StateCard";
import { PromotionIdentity } from "./PromotionIdentity";

type PageState =
  | "loading"
  | "anonymous"
  | "hosted"
  | "unreachable"
  | "error"
  | "no_team"
  | "ready";
type TeamMember = TeamMembersResponse["members"][number];
type Role = "admin" | "editor" | "viewer";
type MutationFailure = { cause: unknown; message: string };

const features = tableFeatures({});
const helper = createColumnHelper<typeof features, TeamMember>();

function pageStateForError(error: unknown): PageState {
  if (error instanceof ApiError && error.kind === "unreachable")
    return "unreachable";
  if (error instanceof ApiError && error.kind === "forbidden") return "hosted";
  return "error";
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The team could not be loaded.";
}

function actionMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "encryption_locked")
      return "Unlock team encryption with `lore sync enable` before changing team members.";
    if (error.code === "sync_disabled")
      return "Enable sync with `lore sync enable` before changing team members.";
  }
  return errorMessage(error);
}

function memberLabel(member: TeamMember): string {
  return member.label ?? "Former member";
}

export const TeamPage: Component = () => {
  const ws = useWorkspace();
  const folk = ws.state.folk;
  const [pageState, setPageState] = createSignal<PageState>("loading");
  const [teamId, setTeamId] = createSignal("");
  const [members, setMembers] = createSignal<TeamMembersResponse>();
  const [loadingMembers, setLoadingMembers] = createSignal(false);
  const [pageError, setPageError] = createSignal<unknown>();
  const [actionError, setActionError] = createSignal("");
  const [staleMemberId, setStaleMemberId] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [inviteRole, setInviteRole] = createSignal<"editor" | "viewer">(
    "viewer",
  );
  const [inviteEmail, setInviteEmail] = createSignal("");
  const [inviteReceipt, setInviteReceipt] =
    createSignal<TeamInviteReceipt | null>(null);
  const [inviteError, setInviteError] = createSignal("");
  const [copyMessage, setCopyMessage] = createSignal("");
  const [removeTarget, setRemoveTarget] = createSignal<TeamMember | null>(null);
  const [removeError, setRemoveError] = createSignal<MutationFailure | null>(
    null,
  );
  const [removeReceipt, setRemoveReceipt] =
    createSignal<TeamRemovalReceipt | null>(null);
  const [roleReceipt, setRoleReceipt] = createSignal<TeamRoleReceipt | null>(
    null,
  );
  const [leftTeam, setLeftTeam] = createSignal(false);
  const [removing, setRemoving] = createSignal(false);

  const teams = () => folk.teams.data()?.teams ?? [];
  const columns = helper.columns([
    helper.accessor((row) => row.user_id, {
      id: "member",
      header: "Member",
    }),
    helper.accessor((row) => row.role, { id: "role", header: "Role" }),
    helper.display({ id: "actions", header: "Actions" }),
  ]);
  const table = createTable({
    features,
    columns,
    get data() {
      return members()?.members ?? [];
    },
    getRowId: (row) => row.user_id,
  });

  const loadMembers = async (selectedTeam: string) => {
    if (!selectedTeam) return;
    if (selectedTeam !== teamId()) {
      setStaleMemberId(null);
      setRemoveReceipt(null);
      setRoleReceipt(null);
      setLeftTeam(false);
    }
    setTeamId(selectedTeam);
    setPageState("loading");
    setPageError(undefined);
    setActionError("");
    setLoadingMembers(true);
    try {
      const response = await ws.tracked(() =>
        ws.client.getTeamMembers(selectedTeam),
      );
      setMembers(response);
      if (response.remote === "anonymous") setPageState("anonymous");
      else if (response.remote === "hosted") setPageState("hosted");
      else if (response.remote === "unreachable") setPageState("unreachable");
      else setPageState("ready");
    } catch (error) {
      setPageError(error);
      setPageState(pageStateForError(error));
    } finally {
      setLoadingMembers(false);
    }
  };

  createEffect(() => {
    const account = folk.account.data();
    const accountError = folk.account.error();
    const teamList = folk.teams.data();
    const teamsError = folk.teams.error();
    if (teamList?.hosted) {
      setPageState("hosted");
      return;
    }
    if (accountError) {
      setPageError(accountError);
      setPageState(pageStateForError(accountError));
      return;
    }
    if (!account) return;
    if (!account.signed_in) {
      setPageState("anonymous");
      return;
    }
    if (teamsError) {
      setPageError(teamsError);
      setPageState(pageStateForError(teamsError));
      return;
    }
    if (!teamList) return;
    if (teamList.teams.length === 0) {
      setPageState("no_team");
      return;
    }
    const selected =
      teamList.teams.find((team) => team.id === teamId()) ?? teamList.teams[0]!;
    if (teamId() !== selected.id) void loadMembers(selected.id);
  });

  onMount(() => folk.refresh());

  const retry = () => {
    setPageError(undefined);
    folk.refresh();
    if (teamId()) void loadMembers(teamId());
  };

  const staleMemberNotice = () => {
    const id = staleMemberId();
    if (!id) return "";
    const member = members()?.members.find((item) => item.user_id === id);
    const teammate = member ? memberLabel(member) : "Former member";
    if (!member)
      return `${teammate}'s team membership changed since you loaded the team. The list has been reloaded.`;
    const role = member.role.charAt(0).toUpperCase() + member.role.slice(1);
    return `${teammate}'s role changed to ${role} since you loaded the team. The list has been reloaded.`;
  };

  const changeRole = async (
    member: TeamMember,
    role: Role,
    select: HTMLSelectElement,
  ) => {
    const current = members();
    if (!current || !current.can_manage || role === member.role || busy())
      return;
    setBusy(true);
    setActionError("");
    setRoleReceipt(null);
    try {
      const receipt = await ws.tracked(() =>
        ws.client.setTeamMemberRole(
          current.team?.id ?? teamId(),
          member.user_id,
          role,
          member.role as Role,
        ),
      );
      setStaleMemberId(null);
      setRoleReceipt(receipt);
      setMembers((previous) =>
        previous
          ? {
              ...previous,
              my_role: member.me ? receipt.member.role : previous.my_role,
              can_manage: member.me
                ? receipt.member.role === "admin"
                : previous.can_manage,
              members: previous.members.map((row) =>
                row.user_id === receipt.member.user_id
                  ? { ...row, role: receipt.member.role }
                  : row,
              ),
            }
          : previous,
      );
    } catch (error) {
      select.value = member.role;
      if (error instanceof ApiError && error.code === "stale_member") {
        setStaleMemberId(member.user_id);
        setActionError("");
        void loadMembers(teamId());
      } else {
        setActionError(actionMessage(error));
      }
    } finally {
      setBusy(false);
    }
  };

  const submitInvite = async (event: SubmitEvent) => {
    event.preventDefault();
    const current = members();
    if (!current || current.actions.invite !== "available" || busy()) return;
    setBusy(true);
    setInviteError("");
    setCopyMessage("");
    try {
      const receipt = await ws.tracked(() =>
        ws.client.inviteTeamMember(current.team?.id ?? teamId(), {
          role: inviteRole(),
          ...(inviteEmail().trim() ? { email: inviteEmail().trim() } : {}),
        }),
      );
      setStaleMemberId(null);
      setInviteReceipt(receipt);
      setInviteEmail("");
    } catch (error) {
      setInviteError(actionMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const confirmRemove = async () => {
    const target = removeTarget();
    const current = members();
    if (!target || !current || busy()) return;
    setBusy(true);
    setRemoving(true);
    setRemoveError(null);
    try {
      const receipt = await ws.tracked(() =>
        ws.client.removeTeamMember(
          current.team?.id ?? teamId(),
          target.user_id,
          target.role as Role,
        ),
      );
      setStaleMemberId(null);
      setRemoveReceipt(receipt);
      setLeftTeam(target.me);
      setMembers((previous) =>
        previous
          ? {
              ...previous,
              my_role: target.me ? null : previous.my_role,
              can_manage: target.me ? false : previous.can_manage,
              members: previous.members.filter(
                (member) => member.user_id !== receipt.removed,
              ),
            }
          : previous,
      );
      setRemoveTarget(null);
      folk.refresh();
    } catch (error) {
      setRemoveError({ cause: error, message: actionMessage(error) });
    } finally {
      setRemoving(false);
      setBusy(false);
    }
  };

  const closeRemove = () => {
    if (removing()) return;
    setRemoveTarget(null);
    setRemoveError(null);
  };

  const reloadAfterRemoveError = () => {
    const target = removeTarget();
    if (!target) return;
    const error = removeError()?.cause;
    if (error instanceof ApiError && error.code === "stale_member")
      setStaleMemberId(target.user_id);
    setRemoveTarget(null);
    setRemoveError(null);
    void loadMembers(teamId());
  };

  const copyAcceptCommand = async () => {
    const receipt = inviteReceipt();
    if (!receipt) return;
    try {
      await navigator.clipboard.writeText(receipt.invite.accept_command);
      setCopyMessage("Accept command copied.");
    } catch {
      setCopyMessage("Clipboard is unavailable; copy the command above.");
    }
  };

  const closeInviteReceipt = (open: boolean) => {
    if (!open) {
      setInviteReceipt(null);
      setCopyMessage("");
    }
  };

  const inviteUnavailableReason = () => {
    const capability = members()?.actions.invite;
    if (capability === "admin_only")
      return "Only team admins can invite members.";
    if (capability === "unavailable")
      return "Invites are unavailable while the team service is offline.";
    return "";
  };

  const memberActionReason = (action: "remove" | "set_role") => {
    const capability = members()?.actions[action];
    if (!members()?.can_manage || capability === "admin_only")
      return "Only team admins can manage members.";
    if (capability === "unavailable")
      return "This action is unavailable while the team service is offline.";
    return "";
  };
  const onlyAdmin = () => {
    const current = members();
    return (
      current?.my_role === "admin" &&
      current.members.filter((member) => member.role === "admin").length === 1
    );
  };

  return (
    <section class="p-4 sm:p-6" data-testid="team-page">
      <div class="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 class="text-[25px] font-semibold">Team</h1>
          <p class="mt-1 text-sm text-muted">
            Manage team membership and invitation links.
          </p>
        </div>
        <Show when={teams().length > 1}>
          <label class="flex flex-col gap-1 text-xs text-muted">
            Team
            <select
              aria-label="Team"
              class="h-9 min-w-44 rounded-md border border-line bg-surface px-2 text-sm text-text"
              value={teamId()}
              onChange={(event) => void loadMembers(event.currentTarget.value)}
            >
              <For each={teams()}>
                {(team) => (
                  <option value={team.id}>{team.name ?? team.id}</option>
                )}
              </For>
            </select>
          </label>
        </Show>
      </div>

      <Show
        when={folk.sync.data()?.enabled === false && pageState() === "ready"}
      >
        <p
          class="mb-4 rounded-md border border-line bg-bg px-3 py-2 text-sm text-muted"
          role="status"
          data-testid="team-sync-disabled"
        >
          Team changes require sync and unlocked encryption. Enable sync with
          `lore sync enable`.
        </p>
      </Show>
      <Show when={staleMemberId() && pageState() === "ready"}>
        <p
          class="mb-4 rounded-md border border-line bg-bg px-3 py-2 text-sm"
          role="status"
          data-testid="team-stale-member-notice"
        >
          {staleMemberNotice()}
        </p>
      </Show>
      <Show when={actionError() && !removeTarget()}>
        <p class="mb-4 text-sm text-danger" role="alert">
          {actionError()}
        </p>
      </Show>
      <Show when={removeReceipt()}>
        {(receipt) => (
          <div
            class="mb-4 rounded-md border border-line bg-bg p-3 text-sm"
            role="status"
            data-testid="team-removal-receipt"
          >
            {leftTeam() ? "You left the team." : "Member removed."} Team key
            epoch {receipt().new_epoch}; {receipt().rewrapped} keys rewrapped;{" "}
            {receipt().skipped_count} member(s) without a published key need to
            be re-added.{" "}
            {receipt().unlinked_projects > 0
              ? `${receipt().unlinked_projects} linked local project(s) unlinked.`
              : ""}
          </div>
        )}
      </Show>

      <Switch>
        <Match when={pageState() === "loading"}>
          <StateCard kind="loading" title="Loading team" />
        </Match>
        <Match when={pageState() === "anonymous"}>
          <StateCard kind="locked" title="Sign in to manage a team">
            Sign in with `lore login` and join a team before managing its
            members.
          </StateCard>
        </Match>
        <Match when={pageState() === "hosted"}>
          <StateCard kind="locked" title="Team actions are unavailable">
            Team membership changes are not available in hosted mode.
          </StateCard>
        </Match>
        <Match when={pageState() === "unreachable"}>
          <StateCard
            kind="error"
            title="The team service could not be reached"
            action={
              <Button size="sm" variant="outline" onClick={retry}>
                Retry
              </Button>
            }
          >
            Try again when the gateway can reach Lore cloud.
          </StateCard>
        </Match>
        <Match when={pageState() === "error"}>
          <StateCard
            kind="error"
            title="The team could not be loaded"
            action={
              <Button size="sm" variant="outline" onClick={retry}>
                Retry
              </Button>
            }
          >
            {errorMessage(pageError())}
          </StateCard>
        </Match>
        <Match when={pageState() === "no_team"}>
          <StateCard kind="empty" title="No team memberships">
            Join a team with `lore team join` before managing team members.
          </StateCard>
        </Match>
        <Match when={pageState() === "ready"}>
          <Show when={members()}>
            {(current) => (
              <>
                <Show when={current().team}>
                  {(team) => (
                    <p class="mb-4 text-sm text-muted">
                      {team().name ?? team().id} · your role:{" "}
                      {current().my_role ?? "unknown"}
                    </p>
                  )}
                </Show>
                <Show when={onlyAdmin()}>
                  <p
                    class="mb-4 text-sm text-muted"
                    data-testid="team-only-admin-hint"
                  >
                    You're the only admin. Promote another member to admin
                    first.
                  </p>
                </Show>
                <Show when={roleReceipt()}>
                  {(receipt) => (
                    <p class="mb-4 text-sm text-muted" role="status">
                      {receipt().member.user_id} is now {receipt().member.role}.
                    </p>
                  )}
                </Show>
                <Show when={current().members.length === 0}>
                  <StateCard kind="empty" title="No team members are listed" />
                </Show>
                <Show when={current().members.length > 0}>
                  <div class="overflow-x-auto">
                    <table
                      class="min-w-[560px] w-full text-left text-sm"
                      data-testid="team-members"
                    >
                      <thead>
                        <For each={table.getHeaderGroups()}>
                          {(group) => (
                            <tr class="border-b border-line">
                              <For each={group.headers}>
                                {(header) => (
                                  <th class="px-2 py-2 font-semibold">
                                    {flexRender(
                                      header.column.columnDef.header,
                                      header.getContext(),
                                    )}
                                  </th>
                                )}
                              </For>
                            </tr>
                          )}
                        </For>
                      </thead>
                      <tbody>
                        <For each={table.getRowModel().rows}>
                          {(row) => (
                            <tr
                              class="border-b border-line align-top"
                              data-testid="team-member-row"
                              data-user-id={row.original.user_id}
                            >
                              <For each={row.getAllCells()}>
                                {(cell) => (
                                  <td class="px-2 py-3">
                                    <Switch>
                                      <Match when={cell.column.id === "member"}>
                                        <PromotionIdentity
                                          id={row.original.user_id}
                                          label={row.original.label}
                                          showId
                                        />
                                        <Show when={row.original.me}>
                                          <span class="ml-2 text-xs text-muted">
                                            You
                                          </span>
                                        </Show>
                                      </Match>
                                      <Match when={cell.column.id === "role"}>
                                        <div class="flex flex-wrap items-center gap-2">
                                          <select
                                            aria-label={`Role for ${memberLabel(row.original)}`}
                                            class="h-8 rounded-md border border-line bg-surface px-2 text-xs"
                                            value={row.original.role}
                                            disabled={
                                              busy() ||
                                              !current().can_manage ||
                                              current().actions.set_role !==
                                                "available"
                                            }
                                            onChange={(event) =>
                                              void changeRole(
                                                row.original,
                                                event.currentTarget
                                                  .value as Role,
                                                event.currentTarget,
                                              )
                                            }
                                          >
                                            <option value="admin">Admin</option>
                                            <option value="editor">
                                              Editor
                                            </option>
                                            <option value="viewer">
                                              Viewer
                                            </option>
                                          </select>
                                          <Show
                                            when={memberActionReason(
                                              "set_role",
                                            )}
                                          >
                                            <span class="text-xs text-muted">
                                              {memberActionReason("set_role")}
                                            </span>
                                          </Show>
                                        </div>
                                      </Match>
                                      <Match
                                        when={cell.column.id === "actions"}
                                      >
                                        <Button
                                          size="sm"
                                          variant="outline"
                                          disabled={
                                            busy() ||
                                            !current().can_manage ||
                                            current().actions.remove !==
                                              "available"
                                          }
                                          onClick={() =>
                                            setRemoveTarget(row.original)
                                          }
                                        >
                                          {row.original.me
                                            ? "Leave team"
                                            : "Remove"}
                                        </Button>
                                        <Show
                                          when={memberActionReason("remove")}
                                        >
                                          <span class="ml-2 text-xs text-muted">
                                            {memberActionReason("remove")}
                                          </span>
                                        </Show>
                                      </Match>
                                    </Switch>
                                  </td>
                                )}
                              </For>
                            </tr>
                          )}
                        </For>
                      </tbody>
                    </table>
                  </div>
                </Show>

                <section class="mt-6 rounded-lg border border-line bg-bg p-4">
                  <h2 class="text-base font-semibold">Invite a teammate</h2>
                  <Show when={inviteUnavailableReason()}>
                    <p class="mt-1 text-sm text-muted">
                      {inviteUnavailableReason()}
                    </p>
                  </Show>
                  <form
                    class="mt-3 flex flex-wrap items-end gap-3"
                    onSubmit={(event) => void submitInvite(event)}
                  >
                    <label class="flex flex-col gap-1 text-xs text-muted">
                      Role
                      <select
                        aria-label="Invite role"
                        class="h-9 rounded-md border border-line bg-surface px-2 text-sm text-text"
                        value={inviteRole()}
                        onChange={(event) =>
                          setInviteRole(
                            event.currentTarget.value as "editor" | "viewer",
                          )
                        }
                      >
                        <option value="viewer">Viewer</option>
                        <option value="editor">Editor</option>
                      </select>
                    </label>
                    <label class="flex min-w-56 flex-1 flex-col gap-1 text-xs text-muted">
                      Email (optional)
                      <input
                        aria-label="Invite email"
                        type="email"
                        maxLength={320}
                        value={inviteEmail()}
                        class="h-9 rounded-md border border-input bg-surface px-3 text-sm text-text"
                        onInput={(event) =>
                          setInviteEmail(event.currentTarget.value)
                        }
                      />
                    </label>
                    <Button
                      type="submit"
                      size="sm"
                      disabled={
                        busy() || current().actions.invite !== "available"
                      }
                    >
                      {busy() ? "Creating invite…" : "Create invite"}
                    </Button>
                  </form>
                  <Show when={inviteError()}>
                    <p class="mt-2 text-sm text-danger" role="alert">
                      {inviteError()}
                    </p>
                  </Show>
                  <div class="mt-4 space-y-1 border-t border-line pt-3 text-xs text-muted">
                    <p>
                      Pending invites list/revoke: not supported by the sync
                      service.
                    </p>
                    <p>Add by user id, offline invite: CLI only.</p>
                  </div>
                </section>
                <Show when={loadingMembers()}>
                  <p class="mt-2 text-xs text-muted" role="status">
                    Refreshing members…
                  </p>
                </Show>
              </>
            )}
          </Show>
        </Match>
      </Switch>

      <Dialog
        open={removeTarget() !== null}
        onOpenChange={(open) => {
          if (!open) closeRemove();
        }}
      >
        <DialogContent data-testid="team-remove-confirmation">
          <DialogHeader>
            <DialogTitle>
              {removeTarget()?.me ? "Leave team?" : "Remove team member?"}
            </DialogTitle>
            <DialogDescription>
              This rotates the team key.{" "}
              {removeTarget() ? memberLabel(removeTarget()!) : "This member"}{" "}
              will lose access to future team content; copies already synced to
              their device cannot be revoked. All outstanding invite links for
              this team are revoked. Members without a published key must be
              re-added to regain access.
            </DialogDescription>
          </DialogHeader>
          <Show when={removeError()}>
            <p
              class="text-sm text-danger"
              role="alert"
              tabIndex={-1}
              data-testid="team-remove-error"
              ref={(element) => queueMicrotask(() => element.focus())}
            >
              {removeError()?.message}
            </p>
          </Show>
          <Show
            when={removeError() && requiresMutationReload(removeError()?.cause)}
          >
            <Button
              size="sm"
              variant="outline"
              data-testid="team-remove-reload"
              onClick={reloadAfterRemoveError}
            >
              Reload team
            </Button>
          </Show>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={removing()}
              onClick={closeRemove}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={
                removing() ||
                (removeError() !== null &&
                  requiresMutationReload(removeError()?.cause))
              }
              onClick={() => void confirmRemove()}
            >
              {removing()
                ? removeTarget()?.me
                  ? "Leaving…"
                  : "Removing…"
                : removeTarget()?.me
                  ? "Leave team"
                  : "Remove member"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={inviteReceipt() !== null} onOpenChange={closeInviteReceipt}>
        <DialogContent data-testid="team-invite-receipt">
          <DialogHeader>
            <DialogTitle>Invite created</DialogTitle>
            <DialogDescription>
              This {inviteReceipt()?.invite.role} invitation expires in{" "}
              {inviteReceipt()?.invite.expires_in_days} days.
            </DialogDescription>
          </DialogHeader>
          <Show when={inviteReceipt()}>
            {(receipt) => (
              <div class="space-y-3">
                <div>
                  <div class="eyebrow mb-1">Invite token</div>
                  <code class="block break-all rounded-md bg-bg p-3 text-xs">
                    {receipt().invite.token}
                  </code>
                </div>
                <div>
                  <div class="eyebrow mb-1">Accept command</div>
                  <code class="block break-all rounded-md bg-bg p-3 text-xs">
                    {receipt().invite.accept_command}
                  </code>
                </div>
                <p class="text-xs text-muted">
                  {receipt().invite.emailed
                    ? "Invite email sent."
                    : "Share this command with the teammate securely."}
                </p>
                <Show when={copyMessage()}>
                  <p class="text-xs text-muted" role="status">
                    {copyMessage()}
                  </p>
                </Show>
                <DialogFooter>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void copyAcceptCommand()}
                  >
                    Copy accept command
                  </Button>
                  <Button size="sm" onClick={() => closeInviteReceipt(false)}>
                    Done
                  </Button>
                </DialogFooter>
              </div>
            )}
          </Show>
        </DialogContent>
      </Dialog>
    </section>
  );
};
