/**
 * folk-status.ts — Read-only Folk Lore (team sync) status routes (FOLK-01, #1806).
 *
 *   GET /api/v1/account               local account/session state
 *   GET /api/v1/teams                 locally mirrored team memberships
 *   GET /api/v1/projects/:id/sharing  project → team link, policy, lock state
 *   GET /api/v1/sync/status           sync enablement + pending local changes
 *
 * Every answer is computed from what the gateway already knows locally: the
 * persisted Supabase session projection (`team_config`), the pull-only
 * registry mirrors (`scopes`, `scope_members`), project link columns, the
 * keystore and the sync outbox. No cloud call, no sync trigger, no side
 * effects. Credentials (access/refresh/provider tokens) are never read into
 * a response — only the identity fields of the session projection are.
 *
 * Hosted / remote-gateway mode: cloud sync is installation-global and
 * single-account (see `syncData.isLocalSyncContext`), so tenant-scoped
 * requests must not see the operator's identity or memberships. Those
 * requests answer "anonymous / disabled" without touching `team_config`.
 */

import {
  db,
  keystore,
  syncData,
  getKV,
  projectScope,
  currentTenantId,
  LOCAL_TENANT_ID,
} from "@loreai/core";
import type { GatewayConfig } from "./config";
import { loadPersistedSession } from "./supabase";

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

export type AccountState = "signed_in" | "anonymous" | "expired";

export interface AccountStatus {
  signed_in: boolean;
  user: {
    id: string;
    email: string | null;
    display_name: string | null;
  } | null;
  provider: string | null;
  /** ISO-8601 access-token expiry, or null when the session carries none. */
  expires_at: string | null;
  state: AccountState;
}

export interface TeamStatus {
  id: string;
  name: string | null;
  role: string;
  member_count: number;
}

export type PromotionPolicy = "manual" | "auto";

export interface SharingPolicy {
  effective: PromotionPolicy;
  project_override: PromotionPolicy | null;
  team_default: PromotionPolicy | null;
}

export type SharingState = "not_linked" | "linked" | "locked" | "degraded";

export interface SharingStatus {
  linked: boolean;
  team: { id: string; name: string | null } | null;
  policy: SharingPolicy;
  state: SharingState;
  detail: string | null;
}

export type SyncState = "idle" | "disabled";

