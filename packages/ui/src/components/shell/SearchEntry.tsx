import {
  PROJECT_MEMORY_SEARCH_LABEL,
  WORKSPACE_KNOWLEDGE_SEARCH_LABEL,
} from "~/lib/search-labels";
import type { Component } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { searchHref, workspaceSearchHref } from "~/lib/href";
import { Icon } from "./Icon";
import { cn } from "~/lib/utils";

export const SearchEntry: Component<{
  class?: string;
  searchProjectId?: string;
}> = (props) => {
  const navigate = useNavigate();
  return (
    <form
      class={cn(
        "ml-auto flex min-w-0 items-center rounded-md border border-line bg-bg text-[13px] text-muted",
        "h-8 md:w-[min(27rem,40vw)]",
        props.class,
      )}
      onSubmit={(event) => {
        event.preventDefault();
        const raw = new FormData(event.currentTarget).get("q");
        const q = (typeof raw === "string" ? raw : "").trim();
        if (props.searchProjectId)
          navigate(searchHref(props.searchProjectId, q, "all"));
        else navigate(workspaceSearchHref(q));
      }}
    >
      <Icon name="search" class="ml-2.5 hidden size-3.5 md:block" />
      <input
        name="q"
        aria-label={
          props.searchProjectId
            ? PROJECT_MEMORY_SEARCH_LABEL
            : WORKSPACE_KNOWLEDGE_SEARCH_LABEL
        }
        placeholder={
          props.searchProjectId
            ? `${PROJECT_MEMORY_SEARCH_LABEL}…`
            : `${WORKSPACE_KNOWLEDGE_SEARCH_LABEL}…`
        }
        class="hidden h-full min-w-0 flex-1 bg-transparent px-2.5 text-xs outline-none md:block"
      />
      <button
        type="submit"
        data-testid="search-entry"
        aria-label={
          props.searchProjectId
            ? PROJECT_MEMORY_SEARCH_LABEL
            : WORKSPACE_KNOWLEDGE_SEARCH_LABEL
        }
        class="size-8 md:hidden"
      >
        <Icon name="search" class="mx-auto size-3.5" />
      </button>
    </form>
  );
};
