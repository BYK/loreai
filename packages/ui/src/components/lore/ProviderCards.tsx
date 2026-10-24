/** Per-provider spend cards + subscription quota windows (#1926 UI half). */
import type { Component, JSX } from "solid-js";
import { createSignal, For, onCleanup, Show } from "solid-js";

import type { CostsSnapshot, ProviderBudgetInput } from "~/contracts";
import { isApiError } from "~/lib/api";
import { formatWhen } from "~/lib/format";
import { Button } from "~/components/ui/button";
import {
  applyBudgetEditor,
  budgetEditorState,
  budgetsForCard,
  CAP_FIELDS,
  evenPacePercent,
  PACE_WINDOWS,
  paceFor,
  paceStateText,
  type BudgetEditorState,
  displayProvider,
  formatDuration,
  formatResetCountdown,
  groupProviderCards,
  quotaPercent,
  quotaStale,
  quotaWindowLabel,
  type BudgetRow,
  type ProviderCardModel,
  type QuotaRow,
} from "~/lib/provider-quota";
import { StateCard } from "./StateCard";

type Providers = CostsSnapshot["providers"];
type Quotas = CostsSnapshot["quotas"];
type Budgets = CostsSnapshot["provider_budgets"];

function count(value: number): string {
  return new Intl.NumberFormat().format(value);
}

const Row: Component<{ label: string; children: JSX.Element }> = (props) => (
  <div class="flex items-baseline justify-between gap-3 text-xs">
    <span class="text-muted">{props.label}</span>
    <span class="tabular-nums">{props.children}</span>
  </div>
);

function quotaTone(percent: number): string {
  return percent < 60
    ? "bg-chart-accent"
    : percent < 85
      ? "bg-chart-emphasis"
      : "bg-danger";
}

/** 5h/7d always render; other windows need a usable numeric field. */
function visibleQuotas(card: ProviderCardModel): QuotaRow[] {
  return card.quotas.filter(
    (q) =>
      q.window === "5h" ||
      q.window === "7d" ||
      q.used_percent !== null ||
      (q.limit !== null && q.remaining !== null),
  );
}

const QuotaLine: Component<{
  quota: QuotaRow;
  now: () => number;
  pace: BudgetRow | null;
}> = (props) => {
  const percent = () => quotaPercent(props.quota);
  const label = () => quotaWindowLabel(props.quota);
  const stale = () => quotaStale(props.quota, props.now());
  const evenPace = () => evenPacePercent(props.pace);
  const paceState = () => paceStateText(props.pace, stale());
  const paceTone = () =>
    (props.pace?.pressure ?? 0) > 0 && !stale() ? "text-danger" : "text-muted";
  return (
    <div>
      <div class="flex justify-between gap-3 text-xs">
        <span class={stale() ? "text-muted" : "font-medium"}>{label()}</span>
        <Show
          when={!stale()}
          fallback={
            <span class="text-muted">
              last seen {formatDuration(props.now() - props.quota.observed_at)}{" "}
              ago, may have reset
            </span>
          }
        >
          <Show
            when={percent() !== null}
            fallback={
              <span class="text-muted">
                {props.quota.remaining !== null &&
                  `remaining ${count(props.quota.remaining)}`}
                {props.quota.remaining !== null &&
                  props.quota.limit !== null &&
                  " · "}
                {props.quota.limit !== null &&
                  `limit ${count(props.quota.limit)}`}
              </span>
            }
          >
            <span class="text-muted">
              {formatResetCountdown(props.quota.resets_at, props.now())}
            </span>
          </Show>
        </Show>
      </div>
      <Show when={percent() !== null && !stale()}>
        <div
          class="relative mt-1.5 h-2 overflow-hidden rounded-full bg-soft"
          role="progressbar"
          aria-label={`${label()} used`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent()!}
        >
          <div
            class={`h-full ${quotaTone(percent()!)}`}
            style={{ width: `${Math.min(100, percent()!)}%` }}
          />
          <Show when={evenPace() !== null}>
            <div
              class="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-foreground/70"
              style={{ left: `${evenPace()}%` }}
              data-testid="pace-tick"
              data-pace={evenPace()!.toFixed(1)}
              title="Even pace"
              aria-hidden="true"
            />
          </Show>
        </div>
      </Show>
      <Show when={paceState()}>
        <div class={`mt-1 text-[11px] ${paceTone()}`} data-testid="pace-state">
          {paceState()}
        </div>
      </Show>
      <div class="mt-1 text-[11px] text-muted">
        observed {formatWhen(props.quota.observed_at)}
      </div>
    </div>
  );
};

