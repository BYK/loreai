import type { Component, JSX } from "solid-js";
import { createMemo, For, Match, Show, Switch } from "solid-js";
import { A, useParams } from "@solidjs/router";

import { KnowledgeDocument } from "~/components/lore/KnowledgeDocument";
import { ListRow, PaneHead } from "~/components/lore/Panes";
import { StaleBadge } from "~/components/lore/StaleBadge";
import { StateCard } from "~/components/lore/StateCard";
import { Nav } from "~/components/shell/Nav";
import { Shell, type MobilePane } from "~/components/shell/Shell";
import { isApiError } from "~/lib/api";
import { formatWhen, pluralize, previewOf } from "~/lib/format";
import type { ProjectSummary } from "~/contracts";

import { useWorkspace } from "./workspace";

export const projectHref = (projectId: string) =>
  `/projects/${encodeURIComponent(projectId)}`;
export const knowledgeHref = (projectId: string, knowledgeId: string) =>
  `${projectHref(projectId)}/knowledge/${encodeURIComponent(knowledgeId)}`;

function decodeParam(segment: string | undefined): string | undefined {
  if (segment === undefined) return undefined;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function errorState(
  error: unknown,
  what: string,
  retry: () => void,
): JSX.Element {
  const retryButton = (
    <button type="button" class="text-xs text-accent underline" onClick={retry}>
      Retry
    </button>
  );
  if (isApiError(error)) {
    switch (error.kind) {
      case "unauthorized":
        return (
          <StateCard kind="locked" title={`${what} hidden by the gateway`}>
            The management API is only served to loopback peers unless
            LORE_ALLOW_REMOTE_MANAGEMENT is enabled. This view has no way to
            authenticate; use the machine running the gateway.
          </StateCard>
        );
      case "not_found":
        return (
          <StateCard kind="empty" title={`${what} not found`}>
            The gateway has nothing at this address; it may have been removed or
            merged. Pick another entry from the list.
          </StateCard>
        );
      case "invalid":
        return (
          <StateCard
            kind="error"
            title={`${what} could not be read`}
            action={retryButton}
          >
            The gateway answered, but the response did not match the shape this
            UI understands. The gateway and UI versions may differ.
          </StateCard>
        );
      default:
        return (
          <StateCard
            kind="error"
            title={`${what} unavailable`}
            action={retryButton}
          >
            {error.message}
          </StateCard>
        );
    }
  }
  return (
    <StateCard kind="error" title={`${what} unavailable`} action={retryButton}>
      {error instanceof Error ? error.message : String(error)}
    </StateCard>
  );
}

const WelcomeDetail: Component<{
  projects: readonly ProjectSummary[] | undefined;
}> = (props) => (
  <div class="mx-auto max-w-[940px] px-5 py-8 sm:px-7.5">
    <div class="eyebrow mb-2">Memory browser</div>
    <h1 class="mb-3 text-[25px] leading-[1.2] font-semibold tracking-[-0.65px]">
      Choose a project
    </h1>
    <p class="mb-6 max-w-prose text-sm text-muted">
      Lore keeps what your agents learned about each project. Pick a project on
      the left to browse its knowledge; each entry opens as a document with its
      sources.
    </p>
    <Switch>
      <Match when={props.projects?.length === 0}>
        <StateCard kind="empty" title="No projects yet">
          Memory fills as agents work through the gateway. Run{" "}
          <code class="rounded-sm bg-chrome px-1 font-mono text-[11px]">
            lore run
          </code>{" "}
          in a project to start.
        </StateCard>
      </Match>
      <Match when={props.projects}>
        {(projects) => (
          <ul class="m-0 grid list-none gap-2 p-0 sm:grid-cols-2">
            <For each={projects()}>
              {(project) => (
                <li>
                  <A
                    href={projectHref(project.id)}
                    class="block rounded-lg border border-line bg-bg px-4 py-3 text-sm text-text hover:border-thread hover:bg-soft"
                  >
                    <div class="truncate font-semibold">
                      {project.name || project.path}
                    </div>
                    <div class="mt-1 text-xs text-muted">
                      {pluralize(project.knowledge_count, "entry", "entries")} ·{" "}
                      {pluralize(project.session_count, "session")}
                    </div>
                  </A>
                </li>
              )}
            </For>
          </ul>
        )}
      </Match>
    </Switch>
  </div>
);

/**
 * The browsing routes share one component so the shell (nav, list, detail)
 * keeps its state while the URL moves between project, list and entry:
 *   /                                    projects (nav) + welcome
 *   /projects/:projectId                 + knowledge list
 *   /projects/:projectId/knowledge/:id   + entry document
 *   /knowledge/:id                       entry document; project from the entry
 */
export const Browse: Component = () => {
  const raw = useParams<{ projectId?: string; knowledgeId?: string }>();
  // Router params are the raw (percent-encoded) path segments; `projectHref`
  // and `knowledgeHref` encode, so decode once here before any lookup or
  // API call.
  const params = {
    get projectId() {
      return decodeParam(raw.projectId);
    },
    get knowledgeId() {
      return decodeParam(raw.knowledgeId);
    },
  };
  const ws = useWorkspace();

  const entry = ws.state.knowledge.entry(() => params.knowledgeId ?? null);

  // `/knowledge/:id` deep links resolve their project from the entry itself.
  const projectId = createMemo(
    () => params.projectId ?? entry.loader.data()?.project_id ?? null,
  );

  const knowledge = ws.state.knowledge.list(projectId);
  const knowledgeLoader = knowledge.loader;
  const knowledgeStatus = knowledge.status;

  const project = createMemo(() => ws.projectById(projectId()));
  const projectLabel = () => {
    const p = project();
    return p ? p.name || p.path : "Project";
  };
  const totalKnowledge = createMemo(
    () =>
      ws.projects.data()?.reduce((n, p) => n + p.knowledge_count, 0) ?? null,
  );

  const mobilePane = (): MobilePane =>
    params.knowledgeId ? "detail" : projectId() ? "list" : "nav";

  const back = () => {
    const id = projectId();
    if (params.knowledgeId && id)
      return { href: projectHref(id), label: projectLabel() };
    if (id) return { href: "/", label: "Projects" };
    return undefined;
  };

  const nav = () => (
    <Nav
      projects={ws.projects.data()}
      loading={ws.projects.loading()}
      error={ws.projects.error()}
      activeProjectId={projectId()}
      totalKnowledge={totalKnowledge()}
      onRetry={ws.projects.reload}
      stale={ws.state.projects.status()}
    />
  );

  const list = () => {
    const id = projectId();
    if (!id) return undefined;
    return (
      <div data-testid="knowledge-list">
        <PaneHead
          title={`Knowledge · ${projectLabel()}`}
          trailing={
            <Show when={knowledgeLoader.data()}>
              {(entries) => pluralize(entries().length, "entry", "entries")}
            </Show>
          }
        />
        <Show when={knowledgeStatus().stale}>
          <div class="border-b border-line px-4.5 py-1.5">
            <StaleBadge status={knowledgeStatus()} />
          </div>
        </Show>
        <Switch>
          <Match when={knowledgeLoader.error() && !knowledgeLoader.data()}>
            <div class="p-3">
              {errorState(
                knowledgeLoader.error(),
                "Knowledge",
                knowledgeLoader.reload,
              )}
            </div>
          </Match>
          <Match when={knowledgeLoader.loading() && !knowledgeLoader.data()}>
            <div class="p-4 text-[13px] text-muted" role="status">
              Loading knowledge…
            </div>
          </Match>
          <Match when={knowledgeLoader.data()?.length === 0}>
            <div class="p-3">
              <StateCard kind="empty" title="No knowledge yet" compact>
                This project has sessions but no distilled knowledge entries
                with confidence above the listing threshold.
              </StateCard>
            </div>
          </Match>
          <Match when={knowledgeLoader.data()}>
            {(entries) => (
              <For each={entries()}>
                {(k) => (
                  <ListRow
                    href={knowledgeHref(id, k.id)}
                    title={k.title}
                    preview={previewOf(k.content)}
                    footLeft={k.category}
                    footRight={formatWhen(k.updated_at ?? k.created_at)}
                    selected={k.id === params.knowledgeId}
                    testId="knowledge-row"
                  />
                )}
              </For>
            )}
          </Match>
        </Switch>
      </div>
    );
  };

  const detail = () => (
    <Switch fallback={<WelcomeDetail projects={ws.projects.data()} />}>
      <Match when={params.knowledgeId}>
        <Switch>
          <Match when={entry.loader.error() && !entry.loader.data()}>
            <div class="p-5 sm:p-7.5">
              {errorState(
                entry.loader.error(),
                "Knowledge entry",
                entry.loader.reload,
              )}
            </div>
          </Match>
          <Match when={entry.loader.loading() && !entry.loader.data()}>
            <div class="p-5 text-sm text-muted sm:p-7.5" role="status">
              Loading entry…
            </div>
          </Match>
          <Match when={entry.loader.data()}>
            {(e) => (
              <>
                <Show when={entry.status().stale}>
                  <div class="px-5 pt-3 sm:px-7.5">
                    <StaleBadge status={entry.status()} />
                  </div>
                </Show>
                <KnowledgeDocument entry={e()} project={project()} />
              </>
            )}
          </Match>
        </Switch>
      </Match>
      <Match when={projectId()}>
        <div class="p-5 sm:p-7.5">
          <StateCard kind="empty" title="Select an entry">
            Knowledge entries for {projectLabel()} are listed on the left. Each
            opens as a document with its category, confidence and source.
          </StateCard>
        </div>
      </Match>
    </Switch>
  );

  return (
    <Shell
      nav={nav}
      list={list()}
      detail={detail()}
      mobilePane={mobilePane()}
      back={back()}
      mobileTitle={
        params.knowledgeId
          ? (entry.loader.data()?.title ?? "Knowledge")
          : projectId()
            ? projectLabel()
            : undefined
      }
    />
  );
};
