import "./config";
import { type } from "arktype";

export const teamRemote = type("'ok' | 'anonymous' | 'unreachable' | 'hosted'");

export const teamActionAvailability = type(
  "'available' | 'admin_only' | 'unavailable'",
);

export const teamMember = type({
  user_id: "string",
  label: "string | null",
  role: "string",
  me: "boolean",
});

export const teamMembersResponse = type({
  remote: teamRemote,
  team: type({ id: "string", name: "string | null" }).or("null"),
  my_role: "string | null",
  can_manage: "boolean",
  members: teamMember.array(),
  actions: {
    invite: teamActionAvailability,
    remove: teamActionAvailability,
    set_role: teamActionAvailability,
    add_by_id: "'cli_only'",
    offline_invite: "'cli_only'",
    list_invites: "'unsupported'",
    revoke_invite: "'unsupported'",
  },
});

export type TeamMembersResponse = typeof teamMembersResponse.infer;

export const teamInviteReceipt = type({
  invite: {
    team_id: "string",
    role: "'editor' | 'viewer'",
    expires_in_days: "14",
    token: "string",
    accept_command: "string",
    emailed: "boolean",
  },
});

export type TeamInviteReceipt = typeof teamInviteReceipt.infer;

export const teamRoleReceipt = type({
  member: {
    user_id: "string",
    role: "'admin' | 'editor' | 'viewer'",
  },
});

export type TeamRoleReceipt = typeof teamRoleReceipt.infer;

export const teamRemovalReceipt = type({
  removed: "string",
  new_epoch: "number.integer >= 1",
  rewrapped: "number.integer >= 0",
  skipped_count: "number.integer >= 0",
  unlinked_projects: "number.integer >= 0",
});

export type TeamRemovalReceipt = typeof teamRemovalReceipt.infer;
