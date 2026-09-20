import type { Component } from "solid-js";
import { For, Match, Show, Switch, createEffect, createSignal } from "solid-js";
import { useNavigate } from "@solidjs/router";
import {
  createColumnHelper,
  createTable,
  flexRender,
  tableFeatures,
} from "@tanstack/solid-table";

import type { KnowledgeEntry, KnowledgeQuery } from "~/contracts";
import {
  DEFAULT_KNOWLEDGE_QUERY,
  KNOWLEDGE_CATEGORIES,
  KNOWLEDGE_SCOPES,
} from "~/contracts";
import { knowledgeListHref, knowledgeHref } from "~/routes/Browse";
import { formatConfidence, formatWhen, previewOf } from "~/lib/format";
import { StaleBadge } from "./StaleBadge";
import { StateCard } from "./StateCard";
import { errorStateFor } from "./ErrorState";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { TextField, TextFieldInput } from "../ui/text-field";

export const prevCursorOf = new Map<string, string | null>();
const features = tableFeatures({});
const helper = createColumnHelper<typeof features, KnowledgeEntry>();
const SORT_LABELS: Record<KnowledgeQuery["sort"], string> = {
  updated_desc: "Updated",
  created_desc: "Created",
  confidence_desc: "Confidence",
  title_asc: "Title A–Z",
};

