import type { Component, JSX } from "solid-js";
import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js";
import { A, useMatch, useResolvedPath } from "@solidjs/router";
import * as DialogPrimitive from "@kobalte/core/dialog";

import { cn } from "~/lib/utils";
import {
  CONNECTION_LABEL,
  useConnection,
  type ConnectionState,
} from "~/lib/connection";
import { allKnowledgeHref, duplicatesHref } from "~/lib/href";
import type { KeyStatus } from "~/state/status";
import { StaleBadge } from "../lore/StaleBadge";
import type { ProjectSummary } from "~/contracts";
import { withWorkspaceQuery } from "~/lib/href";
import {
  parseActivityQuery,
  DEFAULT_ACTIVITY_QUERY,
} from "@loreai/core/activity-query";
import { pins } from "~/state/pins";
import { savedSearches, type SavedSearch } from "~/state/saved-searches";

const NavItem: Component<{
  href: string;
  active?: boolean;
  children: JSX.Element;
  testId?: string;
  end?: boolean;
}> = (props) => (
  <A
    href={props.href}
    end={props.end}
    data-testid={props.testId}
    aria-current={props.active ? "page" : undefined}
    class={cn(
      "my-0.5 flex items-center justify-between gap-2 rounded-md px-3 py-1.5 text-sm text-text hover:bg-soft",
      props.active && "bg-selected font-semibold text-selected-text",
    )}
  >
    <span class="truncate">{props.children}</span>
  </A>
);

const NavHeading: Component<{ children: JSX.Element }> = (props) => (
  <h4 class="mx-2.5 mt-4 mb-1 text-[10px] uppercase tracking-[0.1em] text-muted">
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
  activeProjectId: string | null;
  stale?: KeyStatus;
  projects?: readonly ProjectSummary[];
  query?: string;
  footer?: JSX.Element;
  class?: string;
}

