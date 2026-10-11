import type { Component, JSX } from "solid-js";

import { cn } from "~/lib/utils";

export const ListPane: Component<{
  visible: boolean;
  full: boolean;
  maximized: boolean;
  width: number;
  header: JSX.Element;
  query: string;
  onQueryInput: (value: string) => void;
  children: JSX.Element;
}> = (props) => (
  <section
    data-pane="list"
    aria-label="List"
    aria-hidden={!props.visible}
    hidden={!props.visible}
    class={cn(
      "flex min-h-0 flex-none flex-col overflow-hidden border-r border-line bg-surface",
      !props.full && "w-full",
      props.maximized && "flex-1",
    )}
    style={
      props.full && !props.maximized ? { width: `${props.width}px` } : undefined
    }
  >
    {props.header}
    <label class="mx-2 mb-2 flex h-8 items-center rounded-md bg-chrome px-2">
      <span class="sr-only">Search projects</span>
      <input
        type="search"
        aria-label="Filter projects"
        placeholder="in:inbox"
        data-testid="nav-project-filter"
        class="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted"
        value={props.query}
        onInput={(event) => props.onQueryInput(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") props.onQueryInput("");
        }}
      />
    </label>
    {props.children}
  </section>
);
