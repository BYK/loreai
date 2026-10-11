import type { Component } from "solid-js";
import { createMemo, createSignal, For, Show } from "solid-js";

import { Avatar } from "~/components/lore/Avatar";

export interface Participant {
  id: string;
  kind: "user" | "agent" | "lore";
  label: string;
  last_seen?: number;
  status?: string;
  present?: boolean;
}

export const ParticipantsPane: Component<{
  participants: readonly Participant[];
  onSelectParticipant?: (participant: Participant) => void;
}> = (props) => {
  const [query, setQuery] = createSignal("");
  const filtered = createMemo(() => {
    const value = query().trim().toLowerCase();
    if (!value) return props.participants;
    return props.participants.filter(
      (participant) =>
        participant.label.toLowerCase().includes(value) ||
        participant.id.toLowerCase().includes(value),
    );
  });
  return (
    <section aria-label="Participants" class="min-h-0 flex-1 overflow-y-auto">
      <label class="mx-2 mb-2 flex h-8 items-center rounded-md border border-hairline px-2">
        <span class="sr-only">Search participants</span>
        <input
          type="search"
          aria-label="Search participants"
          placeholder="Find participant"
          class="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted"
          value={query()}
          onInput={(event) => setQuery(event.currentTarget.value)}
        />
      </label>
      <For each={filtered()}>
        {(participant) => (
          <button
            type="button"
            class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-soft"
            data-participant-kind={participant.kind}
            data-testid="workspace-participant"
            onClick={() => props.onSelectParticipant?.(participant)}
          >
            <span class="relative">
              <Avatar label={participant.label.slice(0, 1)} />
              <Show when={participant.present}>
                <span class="absolute -right-0.5 -bottom-0.5 size-2 rounded-full bg-pastel-sage ring-1 ring-surface" />
              </Show>
            </span>
            <span class="min-w-0 flex-1">
              <span class="block truncate">{participant.label}</span>
              <Show when={participant.status}>
                <span class="block truncate text-[10px] text-muted">
                  {participant.status}
                </span>
              </Show>
            </span>
          </button>
        )}
      </For>
      <p class="px-3 py-2 text-xs text-muted">Agents appear here as they act</p>
    </section>
  );
};
