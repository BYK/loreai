import type { Component } from "solid-js";
import { A } from "@solidjs/router";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
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
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/components/ui/popover";
import { Dialog, DialogTitle, DialogTrigger } from "~/components/ui/dialog";
import { Icon } from "~/components/shell/Icon";
import { BottomSheetContent } from "~/components/ui/bottom-sheet";
import { ResponsiveSelect } from "~/components/ui/responsive-select";
import { createResponsiveOverlay } from "~/lib/responsive-overlay";

const categoryLabels: Record<string, string> = {
  decision: "Decisions",
  pattern: "Patterns",
  preference: "Preferences",
  architecture: "Architecture",
  gotcha: "Gotchas",
};
const categoryOptions: Array<NonNullable<KnowledgeQuery["category"]> | ""> = [
  "",
  ...KNOWLEDGE_CATEGORIES,
];
const scopeOptions: Array<NonNullable<KnowledgeQuery["scope"]> | ""> = [
  "",
  ...KNOWLEDGE_SCOPES,
];
const scopeLabels: Record<string, string> = {
  "": "This project",
  project: "Project-only",
  shared: "Shared knowledge",
  all: "Project + shared",
};
const scopeDescriptions: Record<string, string> = {
  "": "Entries owned by this project, including ones marked as shared.",
  project: "Entries in this project that are not marked as shared.",
  shared: "Shared entries from any project and global knowledge.",
  all: "This project's entries plus shared and global knowledge.",
};
const sorts: Record<string, string> = {
  "updated_at:desc": "Recently updated",
  "updated_at:asc": "Least recently updated",
  "created_at:desc": "Newest added",
  "created_at:asc": "Oldest added",
  "title:asc": "Title A–Z",
  "title:desc": "Title Z–A",
  "confidence:desc": "Highest confidence",
  "confidence:asc": "Lowest confidence",
};

