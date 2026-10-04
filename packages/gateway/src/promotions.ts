import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  crypto,
  effectivePromotionPolicy,
  keystore,
  log,
  ltm,
} from "@loreai/core";
import { loadConfig, type GatewayConfig } from "./config";
import {
  accessFor,
  errorResponse,
  hostedRefusal,
  json,
  localIdentityLabel,
  readObjectBody,
  requestIsHosted,
  routeId,
  UUID,
} from "./folk-access";
import type { Access, RemoteStatus } from "./folk-access";
import { sharingStatus, type SharingPolicy } from "./folk-status";
import { getCurrentUser } from "./supabase";
import {
  identityLabel,
  listTeams,
  teamMemberProfiles,
  teamMembers,
} from "./team";
import { makeEncryptionResolver, openString, sealString } from "./sync";
type DecisionStatus = "approved" | "rejected";
type RequestStatus = "pending" | DecisionStatus | "withdrawn";
type AppliedStatus = "applied" | "stale";
type PromotionServiceFailure = {
  ok: false;
  status: number;
  code: string;
  message: string;
  extra?: Record<string, unknown>;
};
export type PromotionServiceResult<T> =
  | { ok: true; value: T }
  | PromotionServiceFailure;

type PromotionRow = {
  id: string;
  scope_id: string;
  logical_id: string;
  entry_version_id: string;
  entry_version: number;
  category: string;
  title_enc: string;
  content_enc: string;
  proposer_id: string;
  status: RequestStatus;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  applied: AppliedStatus | null;
  applied_at: string | null;
  created_at: string;
};

export interface PromotionRequest {
  id: string;
  team: { id: string; name: string | null };
  logical_id: string;
  entry_version_id: string;
  entry_version: number;
  category: string;
  title: string | null;
  content: string | null;
  sealed: boolean;
  proposer: { id: string; label: string | null };
  mine: boolean;
  status: RequestStatus;
  decided_by: { id: string; label: string | null } | null;
  decided_at: string | null;
  decision_note: string | null;
  applied: AppliedStatus | null;
  applied_at: string | null;
  created_at: string;
  can_decide: boolean;
  decide_blocked_reason: "own_proposal" | "not_admin" | "decided" | null;
}

type TeamPresentation = {
  name: string | null;
  role: string | null;
  labels: Map<string, string | null>;
};

function serviceFailure(
  status: number,
  code: string,
  message: string,
  extra?: Record<string, unknown>,
): PromotionServiceFailure {
  return { ok: false, status, code, message, ...(extra ? { extra } : {}) };
}

function resultResponse(result: PromotionServiceFailure): Response {
  return errorResponse(
    result.status,
    result.code,
    result.message,
    result.extra,
  );
}

function postgresError(error: {
  code?: string;
  message?: string;
}): PromotionServiceFailure {
  const message = error.message ?? "Promotion request failed";
  switch (error.code) {
    case "P0002":
      return serviceFailure(404, "not_found", message);
    case "42501":
      return serviceFailure(403, "forbidden", message);
    case "55000":
      return serviceFailure(409, "already_decided", message);
    case "23505":
      return serviceFailure(409, "already_pending", message);
    case "22023":
    case "22001":
      return serviceFailure(400, "invalid_request", message);
    default:
      return serviceFailure(502, "remote_unreachable", message);
  }
}

function eligibility(
  candidate: NonNullable<ReturnType<typeof ltm.teamPromotionCandidate>>,
  remote: RemoteStatus,
  hasTeamContext: boolean,
): {
  promotable: boolean;
  reason:
    | null
    | "no_project"
    | "not_linked"
    | "already_shared"
    | "restricted"
    | "hosted"
    | "account_required"
    | "remote_unavailable"
    | "encryption_locked";
} {
  if (candidate.projectId === null)
    return { promotable: false, reason: "no_project" };
  if (candidate.scopeId === null)
    return { promotable: false, reason: "not_linked" };
  if (candidate.approvalStatus === "approved")
    return { promotable: false, reason: "already_shared" };
  if (candidate.sensitivity === "restricted")
    return { promotable: false, reason: "restricted" };
  if (remote === "hosted") return { promotable: false, reason: "hosted" };
  if (remote === "anonymous")
    return { promotable: false, reason: "account_required" };
  if (remote === "unreachable")
    return { promotable: false, reason: "remote_unavailable" };
  if (keystore.encryptionState() !== "on" || !hasTeamContext)
    return { promotable: false, reason: "encryption_locked" };
  return { promotable: true, reason: null };
}

