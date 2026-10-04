import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { crypto, isHostedMode, keystore, ltm, syncData } from "@loreai/core";
import type { GatewayConfig } from "./config";
import { sharingStatus, type SharingPolicy } from "./folk-status";
import {
  getAuthedClient,
  getCurrentUser,
  loadPersistedSession,
} from "./supabase";
import { listTeams, teamMembers } from "./team";
import { makeEncryptionResolver, openString, sealString } from "./sync";

type RemoteStatus = "ok" | "anonymous" | "unreachable" | "hosted";
type DecisionStatus = "approved" | "rejected";
type RequestStatus = "pending" | DecisionStatus | "withdrawn";
type AppliedStatus = "applied" | "stale";

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
  decided_by: { id: string; label: string } | null;
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

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(
  status: number,
  type: string,
  message: string,
  fields: Record<string, unknown> = {},
): Response {
  return json({ type: "error", error: { type, message, ...fields } }, status);
}

function requestIsHosted(config: GatewayConfig): boolean {
  return (
    config.hostedMode ||
    config.remoteGateway ||
    isHostedMode() ||
    !syncData.isLocalSyncContext()
  );
}

function hostedRefusal(): Response {
  return errorResponse(
    403,
    "forbidden",
    "Knowledge promotions are not available in hosted mode.",
  );
}

type Access = {
  remote: RemoteStatus;
  client: SupabaseClient | null;
  me: string | null;
};

async function accessFor(config: GatewayConfig): Promise<Access> {
  if (requestIsHosted(config)) {
    return { remote: "hosted", client: null, me: null };
  }
  const session = loadPersistedSession();
  if (!session) return { remote: "anonymous", client: null, me: null };
  try {
    const client = await getAuthedClient();
    if (!client) return { remote: "anonymous", client: null, me: null };
    return { remote: "ok", client, me: session.user_id };
  } catch {
    return { remote: "unreachable", client: null, me: session.user_id };
  }
}

function parseObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function readObjectBody(
  req: Request,
): Promise<Record<string, unknown> | Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, "invalid_request", "Invalid JSON body");
  }
  const object = parseObject(body);
  return (
    object ?? errorResponse(400, "invalid_request", "Expected an object body")
  );
}

function postgresError(error: { code?: string; message?: string }): Response {
  const message = error.message ?? "Promotion request failed";
  switch (error.code) {
    case "P0002":
      return errorResponse(404, "not_found", message);
    case "42501":
      return errorResponse(403, "forbidden", message);
    case "55000":
      return errorResponse(409, "already_decided", message);
    case "23505":
      return errorResponse(409, "already_pending", message);
    case "22023":
    case "22001":
      return errorResponse(400, "invalid_request", message);
    default:
      return errorResponse(502, "remote_unreachable", message);
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
    | "account_required"
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
  if (remote !== "ok") return { promotable: false, reason: "account_required" };
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

function localIdentityLabel(userId: string): string | null {
  const session = loadPersistedSession();
  if (!session || session.user_id !== userId) return null;
  if (session.github_login) return `@${session.github_login}`;
  return session.display_name ?? session.email ?? null;
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
      const role =
        members.find((member) => member.userId === me)?.role ??
        team?.role ??
        null;
      const labels = new Map(
        members.map((member) => [
          member.userId,
          member.userId === me ? localIdentityLabel(me) : null,
        ]),
      );
      if (!labels.has(me)) labels.set(me, localIdentityLabel(me));
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
  const canDecide =
    row.status === "pending" && !mine && presentation.role === "admin";
  const blockedReason =
    row.status !== "pending"
      ? "decided"
      : mine
        ? "own_proposal"
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
          label:
            presentation.labels.get(row.decided_by) ??
            (row.decided_by === me ? localIdentityLabel(me) : null) ??
            row.decided_by,
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
  const eligibilityResult = eligibility(candidate, access.remote, ctx !== null);

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
    eligibility: eligibilityResult,
    previous_team_version: previous,
    pending_request: pendingRequest,
    remote,
  });
}

