import type { Component, JSX } from "solid-js";
import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js";
import { A, useLocation } from "@solidjs/router";

import { cn } from "~/lib/utils";
import { pins } from "~/state/pins";
import type { ProjectSummary } from "~/contracts";
import {
  CONNECTION_LABEL,
  useConnection,
  type ConnectionState,
} from "~/lib/connection";

import { StaleBadge } from "../lore/StaleBadge";
import { StateCard } from "../lore/StateCard";
import { sectionProjects } from "./nav-projects";
import type { KeyStatus } from "~/state/status";

const NavItem: Component<{
  href: string;
  active?: boolean;
  count?: number | string;
  children: JSX.Element;
  testId?: string;
  section?: string;
}> = (props) => (
  <A
    href={props.href}
    data-testid={props.testId}
    data-section={props.section}
    aria-current={props.active ? "page" : undefined}
    class={cn(
      "my-0.5 flex items-center justify-between gap-2 rounded-md px-3 py-2.25 text-sm text-text hover:bg-soft",
      props.active && "bg-accent-soft font-semibold text-accent-soft-text",
    )}
  >
    <span class="truncate">{props.children}</span>
    <Show when={props.count !== undefined}>
      <span class="flex-none text-muted">{props.count}</span>
    </Show>
  </A>
);

const ProjectRow: Component<{
  project: ProjectSummary;
  activeProjectId: string | null;
  section: "pinned" | "recent" | "all" | "matches";
}> = (props) => {
  const pinned = () => pins().isPinned(props.project.id);
  const label = () => props.project.name || props.project.path;
  return (
    <div class="group flex items-center">
      <div class="min-w-0 flex-1">
        <NavItem
          href={`/projects/${encodeURIComponent(props.project.id)}`}
          active={props.project.id === props.activeProjectId}
          count={props.project.knowledge_count}
          testId="nav-project"
          section={props.section}
        >
          {label()}
        </NavItem>
      </div>
      <button
        type="button"
        data-testid="nav-pin"
        aria-pressed={pinned()}
        aria-label={`${pinned() ? "Unpin" : "Pin"} ${label()}`}
        class={cn(
          "mr-2 flex-none rounded-sm text-muted focus-visible:opacity-100 group-hover:opacity-100",
          pinned() ? "opacity-100" : "[@media(hover:hover)]:opacity-0",
        )}
        onClick={() => pins().toggle(props.project.id)}
      >
        {pinned() ? "★" : "☆"}
      </button>
    </div>
  );
};

const NavHeading: Component<{ children: JSX.Element }> = (props) => (
  <h4 class="mx-2.5 mt-5.5 mb-2 text-[11px] uppercase tracking-[0.1em] text-muted">
    {props.children}
  </h4>
);

const STATUS_TONE: Record<ConnectionState, string> = {
  checking: "text-muted",
  reachable: "text-accent",
  unreachable: "text-danger",
  unauthorized: "text-gold",
};

export const ConnectionStatus: Component<{ class?: string }> = (props) => {
  const conn = useConnection();
  return (
    <div
      class={cn("text-xs", props.class)}
      data-testid="connection-status"
      data-connection={conn.state()}
      role="status"
    >
      <b class={STATUS_TONE[conn.state()]}>{CONNECTION_LABEL[conn.state()]}</b>
      <br />
      <Switch fallback={<span>Local gateway</span>}>
        <Match when={conn.state() === "unreachable"}>
          <span>{conn.detail() ?? "Start it with `lore start`."}</span>
        </Match>
        <Match when={conn.state() === "unauthorized"}>
          <span>
            Only loopback peers may manage this gateway unless
            LORE_ALLOW_REMOTE_MANAGEMENT is set.
          </span>
        </Match>
      </Switch>
      <br />
      <br />
      Private workspace
      <br />
      Nothing shared by this view
    </div>
  );
};

export interface NavProps {
  projects: readonly ProjectSummary[] | undefined;
  loading: boolean;
  error: unknown;
  activeProjectId: string | null;
  totalKnowledge: number | null;
  onRetry?: () => void;
  /** Stale-cache indicator shown next to the Projects header. */
  stale?: KeyStatus;
  /** Optional workspace actions rendered above the connection status. */
  footer?: JSX.Element;
  class?: string;
}

