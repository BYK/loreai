import {
  PROJECT_MEMORY_SEARCH_LABEL,
  WORKSPACE_KNOWLEDGE_SEARCH_LABEL,
} from "~/lib/search-labels";
import type { Component, JSX } from "solid-js";
import { Show } from "solid-js";
import { useLocation } from "@solidjs/router";
import { Icon } from "./Icon";
import { Button } from "~/components/ui/button";
import { useWorkspace } from "~/routes/workspace";
import { projectDestination, secondaryPage, workspacePath } from "./navigation";
import { ProjectPicker } from "./ProjectPicker";
import { SearchEntry } from "./SearchEntry";

export const AppBar: Component<{
  /** Mobile-only: back link beside the context toggle. */
  leading?: JSX.Element;
  onOpenMenu?: () => void;
  menuOpen?: boolean;
  /** Mobile-only: opens the navigation pane. */
  onOpenNav?: () => void;
  searchProjectId?: string;
  navigationOpen?: boolean;
  contextLabel?: string;
  pageLabel?: string;
}> = (props) => {
  const ws = useWorkspace();
  const location = useLocation();
  const section = () => {
    if (props.pageLabel) return props.pageLabel;
    const path = workspacePath(location.pathname);
    const secondary = secondaryPage(path);
    if (secondary) return secondary.label;
    if (path.includes("/knowledge")) return "Knowledge";
    if (
      path.includes("/sessions") ||
      new URLSearchParams(location.search).get("section") === "sessions"
    )
      return "Sessions";
    if (path.includes("/imports")) return "Imports";
    if (path.includes("/duplicates")) return "Find duplicates";
    if (path.includes("/search"))
      return props.searchProjectId
        ? PROJECT_MEMORY_SEARCH_LABEL
        : WORKSPACE_KNOWLEDGE_SEARCH_LABEL;
    return props.searchProjectId ? "Overview" : "Projects";
  };
  return (
    <header class="flex h-12 min-w-0 shrink-0 items-center gap-3 border-b border-line bg-surface px-3 sm:px-4">
      <Show when={props.onOpenMenu}>
        <Button
          variant="ghost"
          size="icon"
          class="size-8 shrink-0 text-muted md:hidden"
          aria-label="Open navigation menu"
          aria-expanded={props.menuOpen ?? false}
          aria-controls="mobile-navigation-drawer"
          data-testid="mobile-menu-trigger"
          onClick={() => props.onOpenMenu?.()}
        >
          <Icon name="menu" />
        </Button>
      </Show>
      <Show when={props.onOpenNav}>
        <Button
          variant="ghost"
          size="icon"
          class="size-8 shrink-0 text-muted"
          aria-label={
            props.navigationOpen
              ? "Collapse context pane"
              : "Expand context pane"
          }
          title={`${props.navigationOpen ? "Hide" : "Show"} ${(props.contextLabel ?? "context").toLowerCase()} list`}
          data-testid="context-toggle"
          aria-expanded={props.navigationOpen ?? false}
          aria-controls="workspace-context"
          onClick={() => props.onOpenNav?.()}
        >
          <Icon name="panel" />
        </Button>
      </Show>
      <Show when={props.leading}>
        <span class="lg:hidden">{props.leading}</span>
      </Show>
      <ProjectPicker
        compact
        emptyLabel="Workspace"
        hrefForProject={(id) =>
          projectDestination(location.pathname, location.search, id)
        }
        projects={ws.projects.data()}
        loading={ws.projects.loading()}
        error={ws.projects.error()}
        activeProjectId={props.searchProjectId ?? null}
        onRetry={ws.projects.reload}
        stale={ws.state.projects.status()}
      />
      <span class="hidden shrink-0 text-xs font-medium text-heading xl:inline">
        {section()}
      </span>
      <SearchEntry searchProjectId={props.searchProjectId} />
    </header>
  );
};
