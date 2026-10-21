import type { Component } from "solid-js";
import { A } from "@solidjs/router";
import { Show } from "solid-js";
import type { KnowledgeQuery } from "~/contracts";
import {
  KNOWLEDGE_CATEGORIES,
  KNOWLEDGE_SCOPES,
  formatKnowledgeSort,
  parseKnowledgeSort,
} from "~/contracts";
import { Button } from "~/components/ui/button";
import { TextField, TextFieldInput } from "~/components/ui/text-field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Icon } from "~/components/shell/Icon";

export const KnowledgeListToolbar: Component<{
  query: KnowledgeQuery;
  count?: number;
  tableHref: string;
  onChange: (query: KnowledgeQuery) => void;
}> = (props) => {
  const sorts: Record<string, string> = {
    "updated_at:desc": "Recently updated",
    "created_at:desc": "Newest added",
    "title:asc": "Title A–Z",
    "confidence:desc": "Highest confidence",
  };
  const currentSort = () => formatKnowledgeSort(props.query.sort);
  const sortOptions = () => [
    ...new Set([...Object.keys(sorts), currentSort()]),
  ];
  const activeFilters = () =>
    [props.query.q, props.query.category, props.query.scope].filter(Boolean)
      .length;
  const filter = (name: "category" | "scope") => {
    const options =
      name === "category" ? KNOWLEDGE_CATEGORIES : KNOWLEDGE_SCOPES;
    const fallback = name === "category" ? "All categories" : "Any scope";
    return (
      <Select
        placeholder={fallback}
        value={props.query[name] ?? ""}
        options={["", ...options]}
        onChange={(value) =>
          props.onChange({
            ...props.query,
            [name]: value || null,
            cursor: null,
          })
        }
        itemComponent={(item) => (
          <SelectItem item={item.item}>
            {item.item.rawValue || fallback}
          </SelectItem>
        )}
      >
        <SelectTrigger
          aria-label={`List ${name}`}
          class="h-7 min-w-0 flex-1 bg-surface px-2 text-[11px]"
        >
          <SelectValue<string>>
            {(state) => state.selectedOption() || fallback}
          </SelectValue>
        </SelectTrigger>
        <SelectContent />
      </Select>
    );
  };
  return (
    <header class="sticky top-0 z-10 border-b border-line bg-bg">
      <div class="flex h-11 items-center justify-between gap-2 px-4">
        <div class="flex items-center gap-2 text-[13px] font-semibold">
          Knowledge
          <Show when={props.count !== undefined}>
            <span class="rounded bg-soft px-1.5 py-0.5 text-[10px] font-normal tabular-nums text-muted">
              {props.count}
            </span>
          </Show>
        </div>
        <A
          href={props.tableHref}
          class="text-[11px] text-muted hover:text-text"
        >
          Open as table
        </A>
      </div>
      <div class="space-y-2 px-3 pb-3">
        <form
          class="flex min-w-0 items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            const raw = new FormData(event.currentTarget).get("q");
            props.onChange({
              ...props.query,
              q: (typeof raw === "string" ? raw : "").trim().slice(0, 500),
              cursor: null,
            });
          }}
        >
          <TextField class="min-w-0 flex-1">
            <TextFieldInput
              name="q"
              aria-label="Filter knowledge list"
              placeholder="Filter entries…"
              value={props.query.q}
              class="h-8 bg-surface px-2.5 text-xs"
            />
          </TextField>
          <Button
            type="submit"
            size="icon"
            variant="outline"
            class="size-8 shrink-0"
            aria-label="Filter entries"
          >
            <Icon name="search" class="size-3.5" />
          </Button>
        </form>
        <div class="flex min-w-0 gap-1.5">
          {filter("category")}
          {filter("scope")}
        </div>
        <Select
          value={currentSort()}
          options={sortOptions()}
          onChange={(value) => {
            const sort = parseKnowledgeSort(value ?? "");
            if (sort) props.onChange({ ...props.query, sort, cursor: null });
          }}
          itemComponent={(item) => (
            <SelectItem item={item.item}>
              {sorts[item.item.rawValue] ?? "Custom sort"}
            </SelectItem>
          )}
        >
          <SelectTrigger
            aria-label="List sort"
            class="h-7 w-full bg-surface px-2 text-[11px]"
          >
            <SelectValue<string>>
              {(state) => sorts[state.selectedOption()] ?? "Custom sort"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent />
        </Select>
        <Show when={activeFilters() > 0}>
          <div class="flex items-center justify-between text-[11px] text-muted">
            <span>
              {activeFilters()} active{" "}
              {activeFilters() === 1 ? "filter" : "filters"}
            </span>
            <Button
              variant="ghost"
              size="sm"
              class="h-6 px-1.5 text-[11px] text-accent"
              onClick={() =>
                props.onChange({
                  ...props.query,
                  q: "",
                  category: null,
                  scope: null,
                  cursor: null,
                })
              }
            >
              Clear filters
            </Button>
          </div>
        </Show>
      </div>
    </header>
  );
};
