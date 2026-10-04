import type { Component } from "solid-js";
import { For, Match, Show, Switch } from "solid-js";
import { A, useNavigate } from "@solidjs/router";

import {
  DEFAULT_ALL_KNOWLEDGE_QUERY,
  DEFAULT_KNOWLEDGE_QUERY,
} from "~/contracts";
import type { AllKnowledgeQuery, KnowledgeSearchResponse } from "~/contracts";
import { pluralize, previewOf, formatWhen } from "~/lib/format";
import type { Loader } from "~/lib/loader";
import { errorStateFor } from "./ErrorState";
import { ListRow } from "./Panes";
import { StateCard } from "./StateCard";
import { Button } from "../ui/button";
import { TextField, TextFieldInput } from "../ui/text-field";

export const WorkspaceSearch: Component<{
  q: string;
  page: { loader: Loader<KnowledgeSearchResponse> };
  allHref: (query: AllKnowledgeQuery) => string;
  entryHref: (knowledgeId: string) => string;
  searchHref: (q: string) => string;
}> = (props) => {
  const navigate = useNavigate();
  const response = () => props.page.loader.data();
  return (
    <div class="mx-auto max-w-[940px] px-5 py-8 sm:px-7.5">
      <h1 class="mb-3 text-[25px] font-semibold">Search all knowledge</h1>
      <form
        role="search"
        class="mb-5 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const raw = new FormData(event.currentTarget).get("q");
          const q = (typeof raw === "string" ? raw : "").trim();
          navigate(props.searchHref(q));
        }}
      >
        <TextField class="min-w-0 flex-1">
          <TextFieldInput
            name="q"
            value={props.q}
            aria-label="Search all knowledge"
            placeholder="Search all knowledge"
          />
        </TextField>
        <Button type="submit" size="sm">
          Search
        </Button>
      </form>
      <p class="mb-5 text-xs text-muted">
        Knowledge only — sessions and distillations are searched per project.
      </p>
      <Switch>
        <Match when={!props.q}>
          <StateCard
            kind="empty"
            title="Type a query to search knowledge across every project"
          >
            <A
              class="text-accent underline"
              href={props.allHref(DEFAULT_ALL_KNOWLEDGE_QUERY)}
            >
              Browse all knowledge
            </A>
          </StateCard>
        </Match>
        <Match when={props.page.loader.loading() && !response()}>
          <StateCard kind="loading" title="Searching knowledge" />
        </Match>
        <Match when={props.page.loader.error()}>
          {errorStateFor(
            props.page.loader.error(),
            "Knowledge search",
            props.page.loader.reload,
          )}
        </Match>
        <Match when={response()}>
          {(result) => (
            <div>
              <p class="mb-3 text-sm" data-testid="search-summary">
                {result().total > result().items.length
                  ? `Top ${result().items.length} of ${pluralize(result().total, "match", "matches")}`
                  : pluralize(result().total, "match", "matches")}
              </p>
              <Show when={result().mode === "like"}>
                <p class="mb-3 text-xs text-muted">
                  No indexed terms in this query; showing substring matches,
                  newest first.
                </p>
              </Show>
              <Show when={result().mode === "none"}>
                <StateCard
                  kind="empty"
                  title="Nothing in this query is searchable"
                >
                  <A
                    class="text-accent underline"
                    href={props.allHref(DEFAULT_ALL_KNOWLEDGE_QUERY)}
                  >
                    Browse all knowledge
                  </A>
                </StateCard>
              </Show>
              <Show
                when={result().mode !== "none" && result().items.length === 0}
              >
                <StateCard kind="empty" title="No knowledge matches this query">
                  <A
                    class="text-accent underline"
                    href={props.allHref(DEFAULT_ALL_KNOWLEDGE_QUERY)}
                  >
                    Browse all knowledge
                  </A>
                </StateCard>
              </Show>
              <Show
                when={result().mode !== "none" && result().items.length > 0}
              >
                <A
                  class="mb-4 inline-block text-sm text-accent underline"
                  href={props.allHref({
                    q: props.q,
                    category: null,
                    scope: null,
                    sort: DEFAULT_KNOWLEDGE_QUERY.sort,
                    cursor: null,
                    project: null,
                  })}
                >
                  Browse all {result().total}{" "}
                  {result().total === 1 ? "match" : "matches"} in the table
                </A>
                <ol class="m-0 list-none p-0">
                  <For each={result().items}>
                    {(hit) => (
                      <li>
                        <ListRow
                          href={props.entryHref(hit.id)}
                          title={hit.title}
                          preview={previewOf(hit.content)}
                          footLeft={`${hit.category} · ${hit.project_name ?? (hit.project_id ? "Unknown project" : "No project")}`}
                          footRight={formatWhen(
                            hit.updated_at ?? hit.created_at,
                          )}
                          testId="search-hit"
                        />
                      </li>
                    )}
                  </For>
                </ol>
              </Show>
            </div>
          )}
        </Match>
      </Switch>
    </div>
  );
};
