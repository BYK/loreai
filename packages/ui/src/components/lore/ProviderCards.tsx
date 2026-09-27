/** Per-provider spend cards + subscription quota windows (#1926 UI half). */
import type { Component, JSX } from "solid-js";
import { createSignal, For, onCleanup, Show } from "solid-js";

import type { CostsSnapshot } from "~/contracts";
import { formatWhen } from "~/lib/format";
import {
  displayProvider,
  formatResetCountdown,
  groupProviderCards,
  quotaPercent,
  quotaWindowLabel,
  type ProviderCardModel,
  type QuotaRow,
} from "~/lib/provider-quota";
import { StateCard } from "./StateCard";

type Providers = CostsSnapshot["providers"];
type Quotas = CostsSnapshot["quotas"];

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
  return percent < 60 ? "bg-accent" : percent < 85 ? "bg-gold" : "bg-danger";
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

const QuotaLine: Component<{ quota: QuotaRow; now: () => number }> = (
  props,
) => {
  const percent = () => quotaPercent(props.quota);
  const label = () => quotaWindowLabel(props.quota);
  return (
    <div>
      <div class="flex justify-between gap-3 text-xs">
        <span class="font-medium">{label()}</span>
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
      </div>
      <Show when={percent() !== null}>
        <div
          class="mt-1.5 h-2 overflow-hidden rounded-full bg-soft"
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
        </div>
      </Show>
      <div class="mt-1 text-[11px] text-muted">
        observed {formatWhen(props.quota.observed_at)}
      </div>
    </div>
  );
};

const ProviderCard: Component<{
  card: ProviderCardModel;
  money: (usd: number) => string;
  now: () => number;
}> = (props) => (
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
          {props.card.auth_kind === "subscription" ? "Subscription" : "API key"}
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
          {(quota) => <QuotaLine quota={quota} now={props.now} />}
        </For>
      </div>
    </Show>
  </section>
);

export const ProviderCards: Component<{
  providers: Providers;
  quotas: Quotas;
  money: (usd: number) => string;
  now?: () => number;
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
              <ProviderCard card={card} money={props.money} now={now} />
            )}
          </For>
        </div>
      </Show>
    </section>
  );
};
