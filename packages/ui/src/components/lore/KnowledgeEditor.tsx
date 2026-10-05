import type { Component } from "solid-js";
import {
  For,
  Show,
  createEffect,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";

import type {
  KnowledgeEffects,
  KnowledgeEntry,
  KnowledgeVersionHistory,
} from "~/contracts";
import type { Loader } from "~/lib/loader";
import type { LocalDraft } from "~/db";
import { isApiError } from "~/lib/api";
import { formatConfidence, formatWhen } from "~/lib/format";
import { useWorkspace } from "~/routes/workspace";
import { Button } from "~/components/ui/button";
import { ConfirmDialog } from "~/components/ui/confirm-dialog";
import { StateCard } from "~/components/lore/StateCard";
import {
  KnowledgeEffectsSummary,
  loreEffectOutcome,
} from "~/components/lore/KnowledgeEffectsSummary";

const CATEGORIES = [
  "decision",
  "pattern",
  "preference",
  "architecture",
  "gotcha",
] as const;

type Scope = "project" | "shared";

function entryScope(entry: KnowledgeEntry): Scope {
  return entry.project_id === null ||
    entry.cross_project === true ||
    entry.cross_project === 1
    ? "shared"
    : "project";
}

function isStoredDraft(value: unknown, key: string): value is LocalDraft {
  if (!value || typeof value !== "object") return false;
  const draft = value as Partial<LocalDraft>;
  const body = draft.body;
  return (
    draft.key === key &&
    draft.kind === "knowledge" &&
    typeof draft.target === "string" &&
    !!body &&
    typeof body.title === "string" &&
    typeof body.content === "string" &&
    typeof body.category === "string" &&
    (body.confidence === undefined ||
      (typeof body.confidence === "number" &&
        body.confidence >= 0 &&
        body.confidence <= 1)) &&
    (body.scope === undefined ||
      body.scope === "project" ||
      body.scope === "shared") &&
    (draft.baseRevision === undefined ||
      (Number.isSafeInteger(draft.baseRevision) && draft.baseRevision > 0))
  );
}

function currentRevision(
  history: KnowledgeVersionHistory | undefined,
): number | undefined {
  return history?.versions.find((version) => version.is_current)?.version;
}

function savedEffectText(
  effects: KnowledgeEffects,
  revision: number,
  changed: string[],
): string {
  const lore = loreEffectOutcome(effects, changed.includes("scope"));
  const agents =
    effects.agents_file.mode === "pointer"
      ? "AGENTS.md pointer unchanged"
      : effects.agents_file.mode === "inline"
        ? "AGENTS.md inline section updates on the next idle export"
        : "AGENTS.md export is off";
  const sync = effects.sync.enabled ? "Sync is enabled" : "Sync is off";
  return `Saved as v${revision} · ${lore} · ${agents} · ${sync}`;
}

export const KnowledgeEditor: Component<{
  entry: KnowledgeEntry;
  versions: Loader<KnowledgeVersionHistory>;
  reloadEntry: () => void;
  onDeleted?: () => void;
}> = (props) => {
  const ws = useWorkspace();
  const id = () => props.entry.logical_id ?? props.entry.id;
  const draftKey = () => `knowledge/${id()}`;
  const availableDraft = () => (draftLoading() ? undefined : savedDraft());
  const [editing, setEditing] = createSignal(false);
  const [title, setTitle] = createSignal("");
  const [content, setContent] = createSignal("");
  const [category, setCategory] =
    createSignal<(typeof CATEGORIES)[number]>("decision");
  const [confidenceText, setConfidenceText] = createSignal("0.8");
  const confidence = () => {
    const raw = confidenceText().trim();
    if (!raw) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 && value <= 1
      ? value
      : undefined;
  };
  const [scope, setScope] = createSignal<Scope>("project");
  const [baseRevision, setBaseRevision] = createSignal<number>();
  const [freshRevision, setFreshRevision] = createSignal<number>();
  const [freshHead, setFreshHead] =
    createSignal<KnowledgeVersionHistory["versions"][number]>();
  const [savedDraft, setSavedDraft] = createSignal<LocalDraft>();
  const [draftLoading, setDraftLoading] = createSignal(true);
  const [draftNotice, setDraftNotice] = createSignal("");
  const [dirty, setDirty] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [saveError, setSaveError] = createSignal("");
  const [titleConflict, setTitleConflict] = createSignal("");
  const [conflict, setConflict] = createSignal("");
  const [locked, setLocked] = createSignal(false);
  const [success, setSuccess] = createSignal("");
  const [deleteDialog, setDeleteDialog] = createSignal(false);
  const [deleteEffects, setDeleteEffects] = createSignal<KnowledgeEffects>();
  const [deleteExpectedRevision, setDeleteExpectedRevision] =
    createSignal<number>();
  const [deleteLoading, setDeleteLoading] = createSignal(false);
  const [deletePending, setDeletePending] = createSignal(false);
  const [deleteError, setDeleteError] = createSignal("");

  const revision = () =>
    freshRevision() ?? currentRevision(props.versions.data());
  const currentVersion = () =>
    freshHead() ??
    props.versions.data()?.versions.find((version) => version.is_current);
  const projectless = () => props.entry.project_id == null;

  onMount(() => {
    void (async () => {
      try {
        const stored = await ws.state.drafts.get(draftKey());
        if (stored && isStoredDraft(stored, draftKey())) {
          setSavedDraft(stored);
        } else if (stored) {
          setDraftNotice("A saved draft could not be read on this device.");
        }
      } catch {
        setDraftNotice("Local draft storage is unavailable on this device.");
      } finally {
        setDraftLoading(false);
        if (ws.state.cache.status() === "unavailable")
          setDraftNotice("Local draft storage is unavailable on this device.");
      }
    })();
  });

  const makeDraft = (): LocalDraft => ({
    key: draftKey(),
    kind: "knowledge",
    target: id(),
    body: {
      title: title(),
      content: content(),
      category: category(),
      ...(confidence() === undefined ? {} : { confidence: confidence() }),
      scope: scope(),
    },
    baseRevision: baseRevision(),
    updatedAt: Date.now(),
  });

  const persistDraft = async (): Promise<boolean> => {
    if (baseRevision() === undefined) return false;
    const draft = makeDraft();
    const persisted = await ws.state.drafts.put(draft);
    if (persisted) {
      setSavedDraft(draft);
      setDraftNotice("");
      return true;
    }
    setDraftNotice(
      "Could not save this draft on this device. It may be lost if you leave this page.",
    );
    return false;
  };

  createEffect(() => {
    if (!editing() || !dirty() || saving()) return;
    const timer = setTimeout(() => void persistDraft(), 350);
    onCleanup(() => clearTimeout(timer));
  });

  const beginEditing = () => {
    setTitle(props.entry.title);
    setContent(props.entry.content);
    setCategory(
      CATEGORIES.includes(props.entry.category as (typeof CATEGORIES)[number])
        ? (props.entry.category as (typeof CATEGORIES)[number])
        : "decision",
    );
    setConfidenceText(String(props.entry.confidence));
    setScope(entryScope(props.entry));
    setBaseRevision(revision());
    setDirty(false);
    setSaveError("");
    setTitleConflict("");
    setConflict("");
    setSuccess("");
    setEditing(true);
  };

  const resumeDraft = () => {
    const draft = savedDraft();
    if (!draft) return;
    const latestRevision = revision();
    const draftRevision = draft.baseRevision;
    setTitle(draft.body.title);
    setContent(draft.body.content);
    setCategory(
      CATEGORIES.includes(draft.body.category as (typeof CATEGORIES)[number])
        ? (draft.body.category as (typeof CATEGORIES)[number])
        : "decision",
    );
    setConfidenceText(String(draft.body.confidence ?? props.entry.confidence));
    setScope(
      projectless() ? "shared" : (draft.body.scope ?? entryScope(props.entry)),
    );
    setBaseRevision(draftRevision);
    setDirty(false);
    setSaveError("");
    setTitleConflict("");
    setConflict(
      latestRevision !== undefined && draftRevision !== latestRevision
        ? "This draft is based on an older revision. Compare the server version and your draft before continuing."
        : "",
    );
    setEditing(true);
  };

  const discardDraft = async () => {
    const removed = await ws.state.drafts.delete(draftKey());
    if (!removed) {
      setDraftNotice("Could not remove this draft from this device.");
      return;
    }
    setSavedDraft(undefined);
    setDraftNotice("");
    setDirty(false);
    setEditing(false);
  };

  const invalidateCollections = async (
    before: KnowledgeEntry,
    after?: KnowledgeEntry,
  ) => {
    const scopes = new Set<string>();
    for (const entry of [before, after]) {
      if (!entry) continue;
      if (entry.project_id) scopes.add(entry.project_id);
      if (entryScope(entry) === "shared") {
        for (const project of ws.projects.data() ?? []) scopes.add(project.id);
      }
    }
    await Promise.all(
      [...scopes].map((projectId) =>
        ws.state.knowledge.invalidateProject(projectId),
      ),
    );
  };

  const refreshAfterConflict = async () => {
    props.versions.reload();
    props.reloadEntry();
    const latest = await ws.tracked(() =>
      ws.client.listKnowledgeVersions(id(), { includeDeleted: true }),
    );
    setFreshRevision(currentRevision(latest));
    setFreshHead(latest.versions.find((version) => version.is_current));
  };

  const save = async (event: SubmitEvent) => {
    event.preventDefault();
    const expectedRevision = baseRevision();
    if (expectedRevision === undefined || saving()) return;
    const confidenceValue = confidence();
    if (confidenceValue === undefined) {
      setSaveError("Confidence must be a number from 0 to 1.");
      return;
    }
    setSaving(true);
    setSaveError("");
    setTitleConflict("");
    setConflict("");
    try {
      const result = await ws.tracked(() =>
        ws.client.editKnowledge(id(), {
          expected_revision: expectedRevision,
          title: title(),
          content: content(),
          category: category(),
          confidence: confidenceValue,
          scope: projectless() ? "shared" : scope(),
        }),
      );
      if (!result.entry)
        throw new Error("Saved knowledge entry was unavailable");
      await ws.state.knowledge.reconcile(result.entry);
      await invalidateCollections(props.entry, result.entry);
      props.reloadEntry();
      props.versions.reload();
      setFreshRevision(result.revision);
      setFreshHead(undefined);
      setBaseRevision(result.revision);
      const removed = savedDraft()
        ? await ws.state.drafts.delete(draftKey())
        : true;
      if (removed) setSavedDraft(undefined);
      else
        setDraftNotice(
          "The entry was saved, but its local draft could not be removed.",
        );
      setDirty(false);
      setEditing(false);
      setSuccess(
        savedEffectText(result.effects, result.revision, result.changed),
      );
    } catch (error) {
      if (isApiError(error) && error.errorType === "stale_revision") {
        await persistDraft();
        setConflict(
          "This entry changed since you started editing. Rebase your draft onto the latest revision before saving.",
        );
        try {
          await refreshAfterConflict();
        } catch {
          setSaveError("Could not reload the latest revision. Try again.");
        }
      } else if (isApiError(error) && error.errorType === "title_conflict") {
        setTitleConflict(
          "Another entry in this scope already uses this title.",
        );
      } else if (isApiError(error) && error.kind === "forbidden") {
        await persistDraft();
        setLocked(true);
        setEditing(false);
        setSaveError("Editing is unavailable in hosted mode.");
      } else {
        setSaveError(
          error instanceof Error ? error.message : "Could not save this entry.",
        );
      }
    } finally {
      setSaving(false);
    }
  };

  const rebaseDraft = () => {
    const nextRevision = revision();
    if (nextRevision === undefined || nextRevision === baseRevision()) return;
    setBaseRevision(nextRevision);
    setConflict("");
    setSaveError("");
    setDirty(true);
  };

  const loadDeleteEffects = async () => {
    const expectedRevision = revision();
    if (expectedRevision === undefined || locked()) return;
    setDeleteLoading(true);
    setDeleteError("");
    try {
      const effects = await ws.tracked(() =>
        ws.client.getKnowledgeEffects(id()),
      );
      if (effects.revision !== expectedRevision) {
        try {
          await refreshAfterConflict();
        } catch {
          setDeleteError(
            "This entry changed while deletion consequences were loading, but its latest revision could not be reloaded. Cancel and try again.",
          );
          return;
        }
        setDeleteError(
          "This entry changed while deletion consequences were loading. The latest revision and effects have been reloaded; review them before deleting.",
        );
        return;
      }
      setDeleteEffects(effects);
      setDeleteExpectedRevision(effects.revision);
      setDeleteDialog(true);
    } catch (error) {
      if (isApiError(error) && error.kind === "forbidden") {
        setLocked(true);
        setDeleteError("Editing is unavailable in hosted mode.");
      } else {
        setDeleteError(
          error instanceof Error
            ? error.message
            : "Could not load deletion consequences.",
        );
      }
    } finally {
      setDeleteLoading(false);
    }
  };

  const confirmDelete = async () => {
    const expectedRevision = deleteExpectedRevision();
    if (expectedRevision === undefined || deletePending()) return;
    setDeletePending(true);
    setDeleteError("");
    try {
      await ws.tracked(() => ws.client.deleteKnowledge(id(), expectedRevision));
      await ws.state.knowledge.remove(id());
      await invalidateCollections(props.entry);
      const removed = savedDraft()
        ? await ws.state.drafts.delete(draftKey())
        : true;
      if (!removed)
        setDraftNotice(
          "The entry was deleted, but its local draft could not be removed.",
        );
      setDeleteDialog(false);
      props.onDeleted?.();
    } catch (error) {
      if (isApiError(error) && error.errorType === "stale_revision") {
        setDeleteError(
          "This entry changed after the confirmation was opened. The latest revision and effects have been reloaded; review them before deleting.",
        );
        try {
          await refreshAfterConflict();
          const effects = await ws.tracked(() =>
            ws.client.getKnowledgeEffects(id()),
          );
          setDeleteEffects(effects);
          setDeleteExpectedRevision(effects.revision);
        } catch {
          setDeleteError(
            "This entry changed. Could not reload its revision and effects; cancel and try again.",
          );
        }
      } else if (isApiError(error) && error.kind === "forbidden") {
        setLocked(true);
        setDeleteError("Editing is unavailable in hosted mode.");
      } else {
        setDeleteError(
          error instanceof Error
            ? error.message
            : "Could not delete this entry.",
        );
      }
    } finally {
      setDeletePending(false);
    }
  };

  return (
    <div class="mt-3 space-y-3" data-testid="knowledge-edit-actions">
      <Show when={success()}>
        <p
          class="rounded-md border border-line bg-soft px-3 py-2 text-sm"
          role="status"
          data-testid="knowledge-save-success"
        >
          {success()}
        </p>
      </Show>
      <Show when={availableDraft()}>
        {(draft) => (
          <div
            class="flex flex-wrap items-center gap-2 rounded-md border border-line bg-soft px-3 py-2 text-sm"
            role="status"
            data-testid="knowledge-draft-banner"
          >
            <span class="mr-auto">
              Unsaved draft from {formatWhen(draft().updatedAt)} (based on{" "}
              {draft().baseRevision === undefined
                ? "an unknown revision"
                : `v${draft().baseRevision}`}
              )
            </span>
            <Show when={!editing()}>
              <Button variant="outline" size="sm" onClick={resumeDraft}>
                Resume draft
              </Button>
            </Show>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void discardDraft()}
            >
              Discard draft
            </Button>
          </div>
        )}
      </Show>
      <Show when={draftNotice()}>
        <p class="text-xs text-muted" role="status">
          {draftNotice()}
        </p>
      </Show>
      <Show when={locked()}>
        <StateCard kind="locked" title="Editing unavailable">
          Writes are refused in hosted mode.
        </StateCard>
      </Show>
      <div class="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={!revision() || locked() || deletePending()}
          onClick={() => (editing() ? setEditing(false) : beginEditing())}
        >
          {editing() ? "Cancel edit" : "Edit"}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!revision() || locked() || deleteLoading()}
          onClick={() => void loadDeleteEffects()}
        >
          {deleteLoading() ? "Loading effects…" : "Delete"}
        </Button>
        <Show when={deleteError() && !deleteDialog()}>
          <span class="self-center text-sm text-danger" role="alert">
            {deleteError()}
          </span>
        </Show>
      </div>
      <Show when={editing()}>
        <form
          class="space-y-3 rounded-lg border border-line bg-bg p-4"
          data-testid="knowledge-editor"
          onSubmit={(event) => void save(event)}
        >
          <div class="grid gap-3 sm:grid-cols-2">
            <label class="grid gap-1 text-sm font-medium">
              Title
              <input
                class="h-10 rounded-md border border-input bg-surface px-3 text-sm"
                name="title"
                required
                value={title()}
                onInput={(event) => {
                  setTitle(event.currentTarget.value);
                  setDirty(true);
                  setTitleConflict("");
                }}
              />
              <Show when={titleConflict()}>
                <span class="text-xs text-danger" role="alert">
                  {titleConflict()}
                </span>
              </Show>
            </label>
            <label class="grid gap-1 text-sm font-medium">
              Category
              <select
                class="h-10 rounded-md border border-input bg-surface px-3 text-sm"
                name="category"
                value={category()}
                onChange={(event) => {
                  setCategory(
                    event.currentTarget.value as (typeof CATEGORIES)[number],
                  );
                  setDirty(true);
                }}
              >
                <For each={CATEGORIES}>
                  {(value) => <option value={value}>{value}</option>}
                </For>
              </select>
            </label>
            <label class="grid gap-1 text-sm font-medium">
              Confidence (
              {confidence() === undefined
                ? "enter 0 to 1"
                : formatConfidence(confidence() ?? 0)}
              )
              <input
                class="h-10 rounded-md border border-input bg-surface px-3 text-sm"
                name="confidence"
                type="number"
                required
                min="0"
                max="1"
                step="any"
                value={confidenceText()}
                onInput={(event) => {
                  setConfidenceText(event.currentTarget.value);
                  setDirty(true);
                }}
              />
            </label>
            <fieldset class="grid gap-2 border-0 p-0 text-sm font-medium">
              <legend>Scope</legend>
              <label class="flex items-center gap-2 font-normal">
                <input
                  type="radio"
                  name="scope"
                  value="project"
                  checked={!projectless() && scope() === "project"}
                  disabled={projectless()}
                  onChange={() => {
                    setScope("project");
                    setDirty(true);
                  }}
                />
                Project
              </label>
              <label class="flex items-center gap-2 font-normal">
                <input
                  type="radio"
                  name="scope"
                  value="shared"
                  checked={projectless() || scope() === "shared"}
                  onChange={() => {
                    setScope("shared");
                    setDirty(true);
                  }}
                />
                Shared
              </label>
              <Show when={projectless()}>
                <span class="text-xs text-muted">
                  This entry has no project and must remain shared.
                </span>
              </Show>
            </fieldset>
          </div>
          <label class="grid gap-1 text-sm font-medium">
            Content
            <textarea
              class="min-h-40 rounded-md border border-input bg-surface px-3 py-2 text-sm leading-relaxed"
              name="content"
              required
              value={content()}
              onInput={(event) => {
                setContent(event.currentTarget.value);
                setDirty(true);
              }}
            />
          </label>
          <Show when={conflict()}>
            <div
              class="rounded-md border border-gold/40 bg-gold-soft px-3 py-2 text-sm"
              role="status"
              data-testid="knowledge-edit-conflict"
            >
              <p class="m-0">{conflict()}</p>
              <div class="mt-3 grid gap-3 sm:grid-cols-2">
                <section class="rounded-md border border-line bg-bg p-3">
                  <h3 class="mb-2 text-xs font-semibold">
                    Current on server · v{revision() ?? "unknown"}
                  </h3>
                  <p class="m-0 font-medium">
                    {currentVersion()?.title ?? "Current title unavailable"}
                  </p>
                  <p class="mt-2 whitespace-pre-wrap text-xs leading-relaxed">
                    {currentVersion()?.content ?? "Current content unavailable"}
                  </p>
                </section>
                <section class="rounded-md border border-line bg-bg p-3">
                  <h3 class="mb-2 text-xs font-semibold">Your draft</h3>
                  <p class="m-0 font-medium">{title()}</p>
                  <p class="mt-2 whitespace-pre-wrap text-xs leading-relaxed">
                    {content()}
                  </p>
                </section>
              </div>
              <Button
                class="mt-2"
                variant="outline"
                size="sm"
                disabled={
                  revision() === undefined || revision() === baseRevision()
                }
                onClick={rebaseDraft}
                type="button"
              >
                Continue editing on v{revision() ?? "…"}
              </Button>
              <Button
                class="mt-2"
                variant="outline"
                size="sm"
                disabled={saving()}
                onClick={() => void discardDraft()}
                type="button"
              >
                Discard draft
              </Button>
            </div>
          </Show>
          <Show when={saveError()}>
            <p class="m-0 text-sm text-danger" role="alert">
              {saveError()}
            </p>
          </Show>
          <div class="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={saving() || !baseRevision()}>
              {saving() ? "Saving…" : "Save"}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={saving()}
              onClick={() => {
                if (dirty()) void persistDraft();
                setEditing(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      </Show>
      <ConfirmDialog
        open={deleteDialog()}
        title="Delete knowledge entry?"
        description={
          <div>
            <p>
              Delete “{currentVersion()?.title ?? props.entry.title}” at
              revision {deleteExpectedRevision()}. The live entry will be
              removed.
            </p>
            <Show when={deleteEffects()}>
              {(effects) => (
                <KnowledgeEffectsSummary effects={effects()} phase="confirm" />
              )}
            </Show>
            <p class="mb-0 text-sm">
              The deleted entry and versions remain in History for recovery.
              References purged by deletion are not restored.
            </p>
          </div>
        }
        confirmLabel="Delete entry"
        destructive
        pending={deletePending()}
        onConfirm={() => void confirmDelete()}
        onCancel={() => {
          if (!deletePending()) {
            setDeleteDialog(false);
            setDeleteError("");
          }
        }}
      >
        <Show when={deleteError()}>
          <p class="text-sm text-danger" role="alert">
            {deleteError()}
          </p>
        </Show>
      </ConfirmDialog>
    </div>
  );
};
