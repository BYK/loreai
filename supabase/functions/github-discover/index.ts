// E-5-d (#630, Slice 1): github-discover Edge Function. Reads the caller's repos + each repo's
// default-branch contributors FROM GitHub with the caller's OWN provider_token (unforgeable — GitHub
// authorizes on the caller's access), then reveals which contributors already have a Lore account
// via the service-role-only lore_users_for_github_ids RPC (0050).
//
// SECURITY:
//   - The provider_token is bound to the JWT's linked GitHub identity (a leaked/foreign token can't
//     be used to enumerate someone else's repos as this user).
//   - Lore-membership is disclosed ONLY for contributors of repos the caller can actually read
//     (GitHub 403/404s an inaccessible repo → skipped). No open "is X on Lore" oracle.
//   - The RPC returns only the SET of present github ids (never Lore user_ids), and is
//     service-role-only, so a client can never call it directly to enumerate accounts.
//
// OPTIONAL INVITE MODE (E-5-d-2 + E-5-e server-side):
//   When the body includes `invite_to_scope` (UUID) and `invite_role`, after the discovery phase we
//   mint one invite per DISTINCT contributor and email the join link when a recipient address can be
//   resolved server-side. The gateway never sees the resolved email — only an Emailed/print tally.
//
//   Authorization chain (enforced via caller's JWT for every nested call):
//     1. caller is admin of invite_to_scope (scope_role rpc)
//     2. invite minted via create_scope_invite rpc (RLS enforces admin)
//     3. recipient email resolved via:
//          a. lore_emails_for_github_ids rpc (service-role) — preferred
//          b. GitHub /users/{login} via caller's provider_token — fallback for non-Lore users with
//             public email
//        Then sent via the send-invite-email Edge Function, which independently enforces:
//          - caller is admin of the invite's scope (scope_role)
//          - caller created the invite (inv.invited_by === user.id)
//
//   When neither lookup resolves (e.g. Lore user with no email on file, OR non-Lore with private
//   email), the invite is still server-side but the link is returned in `invites[].status` as
//   `no_email` + the gateway prints it manually.
//
// WHY CONTRIBUTORS: `/collaborators` requires push/access AND returns "everyone with at least
// triage" — which for a private org repo is effectively the org roster. We use `/contributors`
// (default branch, cached 24h by GitHub) instead — commit-attribution rosters are the user-asked
// mental model of "people who worked on this code".
//
// Deploy (auto-deployed on push to main via .github/workflows/deploy-functions.yml). SUPABASE_URL,
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
  fetchRepoContributors,
  fetchUserRepos,
  parseRepoRef,
  type RepoContributors,
} from "./discover.ts";
import { capture, initSentry, wrapHandler } from "../_shared/sentry.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Cap the number of repos we scan per call — bounds GitHub API fan-out (and cost) per request.
const MAX_REPOS = 50;

// Cap the number of invites we mint per call — bounds SMTP send rate + DB writes per request. The
// gateway surfaces this in the response so the admin can re-run with --role viewer for the rest if
// they want to split.
const MAX_INVITES = 200;

