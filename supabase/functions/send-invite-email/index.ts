// E-5-e (#630/#827): send-invite-email Edge Function. Emails a team invitee their join link via
// SMTP2GO. Authorization is anchored on the invite TOKEN, not client-supplied scope/role: the caller
// must be an admin of the invite's scope AND the pending invite must exist (looked up service-role),
// so this can never be used as an open email-spam relay — you can only email an invite that exists
// for a team you administer, to one recipient per call.
//
// Deploy (not auto-deployed): `supabase functions deploy send-invite-email`. Requires the
// SMTP2GO_API_KEY Function secret; SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are
// injected by the platform. INVITE_SENDER defaults to keeper@withlore.ai; SMTP2GO_API_URL optional.
import { createClient } from "npm:@supabase/supabase-js@2";
import { buildInviteEmail, capabilityOf, sendViaSmtp2go } from "./send.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Conservative RFC-ish email shape check — the recipient is admin-supplied, but we still guard.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

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
  const apiUrl = Deno.env.get("SMTP2GO_API_URL") ?? undefined;

  // Verify the caller's JWT → user id (never trust a client-supplied identity).
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
  };
  const token = typeof body.token === "string" ? body.token : "";
  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (!token) return json({ error: "missing token" }, 400);
  if (!email || !EMAIL_RE.test(email))
    return json({ error: "invalid email" }, 400);

  // An offline invite token is `<capability>.<base64url(secret)>`; only the capability part is stored
  // in pending_invites.token (mirrors acceptTeamInvite). Look up by the capability, but email the
  // FULL token — the invitee needs the secret suffix to unwrap the DEK.
  const capability = capabilityOf(token);

  // Authorize on the TOKEN: resolve the invite service-role, then confirm the caller is an admin of
  // its scope. Scope/role/team_name come from the row, never from client input — no spam relay.
  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: inv, error: invErr } = await admin
    .from("pending_invites")
    .select("scope_id, role, invited_by, eph_pub, expires_at")
    .eq("token", capability)
    .maybeSingle();
  if (invErr) {
    console.error("pending_invites read failed:", invErr.message);
    return json({ error: "lookup failed" }, 500);
  }
  // Generic 404 whether the token is absent or expired — never disclose which.
  if (!inv || new Date(inv.expires_at as string).getTime() <= Date.now())
    return json({ error: "invite not found" }, 404);

  // The caller must be an ADMIN of the invite's scope. Check via scope_role() with the caller JWT
  // (RLS-safe; resolves auth.uid()). Belt-and-suspenders: also require they created the invite.
  const { data: roleRow } = await userClient.rpc("scope_role", {
    p_scope: inv.scope_id,
  });
  const isAdmin = roleRow === "admin";
  const isCreator = inv.invited_by === user.id;
  if (!isAdmin || !isCreator) return json({ error: "forbidden" }, 403);

  // Look up the team name for the email copy (service-role read; best-effort).
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
    await sendViaSmtp2go(email, message, { apiKey, sender, apiUrl });
  } catch (e) {
    console.error("smtp2go send failed:", (e as Error).message);
    return json({ error: "send failed" }, 502);
  }
  return json({ ok: true });
});