export const Nav: Component<NavProps> = (props) => {
  const conn = useConnection();
  const location = useLocation();
  const [filter, setFilter] = createSignal("");
  const [showAll, setShowAll] = createSignal(false);
  const sections = createMemo(() =>
    sectionProjects(
      props.projects ?? [],
      pins().pinned(),
      filter(),
      props.activeProjectId,
    ),
  );
  return (
    <nav
      aria-label="Workspace"
      class={cn(
        "flex min-h-full flex-col border-r border-line bg-nav px-3.5 py-6",
        props.class,
      )}
    >
      <div class="eyebrow px-3">Workspace</div>
      <NavItem
        href="/"
        active={props.activeProjectId === null}
        count={props.projects?.length}
        testId="nav-projects"
      >
        Projects
      </NavItem>
      <Show when={props.stale}>
        {(status) => (
          <Show when={status().stale}>
            <div class="px-3 pb-1">
              <StaleBadge status={status()} />
            </div>
          </Show>
        )}
      </Show>
      <NavItem href="/" count={props.totalKnowledge ?? undefined}>
        Knowledge
      </NavItem>

      <Show when={!props.projects?.length}>
        <NavHeading>Projects</NavHeading>
      </Show>
      <Switch>
        <Match when={props.loading && !props.projects}>
          <div class="px-3 py-2 text-xs text-muted" role="status">
            Loading projects…
          </div>
        </Match>
        <Match when={props.error && !props.projects}>
          <StateCard
            kind={conn.state() === "unauthorized" ? "locked" : "error"}
            compact
            title={
              conn.state() === "unauthorized"
                ? "Projects hidden"
                : "Projects unavailable"
            }
            action={
              <Show when={props.onRetry}>
                <button
                  type="button"
                  class="text-xs text-accent underline"
                  onClick={() => props.onRetry?.()}
                >
                  Retry
                </button>
              </Show>
            }
          >
            {conn.detail()}
          </StateCard>
        </Match>
        <Match when={props.projects?.length === 0}>
          <div class="px-3 py-2 text-xs text-muted">No projects yet</div>
        </Match>
        <Match when={props.projects}>
          {(_projects) => (
            <>
              <Show when={!sections().matches && sections().pinned.length > 0}>
                <NavHeading>Pinned</NavHeading>
                <For each={sections().pinned}>
                  {(project) => (
                    <ProjectRow
                      project={project}
                      activeProjectId={props.activeProjectId}
                      section="pinned"
                    />
                  )}
                </For>
              </Show>
              <Show when={sections().rest.length > 0 || filter() !== ""}>
                <input
                  type="search"
                  aria-label="Filter projects"
                  placeholder="Filter projects…"
                  data-testid="nav-project-filter"
                  class="mx-2.5 mt-2 rounded-md border border-line bg-surface px-2 py-1 text-sm text-text placeholder:text-muted"
                  value={filter()}
                  onInput={(e) => setFilter(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setFilter("");
                  }}
                />
              </Show>
              <Show
                when={sections().matches}
                fallback={
                  <>
                    <Show when={sections().recent.length > 0}>
                      <NavHeading>Recent</NavHeading>
                      <For each={sections().recent}>
                        {(project) => (
                          <ProjectRow
                            project={project}
                            activeProjectId={props.activeProjectId}
                            section="recent"
                          />
                        )}
                      </For>
                    </Show>
                    <Show when={sections().rest.length > 0}>
                      <button
                        type="button"
                        aria-expanded={showAll()}
                        data-testid="nav-all-projects"
                        class="mx-2.5 my-1 rounded-md px-1 py-1 text-left text-xs text-muted hover:bg-soft"
                        onClick={() => setShowAll((v) => !v)}
                      >
                        All projects ({sections().rest.length})
                      </button>
                      <Show when={showAll()}>
                        <For each={sections().rest}>
                          {(project) => (
                            <ProjectRow
                              project={project}
                              activeProjectId={props.activeProjectId}
                              section="all"
                            />
                          )}
                        </For>
                      </Show>
                    </Show>
                  </>
                }
              >
                {(matches) => (
                  <>
                    <NavHeading>Matches</NavHeading>
                    <Show
                      when={matches().length > 0}
                      fallback={
                        <div class="px-3 py-2 text-xs text-muted">
                          No projects match
                        </div>
                      }
                    >
                      <For each={matches()}>
                        {(project) => (
                          <ProjectRow
                            project={project}
                            activeProjectId={props.activeProjectId}
                            section="matches"
                          />
                        )}
                      </For>
                    </Show>
                  </>
                )}
              </Show>
            </>
          )}
        </Match>
      </Switch>

      <NavHeading>Memory</NavHeading>
      <NavItem
        href="/entities"
        active={location.pathname.startsWith("/entities")}
        testId="nav-entities"
      >
        Entities
      </NavItem>
      <NavItem
        href="/contradictions"
        active={location.pathname.startsWith("/contradictions")}
        testId="nav-contradictions"
      >
        Contradictions
      </NavItem>
      <div class="my-0.5 flex items-center justify-between gap-2 px-3 py-2.25 text-sm text-muted">
        <span>Sessions</span>
        <span class="text-[10px] uppercase tracking-wider">UI-05</span>
      </div>
      <div class="my-0.5 flex items-center justify-between gap-2 px-3 py-2.25 text-sm text-muted">
        <span>Find duplicates</span>
        <span class="text-[10px] uppercase tracking-wider">UI-08</span>
      </div>

      <NavHeading>Operations</NavHeading>
      <NavItem
        href="/warming"
        active={location.pathname.startsWith("/warming")}
        testId="nav-warming"
      >
        Cache warming
      </NavItem>
      <NavItem
        href="/costs"
        active={location.pathname.startsWith("/costs")}
        testId="nav-costs"
      >
        Cost intelligence
      </NavItem>

      <Show when={props.footer}>{(footer) => footer()}</Show>

      <ConnectionStatus class="mt-auto border-t border-line px-3 pt-4" />
    </nav>
  );
};
