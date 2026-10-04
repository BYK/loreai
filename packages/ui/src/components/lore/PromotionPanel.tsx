import type { Component } from "solid-js";
import { createSignal, onMount, Show } from "solid-js";

import type { PromotionPreview, PromotionRequest } from "~/contracts";
import { ApiError, type ApiClient } from "~/lib/api";
import { Button } from "~/components/ui/button";
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

const ELIGIBILITY: Record<
  NonNullable<PromotionPreview["eligibility"]["reason"]>,
  string
> = {
  no_project: "This entry is not attached to a project.",
  not_linked: "Link this project to a team before proposing.",
  already_shared: "This entry is already shared with the team.",
  restricted: "Restricted knowledge cannot be proposed to a team.",
  hosted: "Team promotion is not available on a hosted gateway.",
  account_required: "Sign in with `lore login` to propose.",
  remote_unavailable: "Lore cloud could not be reached. Try again later.",
  encryption_locked: "Unlock team encryption with `lore sync enable`.",
};

function requestStatus(request: PromotionRequest): string {
  if (request.applied === "stale")
    return "Stale: the entry changed after it was proposed; propose again.";
  switch (request.status) {
    case "pending":
      return request.mine
        ? "Proposed · waiting for review"
        : "Waiting for review";
    case "approved":
      return request.applied === "applied"
        ? "Shared"
        : "Approved, applying on next sync";
    case "rejected":
      return "Rejected";
    case "withdrawn":
      return "Withdrawn";
  }
}

function timestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function eligibilityMessage(
  reason: PromotionPreview["eligibility"]["reason"],
): string {
  return reason
    ? ELIGIBILITY[reason]
    : "This entry cannot be proposed to a team.";
}

