import type { Component } from "solid-js";
import { createSignal, For, Match, onMount, Show, Switch } from "solid-js";

import type {
  SyncConflict,
  SyncConflictCurrent,
  SyncConflictList,
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

type Confirmation = {
  conflict: SyncConflict;
  action: "keep" | "discard";
};

type PageState = "loading" | "hosted" | "unreachable" | "error" | "ready";

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Sync conflicts could not be loaded.";
}

function reasonMessage(conflict: SyncConflict): string {
  switch (conflict.unrecoverable_reason) {
    case "not_knowledge":
      return `This conflict affects ${conflict.table}, not knowledge. Its local snapshot is hidden.`;
    case "remote_delete":
      return "The remote entry was deleted; restoring it here is not supported.";
    case "entry_missing":
      return "The current knowledge entry no longer exists.";
    case "unreadable":
      return "The saved local snapshot could not be read.";
    default:
      return "This conflict cannot be restored here.";
  }
}

function versionSummary(current: SyncConflictCurrent): string {
  return `Version ${current.version} · ${current.version_id}`;
}

export const ConflictsPage: Component = () => {
  const ws = useWorkspace();
  const [pageState, setPageState] = createSignal<PageState>("loading");
  const [data, setData] = createSignal<SyncConflictList>();
  const [loading, setLoading] = createSignal(false);
  const [loadError, setLoadError] = createSignal<unknown>();
  const [confirmation, setConfirmation] = createSignal<Confirmation | null>(
    null,
  );
  const [acting, setActing] = createSignal(false);
  const [actionError, setActionError] = createSignal<{
    id: number;
    message: string;
  } | null>(null);
  const [resolvedIds, setResolvedIds] = createSignal<ReadonlySet<number>>(
    new Set(),
  );
  const [reloadRequired, setReloadRequired] = createSignal(false);
  const [receipt, setReceipt] = createSignal<SyncConflictCurrent | null>(null);

  const load = async () => {
    setLoading(true);
    setLoadError(undefined);
    setActionError(null);
    setReloadRequired(false);
    setResolvedIds(new Set<number>());
    try {
      const response = await ws.tracked(() => ws.client.listSyncConflicts());
      setData(response);
      setPageState(response.available ? "ready" : "hosted");
    } catch (error) {
      setLoadError(error);
      if (error instanceof ApiError && error.kind === "unreachable")
        setPageState("unreachable");
      else if (error instanceof ApiError && error.kind === "forbidden")
        setPageState("hosted");
      else setPageState("error");
    } finally {
      setLoading(false);
    }
  };

  const confirmAction = async () => {
    const current = confirmation();
    if (!current || acting()) return;
    setActing(true);
    setActionError(null);
    setReloadRequired(false);
    try {
      if (current.action === "keep") {
        const expectedVersion = current.conflict.current?.version_id;
        if (!expectedVersion) {
          setActionError({
            id: current.conflict.id,
            message: "The current version is unavailable. Reload conflicts.",
          });
          setReloadRequired(true);
          return;
        }
        const result = await ws.tracked(() =>
          ws.client.keepSyncConflictLocal(current.conflict.id, expectedVersion),
        );
        setReceipt(result.current);
        setData((previous) =>
          previous
            ? {
                ...previous,
                conflicts: previous.conflicts.filter(
                  (conflict) => conflict.id !== current.conflict.id,
                ),
              }
            : previous,
        );
      } else {
        const result = await ws.tracked(() =>
          ws.client.discardSyncConflict(current.conflict.id),
        );
        setData((previous) =>
          previous
            ? {
                ...previous,
                conflicts: previous.conflicts.filter(
                  (conflict) => conflict.id !== result.discarded,
                ),
              }
            : previous,
        );
      }
      setResolvedIds((previous) => {
        const next = new Set(previous);
        next.delete(current.conflict.id);
        return next;
      });
      setConfirmation(null);
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.kind === "not_found" || error.code === "not_found")
      ) {
        setResolvedIds((previous) =>
          new Set(previous).add(current.conflict.id),
        );
        setActionError({
          id: current.conflict.id,
          message: "This conflict was already resolved elsewhere.",
        });
        setReloadRequired(true);
      } else if (requiresMutationReload(error)) {
        setActionError({
          id: current.conflict.id,
          message: errorMessage(error),
        });
        setReloadRequired(true);
      } else {
        setActionError({
          id: current.conflict.id,
          message: errorMessage(error),
        });
        setReloadRequired(false);
      }
    } finally {
      setActing(false);
    }
  };

  const requestAction = (
    conflict: SyncConflict,
    action: "keep" | "discard",
  ) => {
    setActionError(null);
    setReloadRequired(false);
    setConfirmation({ conflict, action });
  };

  const reloadConflicts = () => {
    setReceipt(null);
    void load();
  };

  const closeConfirmation = (open: boolean) => {
    if (!open && !acting()) setConfirmation(null);
  };

  const dialogActionError = () => {
    const current = confirmation();
    const error = actionError();
    return current && error?.id === current.conflict.id ? error : null;
  };

  const reloadAfterDialogError = () => {
    setConfirmation(null);
    reloadConflicts();
  };

  onMount(() => void load());

  return (
    <section class="p-4 sm:p-6" data-testid="conflicts-page">
      <div class="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 class="text-[25px] font-semibold">Sync conflicts</h1>
          <p class="mt-1 text-sm text-muted">
            Review local knowledge versions replaced by cloud sync.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={loading()}
          data-testid="conflicts-reload"
          onClick={reloadConflicts}
        >
          {loading() ? "Loading…" : "Reload"}
        </Button>
      </div>

      <Switch>
        <Match when={pageState() === "loading" && !data()}>
          <StateCard kind="loading" title="Loading sync conflicts" />
        </Match>
        <Match when={pageState() === "hosted"}>
          <StateCard kind="locked" title="Sync conflicts are unavailable">
            Conflict recovery is available only on a local gateway.
          </StateCard>
        </Match>
        <Match when={pageState() === "unreachable"}>
          <StateCard
            kind="error"
            title="Sync conflicts could not be reached"
            action={
              <Button size="sm" variant="outline" onClick={reloadConflicts}>
                Retry
              </Button>
            }
          >
            {errorMessage(loadError())}
          </StateCard>
        </Match>
        <Match when={pageState() === "error"}>
          <StateCard
            kind="error"
            title="Sync conflicts could not be loaded"
            action={
              <Button size="sm" variant="outline" onClick={reloadConflicts}>
                Retry
              </Button>
            }
          >
            {errorMessage(loadError())}
          </StateCard>
        </Match>
        <Match when={pageState() === "ready"}>
          <Show when={data()?.complete === false}>
            <p
              class="mb-4 rounded-md border border-line bg-bg px-3 py-2 text-sm text-muted"
              data-testid="conflicts-truncated"
            >
              Showing the newest 100 sync conflicts. Older conflicts are not
              included.
            </p>
          </Show>
          <Show when={receipt()}>
            {(current) => (
              <div
                class="mb-4 rounded-md border border-line bg-bg p-3 text-sm"
                role="status"
                data-testid="conflict-recovery-receipt"
              >
                Local version restored as {versionSummary(current())}:{" "}
                <strong>{current().title}</strong>
              </div>
            )}
          </Show>
          <Show when={reloadRequired() && !confirmation()}>
            <div class="mb-4 flex flex-wrap items-center gap-3 rounded-md border border-line bg-bg px-3 py-2 text-sm">
              <span>
                {actionError()?.message ??
                  "The conflict list may have changed; reload to continue."}
              </span>
              <Button
                size="sm"
                variant="outline"
                data-testid="conflicts-reload-after-action"
                onClick={reloadConflicts}
              >
                Reload conflicts
              </Button>
            </div>
          </Show>
          <Show
            when={(data()?.conflicts.length ?? 0) > 0}
            fallback={
              <StateCard kind="empty" title="No sync conflicts">
                Conflicts created by local sync will appear here.
              </StateCard>
            }
          >
            <div class="space-y-4" data-testid="conflict-list">
              <For each={data()?.conflicts ?? []}>
                {(conflict) => (
                  <article
                    class="rounded-lg border border-line bg-surface p-4"
                    data-testid="conflict-card"
                    data-conflict-id={conflict.id}
                  >
                    <div class="flex flex-wrap items-start justify-between gap-3">
                      <div class="min-w-0">
                        <h2 class="font-semibold">
                          {conflict.local?.title ??
                            conflict.current?.title ??
                            `Conflict in ${conflict.table}`}
                        </h2>
                        <p class="mt-1 break-all text-xs text-muted">
                          {conflict.table} · {conflict.row_id} ·{" "}
                          {new Date(conflict.detected_at).toLocaleString()}
                        </p>
                      </div>
                      <span class="rounded-full border border-line px-2 py-1 text-[11px] text-muted">
                        {conflict.recoverable
                          ? "Recoverable"
                          : "Needs attention"}
                      </span>
                    </div>

                    <Show when={conflict.recoverable}>
                      <div class="mt-4 grid gap-3 md:grid-cols-2">
                        <section class="min-w-0 rounded-md border border-line bg-bg p-3">
                          <h3 class="text-sm font-semibold">
                            Your discarded version
                          </h3>
                          <Show when={conflict.local}>
                            {(local) => (
                              <>
                                <p class="mt-1 text-xs text-muted">
                                  {local().category}
                                </p>
                                <pre class="mt-2 whitespace-pre-wrap break-words font-sans text-sm">
                                  {local().content}
                                </pre>
                              </>
                            )}
                          </Show>
                        </section>
                        <section class="min-w-0 rounded-md border border-line bg-bg p-3">
                          <h3 class="text-sm font-semibold">Current version</h3>
                          <Show when={conflict.current}>
                            {(current) => (
                              <>
                                <p class="mt-1 break-all text-xs text-muted">
                                  {versionSummary(current())}
                                </p>
                                <strong class="mt-2 block break-words text-sm">
                                  {current().title}
                                </strong>
                                <pre class="mt-2 whitespace-pre-wrap break-words font-sans text-sm">
                                  {current().content}
                                </pre>
                              </>
                            )}
                          </Show>
                        </section>
                      </div>
                    </Show>

                    <Show when={!conflict.recoverable}>
                      <p class="mt-3 text-sm text-muted">
                        {reasonMessage(conflict)}
                      </p>
                    </Show>
                    <Show
                      when={
                        !confirmation() && actionError()?.id === conflict.id
                      }
                    >
                      <p class="mt-3 text-sm text-danger" role="alert">
                        {actionError()?.message}
                      </p>
                    </Show>
                    <Show
                      when={!confirmation() && resolvedIds().has(conflict.id)}
                    >
                      <p
                        class="mt-3 text-sm text-muted"
                        role="status"
                        data-testid="conflict-already-resolved"
                      >
                        Already resolved. Reload the list for the latest state.
                      </p>
                    </Show>
                    <div class="mt-4 flex flex-wrap gap-2">
                      <Show when={conflict.recoverable}>
                        <Button
                          size="sm"
                          disabled={
                            acting() ||
                            resolvedIds().has(conflict.id) ||
                            reloadRequired()
                          }
                          data-testid="conflict-keep-local"
                          onClick={() => requestAction(conflict, "keep")}
                        >
                          Keep mine
                        </Button>
                      </Show>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={
                          acting() ||
                          resolvedIds().has(conflict.id) ||
                          reloadRequired()
                        }
                        data-testid="conflict-discard"
                        onClick={() => requestAction(conflict, "discard")}
                      >
                        Discard mine
                      </Button>
                    </div>
                  </article>
                )}
              </For>
            </div>
          </Show>
        </Match>
      </Switch>

      <Dialog open={confirmation() !== null} onOpenChange={closeConfirmation}>
        <DialogContent data-testid="conflict-action-confirmation">
          <DialogHeader>
            <DialogTitle>
              {confirmation()?.action === "keep"
                ? "Keep your discarded version?"
                : "Discard your local snapshot?"}
            </DialogTitle>
            <DialogDescription>
              {confirmation()?.action === "keep"
                ? "This creates a new current knowledge version from the saved local snapshot. The current title may remain unchanged if it conflicts with another entry."
                : "This permanently removes the saved local snapshot for this conflict."}
            </DialogDescription>
          </DialogHeader>
          <Show when={dialogActionError()}>
            {(error) => (
              <p
                class="text-sm text-danger"
                role="alert"
                tabIndex={-1}
                data-testid="conflict-action-error"
                ref={(element) => queueMicrotask(() => element.focus())}
              >
                {error().message}
              </p>
            )}
          </Show>
          <Show when={reloadRequired() && dialogActionError()}>
            <Button
              size="sm"
              variant="outline"
              data-testid="conflicts-reload-after-action"
              onClick={reloadAfterDialogError}
            >
              Reload conflicts
            </Button>
          </Show>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={acting()}
              onClick={() => setConfirmation(null)}
            >
              Cancel
            </Button>
            <Button
              disabled={
                acting() || (reloadRequired() && dialogActionError() !== null)
              }
              variant={
                confirmation()?.action === "discard" ? "destructive" : "default"
              }
              onClick={() => void confirmAction()}
            >
              {acting()
                ? "Working…"
                : confirmation()?.action === "keep"
                  ? "Keep mine"
                  : "Discard"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
};
