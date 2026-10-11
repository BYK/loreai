import type { Component } from "solid-js";
import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js";
import { A, useNavigate, useParams, useSearchParams } from "@solidjs/router";

import type {
  AllKnowledgeQuery,
  KnowledgeVersion,
  ProjectSummary,
  RecallScope,
} from "~/contracts";
import {
  DEFAULT_ALL_KNOWLEDGE_QUERY,
  parseAllKnowledgeQuery,
  parseKnowledgeQuery,
} from "~/contracts";
import {
  allKnowledgeHref,
  globalKnowledgeHref,
  workspaceSearchHref,
} from "~/lib/href";
import { isApiError } from "~/lib/api";
import { KnowledgeDocument } from "~/components/lore/KnowledgeDocument";
import { PromotionPanel } from "~/components/lore/PromotionPanel";
import { DeletedKnowledgeDocument } from "~/components/lore/DeletedKnowledgeDocument";
import { KnowledgeEditor } from "~/components/lore/KnowledgeEditor";
import { RestoreKnowledgeAction } from "~/components/lore/RestoreKnowledgeAction";
import { KnowledgeTable } from "~/components/lore/KnowledgeTable";
import { ProjectPage } from "~/components/lore/ProjectPage";
import { MergeProjectsAction } from "~/components/lore/ProjectActions";
import { SearchResults } from "~/components/lore/SearchResults";
import { WorkspaceSearch } from "~/components/lore/WorkspaceSearch";
import { SessionList } from "~/components/lore/SessionList";
import { ImportHistoryPage } from "~/components/lore/ImportHistoryPage";
import { DuplicateReview } from "~/components/lore/DuplicateReview";
import { errorStateFor } from "~/components/lore/ErrorState";
import { StateCard } from "~/components/lore/StateCard";
import { useWorkspace } from "./workspace";
import { createLoader } from "~/lib/loader";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";

