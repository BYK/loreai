import type { Component, JSX } from "solid-js";
import { Match, Show, Switch } from "solid-js";
import { A, useMatch, useResolvedPath } from "@solidjs/router";

import { cn } from "~/lib/utils";
import {
  CONNECTION_LABEL,
  useConnection,
  type ConnectionState,
} from "~/lib/connection";
import {
  allKnowledgeHref,
  duplicatesHref,
  withWorkspaceFilter,
} from "~/lib/href";
import type { KeyStatus } from "~/state/status";
import { StaleBadge } from "../lore/StaleBadge";

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
  footer?: JSX.Element;
  class?: string;
  workspaceFilter?: string;
}

export const Nav: Component<NavProps> = (props) => {
  const withFilter = (href: string) =>
    withWorkspaceFilter(href, props.workspaceFilter ?? "");
  const homePath = useResolvedPath(() => "/");
  const allKnowledgePath = useResolvedPath(() => "/knowledge");
  const entitiesPath = useResolvedPath(() => "/entities/*");
  const contradictionsPath = useResolvedPath(() => "/contradictions/*");
  const promotionsPath = useResolvedPath(() => "/promotions/*");
  const teamPath = useResolvedPath(() => "/team/*");
  const conflictsPath = useResolvedPath(() => "/conflicts/*");
  const warmingPath = useResolvedPath(() => "/warming/*");
  const costsPath = useResolvedPath(() => "/costs/*");
  const modelUsagePath = useResolvedPath(() => "/model-usage/*");
  const duplicatesPath = useResolvedPath(() =>
    props.activeProjectId
      ? duplicatesHref(props.activeProjectId)
      : "/__no-active-project__",
  );
  const atHome = useMatch(() => homePath() ?? "");
  const atAllKnowledge = useMatch(() => allKnowledgePath() ?? "");
  const atDuplicates = useMatch(() => duplicatesPath() ?? "");
  const atEntities = useMatch(() => entitiesPath() ?? "");
  const atContradictions = useMatch(() => contradictionsPath() ?? "");
  const atPromotions = useMatch(() => promotionsPath() ?? "");
  const atTeam = useMatch(() => teamPath() ?? "");
  const atConflicts = useMatch(() => conflictsPath() ?? "");
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
        href={withFilter("/")}
        active={!!atHome()}
        testId="nav-projects"
        end
      >
        Projects
      </NavItem>
      <NavItem
        href={withFilter(allKnowledgeHref())}
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
      <NavHeading>Memory</NavHeading>
      <NavItem
        href={withFilter("/entities")}
        active={!!atEntities()}
        testId="nav-entities"
      >
        Entities
      </NavItem>
      <NavItem
        href={withFilter("/contradictions")}
        active={!!atContradictions()}
        testId="nav-contradictions"
      >
        Contradictions
      </NavItem>
      <NavItem
        href={withFilter("/promotions")}
        active={!!atPromotions()}
        testId="nav-promotions"
        end
      >
        Promotions
      </NavItem>
      <NavItem
        href={withFilter("/team")}
        active={!!atTeam()}
        testId="nav-team"
        end
      >
        Team
      </NavItem>
      <NavItem
        href={withFilter("/conflicts")}
        active={!!atConflicts()}
        testId="nav-conflicts"
        end
      >
        Conflicts
      </NavItem>
      <div class="my-0.5 flex items-center justify-between gap-2 px-3 py-1.5 text-sm text-muted">
        <span>Sessions</span>
        <span class="text-[10px] uppercase tracking-wider">UI-05</span>
      </div>
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
            href={withFilter(duplicatesHref(projectId()))}
            active={!!atDuplicates()}
            testId="nav-duplicates"
          >
            Find duplicates
          </NavItem>
        )}
      </Show>
      <NavHeading>Operations</NavHeading>
      <NavItem
        href={withFilter("/warming")}
        active={!!atWarming()}
        testId="nav-warming"
      >
        Cache warming
      </NavItem>
      <NavItem
        href={withFilter("/costs")}
        active={!!atCosts()}
        testId="nav-costs"
      >
        Cost intelligence
      </NavItem>
      <NavItem
        href={withFilter("/model-usage")}
        active={!!atModelUsage()}
        testId="nav-model-usage"
      >
        Model usage
      </NavItem>
      <Show when={props.footer}>{(footer) => footer()}</Show>
      <ConnectionStatus class="mt-auto border-t border-hairline px-3 pt-3" />
    </nav>
  );
};