async function promote(
  req: Request,
  id: string,
  config: GatewayConfig,
): Promise<Response> {
  if (requestIsHosted(config)) return hostedRefusal();
  const body = await readObjectBody(req);
  if (isResponse(body)) return body;
  if (typeof body.version_id !== "string") {
    return errorResponse(400, "invalid_request", "version_id must be a string");
  }
  if (Object.keys(body).some((key) => key !== "version_id")) {
    return errorResponse(400, "invalid_request", "Only version_id is accepted");
  }
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
  const eligibilityResult = eligibility(candidate, access.remote, ctx !== null);
  if (!eligibilityResult.promotable) {
    const reason = eligibilityResult.reason!;
    const status =
      reason === "account_required" || reason === "encryption_locked"
        ? 409
        : 422;
    return errorResponse(
      status,
      reason === "account_required" || reason === "encryption_locked"
        ? reason
        : "not_promotable",
      "Knowledge entry cannot be proposed",
      { reason },
    );
  }
  if (body.version_id !== candidate.versionId) {
    return errorResponse(
      409,
      "stale_version",
      "Knowledge entry changed; reload the preview",
      {
        current_version_id: candidate.versionId,
      },
    );
  }
  if (!access.client || !access.me || !candidate.scopeId || !ctx) {
    return errorResponse(
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
  const { data, error } = await access.client
    .from("promotion_requests")
    .insert({
      id: requestId,
      scope_id: candidate.scopeId,
      logical_id: candidate.logicalId,
      entry_version_id: candidate.versionId,
      entry_version: candidate.version,
      category: candidate.category,
      title_enc: titleEnc,
      content_enc: contentEnc,
      proposer_id: access.me,
    })
    .select("*")
    .single();
  if (error) return postgresError(error);
  if (!data)
    return errorResponse(
      502,
      "remote_unreachable",
      "Promotion service returned no receipt",
    );
  try {
    const row = data as PromotionRow;
    const presentation = (
      await teamPresentations(access.client, access.me, [row])
    ).get(row.scope_id) ?? { name: null, role: null, labels: new Map() };
    return json(
      {
        request: await shapeRequest(row, access.me, presentation, resolver),
      },
      201,
    );
  } catch {
    return errorResponse(
      502,
      "remote_unreachable",
      "Could not read promotion receipt",
    );
  }
}

async function listPromotions(
  url: URL,
  config: GatewayConfig,
): Promise<Response> {
  const teamId = url.searchParams.get("team");
  const status = url.searchParams.get("status") ?? "pending";
  if (!teamId || !UUID.test(teamId)) {
    return errorResponse(400, "invalid_request", "team must be a UUID");
  }
  if (status !== "pending" && status !== "decided" && status !== "all") {
    return errorResponse(
      400,
      "invalid_request",
      "status must be pending, decided, or all",
    );
  }
  const access = await accessFor(config);
  if (!access.client || !access.me) {
    return json({
      remote: access.remote,
      requests: [],
      complete: true,
    });
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
  const { data, error } = await query;
  if (error) {
    return json({ remote: "unreachable", requests: [], complete: true });
  }
  const rows = (data ?? []) as PromotionRow[];
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
    return json({ remote: "ok", requests, complete });
  } catch {
    return json({ remote: "unreachable", requests: [], complete: true });
  }
}

async function review(
  req: Request,
  id: string,
  decision: "approve" | "reject" | "withdraw",
  config: GatewayConfig,
): Promise<Response> {
  if (requestIsHosted(config)) return hostedRefusal();
  const body = await readObjectBody(req);
  if (isResponse(body)) return body;
  let note: string | undefined;
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
    note = body.note;
  } else if (Object.keys(body).length > 0) {
    return errorResponse(
      400,
      "invalid_request",
      "Withdraw does not accept fields",
    );
  }
  const access = await accessFor(config);
  if (!access.client || !access.me) {
    return errorResponse(
      403,
      "forbidden",
      "Sign in with lore login to review promotions.",
    );
  }
  const rpc =
    decision === "withdraw"
      ? await access.client.rpc("withdraw_promotion", { p_id: id })
      : await access.client.rpc("decide_promotion", {
          p_id: id,
          p_decision: decision === "approve" ? "approved" : "rejected",
          p_note: note ?? null,
        });
  if (rpc.error) return postgresError(rpc.error);
  const raw = Array.isArray(rpc.data) ? rpc.data[0] : rpc.data;
  if (!raw)
    return errorResponse(
      502,
      "remote_unreachable",
      "Promotion service returned no receipt",
    );
  try {
    const row = raw as PromotionRow;
    const presentation = (
      await teamPresentations(access.client, access.me, [row])
    ).get(row.scope_id) ?? { name: null, role: null, labels: new Map() };
    return json({
      request: await shapeRequest(
        row,
        access.me,
        presentation,
        makeEncryptionResolver(),
      ),
    });
  } catch {
    return errorResponse(
      502,
      "remote_unreachable",
      "Could not read promotion receipt",
    );
  }
}

function routeId(segment: string): string | Response {
  let id: string;
  try {
    id = decodeURIComponent(segment);
  } catch {
    return errorResponse(400, "invalid_request", "Promotion id must be a UUID");
  }
  return UUID.test(id)
    ? id
    : errorResponse(400, "invalid_request", "Promotion id must be a UUID");
}

export async function handlePromotionRequest(
  req: Request,
  url: URL,
  config: GatewayConfig,
): Promise<Response | null> {
  const path = url.pathname;
  let match: RegExpExecArray | null;
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
    if (error || !data) return;
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
          await client.rpc("mark_promotion_applied", {
            p_id: row.id,
            p_outcome: "applied",
          });
        } else {
          await client.rpc("mark_promotion_applied", {
            p_id: row.id,
            p_outcome: "stale",
          });
        }
      } catch {
        continue;
      }
    }
  } catch {
    return;
  }
}
