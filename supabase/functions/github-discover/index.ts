// E-5-d (#630, Slice 1): github-discover Edge Function. Reads the caller's repos + each repo's
// collaborators FROM GitHub with the caller's OWN provider_token (unforgeable — GitHub authorizes on
// the caller's access), then reveals which collaborators already have a Lore account via the
// service-role-only lore_users_for_github_ids RPC (0050).
//
// SECURITY:
//   - The provider_token is bound to the JWT's linked GitHub identity (a leaked/foreign token can't
//     be used to enumerate someone else's collaborators as this user).
//   - Lore-membership is disclosed ONLY for collaborators of repos the caller can actually read
//     (GitHub 403/404s an inaccessible repo → skipped). No open "is X on Lore" oracle.
//   - The RPC returns only the SET of present github ids (never Lore user_ids), and is
//     service-role-only, so a client can never call it directly to enumerate accounts.
//
// Deploy (not auto-deployed): `supabase functions deploy github-discover`. SUPABASE_URL,
// SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are injected by the platform; GITHUB_API_URL is
// optional (defaults to https://api.github.com; overridable for testing).
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  fetchGitHubUser,
  isTokenOwnerBound,
  resolveJwtGithubId,
} from "../github-provision/provision.ts";
import {
  annotateOnLore,
  collectGithubIds,
  fetchRepoCollaborators,
  fetchUserRepos,
  parseRepoRef,
  type RepoCollaborators,
} from "./discover.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Cap the number of repos we scan per call — bounds GitHub API fan-out (and cost) per request.
const MAX_REPOS = 50;

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "missing authorization" }, 401);

  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anonKey || !serviceKey) {
    return json({ error: "server misconfigured" }, 500);
  }

  // Verify the caller's Supabase JWT → user id (never trust a client-supplied id).
  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const {
    data: { user },
    error: userErr,
  } = await userClient.auth.getUser();
  if (userErr || !user) return json({ error: "invalid token" }, 401);

  const jwtGithubId = resolveJwtGithubId(user);

  const body = (await req.json().catch(() => ({}))) as {
    provider_token?: string;
    repos?: string[];
  };
  const providerToken = body.provider_token;
  if (!providerToken) return json({ error: "missing provider_token" }, 400);

  const apiUrl = Deno.env.get("GITHUB_API_URL") ?? undefined;

  // Bind the provider_token to the authenticated identity (same guard as github-provision).
  let selfGithubId: number;
  try {
    const tokenOwner = await fetchGitHubUser(providerToken, { apiUrl });
    if (!isTokenOwnerBound(tokenOwner.id, jwtGithubId)) {
      return json({ error: "provider_token identity mismatch" }, 403);
    }
    selfGithubId = tokenOwner.id;
  } catch (e) {
    return json({ error: `github: ${(e as Error).message}` }, 502);
  }

  // Resolve the repo set: explicit list (validated) or the caller's own repos (first page).
  let repos: Array<{ owner: string; name: string }>;
  try {
    if (Array.isArray(body.repos) && body.repos.length > 0) {
      repos = [];
      for (const r of body.repos) {
        const ref = parseRepoRef(r);
        if (ref) repos.push(ref);
      }
    } else {
      repos = await fetchUserRepos(providerToken, { apiUrl });
    }
  } catch (e) {
    return json({ error: `github: ${(e as Error).message}` }, 502);
  }
  repos = repos.slice(0, MAX_REPOS);

  // Read each repo's collaborators with the caller's token (repos they can't read are skipped).
  const rosters: RepoCollaborators[] = [];
  for (const repo of repos) {
    try {
      const collaborators = await fetchRepoCollaborators(
        providerToken,
        repo,
        selfGithubId,
        { apiUrl },
      );
      if (collaborators === null) continue; // inaccessible — skip, don't fail the whole call
      rosters.push({ repo: `${repo.owner}/${repo.name}`, collaborators });
    } catch (e) {
      // A transient error on one repo shouldn't sink the batch — log and skip.
      console.error(
        `collaborators ${repo.owner}/${repo.name}:`,
        (e as Error).message,
      );
    }
  }

  // Service-role lookup: which collaborator github ids have a Lore account. Returns only the SET of
  // present ids (never user_ids) — the RPC is service-role-only so this is the only enumeration path.
  const githubIds = collectGithubIds(rosters);
  const loreIds = new Set<number>();
  if (githubIds.length > 0) {
    const admin = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await admin.rpc("lore_users_for_github_ids", {
      p_github_ids: githubIds,
    });
    if (error) {
      console.error("lore_users_for_github_ids failed:", error.message);
      return json({ error: "lookup failed" }, 500);
    }
    for (const row of (data ?? []) as Array<{ github_id: number | string }>) {
      loreIds.add(Number(row.github_id));
    }
  }

  return json({ repos: annotateOnLore(rosters, loreIds) });
});
