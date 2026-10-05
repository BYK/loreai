import type { Component } from "solid-js";
import { Show, createSignal } from "solid-js";

import type {
  KnowledgeEffects,
  KnowledgeEntry,
  KnowledgeVersionHistory,
} from "~/contracts";
import type { Loader } from "~/lib/loader";
import { isApiError } from "~/lib/api";
import { useWorkspace } from "~/routes/workspace";
import { Button } from "~/components/ui/button";
import { ConfirmDialog } from "~/components/ui/confirm-dialog";
import {
  KnowledgeEffectsSummary,
  loreEffectOutcome,
} from "~/components/lore/KnowledgeEffectsSummary";

function currentRevision(
  history: KnowledgeVersionHistory | undefined,
): number | undefined {
  return history?.versions.find((version) => version.is_current)?.version;
}

function entryScope(entry: KnowledgeEntry): "project" | "shared" {
  return entry.project_id === null ||
    entry.cross_project === true ||
    entry.cross_project === 1
    ? "shared"
    : "project";
}

function successText(
  effects: KnowledgeEffects,
  revision: number,
  scopeChanged: boolean,
): string {
  const lore = loreEffectOutcome(effects, scopeChanged);
  const agents =
    effects.agents_file.mode === "pointer"
      ? "AGENTS.md pointer unchanged"
      : effects.agents_file.mode === "inline"
        ? "AGENTS.md inline section updates on the next idle export"
        : "AGENTS.md export is off";
  return `Restored as v${revision} · ${lore} · ${agents} · ${effects.sync.enabled ? "Sync is enabled" : "Sync is off"}`;
}

