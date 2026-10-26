/** Global cache-warming controls and live decision telemetry (UI-08). */
import type { Component } from "solid-js";
import { createSignal, For, onMount, Show } from "solid-js";
import { A } from "@solidjs/router";

import type { WarmingSnapshot } from "~/contracts";
import { formatFullDate } from "~/lib/format";
import { isApiError } from "~/lib/api";
import { useWorkspace } from "~/routes/workspace";
import { Button } from "~/components/ui/button";
import { errorStateFor } from "./ErrorState";
import { StateCard } from "./StateCard";

function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  const hours = ms / 3_600_000;
  return `${hours < 10 ? hours.toFixed(1) : Math.floor(hours)}h`;
}

function shortId(value: string) {
  return value.length > 18 ? `${value.slice(0, 9)}…${value.slice(-6)}` : value;
}

function actionError(error: unknown): string {
  return isApiError(error) ? error.message : String(error);
}

export const WarmingPage: Component = () => {
  const ws = useWorkspace();
  const [snapshot, setSnapshot] = createSignal<WarmingSnapshot>();
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<unknown>();
  const [actionMessage, setActionMessage] = createSignal("");
  const [busy, setBusy] = createSignal<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(undefined);
    try {
      setSnapshot(await ws.tracked(() => ws.client.getWarming()));
    } catch (reason) {
      setError(reason);
    } finally {
      setLoading(false);
    }
  };

  const act = async (key: string, run: () => Promise<unknown>) => {
    setBusy(key);
    setActionMessage("");
    try {
      await ws.tracked(run);
      await load();
    } catch (reason) {
      setActionMessage(actionError(reason));
    } finally {
      setBusy(null);
    }
  };

  onMount(() => void load());

  const activeSessions = () =>
    (snapshot()?.sessions ?? []).filter((row) => row.warming !== null);
  const userStopped = (row: WarmingSnapshot["sessions"][number]) =>
    row.warming?.user_stopped ??
    row.warming?.reason === "Warming stopped by user";
  const mode = (row: WarmingSnapshot["sessions"][number]) =>
    userStopped(row) ? "stop" : row.warming?.force_keep_warm ? "keep" : "auto";

  return (
    <div
      class="mx-auto max-w-[1100px] px-5 py-8 sm:px-7.5"
      data-testid="warming-page"
    >
      <div class="eyebrow mb-2">Operations</div>
      <h1 class="mb-1 text-[25px] font-semibold">Cache warming</h1>
      <p class="mb-6 max-w-prose text-sm text-muted">
        Watch the gateway’s cache refresh decisions and control warming for the
        whole gateway or an individual live session.
      </p>

      <Show when={actionMessage()}>
        <StateCard kind="error" title="The action could not be completed">
          {actionMessage()}
        </StateCard>
      </Show>

      <Show when={snapshot() && error()}>
        <StateCard
          kind="error"
          title="Could not refresh cache-warming data"
          compact
          action={
            <Button
              size="sm"
              class="h-11 md:h-9"
              variant="outline"
              onClick={() => void load()}
            >
              Retry
            </Button>
          }
        >
          Showing the last successful snapshot. {actionError(error())}
        </StateCard>
      </Show>

      <Show
        when={snapshot()}
        fallback={
          loading() ? (
            <StateCard kind="loading" title="Loading cache warming" />
          ) : (
            errorStateFor(error(), "Cache warming", () => void load())
          )
        }
      >
        {(data) => (
          <>
            <section class="mb-5 flex flex-wrap items-center gap-4 rounded-lg border border-line bg-bg p-4">
              <div class="w-full min-w-0 sm:w-auto sm:flex-1">
                <div class="text-sm font-semibold">
                  Cache warming is{" "}
                  <span class={data().enabled ? "text-accent" : "text-danger"}>
                    {data().enabled ? "ON" : "OFF"}
                  </span>
                </div>
                <p class="mt-1 text-sm text-muted">
                  {data().summary.live_sessions} live{" "}
                  {data().summary.live_sessions === 1 ? "session" : "sessions"}{" "}
                  · {data().summary.warming_now} warming now
                </p>
                <p class="mt-1 text-xs text-muted">
                  {data().env_forced
                    ? "Controlled by LORE_WARMING_ENABLED."
                    : data().override === null
                      ? "Following the cache.warming.enabled config default."
                      : "A runtime override is saved for this gateway."}
                </p>
              </div>
              <Button
                pending={busy() === "enabled"}
                icon="save"
                size="sm"
                class="h-11 md:h-9"
                disabled={!data().can_toggle || busy() === "enabled"}
                onClick={() =>
                  void act("enabled", () =>
                    ws.client.setWarmingEnabled(!data().enabled),
                  )
                }
              >
                {busy() === "enabled"
                  ? "Saving…"
                  : data().enabled
                    ? "Disable warming"
                    : "Enable warming"}
              </Button>
            </section>

            <Show when={data().circuit_breaker.tripped_count > 0}>
              <section
                class="mb-6 rounded-lg border border-danger/40 bg-danger-soft p-4"
                data-testid="warming-breaker"
              >
                <div class="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 class="font-semibold text-danger">
                      {data().circuit_breaker.tripped_count} circuit breaker
                      bucket
                      {data().circuit_breaker.tripped_count === 1
                        ? ""
                        : "s"}{" "}
                      tripped
                    </h2>
                    <p class="mt-1 max-w-prose text-xs text-muted">
                      These session, model and upstream route combinations stop
                      warming after repeated cache mismatches. They recover
                      automatically after six hours, or you can reset them now.
                    </p>
                  </div>
                  <Button
                    pending={busy() === "reset"}
                    size="sm"
                    class="h-11 md:h-9"
                    variant="outline"
                    disabled={!data().can_edit || busy() === "reset"}
                    onClick={() =>
                      void act("reset", () =>
                        ws.client.resetWarmingCircuitBreaker(),
                      )
                    }
                  >
                    {busy() === "reset"
                      ? "Resetting…"
                      : "Reset circuit breakers"}
                  </Button>
                </div>
                <details class="mt-3">
                  <summary class="min-h-11 cursor-pointer content-center text-sm font-semibold focus-visible:outline-2 focus-visible:outline-accent md:min-h-0">
                    Circuit breaker details
                  </summary>
                  <ul class="mt-3 space-y-1 text-xs [overflow-wrap:anywhere]">
                    <For each={data().circuit_breaker.entries}>
                      {(entry) => (
                        <li>
                          <code>{shortId(entry.session_id)}</code>
                          <span class="text-muted">
                            {" "}
                            · {entry.model} · {entry.upstream} · tripped{" "}
                          </span>
                          <time
                            dateTime={new Date(entry.tripped_at).toISOString()}
                          >
                            {formatFullDate(entry.tripped_at)}
                          </time>
                        </li>
                      )}
                    </For>
                  </ul>
                </details>
              </section>
            </Show>

            <section class="mb-7">
              <div class="mb-3 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 class="text-lg font-semibold">Live sessions</h2>
                  <p class="text-xs text-muted">
                    Per-session controls apply while a session is active.
                  </p>
                </div>
                <Button
                  size="sm"
                  class="h-11 md:h-9"
                  variant="outline"
                  onClick={() => void load()}
                >
                  Refresh
                </Button>
              </div>
              <Show
                when={activeSessions().length > 0}
                fallback={
                  <StateCard kind="empty" title="No active sessions">
                    Warming data appears after conversations pass through this
                    gateway.
                  </StateCard>
                }
              >
                <div class="space-y-3">
                  <For each={activeSessions()}>
                    {(row) => (
                      <article class="min-w-0 rounded-lg border border-line bg-bg p-3 [overflow-wrap:anywhere]">
                        <div class="flex flex-wrap items-start justify-between gap-3">
                          <div class="min-w-0">
                            <div class="text-sm font-semibold">
                              <Show
                                when={row.project_id}
                                fallback={row.project_name ?? "Project unknown"}
                              >
                                {(id) => (
                                  <A
                                    class="inline-flex min-h-11 items-center text-accent hover:underline md:min-h-0"
                                    href={`/projects/${encodeURIComponent(id())}`}
                                  >
                                    {row.project_name ??
                                      row.project_path ??
                                      "Project"}
                                  </A>
                                )}
                              </Show>
                            </div>
                            <div class="mt-1 text-sm">
                              {row.warming?.should_warm
                                ? "Warming now"
                                : userStopped(row)
                                  ? "Stopped"
                                  : row.warming?.disabled
                                    ? "Paused by survival"
                                    : row.warming?.phase === "none"
                                      ? "Idle"
                                      : "Waiting"}
                            </div>
                            <p class="mt-1 text-xs text-muted">
                              {row.warming?.reason ??
                                `Cache ${row.warming?.ttl ?? "TTL unknown"}`}
                            </p>
                            <p
                              class="mt-1 text-xs text-muted"
                              title={row.session_id}
                            >
                              {shortId(row.session_id)}
                              {row.is_subagent ? " · child" : ""}
                            </p>
                          </div>
                          <div class="flex flex-wrap gap-1">
                            <For each={["keep", "stop", "auto"] as const}>
                              {(nextMode) => (
                                <Button
                                  size="sm"
                                  class="h-11 md:h-9"
                                  variant={
                                    mode(row) === nextMode
                                      ? "default"
                                      : "outline"
                                  }
                                  disabled={
                                    !data().can_edit ||
                                    busy() === `session:${row.session_id}`
                                  }
                                  aria-pressed={mode(row) === nextMode}
                                  aria-label={`${nextMode} warming for ${row.session_id}`}
                                  onClick={() =>
                                    void act(`session:${row.session_id}`, () =>
                                      ws.client.setSessionWarmingMode(
                                        row.session_id,
                                        nextMode,
                                      ),
                                    )
                                  }
                                >
                                  {nextMode === "keep"
                                    ? "Keep"
                                    : nextMode === "stop"
                                      ? "Stop"
                                      : "Auto"}
                                </Button>
                              )}
                            </For>
                          </div>
                        </div>
                        <details class="mt-2 border-t border-line pt-2">
                          <summary class="min-h-11 cursor-pointer content-center text-sm font-semibold focus-visible:outline-2 focus-visible:outline-accent md:min-h-0">
                            Session diagnostics
                          </summary>
                          <dl class="mt-2 grid grid-cols-2 gap-2 text-xs">
                            <dt>Turns</dt>
                            <dd>{row.turns}</dd>
                            <dt>Idle</dt>
                            <dd>{duration(row.warming?.idle_ms ?? 0)}</dd>
                            <dt>P(return)</dt>
                            <dd>
                              {((row.warming?.p_returns ?? 0) * 100).toFixed(1)}
                              %
                            </dd>
                            <dt>Hits / warmups</dt>
                            <dd>
                              {row.warming?.warmup_hits}/
                              {row.warming?.total_warmups}
                            </dd>
                          </dl>
                        </details>
                      </article>
                    )}
                  </For>
                </div>
              </Show>
            </section>

            <details class="mb-5 rounded-lg border border-line p-3">
              <summary class="min-h-11 cursor-pointer content-center text-sm font-semibold focus-visible:outline-2 focus-visible:outline-accent md:min-h-0">
                Warming statistics
              </summary>
              <div class="mt-3">
                <div class="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
                  <Stat
                    label="Live sessions"
                    value={data().summary.live_sessions}
                  />
                  <Stat
                    label="Warming now"
                    value={data().summary.warming_now}
                  />
                  <Stat
                    label="Disabled sessions"
                    value={data().summary.disabled_sessions}
                  />
                  <Stat
                    label="Total warmups"
                    value={data().summary.total_warmups}
                  />
                  <Stat
                    label="Hit rate"
                    value={
                      data().summary.hit_rate === null
                        ? "—"
                        : `${((data().summary.hit_rate ?? 0) * 100).toFixed(0)}%`
                    }
                  />
                  <Stat
                    label="Tripped buckets"
                    value={data().summary.tripped_buckets}
                  />
                </div>
              </div>
            </details>
            <details class="rounded-lg border border-line p-3">
              <summary class="min-h-11 cursor-pointer content-center text-sm font-semibold focus-visible:outline-2 focus-visible:outline-accent md:min-h-0">
                Project histograms
              </summary>
              <p class="mb-3 text-xs text-muted">
                Historical inter-turn gaps form the prior used for projects with
                little session history.
              </p>
              <Show
                when={data().histograms.length > 0}
                fallback={
                  <StateCard kind="empty" title="No histogram data yet">
                    Histograms fill as conversations are observed.
                  </StateCard>
                }
              >
                <div class="space-y-3">
                  <For each={data().histograms}>
                    {(hist) => (
                      <details class="rounded-lg border border-line bg-bg p-3">
                        <summary class="min-h-11 cursor-pointer content-center text-sm font-semibold focus-visible:outline-2 focus-visible:outline-accent md:min-h-0">
                          {hist.project_name ?? hist.project_id}
                          <span class="ml-2 text-xs font-normal text-muted">
                            {hist.total} observations
                          </span>
                        </summary>
                        <div
                          class="mt-4 flex h-20 items-end gap-1 border-b border-line"
                          aria-label={`Inter-turn gap histogram for ${hist.project_name ?? hist.project_id}`}
                        >
                          <For each={hist.counts}>
                            {(count, index) => {
                              const max = Math.max(1, ...hist.counts);
                              const edge = hist.bins_ms[index()];
                              const label =
                                edge === undefined
                                  ? `>${duration(hist.bins_ms.at(-1) ?? 0)}`
                                  : `≤${duration(edge)}`;
                              return (
                                <div class="flex min-w-0 flex-1 flex-col items-center justify-end">
                                  <div
                                    class="w-full rounded-t bg-chart-accent"
                                    title={`${label}: ${count}`}
                                    style={{
                                      height: `${Math.max(2, (count / max) * 64)}px`,
                                    }}
                                  />
                                  <span class="mt-1 text-[9px] text-muted">
                                    {index() % 2 === 0 ? label : ""}
                                  </span>
                                </div>
                              );
                            }}
                          </For>
                        </div>
                      </details>
                    )}
                  </For>
                </div>
              </Show>
            </details>
          </>
        )}
      </Show>
    </div>
  );
};

const Stat: Component<{ label: string; value: string | number }> = (props) => (
  <div class="rounded-lg border border-line bg-bg px-3.5 py-3">
    <div class="text-[11px] text-muted">{props.label}</div>
    <div class="mt-1 text-lg font-semibold">{props.value}</div>
  </div>
);
