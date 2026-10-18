import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js";
import type { Component } from "solid-js";

import type { KnowledgeVersion } from "~/contracts";
import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group";
import { diffText } from "~/lib/text-diff";
import type { TextChange } from "~/lib/text-diff";

const ChangedText: Component<{ changes: TextChange[] }> = (props) => (
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

export const VersionDiff: Component<{
  version: KnowledgeVersion;
  previous?: KnowledgeVersion;
}> = (props) => {
  const [fullText, setFullText] = createSignal(false);
  const comparison = createMemo(() => {
    if (!props.previous) return null;
    const title = diffText(props.previous.title, props.version.title);
    const content = diffText(props.previous.content, props.version.content);
    return title && content ? { title, content } : null;
  });
  const hasChanges = () => {
    const value = comparison();
    return (
      value &&
      [...value.title, ...value.content].some((part) => part.kind !== "equal")
    );
  };
  return (
    <div class="space-y-3">
      <Show
        when={comparison()}
        fallback={
          <p class="m-0 text-muted">
            {props.previous
              ? "Changes too large to compare. Showing full text."
              : props.version.version === 1
                ? "Original version"
                : "Previous version unavailable. Showing full text."}
          </p>
        }
      >
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span class="text-muted">
            Changes from v{props.previous?.version}
          </span>
          <ToggleGroup
            class="inline-flex rounded-md border border-line p-0.5"
            size="sm"
            value={fullText() ? "full" : "changes"}
            onChange={(value) => {
              // A view must remain selected when its pressed item is clicked again.
              if (value !== null) setFullText(value === "full");
            }}
            aria-label={`Version ${props.version.version} view`}
          >
            <ToggleGroupItem value="changes" class="text-xs">
              Changes
            </ToggleGroupItem>
            <ToggleGroupItem value="full" class="text-xs">
              Full text
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
        <Show when={!fullText()}>
          <p class="m-0 text-muted">
            {hasChanges()
              ? "Added text is underlined; removed text is struck through."
              : "No text changes. See the recorded details below."}
          </p>
        </Show>
      </Show>
      <div
        class="break-words whitespace-pre-wrap font-semibold"
        data-testid="version-title"
      >
        <Show when={!fullText() && comparison()} fallback={props.version.title}>
          {(value) => <ChangedText changes={value().title} />}
        </Show>
      </div>
      <p
        class="m-0 break-words whitespace-pre-wrap leading-relaxed"
        data-testid="version-content"
      >
        <Show
          when={!fullText() && comparison()}
          fallback={props.version.content}
        >
          {(value) => <ChangedText changes={value().content} />}
        </Show>
      </p>
    </div>
  );
};
