// E-5-d (#630, Slice 1): github-discover Edge Function. Reads the caller's repos + each repo's
// contributors FROM GitHub with the caller's OWN provider_token (unforgeable — GitHub authorizes on
// the caller's access), then reveals which contributors already have a Lore account via the
// service-role-only lore_users_for_github_ids RPC (0050).
//
// SECURITY:
//   - The provider_token is bound to the JWT's linked GitHub identity (a leaked/foreign token can't
//     be used to enumerate someone else's contributors as this user).
//   - Lore-membership is disclosed ONLY for contributors of repos the caller can actually read
//     (GitHub 403/404s an inaccessible repo → skipped). No open "is X on Lore" oracle.
//   - The RPC returns only the SET of present github ids (never Lore user_ids), and is
//     service-role-only, so a client can never call it directly to enumerate accounts.
//
// WHY CONTRIBUTORS NOT COLLABORATORS: `/repos/{owner}/{name}/collaborators` requires the caller to
// have push/admin on the repo AND it returns "everyone with admin/maintain/write/triage" — which
// for a private org repo is effectively the org roster (every org member typically has at least
// triage via org rules). That doesn't match the user's mental model of "people who actually worked
// on this code". `/repos/{owner}/{name}/contributors` (default branch only, cached 24h by GitHub)
// returns the commit-attribution roster — usually much narrower and far more actionable.
//
// Deploy (not auto-deployed): `supabase functions deploy github-discover`. SUPABASE_URL,
// SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are injected by the platform; GITHUB_API_URL is
// optional (defaults to https://api.github.com; overridable for testing).

export interface RepoRef {
  owner: string;
  name: string;
}
export interface Contributor {
  login: string;
  github_id: number;
}
export interface RepoContributors {
  repo: string; // "owner/name"
  contributors: Contributor[];
}

const GH_HEADERS = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "lore-github-discover",
});

// GitHub returns the next-page URL inside a `Link: <url>; rel="next"` header. We follow it up to
// MAX_PAGES so a single burst-of-contributors repo can't stall the request indefinitely.
const MAX_PAGES = 5;
const PER_PAGE = 100;

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
  // collapse `.`/`..` path segments (e.g. /repos/owner/../contributors → /repos/contributors),
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
 * Read the `Link: <url>; rel="next"` header into a next-page URL string, or null when there is no
 * next page. GitHub sends `rel="prev"` and `rel="first"` / `rel="last"` too; we only follow `next`.
 */
function nextPageUrl(linkHeader: string | null, apiUrl: string): string | null {
  if (!linkHeader) return null;
  const matches = linkHeader.split(/,\s*/);
  for (const m of matches) {
    const parsed = /^<([^>]+)>;\s*rel="next"$/.exec(m);
    if (parsed) {
      const nextUrl = parsed[1];
      // GitHub's next URL is fully qualified under `apiUrl`, but defense-in-depth: if a non-`apiUrl`
      // host sneaks in (e.g. an internal proxy in tests), coerce it onto `apiUrl` so a token-leaking
      // surface can't be reached.
      const apiRoot = apiUrl.replace(/\/$/, "");
      try {
        const u = new URL(nextUrl);
        if (`${u.protocol}//${u.host}` !== new URL(apiRoot).origin) {
          return `${apiRoot}${u.pathname}${u.search}`;
        }
      } catch {
        // fall through and return as-is — the fetch will fail rather than leak.
      }
      return nextUrl;
    }
  }
  return null;
}

/**
 * Fetch a single repo's contributors (default branch commit attribution) with the caller's token.
 * GitHub's `/contributors` endpoint is read-access-only and returns "everyone with at least one
 * commit on the default branch". Includes anonymous contributors when `?anon=true` — we still drop
 * rows without a `login`+`id` since we can only link those to a Lore account via github_id.
 *
 * Special statuses:
 *   - 202: GitHub is computing contributor stats (cold cache for new/large repos). Skip — caller
 *     can retry later; we never bubble a 202 up.
 *   - 204: empty contributor list → return [] (not null — a 204 IS a readable repo).
 *   - 403/404: caller has no read access / no such repo → return null (skip, don't fail).
 *
 * Pages up to MAX_PAGES to avoid runaway on a sudden burst.
 */
export async function fetchRepoContributors(
  token: string,
  repo: RepoRef,
  selfGithubId: number,
  opts: { apiUrl?: string; fetchImpl?: typeof fetch } = {},
): Promise<Contributor[] | null> {
  const apiUrl = (opts.apiUrl ?? "https://api.github.com").replace(/\/$/, "");
  const f = opts.fetchImpl ?? fetch;
  let url: string | null =
    `${apiUrl}/repos/${repo.owner}/${repo.name}/contributors?anon=true&per_page=${PER_PAGE}`;
  const seen: Contributor[] = [];
  const seenIds = new Set<number>();
  for (let page = 0; page < MAX_PAGES && url; page++) {
    const resp = await f(url, { headers: GH_HEADERS(token) });
    // 403/404: skip the repo (caller can't read it / no such repo).
    if (resp.status === 403 || resp.status === 404) return null;
    // 202: stats still computing — caller can retry; treat as empty and don't fail the batch.
    // 204: repo is readable but GitHub returned no body (typically an empty repo with no
    //      commits). Without this branch, `resp.ok === true` and `await resp.json()`
    //      throws `SyntaxError: Unexpected end of JSON input` on the empty body, which
    //      the outer per-repo try/catch silently swallows as "inaccessible".
    //      Documented intent (see function docstring) was to return [] for both 202 and 204.
    if (resp.status === 202 || resp.status === 204) return [];
    if (!resp.ok)
      throw new Error(
        `github /repos/${repo.owner}/${repo.name}/contributors: ${resp.status}`,
      );
    const json = (await resp.json()) as Array<{
      login?: string | null;
      id?: number;
    }>;
    for (const c of Array.isArray(json) ? json : []) {
      // Anonymous contributors (or malformed rows) lack `login` / `id` — we can't tie those to a
      // Lore account, drop them. Same for self. Set-based dedup also defends against edge cases
      // (mock fetchers, future API quirks).
      if (typeof c.id !== "number" || c.id === selfGithubId) continue;
      if (typeof c.login !== "string" || c.login === "") continue;
      if (seenIds.has(c.id)) continue;
      seenIds.add(c.id);
      seen.push({ login: c.login, github_id: c.id });
    }
    url = nextPageUrl(resp.headers.get("link"), apiUrl);
  }
  return seen;
}

/**
 * The distinct set of contributor github ids across all discovered repos — the input to the
 * service-role Lore-membership lookup.
 */
export function collectGithubIds(repos: RepoContributors[]): number[] {
  const ids = new Set<number>();
  for (const r of repos) for (const c of r.contributors) ids.add(c.github_id);
  return Array.from(ids);
}

/**
 * Annotate each repo's roster with an `on_lore` flag from the set of github ids known to have a Lore
 * account (resolved server-side via the service-role lookup). Never exposes Lore user_ids — only the
 * boolean membership signal, and only for contributors of repos the caller could already read.
 */
export function annotateOnLore(
  repos: RepoContributors[],
  loreGithubIds: Set<number>,
): Array<{
  repo: string;
  contributors: Array<{ login: string; github_id: number; on_lore: boolean }>;
}> {
  return repos.map((r) => ({
    repo: r.repo,
    contributors: r.contributors.map((c) => ({
      login: c.login,
      github_id: c.github_id,
      on_lore: loreGithubIds.has(c.github_id),
    })),
  }));
}
