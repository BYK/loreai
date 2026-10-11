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
import { A, useLocation } from "@solidjs/router";
import { createVirtualizer } from "@tanstack/solid-virtual";

import { parseActivityQuery } from "@loreai/core/activity-query";
import { useWorkspace } from "~/routes/workspace";
import { ACTIVITY_KIND_UI } from "~/lib/activity-kinds";
import { formatActivityTime } from "~/lib/format";
import { withWorkspaceQuery } from "~/lib/href";
import {
  activityUnreadChip,
  activityItemKey,
  clientFilter,
  unreadCount,
} from "~/state/activity-filter";
import { Avatar } from "~/components/lore/Avatar";

const PAGE_SIZE = 50;
const PAGE_BUDGET = 5;

export const ActivityListBody: Component<{
  query: string;
  onCountChange?: (count: number) => void;
  onVirtualizedScrollRestore?: (
    restore: (scrollTop: number, index: number | null) => void,
  ) => void;
}> = (props) => {
  const ws = useWorkspace();
  const items = ws.activityList.items;
  const setItems = ws.activityList.setItems;
  const selectedKeys = ws.activityList.selectedKeys;
  const setSelectedKeys = ws.activityList.setSelectedKeys;
  const [nextPage, setNextPage] = createSignal<{
    query: string;
    cursor: string;
  } | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [scrollTick, setScrollTick] = createSignal(0);
  let scroller: HTMLDivElement | undefined;
  let generation = 0;
  let pageBudget = PAGE_BUDGET;
  let requestActive = false;

  const parsed = createMemo(() => parseActivityQuery(props.query));
  const location = useLocation();
  const errors = () => parsed().errors;
  const hasClientFilters = () =>
    parsed().client.in.length > 0 ||
    parsed().client.folders.length > 0 ||
    parsed().client.is.length > 0;
  const visibleItems = createMemo(() =>
    items().filter((item) =>
      clientFilter(item, parsed().client, ws.state.activityLocal.snapshot()),
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
  props.onVirtualizedScrollRestore?.((scrollTop, index) => {
    if (index !== null) {
      virtualizer.scrollToIndex(index, { align: "start" });
    }
    virtualizer.scrollToOffset(scrollTop);
  });
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
    setNextPage(
      page.next_cursor ? { query: q, cursor: page.next_cursor } : null,
    );
  };

  const loadFirst = async (q: string) => {
    generation += 1;
    const currentGeneration = generation;
    setItems([]);
    setNextPage(null);
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
    const currentGeneration = generation;
    const page = nextPage();
    if (
      !page ||
      page.query !== props.query ||
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
      await fetchPage(page.query, page.cursor, currentGeneration);
    } catch (cause) {
      if (currentGeneration === generation) {
        setError(
          cause instanceof Error ? cause.message : "Activity unavailable",
        );
      }
    } finally {
      requestActive = false;
      if (currentGeneration === generation) {
        setLoading(false);
        setScrollTick((tick) => tick + 1);
      }
    }
  };

  createEffect(
    on(
      () => props.query,
      (query) => {
        setSelectedKeys([]);
        void loadFirst(query);
      },
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
                class="rounded-sm bg-pastel-rose px-2 py-1 text-xs text-danger"
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
                  <Show when={item()} keyed>
                    {(row) => {
                      const registry = ACTIVITY_KIND_UI[row.kind];
                      const key = activityItemKey(row);
                      const local = () => ws.state.activityLocal.snapshot();
                      const unread = () => unreadCount(row, local());
                      const chip = () => activityUnreadChip(row, local());
                      const href = () =>
                        withWorkspaceQuery(registry.href(row), props.query);
                      const current = () =>
                        registry.isCurrent(row, location.pathname);
                      const participants = row.participants.slice(0, 3);
                      const rest =
                        row.participants.length - participants.length;
                      const checked = () => selectedKeys().includes(key);
                      return (
                        <div
                          data-list-key={key}
                          data-testid="activity-item"
                          data-activity-kind={row.kind}
                          data-index={virtualItem.index}
                          ref={(element) => virtualizer.measureElement(element)}
                          class={`group absolute left-0 top-0 flex min-h-[68px] w-full items-start gap-2 border-b border-hairline px-3 py-2 ${
                            current() ? "bg-selected text-selected-text" : ""
                          } ${unread() > 0 && !current() ? "bg-unread-soft" : ""}`}
                          style={{
                            transform: `translateY(${virtualItem.start}px)`,
                          }}
                        >
                          <input
                            type="checkbox"
                            aria-label={`Select ${row.title}`}
                            checked={checked()}
                            class="mt-1 accent-accent"
                            onClick={(event) => event.stopPropagation()}
                            onChange={(event) =>
                              setSelectedKeys((keys) =>
                                event.currentTarget.checked
                                  ? [...new Set([...keys, key])]
                                  : keys.filter((selected) => selected !== key),
                              )
                            }
                          />
                          <A
                            href={href()}
                            end
                            aria-current={current() ? "page" : undefined}
                            class="flex min-w-0 flex-1 items-center gap-2 text-left no-underline"
                            onClick={() => {
                              ws.activityList.setCurrentKey(key);
                              if (registry.readMode === "item") {
                                queueMicrotask(() =>
                                  ws.state.activityLocal.markRead(
                                    key,
                                    row.total,
                                  ),
                                );
                              }
                            }}
                          >
                            <span class="flex flex-none items-center -space-x-1">
                              <For each={participants}>
                                {(participant) => (
                                  <span title={participant.label}>
                                    <Avatar
                                      label={participant.label.slice(0, 1)}
                                      kind={
                                        participant.kind === "agent"
                                          ? "agent"
                                          : "person"
                                      }
                                      size="sm"
                                    />
                                  </span>
                                )}
                              </For>
                              <Show when={rest > 0}>
                                <span class="inline-flex size-6 items-center justify-center rounded-md bg-soft text-[10px] text-muted">
                                  +{rest}
                                </span>
                              </Show>
                            </span>
                            <span class="min-w-0 flex-1">
                              <span class="flex min-w-0 items-center">
                                <span
                                  class={`truncate text-sm ${
                                    unread() > 0
                                      ? "font-semibold"
                                      : "font-medium"
                                  } ${current() ? "text-selected-text" : "text-text"}`}
                                  data-testid="activity-title"
                                >
                                  {row.title}
                                </span>
                                <span
                                  class={`truncate text-sm ${
                                    current()
                                      ? "text-selected-text/70"
                                      : "text-muted"
                                  }`}
                                >
                                  {row.snippet ? ` – ${row.snippet}` : ""}
                                </span>
                                <Show when={row.match === "fuzzy"}>
                                  <span
                                    class="ml-1 shrink-0 text-[10px] text-muted"
                                    aria-label="Approximate match"
                                  >
                                    ~
                                  </span>
                                </Show>
                              </span>
                              <span
                                class={`mt-1 flex min-w-0 items-center gap-1 text-[10px] ${
                                  current()
                                    ? "text-selected-text/70"
                                    : "text-muted"
                                }`}
                              >
                                <span class="min-w-0 truncate">
                                  {row.project_name} · {registry.label}
                                </span>
                                <span class="ml-auto flex flex-none items-center gap-2">
                                  <time
                                    dateTime={new Date(
                                      row.last_activity_at,
                                    ).toISOString()}
                                  >
                                    {formatActivityTime(row.last_activity_at)}
                                  </time>
                                  <span
                                    class={`rounded px-1.5 py-0.5 ${
                                      current()
                                        ? "bg-selected text-selected-text"
                                        : chip().unread
                                          ? "bg-accent-soft text-accent-soft-text"
                                          : "bg-soft text-muted"
                                    }`}
                                    data-testid="activity-unread-chip"
                                  >
                                    {chip().label}
                                  </span>
                                </span>
                              </span>
                            </span>
                          </A>
                        </div>
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
