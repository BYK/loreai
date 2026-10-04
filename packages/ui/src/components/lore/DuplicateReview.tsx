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
  DedupApplyBody,
  DedupApplyReceipt,
  DedupPreviewGroup,
  KnowledgeVersion,
  KnowledgeVersionHistory,
  SyncStatus,
} from "~/contracts";
import type { DedupApplyRecord, DedupReviewMark } from "~/db";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { ConfirmDialog } from "~/components/ui/confirm-dialog";
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

const REFUSAL_LABELS = {
  stale_revision: "Changed since you reviewed it — rescan and review again",
  not_found: "An entry was removed since the scan",
  scope_mismatch: "An entry is no longer in this scope",
  conflicting_groups: "Shares an entry with another accepted group",
} as const;

type ApplyNotice = { kind: "error" | "locked" | "status"; text: string };
type ApplyResult = {
  record: DedupApplyRecord;
  receipt: DedupApplyReceipt;
};

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
  const [pendingApplies, setPendingApplies] = createSignal<DedupApplyRecord[]>(
    [],
  );
  const [applyResults, setApplyResults] = createSignal<ApplyResult[]>([]);
  const [applyNotice, setApplyNotice] = createSignal<ApplyNotice | null>(null);
  const [applyPending, setApplyPending] = createSignal(false);
  const [activeApplyKey, setActiveApplyKey] = createSignal<string | null>(null);
  const [confirmOpen, setConfirmOpen] = createSignal(false);
  const [syncStatus, setSyncStatus] = createSignal<SyncStatus | null>(null);
  const [syncStatusLoading, setSyncStatusLoading] = createSignal(false);
  const [syncStatusFailed, setSyncStatusFailed] = createSignal(false);
  const [persistenceError, setPersistenceError] = createSignal(false);
  const refreshMarks = async (projectId = props.projectId) => {
    setMarks(await ws.state.dedupReview.list(projectId));
  };
  const refreshApplies = async (projectId = props.projectId) => {
    setPendingApplies(await ws.state.dedupReview.listApplies(projectId));
  };
  createEffect(() => {
    const projectId = props.projectId;
    void refreshMarks(projectId);
    void refreshApplies(projectId);
    setApplyResults([]);
    setApplyNotice(null);
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
  const acceptedGroups = () =>
    groups().filter((group) => statusFor(group) === "accepted");
  const applyPlans = () => {
    const accepted = acceptedGroups();
    return (["project", "global"] as const).flatMap((scope) => {
      const scopedGroups = accepted.filter((group) =>
        scope === "project"
          ? group.scope === "project"
          : group.scope === "global",
      );
      if (!scopedGroups.length) return [];
      const groupMarks = scopedGroups.map((group) => {
        const mark = markFor(group);
        if (!mark || markStatus(group, mark) !== "accepted")
          throw new Error("Accepted duplicate group has no current mark");
        return mark;
      });
      const operationId = crypto.randomUUID();
      const body: DedupApplyBody = {
        operationId,
        reviewedAt: Math.max(...groupMarks.map((mark) => mark.markedAt)),
        actor: "lore-ui",
        decisions: groupMarks.map((mark) => ({
          keepId: mark.keepId,
          mergeIds: [...mark.mergeIds],
          expectedRevisions: { ...mark.expectedRevisions },
        })),
        ...(scope === "global" ? { projectId: null } : {}),
      };
      const record: DedupApplyRecord = {
        key: `${props.projectId}/apply/${operationId}`,
        kind: "dedup-apply",
        projectId: props.projectId,
        operationId,
        body,
        groupIds: scopedGroups.map((group) => group.group_id),
        candidateTitles: Object.fromEntries(
          scopedGroups.flatMap((group) =>
            group.candidates.map((candidate) => [
              candidate.logical_id,
              candidate.title,
            ]),
          ),
        ),
        createdAt: Date.now(),
      };
      return [{ record }];
    });
  };
  const titleFor = (record: DedupApplyRecord, id: string) =>
    record.candidateTitles[id] ?? id;
  const knowledgeLinkFor = (record: DedupApplyRecord, id: string) =>
    record.body.projectId === null
      ? globalKnowledgeHref(id)
      : knowledgeHref(record.projectId, id);
  const syncConsequence = () => {
    if (syncStatus()?.enabled) {
      const pending = syncStatus()?.pending_changes;
      return pending === null
        ? "Deletions are synced (pending count unavailable)"
        : `Deletions are synced (${pending} changes already pending)`;
    }
    return syncStatus() ? "Sync is off — this device only" : "";
  };
  const openConfirmation = async () => {
    if (!acceptedGroups().length || applyPending()) return;
    setApplyNotice(null);
    setSyncStatus(null);
    setSyncStatusFailed(false);
    setSyncStatusLoading(true);
    setConfirmOpen(true);
    try {
      setSyncStatus(await ws.tracked(() => ws.client.getSyncStatus()));
    } catch {
      setSyncStatusFailed(true);
    } finally {
      setSyncStatusLoading(false);
    }
  };
  const removeApplyRecord = async (
    record: DedupApplyRecord,
    receiptConfirmed = true,
  ) => {
    const removed = await ws.state.dedupReview.deleteApply(record);
    if (!removed) {
      setApplyNotice({
        kind: "error",
        text: receiptConfirmed
          ? "The apply receipt is confirmed, but its local retry record could not be removed."
          : "The apply was rejected, but its local retry record could not be removed.",
      });
    }
    await refreshApplies(record.projectId);
    return removed;
  };
  const applyReceipt = async (
    record: DedupApplyRecord,
    receipt: DedupApplyReceipt,
  ) => {
    setApplyResults((previous) => [
      ...previous.filter(
        (result) => result.receipt.operationId !== receipt.operationId,
      ),
      { record, receipt },
    ]);
    await removeApplyRecord(record);
    const markDeletes = await Promise.all(
      receipt.applied.map(async (applied) => {
        const groupId = record.groupIds[applied.groupIndex];
        if (!groupId) return false;
        return ws.state.dedupReview.delete(record.projectId, groupId);
      }),
    );
    setPersistenceError(markDeletes.some((deleted) => !deleted));
    await refreshMarks(record.projectId);
    try {
      await Promise.all(
        receipt.applied.flatMap((applied) =>
          applied.merged.map((entry) => ws.state.knowledge.remove(entry.id)),
        ),
      );
      await ws.state.knowledge.invalidateProject(record.projectId);
      ws.projects.reload();
      preview.reload();
    } catch {
      setApplyNotice({
        kind: "error",
        text: "Apply is confirmed, but local knowledge caches could not be refreshed.",
      });
    }
    await refreshApplies(record.projectId);
  };
  const submitApply = async (
    record: DedupApplyRecord,
    persistBeforePost: boolean,
  ): Promise<boolean> => {
    if (persistBeforePost) {
      if (!(await ws.state.dedupReview.persistent())) {
        setApplyNotice({
          kind: "error",
          text: "Could not save the apply operation on this device — no changes were sent.",
        });
        return false;
      }
      const saved = await ws.state.dedupReview.putApply(record);
      if (!saved) {
        setApplyNotice({
          kind: "error",
          text: "Could not save the apply operation on this device — no changes were sent.",
        });
        return false;
      }
      await refreshApplies(record.projectId);
    }

    setApplyNotice(null);
    let receipt: DedupApplyReceipt;
    try {
      receipt = await ws.tracked(() =>
        ws.client.applyDedup(record.projectId, record.body),
      );
    } catch (error) {
      setConfirmOpen(false);
      if (isApiError(error) && error.status === 409) {
        const removed = await removeApplyRecord(record, false);
        setApplyNotice({
          kind: "error",
          text: `Operation ID conflict — ${error.message}${
            removed ? "" : " The local retry record could not be removed."
          }`,
        });
        return false;
      }
      if (
        isApiError(error) &&
        (error.kind === "forbidden" ||
          error.kind === "unauthorized" ||
          (error.status !== null && error.status >= 400 && error.status < 500))
      ) {
        const removed = await removeApplyRecord(record, false);
        setApplyNotice(
          error.kind === "forbidden"
            ? {
                kind: "locked",
                text: `Not available in hosted mode — run a local gateway to use this action.${
                  removed ? "" : " The local retry record could not be removed."
                }`,
              }
            : {
                kind: "error",
                text: `${error.message}${
                  removed ? "" : " The local retry record could not be removed."
                }`,
              },
        );
        return false;
      }
      setApplyNotice({
        kind: "status",
        text: "The last apply didn't confirm — Retry",
      });
      await refreshApplies(record.projectId);
      return false;
    }

    await applyReceipt(record, receipt);
    return true;
  };
  const applyAccepted = async () => {
    const plans = applyPlans();
    if (!plans.length || applyPending()) return;
    setConfirmOpen(false);
    setApplyPending(true);
    try {
      for (const { record } of plans) {
        setActiveApplyKey(record.key);
        if (!(await submitApply(record, true))) break;
      }
    } finally {
      setActiveApplyKey(null);
      setApplyPending(false);
    }
  };
  const retryApply = async (record: DedupApplyRecord) => {
    if (applyPending()) return;
    if (!(await ws.state.dedupReview.persistent())) {
      setApplyNotice({
        kind: "error",
        text: "IndexedDB is unavailable — the saved apply cannot be retried safely.",
      });
      return;
    }
    setApplyPending(true);
    setActiveApplyKey(record.key);
    try {
      await submitApply(record, false);
    } finally {
      setActiveApplyKey(null);
      setApplyPending(false);
    }
  };
  const showReceipt = (
    record: DedupApplyRecord,
    receipt: DedupApplyReceipt,
  ) => (
    <div class="space-y-3 border-t border-line pt-3">
      <div
        class="flex flex-wrap items-center gap-2 text-xs text-muted"
        data-testid="dedup-apply-operation-header"
      >
        <span>
          Operation <code>{receipt.operationId}</code>
        </span>
        <Badge variant="outline">
          {record.body.projectId !== null ? "Project" : "Shared (no project)"}
        </Badge>
      </div>
      <For each={receipt.applied}>
        {(applied) => (
          <div
            class="rounded-md border border-line bg-bg p-3"
            data-testid="applied-group"
          >
            <p class="m-0 text-sm font-medium">
              {titleFor(record, applied.keepId)} ←{" "}
              <For each={applied.merged}>
                {(entry, index) => (
                  <>
                    {index() > 0 ? ", " : ""}
                    <A
                      class="text-accent underline"
                      href={knowledgeLinkFor(record, entry.id)}
                    >
                      {titleFor(record, entry.id)}
                    </A>
                  </>
                )}
              </For>
            </p>
            <p class="mt-2 text-xs text-muted">Applied</p>
          </div>
        )}
      </For>
      <For each={receipt.refused}>
        {(refused) => (
          <div
            class="rounded-md border border-mark-edge/60 bg-mark/30 p-3"
            data-testid="refused-group"
          >
            <p class="m-0 text-sm font-medium">
              {titleFor(record, refused.keepId)} ←{" "}
              <For each={refused.mergeIds}>
                {(id, index) => (
                  <>
                    {index() > 0 ? ", " : ""}
                    <A
                      class="text-accent underline"
                      href={knowledgeLinkFor(record, id)}
                    >
                      {titleFor(record, id)}
                    </A>
                  </>
                )}
              </For>
            </p>
            <p class="mt-2 text-xs text-gold">
              {REFUSAL_LABELS[refused.error.code]}
            </p>
          </div>
        )}
      </For>
      <details class="text-xs text-muted">
        <summary class="cursor-pointer">Technical details</summary>
        <p class="mt-2">
          Operation ID: <code>{receipt.operationId}</code>
          <br />
          Replayed: {receipt.replayed ? "true" : "false"}
        </p>
      </details>
    </div>
  );
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

  const scopeLabel = (group: DedupPreviewGroup) =>
    group.scope === "global" ? "Shared (no project)" : "Project";

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
          Accepted decisions are applied only after confirmation.
        </p>
        <p class="mt-1 text-xs text-muted">
          Marks are saved only in this browser.
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

      <Show when={applyNotice()}>
        {(notice) => (
          <p
            class={`mb-4 rounded-md border px-3 py-2 text-sm ${
              notice().kind === "locked"
                ? "border-mark-edge/60 bg-mark/30 text-gold"
                : notice().kind === "error"
                  ? "border-danger/40 bg-danger/10 text-danger"
                  : "border-line bg-soft text-muted"
            }`}
            role={notice().kind === "status" ? "status" : "alert"}
            data-testid="apply-notice"
          >
            {notice().text}
          </p>
        )}
      </Show>

      <Show when={pendingApplies().length > 0}>
        <section
          class="mb-5 space-y-2 rounded-lg border border-mark-edge/60 bg-mark/30 px-4 py-3"
          aria-label="Pending apply operations"
          data-testid="pending-dedup-applies"
        >
          <For
            each={pendingApplies()
              .slice()
              .sort((a, b) => b.createdAt - a.createdAt)}
          >
            {(record) => {
              const confirmed = () =>
                applyResults().some(
                  (result) => result.receipt.operationId === record.operationId,
                );
              return (
                <div class="flex flex-wrap items-center justify-between gap-3">
                  <div class="text-sm">
                    <p class="m-0">
                      {activeApplyKey() === record.key
                        ? "Applying…"
                        : confirmed()
                          ? "Apply receipt confirmed — retry replays this operation"
                          : "The last apply didn't confirm — Retry"}
                    </p>
                    <p class="mt-1 text-xs text-muted">
                      Operation <code>{record.operationId}</code>
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    data-testid="retry-dedup-apply"
                    disabled={applyPending()}
                    onClick={() => void retryApply(record)}
                  >
                    Retry
                  </Button>
                </div>
              );
            }}
          </For>
        </section>
      </Show>

      <Show when={applyResults().length > 0}>
        <section
          class="mb-5 space-y-4 rounded-lg border border-thread bg-soft px-4 py-4"
          aria-label="Dedup apply receipts"
          role="status"
          data-testid="dedup-apply-receipt"
        >
          <h2 class="m-0 text-base font-semibold">Apply receipts</h2>
          <For each={applyResults()}>
            {(result) => (
              <article data-testid="dedup-apply-operation">
                {showReceipt(result.record, result.receipt)}
              </article>
            )}
          </For>
        </section>
      </Show>

      <Show when={preview.data()}>
        <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
          <p class="text-xs text-muted">
            {groups().length} candidate{" "}
            {groups().length === 1 ? "group" : "groups"}
            {preview.loading() ? " · scanning again" : ""}
          </p>
          <div class="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              data-testid="apply-accepted"
              disabled={
                acceptedGroups().length === 0 ||
                applyPending() ||
                pendingApplies().length > 0 ||
                preview.loading()
              }
              onClick={() => void openConfirmation()}
            >
              Apply {acceptedGroups().length} accepted…
            </Button>
            <Button
              variant="outline"
              size="sm"
              data-testid="dedup-rescan"
              onClick={rescan}
            >
              Rescan
            </Button>
          </div>
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

      <ConfirmDialog
        open={confirmOpen()}
        title="Apply accepted duplicate decisions?"
        description={
          <div class="space-y-3">
            <p>
              The accepted groups below will be applied to the gateway. Review
              the affected entries and consequences before continuing.
            </p>
            <ul class="space-y-3 pl-5">
              <For each={acceptedGroups()}>
                {(group) => {
                  const mark = () => markFor(group);
                  const keepTitle = () =>
                    group.candidates.find(
                      (candidate) => candidate.logical_id === mark()?.keepId,
                    )?.title ?? mark()?.keepId;
                  const mergeTitles = () =>
                    group.candidates
                      .filter(
                        (candidate) => candidate.logical_id !== mark()?.keepId,
                      )
                      .map((candidate) => candidate.title)
                      .join(", ");
                  return (
                    <li>
                      <p class="m-0 font-medium">
                        {keepTitle()} ← {mergeTitles()}
                      </p>
                      <p class="mt-1 text-xs text-muted">
                        {group.scope === "project"
                          ? "This project's .lore.md is regenerated (when .lore.md export is enabled)"
                          : ".lore.md files are not affected (shared entries are not exported)"}
                      </p>
                    </li>
                  );
                }}
              </For>
            </ul>
            <p class="text-xs text-muted">
              {syncStatusLoading()
                ? "Checking sync status…"
                : syncStatusFailed()
                  ? "Sync status could not be checked."
                  : syncConsequence()}
            </p>
            <p class="text-xs text-muted">
              Each scope is a separate operation. Receipts are recorded under an
              operation ID so a retry replays the same result.
            </p>
          </div>
        }
        confirmLabel={`Apply ${acceptedGroups().length} accepted`}
        pending={applyPending() || syncStatusLoading()}
        onConfirm={() => void applyAccepted()}
        onCancel={() => setConfirmOpen(false)}
      />
    </main>
  );
};
