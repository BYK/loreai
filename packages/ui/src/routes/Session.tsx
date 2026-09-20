/**
 * `/ui/projects/:projectId/sessions/:sessionId[?a=<anchor>]` — the session
 * reader route (UI-06b). Wires the paged session state to `SessionView`;
 * the `a` query parameter is the addressable state (a source anchor).
 */
import type { Component } from "solid-js";
import { createMemo, Match, Show, Switch } from "solid-js";
import { useParams, useSearchParams } from "@solidjs/router";

import { DocHeader } from "~/components/lore/Document";
import { StateCard } from "~/components/lore/StateCard";
import { SessionView } from "~/components/reader/SessionView";
import { Nav } from "~/components/shell/Nav";
import { Shell } from "~/components/shell/Shell";
import { isApiError } from "~/lib/api";

import { projectHref } from "./Browse";
import { useWorkspace } from "./workspace";

export const sessionHref = (projectId: string, sessionId: string) =>
  `${projectHref(projectId)}/sessions/${encodeURIComponent(sessionId)}`;

function decodeParam(segment: string | undefined): string | undefined {
  if (segment === undefined) return undefined;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function errorTitle(error: unknown): { title: string; body: string } {
  if (isApiError(error)) {
    switch (error.kind) {
      case "unauthorized":
        return {
          title: "Session hidden by the gateway",
          body: "The management API is only served to loopback peers unless LORE_ALLOW_REMOTE_MANAGEMENT is enabled.",
        };
      case "not_found":
        return {
          title: "Session not found",
          body: "The gateway has no session at this address for this project.",
        };
      case "invalid":
        return {
          title: "Session could not be read",
          body: "The gateway answered, but the response did not match the shape this UI understands.",
        };
      default:
        return { title: "Session unavailable", body: error.message };
    }
  }
  return {
    title: "Session unavailable",
    body: error instanceof Error ? error.message : String(error),
  };
}

export const Session: Component = () => {
  const raw = useParams<{ projectId: string; sessionId: string }>();
  const [search, setSearch] = useSearchParams<{ a?: string }>();
  const ws = useWorkspace();

  const projectId = () => decodeParam(raw.projectId) ?? null;
  const sessionId = () => decodeParam(raw.sessionId) ?? null;
  const project = createMemo(() => ws.projectById(projectId()));
  const projectLabel = () => {
    const p = project();
    return p ? p.name || p.path : "Project";
  };

  const reader = ws.state.sessions.reader(projectId, sessionId);
  const projectsSettled = () =>
    ws.projects.data() !== undefined || ws.projects.error() !== undefined;
  const projectMissing = () =>
    projectsSettled() && !!projectId() && project() === undefined;

  const anchorParam = () => {
    const a = search.a;
    return typeof a === "string" && a !== "" ? a : null;
  };

  const nav = () => (
    <Nav
      projects={ws.projects.data()}
      loading={ws.projects.loading()}
      error={ws.projects.error()}
      activeProjectId={projectId()}
      totalKnowledge={
        ws.projects.data()?.reduce((n, p) => n + p.knowledge_count, 0) ?? null
      }
      onRetry={ws.projects.reload}
      stale={ws.state.projects.status()}
    />
  );

  const header = () => (
    <DocHeader
      crumb={[projectLabel(), "Sessions"]}
      title={`Session ${sessionId() ?? ""}`}
      trailing={
        <Show when={reader.messageCount() !== null}>
          <span class="font-mono text-[11px]">{sessionId()}</span>
        </Show>
      }
    />
  );

  const detail = () => (
    <Switch>
      <Match when={projectMissing()}>
        <div class="p-5 sm:p-7.5">
          <StateCard kind="empty" title="Project not found">
            No project with this id is known to the gateway. Pick a project from
            the navigation.
          </StateCard>
        </div>
      </Match>
      <Match when={reader.loader.error() && !reader.loader.data()}>
        {(_) => {
          const error = reader.loader.error();
          const e = errorTitle(error);
          return (
            <div class="p-5 sm:p-7.5">
              <StateCard
                kind={
                  isApiError(error) && error.kind === "unauthorized"
                    ? "locked"
                    : "error"
                }
                title={e.title}
                action={
                  <button
                    type="button"
                    class="text-xs text-accent underline"
                    onClick={reader.loader.reload}
                  >
                    Retry
                  </button>
                }
              >
                {e.body}
              </StateCard>
            </div>
          );
        }}
      </Match>
      <Match when={!reader.loader.data()}>
        <div class="p-5 text-sm text-muted sm:p-7.5" role="status">
          Loading session…
        </div>
      </Match>
      <Match when={reader.loader.data()}>
        <SessionView
          sessionId={sessionId() ?? ""}
          messages={reader.messages()}
          distillations={reader.distillations()}
          messageCount={reader.messageCount()}
          hasOlder={reader.hasOlder()}
          loadingOlder={reader.loadingOlder()}
          olderError={reader.olderError()}
          onLoadOlder={reader.loadOlder}
          status={reader.status()}
          anchorParam={anchorParam()}
          onAnchorChange={(encoded) =>
            setSearch({ a: encoded ?? undefined }, { replace: true })
          }
          linkBase={() => window.location.href}
          loadDistillation={(id) =>
            ws.tracked(() => ws.client.getDistillation(id))
          }
          header={header()}
        />
      </Match>
    </Switch>
  );

  return (
    <Shell
      nav={nav}
      detail={detail()}
      mobilePane="detail"
      back={
        projectId()
          ? { href: projectHref(projectId()!), label: projectLabel() }
          : undefined
      }
      mobileTitle={`Session ${sessionId() ?? ""}`}
    />
  );
};