function sharingPolicy(
  config: GatewayConfig,
  projectId: string | null,
): {
  team: { id: string; name: string | null } | null;
  policy: SharingPolicy;
} {
  if (projectId) {
    const status = sharingStatus(config, projectId);
    if (status) return { team: status.team, policy: status.policy };
  }
  return {
    team: null,
    policy: {
      effective: "manual",
      project_override: null,
      team_default: null,
    },
  };
}

async function teamPresentations(
  client: SupabaseClient,
  me: string,
  rows: PromotionRow[],
): Promise<Map<string, TeamPresentation>> {
  let teams: Awaited<ReturnType<typeof listTeams>> = [];
  try {
    teams = await listTeams(client);
  } catch {
    teams = [];
  }
  const scopes = [...new Set(rows.map((row) => row.scope_id))];
  const presentations = new Map<string, TeamPresentation>();
  await Promise.all(
    scopes.map(async (scopeId) => {
      const team = teams.find((item) => item.scopeId === scopeId);
      let members: Awaited<ReturnType<typeof teamMembers>> = [];
      try {
        members = await teamMembers(client, scopeId);
      } catch {
        members = [];
      }
      let profiles: Awaited<ReturnType<typeof teamMemberProfiles>> = [];
      let profileLookupFailed = false;
      try {
        profiles = await teamMemberProfiles(client, scopeId);
      } catch {
        profileLookupFailed = true;
      }
      const role =
        members.find((member) => member.userId === me)?.role ??
        team?.role ??
        null;
      const profilesByUser = new Map(
        profiles.map((profile) => [profile.user_id, profile]),
      );
      const labels = new Map(
        members.map((member) => {
          const profile = profilesByUser.get(member.userId);
          return [
            member.userId,
            profile
              ? identityLabel(profile)
              : profileLookupFailed && member.userId === me
                ? localIdentityLabel(me)
                : null,
          ] as const;
        }),
      );
      if (!labels.has(me) && profileLookupFailed)
        labels.set(me, localIdentityLabel(me));
      presentations.set(scopeId, {
        name: team?.name || null,
        role,
        labels,
      });
    }),
  );
  return presentations;
}

async function shapeRequest(
  row: PromotionRow,
  me: string,
  presentation: TeamPresentation,
  resolver: ReturnType<typeof makeEncryptionResolver>,
): Promise<PromotionRequest> {
  let title: string | null = null;
  let content: string | null = null;
  let sealed = true;
  if (keystore.encryptionState() === "on") {
    const ctx = await resolver.ctxForScope(row.scope_id);
    if (ctx) {
      try {
        title = openString(
          ctx,
          crypto.buildAad(row.scope_id, "promotion_requests", "title", row.id),
          row.title_enc,
        );
        content = openString(
          ctx,
          crypto.buildAad(
            row.scope_id,
            "promotion_requests",
            "content",
            row.id,
          ),
          row.content_enc,
        );
        sealed = false;
      } catch {
        title = null;
        content = null;
      }
    }
  }
  const mine = row.proposer_id === me;
  const canDecide = row.status === "pending" && presentation.role === "admin";
  const blockedReason =
    row.status !== "pending"
      ? "decided"
      : presentation.role !== "admin"
        ? "not_admin"
        : null;
  return {
    id: row.id,
    team: { id: row.scope_id, name: presentation.name },
    logical_id: row.logical_id,
    entry_version_id: row.entry_version_id,
    entry_version: row.entry_version,
    category: row.category,
    title,
    content,
    sealed,
    proposer: {
      id: row.proposer_id,
      label: presentation.labels.get(row.proposer_id) ?? null,
    },
    mine,
    status: row.status,
    decided_by: row.decided_by
      ? {
          id: row.decided_by,
          label: presentation.labels.get(row.decided_by) ?? null,
        }
      : null,
    decided_at: row.decided_at,
    decision_note: row.decision_note,
    applied: row.applied,
    applied_at: row.applied_at,
    created_at: row.created_at,
    can_decide: canDecide,
    decide_blocked_reason: blockedReason,
  };
}

