/**
 * Folk Lore (team sync) status routes — field-for-field copies of the
 * interfaces in `packages/gateway/src/folk-status.ts`, enums as picklists.
 */
import "./config";
import { type } from "arktype";

import { nonNegInt } from "./primitives";

export const accountState = type("'signed_in' | 'anonymous' | 'expired'");

export const accountStatus = type({
  signed_in: "boolean",
  user: type({
    id: "string",
    email: "string | null",
    display_name: "string | null",
  }).or("null"),
  provider: "string | null",
  /** ISO-8601 access-token expiry (this route reports ISO, not epoch ms). */
  expires_at: "string | null",
  state: accountState,
});

export type AccountStatus = typeof accountStatus.infer;

export const teamStatus = type({
  id: "string",
  name: "string | null",
  role: "string",
  member_count: nonNegInt,
});

export type TeamStatus = typeof teamStatus.infer;

/** `GET /api/v1/teams` wraps the rows in `{ teams: [...] }`. */
export const teamList = type({
  teams: teamStatus.array(),
});

export type TeamList = typeof teamList.infer;

export const promotionPolicy = type("'manual' | 'auto'");

export const sharingState = type(
  "'not_linked' | 'linked' | 'locked' | 'degraded'",
);

export const sharingStatus = type({
  linked: "boolean",
  team: type({
    id: "string",
    name: "string | null",
  }).or("null"),
  policy: type({
    effective: promotionPolicy,
    project_override: promotionPolicy.or("null"),
    team_default: promotionPolicy.or("null"),
  }),
  state: sharingState,
  detail: "string | null",
});

export type SharingStatus = typeof sharingStatus.infer;

export const syncState = type("'idle' | 'disabled'");

export const syncStatus = type({
  enabled: "boolean",
  state: syncState,
  pending_changes: nonNegInt.or("null"),
});

export type SyncStatus = typeof syncStatus.infer;
