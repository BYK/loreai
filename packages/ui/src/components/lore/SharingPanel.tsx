import type { Component } from "solid-js";
import { Match, Show, Switch } from "solid-js";

import type { SharingStatus } from "~/contracts";
import { isApiError } from "~/lib/api";
import { createLoader } from "~/lib/loader";
import { useWorkspace } from "~/routes/workspace";

import { Button } from "../ui/button";
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
        <Match when={sharing.data()}>
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
              <Button
                variant="outline"
                size="sm"
                onClick={() => sharing.reload()}
              >
                Retry
              </Button>
            }
          />
        </Match>
      </Switch>
    </section>
  );
};