function isResponse(value: unknown): value is Response {
  return value instanceof Response;
}

async function getPreview(
  id: string,
  config: GatewayConfig,
): Promise<Response> {
  const candidate = ltm.teamPromotionCandidate(id);
  if (!candidate)
    return errorResponse(404, "not_found", "Knowledge entry not found");
  const access = await accessFor(config);
  const resolver = makeEncryptionResolver();
  const ctx =
    candidate.scopeId &&
    access.remote === "ok" &&
    keystore.encryptionState() === "on"
      ? await resolver.ctxForScope(candidate.scopeId)
      : null;
  const policy = sharingPolicy(config, candidate.projectId);

  // Knowledge has no branch-scoped field; metadata.gitHead is not a promotion gate.
  const entry = {
    id: candidate.logicalId,
    version_id: candidate.versionId,
    version: candidate.version,
    title: candidate.title,
    content: candidate.content,
    category: candidate.category,
    project_id: candidate.projectId,
    sensitivity: candidate.sensitivity,
    approval_status: candidate.approvalStatus,
  };
  const previous = candidate.previousTeamVersion
    ? {
        version_id: candidate.previousTeamVersion.versionId,
        version: candidate.previousTeamVersion.version,
        title: candidate.previousTeamVersion.title,
        content: candidate.previousTeamVersion.content,
      }
    : null;

  let pendingRequest: PromotionRequest | null = null;
  let remote = access.remote;
  if (access.client && candidate.scopeId) {
    const { data, error } = await access.client
      .from("promotion_requests")
      .select("*")
      .eq("scope_id", candidate.scopeId)
      .eq("logical_id", candidate.logicalId)
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) {
      remote = "unreachable";
    } else if (data?.length) {
      const row = data[0] as PromotionRow;
      try {
        const presentation = (
          await teamPresentations(access.client, access.me!, [row])
        ).get(row.scope_id) ?? { name: null, role: null, labels: new Map() };
        pendingRequest = await shapeRequest(
          row,
          access.me!,
          presentation,
          resolver,
        );
      } catch {
        remote = "unreachable";
      }
    }
  }
  return json({
    entry,
    team: policy.team,
    policy: policy.policy,
    eligibility: eligibility(candidate, remote, ctx !== null),
    previous_team_version: previous,
    pending_request: pendingRequest,
    remote,
  });
}

