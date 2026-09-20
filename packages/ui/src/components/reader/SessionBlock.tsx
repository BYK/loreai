/**
 * Visual rendering of session blocks (UI-06a). Presentation only: the block
 * model decides *what* a part is, `~/lib/safe-html` decides what HTML may
 * reach the DOM, and these components decide how it looks. Every rendered
 * part carries `data-block` / `data-part` so the reader (UI-06b) can map a
 * DOM selection back to a logical source anchor.
 */
import type { Accessor, Component, JSX } from "solid-js";
import {
  For,
  Show,
  createContext,
  createEffect,
  createMemo,
  useContext,
} from "solid-js";

import { Avatar } from "~/components/lore/Avatar";
import { Badge } from "~/components/ui/badge";
import type { DistillationDetail } from "~/contracts";
import { formatFullDate, formatWhen } from "~/lib/format";
import type { RenderedHtml } from "~/lib/safe-html";
import { cn } from "~/lib/utils";
import {
  type BlockPart,
  type DistillationBlock,
  type MessageBlock,
  originLabel,
} from "~/reader/blocks";
import { renderPart } from "~/reader/render";
import {
  type HighlightSpan,
  applyHighlights,
  clearHighlight,
} from "~/reader/selection";

export const TIME_UNKNOWN = "time unknown";

/** A displayed-text span of one part the reader wants marked. */
export interface PassageHighlight {
  blockId: string;
  partIndex: number;
  start: number;
  end: number;
}

export interface HighlightController {
  highlight: Accessor<PassageHighlight | null>;
  /** The current in-session search hit; marked independently of the passage. */
  searchHit?: Accessor<PassageHighlight | null>;
  /** Called with the first `<mark>` each time a highlight is (re)applied. */
  onApplied?: (mark: HTMLElement, highlight: PassageHighlight) => void;
}

function addresses(
  h: PassageHighlight | null | undefined,
  block: string,
  part: number,
): h is PassageHighlight {
  return !!h && h.blockId === block && h.partIndex === part;
}

/**
 * The reader provides the current passage highlight; `RichText` applies it
 * to whichever mounted part it addresses. Logical (block/part/offsets), so a
 * virtualised row that unmounts and remounts re-applies it on its own.
 */
export const HighlightContext = createContext<HighlightController>({
  highlight: () => null,
});

/** Relative time with the full date as a tooltip; honest when unknown. */
export const BlockTime: Component<{ at: number | null; class?: string }> = (
  props,
) => (
  <Show
    when={props.at !== null}
    fallback={
      <span class={cn("text-xs italic text-muted", props.class)}>
        {TIME_UNKNOWN}
      </span>
    }
  >
    <time
      class={cn("text-xs text-muted", props.class)}
      dateTime={new Date(props.at ?? 0).toISOString()}
      title={formatFullDate(props.at)}
    >
      {formatWhen(props.at)}
    </time>
  </Show>
);

/**
 * Sanitised HTML container. The only `innerHTML` sink in the UI; its input
 * is always a `RenderedHtml` produced by `~/lib/safe-html`.
 */
export const RichText: Component<{
  rendered: RenderedHtml;
  block: string;
  part: number;
  class?: string;
}> = (props) => {
  const controller = useContext(HighlightContext);
  let el: HTMLDivElement | undefined;
  createEffect(() => {
    // Re-run when the HTML is replaced (Solid resets innerHTML first) or
    // the highlight moves.
    void props.rendered.html;
    const hit = controller.searchHit?.();
    const h = controller.highlight();
    if (!el) return;
    const wanted: { span: HighlightSpan; source: PassageHighlight }[] = [];
    if (addresses(h, props.block, props.part))
      wanted.push({
        span: { start: h.start, end: h.end, className: "passage-target" },
        source: h,
      });
    if (addresses(hit, props.block, props.part))
      wanted.push({
        span: { start: hit.start, end: hit.end, className: "passage-search" },
        source: hit,
      });
    if (wanted.length === 0) {
      clearHighlight(el);
      return;
    }
    const marks = applyHighlights(
      el,
      wanted.map((w) => w.span),
    );
    marks.forEach((mark, i) => {
      if (mark) controller.onApplied?.(mark, wanted[i]!.source);
    });
  });
  return (
    <div
      ref={(node) => (el = node)}
      class={cn(
        "rich-text",
        props.rendered.plain && "rich-text-plain",
        props.class,
      )}
      data-block={props.block}
      data-part={props.part}
      innerHTML={props.rendered.html}
    />
  );
};

const ORIGIN_AVATAR: Record<
  MessageBlock["origin"],
  { label: string; kind: "person" | "agent" }
> = {
  user: { label: "U", kind: "person" },
  agent: { label: "AI", kind: "agent" },
  lore: { label: "L", kind: "agent" },
  system: { label: "S", kind: "agent" },
  unknown: { label: "?", kind: "person" },
};

/** Author line: who, how (harness / model), when. */
export const BlockAuthor: Component<{ block: MessageBlock }> = (props) => {
  const avatar = () => ORIGIN_AVATAR[props.block.origin];
  return (
    <div class="mb-2 flex flex-wrap items-center gap-2 text-[13px]">
      <Avatar label={avatar().label} kind={avatar().kind} size="sm" />
      <b>{originLabel(props.block)}</b>
      <Show when={props.block.origin === "lore"}>
        <Badge
          variant="teal"
          title="Injected by Lore, not written by a participant"
        >
          injected by Lore
        </Badge>
      </Show>
      <Show when={props.block.origin === "system"}>
        <Badge variant="teal">system prompt</Badge>
      </Show>
      <Show when={props.block.origin === "unknown"}>
        <Badge variant="outline" title="Stored role Lore does not recognise">
          unrecognised role
        </Badge>
      </Show>
      <Show when={props.block.meta.agent}>
        {(agent) => (
          <Badge variant="outline" title="Harness that produced this message">
            via {agent()}
          </Badge>
        )}
      </Show>
      <Show when={props.block.meta.modelId}>
        {(model) => (
          <Badge variant="outline" title="Model recorded for this message">
            {model()}
          </Badge>
        )}
      </Show>
      <Show when={props.block.distilled}>
        <Badge variant="outline" title="Already folded into compressed context">
          distilled
        </Badge>
      </Show>
      <BlockTime at={props.block.createdAt} class="ml-auto" />
    </div>
  );
};

