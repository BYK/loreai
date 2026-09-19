import type { Component, JSX } from "solid-js";
import { For } from "solid-js";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

export const NOT_AVAILABLE_YET = "not available yet";

/** Actions defined by the roadmap but not implemented in this slice. */
export const FUTURE_ACTIONS = [
  "Save note",
  "Ask agent",
  "Explore separately",
  "Start with selected context",
  "Share finding",
] as const;

export type FutureActionName = (typeof FUTURE_ACTIONS)[number];

/**
 * A disabled button for an action that a later slice implements. Always
 * disabled, always says so: the label is visible text (not just a tooltip)
 * so the state is obvious in screenshots and to assistive technology.
 */
export const FutureAction: Component<{
  name: FutureActionName;
  variant?: "default" | "outline";
  class?: string;
}> = (props) => (
  <Button
    variant={props.variant ?? "outline"}
    disabled
    aria-disabled="true"
    title={`${props.name} — ${NOT_AVAILABLE_YET}`}
    class={cn(
      "h-auto min-h-10 flex-col gap-0 py-1.5 leading-tight",
      props.class,
    )}
  >
    <span>{props.name}</span>
    <span class="text-[10px] font-normal opacity-80">{NOT_AVAILABLE_YET}</span>
  </Button>
);

export const FutureActionRow: Component<{
  actions: readonly FutureActionName[];
  primary?: FutureActionName;
  trailing?: JSX.Element;
  class?: string;
}> = (props) => (
  <div class={cn("mt-3 flex flex-wrap items-center gap-2", props.class)}>
    <For each={props.actions}>
      {(name) => (
        <FutureAction
          name={name}
          variant={name === props.primary ? "default" : "outline"}
        />
      )}
    </For>
    {props.trailing}
  </div>
);
