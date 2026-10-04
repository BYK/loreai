/**
 * Context window pane (#1924): what the model actually saw for this session,
 * built from `GET /sessions/:id/context` — accepted gradient layer and
 * sent-vs-raw volume, the live distilled prefix, injected knowledge,
 * durable prompt-delta updates, and per-turn transform stats. Every section
 * is honest about what is recorded: no counts or layers are invented when
 * the gateway could not derive them. All server text renders as inert text.
 */
import type { Component, JSX } from "solid-js";
import { For, Show } from "solid-js";
import { A } from "@solidjs/router";

import { StateCard } from "~/components/lore/StateCard";
import { Badge } from "~/components/ui/badge";
import { isApiError } from "~/lib/api";
import { formatWhen } from "~/lib/format";
import type {
  SessionContext,
  SessionContextDelta,
  SessionContextTurn,
} from "~/contracts";

import { BlockTime } from "./SessionBlock";

/** Gradient transform layers (see AGENTS.md / gradient.ts). */
const LAYER_LABEL = [
  "passthrough",
  "distilled prefix",
  "tool-output stripped",
  "emergency",
] as const;

function layerLabel(layer: number): string {
  return `Layer ${layer} · ${LAYER_LABEL[layer] ?? "unknown"}`;
}

function tokens(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : value.toLocaleString();
}

function ratio(turn: SessionContextTurn): string {
  if (turn.total_tokens <= 0 || turn.raw_tokens <= 0) return "—";
  // The transform can send more than the raw capture (e.g. injected
  // knowledge) — a sub-1.0 raw/total is expansion, not compression.
  return turn.raw_tokens >= turn.total_tokens
    ? `×${(turn.raw_tokens / turn.total_tokens).toFixed(1)} compression`
    : `×${(turn.total_tokens / turn.raw_tokens).toFixed(1)} expansion`;
}

const Card: Component<{ title: string; children: JSX.Element }> = (props) => (
  <section class="rounded-md border border-line bg-soft/40 px-3.5 py-3 text-[13px]">
    <div class="eyebrow mb-2">{props.title}</div>
    {props.children}
  </section>
);

function latestTurn(ctx: SessionContext): SessionContextTurn | null {
  let latest: SessionContextTurn | null = null;
  for (const turn of ctx.turns) {
    if (!latest || turn.created_at >= latest.created_at) latest = turn;
  }
  return latest;
}

const SummarySection: Component<{ context: SessionContext }> = (props) => {
  const turn = () => latestTurn(props.context);
  return (
    <Card title="Sent vs raw">
      <Show
        when={turn()}
        fallback={
          <div data-testid="context-summary">
            <p class="text-muted">
              No per-turn stats recorded yet — Lore records them for sessions
              proxied after this build.
            </p>
            <Show when={props.context.layer !== null}>
              <Badge variant="gold">{layerLabel(props.context.layer!)}</Badge>
            </Show>
            <Show when={props.context.history.message_count > 0}>
              <p class="mt-1.5 text-xs text-muted">
                {props.context.history.message_count.toLocaleString()} captured
                messages · ≈{tokens(props.context.history.token_estimate)} raw
                tokens
              </p>
            </Show>
          </div>
        }
      >
        {(t) => (
          <div data-testid="context-summary" class="flex flex-col gap-1.5">
            <div class="flex flex-wrap items-baseline gap-x-3">
              <span>
                Sent to model:{" "}
                <b class="text-text">{tokens(t().total_tokens)}</b>
              </span>
              <span class="text-muted">
                Raw history: {tokens(t().raw_tokens)}
              </span>
              <span class="text-muted">{ratio(t())}</span>
            </div>
            <Badge variant="gold">{layerLabel(t().layer)}</Badge>
          </div>
        )}
      </Show>
    </Card>
  );
};

const DistilledSection: Component<{ context: SessionContext }> = (props) => (
  <Card title="Distilled prefix">
    <Show
      when={props.context.distilled_prefix.distillations.length > 0}
      fallback={<p class="text-muted">No distilled prefix in effect.</p>}
    >
      <p class="mb-1.5 text-muted">
        {tokens(props.context.distilled_prefix.token_count)} tokens across{" "}
        {props.context.distilled_prefix.distillations.length}{" "}
        {props.context.distilled_prefix.distillations.length === 1
          ? "distillation"
          : "distillations"}
      </p>
      <ul class="flex flex-col gap-1 text-xs text-muted">
        <For each={props.context.distilled_prefix.distillations}>
          {(d) => (
            <li class="flex flex-wrap items-center gap-2">
              <Badge variant="outline">generation {d.generation}</Badge>
              <span>{tokens(d.token_count)} tokens</span>
              <BlockTime at={d.created_at} />
            </li>
          )}
        </For>
      </ul>
    </Show>
  </Card>
);

