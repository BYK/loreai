import type { Component } from "solid-js";
import { createEffect, createSignal, Match, on, Show, Switch } from "solid-js";

import type { SharingStatus } from "~/contracts";
import { isApiError } from "~/lib/api";
import { createLoader } from "~/lib/loader";
import { useWorkspace } from "~/routes/workspace";

import { Button } from "../ui/button";
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

/** Read-only project sharing status (`GET /api/v1/projects/:id/sharing`). */
export const SharingPanel: Component<{ projectId: string }> = (props) => {
  const ws = useWorkspace();
  const sharing = createLoader(
    () => props.projectId,
    (projectId) => ws.tracked(() => ws.client.getProjectSharing(projectId)),
  );
  const [receipt, setReceipt] = createSignal<SharingStatus>();
  const [confirmReview, setConfirmReview] = createSignal(false);
  const [savingPolicy, setSavingPolicy] = createSignal(false);
  const [policyError, setPolicyError] = createSignal<unknown>();
  const shownStatus = () => receipt() ?? sharing.data();
  const stalePolicy = () => {
    const error = policyError();
    return isApiError(error) && error.code === "stale_policy";
  };
  createEffect(
    on(
      () => props.projectId,
      () => {
        setReceipt(undefined);
        setPolicyError(undefined);
      },
    ),
  );
  const reload = () => {
    setReceipt(undefined);
    setPolicyError(undefined);
    sharing.reload();
  };
  const requireReview = async () => {
    const current = shownStatus();
    if (
      !current ||
      !current.linked ||
      current.policy.effective !== "auto" ||
      savingPolicy()
    )
      return;
    setSavingPolicy(true);
    setPolicyError(undefined);
    try {
      const updated = await ws.tracked(() =>
        ws.client.requireProjectSharingReview(
          props.projectId,
          current.policy.project_override,
        ),
      );
      setReceipt(updated);
      setConfirmReview(false);
    } catch (error) {
      setPolicyError(error);
    } finally {
      setSavingPolicy(false);
    }
  };
  const errorText = () => {
    const error = policyError();
    return error instanceof Error
      ? error.message
      : "The sharing policy could not be updated.";
  };
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
              <Show
                when={status().linked && status().policy.effective === "auto"}
              >
                <div class="text-xs text-muted">
                  Automatic sharing can only be selected from the CLI.
                </div>
              </Show>
              <Show
                when={status().linked && status().policy.effective === "auto"}
              >
                <Button
                  class="mt-2"
                  size="sm"
                  variant="outline"
                  data-testid="sharing-require-review"
                  disabled={savingPolicy()}
                  onClick={() => {
                    setPolicyError(undefined);
                    setConfirmReview(true);
                  }}
                >
                  Require review
                </Button>
              </Show>
              <Show when={policyError()}>
                <p class="mt-2 text-sm text-danger" role="alert">
                  {errorText()}
                </p>
              </Show>
              <Show when={stalePolicy()}>
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
      <Dialog open={confirmReview()} onOpenChange={setConfirmReview}>
        <DialogContent data-testid="sharing-policy-confirmation">
          <DialogHeader>
            <DialogTitle>Require review before sharing?</DialogTitle>
            <DialogDescription>
              New knowledge will wait for a team admin to approve it before it
              is shared. Automatic sharing can only be enabled from the CLI.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              size="sm"
              variant="outline"
              disabled={savingPolicy()}
              onClick={() => setConfirmReview(false)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={savingPolicy()}
              onClick={() => void requireReview()}
            >
              {savingPolicy() ? "Saving…" : "Require review"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
};
