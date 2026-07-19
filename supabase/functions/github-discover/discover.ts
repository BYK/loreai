// E-5-d (#630, Slice 1): pure, runtime-portable core of the github-discover Edge Function — read
// the caller's repos + each repo's collaborators from GitHub with the caller's OWN provider_token,
// so membership is authorized by GitHub on the caller's access (a repo they cannot read 403s and is
// skipped). No Deno/npm imports here so it is unit-testable under Node/Vitest; index.ts is the thin
// Deno glue that adds JWT verification + the service-role Lore-membership lookup.

export interface RepoRef {
  owner: string;
  name: string;
}
export interface Collaborator {
  login: string;
  github_id: number;
}
export interface RepoCollaborators {
  repo: string; // "owner/name"
  collaborators: Collaborator[];
}

const GH_HEADERS = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "lore-github-discover",
});

/**
 * Parse an "owner/name" string into a RepoRef, or null when malformed. Accepts a full GitHub URL or
 * a bare slug; strips a trailing ".git". Rejects anything that isn't exactly two non-empty segments
 * of the GitHub-allowed charset (defense against path traversal into the API URL).
 */
export function parseRepoRef(input: string): RepoRef | null {
  let s = input.trim();
  // Accept https://github.com/owner/name(.git) and github.com/owner/name too.
  s = s.replace(/^https?:\/\/[^/]+\//i, "").replace(/^github\.com\//i, "");
  s = s.replace(/\.git$/i, "").replace(/\/$/, "");
  const parts = s.split("/");
  if (parts.length !== 2) return null;
  const [owner, name] = parts;
  const ok = /^[A-Za-z0-9._-]+$/;
  if (!owner || !name || !ok.test(owner) || !ok.test(name)) return null;
  // Reject "." / ".." segments: the charset above allows dots, and a WHATWG URL parser would
  // collapse `.`/`..` path segments (e.g. /repos/owner/../collaborators → /repos/collaborators),
  // so a bare `.`/`..` must never be treated as a real repo owner/name.
  if (owner === "." || owner === ".." || name === "." || name === "..")
    return null;
  return { owner, name };
}

/**
 * List the AUTHENTICATED user's repos (owner + collaborator affiliations) using their OWN token.
 * v1: first page only (per_page=100); pagination is a follow-up. Returns "owner/name" refs.
 */
export async function fetchUserRepos(
  token: string,
  opts: { apiUrl?: string; fetchImpl?: typeof fetch } = {},
): Promise<RepoRef[]> {
  const apiUrl = (opts.apiUrl ?? "https://api.github.com").replace(/\/$/, "");
  const f = opts.fetchImpl ?? fetch;
  const resp = await f(
    `${apiUrl}/user/repos?per_page=100&affiliation=owner,collaborator`,
    { headers: GH_HEADERS(token) },
  );
  if (!resp.ok) throw new Error(`github /user/repos: ${resp.status}`);
  const json = (await resp.json()) as Array<{ full_name?: string }>;
  const out: RepoRef[] = [];
  for (const r of Array.isArray(json) ? json : []) {
    if (typeof r.full_name !== "string") continue;
    const ref = parseRepoRef(r.full_name);
    if (ref) out.push(ref);
  }
  return out;
}

/**
 * Fetch a single repo's collaborators with the caller's token. GitHub authorizes on the caller's
 * access, so a repo the caller cannot read returns 403/404 → we return null (the caller skips it)
 * rather than throwing, so one inaccessible repo never fails the whole discovery. Excludes the
 * caller themself (by github id) from the roster.
 */
export async function fetchRepoCollaborators(
  token: string,
  repo: RepoRef,
  selfGithubId: number,
  opts: { apiUrl?: string; fetchImpl?: typeof fetch } = {},
): Promise<Collaborator[] | null> {
  const apiUrl = (opts.apiUrl ?? "https://api.github.com").replace(/\/$/, "");
  const f = opts.fetchImpl ?? fetch;
  const resp = await f(
    `${apiUrl}/repos/${repo.owner}/${repo.name}/collaborators?per_page=100`,
    { headers: GH_HEADERS(token) },
  );
  // 403 (no access / not admin — collaborators requires push access) or 404 (no such repo): skip.
  if (resp.status === 403 || resp.status === 404) return null;
  if (!resp.ok)
    throw new Error(
      `github /repos/${repo.owner}/${repo.name}/collaborators: ${resp.status}`,
    );
  const json = (await resp.json()) as Array<{ login?: string; id?: number }>;
  const out: Collaborator[] = [];
  for (const c of Array.isArray(json) ? json : []) {
    if (typeof c.id !== "number" || c.id === selfGithubId) continue;
    if (typeof c.login !== "string" || c.login === "") continue;
    out.push({ login: c.login, github_id: c.id });
  }
  return out;
}

/**
 * The distinct set of collaborator github ids across all discovered repos — the input to the
 * service-role Lore-membership lookup.
 */
export function collectGithubIds(repos: RepoCollaborators[]): number[] {
  const ids = new Set<number>();
  for (const r of repos) for (const c of r.collaborators) ids.add(c.github_id);
  return Array.from(ids);
}

/**
 * Annotate each repo's roster with an `on_lore` flag from the set of github ids known to have a Lore
 * account (resolved server-side via the service-role lookup). Never exposes Lore user_ids — only the
 * boolean membership signal, and only for collaborators of repos the caller could already read.
 */
export function annotateOnLore(
  repos: RepoCollaborators[],
  loreGithubIds: Set<number>,
): Array<{
  repo: string;
  collaborators: Array<{ login: string; github_id: number; on_lore: boolean }>;
}> {
  return repos.map((r) => ({
    repo: r.repo,
    collaborators: r.collaborators.map((c) => ({
      login: c.login,
      github_id: c.github_id,
      on_lore: loreGithubIds.has(c.github_id),
    })),
  }));
}
