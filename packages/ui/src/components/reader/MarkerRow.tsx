/**
 * Transcript marker row (#1924): a thin interstitial in the message stream
 * recording what Lore did to the context — an injection batch, a durable
 * prompt-delta update, or a gradient compaction. Rendered as a labelled
 * note, never as speech; every item is inert text (knowledge links only
 * when the caller supplies `knowledgeHref`).
 */
import type { Component } from "solid-js";
import { For, Show } from "solid-js";
import { A } from "@solidjs/router";

import { Badge } from "~/components/ui/badge";
import type { MarkerBlock, MarkerKind } from "~/reader/markers";

const VARIANT: Record<MarkerKind, "teal" | "outline" | "gold"> = {
  injection: "teal",
  delta: "outline",
  compaction: "gold",
};

const KIND_LABEL: Record<MarkerKind, string> = {
  injection: "knowledge",
  delta: "prompt delta",
  compaction: "compaction",
};

export const MarkerRowView: Component<{
  marker: MarkerBlock;
  knowledgeHref?: (logicalId: string) => string;
}> = (props) => (
  <div
    data-testid="context-marker"
    data-marker={props.marker.marker}
    role="note"
    aria-label={props.marker.title}
    class="my-5 flex items-center gap-3"
  >
    <span aria-hidden="true" class="h-px flex-1 bg-line" />
    <div class="flex max-w-full flex-wrap items-center justify-center gap-x-2 gap-y-1 text-[11px] text-muted">
      <Badge variant={VARIANT[props.marker.marker]}>
        {KIND_LABEL[props.marker.marker]}
      </Badge>
      <span class="font-medium text-text">{props.marker.title}</span>
      <Show when={props.marker.detail}>
        <span class="text-muted">{props.marker.detail}</span>
      </Show>
      <Show when={props.marker.items.length > 0}>
        <span class="flex min-w-0 flex-wrap items-baseline gap-x-1 text-muted">
          <For each={props.marker.items}>
            {(item, i) => (
              <>
                {i() > 0 ? ", " : ""}
                <Show
                  when={item.id !== null && props.knowledgeHref}
                  fallback={<span>{item.label}</span>}
                >
                  <A
                    class="text-accent underline"
                    href={props.knowledgeHref!(item.id!)}
                  >
                    {item.label}
                  </A>
                </Show>
              </>
            )}
          </For>
        </span>
      </Show>
    </div>
    <span aria-hidden="true" class="h-px flex-1 bg-line" />
  </div>
);
