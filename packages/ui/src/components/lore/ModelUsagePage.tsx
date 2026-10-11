/**
 * Model usage page (#2026): distinct sessions per model per UTC day, read
 * from the assistant turns Lore stored — the same metric as Model Tides.
 * Whole document per project; date range and totals filtering happen
 * client-side.
 */
import type { Component } from "solid-js";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { useSearchParams } from "@solidjs/router";

import type { ModelUsageDocument } from "~/contracts";
import { API_BASE, apiPath, isApiError } from "~/lib/api";
import { fuzzyRank } from "~/lib/fuzzy";
import { useWorkspace } from "~/routes/workspace";
import { Button } from "~/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { TextField, TextFieldInput } from "~/components/ui/text-field";
import { errorStateFor } from "./ErrorState";
import { ModelFlowChart, shortModelName } from "./ModelFlowChart";
import { StateCard } from "./StateCard";

const DAY = 86_400_000;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
function validDay(value: string | undefined): string | undefined {
  if (!value || !DAY_RE.test(value)) return undefined;
  const time = Date.parse(`${value}T00:00:00Z`);
  if (
    !Number.isFinite(time) ||
    new Date(time).toISOString().slice(0, 10) !== value
  )
    return undefined;
  return value;
}
const toMs = (day: string) => Date.parse(`${day}T00:00:00Z`);
const fromMs = (ms: number) => new Date(ms).toISOString().slice(0, 10);

type SortField = "model" | "provider" | "sessions" | "share" | "days" | "last";
interface SortKey {
  field: SortField;
  dir: "asc" | "desc";
}
const SORT_LABELS: Record<SortField, string> = {
  model: "Model",
  provider: "Provider",
  sessions: "Session-days",
  share: "Share",
  days: "Active days",
  last: "Last used",
};
const DEFAULT_SORT_DIRECTION: Record<SortField, "asc" | "desc"> = {
  model: "asc",
  provider: "asc",
  sessions: "desc",
  share: "desc",
  days: "desc",
  last: "desc",
};
const DEFAULT_SORT: SortKey[] = [
  { field: "sessions", dir: "desc" },
  { field: "model", dir: "asc" },
];

interface ModelTotal {
  model: string;
  provider: string;
  sessions: number;
  share: number;
  days: number;
  last: string;
}

const PRESETS = [
  { label: "4 weeks", days: 28 },
  { label: "3 months", days: 92 },
  { label: "1 year", days: 365 },
  { label: "All", days: null },
] as const;

function showError(error: unknown): string {
  return isApiError(error) ? error.message : String(error);
}

