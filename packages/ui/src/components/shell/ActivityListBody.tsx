import type { Component } from "solid-js";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  Show,
} from "solid-js";
import { A } from "@solidjs/router";
import { createVirtualizer } from "@tanstack/solid-virtual";

import { parseActivityQuery } from "@loreai/core/activity-query";
import type { ActivityItem } from "~/contracts";
import { useWorkspace } from "~/routes/workspace";
import { ACTIVITY_KIND_UI } from "~/lib/activity-kinds";
import { withWorkspaceQuery } from "~/lib/href";
import {
  activityItemKey,
  clientFilter,
  DEFAULT_ACTIVITY_LOCAL_STATE,
} from "~/state/activity-filter";

const PAGE_SIZE = 50;
const PAGE_BUDGET = 5;

export const ActivityListBody: Component<{
  query: string;
  onCountChange?: (count: number) => void;
  onVirtualizedScrollRestore?: (restore: (scrollTop: number) => void) => void;
}> = (props) => {
  const ws = useWorkspace();
  const [items, setItems] = createSignal<ActivityItem[]>([]);
  const [nextCursor, setNextCursor] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [scrollTick, setScrollTick] = createSignal(0);
  let scroller: HTMLDivElement | undefined;
  let generation = 0;
  let pageBudget = PAGE_BUDGET;
  let requestActive = false;

  const parsed = createMemo(() => parseActivityQuery(props.query));
  const errors = () => parsed().errors;
  const hasClientFilters = () =>
    parsed().client.in.length > 0 ||
    parsed().client.folders.length > 0 ||
    parsed().client.is.length > 0;
  const visibleItems = createMemo(() =>
    items().filter((item) =>
      clientFilter(item, parsed().client, DEFAULT_ACTIVITY_LOCAL_STATE),
    ),
  );
  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    get count() {
      return visibleItems().length;
    },
    getScrollElement: () => scroller ?? null,
    estimateSize: () => 76,
    getItemKey: (index) => {
      const item = visibleItems()[index];
      return item ? activityItemKey(item) : `activity-${index}`;
    },
    overscan: 6,
  });
  props.onVirtualizedScrollRestore?.((scrollTop) =>
    virtualizer.scrollToOffset(scrollTop),
  );
  const virtualItems = createMemo(() => virtualizer.getVirtualItems());

  const fetchPage = async (
    q: string,
    cursor: string | null,
    currentGeneration: number,
  ) => {
    const page = await ws.tracked(() =>
      ws.client.fetchActivity({ q, cursor, limit: PAGE_SIZE }),
    );
    if (currentGeneration !== generation) return;
    setItems((current) => (cursor ? [...current, ...page.items] : page.items));
    setNextCursor(page.next_cursor);
    props.onCountChange?.(page.items.length);
  };

  const loadFirst = async (q: string) => {
    generation += 1;
    const currentGeneration = generation;
    setItems([]);
    setNextCursor(null);
    setError(null);
    pageBudget = PAGE_BUDGET;
    if (errors().length > 0) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      await fetchPage(q, null, currentGeneration);
    } catch (cause) {
      if (currentGeneration === generation) {
        setError(
          cause instanceof Error ? cause.message : "Activity unavailable",
        );
      }
    } finally {
      if (currentGeneration === generation) setLoading(false);
    }
  };

  const loadMore = async (filteredFill = false) => {
    const cursor = nextCursor();
    if (
      !cursor ||
      requestActive ||
      (filteredFill && pageBudget <= 0) ||
      errors().length > 0
    ) {
      return;
    }
    requestActive = true;
    if (filteredFill) pageBudget -= 1;
    setLoading(true);
    try {
      await fetchPage(props.query, cursor, generation);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Activity unavailable");
    } finally {
      requestActive = false;
      setLoading(false);
      setScrollTick((tick) => tick + 1);
    }
  };

  createEffect(
    on(
      () => props.query,
      (query) => void loadFirst(query),
      { defer: false },
    ),
  );
  createEffect(() => {
    scrollTick();
    const count = visibleItems().length;
    const last = virtualItems().at(-1);
    if (hasClientFilters() && count < PAGE_SIZE) {
      void loadMore(true);
    } else if (last && last.index >= count - 5) {
      void loadMore();
    }
  });
  createEffect(() => props.onCountChange?.(visibleItems().length));
  onCleanup(() => {
    generation += 1;
  });

  return (
    <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
      <Show when={errors().length > 0}>
        <div class="flex flex-wrap gap-1 px-3 pb-2" role="alert">
          <For each={errors()}>
            {(error) => (
              <span
                class="rounded-sm bg-unread-soft px-2 py-1 text-xs text-unread"
                data-testid="activity-query-error"
                data-offset={error.start}
              >
                {error.token}: {error.message}
              </span>
            )}
          </For>
        </div>
      </Show>
      <div
        ref={(element) => {
          scroller = element;
        }}
        class="min-h-0 flex-1 overflow-y-auto px-2 py-1"
        data-testid="activity-list-body"
        data-list-scroller
        style={{ "overflow-anchor": "none" }}
        onScroll={() => {
          pageBudget = PAGE_BUDGET;
          setScrollTick((tick) => tick + 1);
        }}
      >
        <Show when={error()}>
          {(message) => (
            <div role="alert" class="px-3 py-2 text-xs text-danger">
              {message()}
            </div>
          )}
        </Show>
        <Show
          when={visibleItems().length > 0}
          fallback={
            <div class="px-3 py-3 text-xs text-muted">
              <Show when={loading()} fallback="No activity">
                Loading activity…
              </Show>
            </div>
          }
        >
          <div
            class="relative w-full"
            style={{ height: `${virtualizer.getTotalSize()}px` }}
          >
            <For each={virtualItems()}>
              {(virtualItem) => {
                const item = () => visibleItems()[virtualItem.index];
                return (
                  <Show when={item()}>
                    {(activity) => {
                      const row = activity();
                      const registry = ACTIVITY_KIND_UI[row.kind];
                      return (
                        <A
                          href={withWorkspaceQuery(
                            registry.href(row),
                            props.query,
                          )}
                          end
                          activeClass="bg-selected text-selected-text"
                          data-list-key={`${row.kind}:${row.project_id}:${row.id}`}
                          data-testid="activity-item"
                          data-activity-kind={row.kind}
                          ref={(element) =>
                            virtualizer.measureElement(
                              element as unknown as HTMLDivElement,
                            )
                          }
                          data-index={virtualItem.index}
                          class="group absolute left-0 top-0 flex min-h-[68px] w-full flex-col gap-0.5 border-b border-hairline px-3 py-2 text-left no-underline hover:bg-soft"
                          style={{
                            transform: `translateY(${virtualItem.start}px)`,
                          }}
                        >
                          <span class="flex min-w-0 items-center gap-2">
                            <span class="min-w-0 flex-1 truncate text-sm font-medium text-text">
                              {row.title}
                            </span>
                            <Show when={row.match === "fuzzy"}>
                              <span
                                class="shrink-0 text-[10px] text-muted"
                                aria-label="Approximate match"
                              >
                                ~
                              </span>
                            </Show>
                          </span>
                          <span class="truncate text-xs text-muted">
                            {row.snippet}
                          </span>
                          <span class="flex items-center gap-2 text-[10px] text-muted">
                            <span>{row.project_name}</span>
                            <span>·</span>
                            <span>{registry.label}</span>
                            <span>·</span>
                            <time
                              dateTime={new Date(
                                row.last_activity_at,
                              ).toISOString()}
                            >
                              {new Intl.RelativeTimeFormat(undefined, {
                                numeric: "auto",
                              }).format(
                                Math.round(
                                  (row.last_activity_at - Date.now()) / 60_000,
                                ),
                                "minute",
                              )}
                            </time>
                          </span>
                        </A>
                      );
                    }}
                  </Show>
                );
              }}
            </For>
          </div>
        </Show>
        <Show when={loading() && visibleItems().length > 0}>
          <div class="px-3 py-2 text-xs text-muted" role="status">
            Loading…
          </div>
        </Show>
      </div>
    </div>
  );
};
