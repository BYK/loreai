// E-5-e (#630/#827): send-invite-email Edge Function. Emails a team invitee their join link via
// SMTP2GO. Authorization is anchored on the invite TOKEN, not client-supplied scope/role: the caller
// must be an admin of the invite's scope AND the pending invite must exist (looked up service-role),
// so this can never be used as an open email-spam relay — you can only email an invite that exists
// for a team you administer, to one recipient per call.
//
// Recipient resolution: the body accepts either an explicit `email` (admin-supplied, sent as-is) OR
// a `github_login` (server-side lookup). The lookup never returns an email to the gateway — only the
// SMTP send happens server-side. Resolution order: Lore-account email (via lore_emails_for_github_ids
// rpc + GitHub /users/{login} for the numeric id), then GitHub public email (only if the user has one
// set to public). When neither resolves, the EF returns `no_resolvable_email` and the gateway falls
// back to printing the link — the invite itself is already server-side, so the admin can finish the
// handoff however they want.
//
// Deploy (auto-deployed on push to main via .github/workflows/deploy-functions.yml). SMTP2GO_API_KEY
// must be set as a Function secret (`supabase secrets set SMTP2GO_API_KEY=…`). SUPABASE_URL /
// SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are injected by the platform. INVITE_SENDER defaults
// to keeper@withlore.ai; SMTP2GO_API_URL optional; GITHUB_API_URL optional (default api.github.com).
import { createClient } from "npm:@supabase/supabase-js@2";
import { buildInviteEmail, capabilityOf, sendViaSmtp2go } from "./send.ts";
import { capture, initSentry, wrapHandler } from "../_shared/sentry.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GH_HEADERS = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "lore-send-invite-email",
});

// GitHub /users/{login} returns { id, email }. Email is null when private.
// We look the user up primarily to obtain the numeric id — then prefer the Lore-account email for
// known accounts over the public GitHub email (Lore is the user's primary auth path for the team).
async function fetchGitHubUserByLogin(
  providerToken: string,
  login: string,
  apiUrl: string,
  fetchImpl: typeof fetch,
): Promise<{ id: number | null; email: string | null }> {
  const resp = await fetchImpl(`${apiUrl}/users/${encodeURIComponent(login)}`, {
    headers: GH_HEADERS(providerToken),
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

initSentry("send-invite-email");

Deno.serve(
  wrapHandler("send-invite-email", async (req: Request): Promise<Response> => {
    if (req.method !== "POST")
      return json({ error: "method not allowed" }, 405);

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "missing authorization" }, 401);

    const url = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const apiKey = Deno.env.get("SMTP2GO_API_KEY");
    if (!url || !anonKey || !serviceKey || !apiKey) {
      return json({ error: "server misconfigured" }, 500);
    }
    const sender = Deno.env.get("INVITE_SENDER") ?? "keeper@withlore.ai";
    const smtpApiUrl = Deno.env.get("SMTP2GO_API_URL") ?? undefined;
    const ghApiUrl = (
      Deno.env.get("GITHUB_API_URL") ?? "https://api.github.com"
    ).replace(/\/$/, "");

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
      token?: string;
      email?: string;
      github_login?: string;
      provider_token?: string;
    };
    const token = typeof body.token === "string" ? body.token : "";
    if (!token) return json({ error: "missing token" }, 400);
    const explicitEmail =
      typeof body.email === "string" ? body.email.trim() : "";
    const githubLogin =
      typeof body.github_login === "string" ? body.github_login.trim() : "";
    const providerToken =
      typeof body.provider_token === "string" ? body.provider_token : "";

    let recipient = "";
    let resolvedVia:
      | "explicit_email"
      | "lore_email"
      | "github_public_email"
      | null = null;
    if (explicitEmail) {
      if (!EMAIL_RE.test(explicitEmail))
        return json({ error: "invalid email" }, 400);
      recipient = explicitEmail;
      resolvedVia = "explicit_email";
    } else if (githubLogin) {
      // Resolve github_login → id via GitHub /users/{login}. Then prefer the Lore email (since
      // the recipient has a Lore account they're about to accept into), fall back to the GitHub
      // public email. The admin must supply provider_token so the call uses THEIR scoped grant.
      if (!providerToken) {
        return json(
          {
            error: "missing provider_token (required for github_login lookup)",
          },
          400,
        );
      }
      const { id: ghId, email: ghEmail } = await fetchGitHubUserByLogin(
        providerToken,
        githubLogin,
        ghApiUrl,
        fetch,
      );
      // Try Lore email first (private-bound recipient path: admin knows the user, it's their team).
      if (ghId !== null) {
        const admin = createClient(url, serviceKey, {
          auth: { persistSession: false, autoRefreshToken: false },
        });
        const { data: loreRows, error: loreErr } = await admin.rpc(
          "lore_emails_for_github_ids",
          { p_github_ids: [ghId] },
        );
        if (loreErr) {
          await capture(loreErr);
          console.error("lore_emails_for_github_ids failed:", loreErr.message);
          // Continue — public email below may still work.
        } else if (
          Array.isArray(loreRows) &&
          loreRows[0] &&
          typeof (loreRows[0] as { email?: unknown }).email === "string" &&
          (loreRows[0] as { email: string }).email.length > 0
        ) {
          const loreEmail = (loreRows[0] as { email: string }).email;
          if (EMAIL_RE.test(loreEmail)) {
            recipient = loreEmail;
            resolvedVia = "lore_email";
          }
        }
      }
      if (!recipient && ghEmail) {
        if (EMAIL_RE.test(ghEmail)) {
          recipient = ghEmail;
          resolvedVia = "github_public_email";
        }
      }
      if (!recipient) {
        return json(
          {
            error: "no_resolvable_email",
            hint: "Recipient has no Lore email on file and no public GitHub email.",
          },
          404,
        );
      }
    } else {
      return json({ error: "missing email or github_login" }, 400);
    }

    const capability = capabilityOf(token);

    const admin = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: inv, error: invErr } = await admin
      .from("pending_invites")
      .select("scope_id, role, invited_by, eph_pub, expires_at")
      .eq("token", capability)
      .maybeSingle();
    if (invErr) {
      await capture(invErr);
      console.error("pending_invites read failed:", invErr.message);
      return json({ error: "lookup failed" }, 500);
    }
    if (!inv || new Date(inv.expires_at as string).getTime() <= Date.now())
      return json({ error: "invite not found" }, 404);

    const { data: roleRow } = await userClient.rpc("scope_role", {
      p_scope: inv.scope_id,
    });
    const isAdmin = roleRow === "admin";
    const isCreator = inv.invited_by === user.id;
    if (!isAdmin || !isCreator) return json({ error: "forbidden" }, 403);

    const { data: scopeRow } = await admin
      .from("scopes")
      .select("name")
      .eq("id", inv.scope_id)
      .maybeSingle();

    const message = buildInviteEmail({
      token,
      teamName: (scopeRow?.name as string | null) ?? null,
      role: inv.role as string | null,
      offline: !!inv.eph_pub,
    });

    try {
      await sendViaSmtp2go(recipient, message, {
        apiKey,
        sender,
        apiUrl: smtpApiUrl,
      });
    } catch (e) {
      await capture(e);
      console.error("smtp2go send failed:", (e as Error).message);
      return json({ error: "send failed" }, 502);
    }
    return json({ ok: true, resolved_via: resolvedVia });
  }),
);
