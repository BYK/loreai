/**
 * `/projects/:id/imports` — the conversation-import history for one project
 * (UI-08, #1823). Server-authoritative (no IndexedDB projection): the table
 * is small and only interesting while it's fresh. Keyset `?cursor=` paging
 * matches the sessions/entities pattern.
 */
import type { Component } from "solid-js";
import { createSignal, For, Match, Show, Switch } from "solid-js";
import { useNavigate } from "@solidjs/router";

import { formatWhen, pluralize } from "~/lib/format";
import { createLoader } from "~/lib/loader";
import { useWorkspace } from "~/routes/workspace";
import { importsHref } from "~/lib/href";
import { Button } from "~/components/ui/button";
import { errorStateFor } from "./ErrorState";
import { StateCard } from "./StateCard";

export const ImportHistoryPage: Component<{
  projectId: string;
  cursor: string | null;
}> = (props) => {
  const ws = useWorkspace();
  const navigate = useNavigate();
  // Keyset cursors are one-way — keep a stack for Previous.
  const [history, setHistory] = createSignal<string[]>([]);
  // createSignal used inside the loader source so history resets don't refetch.
  const page = createLoader(
    () => ({ projectId: props.projectId, cursor: props.cursor }),
    (source, signal) =>
      ws.tracked(() =>
        ws.client.listProjectImports(
          source.projectId,
          { page: source.cursor },
          signal,
        ),
      ),
  );

  const rows = () => page.data()?.imports;
  const nextCursor = () => page.data()?.next_cursor ?? null;

  const goNext = () => {
    const next = nextCursor();
    if (!next) return;
    setHistory((h) => [...h, props.cursor ?? ""]);
    navigate(importsHref(props.projectId, next));
  };
  const goPrev = () => {
    const stack = history();
    if (stack.length === 0) return;
    const prev = stack[stack.length - 1];
    setHistory(stack.slice(0, -1));
    navigate(importsHref(props.projectId, prev === "" ? null : prev));
  };

  return (
    <div class="p-4 sm:p-6" data-testid="import-history">
      <div class="mb-4 flex items-center gap-2">
        <h1 class="text-lg font-semibold">Import history</h1>
        <Show when={page.data()}>
          {(data) => (
            <span class="text-xs text-muted">
              {pluralize(data().total, "import")}
            </span>
          )}
        </Show>
      </div>
      <Switch>
        <Match when={page.loading() && !rows()}>
          <StateCard kind="loading" title="Loading imports" />
        </Match>
        <Match when={page.error() && !rows()}>
          {errorStateFor(page.error(), "Import history", page.reload, {
            firstPage: () => navigate(importsHref(props.projectId)),
          })}
        </Match>
        <Match when={rows()?.length === 0}>
          <StateCard kind="empty" title="No imports">
            No conversation imports recorded for this project.
          </StateCard>
        </Match>
        <Match when={rows()}>
          {(items) => (
            <>
              <table
                class="w-full text-left text-[13px]"
                data-testid="imports-table"
              >
                <thead>
                  <tr class="text-xs text-muted">
                    <th class="py-1 pr-3 font-medium">Agent</th>
                    <th class="py-1 pr-3 font-medium">Source</th>
                    <th class="py-1 pr-3 font-medium">Created</th>
                    <th class="py-1 pr-3 font-medium">Updated</th>
                    <th class="py-1 font-medium">Imported</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={items()}>
                    {(row) => (
                      <tr class="border-t border-line" data-testid="import-row">
                        <td class="py-2 pr-3">{row.agent_name}</td>
                        <td class="py-2 pr-3 font-mono text-xs">
                          {row.source_id}
                        </td>
                        <td class="py-2 pr-3">{row.entries_created}</td>
                        <td class="py-2 pr-3">{row.entries_updated}</td>
                        <td class="py-2 text-muted">
                          {formatWhen(row.imported_at)}
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
              <div class="mt-3 flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={history().length === 0}
                  onClick={goPrev}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!nextCursor()}
                  onClick={goNext}
                >
                  Next
                </Button>
              </div>
            </>
          )}
        </Match>
      </Switch>
    </div>
  );
};
