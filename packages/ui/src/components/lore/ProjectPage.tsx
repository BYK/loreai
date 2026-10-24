import { Icon } from "~/components/shell/Icon";
import type { Component } from "solid-js";
import { For, Match, Show, Switch, createSignal } from "solid-js";
import { A, useNavigate } from "@solidjs/router";

import type { ProjectSummary, RecallScope } from "~/contracts";
import { formatWhen, pluralize } from "~/lib/format";
import { useWorkspace } from "~/routes/workspace";
import {
  projectHref,
  knowledgeListHref,
  importsHref,
  sessionsHref,
  sessionHref,
  searchHref,
  duplicatesHref,
} from "~/lib/href";
import { DocHeader } from "./Document";
import { ProjectActions } from "./ProjectActions";
import { ListRow } from "./Panes";
import { SharingPanel } from "./SharingPanel";
import { StateCard } from "./StateCard";
import { Button } from "../ui/button";
import { ResponsiveSelect } from "~/components/ui/responsive-select";
import { TextField, TextFieldInput } from "../ui/text-field";

export const ProjectPage: Component<{ project: ProjectSummary }> = (props) => {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const [scope, setScope] = createSignal<RecallScope>("all");
  const sessions = ws.state.sessions.page(() => ({
    projectId: props.project.id,
    cursor: null,
  }));
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
    <div class="mx-auto max-w-[1040px] px-5 py-7 sm:px-8">
      <DocHeader
        compact
        class="px-0 pt-0 sm:px-0"
        crumb={["Projects", "Overview"]}
        title={props.project.name || props.project.path}
      >
        <div class="mt-4 flex flex-wrap gap-2">
          <Button as={A} href={knowledgeListHref(props.project.id)} size="sm">
            <Icon name="book" /> Browse knowledge (
            {props.project.knowledge_count})
          </Button>
          <Button
            as={A}
            href={sessionsHref(props.project.id)}
            variant="outline"
            size="sm"
          >
            Session history
          </Button>
        </div>
      </DocHeader>
      <section data-testid="health" class="border-b border-line py-5">
        <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div class="eyebrow">Memory health</div>
          <A
            class="text-xs text-accent underline"
            data-testid="review-duplicates-link"
            href={duplicatesHref(props.project.id)}
          >
            Review duplicates
          </A>
        </div>
        <div class="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4 [&>span]:rounded-lg [&>span]:border [&>span]:border-line [&>span]:bg-bg [&>span]:min-w-0 [&>span]:p-3 sm:[&>span]:p-4 [&>span]:font-medium [&>span]:tabular-nums">
          <span>{props.project.knowledge_count} knowledge</span>
          <span>{props.project.session_count} sessions</span>
          <span>{pluralize(props.project.message_count, "message")}</span>
          <span>{props.project.distillation_count} distillations</span>
        </div>
        <div class="mt-2 text-xs text-muted">
          Hints from recorded counts:{" "}
          <Show when={healthHint()} fallback="No recorded health warnings.">
            {healthHint()}
          </Show>
        </div>
      </section>
      <section class="py-5">
        <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div class="eyebrow">Knowledge</div>
        </div>
        <form
          role="search"
          class="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            const rawQ = data.get("q");
            const q = typeof rawQ === "string" ? rawQ : "";
            navigate(searchHref(props.project.id, q, scope()));
          }}
        >
          <TextField class="w-full min-w-0 sm:w-auto sm:flex-1">
            <TextFieldInput
              name="q"
              aria-label="Search project memory"
              placeholder="Search this project"
              class="h-11 md:h-10"
            />
          </TextField>
          <ResponsiveSelect
            label="Search scope"
            sheetTitle="Search scope"
            value={scope()}
            onChange={(value) => setScope((value ?? "all") as RecallScope)}
            options={["all", "session", "project", "knowledge"]}
            triggerClass="h-10 w-28"
          />
          <Button
            type="submit"
            size="sm"
            class="h-11 flex-1 sm:flex-none md:h-10"
          >
            Search
          </Button>
        </form>
      </section>
      <section class="border-b border-line py-5">
        <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div class="eyebrow">Recent sessions</div>
          <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
            <A
              class="inline-flex items-center gap-1 whitespace-nowrap text-xs text-accent underline"
              href={importsHref(props.project.id)}
            >
              Import history <Icon name="chevron" class="size-3.5" />
            </A>
            <A
              class="inline-flex items-center gap-1 whitespace-nowrap text-xs text-accent underline"
              href={sessionsHref(props.project.id)}
            >
              All sessions <Icon name="chevron" class="size-3.5" />
            </A>
          </div>
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
                  preview={`${pluralize(session.message_count, "message")} · ${session.distilled_count} distilled`}
                  footRight={formatWhen(session.last_message_at)}
                />
              )}
            </For>
          </Match>
        </Switch>
      </section>
      <section class="border-b border-line py-5">
        <div class="eyebrow mb-2">Identity</div>
        <div class="break-all font-mono text-xs">{props.project.path}</div>
        <Show
          when={props.project.git_remote}
          fallback={
            <span class="mt-2 inline-block text-xs text-muted">
              local path only (no remote recorded)
            </span>
          }
        >
          <div class="mt-2 break-all text-xs text-muted">
            {props.project.git_remote}
          </div>
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
                      class="break-all text-xs text-accent underline"
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
      <ProjectActions project={props.project} />
      <SharingPanel projectId={props.project.id} />
    </div>
  );
};
