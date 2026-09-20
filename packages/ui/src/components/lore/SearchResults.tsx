import type { Component } from "solid-js";
import {
  Match,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { TextField, TextFieldInput } from "../ui/text-field";
import { useWorkspace } from "~/routes/workspace";
import { searchHref } from "~/routes/Browse";

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
      <form
        role="search"
        class="mb-5 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          const rawQ = data.get("q");
          const q = typeof rawQ === "string" ? rawQ : "";
          navigate(searchHref(props.project.id, q, scope()));
        }}
      >
        <TextField class="min-w-0 flex-1">
          <TextFieldInput name="q" value={props.q} aria-label="Search query" />
        </TextField>
        <Select
          name="scope"
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
      <p class="mb-4 text-xs text-muted">
        Search results are the recall output an agent would receive; query
        expansion is disabled so no model is called.
      </p>
      <Switch>
        <Match when={!props.q}>
          <StateCard
            kind="empty"
            title="Type a query to search this project's memory"
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
          <StateCard kind="empty" title="No results" />
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