function budgetLabel(budget: BudgetRow): string {
  if (budget.mode === "pace") return `Pace · ${budget.window}`;
  if (budget.mode === "off") return `Pace off · ${budget.window}`;
  const unit =
    budget.unit === "usd"
      ? "USD"
      : budget.unit === "tokens"
        ? "Tokens"
        : "Quota";
  return `${unit} cap · ${budget.window}`;
}

function budgetValue(
  budget: BudgetRow,
  money: (usd: number) => string,
): string {
  if (budget.mode === "off") return "off";
  if (budget.used === null) return "—";
  if (budget.mode === "pace") {
    return budget.target === null
      ? `${budget.used.toFixed(0)}%`
      : `${budget.used.toFixed(0)}% / ${budget.target.toFixed(0)}% pace`;
  }
  const amount = budget.amount ?? 0;
  if (budget.unit === "usd") return `${money(budget.used)} / ${money(amount)}`;
  if (budget.unit === "tokens") {
    return `${count(budget.used)} / ${count(amount)}`;
  }
  return `${budget.used.toFixed(0)}% / ${amount.toFixed(0)}%`;
}

const BudgetLine: Component<{
  budget: BudgetRow;
  money: (usd: number) => string;
}> = (props) => (
  <div class="flex items-baseline justify-between gap-3 text-xs">
    <span class="text-muted">{budgetLabel(props.budget)}</span>
    <span
      class={`tabular-nums ${props.budget.pressure >= 1 ? "text-danger" : ""}`}
    >
      {budgetValue(props.budget, props.money)}
      {props.budget.stale ? " (stale)" : ""}
    </span>
  </div>
);

function showError(error: unknown): string {
  return isApiError(error) ? error.message : String(error);
}

const inputClass =
  "h-8 w-20 rounded-md border border-line bg-bg px-2 text-xs tabular-nums";