// GitHub /users/{login} lookup (cf. send-invite-email). Returns { id, email }. Email is null when
// private. We need the id to feed into lore_emails_for_github_ids; we use the public email only as
// a fallback for off-Lore users (most users keep theirs private — this is a "best effort" branch).
async function fetchGitHubUserByLogin(
  providerToken: string,
  login: string,
  apiUrl: string,
  fetchImpl: typeof fetch,
): Promise<{ id: number | null; email: string | null }> {
  const resp = await fetchImpl(`${apiUrl}/users/${encodeURIComponent(login)}`, {
    headers: {
      Authorization: `Bearer ${providerToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "lore-github-discover-invite",
    },
  });
  if (!resp.ok) return { id: null, email: null };
  const j = (await resp.json().catch(() => ({}))) as {
    id?: number;
    email?: string | null;
  };
  return {
    id: typeof j.id === "number" ? j.id : null,
    email: typeof j.email === "string" && j.email !== "" ? j.email : null,
  };
}

initSentry("github-discover");

Deno.serve(
  wrapHandler("github-discover", async (req: Request): Promise<Response> => {
    if (req.method !== "POST")
      return json({ error: "method not allowed" }, 405);

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
      invite_to_scope?: string;
      invite_role?: "editor" | "viewer";
    };
    const providerToken = body.provider_token;
    if (!providerToken) return json({ error: "missing provider_token" }, 400);
    const inviteToScope =
      typeof body.invite_to_scope === "string"
        ? body.invite_to_scope
        : undefined;
    const inviteRole: "editor" | "viewer" =
      body.invite_role === "viewer" ? "viewer" : "editor";

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
      await capture(e);
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
      await capture(e);
      return json({ error: `github: ${(e as Error).message}` }, 502);
    }
    repos = repos.slice(0, MAX_REPOS);

    // Read each repo's contributors with the caller's token (repos they can't read are skipped).
    const rosters: RepoContributors[] = [];
    for (const repo of repos) {
      try {
        const contributors = await fetchRepoContributors(
          providerToken,
          repo,
          selfGithubId,
          { apiUrl },
        );
        if (contributors === null) continue; // inaccessible — skip, don't fail the whole call
        rosters.push({ repo: `${repo.owner}/${repo.name}`, contributors });
      } catch (e) {
        // A transient error on one repo shouldn't sink the batch — log and skip.
        await capture(e);
        console.error(
          `contributors ${repo.owner}/${repo.name}:`,
          (e as Error).message,
        );
      }
    }

    // Service-role lookup: which contributor github ids have a Lore account. Returns only the SET of
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
        await capture(error);
        console.error("lore_users_for_github_ids failed:", error.message);
        return json({ error: "lookup failed" }, 500);
      }
      for (const row of (data ?? []) as Array<{ github_id: number | string }>) {
        loreIds.add(Number(row.github_id));
      }
    }

    const annotated = annotateOnLore(rosters, loreIds);

    // OPTIONAL INVITE PHASE: server-side mint+email per distinct contributor. Skipped when the body
    // does not include invite_to_scope, so the existing read-only callers (which never opt into
    // invites) are unaffected.
    if (!inviteToScope) {
      return json({ repos: annotated });
    }

    // Pre-check: caller is admin of invite_to_scope. We re-check per-invite via RLS, but a fast 403
    // here saves N RPC calls in the unauthorized case.
    const { data: roleRow } = await userClient.rpc("scope_role", {
      p_scope: inviteToScope,
    });
    if (roleRow !== "admin") {
      return json({ error: "not admin of invite_to_scope" }, 403);
    }

    // Distinct contributor set, alphabetically stable, capped at MAX_INVITES.
    const byLogin = new Map<string, { login: string; githubId: number }>();
    for (const r of annotated) {
      for (const c of r.contributors) {
        const existing = byLogin.get(c.login);
        if (!existing)
          byLogin.set(c.login, { login: c.login, githubId: c.githubId });
      }
    }
    const contributors = Array.from(byLogin.values()).sort((a, b) =>
      a.login.localeCompare(b.login),
    );
    const capped = contributors.slice(0, MAX_INVITES);
    const overCap = contributors.length - capped.length;

    // Service-role helpers (used for lore email lookup; supabase admin checks still run with the
    // caller's JWT for create_scope_invite + scope_role + send-invite-email).
    const admin = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    type InviteReport = {
      login: string;
      status:
        | "emailed"
        | "no_email"
        | "forbidden"
        | "invite_failed"
        | "send_failed"
        | "skipped";
      resolved_via?: "lore_email" | "github_public_email" | null;
      token?: string;
    };
    const reports: InviteReport[] = [];
    let emailed = 0;
    let noEmail = 0;

    for (const c of capped) {
      // 1. Mint the invite with the CALLER's JWT — RLS enforces admin via create_scope_invite.
      const mintResp = await userClient.rpc("create_scope_invite", {
        p_scope: inviteToScope,
        p_role: inviteRole,
        p_hint: c.login,
        p_eph_pub: null,
      });
      if (mintResp.error || !mintResp.data) {
        await capture(
          mintResp.error ?? new Error("create_scope_invite no data"),
        );
        reports.push({
          login: c.login,
          status: mintResp.error?.message?.includes("forbidden")
            ? "forbidden"
            : "invite_failed",
        });
        continue;
      }
      const token = String(mintResp.data);

      // 2. Resolve recipient email server-side. Lore email first (preferred), public GitHub email
      //    as fallback for off-Lore users.
      let recipient: string | null = null;
      let resolvedVia: "lore_email" | "github_public_email" | null = null;
      try {
        const { data: loreRows } = await admin.rpc(
          "lore_emails_for_github_ids",
          { p_github_ids: [c.githubId] },
        );
        if (
          Array.isArray(loreRows) &&
          loreRows[0] &&
          typeof (loreRows[0] as { email?: unknown }).email === "string"
        ) {
          const e = (loreRows[0] as { email: string }).email;
          if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
            recipient = e;
            resolvedVia = "lore_email";
          }
        }
      } catch (e) {
        await capture(e);
      }
      if (!recipient) {
        try {
          const fetched = await fetchGitHubUserByLogin(
            providerToken,
            c.login,
            apiUrl ?? "https://api.github.com",
            fetch,
          );
          if (fetched.email) {
            recipient = fetched.email;
            resolvedVia = "github_public_email";
          }
        } catch (e) {
          await capture(e);
        }
      }

      if (!recipient) {
        // We minted but can't email — return the token so the gateway can print it.
        reports.push({
          login: c.login,
          status: "no_email",
          resolved_via: null,
          token,
        });
        noEmail++;
        continue;
      }

      // 3. Send via the existing send-invite-email Edge Function — that EF independently enforces
      //    admin + creator checks. We forward the caller's JWT (Authorization header) by calling
      //    functions.invoke with the userClient's session (which the SDK populates from the
      //    Authorization header we received).
      const { error: sendErr } = await userClient.functions.invoke(
        "send-invite-email",
        { body: { token, email: recipient } },
      );
      if (sendErr) {
        await capture(sendErr);
        reports.push({
          login: c.login,
          status: "send_failed",
          resolved_via: resolvedVia,
          token,
        });
        continue;
      }
      reports.push({
        login: c.login,
        status: "emailed",
        resolved_via: resolvedVia,
        token,
      });
      emailed++;
    }

    return json({
      repos: annotated,
      invited: {
        scope_id: inviteToScope,
        role: inviteRole,
        total: contributors.length,
        emailed,
        no_email: noEmail,
        over_cap: overCap,
        results: reports,
      },
    });
  }),
);
