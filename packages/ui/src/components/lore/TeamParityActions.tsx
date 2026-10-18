import type { Component } from "solid-js";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";

import type {
  DomainJoinRequestList,
  OrganizationList,
  TeamDiscoveryResult,
} from "~/contracts";
import { ApiError } from "~/lib/api";
import { useWorkspace } from "~/routes/workspace";
import {
  TextField,
  TextFieldInput,
  TextFieldLabel,
} from "~/components/ui/text-field";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";

type Props = {
  selectedTeamId: string;
  canManage: boolean;
  hasTeams: boolean;
  onChanged: () => void;
  disabled?: boolean;
};

function errorText(error: unknown): string {
  if (error instanceof ApiError && error.code === "forbidden")
    return "You don't have permission to perform this action.";
  return error instanceof Error ? error.message : "The action failed.";
}

function tokenFromInviteInput(value: string): string | null {
  const input = value.trim();
  if (!input) return null;
  try {
    const url = new URL(input);
    const token =
      url.searchParams.get("token") ??
      url.pathname.split("/").filter(Boolean).at(-1);
    return token?.trim() || null;
  } catch {
    return input;
  }
}

export const TeamParityActions: Component<Props> = (props) => {
  const ws = useWorkspace();
  let active = true;
  onCleanup(() => {
    active = false;
  });
  const [createOpen, setCreateOpen] = createSignal(false);
  const [createName, setCreateName] = createSignal("");
  const [createError, setCreateError] = createSignal("");
  const [creating, setCreating] = createSignal(false);
  const [joinOpen, setJoinOpen] = createSignal(false);
  const [inviteToken, setInviteToken] = createSignal("");
  const [joinError, setJoinError] = createSignal("");
  const [joining, setJoining] = createSignal(false);
  const [addOpen, setAddOpen] = createSignal(false);
  const [accountId, setAccountId] = createSignal("");
  const [addRole, setAddRole] = createSignal<"admin" | "editor" | "viewer">(
    "editor",
  );
  const [addError, setAddError] = createSignal("");
  const [adding, setAdding] = createSignal(false);
  const [reposText, setReposText] = createSignal("");
  const [discovery, setDiscovery] = createSignal<TeamDiscoveryResult>();
  const [selectedLogins, setSelectedLogins] = createSignal<string[]>([]);
  const [inviteRole, setInviteRole] = createSignal<"editor" | "viewer">(
    "editor",
  );
  const [discoveryError, setDiscoveryError] = createSignal("");
  const [discovering, setDiscovering] = createSignal(false);
  const [organizations, setOrganizations] = createSignal<OrganizationList>();
  const [selectedOrg, setSelectedOrg] = createSignal("");
  const [orgIdForRequest, setOrgIdForRequest] = createSignal("");
  const [domain, setDomain] = createSignal("");
  const [domainRole, setDomainRole] = createSignal<
    "manager" | "billing" | "member"
  >("member");
  const [domainRequests, setDomainRequests] =
    createSignal<DomainJoinRequestList>();
  const [domainError, setDomainError] = createSignal("");
  const [domainBusy, setDomainBusy] = createSignal(false);

  const loadOrganizations = async () => {
    try {
      const result = await ws.tracked(() => ws.client.getOrganizations());
      if (!active) return;
      setOrganizations(result);
      if (!selectedOrg() && result.organizations.length > 0) {
        setSelectedOrg(result.organizations[0]!.id);
      }
    } catch (error) {
      if (!active) return;
      setDomainError(errorText(error));
    }
  };

  const loadDomainRequests = async (orgId: string) => {
    if (!orgId) {
      setDomainRequests(undefined);
      return;
    }
    setDomainError("");
    try {
      const requests = await ws.tracked(() =>
        ws.client.getDomainJoinRequests(orgId),
      );
      if (!active) return;
      setDomainRequests(requests);
    } catch (error) {
      if (!active) return;
      setDomainRequests(undefined);
      setDomainError(errorText(error));
    }
  };

  onMount(() => void loadOrganizations());

  const createTeam = async (event: SubmitEvent) => {
    event.preventDefault();
    if (props.disabled || creating() || !createName().trim()) return;
    setCreating(true);
    setCreateError("");
    try {
      await ws.tracked(() => ws.client.createTeam(createName().trim()));
      if (!active) return;
      setCreateOpen(false);
      setCreateName("");
      props.onChanged();
    } catch (error) {
      if (!active) return;
      setCreateError(errorText(error));
    } finally {
      if (active) setCreating(false);
    }
  };

  const joinTeam = async (event: SubmitEvent) => {
    event.preventDefault();
    const token = tokenFromInviteInput(inviteToken());
    if (props.disabled || joining() || !token) return;
    setJoining(true);
    setJoinError("");
    try {
      await ws.tracked(() => ws.client.acceptTeamInvite(token));
      if (!active) return;
      closeJoinDialog(false);
      props.onChanged();
    } catch (error) {
      if (!active) return;
      setJoinError(errorText(error));
    } finally {
      if (active) setJoining(false);
    }
  };

  const closeJoinDialog = (open: boolean) => {
    setJoinOpen(open);
    if (!open) {
      setInviteToken("");
      setJoinError("");
    }
  };

  const addMember = async (event: SubmitEvent) => {
    event.preventDefault();
    if (props.disabled || !props.canManage || adding() || !props.selectedTeamId)
      return;
    setAdding(true);
    setAddError("");
    try {
      await ws.tracked(() =>
        ws.client.addTeamMemberById(
          props.selectedTeamId,
          accountId().trim(),
          addRole(),
        ),
      );
      if (!active) return;
      setAddOpen(false);
      setAccountId("");
      props.onChanged();
    } catch (error) {
      if (!active) return;
      setAddError(errorText(error));
    } finally {
      if (active) setAdding(false);
    }
  };

  const runDiscovery = async (inviteLogins?: string[]) => {
    if (
      props.disabled ||
      !props.canManage ||
      discovering() ||
      !props.selectedTeamId
    )
      return;
    setDiscovering(true);
    setDiscoveryError("");
    try {
      const repos = reposText()
        .split(/[\s,]+/)
        .map((repo) => repo.trim())
        .filter(Boolean);
      const result = await ws.tracked(() =>
        ws.client.discoverTeamContributors(props.selectedTeamId, {
          ...(repos.length > 0 ? { repos } : {}),
          ...(inviteLogins
            ? { invite_role: inviteRole(), invite_logins: inviteLogins }
            : {}),
        }),
      );
      if (!active) return;
      setDiscovery(result);
      if (!inviteLogins) setSelectedLogins([]);
    } catch (error) {
      if (!active) return;
      setDiscoveryError(errorText(error));
    } finally {
      if (active) setDiscovering(false);
    }
  };

  const updateDomain = async (action: "claim" | "request", orgId: string) => {
    if (props.disabled || domainBusy()) return;
    if (!orgId) {
      setDomainError(
        action === "request"
          ? "Enter the organization ID you want to join."
          : "Select an organization first.",
      );
      return;
    }
    const trimmedDomain = domain().trim();
    if (!trimmedDomain) {
      setDomainError("Enter a verified email domain.");
      return;
    }
    setDomainError("");
    setDomainBusy(true);
    try {
      if (action === "claim") {
        await ws.tracked(() =>
          ws.client.claimOrganizationDomain(orgId, trimmedDomain, domainRole()),
        );
      } else {
        await ws.tracked(() =>
          ws.client.requestOrganizationJoin(orgId, trimmedDomain),
        );
      }
      if (!active) return;
      setDomain("");
      if (action === "claim") await loadDomainRequests(orgId);
    } catch (error) {
      if (!active) return;
      setDomainError(errorText(error));
    } finally {
      if (active) setDomainBusy(false);
    }
  };

  const decideDomain = async (
    orgId: string,
    requestId: string,
    decision: "approve" | "reject",
  ) => {
    if (props.disabled || domainBusy()) return;
    setDomainBusy(true);
    setDomainError("");
    try {
      await ws.tracked(() =>
        ws.client.decideDomainJoinRequest(orgId, requestId, decision),
      );
      if (!active) return;
      await loadDomainRequests(orgId);
    } catch (error) {
      if (!active) return;
      setDomainError(errorText(error));
    } finally {
      if (active) setDomainBusy(false);
    }
  };

  const requestOrgId = () => orgIdForRequest().trim() || selectedOrg() || "";

  return (
    <div class="space-y-5" data-testid="team-parity-actions">
      <div class="flex flex-wrap gap-2">
        <Show when={props.hasTeams}>
          <Button
            size="sm"
            variant="outline"
            data-testid="team-new"
            disabled={props.disabled}
            onClick={() => {
              if (props.disabled) return;
              setCreateError("");
              setCreateOpen(true);
            }}
          >
            New team
          </Button>
        </Show>
        <Button
          size="sm"
          variant="outline"
          data-testid="team-join"
          disabled={props.disabled}
          onClick={() => {
            if (props.disabled) return;
            setInviteToken("");
            setJoinError("");
            setJoinOpen(true);
          }}
        >
          Join a team
        </Button>
        <Show when={props.canManage && props.selectedTeamId}>
          <Button
            size="sm"
            variant="outline"
            data-testid="team-add-by-id"
            disabled={props.disabled}
            onClick={() => {
              if (props.disabled) return;
              setAddError("");
              setAddOpen(true);
            }}
          >
            Add by account ID
          </Button>
        </Show>
      </div>

      <Show when={!props.hasTeams}>
        <form
          class="max-w-lg rounded-md border border-line bg-bg p-4"
          data-testid="team-create-form"
          onSubmit={(event) => void createTeam(event)}
        >
          <h2 class="font-semibold">Create a team</h2>
          <TextField class="mt-3 text-sm" value={createName()} required>
            <TextFieldLabel>Team name</TextFieldLabel>
            <TextFieldInput
              class="bg-surface"
              onInput={(event) => setCreateName(event.currentTarget.value)}
              maxLength={120}
            />
          </TextField>
          <Show when={createError()}>
            <p class="mt-2 text-sm text-danger" role="alert">
              {createError()}
            </p>
          </Show>
          <Button
            class="mt-3"
            type="submit"
            disabled={props.disabled || creating()}
          >
            {creating() ? "Creating…" : "Create team"}
          </Button>
        </form>
      </Show>

      <Show when={props.canManage && props.selectedTeamId}>
        <section class="rounded-md border border-line bg-bg p-4">
          <h2 class="font-semibold">Find GitHub contributors</h2>
          <p class="mt-1 text-sm text-muted">
            Search starts only when you select Find contributors.
          </p>
          <TextField class="mt-3 text-sm" value={reposText()}>
            <TextFieldLabel>Repositories (optional, owner/repo)</TextFieldLabel>
            <TextFieldInput
              class="bg-surface"
              onInput={(event) => setReposText(event.currentTarget.value)}
              placeholder="owner/repo"
              data-testid="team-discovery-repos"
            />
          </TextField>
          <Button
            class="mt-3"
            size="sm"
            variant="outline"
            disabled={props.disabled || discovering()}
            data-testid="team-discover"
            onClick={() => void runDiscovery()}
          >
            {discovering() ? "Searching…" : "Find contributors"}
          </Button>
          <Show when={discoveryError()}>
            <p class="mt-2 text-sm text-danger" role="alert">
              {discoveryError()}
            </p>
          </Show>
          <Show when={discovery()}>
            {(result) => (
              <div class="mt-3 space-y-3">
                <For each={result().repos}>
                  {(repo) => (
                    <fieldset class="rounded border border-line p-3">
                      <legend class="px-1 text-sm font-medium">
                        {repo.repo}
                      </legend>
                      <For each={repo.contributors}>
                        {(contributor) => (
                          <label class="flex items-center gap-2 py-1 text-sm">
                            <input
                              type="checkbox"
                              checked={selectedLogins().includes(
                                contributor.login,
                              )}
                              onChange={(event) =>
                                setSelectedLogins((previous) =>
                                  event.currentTarget.checked
                                    ? [...previous, contributor.login]
                                    : previous.filter(
                                        (login) => login !== contributor.login,
                                      ),
                                )
                              }
                            />
                            <span>
                              @{contributor.login}
                              {contributor.onLore ? " · on Lore" : ""}
                            </span>
                          </label>
                        )}
                      </For>
                    </fieldset>
                  )}
                </For>
                <Show when={result().repos.length === 0}>
                  <p class="text-sm text-muted">No contributors found.</p>
                </Show>
                <div class="flex flex-wrap items-end gap-2">
                  <label class="text-sm">
                    Invite role
                    <select
                      class="mt-1 h-9 rounded-md border border-line bg-surface px-2"
                      value={inviteRole()}
                      onChange={(event) =>
                        setInviteRole(
                          event.currentTarget.value as "editor" | "viewer",
                        )
                      }
                    >
                      <option value="editor">Editor</option>
                      <option value="viewer">Viewer</option>
                    </select>
                  </label>
                  <Button
                    size="sm"
                    disabled={
                      props.disabled ||
                      discovering() ||
                      selectedLogins().length === 0 ||
                      result().invited !== undefined
                    }
                    data-testid="team-invite-selected"
                    onClick={() => void runDiscovery(selectedLogins())}
                  >
                    Invite selected
                  </Button>
                </div>
                <Show when={result().invited}>
                  <p class="text-sm text-muted" role="status">
                    Invitation attempted for {result().invited?.total} selected
                    contributor(s).
                  </p>
                </Show>
              </div>
            )}
          </Show>
        </section>
      </Show>

      <section
        class="rounded-md border border-line bg-bg p-4"
        data-testid="organization-domains"
      >
        <h2 class="font-semibold">Organization domains</h2>
        <Show when={(organizations()?.organizations.length ?? 0) > 0}>
          <label class="mt-3 block text-sm">
            Organization
            <select
              class="mt-1 h-9 w-full rounded-md border border-line bg-surface px-2"
              value={selectedOrg()}
              onChange={(event) => {
                setSelectedOrg(event.currentTarget.value);
                void loadDomainRequests(event.currentTarget.value);
              }}
            >
              <For each={organizations()?.organizations ?? []}>
                {(org) => <option value={org.id}>{org.name ?? org.id}</option>}
              </For>
            </select>
          </label>
          <Show when={selectedOrg()}>
            <Button
              class="mt-2"
              size="sm"
              variant="outline"
              onClick={() => void loadDomainRequests(selectedOrg())}
            >
              Load join requests
            </Button>
            <For each={domainRequests()?.requests ?? []}>
              {(request) => (
                <div
                  class="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-2 text-sm"
                  data-testid="domain-join-request"
                >
                  <span>
                    {request.domain} · {request.label ?? "Unknown requester"}
                  </span>
                  <Show when={request.status === "pending"}>
                    <div class="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={props.disabled || domainBusy()}
                        onClick={() =>
                          void decideDomain(
                            selectedOrg(),
                            request.id,
                            "approve",
                          )
                        }
                      >
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={props.disabled || domainBusy()}
                        onClick={() =>
                          void decideDomain(selectedOrg(), request.id, "reject")
                        }
                      >
                        Reject
                      </Button>
                    </div>
                  </Show>
                  <Show when={request.status === "approved"}>
                    <span>Approved</span>
                  </Show>
                  <Show when={request.status === "rejected"}>
                    <span>Rejected</span>
                  </Show>
                </div>
              )}
            </For>
          </Show>
        </Show>
        <form
          class="mt-4 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]"
          onSubmit={(event) => {
            event.preventDefault();
            void updateDomain("request", requestOrgId());
          }}
        >
          <div>
            <TextField class="text-sm" value={orgIdForRequest()}>
              <TextFieldLabel>
                Organization ID for a join request
              </TextFieldLabel>
              <TextFieldInput
                class="bg-surface"
                onInput={(event) =>
                  setOrgIdForRequest(event.currentTarget.value)
                }
              />
            </TextField>
            <TextField class="mt-2 text-sm" value={domain()} required>
              <TextFieldLabel>Verified email domain</TextFieldLabel>
              <TextFieldInput
                class="bg-surface"
                onInput={(event) => setDomain(event.currentTarget.value)}
                placeholder="example.com"
              />
            </TextField>
            <Show
              when={organizations()?.organizations.some(
                (org) => org.id === selectedOrg(),
              )}
            >
              <label class="mt-2 block text-sm">
                Claimed member role
                <select
                  class="mt-1 h-9 rounded-md border border-line bg-surface px-2"
                  value={domainRole()}
                  onChange={(event) =>
                    setDomainRole(
                      event.currentTarget.value as
                        | "manager"
                        | "billing"
                        | "member",
                    )
                  }
                >
                  <option value="member">Member</option>
                  <option value="manager">Manager</option>
                  <option value="billing">Billing</option>
                </select>
              </label>
            </Show>
          </div>
          <div class="flex flex-wrap items-end gap-2">
            <Button
              type="submit"
              size="sm"
              variant="outline"
              disabled={props.disabled || domainBusy()}
            >
              Request to join
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={props.disabled || domainBusy() || !selectedOrg()}
              onClick={() => void updateDomain("claim", selectedOrg())}
            >
              Claim domain
            </Button>
          </div>
        </form>
        <Show when={domainError()}>
          <p class="mt-2 text-sm text-danger" role="alert">
            {domainError()}
          </p>
        </Show>
      </section>

      <Dialog open={createOpen()} onOpenChange={setCreateOpen}>
        <DialogContent data-testid="team-create-dialog">
          <DialogHeader>
            <DialogTitle>Create a team</DialogTitle>
            <DialogDescription>
              Create a team to share knowledge and manage members.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={(event) => void createTeam(event)}>
            <TextField class="text-sm" value={createName()} required>
              <TextFieldLabel>Team name</TextFieldLabel>
              <TextFieldInput
                class="bg-surface"
                onInput={(event) => setCreateName(event.currentTarget.value)}
                maxLength={120}
                data-testid="team-create-name"
              />
            </TextField>
            <Show when={createError()}>
              <p class="mt-2 text-sm text-danger" role="alert">
                {createError()}
              </p>
            </Show>
            <DialogFooter class="mt-4">
              <Button
                type="button"
                variant="outline"
                disabled={props.disabled || creating()}
                onClick={() => setCreateOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={props.disabled || creating()}>
                {creating() ? "Creating…" : "Create team"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={joinOpen()} onOpenChange={closeJoinDialog}>
        <DialogContent data-testid="team-join-dialog">
          <DialogHeader>
            <DialogTitle>Join a team</DialogTitle>
            <DialogDescription>
              Paste an invitation token or accept link. The token is sent only
              in the request body.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={(event) => void joinTeam(event)}>
            <TextField class="text-sm" value={inviteToken()} required>
              <TextFieldLabel>Invitation token</TextFieldLabel>
              <TextFieldInput
                class="bg-surface"
                onInput={(event) => setInviteToken(event.currentTarget.value)}
                data-testid="team-invite-token"
              />
            </TextField>
            <Show when={joinError()}>
              <p class="mt-2 text-sm text-danger" role="alert">
                {joinError()}
              </p>
            </Show>
            <DialogFooter class="mt-4">
              <Button
                type="button"
                variant="outline"
                disabled={props.disabled || joining()}
                onClick={() => closeJoinDialog(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={props.disabled || joining()}>
                {joining() ? "Joining…" : "Join team"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={addOpen()} onOpenChange={setAddOpen}>
        <DialogContent data-testid="team-add-by-id-dialog">
          <DialogHeader>
            <DialogTitle>Add by account ID</DialogTitle>
            <DialogDescription>
              Add an existing Lore account by its UUID.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={(event) => void addMember(event)}>
            <TextField class="text-sm" value={accountId()} required>
              <TextFieldLabel>Account ID</TextFieldLabel>
              <TextFieldInput
                class="bg-surface"
                onInput={(event) => setAccountId(event.currentTarget.value)}
                data-testid="team-account-id"
              />
            </TextField>
            <label class="mt-3 block text-sm">
              Role
              <select
                class="mt-1 h-9 rounded-md border border-line bg-surface px-2"
                value={addRole()}
                onChange={(event) =>
                  setAddRole(
                    event.currentTarget.value as "admin" | "editor" | "viewer",
                  )
                }
              >
                <option value="editor">Editor</option>
                <option value="viewer">Viewer</option>
                <option value="admin">Admin</option>
              </select>
            </label>
            <Show when={addError()}>
              <p class="mt-2 text-sm text-danger" role="alert">
                {addError()}
              </p>
            </Show>
            <DialogFooter class="mt-4">
              <Button
                type="button"
                variant="outline"
                disabled={props.disabled || adding()}
                onClick={() => setAddOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={props.disabled || adding()}>
                {adding() ? "Adding…" : "Add member"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
};
