import "./config";
import { type } from "arktype";

export const promotionRemote = type(
  "'ok' | 'anonymous' | 'unreachable' | 'hosted'",
);

export type PromotionRemote = typeof promotionRemote.infer;

export const promotionEligibilityReason = type(
  "'no_project' | 'not_linked' | 'already_shared' | 'restricted' | 'account_required' | 'encryption_locked'",
);

export const promotionRequestStatus = type(
  "'pending' | 'approved' | 'rejected' | 'withdrawn'",
);

export const promotionRequest = type({
  id: "string",
  team: { id: "string", name: "string | null" },
  logical_id: "string",
  entry_version_id: "string",
  entry_version: "number.integer >= 1",
  category: "string",
  title: "string | null",
  content: "string | null",
  sealed: "boolean",
  proposer: { id: "string", label: "string | null" },
  mine: "boolean",
  status: promotionRequestStatus,
  decided_by: type({ id: "string", label: "string" }).or("null"),
  decided_at: "string | null",
  decision_note: "string | null",
  applied: "'applied' | 'stale' | null",
  applied_at: "string | null",
  created_at: "string",
  can_decide: "boolean",
  decide_blocked_reason: "'own_proposal' | 'not_admin' | 'decided' | null",
});

export type PromotionRequest = typeof promotionRequest.infer;

export const promotionReceipt = type({ request: promotionRequest });
export type PromotionReceipt = typeof promotionReceipt.infer;

export const promotionPreview = type({
  entry: {
    id: "string",
    version_id: "string",
    version: "number.integer >= 1",
    title: "string",
    content: "string",
    category: "string",
    project_id: "string | null",
    sensitivity: "string | null",
    approval_status: "string | null",
  },
  team: type({ id: "string", name: "string | null" }).or("null"),
  policy: {
    effective: "'manual' | 'auto'",
    project_override: "'manual' | 'auto' | null",
    team_default: "'manual' | 'auto' | null",
  },
  eligibility: {
    promotable: "boolean",
    reason: promotionEligibilityReason.or("null"),
  },
  previous_team_version: type({
    version_id: "string",
    version: "number.integer >= 1",
    title: "string",
    content: "string",
  }).or("null"),
  pending_request: promotionRequest.or("null"),
  remote: promotionRemote,
});

export type PromotionPreview = typeof promotionPreview.infer;

export const promotionListResponse = type({
  remote: promotionRemote,
  requests: promotionRequest.array(),
  complete: "boolean",
});

export type PromotionListResponse = typeof promotionListResponse.infer;
