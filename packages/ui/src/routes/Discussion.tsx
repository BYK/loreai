/**
 * Discussion routes (APP-02): the focused view of one discussion (source
 * quote, author, replies, "Back to source") and the project's chronological
 * discussion list. On narrow screens the reader opens discussions here so the
 * focused discussion is its own view.
 */
import type { Component } from "solid-js";
import {
  createEffect,
  createSignal,
  For,
  Match,
  on,
  Show,
  Switch,
} from "solid-js";
import { A, useParams } from "@solidjs/router";

import {
  DiscussionThread,
  ParticipantStack,
} from "~/components/discussions/DiscussionThread";
import { DocHeader } from "~/components/lore/Document";
import { StateCard } from "~/components/lore/StateCard";
import { errorStateFor } from "~/components/lore/ErrorState";
import { Nav } from "~/components/shell/Nav";
import { Shell } from "~/components/shell/Shell";
import { Button } from "~/components/ui/button";
import type { Discussion } from "~/contracts";
import { formatFullDate, formatWhen, pluralize } from "~/lib/format";
import {
  discussionHref,
  discussionSourceHref,
  discussionsHref,
  projectHref,
} from "~/lib/href";
import { encodeAnchor } from "~/reader/anchors";
import {
  discussionTone,
  participantAvatar,
  toSourceAnchor,
} from "~/reader/discussion-marks";
import { useWorkspace } from "./workspace";

