// E-5-a (#827): pure, runtime-portable core of the github-provision Edge Function — fetch the
// caller's GitHub org/team memberships and map them to the provision_github_membership RPC payload.
// No Deno/npm imports here so it is unit-testable under Node/Vitest; index.ts is the thin Deno glue.

export interface GitHubOrg {
  id: number;
  login: string;
  role: "admin" | "member";
}
export interface GitHubTeam {
  id: number;
  slug: string;
  name: string;
  orgId: number;
}
export interface GitHubMemberships {
  orgs: GitHubOrg[];
  teams: GitHubTeam[];
}

export interface ProvisionOrg {
  github_org_id: number;
  login: string;
  role: "manager" | "member";
}
export interface ProvisionTeam {
  github_team_id: number;
  github_org_id: number;
  slug: string;
  name: string;
  role: "admin" | "editor";
}
export interface ProvisionPayload {
  orgs: ProvisionOrg[];
  teams: ProvisionTeam[];
}

export interface GitHubUser {
  id: number;
  login: string;
}

/**
 * The GitHub numeric id (as a string) that a Supabase user is linked to — from the github identity,
 * falling back to user_metadata.provider_id. Returns null when there is no linked GitHub identity
 * (an email-only user), so the caller fails CLOSED.
 */
export function resolveJwtGithubId(user: {
  identities?: Array<{ provider?: string; id?: string }> | null;
  user_metadata?: { provider_id?: unknown } | null;
}): string | null {
  const fromIdentity = user.identities?.find(
    (i) => i.provider === "github",
  )?.id;
  if (fromIdentity != null && fromIdentity !== "") return String(fromIdentity);
  const fromMeta = user.user_metadata?.provider_id;
  if (typeof fromMeta === "string" && fromMeta !== "") return fromMeta;
  if (typeof fromMeta === "number") return String(fromMeta);
  return null;
}

/**
 * True iff the provider_token's owner is the SAME GitHub identity the JWT user is linked to. Binds a
 * token to its owner so a leaked/foreign token can't provision the JWT user into another account's
 * teams. Fails CLOSED when the JWT has no linked GitHub id.
 */
export function isTokenOwnerBound(
  tokenOwnerId: number | string,
  jwtGithubId: string | null,
): boolean {
  return jwtGithubId != null && String(tokenOwnerId) === String(jwtGithubId);
}

const GH_HEADERS = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "lore-github-provision",
});

/**
 * Fetch the GitHub identity that OWNS a provider_token. The caller compares this against the
 * authenticated Supabase user's linked GitHub id, so a token belonging to a DIFFERENT GitHub
 * identity can never provision the JWT's user into someone else's teams.
 */
export async function fetchGitHubUser(
  token: string,
  opts: { apiUrl?: string; fetchImpl?: typeof fetch } = {},
): Promise<GitHubUser> {
  const apiUrl = (opts.apiUrl ?? "https://api.github.com").replace(/\/$/, "");
  const f = opts.fetchImpl ?? fetch;
  const resp = await f(`${apiUrl}/user`, { headers: GH_HEADERS(token) });
  if (!resp.ok) throw new Error(`github /user: ${resp.status}`);
  const j = (await resp.json()) as { id?: number; login?: string };
  if (!j.id) throw new Error("github /user: no id");
  return { id: j.id, login: j.login ?? "" };
}

/**
 * Fetch the AUTHENTICATED user's active org memberships (with role) + teams, using their OWN OAuth
 * `provider_token`. GitHub scopes both endpoints to the token's user, so the result is authoritative
 * and unforgeable for that user's own memberships — this is what makes self-serve provisioning safe.
 * v1: first page only (per_page=100); pagination is a follow-up if a user exceeds 100 orgs/teams.
 */
export async function fetchGitHubMemberships(
  token: string,
  opts: { apiUrl?: string; fetchImpl?: typeof fetch } = {},
): Promise<GitHubMemberships> {
  const apiUrl = (opts.apiUrl ?? "https://api.github.com").replace(/\/$/, "");
  const f = opts.fetchImpl ?? fetch;
  const headers = GH_HEADERS(token);

  const orgsResp = await f(
    `${apiUrl}/user/memberships/orgs?state=active&per_page=100`,
    { headers },
  );
  if (!orgsResp.ok)
    throw new Error(`github /user/memberships/orgs: ${orgsResp.status}`);
  const orgsJson = (await orgsResp.json()) as Array<{
    role?: string;
    state?: string;
    organization?: { id?: number; login?: string };
  }>;
  const orgs: GitHubOrg[] = [];
  for (const m of Array.isArray(orgsJson) ? orgsJson : []) {
    if (m.state !== "active" || !m.organization?.id || !m.organization.login)
      continue;
    orgs.push({
      id: m.organization.id,
      login: m.organization.login,
      role: m.role === "admin" ? "admin" : "member",
    });
  }

  const teamsResp = await f(`${apiUrl}/user/teams?per_page=100`, { headers });
  if (!teamsResp.ok) throw new Error(`github /user/teams: ${teamsResp.status}`);
  const teamsJson = (await teamsResp.json()) as Array<{
    id?: number;
    slug?: string;
    name?: string;
    organization?: { id?: number };
  }>;
  const teams: GitHubTeam[] = [];
  for (const t of Array.isArray(teamsJson) ? teamsJson : []) {
    if (!t.id || !t.organization?.id) continue;
    teams.push({
      id: t.id,
      slug: t.slug ?? "",
      name: t.name ?? t.slug ?? "",
      orgId: t.organization.id,
    });
  }
  return { orgs, teams };
}

/**
 * Map GitHub memberships → the RPC payload. Conservative role map: GitHub org owner/admin ⇒ org
 * 'manager' + scope 'admin' on ALL that org's teams (so an org admin can bootstrap the team DEK);
 * plain member ⇒ org 'member' + scope 'editor'. v1 does NOT read per-team maintainer role (avoids an
 * N+1 GitHub call); org-admin status drives scope-admin. A team whose org isn't in the membership set
 * is dropped (defensive — the RPC would skip it anyway).
 */
export function buildProvisionPayload(m: GitHubMemberships): ProvisionPayload {
  const orgRole = new Map<number, "admin" | "member">();
  for (const o of m.orgs) orgRole.set(o.id, o.role);
  const orgs: ProvisionOrg[] = m.orgs.map((o) => ({
    github_org_id: o.id,
    login: o.login,
    role: o.role === "admin" ? "manager" : "member",
  }));
  const teams: ProvisionTeam[] = [];
  for (const t of m.teams) {
    const r = orgRole.get(t.orgId);
    if (!r) continue; // team's org not in the membership set
    teams.push({
      github_team_id: t.id,
      github_org_id: t.orgId,
      slug: t.slug,
      name: t.name,
      role: r === "admin" ? "admin" : "editor",
    });
  }
  return { orgs, teams };
}
