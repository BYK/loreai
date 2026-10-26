import type { Component } from "solid-js";
import { createMemo, For, Show } from "solid-js";
import { A, useSearchParams } from "@solidjs/router";
import type { ProjectSummary } from "~/contracts";
import { projectHref, sessionsHref } from "~/lib/href";
import { pluralize, formatWhen } from "~/lib/format";
import { TextField, TextFieldInput } from "~/components/ui/text-field";
import { Button } from "~/components/ui/button";
import { Icon } from "~/components/shell/Icon";
import { MergeProjectsAction } from "./ProjectActions";
import { StateCard } from "./StateCard";
import { ResponsiveSelect } from "~/components/ui/responsive-select";
import { directoryProjects, type DirectorySort } from "~/lib/project-directory";

export const ProjectDirectory: Component<{
  sessionsMode?: boolean;
  projects: readonly ProjectSummary[] | undefined;
}> = (props) => {
  const [params, setParams] = useSearchParams();
  const filter = () =>
    typeof params.projectFilter === "string"
      ? params.projectFilter.slice(0, 500)
      : "";
  const setFilter = (value: string) =>
    setParams(
      { projectFilter: value.slice(0, 500) || undefined },
      { replace: true },
    );
  const sort = (): DirectorySort =>
    params.projectSort === "name" || params.projectSort === "knowledge"
      ? params.projectSort
      : "recent";
  const groups = createMemo(() =>
    directoryProjects(props.projects ?? [], filter(), sort()),
  );
  const visibleCount = () =>
    groups().repositories.reduce(
      (count, group) => count + group.projects.length,
      0,
    ) +
    groups().local.length +
    groups().unattributed.length;
  const projectLink = (
    project: ProjectSummary,
    compact = false,
    remote?: string,
  ) => (
    <A
      data-testid="project-card"
      href={
        props.sessionsMode ? sessionsHref(project.id) : projectHref(project.id)
      }
      class={
        compact
          ? "group block min-w-0 border-t border-line px-4 py-3 outline-none hover:bg-soft/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          : "group flex h-full min-h-36 flex-col rounded-lg border border-line bg-bg p-4 outline-none hover:border-accent/50 hover:bg-soft/50 focus-visible:ring-2 focus-visible:ring-ring"
      }
    >
      <Show when={remote}>
        <div class="mb-3 font-mono text-[11px] text-muted [overflow-wrap:anywhere]">
          {remote}
        </div>
      </Show>
      <div class="mb-2 flex min-w-0 items-start gap-2.5">
        <Show when={!compact}>
          <Icon name="folder" class="mt-0.5 shrink-0 text-accent" />
        </Show>
        <span class="min-w-0 text-sm font-semibold text-heading [overflow-wrap:anywhere]">
          {project.name || project.path}
        </span>
        <Icon
          name="chevron"
          class="ml-auto mt-0.5 size-3.5 shrink-0 text-muted"
        />
      </div>
      <div
        class={`${compact ? "mb-2" : "mb-4"} font-mono text-[11px] text-muted [overflow-wrap:anywhere]`}
      >
        {project.path}
      </div>
      <div
        class={`${compact ? "" : "mt-auto border-t border-line pt-3"} flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted`}
      >
        <span>
          {`${project.knowledge_count} ${project.knowledge_count === 1 ? "entry" : "entries"}`}{" "}
          · {pluralize(project.session_count, "session")}
        </span>
        <Show when={project.last_activity}>
          <span>{formatWhen(project.last_activity)}</span>
        </Show>
      </div>
    </A>
  );
  const cards = (projects: readonly ProjectSummary[]) => (
    <ul class="grid list-none gap-3 p-0 sm:grid-cols-2 xl:grid-cols-3">
      <For each={projects}>
        {(project) => <li class="min-w-0">{projectLink(project)}</li>}
      </For>
    </ul>
  );
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
              placeholder="Filter by name, path or recorded remote…"
              class="h-11 bg-bg text-base md:h-9 md:text-xs"
              value={filter()}
              onInput={(event) => setFilter(event.currentTarget.value)}
            />
          </TextField>
          <div class="flex flex-wrap items-center gap-3">
            <ResponsiveSelect
              label="Sort projects"
              sheetTitle="Sort projects"
              value={sort()}
              options={["recent", "name", "knowledge"]}
              optionLabel={(value) =>
                value === "name"
                  ? "Name"
                  : value === "knowledge"
                    ? "Knowledge count"
                    : "Recent activity"
              }
              onChange={(value) =>
                setParams({
                  projectSort:
                    value === "name" || value === "knowledge"
                      ? value
                      : undefined,
                })
              }
              triggerClass="h-11 min-w-44 text-xs md:h-9"
            />
            <span class="text-xs tabular-nums text-muted">
              {visibleCount()}{" "}
              {visibleCount() === 1 ? "project record" : "project records"}
            </span>
          </div>
        </div>
        <Show
          when={(props.projects?.length ?? 0) > 0}
          fallback={
            <StateCard kind="empty" title="No projects yet">
              Open a terminal in your project and run <code>lore run</code>,
              then use the launched agent to capture a session. Return here to
              browse the recorded memory.
            </StateCard>
          }
        >
          <Show
            when={visibleCount()}
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
            <div class="space-y-7">
              <Show when={groups().repositories.length}>
                <section aria-label="Repositories">
                  <h2 class="mb-1 text-sm font-semibold text-heading">
                    Repositories
                  </h2>
                  <p class="mb-4 text-xs text-muted">
                    Checkouts with the same recorded remote appear together.
                    Each keeps its own memory.
                  </p>
                  <ul
                    aria-label="Repository groups"
                    class="grid list-none items-start gap-3 p-0 sm:grid-cols-2 xl:grid-cols-3"
                  >
                    <For each={groups().repositories}>
                      {(group) => (
                        <li
                          class="min-w-0 self-stretch"
                          data-repository={group.remote}
                        >
                          <Show
                            when={group.projects.length === 1}
                            fallback={
                              <section
                                aria-label={group.remote}
                                class="h-full overflow-hidden rounded-lg border border-line bg-bg"
                              >
                                <div class="px-4 py-3">
                                  <h3 class="font-mono text-[11px] text-muted [overflow-wrap:anywhere]">
                                    {group.remote}
                                  </h3>
                                  <p class="mt-1 text-xs text-muted">
                                    {group.projects.length} recorded checkouts
                                  </p>
                                </div>
                                <For each={group.projects}>
                                  {(project) => projectLink(project, true)}
                                </For>
                              </section>
                            }
                          >
                            {group.projects[0] &&
                              projectLink(
                                group.projects[0],
                                false,
                                group.remote,
                              )}
                          </Show>
                        </li>
                      )}
                    </For>
                  </ul>
                </section>
              </Show>
              <Show when={groups().local.length}>
                <section aria-label="Local projects">
                  <h2 class="mb-1 text-sm font-semibold text-heading">
                    Local projects
                  </h2>
                  <p class="mb-3 text-xs text-muted">No git remote recorded.</p>
                  {cards(groups().local)}
                </section>
              </Show>
              <Show when={groups().unattributed.length}>
                <section aria-label="Unattributed sessions">
                  <h2 class="mb-1 text-sm font-semibold text-heading">
                    Unattributed sessions
                  </h2>
                  <p class="mb-3 text-xs text-muted">
                    These sessions arrived without a project path. Open a record
                    to inspect its sessions; start future captures with{" "}
                    <code>lore run</code> from the project directory.
                  </p>
                  {cards(groups().unattributed)}
                </section>
              </Show>
            </div>
          </Show>
        </Show>
      </Show>
      <div class="mt-6 border-t border-line pt-4">
        <MergeProjectsAction />
      </div>
    </div>
  );
};
