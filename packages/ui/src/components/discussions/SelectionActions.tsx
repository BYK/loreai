/**
 * Actions for a logical selection (a passage, a whole message, or knowledge
 * text): start a thread there, save a note, or reply in a discussion the
 * selection overlaps. Agent and sharing actions stay visible but disabled
 * until their slices land (#1824 §0).
 */
import type { Component } from "solid-js";
import { createSignal, For, Show } from "solid-js";

import {
  FUTURE_ACTIONS,
  FutureActionRow,
} from "~/components/lore/FutureAction";
import { Button } from "~/components/ui/button";
import type { Discussion } from "~/contracts";
import type { SourceAnchor } from "~/reader/anchors";
import { toWireAnchor } from "~/reader/discussion-marks";
import { useWorkspace } from "~/routes/workspace";
import {
  newDiscussionDraftKey,
  type DiscussionSource,
} from "~/state/discussions";

import { Composer } from "./Composer";

/** Matches the server's `QUOTE_MAX`; the quote is the only copied text. */
export const QUOTE_MAX = 600;

const DISABLED_ACTIONS = FUTURE_ACTIONS.filter((name) => name !== "Save note");

export const SelectionActions: Component<{
  projectId: string;
  source: DiscussionSource;
  anchor: SourceAnchor;
  quote: string;
  overlapping: readonly Discussion[];
  onReplyIn: (d: Discussion) => void;
  onCreated: (d: Discussion) => void;
}> = (props) => {
  const ws = useWorkspace();
  const [composing, setComposing] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  async function create(kind: "discussion" | "note", body: string) {
    const d = await ws.state.discussions.create({
      projectId: props.projectId,
      kind,
      source: props.source,
      anchors: [toWireAnchor(props.anchor)],
      quote: props.quote.slice(0, QUOTE_MAX),
      ...(body ? { body } : {}),
    });
    setComposing(false);
    props.onCreated(d);
  }

  return (
    <div data-testid="selection-actions" class="mt-2">
      <Show when={props.overlapping.length > 0}>
        <div class="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted">
          <span>Already discussed here:</span>
          <For each={props.overlapping}>
            {(d) => (
              <Button
                size="sm"
                variant="outline"
                data-testid="reply-in-existing"
                onClick={() => props.onReplyIn(d)}
              >
                Reply in “{d.quote.slice(0, 40)}
                {d.quote.length > 40 ? "…" : ""}”
              </Button>
            )}
          </For>
        </div>
      </Show>
      <Show
        when={composing()}
        fallback={
          <div class="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              data-testid="start-thread"
              onClick={() => {
                setError(null);
                setComposing(true);
              }}
            >
              {props.overlapping.length > 0
                ? "Start independent thread"
                : "Start thread"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              data-testid="save-note"
              disabled={saving()}
              aria-busy={saving()}
              onClick={() => {
                if (saving()) return;
                setSaving(true);
                setError(null);
                create("note", "")
                  .catch((err: unknown) =>
                    setError(err instanceof Error ? err.message : String(err)),
                  )
                  .finally(() => setSaving(false));
              }}
            >
              Save note
            </Button>
          </div>
        }
      >
        <Composer
          draftKey={newDiscussionDraftKey(
            props.projectId,
            props.source,
            props.anchor,
          )}
          projectId={props.projectId}
          target={null}
          placeholder="Start a thread at this selection…"
          submitLabel="Start thread"
          autofocus
          testId="start-thread-composer"
          onSubmit={(text) => create("discussion", text)}
          onCancel={() => setComposing(false)}
        />
      </Show>
      <Show when={error()}>
        {(err) => (
          <p class="mt-1 text-xs text-danger" role="alert">
            {err()}
          </p>
        )}
      </Show>
      <FutureActionRow actions={DISABLED_ACTIONS} class="mt-2" />
    </div>
  );
};