function decodeParam(segment: string | undefined): string | undefined {
  if (segment === undefined) return undefined;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function backToSourceHref(d: Discussion): string {
  const first = d.anchors[0];
  return discussionSourceHref(
    d.project_id,
    d.source,
    first ? encodeAnchor(toSourceAnchor(first)) : null,
  );
}

const SOURCE_LABEL: Record<Discussion["source"]["kind"], string> = {
  session: "Session",
  knowledge: "Knowledge entry",
};

function useProjectShell() {
  const ws = useWorkspace();
  const raw = useParams<{ projectId?: string; discussionId?: string }>();
  const projectId = () => decodeParam(raw.projectId) ?? null;
  const discussionId = () => decodeParam(raw.discussionId) ?? null;
  const projectLabel = () => {
    const p = ws.projectById(projectId());
    return p ? p.name || p.path : "Project";
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
  return { ws, projectId, discussionId, projectLabel, nav };
}

export const DiscussionRoute: Component = () => {
  const { ws, projectId, discussionId, projectLabel, nav } = useProjectShell();
  const state = ws.state.discussions;
  const [error, setError] = createSignal<unknown>(undefined);
  const [loading, setLoading] = createSignal(false);
  const discussion = () => {
    const id = discussionId();
    const d = id ? state.byId(id) : undefined;
    return d && d.project_id === projectId() ? d : undefined;
  };

  // The route instance is reused across discussions; only the latest load
  // may report its outcome.
  let generation = 0;
  const load = () => {
    const pid = projectId();
    const id = discussionId();
    const gen = ++generation;
    if (!pid || !id) return;
    setLoading(true);
    setError(undefined);
    state
      .loadDiscussion(pid, id)
      .catch((err: unknown) => {
        if (gen === generation) setError(err);
      })
      .finally(() => {
        if (gen === generation) setLoading(false);
      });
  };
  createEffect(on([projectId, discussionId], load));

  const detail = () => (
    <Switch>
      <Match when={discussion()}>
        {(d) => {
          const author = () => participantAvatar(d().created_by);
          return (
            <article data-testid="discussion-focus">
              <DocHeader
                crumb={[projectLabel(), "Discussions"]}
                title={d().kind === "note" ? "Note" : "Discussion"}
                participants={[
                  {
                    name: author().name,
                    initials: author().label,
                    kind: author().kind,
                  },
                ]}
                trailing={
                  <time
                    dateTime={new Date(d().created_at).toISOString()}
                    title={formatFullDate(d().created_at)}
                  >
                    Started {formatWhen(d().created_at)}
                  </time>
                }
              />
              <div class="mx-auto max-w-[760px] px-5 py-5 sm:px-7.5">
                <figure class="m-0">
                  <blockquote
                    data-testid="discussion-quote"
                    class={`discussion-panel tone-${discussionTone(d().id)} m-0 whitespace-pre-wrap rounded-lg px-4 py-3 text-[15px] leading-relaxed [overflow-wrap:anywhere]`}
                  >
                    {d().quote}
                  </blockquote>
                  <figcaption class="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted">
                    <span data-testid="discussion-author">
                      {author().name} · {SOURCE_LABEL[d().source.kind]}
                    </span>
                    <A
                      href={backToSourceHref(d())}
                      class="text-accent hover:underline"
                      data-testid="back-to-source"
                    >
                      ← Back to source
                    </A>
                    <A
                      href={discussionsHref(d().project_id)}
                      class="hover:underline"
                    >
                      All discussions
                    </A>
                  </figcaption>
                </figure>
                <div class="mt-4">
                  <DiscussionThread
                    projectId={d().project_id}
                    discussion={d()}
                    focused
                  />
                </div>
              </div>
            </article>
          );
        }}
      </Match>
      <Match when={error()}>
        <div class="p-5">{errorStateFor(error(), "Discussion", load)}</div>
      </Match>
      <Match when={loading() || !discussion()}>
        <StateCard kind="loading" title="Loading discussion" />
      </Match>
    </Switch>
  );

  return (
    <Shell
      nav={nav}
      detail={detail()}
      mobilePane="detail"
      searchProjectId={projectId() ?? undefined}
      back={
        projectId()
          ? { href: discussionsHref(projectId()!), label: "Discussions" }
          : undefined
      }
    />
  );
};

export const DiscussionsRoute: Component = () => {
  const { ws, projectId, projectLabel, nav } = useProjectShell();
  const state = ws.state.discussions;
  createEffect(
    on(projectId, (pid) => {
      if (pid) void state.loadProject(pid);
    }),
  );
  const list = () => (projectId() ? state.forProject(projectId()!) : []);
  const status = () =>
    projectId() ? state.projectState(projectId()!) : undefined;

  const detail = () => (
    <div data-testid="discussions-list">
      <DocHeader
        crumb={[projectLabel(), "Discussions"]}
        title="Discussions"
        trailing="Most recent activity first"
      />
      <div class="mx-auto max-w-[760px] px-5 py-4 sm:px-7.5">
        <Switch>
          <Match when={status()?.error && list().length === 0}>
            {errorStateFor(status()?.error, "Discussions", () => {
              const pid = projectId();
              if (pid) void state.loadProject(pid);
            })}
          </Match>
          <Match when={!status()?.loaded}>
            <StateCard kind="loading" title="Loading discussions" />
          </Match>
          <Match when={list().length === 0}>
            <StateCard kind="empty" title="No discussions yet">
              Select text in a session or knowledge entry to start one.
            </StateCard>
          </Match>
          <Match when={true}>
            <ol class="m-0 list-none p-0">
              <For each={list()}>
                {(d) => (
                  <li class="border-b border-line py-3 last:border-0">
                    <A
                      href={discussionHref(d.project_id, d.id)}
                      class="block rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      data-testid="discussion-row"
                    >
                      <span
                        class={`discussion-panel tone-${discussionTone(d.id)} line-clamp-2 rounded px-2 py-1 text-sm`}
                      >
                        {d.quote}
                      </span>
                      <span class="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted">
                        <ParticipantStack participants={d.participants} />
                        <span>{SOURCE_LABEL[d.source.kind]}</span>
                        <span>
                          {pluralize(d.reply_count, "reply", "replies")}
                        </span>
                        <Show when={d.kind === "note"}>
                          <span>note</span>
                        </Show>
                        <Show when={d.state === "resolved"}>
                          <span>resolved</span>
                        </Show>
                        <time
                          class="ml-auto"
                          dateTime={new Date(d.last_activity_at).toISOString()}
                          title={formatFullDate(d.last_activity_at)}
                        >
                          {formatWhen(d.last_activity_at)}
                        </time>
                      </span>
                    </A>
                  </li>
                )}
              </For>
            </ol>
            <Show when={status()?.next}>
              <Button
                size="sm"
                variant="outline"
                class="mt-3"
                disabled={status()?.loading}
                onClick={() => {
                  const pid = projectId();
                  if (pid) void state.loadProject(pid, true);
                }}
              >
                Load more
              </Button>
            </Show>
          </Match>
        </Switch>
      </div>
    </div>
  );

  return (
    <Shell
      nav={nav}
      detail={detail()}
      mobilePane="detail"
      searchProjectId={projectId() ?? undefined}
      back={
        projectId()
          ? { href: projectHref(projectId()!), label: projectLabel() }
          : undefined
      }
    />
  );
};
