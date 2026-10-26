import { RECALL_SCOPES } from "~/contracts";
import {
  PROJECT_MEMORY_SEARCH_LABEL,
  RECALL_SCOPE_DETAILS,
  recallScopeLabel,
} from "~/lib/search-labels";
import type { Component } from "solid-js";
import {
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createResource,
  createSignal,
} from "solid-js";
import { A, useNavigate } from "@solidjs/router";
import type { ProjectSummary, RecallScope } from "~/contracts";
import { StateCard } from "./StateCard";
import { errorStateFor } from "./ErrorState";
import { Button } from "../ui/button";
import { ResponsiveSelect } from "../ui/responsive-select";
import { TextField, TextFieldInput } from "../ui/text-field";
import { useWorkspace } from "~/routes/workspace";
import { knowledgeListHref, searchHref } from "~/lib/href";

export const SearchResults: Component<{
  project: ProjectSummary;
  q: string;
  scope: RecallScope;
}> = (props) => {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const [scope, setScope] = createSignal<RecallScope>(props.scope);
  createEffect(() => setScope(props.scope));
  const [recallText] = createResource(() => import("~/lib/recall-text"));
  const search = ws.state.recall.search(() =>
    props.q ? { project: props.project, q: props.q, scope: props.scope } : null,
  );
  const nodes = createMemo(() =>
    search.loader.data() && recallText()
      ? recallText()!.parseRecallMarkdown(search.loader.data()!.result)
      : [],
  );
  return (
    <div class="p-5 sm:p-7.5">
      <h1 class="mb-4 text-[25px] font-semibold">
        {PROJECT_MEMORY_SEARCH_LABEL}
      </h1>
      <form
        role="search"
        class="mb-5 flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          const rawQ = data.get("q");
          const q = typeof rawQ === "string" ? rawQ : "";
          navigate(searchHref(props.project.id, q, scope()));
        }}
      >
        <TextField class="w-full min-w-0 sm:w-auto sm:flex-1">
          <TextFieldInput
            name="q"
            value={props.q}
            aria-label="Search query"
            placeholder={PROJECT_MEMORY_SEARCH_LABEL}
            class="h-11 md:h-10"
          />
        </TextField>
        <ResponsiveSelect
          name="scope"
          label="Search scope"
          sheetTitle="Search scope"
          value={scope()}
          onChange={(value) => {
            if (value) setScope(value as RecallScope);
          }}
          options={RECALL_SCOPES}
          optionLabel={recallScopeLabel}
          triggerClass="h-11 w-full sm:w-60 md:h-10"
        />
        <Button
          type="submit"
          size="sm"
          class="h-11 flex-1 sm:flex-none md:h-10"
        >
          Search
        </Button>
      </form>
      <p class="mb-2 text-sm" data-testid="recall-search-scope">
        Scope: {recallScopeLabel(props.scope)}
      </p>
      <p class="mb-3 text-xs text-muted">
        {RECALL_SCOPE_DETAILS[props.scope].description}
      </p>
      <p class="mb-4 text-xs text-muted">
        Search results are the recall output an agent would receive; query
        expansion is disabled so no model is called.
      </p>
      <Switch>
        <Match when={!props.q}>
          <StateCard
            kind="empty"
            title="Type a query to search this project's memory"
            action={
              <A
                class="inline-flex min-h-11 items-center text-accent underline md:min-h-0"
                href={knowledgeListHref(props.project.id)}
              >
                Browse project knowledge
              </A>
            }
          />
        </Match>
        <Match when={search.loader.loading() && !search.loader.data()}>
          <StateCard kind="loading" title="Searching memory" />
        </Match>
        <Match when={search.loader.error() && !search.loader.data()}>
          {errorStateFor(search.loader.error(), "Search", search.loader.reload)}
        </Match>
        <Match
          when={
            search.loader.data()?.result.trim() ===
            "No results found for this query."
          }
        >
          <StateCard
            kind="empty"
            title="No results"
            action={
              <A
                class="inline-flex min-h-11 items-center text-accent underline md:min-h-0"
                href={knowledgeListHref(props.project.id)}
              >
                Browse project knowledge
              </A>
            }
          >
            <Show when={props.scope !== "all"} fallback="Try different words.">
              Try different words or search all memory.
              <A
                class="ml-2 text-accent underline"
                href={searchHref(props.project.id, props.q, "all")}
              >
                Search all memory
              </A>
            </Show>
          </StateCard>
        </Match>
        <Match when={search.loader.data()}>
          <div>
            {nodes().map((node) =>
              node.kind === "heading" ? (
                node.level === 2 ? (
                  <h2 class="mb-3 text-xl font-semibold">{node.text}</h2>
                ) : node.level === 3 ? (
                  <h3 class="mb-2 mt-4 font-semibold">{node.text}</h3>
                ) : (
                  <h4 class="mb-2 mt-3 text-sm font-semibold">{node.text}</h4>
                )
              ) : node.kind === "separator" ? (
                <hr class="my-4 border-line" />
              ) : (
                <p
                  class={
                    node.kind === "item"
                      ? "my-1 pl-4 before:mr-2 before:content-['•']"
                      : "my-2"
                  }
                >
                  {node.parts.map((part) =>
                    part.linkId ? (
                      <A
                        class="text-accent underline"
                        href={`/knowledge/${encodeURIComponent(part.linkId)}`}
                      >
                        {part.text}
                      </A>
                    ) : part.bold ? (
                      <strong>{part.text}</strong>
                    ) : (
                      part.text
                    ),
                  )}
                </p>
              ),
            )}
          </div>
        </Match>
      </Switch>
    </div>
  );
};
