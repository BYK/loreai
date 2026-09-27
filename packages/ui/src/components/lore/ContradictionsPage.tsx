import type { Component } from "solid-js";
import {
  createMemo,
  createSignal,
  For,
  Match,
  onMount,
  Show,
  Switch,
} from "solid-js";
import { A } from "@solidjs/router";

import type {
  ContradictionDecision,
  ContradictionListItem,
  ContradictionListResponse,
} from "~/contracts";
import { formatWhen } from "~/lib/format";
import { useWorkspace } from "~/routes/workspace";

import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/confirm-dialog";
import {
  groupContradictions,
  type ContradictionGroup,
} from "./contradiction-groups";
import { errorStateFor } from "./ErrorState";
import { StateCard } from "./StateCard";

interface DecisionRequest {
  pair: ContradictionListItem;
  decision: ContradictionDecision;
}

const pairKey = (pair: ContradictionListItem) => pair.id_a + ":" + pair.id_b;

const ContradictionRow: Component<{
  pair: ContradictionListItem;
  crossProject: boolean;
  acting: boolean;
  disabled: boolean;
  onDecision: (decision: ContradictionDecision) => void;
}> = (props) => (
  <article
    class="rounded-lg border border-line bg-surface p-4"
    data-testid="contradiction-row"
  >
    <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold">
      <A
        class="text-accent underline decoration-accent/40 underline-offset-2"
        href={`/knowledge/${encodeURIComponent(props.pair.id_a)}`}
      >
        {props.pair.title_a}
      </A>
      <span aria-hidden="true" class="text-gold">
        ↔
      </span>
      <A
        class="text-accent underline decoration-accent/40 underline-offset-2"
        href={`/knowledge/${encodeURIComponent(props.pair.id_b)}`}
      >
        {props.pair.title_b}
      </A>
    </div>
    <Show when={props.pair.rationale}>
      {(rationale) => <p class="mt-2 text-[13px] text-muted">{rationale()}</p>}
    </Show>
    <div class="mt-2 text-[11px] text-muted">
      Similarity {(props.pair.similarity * 100).toFixed(0)}% · detected{" "}
      {formatWhen(props.pair.detected_at)}
      <Show when={props.crossProject}>
        {" · A: "}
        {props.pair.project_name_a ?? "Global"}
        {" · B: "}
        {props.pair.project_name_b ?? "Global"}
      </Show>
    </div>
    <div class="mt-3 flex flex-wrap gap-2">
      <Button
        size="sm"
        variant="outline"
        disabled={props.disabled}
        aria-label={"Keep " + props.pair.title_a}
        onClick={() => props.onDecision("keep-a")}
      >
        Keep A
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={props.disabled}
        aria-label={"Keep " + props.pair.title_b}
        onClick={() => props.onDecision("keep-b")}
      >
        Keep B
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={props.disabled}
        onClick={() => props.onDecision("keep-both")}
      >
        Keep both
      </Button>
      <Show when={props.acting}>
        <span class="self-center text-xs text-muted" role="status">
          Saving decision…
        </span>
      </Show>
    </div>
  </article>
);