export const ModelUsagePage: Component = () => {
  const ws = useWorkspace();
  const [searchParams, setSearchParams] = useSearchParams<{
    from?: string;
    to?: string;
    project?: string;
  }>();
  const [doc, setDoc] = createSignal<ModelUsageDocument>();
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<unknown>();
  const [filterText, setFilterText] = createSignal("");
  const [sort, setSort] = createSignal<SortKey[]>(DEFAULT_SORT);

  const project = () => searchParams.project || undefined;

  const load = async () => {
    setLoading(true);
    setError(undefined);
    try {
      const result = await ws.tracked(() =>
        ws.client.getModelUsage({ project: project() }),
      );
      setDoc(result);
    } catch (reason) {
      setError(reason);
    } finally {
      setLoading(false);
    }
  };

  // Loads on mount and refetches whenever the selected project changes.
  createEffect(() => {
    project();
    void load();
  });

  const setProject = (value: string | null) => {
    setSearchParams({ project: value || undefined });
  };

  const docRange = createMemo(() => {
    const days = doc()?.days;
    if (!days?.length) return undefined;
    const first = days[0]!;
    const last = days[days.length - 1]!;
    return { min: first.day, max: last.day };
  });

  // URL state, clamped to the document's day bounds; invalid params fall back
  // to the full range.
  const range = createMemo(() => {
    const bounds = docRange();
    if (!bounds) return { from: "", to: "" };
    let from = validDay(searchParams.from) ?? bounds.min;
    let to = validDay(searchParams.to) ?? bounds.max;
    from =
      from < bounds.min ? bounds.min : from > bounds.max ? bounds.max : from;
    to = to < bounds.min ? bounds.min : to > bounds.max ? bounds.max : to;
    if (from > to) [from, to] = [to, from];
    return { from, to };
  });

  const setRange = (from: string | undefined, to: string | undefined) => {
    const bounds = docRange();
    setSearchParams({
      from: from && bounds && from !== bounds.min ? from : undefined,
      to: to && bounds && to !== bounds.max ? to : undefined,
    });
  };

  const applyPreset = (days: number | null) => {
    const bounds = docRange();
    if (!bounds) return;
    if (days === null) {
      setRange(bounds.min, bounds.max);
      return;
    }
    const end = toMs(bounds.max);
    const start = Math.max(toMs(bounds.min), end - (days - 1) * DAY);
    setRange(fromMs(start), bounds.max);
  };

  const filteredRows = createMemo(() => {
    const { from, to } = range();
    if (!from || !to) return [];
    const start = toMs(from);
    const end = toMs(to) + DAY - 1;
    const rows: { time: number; to: string; weight: number }[] = [];
    for (const day of doc()?.days ?? []) {
      const time = toMs(day.day);
      if (time < start || time > end) continue;
      for (const [model, count] of Object.entries(day.models)) {
        rows.push({ time, to: model, weight: count });
      }
    }
    return rows;
  });

  const totals = createMemo<ModelTotal[]>(() => {
    const rows = filteredRows();
    const byModel = new Map<
      string,
      { sessions: number; days: number; last: number }
    >();
    const total = rows.reduce((sum, row) => sum + row.weight, 0);
    for (const { time, to: model, weight } of rows) {
      const entry = byModel.get(model) ?? { sessions: 0, days: 0, last: 0 };
      entry.sessions += weight;
      entry.days += 1;
      entry.last = Math.max(entry.last, time);
      byModel.set(model, entry);
    }
    return [...byModel].map(([model, entry]) => ({
      model,
      provider: model.split("/")[0] ?? "",
      sessions: entry.sessions,
      share: total > 0 ? entry.sessions / total : 0,
      days: entry.days,
      last: fromMs(entry.last),
    }));
  });

  const filteredTotals = createMemo<ModelTotal[]>(() => {
    const rows = totals();
    const q = filterText();
    if (!q.trim()) return rows;
    const hits = fuzzyRank(q, rows, (row) => [row.model]);
    return hits.map((hit) => hit.item);
  });

  const sortedTotals = createMemo(() => {
    const keys = sort();
    const value = (row: ModelTotal, field: SortField) =>
      field === "model"
        ? row.model
        : field === "provider"
          ? row.provider
          : field === "sessions"
            ? row.sessions
            : field === "share"
              ? row.share
              : field === "days"
                ? row.days
                : row.last;
    return [...filteredTotals()].sort((a, b) => {
      for (const key of keys) {
        const av = value(a, key.field);
        const bv = value(b, key.field);
        const order =
          (typeof av === "number" && typeof bv === "number"
            ? av - bv
            : String(av).localeCompare(String(bv))) *
          (key.dir === "asc" ? 1 : -1);
        if (order !== 0) return order;
      }
      return 0;
    });
  });

  const sortPosition = (field: SortField) =>
    sort().findIndex((key) => key.field === field);
  const ariaSort = (field: SortField) => {
    const primary = sort()[0];
    if (primary?.field !== field) return "none";
    return primary.dir === "asc" ? "ascending" : "descending";
  };
  const sortButtonLabel = (field: SortField) => {
    const position = sortPosition(field);
    if (position < 0) return `Sort by ${SORT_LABELS[field]}`;
    const key = sort()[position]!;
    return `Sort by ${SORT_LABELS[field]}, level ${position + 1}, ${
      key.dir === "asc" ? "ascending" : "descending"
    }`;
  };
  const sortIndicator = (field: SortField) => {
    const position = sortPosition(field);
    if (position < 0) return null;
    const key = sort()[position]!;
    return (
      <span class="ml-1 text-muted" aria-hidden="true">
        {sort().length > 1 ? `${position + 1} ` : ""}
        {key.dir === "asc" ? "↑" : "↓"}
      </span>
    );
  };
  const sortCaption = () =>
    sort()
      .map(
        (key) => `${SORT_LABELS[key.field]} ${key.dir === "asc" ? "↑" : "↓"}`,
      )
      .join(", then ");
  const clickSort = (field: SortField) => {
    const [primary, ...remaining] = sort();
    const next: SortKey[] =
      primary?.field === field
        ? [{ field, dir: primary.dir === "asc" ? "desc" : "asc" }, ...remaining]
        : [
            { field, dir: DEFAULT_SORT_DIRECTION[field] },
            ...sort().filter((key) => key.field !== field),
          ];
    setSort(next.slice(0, 3));
  };

  const exportHref = createMemo(() => {
    const { from, to } = range();
    return (
      API_BASE +
      apiPath(["model-usage", "export"], {
        from: from || undefined,
        to: to || undefined,
        project: project(),
      })
    );
  });

  const hasData = () => (doc()?.days.length ?? 0) > 0;
  const hasRows = () => filteredRows().length > 0;

  const numberFmt = new Intl.NumberFormat("en-GB");

  return (
    <div
      class="mx-auto max-w-[1100px] px-5 py-8 sm:px-7.5"
      data-testid="model-usage-page"
    >
      <div class="eyebrow mb-2">Operations</div>
      <h1 class="mb-1 text-[25px] font-semibold">Model usage</h1>
      <p class="mb-6 max-w-prose text-sm text-muted">
        Distinct sessions per model per UTC day, from assistant turns Lore
        stored — the same metric as Model Tides.
      </p>

      <Show
        when={doc()}
        fallback={
          loading() ? (
            <StateCard kind="loading" title="Loading model usage" />
          ) : (
            errorStateFor(error(), "Model usage", () => void load())
          )
        }
      >
        {(_data) => (
          <>
            <div class="mb-5 flex flex-wrap items-end gap-3">
              <div class="min-w-52">
                <Select
                  value={project() ?? ""}
                  onChange={(value) => setProject(value || null)}
                  options={[
                    "",
                    ...(ws.projects.data()?.map((p) => p.id) ?? []),
                  ]}
                  itemComponent={(props) => (
                    <SelectItem item={props.item}>
                      {props.item.rawValue === ""
                        ? "All projects"
                        : (ws.projects
                            .data()
                            ?.find((p) => p.id === props.item.rawValue)?.name ??
                          ws.projects
                            .data()
                            ?.find((p) => p.id === props.item.rawValue)?.path ??
                          props.item.rawValue)}
                    </SelectItem>
                  )}
                >
                  <SelectTrigger
                    aria-label="Project"
                    class="h-9 w-52 text-xs"
                    data-testid="project-select"
                  >
                    <SelectValue<string>>
                      {(state) =>
                        state.selectedOption() === ""
                          ? "All projects"
                          : (ws.projects
                              .data()
                              ?.find((p) => p.id === state.selectedOption())
                              ?.name ?? state.selectedOption())
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent />
                </Select>
              </div>
              <label class="flex items-center gap-1.5 text-xs text-muted">
                From
                <input
                  type="date"
                  class="h-9 rounded-md border border-input bg-transparent px-2 text-xs"
                  min={docRange()?.min}
                  max={docRange()?.max}
                  value={range().from}
                  data-testid="from-date"
                  onInput={(event) =>
                    setRange(event.currentTarget.value, range().to)
                  }
                />
              </label>
              <label class="flex items-center gap-1.5 text-xs text-muted">
                To
                <input
                  type="date"
                  class="h-9 rounded-md border border-input bg-transparent px-2 text-xs"
                  min={docRange()?.min}
                  max={docRange()?.max}
                  value={range().to}
                  data-testid="to-date"
                  onInput={(event) =>
                    setRange(range().from, event.currentTarget.value)
                  }
                />
              </label>
              <div class="flex gap-1" role="group" aria-label="Date presets">
                <For each={PRESETS}>
                  {(preset) => (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => applyPreset(preset.days)}
                    >
                      {preset.label}
                    </Button>
                  )}
                </For>
              </div>
              <Show when={hasData()}>
                <a
                  href={exportHref()}
                  download=""
                  class="inline-flex h-9 items-center rounded-md border border-line px-3 text-xs font-medium hover:bg-soft"
                  data-testid="export-link"
                >
                  Export
                </a>
              </Show>
            </div>

            <Show
              when={hasData()}
              fallback={
                <StateCard kind="empty" title="No model usage recorded yet">
                  Counts come from assistant turns that carry provider/model
                  metadata. Requests through Lore with a known model appear
                  here.
                </StateCard>
              }
            >
              <Show
                when={hasRows()}
                fallback={
                  <StateCard
                    kind="empty"
                    title="No model activity in this window."
                    action={
                      <Button
                        variant="link"
                        size="sm"
                        onClick={() => applyPreset(null)}
                      >
                        Show all
                      </Button>
                    }
                  />
                }
              >
                <ModelFlowChart
                  rows={filteredRows()}
                  startMs={toMs(range().from)}
                  endMs={toMs(range().to)}
                />

                <section class="mt-6">
                  <div class="mb-3 flex flex-wrap items-end justify-between gap-3">
                    <h2 class="text-lg font-semibold">Totals</h2>
                    <TextField class="w-64">
                      <TextFieldInput
                        aria-label="Filter models"
                        placeholder="Filter models"
                        class="h-9 text-xs"
                        value={filterText()}
                        data-testid="model-filter"
                        onInput={(event) =>
                          setFilterText(event.currentTarget.value)
                        }
                      />
                    </TextField>
                  </div>
                  <div class="overflow-x-auto rounded-lg border border-line">
                    <table class="w-full min-w-[640px] text-left text-xs">
                      <caption class="mb-2 text-left text-[11px] text-muted">
                        Sorted by {sortCaption()}
                      </caption>
                      <thead class="bg-soft text-muted">
                        <tr>
                          <th
                            class="px-3 py-2 font-medium"
                            aria-sort={ariaSort("model")}
                          >
                            <button
                              type="button"
                              aria-label={sortButtonLabel("model")}
                              onClick={() => clickSort("model")}
                            >
                              Model
                              {sortIndicator("model")}
                            </button>
                          </th>
                          <th
                            class="px-3 py-2 font-medium"
                            aria-sort={ariaSort("provider")}
                          >
                            <button
                              type="button"
                              aria-label={sortButtonLabel("provider")}
                              onClick={() => clickSort("provider")}
                            >
                              Provider
                              {sortIndicator("provider")}
                            </button>
                          </th>
                          <th
                            class="px-3 py-2 text-right font-medium tabular-nums"
                            aria-sort={ariaSort("sessions")}
                          >
                            <button
                              type="button"
                              aria-label={sortButtonLabel("sessions")}
                              onClick={() => clickSort("sessions")}
                            >
                              Session-days
                              {sortIndicator("sessions")}
                            </button>
                          </th>
                          <th
                            class="px-3 py-2 text-right font-medium tabular-nums"
                            aria-sort={ariaSort("share")}
                          >
                            <button
                              type="button"
                              aria-label={sortButtonLabel("share")}
                              onClick={() => clickSort("share")}
                            >
                              Share
                              {sortIndicator("share")}
                            </button>
                          </th>
                          <th
                            class="px-3 py-2 text-right font-medium tabular-nums"
                            aria-sort={ariaSort("days")}
                          >
                            <button
                              type="button"
                              aria-label={sortButtonLabel("days")}
                              onClick={() => clickSort("days")}
                            >
                              Active days
                              {sortIndicator("days")}
                            </button>
                          </th>
                          <th
                            class="px-3 py-2 text-right font-medium tabular-nums"
                            aria-sort={ariaSort("last")}
                          >
                            <button
                              type="button"
                              aria-label={sortButtonLabel("last")}
                              onClick={() => clickSort("last")}
                            >
                              Last used
                              {sortIndicator("last")}
                            </button>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        <For each={sortedTotals()}>
                          {(row) => (
                            <tr class="border-t border-line">
                              <td
                                class="px-3 py-2 font-medium"
                                title={row.model}
                              >
                                {shortModelName(row.model)}
                              </td>
                              <td class="px-3 py-2">{row.provider}</td>
                              <td class="px-3 py-2 text-right tabular-nums">
                                {numberFmt.format(row.sessions)}
                              </td>
                              <td class="px-3 py-2 text-right tabular-nums">
                                {(row.share * 100).toFixed(1)}%
                              </td>
                              <td class="px-3 py-2 text-right tabular-nums">
                                {row.days}
                              </td>
                              <td class="px-3 py-2 text-right tabular-nums">
                                {row.last}
                              </td>
                            </tr>
                          )}
                        </For>
                      </tbody>
                    </table>
                  </div>
                </section>
              </Show>
            </Show>
            <Show when={error() && doc()}>
              <p class="mt-4 text-xs text-danger">{showError(error())}</p>
            </Show>
          </>
        )}
      </Show>
    </div>
  );
};
