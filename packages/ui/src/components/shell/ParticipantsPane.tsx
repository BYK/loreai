import type { Component } from "solid-js";
import { For } from "solid-js";

import { Avatar } from "~/components/lore/Avatar";

export interface Participant {
  id: string;
  kind: "user" | "agent" | "lore";
  label: string;
}

export const ParticipantsPane: Component<{
  participants: readonly Participant[];
}> = (props) => (
  <section aria-label="Participants" class="min-h-0 flex-1 overflow-y-auto">
    <For each={props.participants}>
      {(participant) => (
        <div
          class="flex items-center gap-2 px-3 py-1.5 text-sm"
          data-participant-kind={participant.kind}
        >
          <Avatar label={participant.label} />
          <span>{participant.label}</span>
        </div>
      )}
    </For>
    <p class="px-3 py-2 text-xs text-muted">Agents appear here as they act</p>
  </section>
);
