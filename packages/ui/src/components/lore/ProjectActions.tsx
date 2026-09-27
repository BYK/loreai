/**
 * Project actions (UI-08, #1823): rename, move sessions, clear, delete —
 * plus the projects-list merge-duplicates action. Every write goes through
 * `state.projectActions`, which purges the IndexedDB projections so a
 * deleted/cleared/merged project is never served stale.
 *
 * Hosted-mode refusals (a JSON 403 → `forbidden`) render an inline locked
 * notice, never a broken form; the merge route's hosted refusal is a plain
 * 400 and is shown verbatim.
 */
import type { Component } from "solid-js";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  on,
  Show,
  Switch,
} from "solid-js";
import { useNavigate } from "@solidjs/router";

import type { ProjectSummary } from "~/contracts";
import { isApiError } from "~/lib/api";
import { pluralize } from "~/lib/format";
import { useWorkspace } from "~/routes/workspace";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { TextField, TextFieldInput } from "../ui/text-field";

/** One notice per action kind; the last completed result is kept visible. */
type Notice = { kind: "forbidden" | "error" | "result"; text: string };

function noticeFor(error: unknown): Notice {
  if (isApiError(error)) {
    if (error.kind === "forbidden") {
      return {
        kind: "forbidden",
        text: "Not available in hosted mode — run a local gateway to use this action.",
      };
    }
    return { kind: "error", text: error.message };
  }
  return { kind: "error", text: String(error) };
}

const NoticeLine: Component<{ notice: Notice }> = (props) => (
  <div
    class={
      props.notice.kind === "forbidden"
        ? "text-xs text-warn"
        : props.notice.kind === "error"
          ? "text-xs text-danger"
          : "text-xs text-muted"
    }
    data-testid={`action-notice-${props.notice.kind}`}
    role={props.notice.kind === "result" ? "status" : "alert"}
  >
    {props.notice.text}
  </div>
);

