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
import { Icon } from "~/components/shell/Icon";
import { SharingSync } from "./SharingSync";
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
  const hasSignedAccount = () => {
    const current = folk.confirmedAccount();
    return (
      current?.signed_in === true &&
      current.state === "signed_in" &&
      current.user !== null
    );
  };
  const backgroundReady = () =>
    hasSignedAccount() &&
    folk.confirmedSync()?.enabled === true &&
    folk.sync.error() === undefined &&
    !folk.syncBlocker();
  const signedAccountReady = () =>
    statusReady() &&
    folk.account.data()?.signed_in === true &&
    folk.account.data()?.state === "signed_in" &&
    accountId() !== null;
  const initialAccountSettled = createMemo<boolean>(
    (previous) =>
      previous ||
      (!folk.account.loading() &&
        (folk.account.data() !== undefined ||
          folk.account.error() !== undefined)),
    false,
  );
  const sharing = createLoader(
    () => (initialAccountSettled() ? props.projectId : null),
    async (projectId) => {
      const owner = accountId();
      const status = await ws.tracked(() =>
        ws.client.getProjectSharing(projectId),
      );
      return { status, owner };
    },
  );
  // A failed read invalidates its retained value until a new read settles.
  // Healthy refreshes keep their previously confirmed presentation.
  const confirmedSharing = createMemo<ReturnType<typeof sharing.data>>(
    (previous) => {
      if (sharing.error() !== undefined) return undefined;
      return sharing.loading() ? previous : sharing.data();
    },
  );
  let manageSharingButton: HTMLButtonElement | undefined;
  let sharingHeading: HTMLHeadingElement | undefined;
  const [expanded, setExpanded] = createSignal(false);
  const [receipt, setReceipt] = createSignal<SharingStatus>();
  const [confirmAutoShare, setConfirmAutoShare] = createSignal(false);
  const [confirmUnlink, setConfirmUnlink] = createSignal(false);
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
    teams().some(
      (team) => team.id === selectedTeam() && team.role !== "viewer",
    );
  const shownStatus = () => receipt() ?? sharing.data()?.status;
  const writableTeams = () => teams().filter((team) => team.role !== "viewer");
  const linkedTeam = () =>
    teams().find((team) => team.id === shownStatus()?.team?.id);
  const compactReady = () =>
    shownStatus()?.state === "linked" &&
    shownStatus()?.linked === true &&
    shownStatus()?.team !== null &&
    contextAvailable() &&
    sharing.error() === undefined &&
    confirmedSharing()?.owner === accountId() &&
    backgroundReady() &&
    !policyError() &&
    !linkError();
  const settingsVisible = () => !compactReady() || expanded();
  const busy = () => savingPolicy() || savingLink();
  const refresh = () => {
    reload();
    folk.refresh();
  };
  createEffect(
    on(
      () => shownStatus()?.team?.id,
      () => setConfirmUnlink(false),
    ),
  );

  let actionEpoch = 0;
  onCleanup(() => {
    actionEpoch++;
  });
  onMount(() => ws.state.folk.loadTeams());
  createEffect(
    on([() => props.projectId, accountId, contextAvailable], () => {
      actionEpoch++;
      setExpanded(false);
      setSavingPolicy(false);
      setSavingLink(false);
      setReceipt(undefined);
      setPolicyError(null);
      setLinkError(null);
      setConfirmAutoShare(false);
      setConfirmUnlink(false);
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
    if (
      selectedTeam() &&
      !writableTeams().some((team) => team.id === selectedTeam())
    )
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
    if (!current || !current.linked || busy() || !statusReady()) {
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
  const updateProjectLink = async (
    scopeId: string | null,
    trigger?: HTMLButtonElement,
  ) => {
    const current = shownStatus();
    if (
      !current ||
      busy() ||
      !statusReady() ||
      (scopeId !== null && !selectedTeamValid())
    )
      return;
    const initiatedWithFocus =
      trigger !== undefined && document.activeElement === trigger;
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
      const handoffFocus =
        scopeId !== null &&
        initiatedWithFocus &&
        (document.activeElement === trigger ||
          document.activeElement === document.body);
      setReceipt(updated);
      setConfirmUnlink(false);
      setSelectedTeam("");
      setLinkSuccess(scopeId ? "Project linked to team." : "Project unlinked.");
      ws.state.folk.refresh();
      if (handoffFocus)
        queueMicrotask(() => {
          if (
            operationEpoch !== actionEpoch ||
            accountId() !== owner ||
            props.projectId !== projectId
          )
            return;
          if (
            document.activeElement !== trigger &&
            document.activeElement !== document.body
          )
            return;
          (manageSharingButton?.isConnected
            ? manageSharingButton
            : sharingHeading
          )?.focus();
        });
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
    <section
      data-testid="sharing-panel"
      class="my-5 overflow-hidden rounded-xl border border-line bg-surface"
    >
      <Switch
        fallback={
          <div class="p-5">
            <StateCard kind="loading" title="Loading sharing status" compact />
          </div>
        }
      >
        <Match when={shownStatus()}>
          {(status) => (
            <div data-sharing-state={status().state}>
              <div
                class={
                  settingsVisible()
                    ? "border-b border-line px-4 py-5 sm:px-5"
                    : "px-4 py-3 sm:px-5"
                }
              >
                <div class="flex items-start gap-3">
                  <span
                    hidden={!settingsVisible()}
                    class="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent-soft-text"
                  >
                    <Icon name="users" class="size-5" />
                  </span>
                  <div class="min-w-0 flex-1">
                    <div hidden={!settingsVisible()} class="eyebrow mb-1">
                      Team memory
                    </div>
                    <div class="flex flex-wrap items-center justify-between gap-2">
                      <h2
                        ref={(element) => {
                          sharingHeading = element;
                        }}
                        tabIndex={-1}
                        class={
                          settingsVisible()
                            ? "max-w-full min-w-0 text-lg font-semibold tracking-tight [overflow-wrap:anywhere]"
                            : "max-w-full min-w-0 text-sm font-semibold [overflow-wrap:anywhere]"
                        }
                      >
                        {status().linked
                          ? `Connected to ${teamLabel(status())}`
                          : "Share knowledge with your team"}
                      </h2>
                      <span
                        hidden={!settingsVisible()}
                        class="inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-xs text-muted"
                      >
                        <Icon
                          name={status().linked ? "link" : "lock"}
                          class="size-3"
                        />
                        {status().linked ? "Team connected" : "Not connected"}
                      </span>
                    </div>
                    <p
                      hidden={!settingsVisible()}
                      class="mt-1.5 max-w-xl text-sm leading-relaxed text-muted"
                    >
                      {status().linked
                        ? "Choose what you share and check this device’s sync settings below."
                        : "Connect this project, choose how knowledge is shared, and keep your team in the loop."}
                    </p>
                  </div>
                </div>
                <Show when={compactReady()}>
                  <div class="mt-2 flex flex-wrap items-center justify-between gap-2">
                    <p class="text-xs text-muted">
                      {status().auto_share
                        ? "Automatic sharing"
                        : "You choose what to propose"}{" "}
                      · Team review:{" "}
                      {status().review_required === true
                        ? "required"
                        : status().review_required === false
                          ? "optional"
                          : "unavailable"}{" "}
                      · Sync configured on this device
                    </p>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      class="h-11 md:h-9"
                      ref={(element) => {
                        manageSharingButton = element;
                      }}
                      aria-expanded={expanded()}
                      onClick={() => setExpanded(!expanded())}
                    >
                      {expanded() ? "Hide sharing settings" : "Manage sharing"}
                    </Button>
                  </div>
                </Show>
                <ol
                  hidden={!settingsVisible()}
                  aria-label="Sharing setup"
                  class="mt-5 grid list-none grid-cols-3 gap-2 p-0"
                >
                  <For
                    each={[
                      {
                        label: "Connect team",
                        detail: status().linked
                          ? teamLabel(status())
                          : "Choose a team",
                        done: status().linked,
                      },
                      {
                        label: "Choose sharing",
                        detail: status().linked
                          ? status().auto_share
                            ? "Automatic"
                            : "You choose"
                          : "Stay in control",
                        done: status().linked,
                      },
                      {
                        label: "Keep in sync",
                        detail:
                          status().state === "linked" && backgroundReady()
                            ? "Enabled on this device"
                            : "Check setup",
                        done:
                          status().state === "linked" &&
                          backgroundReady() === true,
                      },
                    ]}
                  >
                    {(step, index) => (
                      <li class="min-w-0 rounded-lg border border-line bg-bg/50 px-2.5 py-3 sm:px-3">
                        <span class="mb-2 flex size-5 items-center justify-center rounded-full bg-soft text-[11px] font-semibold text-accent">
                          {step.done ? (
                            <Icon name="check" class="size-3" />
                          ) : (
                            index() + 1
                          )}
                        </span>
                        <span class="block text-xs font-medium sm:text-sm">
                          {step.label}
                        </span>
                        <span class="mt-1 block truncate text-[11px] text-muted sm:text-xs">
                          {step.detail}
                        </span>
                      </li>
                    )}
                  </For>
                </ol>
              </div>
              <div
                hidden={!settingsVisible()}
                class="space-y-4 px-4 py-4 sm:px-5"
              >
                <Show when={sharing.error() !== undefined}>
                  <p role="alert" class="text-sm text-danger">
                    Sharing status could not be refreshed.{" "}
                    <Button
                      variant="link"
                      size="sm"
                      class="h-11 md:h-9"
                      onClick={refresh}
                    >
                      Try again
                    </Button>
                  </p>
                </Show>
                <Show
                  when={status().linked}
                  fallback={
                    <Switch>
                      <Match when={!hasSignedAccount()}>
                        <p class="text-sm text-muted">
                          Your project’s sharing settings are kept while account
                          access is restored.
                        </p>
                      </Match>
                      <Match
                        when={
                          folk.teams.data() === undefined &&
                          folk.teams.error() === undefined
                        }
                      >
                        <p class="text-sm text-muted">Finding your teams…</p>
                      </Match>
                      <Match when={folk.teams.error() !== undefined}>
                        <div>
                          <p class="text-sm text-muted">
                            Your teams could not be loaded.
                          </p>
                          <Button
                            size="sm"
                            class="h-11 md:h-9"
                            variant="outline"
                            onClick={refresh}
                          >
                            Retry teams
                          </Button>
                        </div>
                      </Match>
                      <Match when={teams().length === 0}>
                        <div class="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-bg/50 p-3">
                          <div>
                            <h3 class="text-sm font-medium">
                              Find your people
                            </h3>
                            <p class="mt-1 text-xs text-muted">
                              Join an existing team or create one to start
                              sharing.
                            </p>
                          </div>
                          <Button
                            as="a"
                            href="/ui/team"
                            size="sm"
                            class="h-11 md:h-9"
                            variant="outline"
                            icon="users"
                          >
                            Find or create a team
                          </Button>
                        </div>
                      </Match>
                      <Match when={writableTeams().length === 0}>
                        <p class="text-sm text-muted">
                          An editor or admin can connect this project to a team.
                        </p>
                      </Match>
                      <Match when={true}>
                        <div class="flex flex-wrap items-end gap-3">
                          <label class="min-w-0 flex-1 text-sm font-medium">
                            Connect to a team
                            <select
                              class="mt-2 block h-11 w-full min-w-0 rounded-md border border-line bg-bg px-3 text-sm"
                              aria-label="Link to team"
                              data-testid="sharing-team-picker"
                              value={selectedTeam()}
                              disabled={busy() || !signedAccountReady()}
                              onChange={(event) =>
                                setSelectedTeam(event.currentTarget.value)
                              }
                            >
                              <option value="" selected={!selectedTeam()}>
                                Choose a team
                              </option>
                              <For each={writableTeams()}>
                                {(team) => (
                                  <option
                                    value={team.id}
                                    selected={selectedTeam() === team.id}
                                  >
                                    {team.name ?? "Unnamed team"}
                                  </option>
                                )}
                              </For>
                            </select>
                          </label>
                          <Button
                            class="h-11"
                            pending={savingLink()}
                            icon="link"
                            data-testid="sharing-link-team"
                            disabled={busy() || !selectedTeamValid()}
                            onClick={(event) =>
                              void updateProjectLink(
                                selectedTeam(),
                                event.currentTarget,
                              )
                            }
                          >
                            {savingLink() ? "Linking…" : "Link to team"}
                          </Button>
                        </div>
                        <p class="text-xs leading-relaxed text-muted">
                          {status().policy.project_override === "auto"
                            ? "Your saved automatic-sharing preference will apply to this team. The team’s review rules still apply."
                            : "Connecting chooses where to share. New entries stay private until you propose them and any required review is complete."}
                        </p>
                      </Match>
                    </Switch>
                  }
                >
                  <div class="flex flex-wrap items-center justify-between gap-3">
                    <div class="flex min-w-0 items-center gap-2.5">
                      <span class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-soft text-sm font-semibold text-muted">
                        {teamLabel(status()).slice(0, 1).toUpperCase()}
                      </span>
                      <div class="min-w-0">
                        <p class="truncate text-sm font-medium">
                          {teamLabel(status())}
                        </p>
                        <p class="text-xs text-muted">
                          {linkedTeam()
                            ? `${linkedTeam()!.member_count} members · ${linkedTeam()!.role}`
                            : "Project team"}
                        </p>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      class="h-11 md:h-9"
                      data-testid="sharing-unlink-team"
                      disabled={busy() || !statusReady()}
                      onClick={() => {
                        setLinkError(null);
                        setConfirmUnlink(true);
                      }}
                    >
                      Unlink
                    </Button>
                  </div>
                  <div class="rounded-lg border border-line p-3.5 sm:p-4">
                    <label class="flex cursor-pointer items-start gap-3">
                      <input
                        type="checkbox"
                        role="switch"
                        aria-label="Share automatically"
                        data-testid="sharing-auto-share"
                        class="peer sr-only"
                        checked={status().auto_share}
                        disabled={busy() || !statusReady()}
                        onChange={(event) => {
                          const next = event.currentTarget.checked;
                          event.currentTarget.checked = status().auto_share;
                          setNextAutoShare(next);
                          setPolicyError(null);
                          setConfirmAutoShare(true);
                        }}
                      />
                      <span
                        aria-hidden="true"
                        class="relative mt-0.5 h-6 w-10 shrink-0 rounded-full bg-line peer-checked:bg-accent peer-checked:[&>span]:translate-x-4 peer-focus-visible:[&>span]:transition-none peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-disabled:opacity-50"
                      >
                        <span class="absolute left-1 top-1 size-4 rounded-full bg-surface shadow-sm motion-safe:transition-transform motion-safe:duration-150" />
                      </span>
                      <span class="min-w-0 flex-1">
                        <span class="block text-sm font-medium">
                          Share automatically
                        </span>
                        <span class="mt-1 block text-xs leading-relaxed text-muted">
                          {status().auto_share
                            ? "New team knowledge is proposed automatically. Your team’s review rules still apply."
                            : "You choose which entries to propose. Turn this on to propose new team knowledge automatically."}
                        </span>
                      </span>
                    </label>
                    <div class="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3 text-xs text-muted">
                      <span
                        class="inline-flex items-center gap-1.5"
                        data-testid="sharing-team-review"
                      >
                        <Icon name="lock" class="size-3" />
                        Team review:{" "}
                        {status().review_required === true
                          ? "required"
                          : status().review_required === false
                            ? "optional"
                            : "unavailable"}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>
                        {status().auto_share ? "New entries" : "You propose"} →{" "}
                        {status().review_required === false
                          ? "Shared on the next sync"
                          : "Review → Shared after approval"}
                      </span>
                    </div>
                  </div>
                </Show>
                <Show when={linkSuccess()}>
                  <p
                    class="flex items-center gap-2 text-sm text-accent"
                    role="status"
                  >
                    <Icon name="check" />
                    {linkSuccess()}
                  </p>
                </Show>
                <Show when={policyError() && !confirmAutoShare()}>
                  <p class="text-sm text-danger" role="alert">
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
                    size="sm"
                    class="h-11 md:h-9"
                    variant="outline"
                    data-testid="sharing-reload-policy"
                    onClick={reload}
                  >
                    Reload status
                  </Button>
                </Show>
                <Show when={linkError() && !confirmUnlink()}>
                  <p class="text-sm text-danger" role="alert">
                    {linkErrorText()}
                  </p>
                </Show>
                <Show
                  when={
                    !confirmUnlink() &&
                    linkError() &&
                    requiresMutationReload(linkError()?.cause)
                  }
                >
                  <Button
                    size="sm"
                    class="h-11 md:h-9"
                    variant="outline"
                    data-testid="sharing-reload-link"
                    onClick={reload}
                  >
                    Reload status
                  </Button>
                </Show>
              </div>
              <SharingSync
                status={status()}
                ready={statusReady()}
                busy={busy()}
                compact={compactReady() && !expanded()}
                onRefresh={refresh}
              />
              <details
                hidden={!settingsVisible()}
                class="border-t border-line px-4 py-3 text-xs text-muted sm:px-5"
              >
                <summary class="cursor-pointer select-none hover:text-text">
                  Sharing details
                </summary>
                <div class="mt-2 space-y-1 leading-relaxed">
                  <p data-testid="sharing-summary">
                    {STATE_LABEL[status().state]} · {teamLabel(status())} ·
                    policy: {status().policy.effective}
                  </p>
                  <p data-testid="sharing-policy">
                    Project preference:{" "}
                    {status().policy.project_override ?? "none"} · team default:{" "}
                    {status().policy.team_default ?? "none"}
                  </p>
                  <Show when={status().detail}>
                    <p data-testid="sharing-detail">{status().detail}</p>
                  </Show>
                </div>
              </details>
            </div>
          )}
        </Match>
        <Match when={hidden()}>
          <div class="p-5">
            <StateCard kind="locked" title="Sharing status hidden" compact>
              This gateway does not expose sharing status to this browser.
            </StateCard>
          </div>
        </Match>
        <Match when={sharing.error() !== undefined}>
          <div class="p-5">
            <StateCard
              kind="empty"
              title="Sharing status not available"
              compact
              action={
                <Button
                  variant="outline"
                  size="sm"
                  class="h-11 md:h-9"
                  onClick={refresh}
                >
                  Retry
                </Button>
              }
            />
          </div>
        </Match>
      </Switch>
      <Dialog
        open={confirmUnlink()}
        onOpenChange={(open) => {
          if (!savingLink()) setConfirmUnlink(open);
        }}
      >
        <DialogContent data-testid="sharing-unlink-confirmation">
          <DialogHeader>
            <DialogTitle>
              Unlink from{" "}
              {shownStatus() ? teamLabel(shownStatus()!) : "this team"}?
            </DialogTitle>
            <DialogDescription>
              This stops future sharing from this project. It does not remove
              copies already on teammates’ devices. Your team membership and
              local memory stay unchanged.
            </DialogDescription>
          </DialogHeader>
          <Show when={linkError()}>
            <p
              role="alert"
              class="text-sm text-danger"
              tabIndex={-1}
              ref={(element) => queueMicrotask(() => element.focus())}
            >
              {linkErrorText()}
            </p>
          </Show>
          <Show
            when={linkError() && requiresMutationReload(linkError()?.cause)}
          >
            <Button
              size="sm"
              class="h-11 md:h-9"
              variant="outline"
              onClick={() => {
                setConfirmUnlink(false);
                reload();
              }}
            >
              Reload status
            </Button>
          </Show>
          <DialogFooter>
            <Button
              size="sm"
              class="h-11 md:h-9"
              variant="outline"
              disabled={savingLink()}
              onClick={() => setConfirmUnlink(false)}
            >
              Keep connected
            </Button>
            <Button
              size="sm"
              class="h-11 md:h-9"
              variant="destructive"
              pending={savingLink()}
              disabled={
                busy() ||
                !statusReady() ||
                (!!linkError() && requiresMutationReload(linkError()?.cause))
              }
              onClick={() => void updateProjectLink(null)}
            >
              {savingLink() ? "Unlinking…" : "Unlink project"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={confirmAutoShare()} onOpenChange={closeAutoShareDialog}>
        <DialogContent data-testid="sharing-policy-confirmation">
          <DialogHeader>
            <DialogTitle>
              {nextAutoShare()
                ? "Share automatically?"
                : "Turn off automatic sharing?"}
            </DialogTitle>
            <DialogDescription>
              {!nextAutoShare()
                ? "You’ll choose which new entries to propose. Copies already shared with the team are not removed."
                : shownStatus()?.review_required === false
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
              class="h-11 md:h-9"
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
              class="h-11 md:h-9"
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
              class="h-11 md:h-9"
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
