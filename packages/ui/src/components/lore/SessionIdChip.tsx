import type { Component } from "solid-js";
import { Show } from "solid-js";
import { Button } from "~/components/ui/button";
import { createClipboard } from "~/lib/clipboard";

/** Copy stays local even when the chip lives inside a navigable session row. */
export const SessionIdChip: Component<{ id: string; class?: string }> = (
  props,
) => {
  const clipboard = createClipboard(() => props.id);
  return (
    <span
      class={`inline-flex max-w-full flex-wrap items-center gap-1 font-mono text-xs text-muted ${props.class ?? ""}`}
    >
      <span class="min-w-0 truncate" title={props.id}>
        {props.id}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        class="h-11 min-w-11 shrink-0 gap-1 px-1.5 sm:h-8 sm:min-w-0 disabled:pointer-events-auto text-[11px] text-accent [&_svg]:size-3.5"
        aria-label="Copy session id"
        pending={clipboard.pending()}
        icon={clipboard.copied() ? "check" : "copy"}
        onClick={(event: MouseEvent) => {
          event.preventDefault();
          event.stopPropagation();
          void clipboard.copy(props.id);
        }}
      >
        {clipboard.pending()
          ? "Copying…"
          : clipboard.copied()
            ? "Copied"
            : "Copy"}
      </Button>
      <span class="sr-only" role="status">
        {clipboard.copied() ? "Copied session id" : ""}
      </span>
      <Show when={clipboard.error()}>
        {(error) => (
          <span role="alert" class="basis-full text-xs text-danger">
            {error()}
          </span>
        )}
      </Show>
    </span>
  );
};
