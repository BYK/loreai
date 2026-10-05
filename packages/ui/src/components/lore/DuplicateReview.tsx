import type { Component } from "solid-js";
import {
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
} from "solid-js";
import { A } from "@solidjs/router";

import type {
  DedupPreviewGroup,
  KnowledgeVersion,
  KnowledgeVersionHistory,
} from "~/contracts";
import type { DedupReviewMark } from "~/db";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { ScopeLabel } from "~/components/lore/Document";
import { errorStateFor } from "~/components/lore/ErrorState";
import { StateCard } from "~/components/lore/StateCard";
import { formatConfidence, formatWhen } from "~/lib/format";
import { markFrom, markStatus } from "~/lib/dedup-review";
import { isApiError } from "~/lib/api";
import { globalKnowledgeHref, knowledgeHref, sessionHref } from "~/lib/href";
import { createLoader } from "~/lib/loader";
import { useWorkspace } from "~/routes/workspace";

type VersionLoad =
  | { kind: "loading" }
  | { kind: "loaded"; history: KnowledgeVersionHistory }
  | { kind: "removed" }
  | { kind: "error"; message: string };

const REASON_LABELS: Record<string, string> = {
  title_overlap: "Title overlap",
  embedding_similarity: "Embedding similarity",
};

const STATUS_LABELS = {
  pending: "Pending",
  accepted: "Accepted",
  skipped: "Skipped",
  stale: "Stale",
} as const;

function currentVersion(
  load: VersionLoad | undefined,
): KnowledgeVersion | undefined {
  return load?.kind === "loaded"
    ? load.history.versions.find((version) => version.is_current)
    : undefined;
}

function suggestedKeeper(group: DedupPreviewGroup): string {
  return (
    group.candidates.find(
      (candidate) =>
        candidate.id === group.suggested_keep_id ||
        candidate.logical_id === group.suggested_keep_id,
    )?.logical_id ??
    group.candidates[0]?.logical_id ??
    group.suggested_keep_id
  );
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.closest(
      'input, textarea, select, [contenteditable="true"], [role="textbox"], [role="combobox"], [role="listbox"]',
    ) !== null
  );
}

