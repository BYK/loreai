import type { Component } from "solid-js";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  on,
  onMount,
  onCleanup,
  Show,
  Switch,
} from "solid-js";

import type { SharingStatus } from "~/contracts";
import { isApiError } from "~/lib/api";
import { createLoader } from "~/lib/loader";
import { useWorkspace } from "~/routes/workspace";

import { Button } from "../ui/button";
import { requiresMutationReload } from "./mutation-errors";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { StateCard } from "./StateCard";

const STATE_LABEL: Record<SharingStatus["state"], string> = {
  not_linked: "Not linked",
  linked: "Linked",
  locked: "Locked",
  degraded: "Degraded",
};

type PolicyMutationFailure = { cause: unknown; message: string };

function teamLabel(status: SharingStatus): string {
  if (!status.team) return "No team";
  return status.team.name ?? "Unnamed team";
}

function explanation(status: SharingStatus): string {
  switch (status.state) {
    case "not_linked":
      return "This project is not linked to a team; no one else sees its knowledge.";
    case "linked":
      return status.policy.effective === "auto"
        ? "New knowledge is shared with the team automatically."
        : "New knowledge waits for review before it is shared with the team.";
    case "locked":
      return "Team content stays on this device until encryption is unlocked with `lore sync enable`.";
    case "degraded":
      return "Team content is not syncing until this is resolved.";
  }
}