export const KnowledgeListToolbar: Component<{
  query: KnowledgeQuery;
  count?: number;
  tableHref: string;
  onChange: (query: KnowledgeQuery) => void;
}> = (props) => {
  const appliedSearch = createMemo(() => props.query.q);
  const [search, setSearch] = createSignal(appliedSearch());
  createEffect(() => setSearch(appliedSearch()));
  let toolbar: HTMLElement | undefined;
  const { mobile, open, setOpen, restoreFocus } = createResponsiveOverlay(
    () =>
      toolbar?.querySelector<HTMLButtonElement>(
        "[data-knowledge-filters-trigger]",
      ) ?? undefined,
  );
  const [category, setCategory] =
    createSignal<KnowledgeQuery["category"]>(null);
  const [scope, setScope] = createSignal<KnowledgeQuery["scope"]>(null);
  const changeOpen = (next: boolean) => {
    if (next) {
      setCategory(props.query.category);
      setScope(props.query.scope);
    }
    setOpen(next);
  };
  const currentSort = createMemo(() => formatKnowledgeSort(props.query.sort));
  const sortOptions = createMemo(() => [
    ...new Set([...Object.keys(sorts), currentSort()]),
  ]);
  const active = () => [
    ...(props.query.q
      ? [{ key: "q" as const, label: `Search: ${props.query.q}` }]
      : []),
    ...(props.query.category
      ? [
          {
            key: "category" as const,
            label: `Category: ${categoryLabels[props.query.category] ?? props.query.category}`,
          },
        ]
      : []),
    ...(props.query.scope
      ? [
          {
            key: "scope" as const,
            label: `Scope: ${scopeLabels[props.query.scope]}`,
          },
        ]
      : []),
  ];
  const clear = () => {
    setSearch("");
    props.onChange({
      ...props.query,
      q: "",
      category: null,
      scope: null,
      cursor: null,
    });
  };
  const sortLabel = (value: string) => sorts[value] ?? "Custom sort";
  const filterButtonContents = () => (
    <>
      <Icon name="filter" />
      <span class="hidden md:inline">Filters</span>
      <Show when={active().length}>
        <span
          class="absolute right-0 top-0 rounded bg-accent-soft px-1 text-[10px] tabular-nums text-accent-soft-text md:static md:px-1.5 md:text-[11px]"
          aria-label={`${active().length} active filters`}
        >
          {active().length}
        </span>
      </Show>
    </>
  );
  const filterForm = (sheet: boolean) => (
    <form
      class={sheet ? "flex min-h-0 flex-1 flex-col" : undefined}
      onSubmit={(event) => {
        event.preventDefault();
        setOpen(false);
        props.onChange({
          ...props.query,
          category: category(),
          scope: scope(),
          cursor: null,
        });
      }}
    >
      <div
        class={
          sheet
            ? "min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-4"
            : "space-y-4 p-4"
        }
      >
        <div>
          <Show
            when={sheet}
            fallback={<h2 class="text-sm font-semibold">Filter knowledge</h2>}
          >
            <DialogTitle class="pr-10 text-sm">Knowledge filters</DialogTitle>
          </Show>
          <p class="mt-1 text-xs leading-5 text-muted">
            Narrow the list without leaving this entry.
          </p>
        </div>
        <Select<NonNullable<KnowledgeQuery["category"]> | "">
          modal
          value={category() ?? ""}
          options={categoryOptions}
          placeholder="All categories"
          onChange={(value) => setCategory(value || null)}
          itemComponent={(item) => (
            <SelectItem item={item.item} class="min-h-11 md:min-h-8">
              {categoryLabels[item.item.rawValue] ?? "All categories"}
            </SelectItem>
          )}
        >
          <SelectLabel class="mb-1.5 block text-xs">Category</SelectLabel>
          <SelectTrigger class="h-11 bg-bg text-sm md:h-9 md:text-xs">
            <SelectValue<string>>
              {(state) =>
                categoryLabels[state.selectedOption()] ?? "All categories"
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent class="max-h-[var(--kb-popper-content-available-height)] overflow-y-auto overscroll-contain" />
        </Select>
        <Select<NonNullable<KnowledgeQuery["scope"]> | "">
          modal
          value={scope() ?? ""}
          options={scopeOptions}
          placeholder="This project"
          onChange={(value) => setScope(value || null)}
          itemComponent={(item) => (
            <SelectItem item={item.item} class="min-h-11 md:min-h-8">
              {scopeLabels[item.item.rawValue]}
            </SelectItem>
          )}
        >
          <SelectLabel class="mb-1.5 block text-xs">Scope</SelectLabel>
          <SelectTrigger class="h-11 bg-bg text-sm md:h-9 md:text-xs">
            <SelectValue<string>>
              {(state) => scopeLabels[state.selectedOption()]}
            </SelectValue>
          </SelectTrigger>
          <SelectContent class="max-h-[var(--kb-popper-content-available-height)] overflow-y-auto overscroll-contain" />
        </Select>
        <p class="text-xs leading-5 text-muted">
          {scopeDescriptions[scope() ?? ""]}
        </p>
      </div>
      <div
        class={
          sheet
            ? "flex shrink-0 justify-end gap-2 border-t border-line bg-soft px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
            : "flex justify-end gap-2 border-t border-line bg-soft px-4 py-3"
        }
      >
        <Button
          type="button"
          variant="ghost"
          size="sm"
          class="h-11 md:h-8"
          onClick={() => setOpen(false)}
        >
          Cancel
        </Button>
        <Button type="submit" size="sm" class="h-11 md:h-8">
          Apply filters
        </Button>
      </div>
    </form>
  );

  return (
    <header
      ref={(element) => {
        toolbar = element;
      }}
      class="sticky top-0 z-10 border-b border-line bg-bg"
      data-testid="knowledge-list-toolbar"
    >
      <div class="flex h-11 items-center justify-between gap-2 px-4">
        <div class="flex items-center gap-2 text-[13px] font-semibold">
          Knowledge
          <Show when={props.count !== undefined}>
            <span
              class="rounded bg-soft px-1.5 py-0.5 text-[10px] font-normal tabular-nums text-muted"
              aria-label="Entries on this page"
            >
              {props.count}
            </span>
          </Show>
        </div>
        <A
          href={props.tableHref}
          class="inline-flex min-h-11 items-center text-xs text-muted hover:text-text md:min-h-0"
        >
          Open as table
        </A>
      </div>
      <div class="space-y-2 px-3 pb-3">
        <form
          class="flex min-w-0 items-center gap-1.5"
          role="search"
          aria-label="Search knowledge list"
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
          <TextField
            class="min-w-0 flex-1"
            value={search()}
            onChange={setSearch}
          >
            <TextFieldInput
              name="q"
              aria-label="Filter knowledge list"
              placeholder="Search knowledge…"
              class="h-11 bg-surface px-3 text-base md:h-9 md:text-xs"
            />
          </TextField>
          <Button
            type="submit"
            size="icon"
            variant="outline"
            class="size-11 shrink-0 md:size-9"
            aria-label="Search knowledge"
          >
            <Icon name="search" />
          </Button>
        </form>
        <div class="flex min-w-0 items-center gap-2">
          <Show
            when={mobile()}
            fallback={
              <Popover
                modal
                open={open()}
                onOpenChange={changeOpen}
                placement="bottom-start"
                gutter={6}
              >
                <PopoverTrigger
                  as={Button}
                  variant="outline"
                  size="sm"
                  class="h-11 shrink-0 gap-1.5 px-2.5 md:h-8"
                  aria-label="Filters"
                  data-knowledge-filters-trigger
                >
                  {filterButtonContents()}
                </PopoverTrigger>
                <PopoverContent
                  aria-label="Knowledge filters"
                  class="max-h-[var(--kb-popper-content-available-height)] w-72 overflow-y-auto overscroll-contain"
                  data-testid="knowledge-filter-panel"
                  data-filter-presentation="popover"
                >
                  {filterForm(false)}
                </PopoverContent>
              </Popover>
            }
          >
            <Dialog open={open()} onOpenChange={changeOpen}>
              <DialogTrigger
                as={Button}
                variant="outline"
                size="sm"
                class="relative size-11 shrink-0 p-0"
                aria-label="Filters"
                data-knowledge-filters-trigger
              >
                {filterButtonContents()}
              </DialogTrigger>
              <BottomSheetContent
                onCloseAutoFocus={restoreFocus}
                data-testid="knowledge-filter-panel"
                data-filter-presentation="sheet"
              >
                {filterForm(true)}
              </BottomSheetContent>
            </Dialog>
          </Show>
          <ResponsiveSelect
            label="List sort"
            sheetTitle="Sort knowledge"
            value={currentSort()}
            options={sortOptions()}
            onChange={(value) => {
              const sort = parseKnowledgeSort(value ?? "");
              if (sort && value !== currentSort())
                props.onChange({ ...props.query, sort, cursor: null });
            }}
            optionLabel={sortLabel}
            icon="sort"
            triggerClass="h-11 min-w-0 flex-1 gap-1.5 border-transparent bg-transparent px-2 text-xs text-muted hover:bg-soft md:h-8"
            itemClass="min-h-11 md:min-h-8"
            contentClass="max-h-[var(--kb-popper-content-available-height)] overflow-y-auto overscroll-contain"
          />
        </div>
        <Show when={active().length}>
          <div
            class="flex flex-wrap items-center gap-1.5"
            aria-label="Applied knowledge filters"
            role="group"
          >
            <For each={active()}>
              {(item) => (
                <Button
                  variant="secondary"
                  size="sm"
                  class="h-11 max-w-full gap-1.5 px-2 text-xs md:h-7"
                  aria-label={`Remove ${item.label.charAt(0).toLowerCase()}${item.label.slice(1)}`}
                  onClick={() =>
                    props.onChange({
                      ...props.query,
                      [item.key]: item.key === "q" ? "" : null,
                      cursor: null,
                    })
                  }
                >
                  <span class="truncate">{item.label}</span>
                  <Icon name="close" />
                </Button>
              )}
            </For>
            <Button
              variant="ghost"
              size="sm"
              class="h-11 px-2 text-xs text-muted md:h-7"
              onClick={clear}
            >
              Clear filters
            </Button>
          </div>
        </Show>
      </div>
    </header>
  );
};