const InjectionsSection: Component<{
  context: SessionContext;
  knowledgeHref: (logicalId: string) => string;
}> = (props) => {
  const cacheLine = () => {
    const k = props.context.knowledge;
    const parts: string[] = [];
    if (k.cache_tokens !== null) parts.push(`cache ${tokens(k.cache_tokens)}`);
    if (k.pin_tokens !== null) parts.push(`pinned ${tokens(k.pin_tokens)}`);
    if (k.stable_tokens !== null)
      parts.push(`stable ${tokens(k.stable_tokens)}`);
    return parts.length > 0 ? `${parts.join(" · ")} tokens` : null;
  };
  return (
    <Card title="Injected knowledge">
      <div data-testid="context-injections">
        <Show
          when={props.context.knowledge.injections.length > 0}
          fallback={
            <p class="text-muted">No knowledge injected into this session.</p>
          }
        >
          <ul class="flex flex-col gap-2">
            <For each={props.context.knowledge.injections}>
              {(i) => (
                <li class="flex flex-wrap items-center gap-2">
                  <Show
                    when={i.title !== null}
                    fallback={
                      <span class="text-muted">
                        {i.logical_id} (entry removed)
                      </span>
                    }
                  >
                    <A
                      class="text-accent underline"
                      href={props.knowledgeHref(i.logical_id)}
                    >
                      {i.title}
                    </A>
                  </Show>
                  <Show when={i.category}>
                    {(c) => <Badge variant="outline">{c()}</Badge>}
                  </Show>
                  <Show when={i.credited}>
                    <Badge variant="teal">credited</Badge>
                  </Show>
                  <Show when={i.verdict}>
                    {(v) => <span class="text-muted">verdict: {v()}</span>}
                  </Show>
                  <BlockTime at={i.created_at} />
                </li>
              )}
            </For>
          </ul>
        </Show>
        <Show when={cacheLine()}>
          {(line) => <p class="mt-2 text-xs text-muted">{line()}</p>}
        </Show>
      </div>
    </Card>
  );
};

const DeltaRow: Component<{
  delta: SessionContextDelta;
  knowledgeHref: (logicalId: string) => string;
}> = (props) => (
  <li class="border-b border-line/60 pb-2 last:border-0 last:pb-0">
    <div class="flex flex-wrap items-center gap-2">
      <span class="text-muted">seq {props.delta.seq}</span>
      <Show
        when={props.delta.applied_at !== null}
        fallback={
          <span class="text-xs italic text-muted">time not recorded</span>
        }
      >
        <span class="text-xs text-muted">
          {formatWhen(props.delta.applied_at)}
        </span>
      </Show>
      <Show when={props.delta.changed.length > 0}>
        <span class="text-muted">
          changed:{" "}
          <For each={props.delta.changed}>
            {(c, i) => (
              <>
                {i() > 0 ? ", " : ""}
                <Show when={c.title !== null} fallback={<span>{c.id}</span>}>
                  <A
                    class="text-accent underline"
                    href={props.knowledgeHref(c.id)}
                  >
                    {c.title}
                  </A>
                </Show>
              </>
            )}
          </For>
        </span>
      </Show>
      <Show when={props.delta.removed.length > 0}>
        <span class="text-muted">{props.delta.removed.length} removed</span>
      </Show>
    </div>
    <Show when={props.delta.text.length > 0}>
      <details class="mt-1">
        <summary class="cursor-pointer text-xs text-accent">
          Delta text ({props.delta.text.length})
        </summary>
        <For each={props.delta.text}>
          {(t) => (
            <pre class="mt-1 whitespace-pre-wrap font-mono text-xs leading-relaxed text-muted">
              {t}
            </pre>
          )}
        </For>
      </details>
    </Show>
  </li>
);

