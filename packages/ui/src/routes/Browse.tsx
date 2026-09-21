import type { Component } from "solid-js";
import { createMemo, For, Match, Show, Switch } from "solid-js";
import { A, useNavigate, useParams, useSearchParams } from "@solidjs/router";

import type { KnowledgeQuery, ProjectSummary, RecallScope } from "~/contracts";
import {
  DEFAULT_KNOWLEDGE_QUERY,
  knowledgeQueryToSearch,
  parseKnowledgeQuery,
} from "~/contracts";
import { formatWhen, pluralize, previewOf } from "~/lib/format";
import { KnowledgeDocument } from "~/components/lore/KnowledgeDocument";
import { KnowledgeTable } from "~/components/lore/KnowledgeTable";
import { ProjectPage } from "~/components/lore/ProjectPage";
import { SearchResults } from "~/components/lore/SearchResults";
import { SessionList } from "~/components/lore/SessionList";
import { errorStateFor } from "~/components/lore/ErrorState";
import { ListRow, PaneHead } from "~/components/lore/Panes";
import { StateCard } from "~/components/lore/StateCard";
import { Nav } from "~/components/shell/Nav";
import { Shell, type MobilePane } from "~/components/shell/Shell";
import { useWorkspace } from "./workspace";

export const projectHref = (projectId: string) =>
  `/projects/${encodeURIComponent(projectId)}`;
export const knowledgeListHref = (
  projectId: string,
  query: KnowledgeQuery = DEFAULT_KNOWLEDGE_QUERY,
) => `${projectHref(projectId)}/knowledge${knowledgeQueryToSearch(query)}`;
export const knowledgeHref = (
  projectId: string,
  knowledgeId: string,
  query?: KnowledgeQuery,
) =>
  `${projectHref(projectId)}/knowledge/${encodeURIComponent(knowledgeId)}${query ? knowledgeQueryToSearch(query) : ""}`;
export const sessionsHref = (projectId: string, cursor?: string | null) =>
  `${projectHref(projectId)}/sessions${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`;
export const sessionHref = (projectId: string, sessionId: string) =>
  `${projectHref(projectId)}/sessions/${encodeURIComponent(sessionId)}`;
export const searchHref = (
  projectId: string,
  q: string,
  scope: RecallScope = "all",
) =>
  `${projectHref(projectId)}/search?q=${encodeURIComponent(q)}&scope=${encodeURIComponent(scope)}`;