async function proposeCandidate(
  candidate: NonNullable<ReturnType<typeof ltm.teamPromotionCandidate>>,
  expectedVersionId: string,
  access: Access,
): Promise<PromotionServiceResult<{ request: PromotionRequest }>> {
  const resolver = makeEncryptionResolver();
  const ctx =
    candidate.scopeId &&
    access.remote === "ok" &&
    keystore.encryptionState() === "on"
      ? await resolver.ctxForScope(candidate.scopeId)
      : null;
  const eligibilityResult = eligibility(candidate, access.remote, ctx !== null);
  if (!eligibilityResult.promotable) {
    const reason = eligibilityResult.reason;
    if (reason === "remote_unavailable") {
      return serviceFailure(
        503,
        "remote_unreachable",
        "Lore cloud could not be reached. Try again later.",
        { reason },
      );
    }
    const status =
      reason === "account_required" || reason === "encryption_locked"
        ? 409
        : 422;
    return serviceFailure(
      status,
      reason === "account_required" || reason === "encryption_locked"
        ? reason
        : "not_promotable",
      "Knowledge entry cannot be proposed",
      { reason },
    );
  }
  if (expectedVersionId !== candidate.versionId) {
    return serviceFailure(
      409,
      "stale_version",
      "Knowledge entry changed; reload the preview",
      {
        current_version_id: candidate.versionId,
      },
    );
  }
  if (!access.client || !access.me || !candidate.scopeId || !ctx) {
    return serviceFailure(
      503,
      "remote_unreachable",
      "Promotion service is unavailable",
    );
  }

  const requestId = randomUUID();
  const titleEnc = sealString(
    ctx,
    crypto.buildAad(
      candidate.scopeId,
      "promotion_requests",
      "title",
      requestId,
    ),
    candidate.title,
  );
  const contentEnc = sealString(
    ctx,
    crypto.buildAad(
      candidate.scopeId,
      "promotion_requests",
      "content",
      requestId,
    ),
    candidate.content,
  );
  let data: unknown;
  let rpcError: { code?: string; message?: string } | null;
  try {
    const result = await access.client.rpc("propose_promotion", {
      p_id: requestId,
      p_scope: candidate.scopeId,
      p_logical_id: candidate.logicalId,
      p_entry_version_id: candidate.versionId,
      p_entry_version: candidate.version,
      p_category: candidate.category,
      p_title_enc: titleEnc,
      p_content_enc: contentEnc,
    });
    data = result.data;
    rpcError = result.error;
  } catch {
    return serviceFailure(
      502,
      "remote_unreachable",
      "Could not submit promotion request",
    );
  }
  if (rpcError) return postgresError(rpcError);
  const raw = Array.isArray(data) ? data[0] : data;
  if (!raw)
    return serviceFailure(
      502,
      "remote_unreachable",
      "Promotion service returned no receipt",
    );
  try {
    const row = raw as PromotionRow;
    const presentation = (
      await teamPresentations(access.client, access.me, [row])
    ).get(row.scope_id) ?? { name: null, role: null, labels: new Map() };
    return {
      ok: true,
      value: {
        request: await shapeRequest(row, access.me, presentation, resolver),
      },
    };
  } catch {
    return serviceFailure(
      502,
      "remote_unreachable",
      "Could not read promotion receipt",
    );
  }
}

export async function proposePromotionService(
  logicalId: string,
  expectedVersionId: string,
  config: GatewayConfig = loadConfig(),
): Promise<PromotionServiceResult<{ request: PromotionRequest }>> {
  if (requestIsHosted(config))
    return serviceFailure(
      403,
      "forbidden",
      "Knowledge promotions are not available in hosted mode.",
    );
  const candidate = ltm.teamPromotionCandidate(logicalId);
  if (!candidate)
    return serviceFailure(404, "not_found", "Knowledge entry not found");
  try {
    return await proposeCandidate(
      candidate,
      expectedVersionId,
      await accessFor(config),
    );
  } catch {
    return serviceFailure(
      502,
      "remote_unreachable",
      "Could not submit promotion request",
    );
  }
}