/** Project sharing status, policy and team link controls. */
export const SharingPanel: Component<{ projectId: string }> = (props) => {
  const ws = useWorkspace();
  const folk = ws.state.folk;
  const accountId = createMemo(() => {
    const current = folk.account.data();
    return folk.account.error() === undefined
      ? (current?.user?.id ?? null)
      : null;
  });
  const settledAccountId = createMemo<string | null | undefined>(
    (previous) =>
      folk.account.loading() ||
      (folk.account.data() === undefined && folk.account.error() === undefined)
        ? previous
        : accountId(),
    undefined,
  );
  const contextAvailable = createMemo(
    () =>
      folk.account.error() === undefined &&
      folk.account.data() !== undefined &&
      folk.account.data()?.state !== "hosted",
  );
  const statusReady = () =>
    !folk.account.loading() &&
    contextAvailable() &&
    !sharing.loading() &&
    sharing.error() === undefined;
  const signedAccountReady = () =>
    statusReady() &&
    folk.account.data()?.signed_in === true &&
    folk.account.data()?.state === "signed_in" &&
    accountId() !== null;
  const sharing = createLoader(
    () => props.projectId,
    (projectId) => ws.tracked(() => ws.client.getProjectSharing(projectId)),
  );
  const [receipt, setReceipt] = createSignal<SharingStatus>();
  const [confirmAutoShare, setConfirmAutoShare] = createSignal(false);
  const [nextAutoShare, setNextAutoShare] = createSignal(false);
  const [savingPolicy, setSavingPolicy] = createSignal(false);
  const [policyError, setPolicyError] =
    createSignal<PolicyMutationFailure | null>(null);
  const [selectedTeam, setSelectedTeam] = createSignal("");
  const [savingLink, setSavingLink] = createSignal(false);
  const [linkError, setLinkError] = createSignal<PolicyMutationFailure | null>(
    null,
  );
  const [linkSuccess, setLinkSuccess] = createSignal("");
  const teams = () => folk.teams.data()?.teams ?? [];
  const selectedTeamValid = () =>
    signedAccountReady() &&
    selectedTeam() !== "" &&
    !folk.teams.loading() &&
    folk.teams.error() === undefined &&
    teams().some((team) => team.id === selectedTeam());
  const shownStatus = () => receipt() ?? sharing.data();
  let actionEpoch = 0;
  onCleanup(() => {
    actionEpoch++;
  });
  onMount(() => ws.state.folk.loadTeams());
  createEffect(
    on([() => props.projectId, accountId, contextAvailable], () => {
      actionEpoch++;
      setSavingPolicy(false);
      setSavingLink(false);
      setReceipt(undefined);
      setPolicyError(null);
      setLinkError(null);
      setConfirmAutoShare(false);
      setSelectedTeam("");
      setLinkSuccess("");
    }),
  );
  createEffect(
    on(settledAccountId, (_current, previous) => {
      if (previous !== undefined) sharing.reload();
    }),
  );
  createEffect(() => {
    if (selectedTeam() && !teams().some((team) => team.id === selectedTeam()))
      setSelectedTeam("");
  });
  const reload = () => {
    setReceipt(undefined);
    setPolicyError(null);
    setLinkError(null);
    sharing.reload();
  };
  const closeAutoShareDialog = (open: boolean) => {
    if (!open && savingPolicy()) return;
    setConfirmAutoShare(open);
  };
  const reloadAfterSharingError = () => {
    setConfirmAutoShare(false);
    reload();
  };
  const updateAutoShare = async () => {
    const current = shownStatus();
    if (!current || !current.linked || savingPolicy() || !statusReady()) {
      return;
    }
    const owner = accountId();
    const projectId = props.projectId;
    const operationEpoch = actionEpoch;
    setSavingPolicy(true);
    setPolicyError(null);
    try {
      const updated = await ws.tracked(() =>
        ws.client.setProjectAutoShare(
          projectId,
          nextAutoShare() ? "auto" : "manual",
          current.policy.project_override,
        ),
      );
      if (operationEpoch !== actionEpoch) return;
      if (
        accountId() !== owner ||
        props.projectId !== projectId ||
        !statusReady()
      ) {
        sharing.reload();
        return;
      }
      setReceipt(updated);
      setConfirmAutoShare(false);
    } catch (error) {
      if (operationEpoch !== actionEpoch) return;
      if (accountId() !== owner || props.projectId !== projectId) return;
      setPolicyError({
        cause: error,
        message:
          error instanceof Error
            ? error.message
            : "The sharing policy could not be updated.",
      });
    } finally {
      if (operationEpoch === actionEpoch) setSavingPolicy(false);
    }
  };
  const updateProjectLink = async (scopeId: string | null) => {
    const current = shownStatus();
    if (
      !current ||
      savingLink() ||
      !statusReady() ||
      (scopeId !== null && !selectedTeamValid())
    )
      return;
    const owner = accountId();
    const projectId = props.projectId;
    const operationEpoch = actionEpoch;
    setSavingLink(true);
    setLinkError(null);
    setLinkSuccess("");
    try {
      const updated = await ws.tracked(() =>
        ws.client.linkProjectToTeam(
          projectId,
          scopeId,
          current.linked ? (current.team?.id ?? null) : null,
        ),
      );
      if (operationEpoch !== actionEpoch) return;
      if (
        accountId() !== owner ||
        props.projectId !== projectId ||
        !statusReady() ||
        (scopeId !== null && !signedAccountReady())
      ) {
        sharing.reload();
        return;
      }
      setReceipt(updated);
      setSelectedTeam("");
      setLinkSuccess(scopeId ? "Project linked to team." : "Project unlinked.");
      ws.state.folk.refresh();
    } catch (error) {
      if (operationEpoch !== actionEpoch) return;
      if (accountId() !== owner || props.projectId !== projectId) return;
      setLinkError({
        cause: error,
        message:
          error instanceof Error
            ? error.message
            : "The team link could not be updated.",
      });
    } finally {
      if (operationEpoch === actionEpoch) setSavingLink(false);
    }
  };
  const errorText = () => {
    return policyError()?.message ?? "The sharing policy could not be updated.";
  };
  const linkErrorText = () =>
    linkError()?.message ?? "The project team link could not be updated.";
  const hidden = () => {
    const error = sharing.error();
    return isApiError(error) && error.kind === "unauthorized";
  };
  return (
    <section data-testid="sharing-panel" class="border-b border-line py-5">
      <div class="eyebrow mb-2">Sharing</div>
      <Switch
        fallback={
          <StateCard kind="loading" title="Loading sharing status" compact />
        }
      >
        <Match when={shownStatus()}>
          {(status) => (
            <div
              class="space-y-1.5 text-sm"
              data-sharing-state={status().state}
            >
              <div class="flex flex-wrap items-center gap-2">
                <span data-testid="sharing-summary">
                  {STATE_LABEL[status().state]} · {teamLabel(status())} ·
                  policy: {status().policy.effective}
                </span>
              </div>
              <Show when={status().detail}>
                {(detail) => (
                  <div data-testid="sharing-detail" class="font-medium">
                    {detail()}
                  </div>
                )}
              </Show>
              <div class="text-[13px] text-muted">{explanation(status())}</div>
              <Show when={status().linked}>
                <p class="text-xs text-muted" data-testid="sharing-team-review">
                  Team review:{" "}
                  {status().review_required === true
                    ? "required"
                    : status().review_required === false
                      ? "optional"
                      : "unavailable"}
                </p>
                <label class="mt-2 flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    role="switch"
                    aria-label="Share automatically"
                    data-testid="sharing-auto-share"
                    checked={status().auto_share}
                    disabled={savingPolicy() || !statusReady()}
                    onChange={(event) => {
                      const next = event.currentTarget.checked;
                      event.currentTarget.checked = status().auto_share;
                      setNextAutoShare(next);
                      setPolicyError(null);
                      setConfirmAutoShare(true);
                    }}
                  />
                  <span>
                    Share automatically
                    <span class="mt-1 block text-xs text-muted">
                      {status().review_required === false
                        ? `New team knowledge in this project is shared with ${teamLabel(status())} on the next sync without review, because the team doesn't require review.`
                        : `New team knowledge in this project is sent to ${teamLabel(status())} as review requests on the next sync.`}
                    </span>
                  </span>
                </label>
              </Show>
              <Show when={policyError() && !confirmAutoShare()}>
                <p class="mt-2 text-sm text-danger" role="alert">
                  {errorText()}
                </p>
              </Show>
              <Show
                when={
                  !confirmAutoShare() &&
                  policyError() &&
                  requiresMutationReload(policyError()?.cause)
                }
              >
                <Button
                  class="mt-2"
                  size="sm"
                  variant="outline"
                  data-testid="sharing-reload-policy"
                  onClick={reload}
                >
                  Reload status
                </Button>
              </Show>
              <div data-testid="sharing-policy" class="text-xs text-muted">
                Promotion policy {status().policy.effective} · project override{" "}
                {status().policy.project_override ?? "none"} · team default{" "}
                {status().policy.team_default ?? "none"}
              </div>
              <Show when={status().linked}>
                <Button
                  pending={savingLink()}
                  class="mt-2"
                  size="sm"
                  variant="outline"
                  data-testid="sharing-unlink-team"
                  disabled={savingLink() || !statusReady()}
                  onClick={() => void updateProjectLink(null)}
                >
                  {savingLink() ? "Unlinking…" : "Unlink"}
                </Button>
              </Show>
              <Show when={!status().linked}>
                <div class="mt-2 flex flex-wrap items-end gap-2">
                  <label class="text-sm">
                    Link to team
                    <select
                      class="mt-1 block h-9 rounded-md border border-line bg-surface px-2"
                      aria-label="Link to team"
                      data-testid="sharing-team-picker"
                      value={selectedTeam()}
                      onChange={(event) =>
                        setSelectedTeam(event.currentTarget.value)
                      }
                    >
                      <option value="" selected={!selectedTeam()}>
                        Choose a team
                      </option>
                      <For each={teams()}>
                        {(team) => (
                          <option
                            value={team.id}
                            selected={selectedTeam() === team.id}
                          >
                            {team.name ?? team.id}
                          </option>
                        )}
                      </For>
                    </select>
                  </label>
                  <Button
                    pending={savingLink()}
                    size="sm"
                    variant="outline"
                    data-testid="sharing-link-team"
                    disabled={savingLink() || !selectedTeamValid()}
                    onClick={() => void updateProjectLink(selectedTeam())}
                  >
                    {savingLink() ? "Linking…" : "Link to team"}
                  </Button>
                </div>
              </Show>
              <Show when={linkSuccess()}>
                <p class="mt-2 text-sm text-muted" role="status">
                  {linkSuccess()}
                </p>
              </Show>
              <Show when={linkError()}>
                <p class="mt-2 text-sm text-danger" role="alert">
                  {linkErrorText()}
                </p>
              </Show>
              <Show
                when={linkError() && requiresMutationReload(linkError()?.cause)}
              >
                <Button
                  class="mt-2"
                  size="sm"
                  variant="outline"
                  data-testid="sharing-reload-link"
                  onClick={reload}
                >
                  Reload status
                </Button>
              </Show>
            </div>
          )}
        </Match>
        <Match when={hidden()}>
          <StateCard kind="locked" title="Sharing status hidden" compact>
            This gateway does not expose sharing status to this browser.
          </StateCard>
        </Match>
        <Match when={sharing.error() !== undefined}>
          <StateCard
            kind="empty"
            title="Sharing status not available"
            compact
            action={
              <Button variant="outline" size="sm" onClick={reload}>
                Retry
              </Button>
            }
          />
        </Match>
      </Switch>
      <Dialog open={confirmAutoShare()} onOpenChange={closeAutoShareDialog}>
        <DialogContent data-testid="sharing-policy-confirmation">
          <DialogHeader>
            <DialogTitle>
              {nextAutoShare()
                ? "Share automatically?"
                : "Turn off automatic sharing?"}
            </DialogTitle>
            <DialogDescription>
              {shownStatus()?.review_required === false
                ? `New team knowledge in this project is shared with ${shownStatus() ? teamLabel(shownStatus()!) : "the team"} on the next sync without review, because the team doesn't require review.`
                : `New team knowledge in this project is sent to ${shownStatus() ? teamLabel(shownStatus()!) : "the team"} as review requests on the next sync.`}
            </DialogDescription>
          </DialogHeader>
          <Show when={confirmAutoShare() && policyError()}>
            <p
              class="text-sm text-danger"
              role="alert"
              tabIndex={-1}
              data-testid="sharing-policy-error"
              ref={(element) => queueMicrotask(() => element.focus())}
            >
              {errorText()}
            </p>
          </Show>
          <Show
            when={
              confirmAutoShare() &&
              policyError() &&
              requiresMutationReload(policyError()?.cause)
            }
          >
            <Button
              size="sm"
              variant="outline"
              data-testid="sharing-reload-policy"
              onClick={reloadAfterSharingError}
            >
              Reload status
            </Button>
          </Show>
          <DialogFooter>
            <Button
              size="sm"
              variant="outline"
              disabled={savingPolicy()}
              onClick={() => setConfirmAutoShare(false)}
            >
              Cancel
            </Button>
            <Button
              pending={savingPolicy()}
              icon="save"
              size="sm"
              disabled={
                savingPolicy() ||
                !statusReady() ||
                (policyError() !== null &&
                  requiresMutationReload(policyError()?.cause))
              }
              onClick={() => void updateAutoShare()}
            >
              {savingPolicy()
                ? "Saving…"
                : nextAutoShare()
                  ? "Share automatically"
                  : "Turn off automatic sharing"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
};
