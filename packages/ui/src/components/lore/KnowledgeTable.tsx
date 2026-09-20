import type { Component } from "solid-js";
import { For, Match, Show, Switch, createEffect, createSignal } from "solid-js";
import { useNavigate } from "@solidjs/router";

import type { KnowledgeEntry, KnowledgeQuery } from "~/contracts";
import {
  DEFAULT_KNOWLEDGE_QUERY,
  KNOWLEDGE_CATEGORIES,
  KNOWLEDGE_SCOPES,
} from "~/contracts";
import { knowledgeListHref, knowledgeHref } from "~/routes/Browse";
import { formatConfidence, formatWhen, previewOf } from "~/lib/format";
import { isApiError } from "~/lib/api";
import { StaleBadge } from "./StaleBadge";
import { StateCard } from "./StateCard";
import { Badge } from "../ui/badge";

export const prevCursorOf = new Map<string, string | null>();

export const KnowledgeTable: Component<{
  projectId: string;
  query: KnowledgeQuery;
  page: {
    loader: {
      data: () =>
        | { items: KnowledgeEntry[]; next_cursor: string | null }
        | undefined;
      loading: () => boolean;
      error: () => unknown;
      reload: () => void;
      stale: () => boolean;
      partial: () => boolean;
    };
    status: () => { stale: boolean; partial: boolean };
  };
}> = (props) => {
  const navigate = useNavigate();
  const [active, setActive] = createSignal(0);
  const page = () => props.page.loader.data();
  createEffect(() => {
    const next = page()?.next_cursor;
    if (next !== undefined) prevCursorOf.set(next ?? "", props.query.cursor);
  });
  const go = (query: KnowledgeQuery) =>
    navigate(knowledgeListHref(props.projectId, query));
  const error = () => props.page.loader.error();
  const clear = () => go({ ...DEFAULT_KNOWLEDGE_QUERY });
  const state = () => {
    const reason = error();
    if (!reason) return null;
    if (isApiError(reason) && reason.kind === "not_found")
      return (
        <StateCard kind="error" title="Project not found or inaccessible" />
      );
    if (isApiError(reason) && reason.kind === "unauthorized")
      return (
        <StateCard kind="locked" title="Knowledge hidden by the gateway" />
      );
    if (isApiError(reason) && reason.status === 400)
      return (
        <StateCard
          kind="error"
          title="This page link is no longer valid"
          action={
            <button class="text-xs text-accent underline" onClick={clear}>
              First page
            </button>
          }
        />
      );
    if (isApiError(reason) && reason.kind === "unreachable")
      return (
        <StateCard kind="error" title="Gateway unreachable">
          Start the gateway with <code>lore start</code>.
        </StateCard>
      );
    return (
      <StateCard
        kind="error"
        title="Knowledge unavailable"
        action={
          <button
            class="text-xs text-accent underline"
            onClick={props.page.loader.reload}
          >
            Retry
          </button>
        }
      />
    );
  };
  return (
    <div class="p-4 sm:p-6">
      <div class="mb-4 flex flex-wrap items-end gap-2" role="search">
        <form
          class="flex min-w-[220px] flex-1 gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const raw = new FormData(e.currentTarget).get("q");
            const q = typeof raw === "string" ? raw : "";
            go({ ...props.query, q: q.trim().slice(0, 500), cursor: null });
          }}
        >
          <input
            name="q"
            value={props.query.q}
            aria-label="Knowledge search"
            class="min-w-0 flex-1 rounded-md border border-line bg-bg px-3 py-2 text-sm"
            placeholder="Filter knowledge"
          />
          <button
            type="submit"
            class="rounded-md bg-inverse px-3 py-2 text-xs text-inverse-text"
          >
            Search
          </button>
        </form>
        <select
          aria-label="Category"
          value={props.query.category ?? ""}
          onChange={(e) =>
            go({
              ...props.query,
              category: (e.currentTarget.value ||
                null) as KnowledgeQuery["category"],
              cursor: null,
            })
          }
          class="rounded-md border border-line bg-bg px-2 py-2 text-xs"
        >
          <option value="">All categories</option>
          <For each={KNOWLEDGE_CATEGORIES}>
            {(c) => <option value={c}>{c}</option>}
          </For>
        </select>
        <select
          aria-label="Scope"
          value={props.query.scope ?? ""}
          onChange={(e) =>
            go({
              ...props.query,
              scope: (e.currentTarget.value || null) as KnowledgeQuery["scope"],
              cursor: null,
            })
          }
          class="rounded-md border border-line bg-bg px-2 py-2 text-xs"
        >
          <option value="">Any scope</option>
          <For each={KNOWLEDGE_SCOPES}>
            {(c) => <option value={c}>{c}</option>}
          </For>
        </select>
        <select
          aria-label="Sort"
          value={props.query.sort}
          onChange={(e) =>
            go({
              ...props.query,
              sort: e.currentTarget.value as KnowledgeQuery["sort"],
              cursor: null,
            })
          }
          class="rounded-md border border-line bg-bg px-2 py-2 text-xs"
        >
          <option value="updated_desc">Updated</option>
          <option value="created_desc">Created</option>
          <option value="confidence_desc">Confidence</option>
          <option value="title_asc">Title A–Z</option>
        </select>
      </div>
      <Show when={props.page.loader.stale()}>
        <StaleBadge
          status={{
            ...props.page.status(),
            loading: props.page.loader.loading(),
            error: props.page.loader.error(),
            source: null,
          }}
        />
      </Show>
      <Switch>
        <Match when={props.page.loader.loading() && !page()}>
          <StateCard kind="loading" title="Loading knowledge" />
        </Match>
        <Match when={error() && !page()}>{state()}</Match>
        <Match when={page()?.items.length === 0}>
          <StateCard
            kind="empty"
            title={
              props.query.q || props.query.category || props.query.scope
                ? "No knowledge matches these filters"
                : "No knowledge extracted yet"
            }
            action={
              props.query.q || props.query.category || props.query.scope ? (
                <button class="text-xs text-accent underline" onClick={clear}>
                  Clear filters
                </button>
              ) : undefined
            }
          />
        </Match>
        <Match when={page()}>
          {(loaded) => (
            <table class="w-full table-fixed text-left text-xs">
              <caption class="mb-2 text-left text-[11px] text-muted">
                Sorted on the server · page of up to 50
              </caption>
              <thead>
                <tr class="border-b border-line">
                  <th class="px-2 py-2 font-semibold">
                    <button
                      type="button"
                      aria-sort={
                        props.query.sort === "title_asc" ? "ascending" : "none"
                      }
                      onClick={() =>
                        go({ ...props.query, sort: "title_asc", cursor: null })
                      }
                    >
                      title
                    </button>
                  </th>
                  <th class="px-2 py-2 font-semibold">category</th>
                  <th class="px-2 py-2 font-semibold">scope</th>
                  <th class="px-2 py-2 font-semibold">
                    <button
                      type="button"
                      aria-sort={
                        props.query.sort === "confidence_desc"
                          ? "descending"
                          : "none"
                      }
                      onClick={() =>
                        go({
                          ...props.query,
                          sort: "confidence_desc",
                          cursor: null,
                        })
                      }
                    >
                      confidence
                    </button>
                  </th>
                  <th class="px-2 py-2 font-semibold">
                    <button
                      type="button"
                      aria-sort={
                        props.query.sort === "updated_desc"
                          ? "descending"
                          : "none"
                      }
                      onClick={() =>
                        go({
                          ...props.query,
                          sort: "updated_desc",
                          cursor: null,
                        })
                      }
                    >
                      updated
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                <For each={loaded().items}>
                  {(entry, index) => (
                    <tr
                      data-testid="knowledge-row"
                      data-knowledge-id={entry.id}
                      tabindex={active() === index() ? 0 : -1}
                      aria-selected={active() === index()}
                      class="h-11 cursor-pointer border-b border-line hover:bg-soft"
                      onClick={() =>
                        navigate(
                          knowledgeHref(props.projectId, entry.id, props.query),
                        )
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          navigate(
                            knowledgeHref(
                              props.projectId,
                              entry.id,
                              props.query,
                            ),
                          );
                        } else if (e.key === "ArrowDown") {
                          e.preventDefault();
                          setActive(
                            Math.min(loaded().items.length - 1, index() + 1),
                          );
                        } else if (e.key === "ArrowUp") {
                          e.preventDefault();
                          setActive(Math.max(0, index() - 1));
                        }
                      }}
                    >
                      <td class="truncate px-2 py-2 font-semibold">
                        {entry.title}
                        <div class="font-normal text-muted">
                          {previewOf(entry.content)}
                        </div>
                      </td>
                      <td class="px-2">
                        <Badge>{entry.category}</Badge>
                      </td>
                      <td class="px-2">
                        {entry.cross_project ? "global" : "project"}
                      </td>
                      <td class="px-2">
                        {formatConfidence(entry.confidence)}{" "}
                        <span class="text-muted">recorded</span>
                      </td>
                      <td class="px-2">
                        {formatWhen(entry.updated_at ?? entry.created_at)}
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          )}
        </Match>
      </Switch>
      <div class="mt-4 flex items-center justify-between text-xs">
        <Show when={props.query.cursor}>
          <button
            class="text-accent underline"
            onClick={() => go({ ...props.query, cursor: null })}
          >
            First page
          </button>
        </Show>
        <Show when={props.query.cursor && prevCursorOf.has(props.query.cursor)}>
          <button
            class="text-accent underline"
            onClick={() =>
              go({
                ...props.query,
                cursor: prevCursorOf.get(props.query.cursor!) ?? null,
              })
            }
          >
            Previous page
          </button>
        </Show>
        <button
          disabled={!page()?.next_cursor}
          class="text-accent underline disabled:opacity-40"
          onClick={() => {
            const next = page()?.next_cursor;
            if (next) go({ ...props.query, cursor: next });
          }}
        >
          Next page
        </button>
      </div>
    </div>
  );
};
