/**
 * Inline discussion UI (APP-02): the collapsed indicator that sits at an
 * anchor and the expanded thread with its replies and reply box. The same
 * thread body renders in the focused route.
 */
import type { Component, JSX } from "solid-js";
import { createSignal, For, onMount, Show } from "solid-js";
import { A } from "@solidjs/router";

import { Avatar } from "~/components/lore/Avatar";
import { Button } from "~/components/ui/button";
import type { Discussion, DiscussionReply } from "~/contracts";
import { formatFullDate, formatWhen, pluralize } from "~/lib/format";
import { discussionHref, sessionHref } from "~/lib/href";
import { cn } from "~/lib/utils";
import { discussionTone, participantAvatar } from "~/reader/discussion-marks";
import { useWorkspace } from "~/routes/workspace";
import { replyDraftKey } from "~/state/discussions";

import { Composer } from "./Composer";

export const ANCHOR_STATUS_LABEL: Record<Discussion["anchor_status"], string> =
  {
    current: "",
    stale_anchor: "Source changed since this was anchored",
    source_missing: "Source no longer exists",
  };

export const ParticipantStack: Component<{
  participants: readonly string[];
  max?: number;
}> = (props) => (
  <span class="inline-flex -space-x-1.5">
    <For each={props.participants.slice(0, props.max ?? 3)}>
      {(p) => {
        const a = participantAvatar(p);
        return (
          <Avatar
            label={a.label}
            kind={a.kind}
            size="sm"
            class="size-5 rounded-full text-[9px] ring-2 ring-surface"
          />
        );
      }}
    </For>
  </span>
);

/** Collapsed marker: tone dot, participant avatars, reply count. */
export const DiscussionIndicator: Component<{
  discussion: Discussion;
  expanded: boolean;
  onToggle: () => void;
}> = (props) => (
  <button
    type="button"
    data-testid="discussion-indicator"
    data-discussion-id={props.discussion.id}
    aria-expanded={props.expanded}
    aria-label={`${props.discussion.kind === "note" ? "Note" : "Discussion"} on “${props.discussion.quote.slice(0, 60)}”, ${pluralize(props.discussion.reply_count, "reply", "replies")}`}
    onClick={() => props.onToggle()}
    class={cn(
      "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] text-muted outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-ring",
      `discussion-chip tone-${discussionTone(props.discussion.id)}`,
      props.discussion.state === "resolved" && "opacity-60",
    )}
  >
    <ParticipantStack participants={props.discussion.participants} />
    <span data-testid="discussion-reply-count">
      {props.discussion.reply_count}
    </span>
    <Show when={props.discussion.kind === "note"}>
      <span>note</span>
    </Show>
    <Show when={props.discussion.state === "resolved"}>
      <span>resolved</span>
    </Show>
    <Show when={props.discussion.anchor_status !== "current"}>
      <span
        class="text-danger"
        title={ANCHOR_STATUS_LABEL[props.discussion.anchor_status]}
      >
        ⚠
      </span>
    </Show>
  </button>
);

const ReplyItem: Component<{ projectId: string; reply: DiscussionReply }> = (
  props,
) => {
  const who = () => participantAvatar(props.reply.author);
  return (
    <li
      class="py-1.5"
      data-testid="discussion-reply"
      data-seq={props.reply.seq}
    >
      <div class="flex items-center gap-2 text-xs">
        <Avatar label={who().label} kind={who().kind} size="sm" />
        <b class="text-text">{who().name}</b>
        <time
          class="text-muted"
          dateTime={new Date(props.reply.created_at).toISOString()}
          title={formatFullDate(props.reply.created_at)}
        >
          {formatWhen(props.reply.created_at)}
        </time>
      </div>
      <div class="mt-0.5 whitespace-pre-wrap pl-8 text-sm [overflow-wrap:anywhere]">
        {props.reply.content.kind === "text" ? (
          props.reply.content.body
        ) : (
          <A
            class="text-accent hover:underline"
            href={sessionHref(
              props.projectId,
              props.reply.content.binding.session_id,
            )}
          >
            Native response from {props.reply.content.binding.agent || "agent"}
          </A>
        )}
      </div>
    </li>
  );
};

/** Replies + reply box + fold/resolve controls for one discussion. */
export const DiscussionThread: Component<{
  projectId: string;
  discussion: Discussion;
  /** Hide the "Open" link (already on the focused route). */
  focused?: boolean;
  autofocus?: boolean;
  onClose?: () => void;
  header?: JSX.Element;
}> = (props) => {
  const ws = useWorkspace();
  const state = ws.state.discussions;
  const [error, setError] = createSignal<string | null>(null);
  const [folded, setFolded] = createSignal(false);
  const replies = () => state.replies(props.discussion.id);

  onMount(() => {
    if (!replies()) {
      void state
        .loadReplies(props.projectId, props.discussion.id)
        .catch((err: unknown) =>
          setError(err instanceof Error ? err.message : String(err)),
        );
    }
  });

  async function toggleResolved() {
    setError(null);
    try {
      await state.setState(
        props.projectId,
        props.discussion,
        props.discussion.state === "open" ? "resolved" : "open",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section
      data-testid="discussion-thread"
      data-discussion-id={props.discussion.id}
      aria-label="Discussion"
      class={cn(
        "rounded-lg bg-surface px-3 py-2 text-sm",
        `discussion-panel tone-${discussionTone(props.discussion.id)}`,
      )}
    >
      {props.header}
      <div class="flex flex-wrap items-center gap-2 text-xs text-muted">
        <span>
          {pluralize(props.discussion.reply_count, "reply", "replies")}
        </span>
        <Show when={props.discussion.anchor_status !== "current"}>
          <span class="text-danger" data-testid="anchor-status">
            {ANCHOR_STATUS_LABEL[props.discussion.anchor_status]}
          </span>
        </Show>
        <span class="ml-auto flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            class="h-7 px-2"
            aria-expanded={!folded()}
            onClick={() => setFolded(!folded())}
            data-testid="discussion-fold"
          >
            {folded() ? "Unfold" : "Fold"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            class="h-7 px-2"
            onClick={() => void toggleResolved()}
            data-testid="discussion-resolve"
          >
            {props.discussion.state === "open" ? "Resolve" : "Reopen"}
          </Button>
          <Show when={!props.focused}>
            <A
              href={discussionHref(props.projectId, props.discussion.id)}
              class="px-2 text-accent hover:underline"
              data-testid="discussion-open"
            >
              Open
            </A>
          </Show>
          <Show when={props.onClose}>
            {(close) => (
              <Button
                size="sm"
                variant="ghost"
                class="h-7 px-2"
                aria-label="Collapse discussion"
                onClick={() => close()()}
              >
                ✕
              </Button>
            )}
          </Show>
        </span>
      </div>
      <Show when={!folded()}>
        <ol class="m-0 list-none p-0" data-testid="discussion-replies">
          <For each={replies() ?? []}>
            {(reply) => <ReplyItem projectId={props.projectId} reply={reply} />}
          </For>
        </ol>
        <Composer
          draftKey={replyDraftKey(props.discussion.id)}
          projectId={props.projectId}
          target={props.discussion.id}
          submitLabel="Reply"
          autofocus={props.autofocus}
          onSubmit={async (text) => {
            await state.reply(props.projectId, props.discussion, text);
          }}
        />
      </Show>
      <Show when={error()}>
        {(err) => (
          <p class="mt-1 text-xs text-danger" role="alert">
            {err()}
          </p>
        )}
      </Show>
    </section>
  );
};