export const KnowledgeTable: Component<{
  projectId: string;
  query: KnowledgeQuery;
  selectedId?: string;
  page: {
    loader: {
      data: () =>
        | { items: KnowledgeEntry[]; next_cursor: string | null }
        | undefined;
      loading: () => boolean;
      error: () => unknown;
      reload: () => void;
      stale: () => boolean;
    };
    status: () => { stale: boolean; partial: boolean };
  };
}> = (props) => {
  const navigate = useNavigate();
  const [active, setActive] = createSignal(0);
  let tableRef: HTMLTableElement | undefined;
  const page = () => props.page.loader.data();
  const rows = () => page()?.items ?? [];
  createEffect(() => {
    const next = page()?.next_cursor;
    if (next !== undefined) prevCursorOf.set(next ?? "", props.query.cursor);
  });
  createEffect(() => {
    active();
    const table = tableRef;
    if (!table || !table.contains(document.activeElement)) return;
    table.querySelector<HTMLTableRowElement>("tr[data-active]")?.focus();
  });
  const go = (query: KnowledgeQuery) =>
    navigate(knowledgeListHref(props.projectId, query));
  const clear = () => go({ ...DEFAULT_KNOWLEDGE_QUERY });
  const columns = helper.columns([
    helper.accessor("title", { header: "title" }),
    helper.accessor("category", { header: "category" }),
    helper.display({ id: "scope", header: "scope" }),
    helper.accessor("confidence", { header: "confidence" }),
    helper.display({ id: "updated", header: "updated" }),
  ]);
  const table = createTable({
    features,
    columns,
    get data() {
      return rows();
    },
    getRowId: (row) => row.id,
  });
  const sortOf = (id: string): KnowledgeQuery["sort"] =>
    id === "title"
      ? "title_asc"
      : id === "confidence"
        ? "confidence_desc"
        : id === "updated"
          ? "updated_desc"
          : props.query.sort;
  const ariaSort = (id: string) =>
    props.query.sort === sortOf(id)
      ? id === "title"
        ? "ascending"
        : "descending"
      : "none";
  const filter = (
    name: "category" | "scope",
    options: readonly string[],
    placeholder: string,
  ) => (
    <Select
      value={props.query[name] ?? null}
      onChange={(value) =>
        go({ ...props.query, [name]: value as never, cursor: null })
      }
      options={[...options]}
      placeholder={placeholder}
      itemComponent={(item) => (
        <SelectItem item={item.item}>{item.item.rawValue}</SelectItem>
      )}
    >
      <SelectTrigger aria-label={name} class="h-9 min-w-32 text-xs">
        <SelectValue<string>>
          {(state) => state.selectedOption() ?? placeholder}
        </SelectValue>
      </SelectTrigger>
      <SelectContent />
    </Select>
  );
  return (
    <div class="p-4 sm:p-6">
      <div class="mb-4 flex flex-wrap items-end gap-2" role="search">
        <form
          class="flex min-w-[220px] flex-1 gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const raw = new FormData(event.currentTarget).get("q");
            const q = typeof raw === "string" ? raw : "";
            go({ ...props.query, q: q.trim().slice(0, 500), cursor: null });
          }}
        >
          <TextField class="min-w-0 flex-1">
            <TextFieldInput
              name="q"
              value={props.query.q}
              aria-label="Knowledge search"
              placeholder="Filter knowledge"
            />
          </TextField>
          <Button type="submit" size="sm">
            Search
          </Button>
        </form>
        {filter("category", KNOWLEDGE_CATEGORIES, "All categories")}
        {filter("scope", KNOWLEDGE_SCOPES, "Any scope")}
        <Select
          value={props.query.sort}
          onChange={(value) =>
            go({
              ...props.query,
              sort: value as KnowledgeQuery["sort"],
              cursor: null,
            })
          }
          options={[
            "updated_desc",
            "created_desc",
            "confidence_desc",
            "title_asc",
          ]}
          itemComponent={(item) => (
            <SelectItem item={item.item}>
              {SORT_LABELS[item.item.rawValue]}
            </SelectItem>
          )}
        >
          <SelectTrigger aria-label="Sort" class="h-9 min-w-32 text-xs">
            <SelectValue<string>>
              {(state) =>
                SORT_LABELS[state.selectedOption() as KnowledgeQuery["sort"]]
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent />
        </Select>
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
        <Match when={props.page.loader.error() && !page()}>
          {errorStateFor(
            props.page.loader.error(),
            "Knowledge",
            props.page.loader.reload,
            {
              firstPage: clear,
            },
          )}
        </Match>
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
                <Button variant="link" size="sm" onClick={clear}>
                  Clear filters
                </Button>
              ) : undefined
            }
          />
        </Match>
        <Match when={page()}>
          <table
            ref={(element) => {
              tableRef = element;
            }}
            class="w-full table-fixed text-left text-xs"
          >
            <caption class="mb-2 text-left text-[11px] text-muted">
              Sorted on the server · page of up to 50
            </caption>
            <thead>
              <For each={table.getHeaderGroups()}>
                {(group) => (
                  <tr class="border-b border-line">
                    <For each={group.headers}>
                      {(header) => {
                        const id = header.column.id;
                        const sortable = [
                          "title",
                          "confidence",
                          "updated",
                        ].includes(id);
                        return (
                          <th
                            class="px-2 py-2 font-semibold"
                            aria-sort={sortable ? ariaSort(id) : undefined}
                          >
                            {sortable ? (
                              <button
                                type="button"
                                onClick={() =>
                                  go({
                                    ...props.query,
                                    sort: sortOf(id),
                                    cursor: null,
                                  })
                                }
                              >
                                {flexRender(
                                  header.column.columnDef.header,
                                  header.getContext(),
                                )}
                              </button>
                            ) : (
                              flexRender(
                                header.column.columnDef.header,
                                header.getContext(),
                              )
                            )}
                          </th>
                        );
                      }}
                    </For>
                  </tr>
                )}
              </For>
            </thead>
            <tbody>
              <For each={table.getRowModel().rows}>
                {(row, index) => (
                  <tr
                    data-testid="knowledge-row"
                    data-knowledge-id={row.original.id}
                    data-active={active() === index() ? "" : undefined}
                    tabIndex={active() === index() ? 0 : -1}
                    aria-selected={
                      row.original.id === props.selectedId ? "true" : undefined
                    }
                    class="h-11 cursor-pointer border-b border-line hover:bg-soft"
                    onClick={() =>
                      navigate(
                        knowledgeHref(
                          props.projectId,
                          row.original.id,
                          props.query,
                        ),
                      )
                    }
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        navigate(
                          knowledgeHref(
                            props.projectId,
                            row.original.id,
                            props.query,
                          ),
                        );
                      } else if (event.key === "ArrowDown") {
                        event.preventDefault();
                        setActive(Math.min(rows().length - 1, index() + 1));
                      } else if (event.key === "ArrowUp") {
                        event.preventDefault();
                        setActive(Math.max(0, index() - 1));
                      }
                    }}
                  >
                    <For each={row.getAllCells()}>
                      {(cell) => (
                        <td class="truncate px-2 py-2">
                          {cell.column.id === "title" ? (
                            <>
                              <span class="font-semibold">
                                {row.original.title}
                              </span>
                              <div class="font-normal text-muted">
                                {previewOf(row.original.content)}
                              </div>
                            </>
                          ) : cell.column.id === "category" ? (
                            <Badge>{row.original.category}</Badge>
                          ) : cell.column.id === "scope" ? (
                            row.original.cross_project ? (
                              "global"
                            ) : (
                              "project"
                            )
                          ) : cell.column.id === "confidence" ? (
                            <>
                              {formatConfidence(row.original.confidence)}{" "}
                              <span class="text-muted">recorded</span>
                            </>
                          ) : (
                            formatWhen(
                              row.original.updated_at ??
                                row.original.created_at,
                            )
                          )}
                        </td>
                      )}
                    </For>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </Match>
      </Switch>
      <div class="mt-4 flex items-center justify-between text-xs">
        <Show when={props.query.cursor}>
          <Button
            variant="link"
            size="sm"
            onClick={() => go({ ...props.query, cursor: null })}
          >
            First page
          </Button>
        </Show>
        <Show when={props.query.cursor && prevCursorOf.has(props.query.cursor)}>
          <Button
            variant="link"
            size="sm"
            onClick={() =>
              go({
                ...props.query,
                cursor: prevCursorOf.get(props.query.cursor!) ?? null,
              })
            }
          >
            Previous page
          </Button>
        </Show>
        <Button
          variant="link"
          size="sm"
          disabled={!page()?.next_cursor}
          onClick={() => {
            const next = page()?.next_cursor;
            if (next) go({ ...props.query, cursor: next });
          }}
        >
          Next page
        </Button>
      </div>
      {/* Virtualization is intentionally absent because each page contains at most 50 rows. */}
    </div>
  );
};