export const ProjectActions: Component<{ project: ProjectSummary }> = (
  props,
) => {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const actions = ws.state.projectActions;

  const [renameOpen, setRenameOpen] = createSignal(false);
  const [moveOpen, setMoveOpen] = createSignal(false);
  const [confirmClear, setConfirmClear] = createSignal(false);
  const [confirmDelete, setConfirmDelete] = createSignal(false);
  const [pending, setPending] = createSignal<string | null>(null);
  const [notice, setNotice] = createSignal<Notice | null>(null);

  async function run<T>(
    label: string,
    fn: () => Promise<T>,
  ): Promise<T | undefined> {
    setPending(label);
    setNotice(null);
    try {
      return await fn();
    } catch (error) {
      setNotice(noticeFor(error));
      return undefined;
    } finally {
      setPending(null);
    }
  }

  const busy = () => pending() !== null;

  // Hosted-mode refusals can't be retried — close the dialog and leave the
  // notice on the section. Other errors keep the dialog open so the inline
  // notice stays in view and the user can retry.
  const closeOnForbidden = (result: unknown, close: () => void): boolean => {
    if (result) return false;
    if (notice()?.kind === "forbidden") close();
    return true;
  };

  return (
    <section data-testid="project-actions" class="border-b border-line py-5">
      <div class="eyebrow mb-2">Actions</div>
      <div class="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={busy()}
          onClick={() => {
            setNotice(null);
            setRenameOpen(true);
          }}
        >
          Rename…
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={busy() || props.project.session_count === 0}
          onClick={() => {
            setNotice(null);
            setMoveOpen(true);
          }}
        >
          Move sessions…
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={busy()}
          onClick={() => {
            setNotice(null);
            setConfirmClear(true);
          }}
        >
          Clear…
        </Button>
        <Button
          variant="destructive"
          size="sm"
          disabled={busy()}
          onClick={() => {
            setNotice(null);
            setConfirmDelete(true);
          }}
        >
          Delete project…
        </Button>
      </div>
      <Show when={notice()}>{(n) => <NoticeLine notice={n()} />}</Show>

      <RenameDialog
        project={props.project}
        open={renameOpen()}
        pending={pending() === "rename"}
        notice={notice()}
        onClose={() => setRenameOpen(false)}
        onSubmit={(name) => {
          void run("rename", () => actions.rename(props.project.id, name)).then(
            (result) => {
              if (result) {
                setRenameOpen(false);
                setNotice({
                  kind: "result",
                  text: `Renamed to ${result.name}`,
                });
              } else {
                closeOnForbidden(result, () => setRenameOpen(false));
              }
            },
          );
        }}
      />

      <MoveSessionsDialog
        project={props.project}
        open={moveOpen()}
        pending={pending() === "move"}
        notice={notice()}
        onClose={() => setMoveOpen(false)}
        onSubmit={(sessionIds, targetId, includeChildren) => {
          void run("move", () =>
            actions.move({
              session_ids: sessionIds,
              from_project_id: props.project.id,
              to_project_id: targetId,
              include_children: includeChildren,
            }),
          ).then((result) => {
            if (result) {
              setMoveOpen(false);
              setNotice({
                kind: "result",
                text: `Moved ${pluralize(result.sessions_moved, "session")}, ${pluralize(result.knowledge_moved, "knowledge entry", "knowledge entries")}`,
              });
            } else {
              closeOnForbidden(result, () => setMoveOpen(false));
            }
          });
        }}
      />

      <ConfirmDialog
        open={confirmClear()}
        title="Clear project data"
        description={`This deletes every knowledge entry, session and distillation recorded for ${props.project.name || props.project.path}. The project itself stays.`}
        confirmLabel="Clear project data"
        destructive
        pending={pending() === "clear"}
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => {
          void run("clear", () => actions.clear(props.project.id)).then(
            (result) => {
              if (result) {
                setConfirmClear(false);
                setNotice({
                  kind: "result",
                  text: `Cleared ${pluralize(result.knowledge_deleted ?? 0, "knowledge entry", "knowledge entries")}, ${pluralize(result.sessions_cleared ?? 0, "session")}`,
                });
              } else {
                closeOnForbidden(result, () => setConfirmClear(false));
              }
            },
          );
        }}
      >
        <Show when={notice()}>{(n) => <NoticeLine notice={n()} />}</Show>
      </ConfirmDialog>

      <ConfirmDialog
        open={confirmDelete()}
        title="Delete project"
        description={`This deletes ${props.project.name || props.project.path} and everything recorded for it — knowledge, sessions and distillations. This cannot be undone.`}
        confirmLabel="Delete project"
        destructive
        pending={pending() === "delete"}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          void run("delete", () => actions.remove(props.project.id)).then(
            (result) => {
              if (result) navigate("/");
              else closeOnForbidden(result, () => setConfirmDelete(false));
            },
          );
        }}
      >
        <Show when={notice()}>{(n) => <NoticeLine notice={n()} />}</Show>
      </ConfirmDialog>
    </section>
  );
};