const BudgetEditor: Component<{
  card: ProviderCardModel;
  budgets: BudgetRow[];
  onSave: (budgets: ProviderBudgetInput[]) => Promise<void>;
  onClose: () => void;
}> = (props) => {
  const [state, setState] = createSignal<BudgetEditorState>(
    budgetEditorState(props.budgets, props.card),
  );
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const submit = async () => {
    const next = applyBudgetEditor(props.budgets, props.card, state());
    if (typeof next === "string") {
      setError(next);
      return;
    }
    setBusy(true);
    setError("");
    try {
      await props.onSave(next);
      props.onClose();
    } catch (reason) {
      setError(showError(reason));
    } finally {
      setBusy(false);
    }
  };
  const sub = () => {
    const current = state();
    return current.kind === "subscription" ? current : null;
  };
  const key = () => {
    const current = state();
    return current.kind === "api_key" ? current : null;
  };
  return (
    <form
      class="mt-3 space-y-3 border-t border-line pt-3 text-xs"
      data-testid="budget-editor"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Show when={sub()}>
        {(current) => (
          <For each={PACE_WINDOWS}>
            {(w) => (
              <fieldset class="space-y-1.5">
                <legend class="font-medium">
                  {w === "5h" ? "5-hour window" : "Weekly window"}
                </legend>
                <div class="flex flex-wrap items-center gap-3">
                  <label class="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={current().windows[w].pace}
                      aria-label={`Pace the ${w} window`}
                      onChange={(event) => {
                        const checked = event.currentTarget.checked;
                        setState((prev) =>
                          prev.kind === "subscription"
                            ? {
                                ...prev,
                                windows: {
                                  ...prev.windows,
                                  [w]: { ...prev.windows[w], pace: checked },
                                },
                              }
                            : prev,
                        );
                      }}
                    />
                    Pace
                  </label>
                  <label class="flex items-center gap-1.5 text-muted">
                    headroom
                    <input
                      class={inputClass}
                      type="text"
                      inputMode="decimal"
                      disabled={!current().windows[w].pace}
                      value={current().windows[w].headroom}
                      aria-label={`Pace headroom for the ${w} window (points)`}
                      onInput={(event) => {
                        const value = event.currentTarget.value;
                        setState((prev) =>
                          prev.kind === "subscription"
                            ? {
                                ...prev,
                                windows: {
                                  ...prev.windows,
                                  [w]: { ...prev.windows[w], headroom: value },
                                },
                              }
                            : prev,
                        );
                      }}
                    />
                    pts
                  </label>
                  <label class="flex items-center gap-1.5 text-muted">
                    cap
                    <input
                      class={inputClass}
                      type="text"
                      inputMode="decimal"
                      placeholder="none"
                      value={current().windows[w].cap}
                      aria-label={`Quota cap for the ${w} window (%)`}
                      onInput={(event) => {
                        const value = event.currentTarget.value;
                        setState((prev) =>
                          prev.kind === "subscription"
                            ? {
                                ...prev,
                                windows: {
                                  ...prev.windows,
                                  [w]: { ...prev.windows[w], cap: value },
                                },
                              }
                            : prev,
                        );
                      }}
                    />
                    %
                  </label>
                </div>
              </fieldset>
            )}
          </For>
        )}
      </Show>
      <Show when={key()}>
        {(current) => (
          <div class="grid grid-cols-2 gap-2">
            <For each={CAP_FIELDS}>
              {(field) => (
                <label class="flex items-center justify-between gap-2 text-muted">
                  {field.label}
                  <input
                    class={inputClass}
                    type="text"
                    inputMode="decimal"
                    placeholder="none"
                    value={current().caps[field.key]}
                    aria-label={field.label}
                    onInput={(event) => {
                      const value = event.currentTarget.value;
                      setState((prev) =>
                        prev.kind === "api_key"
                          ? {
                              ...prev,
                              caps: { ...prev.caps, [field.key]: value },
                            }
                          : prev,
                      );
                    }}
                  />
                </label>
              )}
            </For>
          </div>
        )}
      </Show>
      <Show when={error()}>
        <p class="text-danger" role="alert">
          {error()}
        </p>
      </Show>
      <div class="flex gap-2">
        <Button
          pending={busy()}
          icon="save"
          size="sm"
          type="submit"
          disabled={busy()}
        >
          {busy() ? "Saving…" : "Save budgets"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          type="button"
          disabled={busy()}
          onClick={() => props.onClose()}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
};

const ProviderCard: Component<{
  card: ProviderCardModel;
  money: (usd: number) => string;
  now: () => number;
  budgets: BudgetRow[];
  allBudgets: BudgetRow[];
  onSaveBudgets?: (budgets: ProviderBudgetInput[]) => Promise<void>;
}> = (props) => {
  const [editing, setEditing] = createSignal(false);
  return (
    <section
      class="rounded-lg border border-line bg-bg p-4"
      data-testid="provider-card"
      data-provider={props.card.provider}
      data-auth-kind={props.card.auth_kind}
    >
      <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div class="flex min-w-0 items-center gap-2">
          <h3 class="truncate font-semibold">
            {displayProvider(props.card.provider)}
          </h3>
          <span class="rounded-full border border-line bg-soft px-2 py-0.5 text-[10px] font-medium text-muted">
            {props.card.auth_kind === "subscription"
              ? "Subscription"
              : "API key"}
          </span>
        </div>
        <span class="font-mono text-[11px] text-muted">
          {props.card.account === "default"
            ? "default account"
            : `acct ${props.card.account}`}
        </span>
      </div>

      <Show
        when={props.card.costs}
        fallback={
          <div class="space-y-2">
            <Row label="Spend">—</Row>
            <Row label="Last activity">—</Row>
          </div>
        }
      >
        {(costs) => (
          <div class="space-y-2">
            <Row label="Spend">{props.money(costs().spend)}</Row>
            <Row label="Today">{props.money(costs().today_spend)}</Row>
            <Row label="Requests">{count(costs().requests)}</Row>
            <Row label="Input tokens">{count(costs().input_tokens)}</Row>
            <Row label="Output tokens">{count(costs().output_tokens)}</Row>
            <Row label="Cached tokens">
              {count(costs().cache_read_tokens)}
              <Show when={costs().cache_write_tokens > 0}>
                <span class="text-muted">
                  {" "}
                  · {count(costs().cache_write_tokens)} written
                </span>
              </Show>
            </Row>
            <Row label="Last activity">{costs().last_day ?? "—"}</Row>
          </div>
        )}
      </Show>

      <Show when={visibleQuotas(props.card).length > 0}>
        <div class="mt-3 space-y-3 border-t border-line pt-3">
          <For each={visibleQuotas(props.card)}>
            {(quota) => (
              <QuotaLine
                quota={quota}
                now={props.now}
                pace={paceFor(props.budgets, props.card, quota.window)}
              />
            )}
          </For>
        </div>
      </Show>

      <Show when={props.budgets.length > 0}>
        <div class="mt-3 space-y-2 border-t border-line pt-3">
          <div class="text-[11px] font-medium uppercase tracking-wide text-muted">
            Budgets
          </div>
          <For each={props.budgets}>
            {(budget) => <BudgetLine budget={budget} money={props.money} />}
          </For>
        </div>
      </Show>

      <Show when={props.onSaveBudgets}>
        {(onSave) => (
          <Show
            when={editing()}
            fallback={
              <div class="mt-3">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setEditing(true)}
                >
                  Edit budgets
                </Button>
              </div>
            }
          >
            <BudgetEditor
              card={props.card}
              budgets={props.allBudgets}
              onSave={onSave()}
              onClose={() => setEditing(false)}
            />
          </Show>
        )}
      </Show>
    </section>
  );
};

export const ProviderCards: Component<{
  providers: Providers;
  quotas: Quotas;
  budgets?: Budgets;
  money: (usd: number) => string;
  now?: () => number;
  /** Present when budgets are editable (not hosted mode). */
  onSaveBudgets?: (budgets: ProviderBudgetInput[]) => Promise<void>;
}> = (props) => {
  const [tick, setTick] = createSignal(Date.now());
  const timer = setInterval(() => setTick(Date.now()), 30_000);
  onCleanup(() => clearInterval(timer));
  const now = () => props.now?.() ?? tick();
  const cards = () => groupProviderCards(props.providers, props.quotas);

  return (
    <section class="mb-6">
      <h2 class="font-semibold">Spend by provider</h2>
      <p class="mt-1 text-xs text-muted">
        Persisted across restarts · API-key vs subscription accounts are tracked
        separately.
      </p>
      <Show
        when={cards().length > 0}
        fallback={
          <div class="mt-3">
            <StateCard kind="empty" title="No provider costs yet">
              Provider attribution starts with the first proxied request.
            </StateCard>
          </div>
        }
      >
        <div class="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <For each={cards()}>
            {(card) => (
              <ProviderCard
                card={card}
                money={props.money}
                now={now}
                budgets={budgetsForCard(props.budgets ?? [], card)}
                allBudgets={props.budgets ?? []}
                onSaveBudgets={props.onSaveBudgets}
              />
            )}
          </For>
        </div>
      </Show>
    </section>
  );
};
