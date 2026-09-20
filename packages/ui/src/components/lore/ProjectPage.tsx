import type { Component } from "solid-js";
import { For, Match, Show, Switch } from "solid-js";
import { A, useNavigate } from "@solidjs/router";

import type { ProjectSummary } from "~/contracts";
import { formatWhen, pluralize } from "~/lib/format";
import { isApiError } from "~/lib/api";
import { useWorkspace } from "~/routes/workspace";
import {
  projectHref,
  knowledgeListHref,
  sessionsHref,
  sessionHref,
  searchHref,
} from "~/routes/Browse";
import { DocHeader } from "./Document";
import { ListRow } from "./Panes";
import { StateCard } from "./StateCard";
import { createLoader } from "~/lib/loader";

export const ProjectPage: Component<{ project: ProjectSummary }> = (props) => {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const sessions = ws.state.sessions.page(() => ({
    projectId: props.project.id,
    cursor: null,
  }));
  const sharingState = createLoader(
    () => props.project.id,
    (projectId) => ws.tracked(() => ws.client.getProjectSharing(projectId)),
  );
  const aliases = () =>
    props.project.git_remote
      ? (ws.projects.data() ?? []).filter(
          (p) =>
            p.id !== props.project.id &&
            p.git_remote === props.project.git_remote,
        )
      : [];
  const healthHint = () => {
    if (props.project.session_count === 0)
      return "No captured sessions yet — run an agent through `lore` to capture history";
    if (props.project.distillation_count === 0) return "Nothing distilled yet";
    if (props.project.knowledge_count === 0)
      return "No knowledge extracted yet";
    return undefined;
  };
  const recent = () => sessions.loader.data()?.items.slice(0, 5) ?? [];
  return (
    <div class="mx-auto max-w-[940px] px-5 py-7 sm:px-7.5">
      <DocHeader
        crumb={["Projects", props.project.name || props.project.path]}
        title={props.project.name || props.project.path}
      />
      <section class="border-b border-line py-5">
        <div class="eyebrow mb-2">Identity</div>
        <div class="font-mono text-xs">{props.project.path}</div>
        <Show
          when={props.project.git_remote}
          fallback={
            <span class="mt-2 inline-block text-xs text-muted">
              local path only (no remote recorded)
            </span>
          }
        >
          <div class="mt-2 text-xs text-muted">{props.project.git_remote}</div>
          <Show
            when={aliases().length > 0}
            fallback={
              <span class="mt-2 inline-block text-xs text-muted">
                canonical
              </span>
            }
          >
            <div class="mt-4 text-xs font-semibold">
              Checkouts of the same repository
            </div>
            <ul class="mt-1 list-none space-y-1 p-0">
              <li class="text-xs text-muted">This checkout</li>
              <For each={aliases()}>
                {(alias) => (
                  <li>
                    <A
                      class="text-xs text-accent underline"
                      data-testid="project-alias"
                      href={projectHref(alias.id)}
                    >
                      {alias.name || alias.path}
                    </A>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Show>
      </section>
      <section data-testid="health" class="border-b border-line py-5">
        <div class="eyebrow mb-2">Memory health</div>
        <div class="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          <span>{props.project.knowledge_count} knowledge</span>
          <span>{props.project.session_count} sessions</span>
          <span>{props.project.message_count} messages</span>
          <span>{props.project.distillation_count} distillations</span>
        </div>
        <div class="mt-2 text-xs text-muted">
          Hints from recorded counts:{" "}
          <Show when={healthHint()} fallback="No recorded health warnings.">
            {healthHint()}
          </Show>
        </div>
      </section>
      <section class="border-b border-line py-5">
        <div class="eyebrow mb-2">Sharing</div>
        <Show
          when={sharingState.data()}
          fallback={
            <StateCard
              kind="empty"
              title="Sharing status not available"
              compact
            />
          }
        >
          {(status) => (
            <div class="text-sm">
              {status().state} · {status().team?.name ?? "No team"} ·{" "}
              {status().policy.effective} policy
            </div>
          )}
        </Show>
      </section>
      <section class="border-b border-line py-5">
        <div class="mb-3 flex items-center justify-between">
          <div class="eyebrow">Recent sessions</div>
          <A
            class="text-xs text-accent underline"
            href={sessionsHref(props.project.id)}
          >
            All sessions →
          </A>
        </div>
        <Switch>
          <Match when={sessions.loader.loading() && !sessions.loader.data()}>
            <StateCard kind="loading" title="Loading sessions" compact />
          </Match>
          <Match when={recent().length === 0}>
            <StateCard kind="empty" title="No captured sessions" compact />
          </Match>
          <Match when={recent().length > 0}>
            <For each={recent()}>
              {(session) => (
                <ListRow
                  href={sessionHref(props.project.id, session.session_id)}
                  title={session.session_id}
                  preview={`${session.message_count} messages · ${session.distilled_count} distilled`}
                  footRight={formatWhen(session.last_message_at)}
                />
              )}
            </For>
          </Match>
        </Switch>
      </section>
      <section class="py-5">
        <p class="mb-3 text-sm text-muted">Select an entry to inspect it.</p>
        <div class="mb-3 flex items-center justify-between">
          <div class="eyebrow">Knowledge</div>
          <A
            class="text-xs text-accent underline"
            href={knowledgeListHref(props.project.id)}
          >
            Browse knowledge ({props.project.knowledge_count}) →
          </A>
        </div>
        <form
          role="search"
          class="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            const rawQ = data.get("q");
            const rawScope = data.get("scope");
            const q = typeof rawQ === "string" ? rawQ : "";
            const scope = (typeof rawScope === "string" ? rawScope : "all") as
              | "all"
              | "session"
              | "project"
              | "knowledge";
            navigate(searchHref(props.project.id, q, scope));
          }}
        >
          <input
            name="q"
            aria-label="Search project memory"
            class="min-w-0 flex-1 rounded-md border border-line bg-bg px-3 py-2 text-sm"
            placeholder="Search this project"
          />
          <select
            name="scope"
            aria-label="Search scope"
            class="rounded-md border border-line bg-bg px-2 text-sm"
          >
            <option value="all">all</option>
            <option value="session">session</option>
            <option value="project">project</option>
            <option value="knowledge">knowledge</option>
          </select>
          <button
            class="rounded-md bg-inverse px-3 py-2 text-xs text-inverse-text"
            type="submit"
          >
            Search
          </button>
        </form>
      </section>
    </div>
  );
};