export const PromotionPanel: Component<{
  knowledgeId: string;
  client: ApiClient;
}> = (props) => {
  const [preview, setPreview] = createSignal<PromotionPreview>();
  const [loading, setLoading] = createSignal(true);
  const [loadError, setLoadError] = createSignal<unknown>();
  const [dialogOpen, setDialogOpen] = createSignal(false);
  const [sending, setSending] = createSignal(false);
  const [withdrawing, setWithdrawing] = createSignal(false);
  const [actionError, setActionError] = createSignal<unknown>();
  const request = () => preview()?.pending_request ?? null;
  const message = (error: unknown) =>
    error instanceof Error ? error.message : "The gateway refused the request.";
  const isStaleError = () => {
    const error = actionError();
    return error instanceof ApiError && error.code === "stale_version";
  };

  const reloadPreview = async () => {
    setLoading(true);
    setLoadError(undefined);
    setActionError(undefined);
    try {
      setPreview(await props.client.getPromotionPreview(props.knowledgeId));
    } catch (error) {
      setLoadError(error);
    } finally {
      setLoading(false);
    }
  };

  onMount(() => void reloadPreview());

  const propose = async () => {
    const current = preview();
    if (!current || !current.eligibility.promotable) return;
    setSending(true);
    setActionError(undefined);
    try {
      const receipt = await props.client.promoteKnowledge(
        props.knowledgeId,
        current.entry.version_id,
      );
      setPreview((value) =>
        value ? { ...value, pending_request: receipt.request } : value,
      );
      setDialogOpen(false);
    } catch (error) {
      setActionError(error);
    } finally {
      setSending(false);
    }
  };

  const withdraw = async () => {
    const current = request();
    if (!current) return;
    setWithdrawing(true);
    setActionError(undefined);
    try {
      const receipt = await props.client.withdrawPromotion(current.id);
      setPreview((value) =>
        value ? { ...value, pending_request: receipt.request } : value,
      );
    } catch (error) {
      setActionError(error);
    } finally {
      setWithdrawing(false);
    }
  };

  return (
    <section
      class="mt-6 rounded-lg border border-line bg-bg p-4 sm:p-5"
      data-testid="promotion-panel"
    >
      <h2 class="text-base font-semibold">Propose to team</h2>
      <Show when={loading()}>
        <div class="mt-3">
          <StateCard kind="loading" title="Loading promotion preview" compact />
        </div>
      </Show>
      <Show when={loadError()}>
        <div class="mt-3">
          <StateCard kind="error" title="Promotion preview unavailable" compact>
            {message(loadError())}
          </StateCard>
          <Button
            class="mt-3"
            size="sm"
            variant="outline"
            onClick={() => void reloadPreview()}
          >
            Reload preview
          </Button>
        </div>
      </Show>
      <Show when={preview()}>
        {(value) => (
          <>
            <Show when={request()}>
              {(current) => (
                <div
                  class="mt-3 rounded-md border border-line bg-surface p-3"
                  data-testid="promotion-request-status"
                >
                  <div class="font-medium">{requestStatus(current())}</div>
                  <p class="mt-2 text-sm">
                    Proposed by{" "}
                    <PromotionIdentity
                      id={current().proposer.id}
                      label={current().proposer.label}
                    />
                  </p>
                  <Show when={current().decided_by}>
                    {(reviewer) => (
                      <p class="mt-1 text-sm">
                        Reviewed by{" "}
                        <PromotionIdentity
                          id={reviewer().id}
                          label={reviewer().label}
                        />
                      </p>
                    )}
                  </Show>
                  <div class="mt-1 break-all font-mono text-[11px] text-muted">
                    {timestamp(current().created_at)} · {current().id}
                  </div>
                  <Show when={current().status === "pending" && current().mine}>
                    <Button
                      class="mt-3"
                      size="sm"
                      variant="outline"
                      disabled={withdrawing()}
                      onClick={() => void withdraw()}
                    >
                      {withdrawing() ? "Withdrawing…" : "Withdraw"}
                    </Button>
                  </Show>
                </div>
              )}
            </Show>
            <Show when={!value().eligibility.promotable}>
              <p
                class="mt-3 text-sm text-muted"
                data-testid="promotion-eligibility"
              >
                {eligibilityMessage(value().eligibility.reason)}
              </p>
              <Show when={value().eligibility.reason === "remote_unavailable"}>
                <Button
                  class="mt-3"
                  size="sm"
                  variant="outline"
                  onClick={() => void reloadPreview()}
                >
                  Reload preview
                </Button>
              </Show>
              <Button
                class="mt-3"
                size="sm"
                disabled
                data-testid="promotion-propose"
              >
                Propose
              </Button>
            </Show>
            <Show when={value().eligibility.promotable}>
              <Show
                when={request()?.status !== "pending"}
                fallback={
                  <p class="mt-3 text-xs text-muted">
                    A proposal is already waiting for review.
                  </p>
                }
              >
                <Button
                  class="mt-3"
                  size="sm"
                  variant="outline"
                  data-testid="promotion-preview-open"
                  onClick={() => {
                    setActionError(undefined);
                    setDialogOpen(true);
                  }}
                >
                  Preview team share
                </Button>
              </Show>
            </Show>
            <Show when={actionError()}>
              <p class="mt-3 text-sm text-danger" role="alert">
                {message(actionError())}
              </p>
            </Show>
            <Show when={isStaleError()}>
              <Button
                class="mt-2"
                size="sm"
                variant="outline"
                onClick={() => void reloadPreview()}
              >
                Reload preview
              </Button>
            </Show>
            <Dialog open={dialogOpen()} onOpenChange={setDialogOpen}>
              <DialogContent
                data-testid="promotion-preview-dialog"
                aria-label="Preview team share"
              >
                <DialogHeader>
                  <DialogTitle>Preview team share</DialogTitle>
                  <DialogDescription>
                    Review the exact title and content before proposing this
                    knowledge.
                  </DialogDescription>
                </DialogHeader>
                <div
                  class={`grid gap-3 ${value().previous_team_version ? "md:grid-cols-2" : ""}`}
                >
                  <div class="rounded-md border border-line bg-bg p-3">
                    <div class="eyebrow">Title</div>
                    <p class="mt-1 whitespace-pre-wrap break-words text-sm font-semibold">
                      {value().entry.title}
                    </p>
                    <div class="eyebrow mt-4">Content</div>
                    <pre
                      class="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words font-sans text-sm"
                      data-testid="promotion-preview-content"
                    >
                      {value().entry.content}
                    </pre>
                  </div>
                  <Show when={value().previous_team_version}>
                    {(previous) => (
                      <aside
                        class="rounded-md border border-line p-3 text-sm"
                        data-testid="previous-team-version"
                      >
                        <div class="font-semibold">
                          Previous team version · v{previous().version}
                        </div>
                        <div class="mt-2 font-medium">{previous().title}</div>
                        <pre class="mt-1 whitespace-pre-wrap break-words font-sans text-xs text-muted">
                          {previous().content}
                        </pre>
                      </aside>
                    )}
                  </Show>
                </div>
                <p class="text-sm">
                  Team: <strong>{value().team?.name ?? "your team"}</strong>
                </p>
                <p class="text-sm text-muted">
                  Approving makes this visible to every member of{" "}
                  {value().team?.name ?? "the team"} after your Lore syncs. A
                  team admin other than you must approve.
                </p>
                <Show when={actionError()}>
                  <p class="text-sm text-danger" role="alert">
                    {message(actionError())}
                  </p>
                </Show>
                <Show when={isStaleError()}>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void reloadPreview()}
                  >
                    Reload preview
                  </Button>
                </Show>
                <DialogFooter>
                  <Button
                    variant="outline"
                    disabled={sending()}
                    onClick={() => setDialogOpen(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    disabled={sending()}
                    data-testid="promotion-propose"
                    onClick={() => void propose()}
                  >
                    {sending() ? "Sending…" : "Propose"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </>
        )}
      </Show>
    </section>
  );
};