function decodeParam(segment: string | undefined) {
  if (segment === undefined) return undefined;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

const WelcomeDetail: Component<{
  projects: readonly ProjectSummary[] | undefined;
}> = (props) => (
  <div class="mx-auto max-w-[940px] px-5 py-8 sm:px-7.5">
    <div class="eyebrow mb-2">Memory browser</div>
    <h1 class="mb-3 text-[25px] font-semibold">Choose a project</h1>
    <p class="mb-6 max-w-prose text-sm text-muted">
      Lore keeps what your agents learned about each project. Pick a project on
      the left to browse its knowledge.
    </p>
    <Show
      when={props.projects}
      fallback={<StateCard kind="loading" title="Loading projects" />}
    >
      {(projects) => (
        <Show
          when={projects().length > 0}
          fallback={
            <StateCard kind="empty" title="No projects yet">
              Run <code>lore run</code> in a project to start.
            </StateCard>
          }
        >
          <ul class="grid list-none gap-2 p-0 sm:grid-cols-2">
            <For each={projects()}>
              {(project) => (
                <li>
                  <A
                    href={projectHref(project.id)}
                    class="block rounded-lg border border-line px-4 py-3 text-sm hover:bg-soft"
                  >
                    <div class="font-semibold">
                      {project.name || project.path}
                    </div>
                    <div class="mt-1 text-xs text-muted">
                      {pluralize(project.knowledge_count, "entry")} ·{" "}
                      {pluralize(project.session_count, "session")}
                    </div>
                  </A>
                </li>
              )}
            </For>
          </ul>
        </Show>
      )}
    </Show>
  </div>
);

export const Browse: Component<{
  view:
    | "welcome"
    | "project"
    | "knowledge-table"
    | "entry"
    | "sessions"
    | "search";
}> = (props) => {
  const raw = useParams<{
    projectId?: string;
    knowledgeId?: string;
  }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const ws = useWorkspace();
  const projectId = () => decodeParam(raw.projectId);
  const knowledgeId = () => decodeParam(raw.knowledgeId);
  const project = createMemo(() => ws.projectById(projectId()));
  const query = createMemo(() =>
    parseKnowledgeQuery(searchParams as Record<string, string | undefined>),
  );
  const entry = ws.state.knowledge.entry(() => knowledgeId() ?? null);
  const activeProjectId = createMemo(
    () => projectId() ?? entry.loader.data()?.project_id ?? null,
  );
  const pageSource = createMemo(() =>
    (props.view === "knowledge-table" || props.view === "entry") &&
    activeProjectId()
      ? { projectId: activeProjectId()!, query: query() }
      : null,
  );
  const knowledgePage = ws.state.knowledge.page(pageSource);
  const cursor = () =>
    typeof searchParams.cursor === "string" ? searchParams.cursor : null;
  const searchQ = () =>
    typeof searchParams.q === "string" ? searchParams.q : undefined;
  const searchScope = () =>
    typeof searchParams.scope === "string" ? searchParams.scope : "all";
  const sessionsPage = ws.state.sessions.page(() =>
    props.view === "sessions" && activeProjectId()
      ? { projectId: activeProjectId()!, cursor: cursor() }
      : null,
  );
  const projectForEntry = createMemo(
    () => project() ?? ws.projectById(entry.loader.data()?.project_id),
  );
  const versions = ws.state.knowledge.versions(
    () => knowledgeId() ?? entry.loader.data()?.id ?? null,
  );
  const evidence = ws.state.sessions.evidence(() => {
    const sourceSession = entry.loader.data()?.source_session;
    const sourceProject = projectForEntry();
    return sourceSession && sourceProject
      ? { projectPath: sourceProject.path, sessionId: sourceSession }
      : null;
  });
  const label = () =>
    projectForEntry()?.name || projectForEntry()?.path || "Project";
  const mobilePane = (): MobilePane =>
    props.view === "welcome" ? "nav" : "detail";
  const projectFallback = () => {
    if (ws.projects.loading()) {
      return <StateCard kind="loading" title="Loading project" />;
    }
    if (ws.projects.error()) {
      return errorStateFor(ws.projects.error(), "Projects", ws.projects.reload);
    }
    return <StateCard kind="error" title="Project not found or inaccessible" />;
  };
  const nav = () => (
    <Nav
      projects={ws.projects.data()}
      loading={ws.projects.loading()}
      error={ws.projects.error()}
      activeProjectId={projectId() ?? null}
      totalKnowledge={
        ws.projects.data()?.reduce((n, p) => n + p.knowledge_count, 0) ?? null
      }
      onRetry={ws.projects.reload}
      stale={ws.state.projects.status()}
    />
  );
  const list = () => {
    const id = activeProjectId();
    if (!id) return undefined;
    const items = () => knowledgePage.loader.data()?.items;
    return (
      <div data-testid="knowledge-list">
        <PaneHead
          title={
            <>
              {`Knowledge · ${label()}`}
              <Show when={items()}>
                {(rows) =>
                  ` · ${rows().length} ${rows().length === 1 ? "entry" : "entries"}`
                }
              </Show>
            </>
          }
          trailing={
            <A
              class="text-xs text-accent underline"
              href={knowledgeListHref(id, query())}
            >
              Open as table
            </A>
          }
        />
        <Show when={knowledgePage.loader.stale()}>
          <div class="px-4 py-2 text-xs text-muted">
            Showing cached knowledge while refreshing.
          </div>
        </Show>
        <Switch>
          <Match when={knowledgePage.loader.error() && !items()}>
            {errorStateFor(
              knowledgePage.loader.error(),
              "Knowledge",
              knowledgePage.loader.reload,
              {
                firstPage: () =>
                  navigate(knowledgeListHref(id, DEFAULT_KNOWLEDGE_QUERY)),
              },
            )}
          </Match>
          <Match when={!items()}>
            <StateCard kind="loading" title="Loading knowledge" />
          </Match>
          <Match when={items()?.length === 0}>
            <StateCard kind="empty" title="No knowledge extracted yet" />
          </Match>
          <Match when={items()}>
            <For each={items()}>
              {(item) => (
                <ListRow
                  href={knowledgeHref(id, item.id, query())}
                  title={item.title}
                  preview={previewOf(item.content)}
                  footLeft={item.category}
                  footRight={formatWhen(item.updated_at ?? item.created_at)}
                  selected={item.id === knowledgeId()}
                  testId="knowledge-row"
                />
              )}
            </For>
          </Match>
        </Switch>
      </div>
    );
  };
  const detail = () => {
    const id = projectId();
    switch (props.view) {
      case "welcome":
        return <WelcomeDetail projects={ws.projects.data()} />;
      case "project":
        if (!id) return projectFallback();
        return (
          <Show when={project()} fallback={projectFallback()}>
            {(value) => <ProjectPage project={value()} />}
          </Show>
        );
      case "knowledge-table":
        if (!id) return projectFallback();
        return (
          <KnowledgeTable
            projectId={id}
            query={query()}
            selectedId={knowledgeId()}
            page={knowledgePage}
          />
        );
      case "entry":
        if (!knowledgeId()) {
          return <StateCard kind="error" title="Knowledge entry not found" />;
        }
        return (
          <Switch>
            <Match when={entry.loader.error() && !entry.loader.data()}>
              <div class="p-5">
                {errorStateFor(
                  entry.loader.error(),
                  "Knowledge entry",
                  entry.loader.reload,
                )}
              </div>
            </Match>
            <Match when={entry.loader.loading() && !entry.loader.data()}>
              <StateCard kind="loading" title="Loading entry" />
            </Match>
            <Match when={entry.loader.data()}>
              {(value) => (
                <KnowledgeDocument
                  entry={value()}
                  project={projectForEntry()}
                  versions={versions.loader}
                  evidence={evidence.loader}
                />
              )}
            </Match>
          </Switch>
        );
      case "sessions":
        if (!id) return projectFallback();
        return (
          <SessionList projectId={id} cursor={cursor()} page={sessionsPage} />
        );
      case "search":
        if (!id) return projectFallback();
        return (
          <Show when={project()} fallback={projectFallback()}>
            {(value) => (
              <SearchResults
                project={value()}
                q={searchQ() ?? ""}
                scope={searchScope() as RecallScope}
              />
            )}
          </Show>
        );
    }
  };
  const listView = createMemo(list);
  const detailView = createMemo(detail);
  const back = () => {
    const id = projectId();
    if (!id) return undefined;
    switch (props.view) {
      case "entry":
        return { href: knowledgeListHref(id, query()), label: label() };
      case "search":
      case "sessions":
      case "knowledge-table":
        return { href: projectHref(id), label: label() };
      case "project":
        return { href: "/", label: "Projects" };
      default:
        return undefined;
    }
  };
  return (
    <Shell
      nav={nav}
      list={props.view === "entry" ? listView() : undefined}
      detail={detailView()}
      mobilePane={mobilePane()}
      back={back()}
      searchProjectId={projectId()}
    />
  );
};
