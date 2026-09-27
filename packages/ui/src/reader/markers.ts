/**
 * Transcript markers (#1924): thin interstitial notes the reader interleaves
 * into the message stream to say *what Lore did to the context* — knowledge
 * injections, durable prompt-delta updates, and gradient compactions. They
 * are built from `GET /sessions/:id/context`, never from message text, and
 * are rendered as labels, never as speech.
 *
 * A marker needs a trustworthy timestamp to sit inside the transcript;
 * events whose time is not recorded are left to the context-window pane's
 * timeline instead of being slotted somewhere plausible.
 */
import type { SessionContext } from "~/contracts";

export type MarkerKind = "injection" | "delta" | "compaction";

export interface MarkerBlock {
  kind: "marker";
  /** `k.injection.<created_at>` | `k.delta.<seq>` | `k.compaction.<message_id>` */
  id: string;
  marker: MarkerKind;
  createdAt: number;
  /** One-line summary, e.g. "Lore injected 3 knowledge entries". */
  title: string;
  /** One-line supporting detail, e.g. "Layer 2 · 18,400 raw → 6,100 sent". */
  detail: string;
  /** Entries the event names; linked in the marker row when `id` is set. */
  items: Array<{ id: string | null; label: string }>;
}

/** Thousands-separated integer for token counts in marker details. */
function tokens(value: number): string {
  return value.toLocaleString();
}

/**
 * Markers for one session-context answer, sorted by `createdAt` then `id`.
 * Injection batches share one `created_at` stamp (`recordSessionInjections`
 * stamps one `now` per batch) so identical stamps group into a single
 * marker. A prompt delta becomes a marker only when `applied_at` is known;
 * a compaction appears where the accepted gradient layer *increased* (or on
 * the first recorded turn when it already ran transformed, `layer >= 1`).
 */
export function buildMarkers(ctx: SessionContext): MarkerBlock[] {
  const markers: MarkerBlock[] = [];

  const injectionGroups = new Map<
    number,
    SessionContext["knowledge"]["injections"]
  >();
  for (const injection of ctx.knowledge.injections) {
    const group = injectionGroups.get(injection.created_at) ?? [];
    group.push(injection);
    injectionGroups.set(injection.created_at, group);
  }
  for (const [createdAt, group] of injectionGroups) {
    markers.push({
      kind: "marker",
      id: `k.injection.${createdAt}`,
      marker: "injection",
      createdAt,
      title:
        group.length === 1
          ? "Lore injected 1 knowledge entry"
          : `Lore injected ${group.length} knowledge entries`,
      detail: "",
      items: group.map((i) => ({
        id: i.title === null ? null : i.logical_id,
        label: i.title === null ? `${i.logical_id} (entry removed)` : i.title,
      })),
    });
  }

  for (const delta of ctx.prompt_deltas) {
    if (delta.applied_at === null) continue;
    const removed =
      delta.removed.length > 0 ? ` · ${delta.removed.length} removed` : "";
    markers.push({
      kind: "marker",
      id: `k.delta.${delta.seq}`,
      marker: "delta",
      createdAt: delta.applied_at,
      title: "Prompt knowledge updated",
      detail:
        delta.changed.length === 0 && delta.removed.length === 0
          ? "Prompt delta applied"
          : `${delta.changed.length} changed${removed}`,
      items: delta.changed.map((c) => ({ id: c.id, label: c.title ?? c.id })),
    });
  }

  let previous: number | null = null;
  for (const turn of [...ctx.turns].sort(
    (a, b) => a.created_at - b.created_at,
  )) {
    const compacted =
      previous === null ? turn.layer >= 1 : turn.layer > previous;
    if (compacted) {
      markers.push({
        kind: "marker",
        id: `k.compaction.${turn.message_id}`,
        marker: "compaction",
        createdAt: turn.created_at,
        title: "Context compacted",
        detail: `Layer ${turn.layer} · ${tokens(turn.raw_tokens)} raw → ${tokens(turn.total_tokens)} sent`,
        items: [],
      });
    }
    previous = turn.layer;
  }

  markers.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  return markers;
}
