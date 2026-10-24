import type { Component } from "solid-js";
import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js";
import { NavigationLink } from "./NavigationLink";
import type { ProjectSummary } from "~/contracts";
import type { KeyStatus } from "~/state/status";
import { pins } from "~/state/pins";
import { cn } from "~/lib/utils";
import { projectHref } from "~/lib/href";
import { Button } from "~/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/components/ui/popover";
import { StateCard } from "~/components/lore/StateCard";
import { StaleBadge } from "~/components/lore/StaleBadge";
import { sectionProjects } from "./nav-projects";
import { Icon } from "./Icon";

export interface ProjectPickerProps {
  projects: readonly ProjectSummary[] | undefined;
  loading: boolean;
  error: unknown;
  activeProjectId: string | null;
  onRetry?: () => void;
  stale?: KeyStatus;
  compact?: boolean;
  hrefForProject?: (id: string) => string;
  emptyLabel?: string;
}

export const ProjectPicker: Component<ProjectPickerProps> = (props) => {
  const [open, setOpen] = createSignal(false);
  let content: HTMLDivElement | undefined;
  const [filter, setFilter] = createSignal("");
  const [showAll, setShowAll] = createSignal(false);
  const selected = () =>
    props.projects?.find((p) => p.id === props.activeProjectId);
  const label = () =>
    selected()?.name ||
    selected()?.path ||
    (props.activeProjectId
      ? "Current project"
      : (props.emptyLabel ?? "All projects"));
  const sections = createMemo(() =>
    sectionProjects(
      props.projects ?? [],
      pins().pinned(),
      filter(),
      props.activeProjectId,
    ),
  );
  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setFilter("");
      setShowAll(false);
    }
  };
  const moveFocus = (event: KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const target = event.currentTarget as HTMLElement;
    const rows = [
      ...target.querySelectorAll<HTMLAnchorElement>(
        "[data-testid=nav-project]",
      ),
    ];
    if (!rows.length) return;
    event.preventDefault();
    // A row's pin is a keyboard target too: continue from that project.
    const current = rows.findIndex((row) =>
      row.parentElement?.contains(document.activeElement),
    );
    const next =
      current < 0
        ? event.key === "ArrowDown"
          ? 0
          : rows.length - 1
        : (current + (event.key === "ArrowDown" ? 1 : -1) + rows.length) %
          rows.length;
    rows[next]?.focus();
  };
  const togglePin = (event: MouseEvent, id: string) => {
    const button = event.currentTarget as HTMLButtonElement;
    const focused = document.activeElement === button;
    const panel = content;
    pins().toggle(id);
    if (!focused) return;
    // Unpinning an older project can move it out of Recent. Keep the focused
    // project visible so the same control remains reachable after regrouping.
    if (sections().rest.some((project) => project.id === id)) setShowAll(true);
    queueMicrotask(() => {
      if (!open() || content !== panel || !panel?.isConnected) return;
      const active = document.activeElement;
      // Do not override focus the user moved elsewhere before this ran.
      if (active !== document.body && active !== button && active?.isConnected)
        return;
      Array.from(
        panel.querySelectorAll<HTMLButtonElement>("[data-project-pin]"),
      )
        .find((next) => next.dataset.projectPin === id)
        ?.focus();
    });
  };
  const row = (project: ProjectSummary, section: string) => {
    const name = () => project.name || project.path;
    const pinned = () => pins().isPinned(project.id);
    return (
      <div class="group flex items-center gap-1 rounded-md hover:bg-soft">
        <NavigationLink
          href={props.hrefForProject?.(project.id) ?? projectHref(project.id)}
          data-testid="nav-project"
          data-section={section}
          current={project.id === props.activeProjectId}
          title={project.path}
          onClick={() => changeOpen(false)}
          class={cn(
            "flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-2 text-text outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
            project.id === props.activeProjectId && "bg-soft text-accent",
          )}
        >
          <Icon name="folder" class="text-muted" />
          <span class="min-w-0 flex-1">
            <span
              data-project-label
              class="block truncate text-[13px] font-medium"
            >
              {name()}
            </span>
            <span class="block truncate text-[11px] text-muted">
              {project.path}
            </span>
          </span>
          <span data-project-count class="text-xs tabular-nums text-muted">
            {project.knowledge_count}
          </span>
          <Show when={project.id === props.activeProjectId}>
            <Icon name="check" class="size-3.5" />
          </Show>
        </NavigationLink>
        <Button
          variant="ghost"
          size="icon"
          class={cn(
            "mr-1 size-8 text-muted focus-visible:opacity-100 group-hover:opacity-100",
            pinned() ? "opacity-100" : "[@media(hover:hover)]:opacity-0",
          )}
          data-testid="nav-pin"
          data-project-pin={project.id}
          aria-pressed={pinned()}
          aria-label={`${pinned() ? "Unpin" : "Pin"} ${name()}`}
          onClick={(event) => togglePin(event, project.id)}
        >
          <Icon
            name="star"
            class={pinned() ? "fill-current text-accent" : ""}
          />
        </Button>
      </div>
    );
  };
  const ProjectGroup: Component<{
    name: string;
    projects: ProjectSummary[];
    section: string;
  }> = (group) => (
    <Show when={group.projects.length}>
      <h4 class="px-2 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-muted">
        {group.name}
      </h4>
      <For each={group.projects}>{(p) => row(p, group.section)}</For>
    </Show>
  );
  return (
    <Popover
      modal
      open={open()}
      onOpenChange={changeOpen}
      placement="bottom-start"
      gutter={6}
    >
      <PopoverTrigger
        as={Button}
        variant="outline"
        class={cn(
          "justify-start gap-2 bg-surface px-2.5 text-left shadow-none",
          props.compact ? "h-8 w-9 shrink-0 sm:w-40" : "h-11 w-full",
        )}
        aria-label={`Switch project: ${label()}`}
        title={`Switch project: ${label()}`}
        data-testid="project-picker-trigger"
      >
        <Icon name="folder" class="text-accent" />
        <span
          class={cn(
            "min-w-0 flex-1 truncate text-[13px]",
            props.compact && "max-sm:sr-only",
          )}
        >
          {label()}
        </span>
        <Show when={selected()}>
          {(project) => (
            <span
              data-testid="active-project-count"
              class={cn(
                "text-[11px] tabular-nums text-muted",
                props.compact && "hidden",
              )}
            >
              {project().knowledge_count}
            </span>
          )}
        </Show>
        <Icon
          name="chevrons"
          class={cn("size-3 text-muted", props.compact && "hidden")}
        />
      </PopoverTrigger>
      <PopoverContent
        ref={(element: HTMLDivElement) => {
          content = element;
        }}
        data-project-picker-content
        aria-label="Switch project"
        onEscapeKeyDown={(event) => {
          if (filter()) {
            event.preventDefault();
            setFilter("");
          }
        }}
        onKeyDown={moveFocus}
        class="w-[360px]"
      >
        <div class="flex items-center gap-2 border-b border-line px-3 py-2.5">
          <Icon name="search" class="text-muted" />
          <input
            type="search"
            aria-label="Filter projects"
            placeholder="Find a project…"
            data-testid="nav-project-filter"
            class="h-7 min-w-0 flex-1 bg-transparent text-sm outline-none"
            value={filter()}
            onInput={(e) => setFilter(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && filter()) {
                e.preventDefault();
                e.stopPropagation();
                setFilter("");
              }
            }}
          />
          <Show when={props.stale?.stale}>
            <StaleBadge status={props.stale!} />
          </Show>
        </div>
        <div class="max-h-[min(60dvh,420px)] overflow-y-auto p-1.5">
          <Switch>
            <Match when={props.loading && !props.projects}>
              <StateCard kind="loading" title="Loading projects" compact />
            </Match>
            <Match when={props.error && !props.projects}>
              <StateCard
                kind="error"
                title="Projects unavailable"
                compact
                action={
                  <Button variant="outline" size="sm" onClick={props.onRetry}>
                    Retry
                  </Button>
                }
              />
            </Match>
            <Match when={props.projects?.length === 0}>
              <StateCard kind="empty" title="No projects yet" compact />
            </Match>
            <Match when={props.projects}>
              <Show
                when={sections().matches}
                fallback={
                  <>
                    <ProjectGroup
                      name="Pinned"
                      projects={sections().pinned}
                      section="pinned"
                    />
                    <ProjectGroup
                      name="Recent"
                      projects={sections().recent}
                      section="recent"
                    />
                    <Show when={sections().rest.length}>
                      <Button
                        variant="ghost"
                        size="sm"
                        class="mt-1 w-full justify-between px-2 text-xs text-muted"
                        data-testid="nav-all-projects"
                        aria-expanded={showAll()}
                        onClick={() => setShowAll((v) => !v)}
                      >
                        All projects ({sections().rest.length})
                        <Icon
                          name="chevron"
                          class={cn("size-3", showAll() && "rotate-90")}
                        />
                      </Button>
                      <Show when={showAll()}>
                        <For each={sections().rest}>{(p) => row(p, "all")}</For>
                      </Show>
                    </Show>
                  </>
                }
              >
                {(matches) => (
                  <>
                    <Show when={sections().approximate}>
                      <div
                        class="px-2 py-2 text-xs text-muted"
                        data-testid="nav-project-filter-approximate"
                      >
                        Approximate matches
                      </div>
                    </Show>
                    <Show
                      when={matches().length}
                      fallback={
                        <p class="px-3 py-5 text-sm text-muted">
                          No projects match
                        </p>
                      }
                    >
                      <For each={matches()}>{(p) => row(p, "matches")}</For>
                    </Show>
                  </>
                )}
              </Show>
            </Match>
          </Switch>
        </div>
        <NavigationLink
          href="/"
          onClick={() => changeOpen(false)}
          class="flex items-center justify-between border-t border-line px-3 py-2.5 text-xs text-muted hover:bg-soft"
        >
          Browse all projects
          <Icon name="chevron" class="size-3" />
        </NavigationLink>
      </PopoverContent>
    </Popover>
  );
};