const DeltasSection: Component<{
  context: SessionContext;
  knowledgeHref: (logicalId: string) => string;
}> = (props) => (
  <Card title="Prompt-delta updates">
    <Show
      when={props.context.prompt_deltas.length > 0}
      fallback={<p class="text-muted">No prompt updates.</p>}
    >
      <ul data-testid="context-deltas" class="flex flex-col gap-2">
        <For each={props.context.prompt_deltas}>
          {(d) => <DeltaRow delta={d} knowledgeHref={props.knowledgeHref} />}
        </For>
      </ul>
    </Show>
  </Card>
);

const TURNS_SHOWN = 20;

const TurnsSection: Component<{ context: SessionContext }> = (props) => {
  const turns = () => props.context.turns.slice(-TURNS_SHOWN);
  return (
    <Show when={props.context.turns.length > 0}>
      <Card title="Turns">
        <Show when={props.context.turns.length > TURNS_SHOWN}>
          <p class="mb-1.5 text-xs text-muted">
            showing last {TURNS_SHOWN} of{" "}
            {props.context.turns.length.toLocaleString()}
          </p>
        </Show>
        <table class="w-full text-left text-xs">
          <thead>
            <tr class="text-muted">
              <th class="py-1 pr-2 font-normal">Time</th>
              <th class="py-1 pr-2 font-normal">Layer</th>
              <th class="py-1 pr-2 text-right font-normal">Raw</th>
              <th class="py-1 pr-2 text-right font-normal">Sent</th>
              <th class="py-1 pr-2 text-right font-normal">Distilled</th>
              <th class="py-1 text-right font-normal">In / out</th>
            </tr>
          </thead>
          <tbody>
            <For each={turns()}>
              {(t) => (
                <tr class="border-t border-line/60">
                  <td class="py-1 pr-2 text-muted">
                    <BlockTime at={t.created_at} />
                  </td>
                  <td class="py-1 pr-2">{t.layer}</td>
                  <td class="py-1 pr-2 text-right">{tokens(t.raw_tokens)}</td>
                  <td class="py-1 pr-2 text-right">{tokens(t.total_tokens)}</td>
                  <td class="py-1 pr-2 text-right">
                    {tokens(t.distilled_tokens)}
                  </td>
                  <td class="py-1 text-right text-muted">
                    {t.usage
                      ? `${tokens(t.usage.input)} / ${tokens(t.usage.output)}`
                      : "—"}
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </Card>
    </Show>
  );
};

function contextErrorCard(error: unknown, onRetry: () => void) {
  if (isApiError(error) && error.kind === "not_found") {
    return (
      <StateCard kind="empty" title="No context record">
        Lore has no context record for this session.
      </StateCard>
    );
  }
  if (isApiError(error) && error.kind === "unauthorized") {
    return (
      <StateCard kind="locked" title="Context window hidden">
        The management API is only served to loopback peers unless
        LORE_ALLOW_REMOTE_MANAGEMENT is enabled.
      </StateCard>
    );
  }
  return (
    <StateCard
      kind="error"
      title="Context window unavailable"
      action={
        <button
          type="button"
          class="text-xs text-accent underline"
          data-testid="context-retry"
          onClick={onRetry}
        >
          Retry
        </button>
      }
    >
      {error instanceof Error ? error.message : String(error)}
    </StateCard>
  );
}

export const ContextWindowPane: Component<{
  context: SessionContext | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  knowledgeHref: (logicalId: string) => string;
}> = (props) => (
  <div data-testid="context-window" class="flex flex-col gap-3 p-4">
    <Show
      when={props.context}
      fallback={
        <Show
          when={props.error}
          fallback={
            <Show
              when={props.loading}
              fallback={
                <p class="text-sm text-muted" role="status">
                  Context data is not available for this session.
                </p>
              }
            >
              <p class="text-sm text-muted" role="status">
                Loading context window…
              </p>
            </Show>
          }
        >
          {(err) => contextErrorCard(err(), props.onRetry)}
        </Show>
      }
    >
      {(ctx) => (
        <>
          <Show when={props.error}>
            <p class="text-xs text-danger" role="alert">
              Refresh failed — showing the last loaded context.
            </p>
          </Show>
          <SummarySection context={ctx()} />
          <DistilledSection context={ctx()} />
          <InjectionsSection
            context={ctx()}
            knowledgeHref={props.knowledgeHref}
          />
          <DeltasSection context={ctx()} knowledgeHref={props.knowledgeHref} />
          <TurnsSection context={ctx()} />
        </>
      )}
    </Show>
  </div>
);