export async function autoProposePending(
  client: SupabaseClient,
  config?: GatewayConfig,
): Promise<void> {
  try {
    const gatewayConfig = config ?? loadConfig();
    if (requestIsHosted(gatewayConfig) || keystore.encryptionState() !== "on")
      return;
    const user = await getCurrentUser();
    if (!user) return;
    const candidates = ltm
      .listPendingTeamPromotions()
      .map((item) => ltm.teamPromotionCandidate(item.logicalId))
      .filter(
        (
          candidate,
        ): candidate is NonNullable<
          ReturnType<typeof ltm.teamPromotionCandidate>
        > =>
          candidate !== null &&
          candidate.approvalStatus === "pending" &&
          candidate.projectId !== null &&
          candidate.scopeId !== null &&
          effectivePromotionPolicy(candidate.projectId) === "auto" &&
          eligibility(candidate, "ok", true).promotable,
      );
    if (candidates.length === 0) return;
    const { data, error } = await client
      .from("promotion_requests")
      .select("logical_id,entry_version_id,status")
      .eq("proposer_id", user.user_id)
      .in("logical_id", [
        ...new Set(candidates.map((candidate) => candidate.logicalId)),
      ]);
    if (error) {
      log.notice("sync: auto-proposal request lookup failed");
      return;
    }
    const requests = (data ?? []) as Array<{
      logical_id: string;
      entry_version_id: string;
      status: RequestStatus;
    }>;
    for (const candidate of candidates) {
      const matching = requests.filter(
        (request) => request.logical_id === candidate.logicalId,
      );
      if (
        matching.some(
          (request) => request.entry_version_id === candidate.versionId,
        ) ||
        matching.some((request) => request.status === "pending")
      ) {
        continue;
      }
      try {
        const result = await proposeCandidate(candidate, candidate.versionId, {
          remote: "ok",
          client,
          me: user.user_id,
        });
        if (!result.ok) log.notice("sync: automatic promotion proposal failed");
      } catch {
        log.notice("sync: automatic promotion proposal failed");
      }
    }
  } catch {
    log.notice("sync: auto-propose lookup failed");
  }
}

export async function listPromotionRequestsService(
  teamId: string | null,
  status: string = "pending",
  config: GatewayConfig = loadConfig(),
): Promise<
  PromotionServiceResult<{
    remote: RemoteStatus;
    requests: PromotionRequest[];
    complete: boolean;
  }>
> {
  if (teamId !== null && !UUID.test(teamId)) {
    return serviceFailure(400, "invalid_request", "team must be a UUID");
  }
  const access = await accessFor(config);
  if (teamId === null && access.remote !== "ok") {
    return {
      ok: true,
      value: { remote: access.remote, requests: [], complete: true },
    };
  }
  if (status !== "pending" && status !== "decided" && status !== "all") {
    return serviceFailure(
      400,
      "invalid_request",
      "status must be pending, decided, or all",
    );
  }
  if (teamId === null) {
    return serviceFailure(400, "invalid_request", "team is required");
  }
  if (!access.client || !access.me) {
    return {
      ok: true,
      value: { remote: access.remote, requests: [], complete: true },
    };
  }
  let query = access.client
    .from("promotion_requests")
    .select("*")
    .eq("scope_id", teamId)
    .order("created_at", { ascending: false })
    .limit(101);
  if (status === "pending") query = query.eq("status", "pending");
  if (status === "decided")
    query = query.in("status", ["approved", "rejected", "withdrawn"]);
  let rows: PromotionRow[];
  try {
    const { data, error } = await query;
    if (error) {
      return {
        ok: true,
        value: { remote: "unreachable", requests: [], complete: true },
      };
    }
    rows = (data ?? []) as PromotionRow[];
  } catch {
    return {
      ok: true,
      value: { remote: "unreachable", requests: [], complete: true },
    };
  }
  const complete = rows.length <= 100;
  const visible = rows.slice(0, 100);
  try {
    const presentations = await teamPresentations(
      access.client,
      access.me,
      visible,
    );
    const resolver = makeEncryptionResolver();
    const requests = await Promise.all(
      visible.map((row) =>
        shapeRequest(
          row,
          access.me!,
          presentations.get(row.scope_id) ?? {
            name: null,
            role: null,
            labels: new Map(),
          },
          resolver,
        ),
      ),
    );
    return { ok: true, value: { remote: "ok", requests, complete } };
  } catch {
    return {
      ok: true,
      value: { remote: "unreachable", requests: [], complete: true },
    };
  }
}

