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
      "flex min-h-11 items-center justify-between gap-3 border-b border-line bg-bg px-4 py-2.5 text-[13px] font-semibold",
      props.class,
    )}
  >
    <span class="line-clamp-2 break-words leading-snug">{props.title}</span>
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
  /** Optional badge rendered next to the title (e.g. "≈ approximate"). */
  badge?: string;
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
      "block border-b border-line px-4 py-3 text-[13px] text-text hover:bg-soft/70 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
      props.selected && "border-l-2 border-l-accent bg-soft pl-3.5",
    )}
  >
    <div class="mb-1 flex min-w-0 items-center gap-1.5 font-medium">
      <span class="line-clamp-2 break-words leading-snug">{props.title}</span>
      <Show when={props.badge}>
        <span
          class="shrink-0 rounded-sm bg-soft px-1 py-px text-[10px] font-normal text-muted"
          title="Approximate match"
          data-testid="search-match-fuzzy"
        >
          {props.badge}
        </span>
      </Show>
    </div>
    <Show when={props.preview}>
      <div class="mb-2 truncate text-xs text-muted">{props.preview}</div>
    </Show>
    <div class="flex justify-between gap-3 text-[10px] text-muted">
      <span class="truncate">{props.footLeft}</span>
      <span class="flex-none">{props.footRight}</span>
    </div>
  </A>
);

export const Crumb: Component<{ parts: readonly string[] }> = (props) => (
  <div class="mb-2 truncate text-xs text-muted">{props.parts.join(" / ")}</div>
);
