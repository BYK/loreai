import type { JSX } from "solid-js";
import { For, Match, Show, Switch, createEffect, createSignal } from "solid-js";
import { useNavigate } from "@solidjs/router";
import {
  createColumnHelper,
  createTable,
  flexRender,
  tableFeatures,
} from "@tanstack/solid-table";

import type {
  KnowledgeEntry,
  KnowledgeQuery,
  KnowledgeSortField,
  KnowledgeSortKey,
} from "~/contracts";
import {
  DEFAULT_KNOWLEDGE_QUERY,
  KNOWLEDGE_CATEGORIES,
  KNOWLEDGE_SCOPES,
} from "~/contracts";
import { knowledgeListHref, knowledgeHref } from "~/lib/href";
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

type KnowledgeTableRow = KnowledgeEntry & {
  project_name?: string | null;
};

export const prevCursorOf = new Map<string, string | null>();
const features = tableFeatures({});
const helper = createColumnHelper<typeof features, KnowledgeTableRow>();
const SORT_LABELS: Record<KnowledgeSortField, string> = {
  updated_at: "Updated",
  created_at: "Created",
  confidence: "Confidence",
  title: "Title",
};
const DEFAULT_SORT_DIRECTION: Record<
  KnowledgeSortField,
  KnowledgeSortKey["dir"]
> = {
  updated_at: "desc",
  created_at: "desc",
  confidence: "desc",
  title: "asc",
};

export type KnowledgeTableRoutes<Q extends KnowledgeQuery> = {
  list(query: Q): string;
  entry(knowledgeId: string, query: Q): string;
  defaultQuery: Q;
};

export type KnowledgeTableProps<Q extends KnowledgeQuery> = (
  | { projectId: string; routes?: never }
  | { routes: KnowledgeTableRoutes<Q>; projectId?: never }
) & {
  query: Q;
  selectedId?: string;
  page: {
    loader: {
      data: () =>
        | { items: KnowledgeTableRow[]; next_cursor: string | null }
        | undefined;
      loading: () => boolean;
      error: () => unknown;
      reload: () => void;
      stale: () => boolean;
    };
    status: () => { stale: boolean; partial: boolean };
  };
  showProject?: boolean;
  extraFilters?: JSX.Element;
  extraFiltersActive?: boolean;
};