async function shapeReceipt(
  data: unknown,
  access: Access,
): Promise<PromotionServiceResult<{ request: PromotionRequest }>> {
  const raw = Array.isArray(data) ? data[0] : data;
  if (!raw)
    return serviceFailure(
      502,
      "remote_unreachable",
      "Promotion service returned no receipt",
    );
  if (!access.client || !access.me)
    return serviceFailure(
      403,
      "forbidden",
      "Sign in with lore login to review promotions.",
    );
  try {
    const row = raw as PromotionRow;
    const presentation = (
      await teamPresentations(access.client, access.me, [row])
    ).get(row.scope_id) ?? { name: null, role: null, labels: new Map() };
    return {
      ok: true,
      value: {
        request: await shapeRequest(
          row,
          access.me,
          presentation,
          makeEncryptionResolver(),
        ),
      },
    };
  } catch {
    return serviceFailure(
      502,
      "remote_unreachable",
      "Could not read promotion receipt",
    );
  }
}

export async function decidePromotionService(
  id: string,
  decision: "approve" | "reject",
  note?: string,
  config: GatewayConfig = loadConfig(),
): Promise<PromotionServiceResult<{ request: PromotionRequest }>> {
  if (requestIsHosted(config))
    return serviceFailure(
      403,
      "forbidden",
      "Knowledge promotions are not available in hosted mode.",
    );
  if (note !== undefined && note.length > 500)
    return serviceFailure(
      400,
      "invalid_request",
      "note must be at most 500 characters",
    );
  const access = await accessFor(config);
  if (!access.client || !access.me)
    return serviceFailure(
      403,
      "forbidden",
      "Sign in with lore login to review promotions.",
    );
  let data: unknown;
  let rpcError: { code?: string; message?: string } | null;
  try {
    const result = await access.client.rpc("decide_promotion", {
      p_id: id,
      p_decision: decision === "approve" ? "approved" : "rejected",
      p_note: note ?? null,
    });
    data = result.data;
    rpcError = result.error;
  } catch {
    return serviceFailure(
      502,
      "remote_unreachable",
      "Could not update promotion request",
    );
  }
  if (rpcError) return postgresError(rpcError);
  return shapeReceipt(data, access);
}

export async function withdrawPromotionService(
  id: string,
  config: GatewayConfig = loadConfig(),
): Promise<PromotionServiceResult<{ request: PromotionRequest }>> {
  if (requestIsHosted(config))
    return serviceFailure(
      403,
      "forbidden",
      "Knowledge promotions are not available in hosted mode.",
    );
  const access = await accessFor(config);
  if (!access.client || !access.me)
    return serviceFailure(
      403,
      "forbidden",
      "Sign in with lore login to review promotions.",
    );
  let data: unknown;
  let rpcError: { code?: string; message?: string } | null;
  try {
    const result = await access.client.rpc("withdraw_promotion", { p_id: id });
    data = result.data;
    rpcError = result.error;
  } catch {
    return serviceFailure(
      502,
      "remote_unreachable",
      "Could not withdraw promotion request",
    );
  }
  if (rpcError) return postgresError(rpcError);
  return shapeReceipt(data, access);
}

