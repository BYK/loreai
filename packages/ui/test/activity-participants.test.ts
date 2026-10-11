import { describe, expect, it } from "vitest";

import type { ActivityItem } from "~/contracts";
import { deriveParticipants } from "~/state/activity-participants";

const item = (
  title: string,
  last_activity_at: number,
  participants: ActivityItem["participants"],
): ActivityItem => ({
  kind: "session",
  id: title,
  project_id: "project",
  project_name: "Lore",
  title,
  snippet: "",
  participants,
  last_activity_at,
  total: 1,
  match: "exact",
});

describe("deriveParticipants", () => {
  it("keeps You first and ranks participants by presence then last activity", () => {
    const participants = deriveParticipants(
      [
        item("Older", 1_000, [
          { id: "codex", kind: "agent", label: "Codex" },
          { id: "user", kind: "user", label: "You" },
        ]),
        item("Newest", 2_000, [
          { id: "codex", kind: "agent", label: "Codex" },
          { id: "lore", kind: "lore", label: "Lore" },
        ]),
        item("Offline", 0, [{ id: "pi", kind: "agent", label: "Pi" }]),
      ],
      602_000,
    );
    expect(participants.map(({ id }) => id)).toEqual([
      "user",
      "codex",
      "lore",
      "pi",
    ]);
    expect(participants[0]).toMatchObject({ label: "You" });
    expect(participants[1]).toMatchObject({
      last_seen: 2_000,
      status: "Lore · Newest",
      present: true,
    });
    expect(participants[3]?.present).toBe(false);
  });
});
