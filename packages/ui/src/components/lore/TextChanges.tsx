import { For, Match, Switch } from "solid-js";
import type { Component } from "solid-js";
import type { TextChange } from "~/lib/text-diff";

export const TextChanges: Component<{ changes: TextChange[] }> = (props) => (
  <For each={props.changes}>
    {(part) => (
      <Switch>
        <Match when={part.kind === "added"}>
          <ins class="rounded-sm bg-emerald-100 text-emerald-950 decoration-emerald-700 dark:bg-emerald-950 dark:text-emerald-100 dark:decoration-emerald-300">
            {part.text}
          </ins>
        </Match>
        <Match when={part.kind === "removed"}>
          <del class="rounded-sm bg-rose-100 text-rose-950 decoration-rose-700 dark:bg-rose-950 dark:text-rose-100 dark:decoration-rose-300">
            {part.text}
          </del>
        </Match>
        <Match when={part.kind === "equal"}>{part.text}</Match>
      </Switch>
    )}
  </For>
);