export async function setTeamReviewPolicyService(
  scopeId: string,
  policy: "manual" | "auto",
  expected: "manual" | "auto",
  config: GatewayConfig = loadConfig(),
): Promise<PromotionServiceResult<{ policy: "manual" | "auto" }>> {
  if (requestIsHosted(config))
    return serviceFailure(
      403,
      "forbidden",
      "Knowledge promotions are not available in hosted mode.",
    );
  if (!UUID.test(scopeId))
    return serviceFailure(400, "invalid_request", "team must be a UUID");
  if (policy !== "manual" && policy !== "auto")
    return serviceFailure(
      400,
      "invalid_request",
      "policy must be manual or auto",
    );
  if (expected !== "manual" && expected !== "auto")
    return serviceFailure(
      400,
      "invalid_request",
      "expected_policy must be manual or auto",
    );
  const access = await accessFor(config);
  if (!access.client || !access.me)
    return serviceFailure(
      403,
      "forbidden",
      "Sign in with lore login to change team review policy.",
    );
  let data: unknown;
  let error: { code?: string; message?: string } | null;
  try {
    const result = await access.client.rpc("set_team_promotion_policy", {
      p_scope: scopeId,
      p_policy: policy,
      p_expected: expected,
    });
    data = result.data;
    error = result.error;
  } catch {
    return serviceFailure(
      502,
      "remote_unreachable",
      "Could not update team review policy",
    );
  }
  if (error?.code === "40001") {
    let current: { promotion_policy: "manual" | "auto" | null } | null;
    try {
      const result = await access.client
        .from("scopes")
        .select("promotion_policy")
        .eq("id", scopeId)
        .maybeSingle();
      if (result.error) {
        return serviceFailure(
          502,
          "remote_unreachable",
          "Could not read current team review policy",
        );
      }
      current = result.data;
    } catch {
      return serviceFailure(
        502,
        "remote_unreachable",
        "Could not read current team review policy",
      );
    }
    return serviceFailure(
      409,
      "stale_policy",
      "Team review policy changed; reload and try again.",
      {
        current_policy: current?.promotion_policy ?? "manual",
      },
    );
  }
  if (error) return postgresError(error);
  if (data !== "manual" && data !== "auto") {
    return serviceFailure(
      502,
      "remote_unreachable",
      "Team review policy returned no receipt",
    );
  }
  return {
    ok: true,
    value: { policy: data },
  };
}

async function promote(
  req: Request,
  id: string,
  config: GatewayConfig,
): Promise<Response> {
  if (requestIsHosted(config))
    return hostedRefusal(
      "Knowledge promotions are not available in hosted mode.",
    );
  const body = await readObjectBody(req);
  if (isResponse(body)) return body;
  if (typeof body.version_id !== "string") {
    return errorResponse(400, "invalid_request", "version_id must be a string");
  }
  if (Object.keys(body).some((key) => key !== "version_id")) {
    return errorResponse(400, "invalid_request", "Only version_id is accepted");
  }
  const result = await proposePromotionService(id, body.version_id, config);
  return result.ok ? json(result.value, 201) : resultResponse(result);
}

async function listPromotions(
  url: URL,
  config: GatewayConfig,
): Promise<Response> {
  const result = await listPromotionRequestsService(
    url.searchParams.get("team"),
    url.searchParams.get("status") ?? "pending",
    config,
  );
  return result.ok ? json(result.value) : resultResponse(result);
}

async function review(
  req: Request,
  id: string,
  decision: "approve" | "reject" | "withdraw",
  config: GatewayConfig,
): Promise<Response> {
  if (requestIsHosted(config))
    return hostedRefusal(
      "Knowledge promotions are not available in hosted mode.",
    );
  const body = await readObjectBody(req);
  if (isResponse(body)) return body;
  let result: PromotionServiceResult<{ request: PromotionRequest }>;
  if (decision !== "withdraw") {
    if (Object.keys(body).some((key) => key !== "note")) {
      return errorResponse(400, "invalid_request", "Only note is accepted");
    }
    if (body.note !== undefined && typeof body.note !== "string") {
      return errorResponse(400, "invalid_request", "note must be a string");
    }
    if (typeof body.note === "string" && body.note.length > 500) {
      return errorResponse(
        400,
        "invalid_request",
        "note must be at most 500 characters",
      );
    }
    result = await decidePromotionService(id, decision, body.note, config);
  } else {
    if (Object.keys(body).length > 0) {
      return errorResponse(
        400,
        "invalid_request",
        "Withdraw does not accept fields",
      );
    }
    result = await withdrawPromotionService(id, config);
  }
  return result.ok ? json(result.value) : resultResponse(result);
}

