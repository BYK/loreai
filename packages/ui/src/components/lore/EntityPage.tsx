/**
 * `/entities/:entityId` — entity detail (UI-08 PR1): aliases, metadata form
 * (role / description / notes), relations, referencing knowledge, delete.
 * Names and metadata always render as text nodes — never HTML.
 */
import type { Component } from "solid-js";
import { createSignal, For, Match, Show, Switch } from "solid-js";
import { useNavigate } from "@solidjs/router";

import type { EntityDetail } from "~/contracts";
import { isApiError } from "~/lib/api";
import { formatWhen } from "~/lib/format";
import { useWorkspace } from "~/routes/workspace";
import { knowledgeHref } from "~/routes/Browse";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { ConfirmDialog } from "~/components/ui/confirm-dialog";
import {
  TextField,
  TextFieldInput,
  TextFieldLabel,
} from "~/components/ui/text-field";

import { errorStateFor } from "./ErrorState";
import { StateCard } from "./StateCard";

type MetadataField = "role" | "description" | "notes";

function metaString(
  detail: EntityDetail | undefined,
  key: MetadataField,
): string {
  const value = detail?.entity.metadata?.[key];
  return typeof value === "string" ? value : "";
}

const MetadataForm: Component<{
  detail: EntityDetail;
  onSaved?: (detail: EntityDetail) => void;
}> = (props) => {
  const ws = useWorkspace();
  const [role, setRole] = createSignal(metaString(props.detail, "role"));
  const [description, setDescription] = createSignal(
    metaString(props.detail, "description"),
  );
  const [notes, setNotes] = createSignal(metaString(props.detail, "notes"));
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<unknown>();
  const [saved, setSaved] = createSignal(false);

  const [baseline, setBaseline] = createSignal(props.detail);

  const dirty = () =>
    role().trim() !== metaString(baseline(), "role") ||
    description().trim() !== metaString(baseline(), "description") ||
    notes().trim() !== metaString(baseline(), "notes");

  const save = async () => {
    setSaving(true);
    setError(undefined);
    setSaved(false);
    try {
      const updated = await ws.state.entities.updateMetadata(
        props.detail.entity.id,
        { role: role(), description: description(), notes: notes() },
      );
      setRole(metaString(updated, "role"));
      setDescription(metaString(updated, "description"));
      setNotes(metaString(updated, "notes"));
      setBaseline(updated);
      setSaved(true);
      props.onSaved?.(updated);
    } catch (reason) {
      setError(reason);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      class="rounded-lg border border-line p-4"
      data-testid="entity-metadata"
    >
      <h2 class="mb-3 text-sm font-semibold">About this entity</h2>
      <Switch>
        <Match
          when={
            isApiError(error()) &&
            (error() as { kind: string }).kind === "forbidden"
          }
        >
          <StateCard kind="locked" title="Not available in hosted mode" compact>
            The gateway refuses entity edits for this deployment.
          </StateCard>
        </Match>
        <Match when={error()}>
          <div class="mb-3">
            {errorStateFor(error(), "Save", () => void save())}
          </div>
          <Fields
            role={[role, setRole]}
            description={[description, setDescription]}
            notes={[notes, setNotes]}
          />
        </Match>
        <Match when={true}>
          <Fields
            role={[role, setRole]}
            description={[description, setDescription]}
            notes={[notes, setNotes]}
          />
        </Match>
      </Switch>
      <div class="mt-3 flex items-center gap-3">
        <Button
          size="sm"
          disabled={!dirty() || saving()}
          onClick={() => void save()}
          data-testid="entity-save"
        >
          {saving() ? "Saving…" : "Save"}
        </Button>
        <Show when={saved() && !dirty()}>
          <span class="text-xs text-muted">Saved.</span>
        </Show>
      </div>
    </section>
  );
};

const Fields: Component<{
  role: [() => string, (v: string) => void];
  description: [() => string, (v: string) => void];
  notes: [() => string, (v: string) => void];
}> = (props) => (
  <div class="grid gap-3">
    <TextField value={props.role[0]()} onChange={props.role[1]}>
      <TextFieldLabel>Role</TextFieldLabel>
      <TextFieldInput
        on:input={(e) => props.role[1](e.currentTarget.value)}
        placeholder="e.g. colleague, maintainer"
        data-testid="entity-role"
      />
    </TextField>
    <TextField value={props.description[0]()} onChange={props.description[1]}>
      <TextFieldLabel>Description</TextFieldLabel>
      <TextFieldInput
        on:input={(e) => props.description[1](e.currentTarget.value)}
        data-testid="entity-description"
      />
    </TextField>
    <div class="flex flex-col gap-1">
      <label class="text-sm font-medium leading-none" for="entity-notes">
        Notes
      </label>
      <textarea
        id="entity-notes"
        class="flex min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        rows={3}
        value={props.notes[0]()}
        on:input={(e) => props.notes[1](e.currentTarget.value)}
        data-testid="entity-notes"
      />
    </div>
  </div>
);

export const EntityPage: Component<{ entityId: string }> = (props) => {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const detail = ws.state.entities.detail(() => props.entityId);

  const [confirmDelete, setConfirmDelete] = createSignal(false);
  const [deleting, setDeleting] = createSignal(false);
  const [deleteError, setDeleteError] = createSignal<unknown>();

  const remove = async () => {
    setDeleting(true);
    setDeleteError(undefined);
    try {
      await ws.state.entities.remove(props.entityId);
      navigate("/entities");
    } catch (reason) {
      setDeleteError(reason);
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  const projectName = (projectId: string | null) => {
    if (projectId === null) return null;
    const project = ws.projectById(projectId);
    return project?.name || project?.path || projectId;
  };

  return (
    <div
      class="mx-auto max-w-[940px] px-5 py-8 sm:px-7.5"
      data-testid="entity-page"
    >
      <Switch>
        <Match when={detail.loader.error() && !detail.loader.data()}>
          {errorStateFor(detail.loader.error(), "Entity", detail.loader.reload)}
        </Match>
        <Match when={!detail.loader.data()}>
          <StateCard kind="loading" title="Loading entity" />
        </Match>
        <Match when={detail.loader.data()}>
          {(value) => (
            <>
              <div class="eyebrow mb-2">Entity</div>
              <h1
                class="mb-1 text-[25px] font-semibold"
                data-testid="entity-name"
              >
                {value().entity.canonical_name}
              </h1>
              <p class="mb-4 text-sm text-muted">
                <Badge variant="teal">{value().entity.entity_type}</Badge>{" "}
                {value().entity.project_id === null
                  ? "cross-project"
                  : (projectName(value().entity.project_id) ??
                    value().entity.project_id)}
                {" · updated "}
                {formatWhen(value().entity.updated_at)}
              </p>

              <Show when={value().entity.aliases.length > 0}>
                <div
                  class="mb-4 flex flex-wrap gap-1.5"
                  data-testid="entity-aliases"
                >
                  <For each={value().entity.aliases}>
                    {(alias) => <Badge variant="outline">{alias}</Badge>}
                  </For>
                </div>
              </Show>

              <MetadataForm detail={value()} />

              <Show when={value().relations.length > 0}>
                <section class="mt-6" data-testid="entity-relations">
                  <h2 class="mb-2 text-sm font-semibold">
                    Relations ({value().relations.length})
                  </h2>
                  <ul class="list-none p-0">
                    <For each={value().relations}>
                      {(rel) => (
                        <li class="border-t border-line py-2 text-sm">
                          <span class="text-muted">{rel.relation} → </span>
                          {rel.other_name}{" "}
                          <Badge variant="outline">{rel.other_type}</Badge>
                        </li>
                      )}
                    </For>
                  </ul>
                </section>
              </Show>

              <Show when={value().knowledge.length > 0}>
                <section class="mt-6" data-testid="entity-knowledge">
                  <h2 class="mb-2 text-sm font-semibold">
                    Knowledge mentioning this entity ({value().knowledge.length}
                    )
                  </h2>
                  <ul class="list-none p-0">
                    <For each={value().knowledge}>
                      {(entry) => (
                        <li class="border-t border-line py-2 text-sm">
                          <a
                            class="text-accent underline"
                            href={
                              entry.project_id === null
                                ? `/knowledge/${encodeURIComponent(entry.id)}`
                                : knowledgeHref(entry.project_id, entry.id)
                            }
                          >
                            {entry.title}
                          </a>{" "}
                          <Badge variant="outline">{entry.category}</Badge>
                        </li>
                      )}
                    </For>
                  </ul>
                </section>
              </Show>

              <section class="mt-8 border-t border-line pt-4">
                <Switch>
                  <Match
                    when={
                      isApiError(deleteError()) &&
                      (deleteError() as { kind: string }).kind === "forbidden"
                    }
                  >
                    <StateCard
                      kind="locked"
                      title="Not available in hosted mode"
                      compact
                    >
                      The gateway refuses entity deletion for this deployment.
                    </StateCard>
                  </Match>
                  <Match when={deleteError()}>
                    {errorStateFor(deleteError(), "Delete", () =>
                      setDeleteError(undefined),
                    )}
                  </Match>
                </Switch>
                <Button
                  variant="destructive"
                  size="sm"
                  class="mt-3"
                  onClick={() => setConfirmDelete(true)}
                  data-testid="entity-delete"
                >
                  Delete entity
                </Button>
              </section>
            </>
          )}
        </Match>
      </Switch>

      <ConfirmDialog
        open={confirmDelete()}
        title="Delete this entity?"
        description={
          <>
            Deleting{" "}
            <strong>{detail.loader.data()?.entity.canonical_name}</strong>{" "}
            removes it, its aliases and its relations. Knowledge that mentioned
            it is kept.
          </>
        }
        confirmLabel="Delete"
        destructive
        pending={deleting()}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => void remove()}
      />
    </div>
  );
};
