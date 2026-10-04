import type { Component } from "solid-js";
import { createSignal, For, Match, onMount, Show, Switch } from "solid-js";
import {
  createColumnHelper,
  createTable,
  flexRender,
  tableFeatures,
} from "@tanstack/solid-table";

import type { PromotionListResponse, PromotionRequest } from "~/contracts";
import { ApiError } from "~/lib/api";
import { useWorkspace } from "~/routes/workspace";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { TextField, TextFieldTextArea } from "~/components/ui/text-field";
import { StateCard } from "./StateCard";
import { PromotionIdentity } from "./PromotionIdentity";

type PromotionFilter = "pending" | "decided" | "all";
type PageState =
  | "loading"
  | "anonymous"
  | "hosted"
  | "unreachable"
  | "error"
  | "no_team"
  | "ready";
type Decision = "approved" | "rejected";

interface Confirmation {
  request: PromotionRequest;
  decision: Decision;
}

const features = tableFeatures({});
const helper = createColumnHelper<typeof features, PromotionRequest>();

function dateLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Could not load promotion requests.";
}

function blockedReason(request: PromotionRequest): string {
  switch (request.decide_blocked_reason) {
    case "own_proposal":
      return "You proposed this; another admin must review.";
    case "not_admin":
      return "Only team admins can review.";
    case "decided":
      return "This promotion has already been decided.";
    default:
      return "";
  }
}

function statusLabel(request: PromotionRequest): string {
  if (request.applied === "stale")
    return "Stale: the entry changed after it was proposed; propose again.";
  if (request.status === "approved" && request.applied === "applied")
    return "Shared";
  if (request.status === "approved" && request.applied === null)
    return "Approved, applying on next sync";
  return request.status[0]!.toUpperCase() + request.status.slice(1);
}