async function setTeamReviewPolicy(
  req: Request,
  scopeId: string,
  config: GatewayConfig,
): Promise<Response> {
  if (requestIsHosted(config))
    return hostedRefusal(
      "Knowledge promotions are not available in hosted mode.",
    );
  const body = await readObjectBody(req);
  if (isResponse(body)) return body;
  if (
    Object.keys(body).some(
      (key) => key !== "policy" && key !== "expected_policy",
    )
  ) {
    return errorResponse(
      400,
      "invalid_request",
      "Only policy and expected_policy are accepted",
    );
  }
  if (
    (body.policy !== "manual" && body.policy !== "auto") ||
    (body.expected_policy !== "manual" && body.expected_policy !== "auto")
  ) {
    return errorResponse(
      400,
      "invalid_request",
      "policy and expected_policy must be manual or auto",
    );
  }
  const result = await setTeamReviewPolicyService(
    scopeId,
    body.policy,
    body.expected_policy,
    config,
  );
  return result.ok ? json(result.value) : resultResponse(result);
}

export async function handlePromotionRequest(
  req: Request,
  url: URL,
  config: GatewayConfig,
): Promise<Response | null> {
  const path = url.pathname;
  let match: RegExpExecArray | null;
  if (req.method === "PUT") {
    match = /^\/api\/v1\/teams\/([^/]+)\/review-policy$/.exec(path);
    if (match) {
      let scopeId: string;
      try {
        scopeId = decodeURIComponent(match[1]);
      } catch {
        return errorResponse(400, "invalid_request", "team must be a UUID");
      }
      if (!UUID.test(scopeId))
        return errorResponse(400, "invalid_request", "team must be a UUID");
      return setTeamReviewPolicy(req, scopeId, config);
    }
  }
  if (req.method === "GET") {
    match = /^\/api\/v1\/knowledge\/([^/]+)\/promotion$/.exec(path);
    if (match) {
      const id = routeId(match[1]);
      return isResponse(id) ? id : getPreview(id, config);
    }
    if (path === "/api/v1/promotions") return listPromotions(url, config);
  }
  if (req.method === "POST") {
    match = /^\/api\/v1\/knowledge\/([^/]+)\/promote$/.exec(path);
    if (match) {
      const id = routeId(match[1]);
      return isResponse(id) ? id : promote(req, id, config);
    }
    match = /^\/api\/v1\/promotions\/([^/]+)\/(approve|reject|withdraw)$/.exec(
      path,
    );
    if (match) {
      const id = routeId(match[1]);
      if (isResponse(id)) return id;
      return review(
        req,
        id,
        match[2] as "approve" | "reject" | "withdraw",
        config,
      );
    }
  }
  return null;
}

export async function applyPromotionDecisions(
  client: SupabaseClient,
): Promise<void> {
  try {
    const user = await getCurrentUser();
    if (!user) return;
    const { data, error } = await client
      .from("promotion_requests")
      .select("*")
      .eq("proposer_id", user.user_id)
      .in("status", ["approved", "rejected"])
      .is("applied", null);
    if (error) {
      log.notice("sync: promotion decision lookup failed");
      return;
    }
    if (!data) return;
    for (const value of data) {
      const row = value as PromotionRow;
      try {
        const candidate = ltm.teamPromotionCandidate(row.logical_id);
        if (candidate && candidate.versionId === row.entry_version_id) {
          if (row.status === "approved") {
            ltm.approveForTeam(row.logical_id, row.decided_by ?? undefined);
          } else {
            ltm.rejectForTeam(row.logical_id);
          }
          const { error: applyError } = await client.rpc(
            "mark_promotion_applied",
            {
              p_id: row.id,
              p_outcome: "applied",
            },
          );
          if (applyError) {
            log.notice("sync: promotion outcome recording failed");
          }
        } else {
          const { error: staleError } = await client.rpc(
            "mark_promotion_applied",
            {
              p_id: row.id,
              p_outcome: "stale",
            },
          );
          if (staleError) {
            log.notice("sync: stale promotion outcome recording failed");
          }
        }
      } catch {
        log.notice("sync: promotion decision application failed");
      }
    }
  } catch {
    log.notice("sync: promotion decision lookup failed");
  }
}
