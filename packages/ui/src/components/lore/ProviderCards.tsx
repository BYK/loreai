/** Per-provider spend cards + subscription quota windows (#1926 UI half). */
import type { Component, JSX } from "solid-js";
import { createSignal, For, onCleanup, Show } from "solid-js";

import type { CostsSnapshot, ProviderPacingInput } from "~/contracts";
import { isApiError } from "~/lib/api";
import { formatWhen } from "~/lib/format";
import {
  displayProvider,
  effectivePacingState,
  formatExtraGap,
  formatDuration,
  formatRate,
  formatResetCountdown,
  groupProviderCards,
  pacingForCard,
  pacingStateText,
  quotaPercent,
  quotaStale,
  quotaWindowLabel,
  type PacingRow,
  type PacingWindowRow,
  type ProviderCardModel,
  type QuotaRow,
} from "~/lib/provider-quota";
import { StateCard } from "./StateCard";

type Providers = CostsSnapshot["providers"];
type Quotas = CostsSnapshot["quotas"];
type Pacing = CostsSnapshot["provider_pacing"];

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
  pacing: PacingWindowRow | null;
  enabled: boolean;
}> = (props) => {
  const percent = () => quotaPercent(props.quota);
  const label = () => quotaWindowLabel(props.quota);
  const stale = () => quotaStale(props.quota, props.now());
  const pacing = () => (stale() ? null : props.pacing);
  const paceTone = () =>
    props.enabled && pacing()?.throttling ? "text-danger" : "text-muted";
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
        </div>
      </Show>
      <Show when={pacing()}>
        {(w) => (
          <>
            <div
              class="mt-1 flex justify-between gap-3 text-[11px] text-muted"
              data-testid="pacing-rates"
            >
              <span>sustainable {formatRate(w().sustainable_rate)}</span>
              <span>
                current {formatRate(w().current_rate)}
                {w().rate_source === "average" ? " (window avg)" : ""}
              </span>
            </div>
            <div
              class={`mt-0.5 text-[11px] ${paceTone()}`}
              data-testid="pacing-state"
            >
              {pacingStateText(w(), props.enabled)}
            </div>
          </>
        )}
      </Show>
      <div class="mt-1 text-[11px] text-muted">
        observed {formatWhen(props.quota.observed_at)}
      </div>
    </div>
  );
};

function showError(error: unknown): string {
  return isApiError(error) ? error.message : String(error);
}

const PacingControl: Component<{
  card: ProviderCardModel;
  pacing: PacingRow;
  now: () => number;
  onSetPacing?: (setting: ProviderPacingInput) => Promise<void>;
}> = (props) => {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const effectivePacing = () => effectivePacingState(props.pacing, props.now());
  const toggle = async () => {
    const onSet = props.onSetPacing;
    if (!onSet) return;
    setBusy(true);
    setError("");
    try {
      await onSet({
        provider: props.card.provider,
        account: props.card.account,
        enabled: !props.pacing.enabled,
      });
    } catch (reason) {
      setError(showError(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      class="mt-3 space-y-2 border-t border-line pt-3"
      data-testid="pacing-control"
    >
      <div class="flex items-center justify-between gap-3 text-xs">
        <span class="font-medium">Automatic pacing</span>
        <button
          type="button"
          role="switch"
          aria-checked={props.pacing.enabled}
          aria-label="Automatic pacing"
          disabled={!props.onSetPacing || busy()}
          class={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-line transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
            props.pacing.enabled ? "bg-accent" : "bg-soft"
          }`}
          onClick={() => void toggle()}
        >
          <span
            class={`inline-block h-3.5 w-3.5 rounded-full bg-bg shadow transition-transform ${
              props.pacing.enabled ? "translate-x-4" : "translate-x-0.5"
            }`}
          />
        </button>
      </div>
      <Row label="Estimated extra request gap (informational)">
        <span data-testid="pacing-extra-gap">
          {props.pacing.enabled
            ? formatExtraGap(effectivePacing().recommended_extra_gap_ms)
            : "off"}
        </span>
      </Row>
      <Row label="Quota-based curation pause">
        <span
          class={
            props.pacing.enabled && effectivePacing().throttling
              ? "text-danger"
              : "text-muted"
          }
          data-testid="pacing-curation-state"
        >
          {props.pacing.enabled && effectivePacing().throttling
            ? "active"
            : "inactive"}
        </span>
      </Row>
      <p class="text-[11px] text-muted">
        {props.pacing.enabled
          ? "Quota pressure pauses non-urgent background curation. "
          : "Quota-based pauses for non-urgent background curation are off. "}
        The gap estimate is informational only. Provider pacing never delays
        user requests.
      </p>
      <Show when={error()}>
        <p class="text-[11px] text-danger" role="alert">
          {error()}
        </p>
      </Show>
    </div>
  );
};

const ProviderCard: Component<{
  card: ProviderCardModel;
  money: (usd: number) => string;
  now: () => number;
  pacing: PacingRow | null;
  onSetPacing?: (setting: ProviderPacingInput) => Promise<void>;
}> = (props) => {
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
                pacing={
                  props.pacing?.windows.find(
                    (w) => w.window === quota.window,
                  ) ?? null
                }
                enabled={props.pacing?.enabled ?? false}
              />
            )}
          </For>
        </div>
      </Show>

      <Show when={props.pacing}>
        {(pacing) => (
          <PacingControl
            card={props.card}
            pacing={pacing()}
            now={props.now}
            onSetPacing={props.onSetPacing}
          />
        )}
      </Show>
    </section>
  );
};

export const ProviderCards: Component<{
  providers: Providers;
  quotas: Quotas;
  pacing?: Pacing;
  money: (usd: number) => string;
  now?: () => number;
  /** Present when pacing is switchable (not hosted mode). */
  onSetPacing?: (setting: ProviderPacingInput) => Promise<void>;
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
                pacing={pacingForCard(props.pacing ?? [], card)}
                onSetPacing={props.onSetPacing}
              />
            )}
          </For>
        </div>
      </Show>
    </section>
  );
};
