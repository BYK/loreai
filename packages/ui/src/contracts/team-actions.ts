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
    add_by_id: teamActionAvailability,
    offline_invite: teamActionAvailability,
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

export const teamCreateReceipt = type({
  team: { id: "string", name: "string" },
});
export type TeamCreateReceipt = typeof teamCreateReceipt.infer;

export const teamAddReceipt = type({
  member: {
    user_id: "string",
    role: "'admin' | 'editor' | 'viewer'",
    wrapped: "boolean",
  },
});
export type TeamAddReceipt = typeof teamAddReceipt.infer;

export const teamAcceptReceipt = type({
  joined: {
    scope_id: "string",
    role: "string",
  },
});
export type TeamAcceptReceipt = typeof teamAcceptReceipt.infer;

export const teamDiscoveryResult = type({
  repos: type({
    repo: "string",
    contributors: type({
      login: "string",
      githubId: "number",
      onLore: "boolean",
    }).array(),
  }).array(),
  invited: type({
    scopeId: "string",
    role: "'editor' | 'viewer'",
    total: "number",
    emailed: "number",
    noEmail: "number",
    overCap: "number",
    results: type({
      login: "string",
      status:
        "'emailed' | 'no_email' | 'forbidden' | 'invite_failed' | 'send_failed' | 'skipped'",
      resolvedVia: "'lore_email' | 'github_public_email' | null",
      token: "string | undefined",
    }).array(),
  }).optional(),
});
export type TeamDiscoveryResult = typeof teamDiscoveryResult.infer;

export const organizationList = type({
  organizations: type({
    id: "string",
    name: "string | null",
    role: "string",
  }).array(),
});
export type OrganizationList = typeof organizationList.infer;

export const domainJoinRequestList = type({
  requests: type({
    id: "string",
    domain: "string",
    user_id: "string",
    status: "string",
    requested_at: "string",
  }).array(),
});
export type DomainJoinRequestList = typeof domainJoinRequestList.infer;

export const teamReviewPolicy = type({
  policy: "'required' | 'optional'",
});
export type TeamReviewPolicy = typeof teamReviewPolicy.infer;