export function KnowledgeTable<Q extends KnowledgeQuery>(
  props: KnowledgeTableProps<Q>,
) {
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
  const go = (query: Q) =>
    navigate(
      props.routes
        ? props.routes.list(query)
        : knowledgeListHref(props.projectId, query),
    );
  const entryHref = (id: string) =>
    props.routes
      ? props.routes.entry(id, props.query)
      : knowledgeHref(props.projectId, id, props.query);
  const clear = () =>
    go(
      props.routes ? props.routes.defaultQuery : (DEFAULT_KNOWLEDGE_QUERY as Q),
    );
  const filtersActive = () =>
    !!(
      props.query.q ||
      props.query.category ||
      props.query.scope ||
      props.extraFiltersActive
    );
  const columns = helper.columns([
    helper.accessor("title", { header: "title" }),
    helper.accessor("category", { header: "category" }),
    helper.display({ id: "scope", header: "scope" }),
    ...(props.showProject
      ? [helper.display({ id: "project", header: "project" })]
      : []),
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
  const sortFieldOf = (id: string): KnowledgeSortField | null =>
    id === "title"
      ? "title"
      : id === "confidence"
        ? "confidence"
        : id === "updated"
          ? "updated_at"
          : null;
  const sortPosition = (field: KnowledgeSortField) =>
    props.query.sort.findIndex((key) => key.field === field);
  const ariaSort = (id: string) => {
    const field = sortFieldOf(id);
    const primary = props.query.sort[0];
    if (!field || primary?.field !== field) return "none";
    return primary.dir === "asc" ? "ascending" : "descending";
  };
  const sortButtonLabel = (id: string) => {
    const field = sortFieldOf(id);
    if (!field) return "";
    const position = sortPosition(field);
    if (position < 0) return `Sort by ${SORT_LABELS[field]}`;
    const key = props.query.sort[position]!;
    return `Sort by ${SORT_LABELS[field]}, level ${position + 1}, ${
      key.dir === "asc" ? "ascending" : "descending"
    }`;
  };
  const sortIndicator = (field: KnowledgeSortField) => {
    const position = sortPosition(field);
    if (position < 0) return null;
    const key = props.query.sort[position]!;
    return (
      <span class="ml-1 text-muted" aria-hidden="true">
        {props.query.sort.length > 1 ? `${position + 1} ` : ""}
        {key.dir === "asc" ? "↑" : "↓"}
      </span>
    );
  };
  const sortCaption = () =>
    props.query.sort
      .map(
        (key) => `${SORT_LABELS[key.field]} ${key.dir === "asc" ? "↑" : "↓"}`,
      )
      .join(", then ");
  const clickSort = (field: KnowledgeSortField) => {
    const [primary, ...remaining] = props.query.sort;
    const next: KnowledgeSortKey[] =
      primary?.field === field
        ? [{ field, dir: primary.dir === "asc" ? "desc" : "asc" }, ...remaining]
        : [
            { field, dir: DEFAULT_SORT_DIRECTION[field] },
            ...props.query.sort.filter((key) => key.field !== field),
          ];
    go({
      ...props.query,
      sort: next.slice(0, 3),
      cursor: null,
    });
  };
  const filter = (
    name: "category" | "scope",
    options: readonly string[],
    placeholder: string,
  ) => (
    <Select
      value={props.query[name] ?? null}
      onChange={(value) =>
        go({
          ...props.query,
          [name]: (value || null) as never,
          cursor: null,
        })
      }
      options={["", ...options]}
      placeholder={placeholder}
      itemComponent={(item) => (
        <SelectItem item={item.item}>
          {item.item.rawValue || placeholder}
        </SelectItem>
      )}
    >
      <SelectTrigger aria-label={name} class="h-9 min-w-32 text-xs">
        <SelectValue<string>>
          {(state) => state.selectedOption() || placeholder}
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
              class="h-9 text-xs"
            />
          </TextField>
          <Button type="submit" size="sm">
            Search
          </Button>
        </form>
        {filter("category", KNOWLEDGE_CATEGORIES, "All categories")}
        {filter("scope", KNOWLEDGE_SCOPES, "Any scope")}
        {props.extraFilters}
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
              filtersActive()
                ? "No knowledge matches these filters"
                : "No knowledge extracted yet"
            }
            action={
              filtersActive() ? (
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
              Sorted by {sortCaption()} · page of up to 50
              {rows().some((row) => row.match === "fuzzy")
                ? " · approximate matches shown below exact hits"
                : ""}
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
                            class={`px-2 py-2 font-semibold ${
                              id === "scope" ||
                              id === "project" ||
                              id === "confidence" ||
                              id === "updated"
                                ? "hidden sm:table-cell"
                                : ""
                            }`}
                            aria-sort={sortable ? ariaSort(id) : undefined}
                          >
                            {sortable ? (
                              <button
                                type="button"
                                aria-label={sortButtonLabel(id)}
                                onClick={() => {
                                  const field = sortFieldOf(id);
                                  if (field) clickSort(field);
                                }}
                              >
                                {flexRender(
                                  header.column.columnDef.header,
                                  header.getContext(),
                                )}
                                <Show when={sortFieldOf(id)}>
                                  {(field) => sortIndicator(field())}
                                </Show>
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
                    onClick={() => navigate(entryHref(row.original.id))}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        navigate(entryHref(row.original.id));
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
                        <td
                          class={`px-2 py-2 ${
                            cell.column.id === "title" ? "max-w-0" : ""
                          } ${
                            cell.column.id === "scope" ||
                            cell.column.id === "project" ||
                            cell.column.id === "confidence" ||
                            cell.column.id === "updated"
                              ? "hidden sm:table-cell"
                              : ""
                          }`}
                        >
                          {cell.column.id === "title" ? (
                            <>
                              <span class="flex min-w-0 items-center gap-1.5 font-semibold">
                                <span class="truncate">
                                  {row.original.title}
                                </span>
                                <Show when={row.original.match === "fuzzy"}>
                                  <span
                                    data-testid="knowledge-match-fuzzy"
                                    title="Approximate match"
                                    class="shrink-0 rounded-sm bg-soft px-1 py-px text-[10px] font-normal text-muted"
                                  >
                                    ≈ approximate
                                  </span>
                                </Show>
                              </span>
                              <div class="block truncate font-normal text-muted">
                                {previewOf(row.original.content)}
                              </div>
                            </>
                          ) : cell.column.id === "category" ? (
                            <Badge>{row.original.category}</Badge>
                          ) : cell.column.id === "scope" ? (
                            row.original.project_id == null ||
                            row.original.cross_project === true ||
                            row.original.cross_project === 1 ? (
                              "shared"
                            ) : (
                              "project"
                            )
                          ) : cell.column.id === "project" ? (
                            row.original.project_id == null ? (
                              "No project"
                            ) : (
                              (row.original.project_name ?? "Unknown project")
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
}