/** Review recorded opposite instructions without changing them automatically. */
export const ContradictionsPage: Component = () => {
  const ws = useWorkspace();
  const [data, setData] = createSignal<ContradictionListResponse>();
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<unknown>();
  const [actionError, setActionError] = createSignal<unknown>();
  const [acting, setActing] = createSignal<string | null>(null);
  const [confirmation, setConfirmation] = createSignal<DecisionRequest | null>(
    null,
  );
  /** Group keys the reviewer collapsed; survives list refreshes. */
  const [collapsed, setCollapsed] = createSignal<ReadonlySet<string>>(
    new Set(),
  );
  const groups = createMemo<ContradictionGroup[]>(() =>
    groupContradictions(data()?.contradictions ?? []),
  );
  const toggleGroup = (key: string) => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const load = async () => {
    setLoading(true);
    setError(undefined);
    try {
      setData(await ws.tracked(() => ws.client.listContradictions()));
    } catch (reason) {
      setError(reason);
    } finally {
      setLoading(false);
    }
  };

  const actionErrorMessage = () => {
    const reason = actionError();
    return reason instanceof Error
      ? reason.message
      : "The gateway refused the decision.";
  };

  const applyDecision = async (request: DecisionRequest) => {
    const key = pairKey(request.pair);
    setActing(key);
    setActionError(undefined);
    try {
      await ws.tracked(() =>
        ws.client.decideContradiction(
          request.pair.id_a,
          request.pair.id_b,
          request.decision,
        ),
      );
      if (request.decision !== "keep-both") {
        const removedId =
          request.decision === "keep-a" ? request.pair.id_b : request.pair.id_a;
        try {
          await ws.state.knowledge.remove(removedId);
        } catch (reason) {
          // Cache failure must not make a successful gateway decision look
          // like a failed review action. The in-memory store is already clear.
          console.warn("knowledge cache removal failed", reason);
        }
      }
      setData((previous) =>
        previous
          ? {
              contradictions: previous.contradictions.filter(
                (pair) => pairKey(pair) !== key,
              ),
              total: Math.max(0, previous.total - 1),
            }
          : previous,
      );
      setConfirmation(null);
      await load();
    } catch (reason) {
      setActionError(reason);
    } finally {
      setActing(null);
    }
  };

  const requestDecision = (
    pair: ContradictionListItem,
    decision: ContradictionDecision,
  ) => {
    if (decision === "keep-both") {
      void applyDecision({ pair, decision });
      return;
    }
    setConfirmation({ pair, decision });
  };

  const confirmDecision = () => {
    const request = confirmation();
    if (request) void applyDecision(request);
  };

  onMount(() => void load());

  const pendingPair = () => confirmation()?.pair;
  const confirmationIsActing = () => {
    const pair = pendingPair();
    return pair !== undefined && acting() === pairKey(pair);
  };
  const keepTitle = () => {
    const request = confirmation();
    if (!request) return "";
    return request.decision === "keep-a"
      ? request.pair.title_a
      : request.pair.title_b;
  };
  const removeTitle = () => {
    const request = confirmation();
    if (!request) return "";
    return request.decision === "keep-a"
      ? request.pair.title_b
      : request.pair.title_a;
  };

  return (
    <div class="mx-auto max-w-4xl p-5 sm:p-8" data-testid="contradictions-page">
      <header class="mb-6">
        <p class="eyebrow">Memory review</p>
        <h1 class="mt-1 text-2xl font-semibold">Contradictions</h1>
        <p class="mt-2 max-w-2xl text-sm text-muted">
          These knowledge entries give opposing instructions. Lore never merges
          or removes either entry automatically; choose which rule to keep, or
          keep both and dismiss the pair.
        </p>
      </header>

      <Show when={actionError()}>
        <div
          class="mb-4 rounded-md border border-danger/40 bg-danger/5 p-3 text-sm"
          role="alert"
          data-testid="contradiction-action-error"
        >
          The decision could not be saved. {actionErrorMessage()}
        </div>
      </Show>

      <Show when={loading() && data()}>
        <p class="mb-3 text-xs text-muted" role="status">
          Refreshing contradictions…
        </p>
      </Show>

      <Switch>
        <Match when={loading() && !data()}>
          <StateCard kind="loading" title="Loading contradictions">
            Reading open contradiction pairs from the gateway.
          </StateCard>
        </Match>
        <Match when={!data() && error()}>
          {errorStateFor(error(), "Contradictions", () => void load())}
        </Match>
        <Match when={data()?.total === 0}>
          <StateCard kind="empty" title="No open contradictions">
            New pairs appear here only after the gateway has recorded a likely
            conflict for you to review.
          </StateCard>
        </Match>
        <Match when={data()}>
          {(value) => (
            <section aria-label="Open contradiction pairs">
              <div class="mb-3 text-xs text-muted">
                {value().total} open {value().total === 1 ? "pair" : "pairs"}
                <Show when={value().total > value().contradictions.length}>
                  {" · Showing the " +
                    value().contradictions.length +
                    " newest; resolve them to review older pairs."}
                </Show>
              </div>
              <div class="space-y-5">
                <For each={groups()}>
                  {(group) => {
                    const open = () => !collapsed().has(group.key);
                    const bodyId = `contradiction-group-${group.key}`;
                    return (
                      <section
                        data-testid="contradiction-group"
                        data-group={group.key}
                      >
                        <button
                          type="button"
                          aria-expanded={open()}
                          aria-controls={bodyId}
                          data-testid="contradiction-group-toggle"
                          class="mb-2 flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-semibold uppercase tracking-[0.08em] text-muted hover:bg-soft"
                          onClick={() => toggleGroup(group.key)}
                        >
                          <span aria-hidden="true">{open() ? "▾" : "▸"}</span>
                          {group.label} ({group.pairs.length})
                        </button>
                        {/* The aria-controls target stays mounted; only the
                            content inside is collapsed. */}
                        <div id={bodyId}>
                          <Show when={open()}>
                            <Show when={group.crossProject}>
                              <p class="mb-2 px-2 text-[11px] text-muted">
                                Entries from different projects (or global
                                rules)
                              </p>
                            </Show>
                            <div class="space-y-3">
                              <For each={group.pairs}>
                                {(pair) => (
                                  <ContradictionRow
                                    pair={pair}
                                    crossProject={group.crossProject}
                                    acting={acting() === pairKey(pair)}
                                    disabled={
                                      acting() !== null ||
                                      confirmation() !== null
                                    }
                                    onDecision={(decision) =>
                                      requestDecision(pair, decision)
                                    }
                                  />
                                )}
                              </For>
                            </div>
                          </Show>
                        </div>
                      </section>
                    );
                  }}
                </For>
              </div>
            </section>
          )}
        </Match>
      </Switch>

      <Show when={error() && data()}>
        <div
          class="mt-3 rounded-md border border-danger/40 bg-danger/5 p-3 text-sm"
          role="alert"
        >
          The list could not be refreshed.{" "}
          <button class="text-accent underline" onClick={() => void load()}>
            Retry
          </button>
        </div>
      </Show>

      <ConfirmDialog
        open={confirmation() !== null}
        title="Remove the other entry?"
        description={
          <>
            Keep <strong>{keepTitle()}</strong> and permanently remove{" "}
            <strong>{removeTitle()}</strong> from knowledge. This cannot be
            undone.
          </>
        }
        confirmLabel="Keep selected entry"
        destructive
        pending={confirmationIsActing()}
        onCancel={() => setConfirmation(null)}
        onConfirm={confirmDecision}
      />
    </div>
  );
};
