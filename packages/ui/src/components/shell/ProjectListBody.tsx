import type { Component } from "solid-js";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  Show,
} from "solid-js";
import { A } from "@solidjs/router";

import type { ProjectSummary } from "~/contracts";
import { withWorkspaceFilter } from "~/lib/href";
import { sectionProjects } from "~/components/shell/nav-projects";
import { pins } from "~/state/pins";
import { cn } from "~/lib/utils";
import { StateCard } from "~/components/lore/StateCard";

export const ProjectListBody: Component<{
  projects: readonly ProjectSummary[] | undefined;
  activeProjectId: string | null;
  query: string;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  connectionUnauthorized?: boolean;
  connectionDetail?: string | null;
}> = (props) => {
  const [showAll, setShowAll] = createSignal(false);
  const filter = () => (props.query === "in:inbox" ? "" : props.query.trim());
  const sections = createMemo(() =>
    sectionProjects(
      props.projects ?? [],
      pins().pinned(),
      filter(),
      props.activeProjectId,
    ),
  );
  const autoExpandId = createMemo(() =>
    props.activeProjectId &&
    sections().rest.some((project) => project.id === props.activeProjectId)
      ? props.activeProjectId
      : null,
  );
  createEffect(
    on(autoExpandId, (activeProjectId) => {
      if (activeProjectId) setShowAll(true);
    }),
  );
  const row = (
    project: ProjectSummary,
    section: "pinned" | "recent" | "all" | "matches",
  ) => {
    const label = project.name || project.path;
    const isPinned = () => pins().isPinned(project.id);
    return (
      <div class="group flex items-center">
        <A
          href={withWorkspaceFilter(
            `/projects/${encodeURIComponent(project.id)}`,
            props.query,
          )}
          aria-label={label}
          data-section={section}
          data-list-key={`${section}:${project.id}`}
          data-testid="nav-project"
          aria-current={
            project.id === props.activeProjectId ? "page" : undefined
          }
          class={cn(
            "flex min-w-0 flex-1 items-center justify-between gap-2 rounded-md px-3 py-1.5 text-sm text-text hover:bg-soft",
            project.id === props.activeProjectId &&
              "bg-selected font-semibold text-selected-text",
          )}
        >
          <span class="min-w-0 truncate">{label}</span>
          <span class="shrink-0 text-xs text-muted">
            {project.knowledge_count}
          </span>
        </A>
        <button
          type="button"
          data-testid="nav-pin"
          aria-pressed={isPinned()}
          aria-label={`${isPinned() ? "Unpin" : "Pin"} ${label}`}
          class={cn(
            "mr-2 flex-none rounded-sm text-muted focus-visible:opacity-100 group-hover:opacity-100",
            isPinned() ? "opacity-100" : "[@media(hover:hover)]:opacity-0",
          )}
          onClick={() => pins().toggle(project.id)}
        >
          {isPinned() ? "★" : "☆"}
        </button>
      </div>
    );
  };

  return (
    <div
      class="min-h-0 flex-1 overflow-y-auto px-2 py-2"
      data-testid="project-list-body"
      data-list-scroller
      style={{ "overflow-anchor": "none" }}
    >
      <Show when={props.loading && !props.projects}>
        <div class="px-3 py-2 text-xs text-muted" role="status">
          Loading projects…
        </div>
      </Show>
      <Show when={props.error && !props.projects}>
        <StateCard
          kind={props.connectionUnauthorized ? "locked" : "error"}
          compact
          title={
            props.connectionUnauthorized
              ? "Projects hidden"
              : "Projects unavailable"
          }
          action={
            <button
              type="button"
              class="text-xs text-accent underline"
              onClick={() => props.onRetry?.()}
            >
              Retry
            </button>
          }
        >
          {props.connectionDetail}
        </StateCard>
      </Show>
      <Show when={props.projects && props.projects.length === 0}>
        <div class="px-3 py-2 text-xs text-muted">No projects yet</div>
      </Show>
      <Show when={sections().approximate}>
        <div
          data-testid="nav-project-filter-approximate"
          class="px-3 pb-1 text-[11px] text-muted"
        >
          Approximate matches
        </div>
      </Show>
      <Show
        when={sections().matches}
        fallback={
          <>
            <Show when={sections().pinned.length > 0}>
              <h3 class="px-3 pb-1 pt-2 text-[11px] font-medium text-muted">
                Pinned
              </h3>
              <For each={sections().pinned}>
                {(project) => row(project, "pinned")}
              </For>
            </Show>
            <Show when={sections().recent.length > 0}>
              <h3 class="px-3 pb-1 pt-3 text-[11px] font-medium text-muted">
                Recent
              </h3>
              <For each={sections().recent}>
                {(project) => row(project, "recent")}
              </For>
            </Show>
            <Show when={sections().rest.length > 0}>
              <button
                type="button"
                aria-expanded={showAll()}
                data-testid="nav-all-projects"
                class="mx-1 my-1 rounded-md px-2 py-1 text-left text-xs text-muted hover:bg-soft"
                onClick={() => setShowAll((value) => !value)}
              >
                All projects ({sections().rest.length})
              </button>
              <Show when={showAll()}>
                <For each={sections().rest}>
                  {(project) => row(project, "all")}
                </For>
              </Show>
            </Show>
          </>
        }
      >
        {(matches) => (
          <>
            <h3 class="px-3 pb-1 pt-2 text-[11px] font-medium text-muted">
              Matches
            </h3>
            <Show
              when={matches().length > 0}
              fallback={
                <div class="px-3 py-2 text-xs text-muted">
                  No projects match
                </div>
              }
            >
              <For each={matches()}>{(project) => row(project, "matches")}</For>
            </Show>
          </>
        )}
      </Show>
    </div>
  );
};
