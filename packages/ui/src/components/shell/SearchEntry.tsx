import type { Component } from "solid-js";
import { For, Show, createEffect, createSignal } from "solid-js";
import { useNavigate } from "@solidjs/router";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { searchHref } from "~/routes/Browse";
import { cn } from "~/lib/utils";
import { useWorkspace } from "~/routes/workspace";

export const SearchEntry: Component<{
  class?: string;
  searchProjectId?: string;
}> = (props) => {
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [results, setResults] = createSignal<
    Array<{ projectName: string; result: string }>
  >([]);
  const workspace = useWorkspace();
  const navigate = useNavigate();
  let searchGeneration = 0;
  createEffect(() => {
    const q = query().trim();
    const projects = workspace.projects.data();
    if (props.searchProjectId || !open() || !q || !projects) {
      setResults([]);
      return;
    }
    const generation = ++searchGeneration;
    void Promise.all(
      projects.map(async (project) => ({
        projectName: project.name || project.path,
        result: (await workspace.client.recall({ q, project, scope: "all" }))
          .result,
      })),
    ).then((next) => {
      if (generation === searchGeneration)
        setResults(
          next.filter(
            ({ result }) =>
              !result.startsWith("No results found for this query."),
          ),
        );
    });
  });
  return (
    <>
      <form
        class={cn(
          "flex rounded-md border border-line bg-bg text-[13px] text-muted",
          "h-8 md:h-auto md:w-[320px] md:max-w-full",
          props.class,
        )}
        onSubmit={(event) => {
          event.preventDefault();
          const raw = new FormData(event.currentTarget).get("q");
          const q = (typeof raw === "string" ? raw : "").trim();
          if (props.searchProjectId)
            navigate(searchHref(props.searchProjectId, q, "all"));
          else setOpen(true);
        }}
      >
        <input
          name="q"
          aria-label="Search"
          placeholder={
            props.searchProjectId
              ? "Search this project's memory…"
              : "Pick a project to search"
          }
          class="hidden min-w-0 flex-1 bg-transparent px-3 outline-none md:block"
        />
        <button
          type="submit"
          data-testid="search-entry"
          aria-label="Search"
          class="size-8 md:hidden"
        >
          ⌕
        </button>
      </form>
      <Dialog open={open()} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Pick a project first</DialogTitle>
            <DialogDescription>
              Pick a project first — recall is scoped to a project.
            </DialogDescription>
          </DialogHeader>
          <input
            aria-label="Search query"
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search all projects"
            class="h-9 rounded-md border border-line bg-bg px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <Show when={query().trim() && results().length > 0}>
            <div class="space-y-2" data-testid="workspace-search-results">
              <For each={results()}>
                {(result) => (
                  <div
                    class="rounded-md border border-line p-2 text-sm"
                    data-testid="workspace-search-result"
                  >
                    <div class="font-semibold">{result.projectName}</div>
                    <div class="whitespace-pre-wrap text-xs text-muted">
                      {result.result}
                    </div>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </DialogContent>
      </Dialog>
    </>
  );
};
