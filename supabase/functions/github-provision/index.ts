// E-5-a (#827): github-provision Edge Function. Verifies the caller's GitHub org/team memberships
// server-side (with their OWN provider_token — unforgeable for their own memberships) and mirrors
// them into the Lore registry via the SERVICE-ROLE-ONLY provision_github_membership RPC (0035).
//
// SECURITY: the RPC is service-role-only precisely so this function is the ONLY path that can write
// team memberships — a client can never assert (forge) memberships. The user's Supabase JWT is
// verified (getUser), then their provider_token is used to read memberships FROM GitHub; the client
// never gets to say which teams it's in.
//
// Deploy (not auto-deployed): `supabase functions deploy github-provision`. SUPABASE_URL,
// SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are injected by the platform; GITHUB_API_URL is
// optional (defaults to https://api.github.com; overridable for testing).
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  buildProvisionPayload,
  fetchGitHubMemberships,
  fetchGitHubUser,
  isTokenOwnerBound,
  resolveJwtGithubId,
} from "./provision.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

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

  const body = (await req.json().catch(() => ({}))) as {
    provider_token?: string;
  };
  const providerToken = body.provider_token;
  if (!providerToken) return json({ error: "missing provider_token" }, 400);

  // The GitHub id the JWT user is actually linked to — used to bind the provider_token below.
  const jwtGithubId = resolveJwtGithubId(user);

  // Verify memberships against GitHub with the user's own token, then map to the RPC payload.
  let payload: ReturnType<typeof buildProvisionPayload>;
  try {
    const apiUrl = Deno.env.get("GITHUB_API_URL") ?? undefined;
    // Bind the provider_token to the authenticated identity: a token owned by a DIFFERENT GitHub
    // account must never provision this user into that account's teams (defense against a
    // leaked/misused token). GitHub's /user is authoritative for the token's owner.
    const tokenOwner = await fetchGitHubUser(providerToken, { apiUrl });
    if (!isTokenOwnerBound(tokenOwner.id, jwtGithubId)) {
      return json({ error: "provider_token identity mismatch" }, 403);
    }
    const memberships = await fetchGitHubMemberships(providerToken, { apiUrl });
    payload = buildProvisionPayload(memberships);
  } catch (e) {
    return json({ error: `github: ${(e as Error).message}` }, 502);
  }

  // Provision as service_role — the only role permitted to call the RPC.
  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error: rpcErr } = await admin.rpc("provision_github_membership", {
    p_user: user.id,
    p_orgs: payload.orgs,
    p_teams: payload.teams,
  });
  if (rpcErr) {
    console.error("provision_github_membership failed:", rpcErr.message);
    return json({ error: "provisioning failed" }, 500); // generic — details logged server-side
  }

  return json({
    ok: true,
    orgs: payload.orgs.length,
    teams: payload.teams.length,
  });
});