export const RestoreKnowledgeAction: Component<{
  id: string;
  history: Loader<KnowledgeVersionHistory>;
  versionId?: string;
  onRestored?: () => void;
}> = (props) => {
  const ws = useWorkspace();
  const [open, setOpen] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [pending, setPending] = createSignal(false);
  const [effects, setEffects] = createSignal<KnowledgeEffects>();
  const [expectedRevision, setExpectedRevision] = createSignal<number>();
  const [freshRevision, setFreshRevision] = createSignal<number>();
  const [freshHistory, setFreshHistory] =
    createSignal<KnowledgeVersionHistory>();
  const [error, setError] = createSignal("");
  const [locked, setLocked] = createSignal(false);
  const [notice, setNotice] = createSignal("");
  const target = () => {
    const versions =
      freshHistory()?.versions ?? props.history.data()?.versions ?? [];
    return props.versionId
      ? versions.find((version) => version.version_id === props.versionId)
      : versions
          .filter((version) => !version.is_deleted)
          .sort((a, b) => b.version - a.version)[0];
  };
  const restoreEffects = () => {
    const current = effects();
    const version = target();
    if (!current || !version) return current;
    return {
      ...current,
      scope: version.scope,
      is_deleted: false,
      lore_file: {
        ...current.lore_file,
        affected:
          version.scope === "project" &&
          current.project_id !== null &&
          current.lore_file.path !== null,
      },
    };
  };
  const revision = () =>
    freshRevision() ?? currentRevision(freshHistory() ?? props.history.data());

  const loadEffects = async () => {
    const expected = revision();
    if (expected === undefined || loading() || locked()) return;
    setLoading(true);
    setError("");
    try {
      const latest = await ws.tracked(() =>
        ws.client.getKnowledgeEffects(props.id),
      );
      if (latest.revision !== expected) {
        try {
          await reloadAfterConflict();
        } catch {
          setError(
            "The entry changed before restore confirmation opened, but its current revision and consequences could not be reloaded. Cancel and try again.",
          );
          return;
        }
        setError(
          "The entry changed before restore confirmation opened. Its current revision and consequences have been reloaded; review them before restoring.",
        );
        return;
      }
      setEffects(latest);
      setExpectedRevision(latest.revision);
      setOpen(true);
    } catch (reason) {
      if (isApiError(reason) && reason.kind === "forbidden") {
        setLocked(true);
        setError("Restoring is unavailable in hosted mode.");
      } else {
        setError(
          reason instanceof Error
            ? reason.message
            : "Could not load restore consequences.",
        );
      }
    } finally {
      setLoading(false);
    }
  };

  const invalidateCollections = async (
    entry: KnowledgeEntry,
    previousScope?: "project" | "shared",
  ) => {
    const scopes = new Set<string>();
    if (entry.project_id) scopes.add(entry.project_id);
    if (previousScope === "shared" || entryScope(entry) === "shared") {
      for (const project of ws.projects.data() ?? []) scopes.add(project.id);
    }
    await Promise.all(
      [...scopes].map((projectId) =>
        ws.state.knowledge.invalidateProject(projectId),
      ),
    );
  };

  const reloadAfterConflict = async () => {
    props.history.reload();
    const latest = await ws.tracked(() =>
      ws.client.listKnowledgeVersions(props.id, { includeDeleted: true }),
    );
    setFreshHistory(latest);
    setFreshRevision(currentRevision(latest));
    const latestEffects = await ws.tracked(() =>
      ws.client.getKnowledgeEffects(props.id),
    );
    setEffects(latestEffects);
    setExpectedRevision(latestEffects.revision);
  };

  const confirm = async () => {
    const expected = expectedRevision();
    if (expected === undefined || pending()) return;
    setPending(true);
    setError("");
    const previousScope = effects()?.scope;
    try {
      const result = await ws.tracked(() =>
        ws.client.restoreKnowledge(props.id, {
          expected_revision: expected,
          ...(props.versionId ? { version_id: props.versionId } : {}),
        }),
      );
      if (!result.entry)
        throw new Error("Restored knowledge entry was unavailable");
      await ws.state.knowledge.reconcile(result.entry);
      await invalidateCollections(result.entry, previousScope);
      props.history.reload();
      props.onRestored?.();
      setFreshRevision(result.revision);
      setNotice(
        successText(
          result.effects,
          result.revision,
          previousScope !== result.effects.scope,
        ),
      );
      setOpen(false);
    } catch (reason) {
      if (isApiError(reason) && reason.errorType === "stale_revision") {
        setError(
          "The entry changed after this confirmation opened. Its current revision and consequences have been reloaded; review them before restoring.",
        );
        try {
          await reloadAfterConflict();
        } catch {
          setError(
            "The entry changed, but its current revision could not be reloaded. Cancel and try again.",
          );
        }
      } else if (isApiError(reason) && reason.errorType === "title_conflict") {
        setError(
          "This title is now used by another entry in the target scope. Choose a different version or resolve the title conflict first.",
        );
      } else if (isApiError(reason) && reason.kind === "forbidden") {
        setLocked(true);
        setError("Restoring is unavailable in hosted mode.");
      } else {
        setError(
          reason instanceof Error
            ? reason.message
            : "Could not restore this entry.",
        );
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <span class="inline-flex flex-wrap items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        disabled={
          revision() === undefined || !target() || locked() || loading()
        }
        onClick={() => void loadEffects()}
      >
        {loading()
          ? "Loading effects…"
          : props.versionId
            ? `Restore v${target()?.version ?? ""}…`
            : "Restore…"}
      </Button>
      <Show when={notice()}>
        <span class="text-xs text-muted" role="status">
          {notice()}
        </span>
      </Show>
      <Show when={error() && !open()}>
        <span class="text-xs text-danger" role="alert">
          {error()}
        </span>
      </Show>
      <ConfirmDialog
        open={open()}
        title="Restore knowledge version?"
        description={
          <div>
            <p>
              Restore{" "}
              {props.versionId
                ? `v${target()?.version ?? ""}`
                : "the last live version"}{" "}
              as a new revision. Current head: v{expectedRevision()}.
            </p>
            <Show when={restoreEffects()}>
              {(value) => (
                <KnowledgeEffectsSummary
                  effects={value()}
                  phase="confirm"
                  scopeChanged={effects()?.scope !== value().scope}
                />
              )}
            </Show>
            <Show when={effects()?.is_deleted}>
              <p class="mb-0 text-sm">
                References removed by deletion are not restored.
              </p>
            </Show>
          </div>
        }
        confirmLabel="Restore version"
        pending={pending()}
        onConfirm={() => void confirm()}
        onCancel={() => {
          if (!pending()) {
            setOpen(false);
            setError("");
          }
        }}
      >
        <Show when={error()}>
          <p class="text-sm text-danger" role="alert">
            {error()}
          </p>
        </Show>
      </ConfirmDialog>
    </span>
  );
};
