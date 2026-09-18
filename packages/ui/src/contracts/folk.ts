/**
 * Folk Lore (team sync) status routes — field-for-field copies of the
 * interfaces in `packages/gateway/src/folk-status.ts`, enums as picklists.
 */
import * as v from "valibot";

import { nonNegInt } from "./primitives";

export const accountState = v.picklist(["signed_in", "anonymous", "expired"]);

export const accountStatus = v.looseObject({
  signed_in: v.boolean(),
  user: v.nullable(
    v.looseObject({
      id: v.string(),
      email: v.nullable(v.string()),
      display_name: v.nullable(v.string()),
    }),
  ),
  provider: v.nullable(v.string()),
  /** ISO-8601 access-token expiry (this route reports ISO, not epoch ms). */
  expires_at: v.nullable(v.string()),
  state: accountState,
});

export type AccountStatus = v.InferOutput<typeof accountStatus>;

export const teamStatus = v.looseObject({
  id: v.string(),
  name: v.nullable(v.string()),
  role: v.string(),
  member_count: nonNegInt,
});

export type TeamStatus = v.InferOutput<typeof teamStatus>;

/** `GET /api/v1/teams` wraps the rows in `{ teams: [...] }`. */
export const teamList = v.looseObject({
  teams: v.array(teamStatus),
});

export type TeamList = v.InferOutput<typeof teamList>;

export const promotionPolicy = v.picklist(["manual", "auto"]);

export const sharingState = v.picklist([
  "not_linked",
  "linked",
  "locked",
  "degraded",
]);

export const sharingStatus = v.looseObject({
  linked: v.boolean(),
  team: v.nullable(
    v.looseObject({
      id: v.string(),
      name: v.nullable(v.string()),
    }),
  ),
  policy: v.looseObject({
    effective: promotionPolicy,
    project_override: v.nullable(promotionPolicy),
    team_default: v.nullable(promotionPolicy),
  }),
  state: sharingState,
  detail: v.nullable(v.string()),
});

export type SharingStatus = v.InferOutput<typeof sharingStatus>;

export const syncState = v.picklist(["idle", "disabled"]);

export const syncStatus = v.looseObject({
  enabled: v.boolean(),
  state: syncState,
  pending_changes: v.nullable(nonNegInt),
});

export type SyncStatus = v.InferOutput<typeof syncStatus>;
