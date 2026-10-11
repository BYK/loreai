/** Per-provider spend, budgets and quota pacing, plus Lore's overhead and savings estimates (UI-08). */
import type { Component, JSX } from "solid-js";
import { createSignal, For, onMount, Show } from "solid-js";
import { A } from "@solidjs/router";

import type { CostsSnapshot, ProviderBudgetInput } from "~/contracts";
import { isApiError } from "~/lib/api";
import { formatMoney } from "~/lib/money";
import { useWorkspace } from "~/routes/workspace";
import { Button } from "~/components/ui/button";
import { errorStateFor } from "./ErrorState";
import { ProviderCards } from "./ProviderCards";
import { StateCard } from "./StateCard";

function tokens(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function shortId(value: string) {
  return value.length > 18 ? `${value.slice(0, 9)}…${value.slice(-6)}` : value;
}

function showError(error: unknown): string {
  return isApiError(error) ? error.message : String(error);
}

export const CostsPage: Component = () => {
  const ws = useWorkspace();
  const [snapshot, setSnapshot] = createSignal<CostsSnapshot>();
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<unknown>();

  const load = async () => {
    setLoading(true);
    setError(undefined);
    try {
      const result = await ws.tracked(() => ws.client.getCosts());
      setSnapshot(result);
    } catch (reason) {
      setError(reason);
    } finally {
      setLoading(false);
    }
  };

  const saveBudgets = async (budgets: ProviderBudgetInput[]) => {
    await ws.tracked(() => ws.client.putProviderBudgets(budgets));
    await load();
  };

  onMount(() => void load());

  const dailyMax = () =>
    Math.max(0.01, ...(snapshot()?.daily.entries.map((day) => day.cost) ?? []));
  const combinedSavingsTone = () =>
    (snapshot()?.totals.net_savings ?? 0) >= 0 ? "text-accent" : "text-danger";
  const spendRows = () =>
    (snapshot()?.sessions ?? []).filter(
      (session) => session.turns > 0 || session.actual_cost !== 0,
    );

  return (
    <div
      class="mx-auto max-w-[1100px] px-5 py-8 sm:px-7.5"
      data-testid="costs-page"
    >
      <div class="eyebrow mb-2">Operations</div>
      <h1 class="mb-1 text-[25px] font-semibold">Cost intelligence</h1>
      <p class="mb-6 max-w-prose text-sm text-muted">
        Spend, quota and budgets per provider account, Lore’s worker overhead,
        and estimated savings. Historical values are estimates from stored data.
      </p>

      <Show when={snapshot() && error()}>
        <StateCard
          kind="error"
          title="Could not refresh cost data"
          compact
          action={
            <Button size="sm" variant="outline" onClick={() => void load()}>
              Retry
            </Button>
          }
        >
          Showing the last successful snapshot. {showError(error())}
        </StateCard>
      </Show>

      <Show
        when={snapshot()}
        fallback={
          loading() ? (
            <StateCard kind="loading" title="Loading cost intelligence" />
          ) : (
            errorStateFor(error(), "Cost intelligence", () => void load())
          )
        }
      >
        {(data) => (
          <>
            <ProviderCards
              providers={data().providers}
              quotas={data().quotas}
              budgets={data().provider_budgets}
              money={formatMoney}
              onSaveBudgets={data().can_edit_budgets ? saveBudgets : undefined}
            />

            <Show when={data().daily.entries.some((day) => day.cost > 0)}>
              <section class="mb-6 rounded-lg border border-line bg-bg p-4">
                <h2 class="mb-3 font-semibold">Daily costs · last 14 days</h2>
                <div class="flex h-32 items-end gap-1 overflow-x-auto border-b border-line pb-1">
                  <For each={data().daily.entries}>
                    {(day) => (
                      <div class="flex h-full min-w-7 flex-1 flex-col items-center justify-end">
                        <div class="mb-1 text-[9px] text-muted">
                          {day.cost > 0 ? formatMoney(day.cost) : ""}
                        </div>
                        <div
                          class="w-full max-w-8 rounded-t bg-accent"
                          style={{
                            height: `${Math.max(2, (day.cost / dailyMax()) * 78)}px`,
                          }}
                          title={`${day.date}: ${formatMoney(day.cost)}`}
                          aria-label={`${day.date}: ${formatMoney(day.cost)}`}
                        />
                        <time
                          class="mt-1 text-[9px] text-muted"
                          dateTime={day.date}
                        >
                          {day.date.slice(5)}
                        </time>
                      </div>
                    )}
                  </For>
                </div>
              </section>
            </Show>

            <section class="mb-7">
              <h2 class="mb-3 text-lg font-semibold">Live totals</h2>
              <div class="grid gap-4 lg:grid-cols-2">
                <MetricCard title="Spend composition">
                  <Metric
                    label={`Conversation · ${data().live.turns} turns`}
                    value={formatMoney(data().live.conversation_spend)}
                  />
                  <Metric
                    label="Worker overhead"
                    value={formatMoney(data().live.worker_cost)}
                  />
                  <WorkerRows workers={data().live.workers} />
                </MetricCard>
                <MetricCard title="Savings estimate">
                  <Metric
                    label="Cache warming"
                    value={`${formatMoney(data().live.warmup_savings)} saved · ${formatMoney(data().live.workers.warmup.cost)} cost`}
                  />
                  <Metric
                    label="1h cache TTL"
                    value={formatMoney(data().live.ttl_savings)}
                  />
                  <Metric
                    label="Batch API"
                    value={formatMoney(data().live.batch_savings)}
                  />
                  <Metric
                    label={`Avoided compactions · ${data().live.avoided_compactions}`}
                    value={formatMoney(data().live.avoided_compaction_cost)}
                  />
                  <div class="mt-2 border-t border-line pt-2 text-xs text-muted">
                    Warmup cost is included in worker overhead and is subtracted
                    once in the net estimate.
                  </div>
                </MetricCard>
              </div>
              <div class="mt-3 grid gap-3 sm:grid-cols-3">
                <Stat
                  label="Sessions since gateway start"
                  value={data().live.session_count}
                />
                <Stat
                  label="Cache hit rate"
                  value={
                    data().live.input_tokens > 0
                      ? `${((data().live.cache_read_tokens / data().live.input_tokens) * 100).toFixed(0)}%`
                      : "—"
                  }
                />
                <Stat
                  label="Spend without Lore · estimate"
                  value={formatMoney(data().live.cost_without_lore)}
                />
              </div>
            </section>

            <section class="mb-7">
              <div class="mb-3 flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h2 class="text-lg font-semibold">Per-session costs</h2>
                  <p class="text-xs text-muted">
                    Live tracker data since this gateway started.
                  </p>
                </div>
                <Button size="sm" variant="outline" onClick={() => void load()}>
                  Refresh
                </Button>
              </div>
              <Show
                when={spendRows().length > 0}
                fallback={
                  <StateCard kind="empty" title="No live costs yet">
                    Cost tracking starts when the gateway processes a
                    conversation turn.
                  </StateCard>
                }
              >
                <div class="overflow-x-auto rounded-lg border border-line">
                  <table class="w-full min-w-[900px] text-left text-xs">
                    <thead class="bg-soft text-muted">
                      <tr>
                        <th class="px-3 py-2 font-medium">Project</th>
                        <th class="px-3 py-2 font-medium">Session</th>
                        <th class="px-3 py-2 text-right font-medium tabular-nums">
                          Turns
                        </th>
                        <th class="px-3 py-2 text-right font-medium tabular-nums">
                          Spend
                        </th>
                        <th class="px-3 py-2 text-right font-medium tabular-nums">
                          Worker cost
                        </th>
                        <th class="px-3 py-2 text-right font-medium tabular-nums">
                          Net
                        </th>
                        <th class="px-3 py-2 text-right font-medium tabular-nums">
                          Cache hit
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={spendRows()}>
                        {(row) => (
                          <tr class="border-t border-line">
                            <td class="max-w-40 truncate px-3 py-2">
                              {row.project_id ? (
                                <A
                                  class="text-accent hover:underline"
                                  href={`/projects/${encodeURIComponent(row.project_id)}`}
                                >
                                  {row.project_name ??
                                    row.project_path ??
                                    "Project"}
                                </A>
                              ) : (
                                (row.project_name ?? "—")
                              )}
                            </td>
                            <td
                              class="px-3 py-2 font-mono"
                              title={row.session_id}
                            >
                              {row.project_id ? (
                                <A
                                  class="hover:underline"
                                  href={`/projects/${encodeURIComponent(row.project_id)}/sessions/${encodeURIComponent(row.session_id)}`}
                                >
                                  {shortId(row.session_id)}
                                </A>
                              ) : (
                                shortId(row.session_id)
                              )}
                            </td>
                            <td class="px-3 py-2 text-right tabular-nums">
                              {row.turns}
                            </td>
                            <td class="px-3 py-2 text-right tabular-nums">
                              {formatMoney(row.actual_cost)}
                            </td>
                            <td class="px-3 py-2 text-right tabular-nums">
                              {formatMoney(row.worker_cost)}
                            </td>
                            <td
                              class={`px-3 py-2 text-right tabular-nums ${row.net_savings >= 0 ? "text-accent" : "text-danger"}`}
                            >
                              {formatMoney(row.net_savings)}
                            </td>
                            <td class="px-3 py-2 text-right tabular-nums">
                              {row.cache_hit_pct === null
                                ? "—"
                                : `${row.cache_hit_pct.toFixed(0)}%`}
                            </td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </div>
              </Show>
            </section>

            <section>
              <h2 class="mb-1 text-lg font-semibold">Historical estimates</h2>
              <p class="mb-3 text-xs text-muted">
                Backdated from {tokens(data().historical.session_count)}{" "}
                sessions and {tokens(data().historical.message_count)} messages
                in stored data. Persisted API costs are used where available;
                distillation estimates fill older gaps.
              </p>
              <div class="grid gap-4 lg:grid-cols-2">
                <MetricCard title="Historical spend and overhead">
                  <Metric
                    label="Conversation spend"
                    value={formatMoney(
                      data().historical.persisted_conversation_cost,
                    )}
                  />
                  <Metric
                    label="Total worker cost"
                    value={formatMoney(data().historical.total_worker_cost)}
                  />
                  <WorkerRows workers={data().historical.worker_breakdown} />
                  <Metric
                    label="Distillation estimate"
                    value={`${formatMoney(data().historical.distillation_cost)} · ${tokens(data().historical.distillation_calls)} calls`}
                  />
                  <Metric
                    label="Cache warming cost · included above"
                    value={formatMoney(data().historical.warmup_cost)}
                  />
                </MetricCard>
                <MetricCard title="Historical savings estimate">
                  <Metric
                    label="Cache warming"
                    value={`${formatMoney(data().historical.warmup_savings)} saved · ${tokens(data().historical.warmup_hits)} hits`}
                  />
                  <Metric
                    label="1h cache TTL"
                    value={`${formatMoney(data().historical.ttl_savings)} · ${tokens(data().historical.ttl_hits)} hits`}
                  />
                  <Metric
                    label="Batch API"
                    value={formatMoney(data().historical.batch_savings)}
                  />
                  <Metric
                    label={`Avoided compactions · ${data().historical.avoided_compactions}`}
                    value={formatMoney(
                      data().historical.avoided_compaction_cost,
                    )}
                  />
                  <div
                    class={`mt-2 border-t border-line pt-2 text-sm font-semibold ${combinedSavingsTone()}`}
                  >
                    {data().totals.net_savings >= 0
                      ? "Combined net savings"
                      : "Combined net overhead"}
                    : {formatMoney(Math.abs(data().totals.net_savings))}
                  </div>
                </MetricCard>
              </div>
            </section>
          </>
        )}
      </Show>
    </div>
  );
};

const Stat: Component<{
  label: string;
  value: string | number;
  valueClass?: string;
}> = (props) => (
  <div class="rounded-lg border border-line bg-bg px-3.5 py-3">
    <div class="text-[11px] text-muted">{props.label}</div>
    <div class={`mt-1 text-lg font-semibold ${props.valueClass ?? ""}`}>
      {props.value}
    </div>
  </div>
);

const MetricCard: Component<{ title: string; children: JSX.Element }> = (
  props,
) => (
  <section class="rounded-lg border border-line bg-bg p-4">
    <h3 class="mb-3 font-semibold">{props.title}</h3>
    <div class="space-y-2">{props.children}</div>
  </section>
);

const Metric: Component<{ label: string; value: string }> = (props) => (
  <div class="flex flex-wrap justify-between gap-x-4 gap-y-1 text-xs">
    <span class="text-muted">{props.label}</span>
    <span class="font-medium tabular-nums">{props.value}</span>
  </div>
);

type WorkerCosts =
  | CostsSnapshot["live"]["workers"]
  | CostsSnapshot["historical"]["worker_breakdown"];

function workerRows(workers: WorkerCosts) {
  const base = [
    ["Distillation", workers.distillation],
    ["Curation", workers.curation],
    ["Compaction", workers.compaction],
    ["Recall", workers.recall],
  ] as const;
  return "warmup" in workers
    ? [...base, ["Warmup", workers.warmup] as const]
    : base;
}

const WorkerRows: Component<{ workers: WorkerCosts }> = (props) => (
  <div class="border-l border-line pl-3">
    <For each={workerRows(props.workers)}>
      {([label, item]) => (
        <div class="flex justify-between gap-3 py-0.5 text-[11px] text-muted">
          <span>{label}</span>
          <span class="tabular-nums">
            {formatMoney(item.cost)} · {tokens(item.calls)} calls
          </span>
        </div>
      )}
    </For>
  </div>
);
