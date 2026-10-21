import type { Component } from "solid-js";
import { createMemo, createSignal, For, Show } from "solid-js";
import { A } from "@solidjs/router";
import type { ProjectSummary } from "~/contracts";
import { projectHref, sessionsHref } from "~/lib/href";
import { pluralize, formatWhen } from "~/lib/format";
import { TextField, TextFieldInput } from "~/components/ui/text-field";
import { Button } from "~/components/ui/button";
import { Icon } from "~/components/shell/Icon";
import { MergeProjectsAction } from "./ProjectActions";
import { StateCard } from "./StateCard";

export const ProjectDirectory: Component<{
  sessionsMode?: boolean;
  projects: readonly ProjectSummary[] | undefined;
}> = (props) => {
  const [filter, setFilter] = createSignal("");
  const visible = createMemo(() => {
    const q = filter().trim().toLowerCase();
    return (props.projects ?? []).filter(
      (p) => !q || `${p.name ?? ""} ${p.path}`.toLowerCase().includes(q),
    );
  });
  return (
    <div
      data-testid="project-directory"
      class="mx-auto max-w-[1100px] px-5 py-7 sm:px-8"
    >
      <div class="eyebrow mb-2">Workspace</div>
      <h1 class="text-[25px] font-semibold text-heading">
        {props.sessionsMode
          ? "Choose a project for sessions"
          : "Choose a project"}
      </h1>
      <p class="mt-2 max-w-prose text-sm text-muted">
        Browse what your agents learned, revisit sessions, and pick up where you
        left off.
      </p>
      <Show
        when={props.projects}
        fallback={
          <div class="mt-6">
            <StateCard kind="loading" title="Loading projects" />
          </div>
        }
      >
        <div class="my-6 flex flex-wrap items-center justify-between gap-3">
          <TextField class="w-full max-w-sm">
            <TextFieldInput
              aria-label="Filter project cards"
              placeholder="Find a project by name or path…"
              class="h-9 bg-bg text-xs"
              value={filter()}
              onInput={(event) => setFilter(event.currentTarget.value)}
            />
          </TextField>
          <span class="text-xs tabular-nums text-muted">
            {visible().length} {visible().length === 1 ? "project" : "projects"}
          </span>
        </div>
        <Show
          when={(props.projects?.length ?? 0) > 0}
          fallback={
            <StateCard kind="empty" title="No projects yet">
              Run <code>lore run</code> in a project to start.
            </StateCard>
          }
        >
          <Show
            when={visible().length}
            fallback={
              <StateCard
                kind="empty"
                title="No projects match"
                action={
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setFilter("")}
                  >
                    Clear project filter
                  </Button>
                }
              />
            }
          >
            <ul class="grid list-none gap-3 p-0 sm:grid-cols-2 xl:grid-cols-3">
              <For each={visible()}>
                {(project) => (
                  <li class="min-w-0">
                    <A
                      data-testid="project-card"
                      href={
                        props.sessionsMode
                          ? sessionsHref(project.id)
                          : projectHref(project.id)
                      }
                      class="group flex h-full min-h-36 flex-col rounded-lg border border-line bg-bg p-4 outline-none hover:border-accent/50 hover:bg-soft/50 focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <div class="mb-3 flex min-w-0 items-center gap-2.5">
                        <span class="flex size-8 shrink-0 items-center justify-center rounded-md border border-line bg-surface text-accent">
                          <Icon name="folder" />
                        </span>
                        <span class="truncate text-sm font-semibold text-heading">
                          {project.name || project.path}
                        </span>
                        <Icon
                          name="chevron"
                          class="ml-auto size-3.5 text-muted"
                        />
                      </div>
                      <div
                        class="mb-4 truncate font-mono text-[10px] text-muted"
                        title={project.path}
                      >
                        {project.path}
                      </div>
                      <div class="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3 text-[11px] text-muted">
                        <span>
                          {`${project.knowledge_count} ${project.knowledge_count === 1 ? "entry" : "entries"}`}{" "}
                          · {pluralize(project.session_count, "session")}
                        </span>
                        <Show when={project.last_activity}>
                          <span>{formatWhen(project.last_activity)}</span>
                        </Show>
                      </div>
                    </A>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Show>
      </Show>
      <div class="mt-6 border-t border-line pt-4">
        <MergeProjectsAction />
      </div>
    </div>
  );
};
