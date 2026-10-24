import type { Component } from "solid-js";
import { For, Show } from "solid-js";
import { useLocation } from "@solidjs/router";
import {
  allKnowledgeHref,
  knowledgeListHref,
  sessionsHref,
  importsHref,
  duplicatesHref,
  searchHref,
} from "~/lib/href";
import { cn } from "~/lib/utils";
import { NavigationLink } from "./NavigationLink";
import { ConnectionStatus } from "./ConnectionStatus";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "~/components/ui/tooltip";
import { Logo } from "./Logo";
import { Icon, type IconName } from "./Icon";
import { FolkStatus } from "./FolkStatus";
import { SECONDARY_LINKS, workspacePath } from "./navigation";

/** Stable destinations: clicking an icon always opens its page, never toggles another pane. */
export const Rail: Component<{ projectId?: string; expanded?: boolean }> = (
  props,
) => {
  const location = useLocation();
  const path = () => workspacePath(location.pathname);
  const primary = () => {
    if (path().includes("/knowledge")) return "Knowledge";
    if (
      path().includes("/sessions") ||
      (path() === "/" &&
        new URLSearchParams(location.search).get("section") === "sessions")
    )
      return "Sessions";
    if (path().includes("/search")) return "Search";
    if (path() === "/" || /^\/projects\/[^/]+$/.test(path())) return "Projects";
    return undefined;
  };
  const item = (
    href: string,
    label: string,
    icon: IconName,
    id: string,
    active: () => boolean,
    scope: string,
  ) =>
    props.expanded ? (
      <NavigationLink
        href={href}
        aria-label={label}
        data-testid={id}
        current={active()}
        class={cn(
          "flex min-h-10 w-full shrink-0 items-center gap-3 rounded-md px-3 text-sm text-muted outline-none hover:bg-soft hover:text-text focus-visible:ring-2 focus-visible:ring-ring",
          active() && "bg-accent-soft text-accent-soft-text",
        )}
      >
        <Icon name={icon} class="size-[18px]" />
        <span>{label}</span>
      </NavigationLink>
    ) : (
      <Tooltip>
        <TooltipTrigger
          as={NavigationLink}
          href={href}
          aria-label={label}
          data-testid={id}
          current={active()}
          class={cn(
            "rail-action",
            active() && "bg-accent-soft text-accent-soft-text",
          )}
        >
          <Icon name={icon} class="size-[18px]" />
        </TooltipTrigger>
        <TooltipContent>
          <span class="font-medium">{label}</span>
          <span class="ml-2 text-muted">{scope}</span>
        </TooltipContent>
      </Tooltip>
    );
  const groupLabel = (label: string) =>
    props.expanded ? (
      <div class="mt-4 px-3 pb-1 text-xs font-medium text-muted">{label}</div>
    ) : (
      <div
        class="my-1 h-px min-h-px w-5 bg-line"
        role="separator"
        aria-label={label}
      />
    );
  return (
    <nav
      aria-label="Primary navigation"
      data-testid={props.expanded ? "mobile-navigation" : "icon-rail"}
      class={cn(
        "flex h-full min-h-0 flex-col bg-nav py-2",
        props.expanded
          ? "items-stretch px-3"
          : "items-center border-r border-line",
      )}
    >
      <Show when={!props.expanded}>
        <Tooltip>
          <TooltipTrigger
            as={NavigationLink}
            href="/"
            aria-label="Lore.AI — home"
            class="rail-action mb-2 shrink-0"
          >
            <Logo size={28} wordmark={false} />
          </TooltipTrigger>
          <TooltipContent>Lore.AI — home</TooltipContent>
        </Tooltip>
      </Show>
      <div
        data-testid="rail-links"
        class={cn(
          "flex min-h-0 w-full flex-1 flex-col gap-1 overflow-y-auto py-1",
          !props.expanded && "items-center",
        )}
      >
        {item(
          "/",
          "Projects",
          "folder",
          "rail-projects",
          () => primary() === "Projects",
          "Workspace",
        )}
        {item(
          props.projectId
            ? knowledgeListHref(props.projectId)
            : allKnowledgeHref(),
          "Knowledge",
          "book",
          "rail-knowledge",
          () => primary() === "Knowledge",
          props.projectId ? "Current project" : "Workspace",
        )}
        {item(
          props.projectId
            ? sessionsHref(props.projectId)
            : "/?section=sessions",
          "Sessions",
          "messages",
          "rail-sessions",
          () => primary() === "Sessions",
          props.projectId ? "Current project" : "Choose a project",
        )}
        {item(
          props.projectId ? searchHref(props.projectId, "") : "/search",
          "Search",
          "search",
          "rail-search",
          () => primary() === "Search",
          props.projectId ? "Current project" : "Workspace",
        )}
        <Show when={props.projectId}>
          {(id) => (
            <>
              {groupLabel("Project tools")}
              {item(
                importsHref(id()),
                "Imports",
                "upload",
                "rail-imports",
                () => path() === importsHref(id()),
                "Current project",
              )}
              {item(
                duplicatesHref(id()),
                "Find duplicates",
                "layers",
                "rail-duplicates",
                () => path() === duplicatesHref(id()),
                "Current project",
              )}
            </>
          )}
        </Show>
        <For each={["Knowledge tools", "Collaboration", "Operations"]}>
          {(group) => (
            <>
              {groupLabel(group)}
              <For
                each={SECONDARY_LINKS.filter((link) => link.group === group)}
              >
                {(link) =>
                  item(
                    link.href,
                    link.label,
                    link.icon,
                    `rail-${link.id.slice(4)}`,
                    () =>
                      path() === link.href ||
                      path().startsWith(`${link.href}/`),
                    "Workspace",
                  )
                }
              </For>
            </>
          )}
        </For>
      </div>
      <div
        class={cn(
          "flex shrink-0 items-center gap-2 border-t border-line pt-2",
          props.expanded ? "flex-col items-stretch" : "flex-col gap-1",
        )}
      >
        <Tooltip>
          <TooltipTrigger
            as="div"
            tabIndex={0}
            aria-label="Gateway connection"
            class={cn(
              "flex items-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring",
              props.expanded
                ? "min-h-7 justify-start gap-2 px-2"
                : "size-8 justify-center",
            )}
          >
            <ConnectionStatus compact />
            <Show when={props.expanded}>
              <span class="text-[11px] text-muted">Gateway connection</span>
            </Show>
          </TooltipTrigger>
          <TooltipContent>
            <ConnectionStatus />
          </TooltipContent>
        </Tooltip>
        <div
          class={props.expanded ? "order-first w-full" : "flex items-center"}
        >
          <FolkStatus inDrawer={props.expanded} />
        </div>
      </div>
    </nav>
  );
};
