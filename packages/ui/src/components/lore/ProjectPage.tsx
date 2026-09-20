import type { Component } from "solid-js";
import { For, Match, Show, Switch, createSignal } from "solid-js";
import { A, useNavigate } from "@solidjs/router";

import type { ProjectSummary, RecallScope } from "~/contracts";
import { formatWhen, pluralize } from "~/lib/format";
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
import { Button } from "../ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { TextField, TextFieldInput } from "../ui/text-field";

export const ProjectPage: Component<{ project: ProjectSummary }> = (props) => {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const [scope, setScope] = createSignal<RecallScope>("all");
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
  const humanizeState = (state: string) =>
    state
      .replace(/_/g, " ")
      .replace(/^./, (character) => character.toUpperCase());
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
      <section class="border-b border-line py-5">
        <div class="eyebrow mb-2">Sharing</div>
        <Switch>
          <Match when={sharingState.loading() && !sharingState.data()}>
            <StateCard kind="loading" title="Loading sharing status" compact />
          </Match>
          <Match when={sharingState.data()}>
            {(status) => (
              <div class="text-sm">
                {humanizeState(status().state)} ·{" "}
                {status().team?.name ?? "No team"} · policy:{" "}
                {status().policy.effective}
              </div>
            )}
          </Match>
          <Match when={sharingState.error()}>
            <StateCard
              kind="empty"
              title="Sharing status not available"
              compact
            />
          </Match>
        </Switch>
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
                  preview={`${pluralize(session.message_count, "message")} · ${session.distilled_count} distilled`}
                  footRight={formatWhen(session.last_message_at)}
                />
              )}
            </For>
          </Match>
        </Switch>
      </section>
      <section class="py-5">
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
            const q = typeof rawQ === "string" ? rawQ : "";
            navigate(searchHref(props.project.id, q, scope()));
          }}
        >
          <TextField class="min-w-0 flex-1">
            <TextFieldInput
              name="q"
              aria-label="Search project memory"
              placeholder="Search this project"
            />
          </TextField>
          <Select
            value={scope()}
            onChange={setScope}
            options={["all", "session", "project", "knowledge"]}
            itemComponent={(item) => (
              <SelectItem item={item.item}>{item.item.rawValue}</SelectItem>
            )}
          >
            <SelectTrigger aria-label="Search scope" class="h-10 w-28">
              <SelectValue<string>>
                {(state) => state.selectedOption()}
              </SelectValue>
            </SelectTrigger>
            <SelectContent />
          </Select>
          <Button type="submit" size="sm">
            Search
          </Button>
        </form>
      </section>
    </div>
  );
};