const ENVELOPE_LABEL: Record<Exclude<BlockPart["kind"], "text">, string> = {
  reasoning: "Reasoning",
  tool: "Tool",
};

/** Expandable tool output / reasoning; prose renders inline. */
export const PartView: Component<{
  block: MessageBlock;
  part: BlockPart;
  /** Force tool/reasoning parts open (search hits, deep links). */
  open?: boolean;
  children?: JSX.Element;
}> = (props) => {
  const rendered = createMemo(() => renderPart(props.block, props.part));
  const lines = () => props.part.text.split("\n").length;
  const controller = useContext(HighlightContext);
  // A highlighted tool/reasoning part must be visible to be highlighted.
  const highlighted = () =>
    addresses(controller.highlight(), props.block.id, props.part.index) ||
    addresses(controller.searchHit?.(), props.block.id, props.part.index);
  return (
    <Show
      when={props.part.kind !== "text"}
      fallback={
        <RichText
          rendered={rendered()}
          block={props.block.id}
          part={props.part.index}
        />
      }
    >
      <details
        class="my-2.5 rounded-md border border-line bg-bg text-[13px] open:bg-surface"
        open={props.open || highlighted()}
        data-part-kind={props.part.kind}
      >
        <summary class="flex cursor-pointer list-none items-center gap-2 px-3 py-2">
          <span class="rounded-sm bg-chrome px-1.5 py-0.5 font-mono text-[11px] text-accent">
            {props.part.kind === "tool"
              ? (props.part.tool ?? ENVELOPE_LABEL.tool)
              : ENVELOPE_LABEL.reasoning}
          </span>
          <span class="truncate text-muted">
            {props.part.kind === "tool" ? "tool output" : "captured reasoning"}
            {" · "}
            {lines()} {lines() === 1 ? "line" : "lines"}
          </span>
          {props.children}
        </summary>
        <RichText
          rendered={rendered()}
          block={props.block.id}
          part={props.part.index}
          class="border-t border-line"
        />
      </details>
    </Show>
  );
};

export const MessageBlockView: Component<{
  block: MessageBlock;
  openParts?: boolean;
  class?: string;
  /** Rendered after the author line, before the parts (e.g. selection UI). */
  children?: JSX.Element;
}> = (props) => (
  <article
    id={props.block.id}
    data-block-id={props.block.id}
    data-origin={props.block.origin}
    class={cn(
      "reader-block mb-5",
      props.block.origin === "lore" && "reader-block-lore",
      props.block.origin === "system" && "reader-block-system",
      props.class,
    )}
  >
    <BlockAuthor block={props.block} />
    {props.children}
    <div class="pl-0 sm:pl-[33px]">
      <For each={props.block.parts}>
        {(part) => (
          <PartView block={props.block} part={part} open={props.openParts} />
        )}
      </For>
    </div>
  </article>
);

function ratio(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(1)}×`;
}

/**
 * A distillation is *compressed context* Lore produced from the messages
 * around it — never speech from the session. It is labelled as such, kept
 * visually distinct from message blocks and only shows the compressed text
 * when the reader asks for it (the summary row has no body).
 */
export const DistillationBlockView: Component<{
  block: DistillationBlock;
  detail?: DistillationDetail | null;
  loading?: boolean;
  error?: string | null;
  onOpen?: () => void;
  class?: string;
}> = (props) => {
  const s = () => props.block.summary;
  return (
    <aside
      id={props.block.id}
      data-block-id={props.block.id}
      data-origin="distillation"
      aria-label={`Compressed context, generation ${s().generation}`}
      class={cn(
        "reader-block reader-block-distillation mb-5 rounded-md border border-dashed border-thread bg-soft/40 px-3.5 py-3 text-[13px]",
        props.class,
      )}
    >
      <div class="mb-1.5 flex flex-wrap items-center gap-2">
        <span class="eyebrow">Compressed context</span>
        <Badge variant="teal">generation {s().generation}</Badge>
        <Show when={s().archived === 1}>
          <Badge variant="outline">archived</Badge>
        </Show>
        <span class="text-xs text-muted">
          {s().token_count.toLocaleString()} tokens · {ratio(s().r_compression)}{" "}
          compression
        </span>
        <BlockTime at={props.block.createdAt} class="ml-auto" />
      </div>
      <p class="my-1 text-muted">
        Lore's summary of the surrounding messages — not what anyone said.
      </p>
      <details
        class="mt-1.5"
        onToggle={(e) => {
          if (e.currentTarget.open) props.onOpen?.();
        }}
      >
        <summary class="cursor-pointer text-accent">
          Show compressed context
        </summary>
        <Show when={props.loading}>
          <p class="my-2 text-xs text-muted">Loading…</p>
        </Show>
        <Show when={props.error}>
          {(err) => <p class="my-2 text-xs text-danger">{err()}</p>}
        </Show>
        <Show when={props.detail}>
          {(detail) => (
            <pre class="rich-text-plain mt-2 whitespace-pre-wrap font-mono text-xs leading-relaxed">
              {detail().observations}
            </pre>
          )}
        </Show>
      </details>
    </aside>
  );
};