export const PromotionsPage: Component = () => {
  const ws = useWorkspace();
  const [pageState, setPageState] = createSignal<PageState>("loading");
  const [teams, setTeams] = createSignal<
    Array<{
      id: string;
      name: string | null;
      role: string;
      member_count: number;
    }>
  >([]);
  const [teamId, setTeamId] = createSignal("");
  const [filter, setFilter] = createSignal<PromotionFilter>("pending");
  const [data, setData] = createSignal<PromotionListResponse>();
  const [loadingList, setLoadingList] = createSignal(false);
  const [listError, setListError] = createSignal<unknown>();
  const [confirmation, setConfirmation] = createSignal<Confirmation | null>(
    null,
  );
  const [note, setNote] = createSignal("");
  const [acting, setActing] = createSignal(false);
  const [actionError, setActionError] = createSignal<unknown>();
  const [actionErrorMessage, setActionErrorMessage] = createSignal("");

  const columns = helper.columns([
    helper.accessor((row) => row.title ?? "Encrypted request", {
      id: "title",
      header: "Title",
    }),
    helper.accessor((row) => row.team.name ?? row.team.id, {
      id: "team",
      header: "Team",
    }),
    helper.accessor((row) => row.proposer.label ?? row.proposer.id, {
      id: "proposer",
      header: "Proposer",
    }),
    helper.accessor((row) => dateLabel(row.created_at), {
      id: "proposed",
      header: "Proposed",
    }),
    helper.accessor(statusLabel, { id: "status", header: "Status" }),
    helper.display({ id: "actions", header: "Actions" }),
  ]);
  const table = createTable({
    features,
    columns,
    get data() {
      return data()?.requests ?? [];
    },
    getRowId: (row) => row.id,
  });

  const setLoadError = (error: unknown) => {
    setListError(error);
    if (error instanceof ApiError && error.kind === "unreachable") {
      setPageState("unreachable");
    } else if (error instanceof ApiError && error.kind === "forbidden") {
      setPageState("hosted");
    } else {
      setPageState("error");
    }
  };

  const loadList = async (
    selectedTeam: string | null = teamId() || null,
    selectedFilter = filter(),
  ) => {
    setLoadingList(true);
    setListError(undefined);
    try {
      const response = await ws.tracked(() =>
        ws.client.listPromotions(selectedTeam, selectedFilter),
      );
      setData(response);
      if (response.remote === "hosted") setPageState("hosted");
      else if (response.remote === "anonymous") setPageState("anonymous");
      else if (response.remote === "unreachable") setPageState("unreachable");
      else setPageState("ready");
    } catch (error) {
      setLoadError(error);
    } finally {
      setLoadingList(false);
    }
  };

  const initialize = async () => {
    setPageState("loading");
    setListError(undefined);
    try {
      const account = await ws.tracked(() => ws.client.getAccount());
      if (!account.signed_in) {
        await loadList(null, filter());
        return;
      }
      const result = await ws.tracked(() => ws.client.getTeams());
      setTeams(result.teams);
      const first = result.teams[0];
      if (!first) {
        setPageState("no_team");
        return;
      }
      setTeamId(first.id);
      await loadList(first.id, filter());
    } catch (error) {
      setLoadError(error);
    }
  };

  onMount(() => void initialize());

  const retryLoad = () => {
    if (teamId()) {
      setPageState("loading");
      void loadList(teamId(), filter());
    } else {
      void initialize();
    }
  };

  const selectFilter = (event: Event) => {
    const value = (event.currentTarget as HTMLSelectElement)
      .value as PromotionFilter;
    setFilter(value);
    void loadList(teamId() || null, value);
  };

  const selectTeam = (event: Event) => {
    const value = (event.currentTarget as HTMLSelectElement).value;
    setTeamId(value);
    void loadList(value, filter());
  };

  const startDecision = (request: PromotionRequest, decision: Decision) => {
    if (!request.can_decide) return;
    setNote("");
    setActionError(undefined);
    setActionErrorMessage("");
    setConfirmation({ request, decision });
  };

  const confirmDecision = async () => {
    const current = confirmation();
    if (!current || !current.request.can_decide) return;
    setActing(true);
    setActionError(undefined);
    setActionErrorMessage("");
    try {
      const receipt = await ws.tracked(() =>
        ws.client.decidePromotion(
          current.request.id,
          current.decision,
          note() || undefined,
        ),
      );
      setData((previous) =>
        previous
          ? {
              ...previous,
              requests: previous.requests.map((request) =>
                request.id === current.request.id ? receipt.request : request,
              ),
            }
          : previous,
      );
      setConfirmation(null);
    } catch (error) {
      setActionError(error);
      setActionErrorMessage(
        error instanceof Error
          ? error.message
          : "The gateway refused the decision.",
      );
    } finally {
      setActing(false);
    }
  };

  const closeConfirmation = () => {
    if (!acting()) setConfirmation(null);
  };

  return (
    <section class="p-4 sm:p-6" data-testid="promotions-page">
      <div class="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 class="text-[25px] font-semibold">Promotions</h1>
          <p class="mt-1 text-sm text-muted">
            Review knowledge proposed for your team.
          </p>
        </div>
        <div class="flex flex-wrap gap-2">
          <Show when={teams().length > 1}>
            <label class="flex flex-col gap-1 text-xs text-muted">
              Team
              <select
                aria-label="Team"
                data-testid="promotions-team"
                class="h-9 rounded-md border border-line bg-surface px-2 text-sm text-text"
                value={teamId()}
                onChange={selectTeam}
              >
                <For each={teams()}>
                  {(team) => (
                    <option value={team.id}>{team.name ?? team.id}</option>
                  )}
                </For>
              </select>
            </label>
          </Show>
          <label class="flex flex-col gap-1 text-xs text-muted">
            Status
            <select
              aria-label="Status filter"
              data-testid="promotions-status"
              class="h-9 rounded-md border border-line bg-surface px-2 text-sm text-text"
              value={filter()}
              onChange={selectFilter}
            >
              <option value="pending">Pending</option>
              <option value="decided">Decided</option>
              <option value="all">All</option>
            </select>
          </label>
        </div>
      </div>

      <Switch>
        <Match when={pageState() === "loading"}>
          <StateCard kind="loading" title="Loading promotions" />
        </Match>
        <Match when={pageState() === "anonymous"}>
          <div data-testid="promotions-unavailable">
            <StateCard kind="locked" title="Promotions unavailable">
              Sign in with `lore login` to review team promotions.
            </StateCard>
          </div>
        </Match>
        <Match when={pageState() === "hosted"}>
          <StateCard kind="locked" title="Promotions unavailable">
            Team promotion review is not available in hosted mode.
          </StateCard>
        </Match>
        <Match when={pageState() === "unreachable"}>
          <StateCard kind="error" title="Promotions unavailable">
            The gateway or promotion service could not be reached.
          </StateCard>
        </Match>
        <Match when={pageState() === "error"}>
          <StateCard kind="error" title="Promotions unavailable">
            {errorMessage(listError())}
            <Button
              class="mt-3"
              size="sm"
              variant="outline"
              data-testid="promotions-retry"
              onClick={retryLoad}
            >
              Retry
            </Button>
          </StateCard>
        </Match>
        <Match when={pageState() === "no_team"}>
          <StateCard kind="empty" title="No team memberships">
            Join a team before reviewing promotion requests.
          </StateCard>
        </Match>
        <Match when={pageState() === "ready"}>
          <Show when={loadingList() && !data()}>
            <StateCard kind="loading" title="Loading promotions" />
          </Show>
          <Show when={data()}>
            {(result) => (
              <>
                <Show when={!result().complete}>
                  <p
                    class="mb-3 rounded-md border border-line bg-bg px-3 py-2 text-sm text-muted"
                    data-testid="promotions-truncated"
                  >
                    Showing the newest 100 promotion requests.
                  </p>
                </Show>
                <Show
                  when={result().requests.some((request) => request.sealed)}
                >
                  <p
                    class="mb-3 rounded-md border border-line bg-bg px-3 py-2 text-sm text-muted"
                    data-testid="promotions-sealed"
                  >
                    Encrypted, unlock with `lore sync enable` to read proposal
                    content.
                  </p>
                </Show>
                <Show
                  when={result().requests.length > 0}
                  fallback={
                    <StateCard kind="empty" title="No promotion requests">
                      New team proposals will appear here.
                    </StateCard>
                  }
                >
                  <div class="overflow-x-auto" data-testid="promotions-list">
                    <table class="min-w-[760px] w-full text-left text-xs">
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
                              data-testid="promotion-row"
                              data-promotion-id={row.original.id}
                            >
                              <For each={row.getAllCells()}>
                                {(cell) => (
                                  <td class="max-w-64 px-2 py-3">
                                    <Switch>
                                      <Match when={cell.column.id === "title"}>
                                        <span class="block truncate font-semibold">
                                          {row.original.title ??
                                            "Encrypted request"}
                                        </span>
                                        <Show when={row.original.sealed}>
                                          <span class="mt-1 block text-[11px] text-muted">
                                            Encrypted
                                          </span>
                                        </Show>
                                      </Match>
                                      <Match when={cell.column.id === "team"}>
                                        {row.original.team.name ??
                                          row.original.team.id}
                                      </Match>
                                      <Match
                                        when={cell.column.id === "proposer"}
                                      >
                                        <PromotionIdentity
                                          id={row.original.proposer.id}
                                          label={row.original.proposer.label}
                                        />
                                      </Match>
                                      <Match
                                        when={cell.column.id === "proposed"}
                                      >
                                        {dateLabel(row.original.created_at)}
                                      </Match>
                                      <Match when={cell.column.id === "status"}>
                                        {statusLabel(row.original)}
                                      </Match>
                                      <Match
                                        when={cell.column.id === "actions"}
                                      >
                                        <div class="flex flex-wrap gap-1">
                                          <Button
                                            size="sm"
                                            variant="outline"
                                            disabled={
                                              !row.original.can_decide ||
                                              acting()
                                            }
                                            data-testid="promotion-approve"
                                            onClick={() =>
                                              startDecision(
                                                row.original,
                                                "approved",
                                              )
                                            }
                                          >
                                            Approve
                                          </Button>
                                          <Button
                                            size="sm"
                                            variant="outline"
                                            disabled={
                                              !row.original.can_decide ||
                                              acting()
                                            }
                                            data-testid="promotion-reject"
                                            onClick={() =>
                                              startDecision(
                                                row.original,
                                                "rejected",
                                              )
                                            }
                                          >
                                            Reject
                                          </Button>
                                        </div>
                                        <Show when={!row.original.can_decide}>
                                          <span
                                            class="mt-1 block max-w-52 text-[11px] text-muted"
                                            data-testid="promotion-disabled-reason"
                                          >
                                            {blockedReason(row.original)}
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
              </>
            )}
          </Show>
        </Match>
      </Switch>

      <Dialog
        open={confirmation() !== null}
        onOpenChange={(open) => {
          if (!open) closeConfirmation();
        }}
      >
        <DialogContent
          role="alertdialog"
          aria-label="Confirm promotion decision"
          data-testid="promotion-decision-dialog"
        >
          <DialogHeader>
            <DialogTitle>
              {confirmation()?.decision === "approved"
                ? "Approve this promotion?"
                : "Reject this promotion?"}
            </DialogTitle>
            <DialogDescription>
              {confirmation()?.decision === "approved"
                ? `Approving makes this knowledge visible to every member of ${confirmation()?.request.team.name ?? "the team"} after the proposer syncs.`
                : "Rejecting keeps this knowledge private to the proposer."}
            </DialogDescription>
          </DialogHeader>
          <TextField>
            <label for="promotion-note" class="text-sm font-medium">
              Optional note
            </label>
            <TextFieldTextArea
              id="promotion-note"
              aria-label="Decision note"
              maxLength={500}
              value={note()}
              onInput={(event) =>
                setNote(event.currentTarget.value.slice(0, 500))
              }
            />
            <div class="text-right text-xs text-muted">{note().length}/500</div>
          </TextField>
          <Show when={actionError()}>
            <p role="alert" class="text-sm text-danger">
              {actionErrorMessage()}
            </p>
          </Show>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={acting()}
              onClick={closeConfirmation}
            >
              Cancel
            </Button>
            <Button
              disabled={acting()}
              data-testid="promotion-confirm-decision"
              onClick={() => void confirmDecision()}
            >
              {acting()
                ? "Saving…"
                : confirmation()?.decision === "approved"
                  ? "Approve promotion"
                  : "Reject promotion"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
};