const RenameDialog: Component<{
  project: ProjectSummary;
  open: boolean;
  pending: boolean;
  notice: Notice | null;
  onClose: () => void;
  onSubmit: (name: string) => void;
}> = (props) => {
  const [name, setName] = createSignal(props.project.name ?? "");
  createEffect(() => {
    if (props.open) setName(props.project.name ?? "");
  });
  const current = () => (props.project.name ?? "").trim();
  const dirty = () => name().trim() !== current() && name().trim() !== "";
  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename project</DialogTitle>
          <DialogDescription>
            The display name only — the recorded path stays {props.project.path}
            .
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (dirty()) props.onSubmit(name().trim());
          }}
        >
          <TextField>
            <TextFieldInput
              aria-label="Project name"
              value={name()}
              onInput={(event) => setName(event.currentTarget.value)}
              disabled={props.pending}
            />
          </TextField>
          <Show when={props.notice}>{(n) => <NoticeLine notice={n()} />}</Show>
          <DialogFooter class="mt-4">
            <Button
              type="button"
              variant="outline"
              disabled={props.pending}
              onClick={props.onClose}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!dirty() || props.pending}>
              {props.pending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

const MoveSessionsDialog: Component<{
  project: ProjectSummary;
  open: boolean;
  pending: boolean;
  notice: Notice | null;
  onClose: () => void;
  onSubmit: (
    sessionIds: string[],
    targetProjectId: string,
    includeChildren: boolean,
  ) => void;
}> = (props) => {
  const ws = useWorkspace();
  const [cursor, setCursor] = createSignal<string | null>(null);
  const [loaded, setLoaded] = createSignal<{
    items: Map<string, { session_id: string; message_count: number }>;
    next: string | null;
  }>({ items: new Map(), next: null });
  const [selected, setSelected] = createSignal<Set<string>>(new Set());
  const [target, setTarget] = createSignal<string | null>(null);
  const [includeChildren, setIncludeChildren] = createSignal(true);
  let contentEl: HTMLElement | undefined;

  const page = ws.state.sessions.page(() =>
    props.open ? { projectId: props.project.id, cursor: cursor() } : null,
  );

  // Reset all dialog state each time it opens.
  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return;
        setCursor(null);
        setLoaded({ items: new Map(), next: null });
        setSelected(new Set<string>());
        setTarget(null);
        setIncludeChildren(true);
      },
    ),
  );

  // Fold each fetched page into the accumulated checkbox list.
  createEffect(
    on(
      () => page.loader.data(),
      (data) => {
        if (!data) return;
        setLoaded((prev) => {
          const items = new Map(prev.items);
          for (const s of data.items) items.set(s.session_id, s);
          return { items, next: data.next_cursor };
        });
      },
    ),
  );

  const targets = createMemo(() =>
    (ws.projects.data() ?? []).filter((p) => p.id !== props.project.id),
  );
  const sessionList = () => [...loaded().items.values()];
  const canSubmit = () =>
    selected().size > 0 && target() !== null && !props.pending;

  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent ref={(el) => (contentEl = el)} tabIndex={-1}>
        <DialogHeader>
          <DialogTitle>Move sessions</DialogTitle>
          <DialogDescription>
            Move captured sessions out of{" "}
            {props.project.name || props.project.path} into another project.
          </DialogDescription>
        </DialogHeader>
        <div class="max-h-56 overflow-y-auto rounded-md border border-line p-2">
          <Switch>
            <Match when={page.loader.loading() && sessionList().length === 0}>
              <div class="p-2 text-xs text-muted">Loading sessions…</div>
            </Match>
            <Match when={sessionList().length === 0}>
              <div class="p-2 text-xs text-muted">No sessions to move.</div>
            </Match>
            <Match when={true}>
              <For each={sessionList()}>
                {(session) => (
                  <label class="flex items-center gap-2 px-1 py-1 text-xs">
                    <input
                      type="checkbox"
                      checked={selected().has(session.session_id)}
                      disabled={props.pending}
                      onChange={(event) =>
                        setSelected((prev) => {
                          const next = new Set(prev);
                          if (event.currentTarget.checked) {
                            next.add(session.session_id);
                          } else {
                            next.delete(session.session_id);
                          }
                          return next;
                        })
                      }
                    />
                    <span class="font-mono">{session.session_id}</span>
                    <span class="text-muted">
                      {pluralize(session.message_count, "message")}
                    </span>
                  </label>
                )}
              </For>
              <Show when={loaded().next}>
                <Button
                  variant="outline"
                  size="sm"
                  class="mt-2"
                  disabled={page.loader.loading()}
                  onClick={() => setCursor(loaded().next)}
                >
                  {page.loader.loading() ? "Loading…" : "Load more sessions"}
                </Button>
              </Show>
            </Match>
          </Switch>
        </div>
        <div class="mt-3">
          <Select
            // modal={false}: a modal Select inside the modal dialog locks
            // focus/hides outside content and its Escape focus-restore lands
            // on <body>, breaking the dialog's focus trap.
            modal={false}
            onOpenChange={(open) => {
              // Kobalte restores focus to the trigger a frame late; during
              // that gap the unmounted listbox leaves focus on <body> and Tab
              // escapes the dialog's focus scope — snap it back now.
              if (!open) contentEl?.focus();
            }}
            value={target()}
            onChange={setTarget}
            options={targets().map((p) => p.id)}
            placeholder="Choose a target project"
            itemComponent={(item) => (
              <SelectItem item={item.item}>
                {targets().find((p) => p.id === item.item.rawValue)?.name ||
                  targets().find((p) => p.id === item.item.rawValue)?.path}
              </SelectItem>
            )}
            disabled={props.pending || targets().length === 0}
          >
            <SelectTrigger aria-label="Target project" class="h-10">
              <SelectValue<string>>
                {(state) =>
                  state.selectedOption()
                    ? (targets().find((p) => p.id === state.selectedOption())
                        ?.name ??
                      targets().find((p) => p.id === state.selectedOption())
                        ?.path ??
                      state.selectedOption())
                    : "Choose a target project"
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent />
          </Select>
          <Show when={targets().length === 0}>
            <div class="mt-2 text-xs text-muted">
              No other project exists to move sessions into.
            </div>
          </Show>
        </div>
        <label class="mt-3 flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={includeChildren()}
            disabled={props.pending}
            onChange={(event) =>
              setIncludeChildren(event.currentTarget.checked)
            }
          />
          Include child (sub-agent) sessions
        </label>
        <Show when={props.notice}>{(n) => <NoticeLine notice={n()} />}</Show>
        <DialogFooter class="mt-4">
          <Button
            type="button"
            variant="outline"
            disabled={props.pending}
            onClick={props.onClose}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!canSubmit()}
            onClick={() =>
              props.onSubmit([...selected()], target()!, includeChildren())
            }
          >
            {props.pending
              ? "Moving…"
              : `Move ${selected().size} session${selected().size === 1 ? "" : "s"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/** Merge-duplicates action for the projects list (welcome) page. */
export const MergeProjectsAction: Component = () => {
  const ws = useWorkspace();
  const actions = ws.state.projectActions;
  const [confirm, setConfirm] = createSignal(false);
  const [pending, setPending] = createSignal(false);
  const [notice, setNotice] = createSignal<Notice | null>(null);

  return (
    <div data-testid="merge-projects" class="mt-6">
      <Button
        variant="outline"
        size="sm"
        disabled={pending()}
        onClick={() => {
          setNotice(null);
          setConfirm(true);
        }}
      >
        Merge duplicate projects
      </Button>
      <Show when={notice()}>{(n) => <NoticeLine notice={n()} />}</Show>
      <ConfirmDialog
        open={confirm()}
        title="Merge duplicate projects"
        description="Projects that share a git remote are merged into one: their knowledge, sessions and distillations move to the surviving project and the duplicates are removed. Paths without a recorded remote are untouched."
        confirmLabel="Merge duplicates"
        pending={pending()}
        onCancel={() => setConfirm(false)}
        onConfirm={() => {
          setPending(true);
          setNotice(null);
          void actions
            .merge()
            .then((result) => {
              setConfirm(false);
              if (result.merged === 0) {
                setNotice({
                  kind: "result",
                  text:
                    result.updated === 0
                      ? "No duplicates found."
                      : `No duplicates found — recorded git remotes for ${pluralize(result.updated, "project")}.`,
                });
              } else {
                setNotice({
                  kind: "result",
                  text: `Merged ${pluralize(result.merged, "project")}: ${result.mergeDetails
                    .map((d) => `${d.sourcePath} → ${d.targetPath}`)
                    .join(", ")}`,
                });
              }
            })
            .catch((error) => {
              const n = noticeFor(error);
              setNotice(n);
              if (n.kind === "forbidden") setConfirm(false);
            })
            .finally(() => setPending(false));
        }}
      >
        <Show when={notice()}>{(n) => <NoticeLine notice={n()} />}</Show>
      </ConfirmDialog>
    </div>
  );
};