export const DuplicateReview: Component<{ projectId: string }> = (props) => {
  const ws = useWorkspace();
  const preview = createLoader(
    () => props.projectId,
    (projectId, signal) =>
      ws.tracked(() => ws.client.previewDedup(projectId, signal)),
  );
  const rescan = preview.reload;

  const [marks, setMarks] = createSignal<DedupReviewMark[]>([]);
  const [persistenceError, setPersistenceError] = createSignal(false);
  const refreshMarks = async (projectId = props.projectId) => {
    setMarks(await ws.state.dedupReview.list(projectId));
  };
  createEffect(() => {
    void refreshMarks(props.projectId);
  });
  const groups = () => preview.data()?.groups ?? [];
  const [focusedIndex, setFocusedIndex] = createSignal(0);
  const focusedGroup = createMemo(() => groups()[focusedIndex()]);
  createEffect(() => {
    const index = focusedIndex();
    const length = groups().length;
    if (length > 0 && index >= length) setFocusedIndex(length - 1);
    if (length === 0 && index !== 0) setFocusedIndex(0);
  });
  const markFor = (group: DedupPreviewGroup) =>
    marks().find(
      (mark) =>
        mark.projectId === props.projectId && mark.groupId === group.group_id,
    );
  const statusFor = (group: DedupPreviewGroup) =>
    markStatus(group, markFor(group));
  const keeperChoices = createSignal<Record<string, string>>({});
  const keepers = keeperChoices[0];
  const setKeepers = keeperChoices[1];
  const keeperFor = (group: DedupPreviewGroup) => {
    const fallback = suggestedKeeper(group);
    const selected =
      keepers()[group.group_id] ?? markFor(group)?.keepId ?? fallback;
    return group.candidates.some(
      (candidate) => candidate.logical_id === selected,
    )
      ? selected
      : fallback;
  };
  const [versionLoads, setVersionLoads] = createSignal<
    Record<string, VersionLoad>
  >({});
  const candidateChanged = (
    candidate: DedupPreviewGroup["candidates"][number],
  ) => {
    const load = versionLoads()[candidate.logical_id];
    if (load?.kind === "removed") return true;
    const version = currentVersion(load);
    return (
      version !== undefined &&
      (version.version !== candidate.revision || version.is_deleted)
    );
  };
  const focusedGroupChanged = () =>
    focusedGroup()?.candidates.some(candidateChanged) ?? false;

  createEffect(() => {
    const group = focusedGroup();
    if (!group) return;
    const controller = new AbortController();
    const ids = group.candidates.map((candidate) => candidate.logical_id);
    setVersionLoads((previous) => ({
      ...previous,
      ...Object.fromEntries(ids.map((id) => [id, { kind: "loading" }])),
    }));
    void Promise.all(
      group.candidates.map(async (candidate) => {
        try {
          const history = await ws.tracked(() =>
            ws.client.listKnowledgeVersions(candidate.logical_id, {
              signal: controller.signal,
            }),
          );
          return [candidate.logical_id, { kind: "loaded", history }] as const;
        } catch (error) {
          if (isApiError(error) && error.kind === "not_found") {
            return [candidate.logical_id, { kind: "removed" }] as const;
          }
          return [
            candidate.logical_id,
            { kind: "error", message: String(error) },
          ] as const;
        }
      }),
    ).then((loads) => {
      if (controller.signal.aborted) return;
      setVersionLoads((previous) => ({
        ...previous,
        ...Object.fromEntries(loads),
      }));
    });
    onCleanup(() => controller.abort());
  });

  const orphaned = () => {
    if (!preview.data()) return [];
    const groupIds = new Set(groups().map((group) => group.group_id));
    return marks().filter((mark) => !groupIds.has(mark.groupId));
  };

  const saveDecision = async (decision: "accept" | "skip") => {
    const group = focusedGroup();
    if (!group || (decision === "accept" && focusedGroupChanged())) return;
    const mark = markFrom(group, decision, keeperFor(group), props.projectId);
    const saved = await ws.state.dedupReview.put(mark);
    setPersistenceError(!saved);
    if (saved) await refreshMarks();
  };
  const clearMark = async (group = focusedGroup()) => {
    if (!group) return;
    const deleted = await ws.state.dedupReview.delete(
      props.projectId,
      group.group_id,
    );
    setPersistenceError(!deleted);
    if (deleted) await refreshMarks();
  };
  const discardOrphans = async () => {
    const results = await Promise.all(
      orphaned().map((mark) =>
        ws.state.dedupReview.delete(props.projectId, mark.groupId),
      ),
    );
    const deleted = results.every(Boolean);
    setPersistenceError(!deleted);
    await refreshMarks();
  };
  const chooseKeeper = (group: DedupPreviewGroup, id: string) => {
    setKeepers((previous) => ({ ...previous, [group.group_id]: id }));
    const existing = markFor(group);
    if (existing && markStatus(group, existing) !== "stale") {
      void ws.state.dedupReview
        .put(markFrom(group, existing.decision, id, props.projectId))
        .then(async (saved) => {
          setPersistenceError(!saved);
          if (saved) await refreshMarks();
        });
    }
  };
  const move = (delta: number) => {
    if (!groups().length) return;
    setFocusedIndex(
      (index) => (index + delta + groups().length) % groups().length,
    );
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const target = event.target;
    const review = document.querySelector('[data-testid="duplicate-review"]');
    if (
      !(target instanceof Node) ||
      (target !== document.body && !review?.contains(target))
    )
      return;
    if (
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.shiftKey ||
      isTypingTarget(event.target) ||
      document.querySelector('[role="dialog"], [role="alertdialog"]')
    )
      return;
    const key = event.key.toLowerCase();
    if (!focusedGroup()) return;
    if (key === "j" && focusedIndex() < groups().length - 1) {
      event.preventDefault();
      move(1);
    } else if (key === "k" && focusedIndex() > 0) {
      event.preventDefault();
      move(-1);
    } else if (key === "a" && !focusedGroupChanged()) {
      event.preventDefault();
      void saveDecision("accept");
    } else if (key === "s") {
      event.preventDefault();
      void saveDecision("skip");
    } else if (key === "u") {
      event.preventDefault();
      void clearMark();
    } else if (/^[1-9]$/.test(key)) {
      const group = focusedGroup();
      const candidate = group?.candidates[Number(key) - 1];
      if (group && candidate) {
        event.preventDefault();
        chooseKeeper(group, candidate.logical_id);
      }
    }
  };
  createEffect(() => {
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown));
  });

  const counts = createMemo(() => {
    const result = { accepted: 0, skipped: 0, pending: 0, stale: 0 };
    for (const group of groups()) {
      result[statusFor(group)]++;
    }
    return result;
  });

  const scopeLabel = (group: DedupPreviewGroup) => {
    if (group.pool === "shared") return "Shared";
    if (group.pool === "project_shared") return "Project + shared";
    return "Project";
  };

  return (
    <main
      class="mx-auto max-w-[1240px] px-4 py-6 sm:px-7.5"
      data-testid="duplicate-review"
    >
      <header class="mb-5 border-b border-line pb-4">
        <div class="eyebrow mb-2">Memory review</div>
        <h1 class="text-[25px] font-semibold tracking-tight">
          Duplicate review
        </h1>
        <p class="mt-2 text-sm text-muted">
          Compare the evidence, then record a local review decision.
        </p>
      </header>

      <section
        class="mb-5 rounded-lg border border-thread bg-soft px-4 py-3"
        aria-label="Review decision status"
        data-testid="review-summary"
      >
        <p class="font-medium">
          Nothing is applied — marks are saved only in this browser.
        </p>
        <p class="mt-1 text-xs text-muted">
          {counts().accepted} accepted · {counts().skipped} skipped ·{" "}
          {counts().pending} pending · {counts().stale} stale
        </p>
        <Show when={ws.state.cache.status() === "unavailable"}>
          <p class="mt-2 text-xs text-gold" data-testid="review-storage-notice">
            IndexedDB is unavailable; marks are kept in memory for this session
            and are not saved on this device.
          </p>
        </Show>
        <Show when={persistenceError()}>
          <p
            class="mt-2 text-xs text-danger"
            role="status"
            data-testid="review-persistence-error"
          >
            Could not save this mark on this device
          </p>
        </Show>
      </section>

      <Show when={preview.data()}>
        <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
          <p class="text-xs text-muted">
            {groups().length} candidate{" "}
            {groups().length === 1 ? "group" : "groups"}
            {preview.loading() ? " · scanning again" : ""}
          </p>
          <Button
            variant="outline"
            size="sm"
            data-testid="dedup-rescan"
            onClick={rescan}
          >
            Rescan
          </Button>
        </div>
      </Show>

      <Show when={preview.error() && preview.data()}>
        <div class="mb-4">
          {errorStateFor(preview.error(), "Duplicate preview", rescan)}
        </div>
      </Show>
      <Show when={orphaned().length > 0}>
        <section
          class="mb-5 rounded-lg border border-mark-edge/60 bg-mark/30 px-4 py-3"
          data-testid="orphaned-marks"
        >
          <div class="flex flex-wrap items-center justify-between gap-3">
            <p class="text-sm">
              {orphaned().length} saved{" "}
              {orphaned().length === 1 ? "mark is" : "marks are"} not in this
              scan.
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void discardOrphans()}
            >
              Discard orphaned marks
            </Button>
          </div>
        </section>
      </Show>

      <Switch>
        <Match when={!preview.data() && preview.error()}>
          <div class="mx-auto max-w-2xl">
            {errorStateFor(preview.error(), "Duplicate preview", rescan)}
          </div>
        </Match>
        <Match when={!preview.data() && !preview.error()}>
          <StateCard kind="loading" title="Scanning for duplicates">
            The preview is read-only and does not change knowledge.
          </StateCard>
        </Match>
        <Match when={groups().length === 0}>
          <StateCard kind="empty" title="No duplicate candidates">
            Rescan to check for new candidates.
          </StateCard>
        </Match>
        <Match when={groups().length > 0}>
          <div class="grid gap-5 lg:grid-cols-[minmax(260px,0.72fr)_minmax(0,1.7fr)]">
            <nav aria-label="Duplicate groups" class="space-y-2">
              <For each={groups()}>
                {(group, index) => {
                  const reasons = () => [
                    ...new Set(group.candidates.flatMap((c) => c.reasons)),
                  ];
                  const score = () =>
                    Math.round(
                      Math.max(
                        ...group.candidates.map((candidate) => candidate.score),
                      ) * 100,
                    );
                  return (
                    <button
                      type="button"
                      class={`w-full rounded-lg border px-3 py-3 text-left transition-colors ${
                        focusedIndex() === index()
                          ? "border-thread bg-soft"
                          : "border-line bg-surface hover:bg-soft"
                      }`}
                      aria-current={
                        focusedIndex() === index() ? "true" : undefined
                      }
                      data-testid="duplicate-group"
                      onClick={() => setFocusedIndex(index())}
                    >
                      <div class="flex items-start justify-between gap-2">
                        <div class="min-w-0 space-y-1">
                          <For each={group.candidates}>
                            {(candidate) => (
                              <div class="break-words text-sm font-medium">
                                {candidate.title}
                              </div>
                            )}
                          </For>
                        </div>
                        <Badge
                          variant="teal"
                          aria-label={`Best match score ${score()}%`}
                          title={`Best match score ${score()}%`}
                        >
                          {score()}% match
                        </Badge>
                      </div>
                      <div class="mt-2 flex flex-wrap gap-1">
                        <Badge variant="outline">{scopeLabel(group)}</Badge>
                        <For each={reasons()}>
                          {(reason) => (
                            <Badge variant="outline">
                              {REASON_LABELS[reason] ??
                                reason.replaceAll("_", " ")}
                            </Badge>
                          )}
                        </For>
                        <Badge
                          variant={
                            statusFor(group) === "accepted"
                              ? "teal"
                              : statusFor(group) === "stale"
                                ? "gold"
                                : "outline"
                          }
                          data-status={statusFor(group)}
                        >
                          {STATUS_LABELS[statusFor(group)]}
                        </Badge>
                      </div>
                    </button>
                  );
                }}
              </For>
            </nav>

            <Show when={focusedGroup()}>
              {(group) => (
                <section
                  class="min-w-0 rounded-lg border border-line bg-surface"
                  data-testid="focused-duplicate-group"
                >
                  <div class="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
                    <div class="text-xs text-muted">
                      Group {focusedIndex() + 1} of {groups().length} ·{" "}
                      {scopeLabel(group())}
                    </div>
                    <div class="flex flex-wrap items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={focusedIndex() === 0}
                        onClick={() => move(-1)}
                      >
                        Previous
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={focusedIndex() >= groups().length - 1}
                        onClick={() => move(1)}
                      >
                        Next
                      </Button>
                    </div>
                  </div>

                  <div class="grid gap-3 p-3 sm:grid-cols-2 sm:p-4">
                    <For each={group().candidates}>
                      {(candidate, index) => {
                        const load = () =>
                          versionLoads()[candidate.logical_id] ?? {
                            kind: "loading" as const,
                          };
                        const current = () => currentVersion(load());
                        const changed = () => {
                          const version = current();
                          return (
                            version !== undefined &&
                            version.version !== candidate.revision
                          );
                        };
                        const isRemoved = () =>
                          load().kind === "removed" ||
                          (current()?.is_deleted ?? false);
                        return (
                          <article
                            class="min-w-0 rounded-md border border-line bg-bg p-3"
                            data-testid="duplicate-candidate"
                          >
                            <div class="mb-3 flex items-start justify-between gap-2">
                              <h2 class="break-words text-base font-semibold">
                                {current()?.title ?? candidate.title}
                              </h2>
                              <Badge variant="outline">
                                v{current()?.version ?? candidate.revision}
                              </Badge>
                            </div>
                            <div class="mb-3 flex flex-wrap gap-1.5">
                              <Badge variant="teal">{candidate.category}</Badge>
                              <Badge variant="teal">
                                Match {Math.round(candidate.score * 100)}%
                              </Badge>
                              <For each={candidate.reasons}>
                                {(reason) => (
                                  <Badge variant="outline">
                                    {REASON_LABELS[reason] ??
                                      reason.replaceAll("_", " ")}
                                  </Badge>
                                )}
                              </For>
                              <Badge variant="outline">
                                Confidence{" "}
                                {formatConfidence(candidate.confidence)}
                              </Badge>
                              <ScopeLabel scope={candidate.scope} />
                            </div>
                            <Show
                              when={!isRemoved()}
                              fallback={
                                <p class="rounded border border-mark-edge/60 bg-mark/30 p-3 text-sm text-gold">
                                  Removed since this scan
                                </p>
                              }
                            >
                              <Show when={changed()}>
                                <p class="mb-2 text-xs text-gold">
                                  Changed since this scan —{" "}
                                  <button
                                    type="button"
                                    class="underline"
                                    onClick={rescan}
                                  >
                                    rescan
                                  </button>
                                </p>
                              </Show>
                              <Show when={load().kind === "error"}>
                                <p class="mb-2 text-xs text-danger">
                                  Could not load the current version.
                                </p>
                              </Show>
                              <pre
                                class="max-h-[440px] overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-surface p-3 font-sans text-sm leading-relaxed"
                                data-testid="candidate-content"
                              >
                                {current()?.content ??
                                  candidate.content_excerpt}
                              </pre>
                            </Show>
                            <div class="mt-3 space-y-1.5 text-xs text-muted">
                              <p>
                                Source session:{" "}
                                <Show
                                  when={candidate.source_session}
                                  fallback="not recorded"
                                >
                                  {(sessionId) =>
                                    candidate.project_id !== null ? (
                                      <A
                                        class="text-accent underline"
                                        href={sessionHref(
                                          candidate.project_id,
                                          sessionId(),
                                        )}
                                      >
                                        {sessionId()}
                                      </A>
                                    ) : (
                                      <span>{sessionId()}</span>
                                    )
                                  }
                                </Show>
                              </p>
                              <p>Updated {formatWhen(candidate.updated_at)}</p>
                              <p class="font-mono">
                                ID {candidate.logical_id.slice(0, 8)}
                              </p>
                              <A
                                class="inline-block text-accent underline"
                                href={
                                  candidate.project_id
                                    ? knowledgeHref(
                                        candidate.project_id,
                                        candidate.logical_id,
                                      )
                                    : globalKnowledgeHref(candidate.logical_id)
                                }
                              >
                                Open knowledge document
                              </A>
                            </div>
                            <label class="mt-4 flex cursor-pointer items-start gap-2 border-t border-line pt-3 text-sm">
                              <input
                                type="radio"
                                name={`keeper-${group().group_id}`}
                                value={candidate.logical_id}
                                aria-label={`Keep this one (${index() + 1})`}
                                checked={
                                  keeperFor(group()) === candidate.logical_id
                                }
                                onChange={() =>
                                  chooseKeeper(group(), candidate.logical_id)
                                }
                              />
                              <span>
                                Keep this one
                                <span class="ml-1 text-xs text-muted">
                                  ({index() + 1})
                                </span>
                              </span>
                            </label>
                          </article>
                        );
                      }}
                    </For>
                  </div>

                  <div class="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3">
                    <Show when={focusedGroupChanged()}>
                      <p
                        class="basis-full text-xs text-gold"
                        role="status"
                        data-testid="changed-group-notice"
                      >
                        Rescan before marking — this group changed since the
                        scan
                      </p>
                    </Show>
                    <Button
                      size="sm"
                      data-testid="accept-merge"
                      disabled={focusedGroupChanged()}
                      onClick={() => void saveDecision("accept")}
                    >
                      Accept merge
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      data-testid="skip-group"
                      onClick={() => void saveDecision("skip")}
                    >
                      Skip
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!markFor(group())}
                      onClick={() => void clearMark(group())}
                    >
                      Clear mark
                    </Button>
                    <span class="ml-auto text-xs text-muted">
                      Shortcuts: j/k group · a accept · s skip · u clear · 1–9
                      keeper
                    </span>
                  </div>
                </section>
              )}
            </Show>
          </div>
        </Match>
      </Switch>
    </main>
  );
};
