/** Gateway spend, overhead, savings estimates, and daily budget (UI-08). */
import type { Component, JSX } from "solid-js";
import { createSignal, For, onMount, Show } from "solid-js";
import { A } from "@solidjs/router";

import type { CostsSnapshot } from "~/contracts";
import { isApiError } from "~/lib/api";
import { useWorkspace } from "~/routes/workspace";
import { Button } from "~/components/ui/button";
import { errorStateFor } from "./ErrorState";
import { StateCard } from "./StateCard";

function usd(value: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 4,
  }).format(value);
}

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
  const [actionError, setActionError] = createSignal("");
  const [budgetValue, setBudgetValue] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  const load = async () => {
    setLoading(true);
    setError(undefined);
    try {
      const result = await ws.tracked(() => ws.client.getCosts());
      setSnapshot(result);
      setBudgetValue(
        result.daily.budget.amount > 0
          ? String(result.daily.budget.amount)
          : "",
      );
    } catch (reason) {
      setError(reason);
    } finally {
      setLoading(false);
    }
  };

  const setBudget = async (amount: number) => {
    setBusy(true);
    setActionError("");
    try {
      await ws.tracked(() => ws.client.setDailyBudget(amount));
      await load();
    } catch (reason) {
      setActionError(showError(reason));
    } finally {
      setBusy(false);
    }
  };

  onMount(() => void load());

  const dailyMax = () =>
    Math.max(0.01, ...(snapshot()?.daily.entries.map((day) => day.cost) ?? []));
  const liveSavingsTone = () =>
    (snapshot()?.live.net_savings ?? 0) >= 0 ? "text-accent" : "text-danger";
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
        Actual gateway spend, Lore’s worker overhead, estimated savings, and a
        daily spending limit. Historical values are estimates from stored data.
      </p>

      <Show when={actionError()}>
        <StateCard kind="error" title="The budget could not be saved">
          {actionError()}
        </StateCard>
      </Show>

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
            <div class="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Stat label="Current spend" value={usd(data().live.spend)} />
              <Stat
                label={
                  data().live.net_savings >= 0
                    ? "Current net savings"
                    : "Current net overhead"
                }
                value={usd(Math.abs(data().live.net_savings))}
                valueClass={liveSavingsTone()}
              />
              <Stat label="Combined spend" value={usd(data().totals.spend)} />
              <Stat
                label={
                  data().totals.net_savings >= 0
                    ? "Combined net savings"
                    : "Combined net overhead"
                }
                value={usd(Math.abs(data().totals.net_savings))}
                valueClass={combinedSavingsTone()}
              />
            </div>

            <section class="mb-6 rounded-lg border border-line bg-bg p-4">
              <div class="mb-3 flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 class="font-semibold">Daily budget</h2>
                  <p class="mt-1 text-xs text-muted">
                    {data().daily.budget.date} · today’s spend{" "}
                    {usd(data().daily.budget.spend)} · rate{" "}
                    {usd(data().daily.budget.rate)}/hr
                  </p>
                </div>
                <div class="text-right text-xs text-muted">
                  <div>
                    {tokens(data().live.throttle.events)} throttled requests
                  </div>
                  <div>
                    {(data().live.throttle.total_delay_ms / 1000).toFixed(1)}s
                    total delay
                  </div>
                </div>
              </div>
              <Show
                when={data().daily.budget.amount > 0}
                fallback={
                  <p class="mb-3 text-sm text-muted">
                    No daily budget is set. Set one to enable automatic spend
                    throttling.
                  </p>
                }
              >
                <BudgetBar
                  amount={data().daily.budget.amount}
                  spend={data().daily.budget.spend}
                />
              </Show>
              <Show when={data().daily.budget.env_override}>
                {(override) => (
                  <p class="mt-3 text-xs text-muted">
                    Controlled by <code>LORE_DAILY_BUDGET={override()}</code>.
                  </p>
                )}
              </Show>
              <Show when={data().daily.budget.can_edit}>
                <form
                  class="mt-3 flex flex-wrap items-end gap-2"
                  data-testid="budget-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const rawValue = budgetValue().trim();
                    if (!rawValue) {
                      setActionError(
                        "Enter a daily budget between $0 and $1,000,000.",
                      );
                      return;
                    }
                    const value = Number(rawValue);
                    if (
                      !Number.isFinite(value) ||
                      value < 0 ||
                      value > 1_000_000
                    ) {
                      setActionError(
                        "Enter a daily budget between $0 and $1,000,000.",
                      );
                      return;
                    }
                    void setBudget(value);
                  }}
                >
                  <label class="grid gap-1 text-xs text-muted">
                    Budget (USD / day)
                    <input
                      type="number"
                      min="0"
                      max="1000000"
                      step="0.01"
                      value={budgetValue()}
                      onInput={(event) =>
                        setBudgetValue(event.currentTarget.value)
                      }
                      class="h-9 w-36 rounded-md border border-line bg-surface px-3 text-sm text-text outline-none focus-visible:ring-2 focus-visible:ring-accent"
                      aria-label="Daily budget in US dollars"
                    />
                  </label>
                  <Button size="sm" type="submit" disabled={busy()}>
                    {busy() ? "Saving…" : "Save budget"}
                  </Button>
                  <Show when={data().daily.budget.amount > 0}>
                    <Button
                      size="sm"
                      variant="outline"
                      type="button"
                      disabled={busy()}
                      onClick={() => void setBudget(0)}
                    >
                      Disable budget
                    </Button>
                  </Show>
                </form>
              </Show>
            </section>

            <Show when={data().daily.entries.some((day) => day.cost > 0)}>
              <section class="mb-6 rounded-lg border border-line bg-bg p-4">
                <h2 class="mb-3 font-semibold">Daily costs · last 14 days</h2>
                <div class="flex h-32 items-end gap-1 overflow-x-auto border-b border-line pb-1">
                  <For each={data().daily.entries}>
                    {(day) => (
                      <div class="flex h-full min-w-7 flex-1 flex-col items-center justify-end">
                        <div class="mb-1 text-[9px] text-muted">
                          {day.cost > 0 ? usd(day.cost) : ""}
                        </div>
                        <div
                          class="w-full max-w-8 rounded-t bg-accent"
                          style={{
                            height: `${Math.max(2, (day.cost / dailyMax()) * 78)}px`,
                          }}
                          title={`${day.date}: ${usd(day.cost)}`}
                          aria-label={`${day.date}: ${usd(day.cost)}`}
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
                    value={usd(data().live.conversation_spend)}
                  />
                  <Metric
                    label="Worker overhead"
                    value={usd(data().live.worker_cost)}
                  />
                  <WorkerRows workers={data().live.workers} />
                </MetricCard>
                <MetricCard title="Savings estimate">
                  <Metric
                    label="Cache warming"
                    value={`${usd(data().live.warmup_savings)} saved · ${usd(data().live.workers.warmup.cost)} cost`}
                  />
                  <Metric
                    label="1h cache TTL"
                    value={usd(data().live.ttl_savings)}
                  />
                  <Metric
                    label="Batch API"
                    value={usd(data().live.batch_savings)}
                  />
                  <Metric
                    label={`Avoided compactions · ${data().live.avoided_compactions}`}
                    value={usd(data().live.avoided_compaction_cost)}
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
                  value={usd(data().live.cost_without_lore)}
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
                        <th class="px-3 py-2 font-medium">Turns</th>
                        <th class="px-3 py-2 font-medium">Spend</th>
                        <th class="px-3 py-2 font-medium">Worker cost</th>
                        <th class="px-3 py-2 font-medium">Net</th>
                        <th class="px-3 py-2 font-medium">Cache hit</th>
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
                            <td class="px-3 py-2">{row.turns}</td>
                            <td class="px-3 py-2">{usd(row.actual_cost)}</td>
                            <td class="px-3 py-2">{usd(row.worker_cost)}</td>
                            <td
                              class={`px-3 py-2 ${row.net_savings >= 0 ? "text-accent" : "text-danger"}`}
                            >
                              {usd(row.net_savings)}
                            </td>
                            <td class="px-3 py-2">
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
                    value={usd(data().historical.persisted_conversation_cost)}
                  />
                  <Metric
                    label="Total worker cost"
                    value={usd(data().historical.total_worker_cost)}
                  />
                  <WorkerRows workers={data().historical.worker_breakdown} />
                  <Metric
                    label="Distillation estimate"
                    value={`${usd(data().historical.distillation_cost)} · ${tokens(data().historical.distillation_calls)} calls`}
                  />
                  <Metric
                    label="Cache warming cost · included above"
                    value={usd(data().historical.warmup_cost)}
                  />
                </MetricCard>
                <MetricCard title="Historical savings estimate">
                  <Metric
                    label="Cache warming"
                    value={`${usd(data().historical.warmup_savings)} saved · ${tokens(data().historical.warmup_hits)} hits`}
                  />
                  <Metric
                    label="1h cache TTL"
                    value={`${usd(data().historical.ttl_savings)} · ${tokens(data().historical.ttl_hits)} hits`}
                  />
                  <Metric
                    label="Batch API"
                    value={usd(data().historical.batch_savings)}
                  />
                  <Metric
                    label={`Avoided compactions · ${data().historical.avoided_compactions}`}
                    value={usd(data().historical.avoided_compaction_cost)}
                  />
                  <div
                    class={`mt-2 border-t border-line pt-2 text-sm font-semibold ${combinedSavingsTone()}`}
                  >
                    {data().totals.net_savings >= 0
                      ? "Combined net savings"
                      : "Combined net overhead"}
                    : {usd(Math.abs(data().totals.net_savings))}
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
            {usd(item.cost)} · {tokens(item.calls)} calls
          </span>
        </div>
      )}
    </For>
  </div>
);

const BudgetBar: Component<{ amount: number; spend: number }> = (props) => {
  const percent = () => Math.min(100, (props.spend / props.amount) * 100);
  const tone = () =>
    percent() < 60 ? "bg-accent" : percent() < 85 ? "bg-gold" : "bg-danger";
  return (
    <div>
      <div class="flex justify-between text-xs">
        <span class="font-medium">{usd(props.spend)} spent</span>
        <span class="text-muted">{usd(props.amount)} daily limit</span>
      </div>
      <div
        class="mt-2 h-2 overflow-hidden rounded-full bg-soft"
        role="progressbar"
        aria-label="Daily budget used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent()}
      >
        <div class={`h-full ${tone()}`} style={{ width: `${percent()}%` }} />
      </div>
    </div>
  );
};
