import type { Component, JSX } from "solid-js";
import { Show } from "solid-js";
import { A } from "@solidjs/router";

import { cn } from "~/lib/utils";

export const PaneHead: Component<{
  title: JSX.Element;
  trailing?: JSX.Element;
  class?: string;
}> = (props) => (
  <div
    class={cn(
      "flex items-center justify-between gap-3 border-b border-line bg-chrome px-4.5 py-3.5 text-[13px] font-semibold",
      props.class,
    )}
  >
    <span class="truncate">{props.title}</span>
    <Show when={props.trailing}>
      <span class="flex-none text-muted">{props.trailing}</span>
    </Show>
  </div>
);

export interface ListRowProps {
  href: string;
  title: string;
  preview?: string;
  footLeft?: JSX.Element;
  footRight?: JSX.Element;
  selected?: boolean;
  /** Passed to the anchor so tests and e2e can find rows without text matching. */
  testId?: string;
}

/** Inbox-style row shared by the project list and the knowledge list. */
export const ListRow: Component<ListRowProps> = (props) => (
  <A
    href={props.href}
    data-testid={props.testId}
    aria-current={props.selected ? "page" : undefined}
    class={cn(
      "block border-b border-line px-4 py-4 text-sm text-text hover:bg-soft/70 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
      props.selected && "border-l-[3px] border-l-accent bg-soft pl-[13px]",
    )}
  >
    <div class="mb-1 truncate font-semibold">{props.title}</div>
    <Show when={props.preview}>
      <div class="mb-2 line-clamp-2 text-[13px] text-muted">
        {props.preview}
      </div>
    </Show>
    <div class="flex justify-between gap-3 text-[11px] text-muted">
      <span class="truncate">{props.footLeft}</span>
      <span class="flex-none">{props.footRight}</span>
    </div>
  </A>
);

export const Crumb: Component<{ parts: readonly string[] }> = (props) => (
  <div class="mb-2 truncate text-xs text-muted">{props.parts.join(" / ")}</div>
);