function decodeParam(segment: string | undefined) {
  if (segment === undefined) return undefined;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export const Browse: Component<{
  view:
    | "welcome"
    | "project"
    | "knowledge-table"
    | "all-knowledge"
    | "entry"
    | "sessions"
    | "imports"
    | "duplicates"
    | "search"
    | "workspace-search";
}> = (props) => {
  const raw = useParams<{
    projectId?: string;
    knowledgeId?: string;
  }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const ws = useWorkspace();
  const [deletedSaveError, setDeletedSaveError] = createSignal<{
    entryId: string;
    message: string;
  }>();
  const projectId = () => decodeParam(raw.projectId);
  const knowledgeId = () => decodeParam(raw.knowledgeId);
  const project = createMemo(() => ws.projectById(projectId()));
  const query = createMemo(() =>
    parseKnowledgeQuery(searchParams as Record<string, string | undefined>),
  );
  const allQuery = createMemo(() =>
    parseAllKnowledgeQuery(searchParams as Record<string, string | undefined>),
  );
  const entry = ws.state.knowledge.entry(() => knowledgeId() ?? null);
  const deletedHistoryId = createMemo(() => {
    const error = entry.loader.error();
    return props.view === "entry" &&
      isApiError(error) &&
      error.kind === "not_found"
      ? knowledgeId()
      : null;
  });
  const deletedHistory = createLoader(deletedHistoryId, (id, signal) =>
    ws.tracked(() =>
      ws.client.listKnowledgeVersions(id, {
        includeDeleted: true,
        signal,
      }),
    ),
  );
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
  const allPageSource = createMemo(() =>
    props.view === "all-knowledge" ? allQuery() : null,
  );
  const allKnowledgePage = ws.state.knowledge.allPage(allPageSource);
  const cursor = () =>
    typeof searchParams.cursor === "string" ? searchParams.cursor : null;
  const searchQ = () =>
    typeof searchParams.q === "string" ? searchParams.q : undefined;
  const workspaceQ = () =>
    (typeof searchParams.q === "string" ? searchParams.q : "")
      .trim()
      .slice(0, 500);
  const workspaceSearchPage = ws.state.knowledgeSearch.search(() => {
    const q = workspaceQ();
    return props.view === "workspace-search" && q ? { q, project: null } : null;
  });
  const searchScope = () =>
    typeof searchParams.scope === "string" ? searchParams.scope : "all";
  const sessionsPage = ws.state.sessions.page(() =>
    props.view === "sessions" && activeProjectId()
      ? {
          projectId: activeProjectId()!,
          cursor: cursor(),
          q: searchQ() ?? null,
        }
      : null,
  );
  const projectForEntry = createMemo(
    () => project() ?? ws.projectById(entry.loader.data()?.project_id),
  );
  const versions = ws.state.knowledge.versions(
    () => knowledgeId() ?? entry.loader.data()?.id ?? null,
  );
  const refreshAfterKnowledgeWrite = () => {
    entry.loader.reload();
    versions.loader.reload();
    if (pageSource() !== null) {
      knowledgePage.loader.reload();
    }
    if (allPageSource() !== null) {
      allKnowledgePage.loader.reload();
    }
    ws.projects.reload();
  };
  const evidence = ws.state.sessions.evidence(() => {
    const sourceSession = entry.loader.data()?.source_session;
    const sourceProject = projectForEntry();
    return sourceSession && sourceProject
      ? { projectPath: sourceProject.path, sessionId: sourceSession }
      : null;
  });
  const projectFallback = () => {
    if (ws.projects.loading()) {
      return <StateCard kind="loading" title="Loading project" />;
    }
    if (ws.projects.error()) {
      return errorStateFor(ws.projects.error(), "Projects", ws.projects.reload);
    }
    return <StateCard kind="error" title="Project not found or inaccessible" />;
  };
  const projectFilter = () => {
    const current = allQuery().project;
    const options = ["", ...(ws.projects.data() ?? []).map((p) => p.id)];
    if (current && !options.includes(current)) options.push(current);
    const projectName = (id: string) => {
      const project = ws.projectById(id);
      return project?.name || project?.path || id;
    };
    return (
      <Select
        value={current}
        onChange={(project) =>
          navigate(
            allKnowledgeHref({
              ...allQuery(),
              project: project || null,
              cursor: null,
            }),
          )
        }
        options={options}
        placeholder="All projects"
        itemComponent={(item) => (
          <SelectItem item={item.item}>
            {item.item.rawValue
              ? projectName(item.item.rawValue)
              : "All projects"}
          </SelectItem>
        )}
      >
        <SelectTrigger aria-label="project" class="h-9 min-w-32 text-xs">
          <SelectValue<string>>
            {(state) => {
              const selected = state.selectedOption();
              return selected ? projectName(selected) : "All projects";
            }}
          </SelectValue>
        </SelectTrigger>
        <SelectContent />
      </Select>
    );
  };
  const detail = () => {
    const id = projectId();
    switch (props.view) {
      case "welcome":
        return (
          <div class="mx-auto max-w-[940px] px-5 py-8 sm:px-7.5">
            <h1 class="mb-3 text-[25px] font-semibold">Select an item</h1>
            <p class="mb-6 text-sm text-muted">Pick an item from the list.</p>
            <MergeProjectsAction />
          </div>
        );
      case "project":
        if (!id) return projectFallback();
        return (
          <Show when={project()} fallback={projectFallback()}>
            {(value) => <ProjectPage project={value()} />}
          </Show>
        );
      case "duplicates":
        if (!id) return projectFallback();
        return <DuplicateReview projectId={id} />;
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
      case "all-knowledge":
        return (
          <div>
            <h1 class="px-4 pt-6 text-[25px] font-semibold sm:px-6">
              All knowledge
            </h1>
            <KnowledgeTable<AllKnowledgeQuery>
              routes={{
                list: allKnowledgeHref,
                entry: (id) => globalKnowledgeHref(id),
                defaultQuery: DEFAULT_ALL_KNOWLEDGE_QUERY,
              }}
              query={allQuery()}
              page={allKnowledgePage}
              showProject
              extraFilters={projectFilter()}
              extraFiltersActive={allQuery().project !== null}
            />
          </div>
        );
      case "entry":
        if (!knowledgeId()) {
          return <StateCard kind="error" title="Knowledge entry not found" />;
        }
        return (
          <Switch>
            <Match when={deletedHistoryId()}>
              <DeletedKnowledgeDocument
                history={deletedHistory}
                projectId={projectId()}
                saveError={
                  deletedSaveError()?.entryId === knowledgeId()
                    ? deletedSaveError()?.message
                    : undefined
                }
                restoreAction={
                  <RestoreKnowledgeAction
                    id={knowledgeId()!}
                    history={deletedHistory}
                    onRestored={() => {
                      setDeletedSaveError(undefined);
                      refreshAfterKnowledgeWrite();
                    }}
                  />
                }
                renderRestore={(version: KnowledgeVersion) => (
                  <RestoreKnowledgeAction
                    id={knowledgeId()!}
                    history={deletedHistory}
                    versionId={version.version_id}
                    onRestored={() => {
                      setDeletedSaveError(undefined);
                      refreshAfterKnowledgeWrite();
                    }}
                  />
                )}
              />
            </Match>
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
                <>
                  <KnowledgeDocument
                    entry={value()}
                    project={projectForEntry()}
                    versions={versions.loader}
                    evidence={evidence.loader}
                    actions={
                      <KnowledgeEditor
                        entry={value()}
                        versions={versions.loader}
                        reloadEntry={entry.loader.reload}
                        onSaved={() => refreshAfterKnowledgeWrite()}
                        onSaveError={(message) => {
                          const entryId = knowledgeId();
                          setDeletedSaveError(
                            message && entryId
                              ? { entryId, message }
                              : undefined,
                          );
                        }}
                        onDeleted={() => refreshAfterKnowledgeWrite()}
                      />
                    }
                    renderRestore={(version: KnowledgeVersion) => (
                      <RestoreKnowledgeAction
                        id={value().logical_id ?? value().id}
                        history={versions.loader}
                        versionId={version.version_id}
                        onRestored={() => refreshAfterKnowledgeWrite()}
                      />
                    )}
                    loadDistillation={(id) =>
                      ws.tracked(() => ws.client.getDistillation(id))
                    }
                  />
                  <PromotionPanel knowledgeId={value().id} client={ws.client} />
                </>
              )}
            </Match>
          </Switch>
        );
      case "sessions":
        if (!id) return projectFallback();
        return (
          <SessionList
            projectId={id}
            cursor={cursor()}
            q={searchQ() ?? null}
            page={sessionsPage}
          />
        );
      case "imports":
        if (!id) return projectFallback();
        return <ImportHistoryPage projectId={id} cursor={cursor()} />;
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
      case "workspace-search":
        return (
          <WorkspaceSearch
            q={workspaceQ()}
            page={workspaceSearchPage}
            allHref={allKnowledgeHref}
            entryHref={globalKnowledgeHref}
            searchHref={workspaceSearchHref}
          />
        );
    }
  };
  const detailView = createMemo(detail);
  return <>{detailView()}</>;
};