export const Nav: Component<NavProps> = (props) => {
  const currentQuery = () => props.query ?? DEFAULT_ACTIVITY_QUERY;
  const saved = savedSearches();
  const [dialogOpen, setDialogOpen] = createSignal(false);
  const [editing, setEditing] = createSignal<SavedSearch | null>(null);
  const [title, setTitle] = createSignal("");
  const [queryDraft, setQueryDraft] = createSignal("");
  const parsedDraft = createMemo(() => parseActivityQuery(queryDraft()));
  const validationError = () =>
    parsedDraft().errors[0]?.message ??
    (!queryDraft().trim() ? "Query is required" : null) ??
    (!title().trim() ? "Title is required" : null);

  const openSearchDialog = (search?: SavedSearch) => {
    setEditing(search ?? null);
    setTitle(search?.title ?? "");
    setQueryDraft(search?.query ?? currentQuery());
    setDialogOpen(true);
  };
  const saveSearch = () => {
    const nextTitle = title().trim();
    const nextQuery = queryDraft().trim();
    if (!nextTitle || !nextQuery || parsedDraft().errors.length > 0) return;
    const existing = editing();
    if (existing) {
      saved.update(existing.id, { title: nextTitle, query: nextQuery });
    } else {
      saved.save({ title: nextTitle, query: nextQuery });
    }
    setDialogOpen(false);
  };

  const builtins = [
    { title: "Inbox", query: "in:inbox" },
    { title: "Sessions", query: "type:session" },
    { title: "Knowledge", query: "type:knowledge" },
    { title: "Needs attention", query: "type:contradiction,promotion" },
    { title: "Unread", query: "is:unread" },
  ] as const;
  const pinnedProjects = createMemo(() => {
    const byId = new Map(
      (props.projects ?? []).map((project) => [project.id, project]),
    );
    return pins()
      .pinned()
      .flatMap((id) => {
        const project = byId.get(id);
        return project ? [project] : [];
      });
  });
  const activeProject = createMemo(() =>
    props.projects?.find((project) => project.id === props.activeProjectId),
  );
  const homePath = useResolvedPath(() => "/");
  const atHome = useMatch(() => homePath() ?? "");
  const allKnowledgePath = useResolvedPath(() => "/knowledge");
  const entitiesPath = useResolvedPath(() => "/entities/*");
  const contradictionsPath = useResolvedPath(() => "/contradictions/*");
  const promotionsPath = useResolvedPath(() => "/promotions/*");
  const warmingPath = useResolvedPath(() => "/warming/*");
  const costsPath = useResolvedPath(() => "/costs/*");
  const modelUsagePath = useResolvedPath(() => "/model-usage/*");
  const duplicatesPath = useResolvedPath(() =>
    props.activeProjectId
      ? duplicatesHref(props.activeProjectId)
      : "/__no-active-project__",
  );
  const atAllKnowledge = useMatch(() => allKnowledgePath() ?? "");
  const atDuplicates = useMatch(() => duplicatesPath() ?? "");
  const atEntities = useMatch(() => entitiesPath() ?? "");
  const atContradictions = useMatch(() => contradictionsPath() ?? "");
  const atPromotions = useMatch(() => promotionsPath() ?? "");
  const atWarming = useMatch(() => warmingPath() ?? "");
  const atCosts = useMatch(() => costsPath() ?? "");
  const atModelUsage = useMatch(() => modelUsagePath() ?? "");
  return (
    <nav
      aria-label="Workspace"
      class={cn("flex min-h-full flex-col bg-nav px-2 py-2", props.class)}
    >
      <div class="px-3 py-1 text-[11px] font-medium text-muted">Workspace</div>
      <NavItem
        href={allKnowledgeHref()}
        active={!!atAllKnowledge()}
        testId="nav-all-knowledge"
        end
      >
        All knowledge
      </NavItem>
      <Show when={props.stale?.stale}>
        <div class="px-3 pb-1">
          <StaleBadge status={props.stale!} />
        </div>
      </Show>
      <Show when={activeProject()}>
        {(project) => (
          <button
            type="button"
            aria-label={`${pins().isPinned(project().id) ? "Unpin" : "Pin"} ${project().name || project().path}`}
            aria-pressed={pins().isPinned(project().id)}
            data-testid="toggle-active-project-pin"
            class="mx-2.5 my-1 text-left text-xs text-muted hover:text-text"
            onClick={() => pins().toggle(project().id)}
          >
            {pins().isPinned(project().id) ? "Unpin project" : "Pin project"}
          </button>
        )}
      </Show>
      <NavHeading>Searches</NavHeading>
      <For each={builtins}>
        {(search) => (
          <NavItem
            href={withWorkspaceQuery("/", search.query)}
            active={
              currentQuery() === search.query &&
              (!!atHome() || props.activeProjectId !== null)
            }
            testId={
              search.query === DEFAULT_ACTIVITY_QUERY
                ? "nav-projects"
                : `activity-search-${search.query.split(":")[0]}`
            }
          >
            {search.title}
          </NavItem>
        )}
      </For>
      <Show when={pinnedProjects().length > 0}>
        <h5 class="mx-2.5 mt-2 mb-1 text-[10px] uppercase tracking-[0.1em] text-muted">
          Pinned projects
        </h5>
        <For each={pinnedProjects()}>
          {(project) => {
            const search = `project:${project.id}`;
            return (
              <NavItem
                href={withWorkspaceQuery("/", search)}
                active={
                  currentQuery() === search &&
                  (!!atHome() || props.activeProjectId !== null)
                }
                testId="pinned-project-search"
              >
                {project.name || project.path}
              </NavItem>
            );
          }}
        </For>
      </Show>
      <div class="mt-2 flex items-center justify-between px-3 text-[10px] uppercase tracking-[0.1em] text-muted">
        <span>Saved searches</span>
        <button
          type="button"
          aria-label="Save search"
          title="Save search"
          data-testid="save-search-open"
          class="rounded px-1 text-xs hover:bg-soft"
          onClick={() => openSearchDialog()}
        >
          +
        </button>
      </div>
      <For each={saved.list()}>
        {(search) => (
          <div class="group flex items-center gap-1">
            <NavItem
              href={withWorkspaceQuery("/", search.query)}
              active={
                currentQuery() === search.query &&
                (!!atHome() || props.activeProjectId !== null)
              }
              testId="saved-search"
            >
              {search.title}
            </NavItem>
            <button
              type="button"
              aria-label={`Edit ${search.title}`}
              data-testid="saved-search-edit"
              class="rounded px-1 text-[10px] text-muted hover:bg-soft"
              onClick={() => openSearchDialog(search)}
            >
              Edit
            </button>
            <button
              type="button"
              aria-label={`Delete ${search.title}`}
              data-testid="saved-search-delete"
              class="rounded px-1 text-[10px] text-muted hover:bg-soft"
              onClick={() => {
                if (
                  globalThis.confirm(`Delete saved search "${search.title}"?`)
                ) {
                  saved.remove(search.id);
                }
              }}
            >
              ×
            </button>
          </div>
        )}
      </For>
      <NavHeading>Memory</NavHeading>
      <NavItem href="/entities" active={!!atEntities()} testId="nav-entities">
        Entities
      </NavItem>
      <NavItem
        href="/contradictions"
        active={!!atContradictions()}
        testId="nav-contradictions"
      >
        Contradictions
      </NavItem>
      <NavItem
        href="/promotions"
        active={!!atPromotions()}
        testId="nav-promotions"
        end
      >
        Promotions
      </NavItem>
      <Show
        when={props.activeProjectId}
        fallback={
          <div class="px-3 py-1 text-xs text-muted">
            Find duplicates · <span>choose a project</span>
          </div>
        }
      >
        {(projectId) => (
          <NavItem
            href={duplicatesHref(projectId())}
            active={!!atDuplicates()}
            testId="nav-duplicates"
          >
            Find duplicates
          </NavItem>
        )}
      </Show>
      <NavHeading>Operations</NavHeading>
      <NavItem href="/warming" active={!!atWarming()} testId="nav-warming">
        Cache warming
      </NavItem>
      <NavItem href="/costs" active={!!atCosts()} testId="nav-costs">
        Cost intelligence
      </NavItem>
      <NavItem
        href="/model-usage"
        active={!!atModelUsage()}
        testId="nav-model-usage"
      >
        Model usage
      </NavItem>
      <Show when={props.footer}>{(footer) => footer()}</Show>
      <ConnectionStatus class="mt-auto border-t border-hairline px-3 pt-3" />
      <DialogPrimitive.Root open={dialogOpen()} onOpenChange={setDialogOpen}>
        <DialogPrimitive.Portal>
          <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
            <DialogPrimitive.Overlay class="fixed inset-0 bg-background/80" />
            <DialogPrimitive.Content class="relative z-50 w-full max-w-lg border border-hairline bg-surface p-5 text-text">
              <DialogPrimitive.Title class="text-sm font-medium">
                {editing() ? "Edit search" : "Save search"}
              </DialogPrimitive.Title>
              <form
                class="mt-4 flex flex-col gap-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  saveSearch();
                }}
              >
                <label class="flex flex-col gap-1 text-xs">
                  Title
                  <input
                    aria-label="Search title"
                    data-testid="saved-search-title"
                    class="h-9 border border-hairline bg-transparent px-2 text-sm"
                    value={title()}
                    onInput={(event) => setTitle(event.currentTarget.value)}
                  />
                </label>
                <label class="flex flex-col gap-1 text-xs">
                  Query
                  <input
                    aria-label="Search query"
                    data-testid="saved-search-query"
                    class="h-9 border border-hairline bg-transparent px-2 text-sm"
                    value={queryDraft()}
                    onInput={(event) =>
                      setQueryDraft(event.currentTarget.value)
                    }
                  />
                </label>
                <Show when={validationError()}>
                  {(message) => (
                    <p role="alert" class="text-xs text-danger">
                      {message()}
                    </p>
                  )}
                </Show>
                <div class="flex justify-end gap-2">
                  <DialogPrimitive.CloseButton
                    type="button"
                    class="rounded px-3 py-1.5 text-xs text-muted hover:bg-soft"
                  >
                    Cancel
                  </DialogPrimitive.CloseButton>
                  <button
                    type="submit"
                    data-testid="saved-search-submit"
                    disabled={!!validationError()}
                    class="rounded bg-selected px-3 py-1.5 text-xs text-selected-text disabled:opacity-50"
                  >
                    Save
                  </button>
                </div>
              </form>
            </DialogPrimitive.Content>
          </div>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </nav>
  );
};
