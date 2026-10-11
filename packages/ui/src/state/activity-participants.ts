import type { ActivityItem } from "~/contracts";

import type { Participant } from "~/components/shell/ParticipantsPane";

const PRESENCE_WINDOW = 10 * 60 * 1000;

export function deriveParticipants(
  items: readonly ActivityItem[],
  now: number,
): Participant[] {
  const latest = new Map<
    string,
    {
      id: string;
      kind: "agent" | "lore";
      label: string;
      last_seen: number;
      status: string;
    }
  >();
  for (const item of items) {
    for (const participant of item.participants) {
      if (participant.kind === "user" || participant.id === "user") continue;
      const previous = latest.get(participant.id);
      if (!previous || item.last_activity_at > previous.last_seen) {
        latest.set(participant.id, {
          id: participant.id,
          kind: participant.kind,
          label: participant.label,
          last_seen: item.last_activity_at,
          status: `${item.project_name} · ${item.title}`,
        });
      }
    }
  }
  const rest = [...latest.values()]
    .map((participant) => ({
      ...participant,
      present: now - participant.last_seen <= PRESENCE_WINDOW,
    }))
    .sort(
      (a, b) =>
        Number(b.present) - Number(a.present) ||
        b.last_seen - a.last_seen ||
        a.label.localeCompare(b.label),
    );
  return [{ id: "user", kind: "user", label: "You" }, ...rest];
}