export interface SyncStatus {
  enabled: boolean;
  state: SyncState;
  pending_changes: number | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function notFound(message: string): Response {
  return json({ type: "error", error: { type: "not_found", message } }, 404);
}

/**
 * True when Folk Lore state must not be disclosed to this request: hosted or
 * remote-gateway deployments, or any request running under a non-local tenant.
 */
function folkUnavailable(config: GatewayConfig): boolean {
  return (
    config.hostedMode || config.remoteGateway || !syncData.isLocalSyncContext()
  );
}

type SafeSession = {
  user_id: string;
  email: string | null;
  display_name: string | null;
  github_login: string | null;
  expires_at: number | null;
};

/** Project the persisted session down to identity fields only — never tokens. */
function safeSession(config: GatewayConfig): SafeSession | null {
  if (folkUnavailable(config)) return null;
  const s = loadPersistedSession();
  if (!s) return null;
  return {
    user_id: s.user_id,
    email: s.email ?? null,
    display_name: s.display_name ?? null,
    github_login: s.github_login ?? null,
    expires_at: typeof s.expires_at === "number" ? s.expires_at : null,
  };
}

function isExpired(s: SafeSession, nowMs: number): boolean {
  return s.expires_at !== null && s.expires_at * 1000 <= nowMs;
}

function asPolicy(v: string | null | undefined): PromotionPolicy | null {
  return v === "manual" || v === "auto" ? v : null;
}

// ---------------------------------------------------------------------------
// Route builders
// ---------------------------------------------------------------------------

export function accountStatus(
  config: GatewayConfig,
  nowMs = Date.now(),
): AccountStatus {
  const s = safeSession(config);
  if (!s) {
    return {
      signed_in: false,
      user: null,
      provider: null,
      expires_at: null,
      state: "anonymous",
    };
  }
  const expired = isExpired(s, nowMs);
  return {
    signed_in: !expired,
    user: { id: s.user_id, email: s.email, display_name: s.display_name },
    provider: s.github_login ? "github" : null,
    expires_at:
      s.expires_at === null
        ? null
        : new Date(s.expires_at * 1000).toISOString(),
    state: expired ? "expired" : "signed_in",
  };
}

export function teamsStatus(config: GatewayConfig): { teams: TeamStatus[] } {
  const s = safeSession(config);
  if (!s) return { teams: [] };
  const rows = db()
    .query(
      `SELECT sm.scope_id AS id, sc.name AS name, sm.role AS role,
              (SELECT COUNT(*) FROM scope_members c WHERE c.scope_id = sm.scope_id) AS member_count
         FROM scope_members sm
         JOIN scopes sc ON sc.id = sm.scope_id
        WHERE sm.user_id = ? AND sc.kind = 'team'
        ORDER BY sc.name, sm.scope_id`,
    )
    .all(s.user_id) as Array<{
    id: string;
    name: string | null;
    role: string;
    member_count: number;
  }>;
  return {
    teams: rows.map((r) => ({
      id: r.id,
      name: r.name ?? null,
      role: r.role,
      member_count: r.member_count,
    })),
  };
}

/** Returns null when the project id is unknown. */
export function sharingStatus(
  config: GatewayConfig,
  projectId: string,
  nowMs = Date.now(),
): SharingStatus | null {
  const link = db()
    .query(
      "SELECT scope_id, promotion_policy FROM projects WHERE tenant_id = ? AND id = ?",
    )
    .get(currentTenantId(), projectId) as {
    scope_id: string | null;
    promotion_policy: string | null;
  } | null;
  if (!link) return null;

  const scopeId = folkUnavailable(config) ? null : projectScope(projectId);
  const scope = scopeId
    ? (db()
        .query("SELECT name, promotion_policy FROM scopes WHERE id = ?")
        .get(scopeId) as {
        name: string | null;
        promotion_policy: string | null;
      } | null)
    : null;

  const projectOverride = asPolicy(link.promotion_policy);
  const teamDefault = asPolicy(scope?.promotion_policy);
  const policy: SharingPolicy = {
    effective: projectOverride ?? (teamDefault === "auto" ? "auto" : "manual"),
    project_override: projectOverride,
    team_default: teamDefault,
  };

  if (!scopeId) {
    return {
      linked: false,
      team: null,
      policy,
      state: "not_linked",
      detail: folkUnavailable(config)
        ? "Folk Lore is unavailable in hosted/remote gateway mode"
        : null,
    };
  }

  const team = { id: scopeId, name: scope?.name ?? null };
  const s = safeSession(config);
  let detail: string | null = null;
  if (!s) detail = "Not signed in; team content cannot sync";
  else if (isExpired(s, nowMs)) detail = "Account session expired";
  else if (!syncData.isSyncEnabled()) detail = "Sync is disabled";
  else if (!scope) detail = "Team is not in the local registry mirror";
  else if (!isMember(scopeId, s.user_id))
    detail = "Current account is not a member of the linked team";
  if (detail) return { linked: true, team, policy, state: "degraded", detail };

  if (keystore.encryptionState() === "locked") {
    return {
      linked: true,
      team,
      policy,
      state: "locked",
      detail: "Encryption keys are locked on this device",
    };
  }
  return { linked: true, team, policy, state: "linked", detail: null };
}

function isMember(scopeId: string, userId: string): boolean {
  const row = db()
    .query("SELECT 1 FROM scope_members WHERE scope_id = ? AND user_id = ?")
    .get(scopeId, userId);
  return row != null;
}

export function syncStatus(config: GatewayConfig): SyncStatus {
  if (folkUnavailable(config) || !syncData.isSyncEnabled()) {
    return { enabled: false, state: "disabled", pending_changes: null };
  }
  let pending = 0;
  for (const meta of syncData.syncedTablesFor(syncData.currentSyncTier())) {
    if (meta.pullOnly) continue;
    const cursor = Number(getKV(`sync.push.${meta.table}`) ?? "0");
    const row = db()
      .query(
        `SELECT COUNT(DISTINCT row_id) AS n FROM sync_outbox
          WHERE tenant_id = ? AND table_name = ? AND seq > ?`,
      )
      .get(LOCAL_TENANT_ID, meta.table, cursor) as { n: number } | null;
    pending += row?.n ?? 0;
  }
  return { enabled: true, state: "idle", pending_changes: pending };
}

// ---------------------------------------------------------------------------
// Dispatcher entry point
// ---------------------------------------------------------------------------

const SHARING_RE = /^\/api\/v1\/projects\/([^/]+)\/sharing$/;

/**
 * Handle a GET Folk Lore status route, or return null when `pathname` is not
 * one of them. Caller (api.ts) has already applied the management boundary.
 */
export function handleFolkStatusRequest(
  pathname: string,
  config: GatewayConfig,
): Response | null {
  if (pathname === "/api/v1/account") return json(accountStatus(config));
  if (pathname === "/api/v1/teams") return json(teamsStatus(config));
  if (pathname === "/api/v1/sync/status") return json(syncStatus(config));
  const m = SHARING_RE.exec(pathname);
  if (m) {
    let id: string;
    try {
      id = decodeURIComponent(m[1]);
    } catch {
      return notFound(`Project not found: ${m[1]}`);
    }
    const status = sharingStatus(config, id);
    if (!status) return notFound(`Project not found: ${id}`);
    return json(status);
  }
  return null;
}
