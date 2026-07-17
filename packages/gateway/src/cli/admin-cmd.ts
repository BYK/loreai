/**
 * `lore admin` — OPERATOR-ONLY commands for the platform maintainer, gated by the
 * `SUPABASE_SERVICE_ROLE_KEY` env var (which only staff hold; it is never shipped
 * or persisted). These perform privileged writes the RLS/tier guards deliberately
 * block for normal users.
 *
 *   lore admin grant <email|orgId> <free|pro|team>
 *
 * Personal upgrade (an email) flips `profiles.tier`; a team upgrade (an org UUID)
 * flips `orgs.tier`. `effective_tier()` reads profiles for personal scopes and
 * orgs for team scopes, so this is the single lever behind entitlement.
 */
import { getServiceRoleClient } from "../supabase";

const USAGE =
  "Usage: lore admin grant <email> <free|pro>   (personal)\n" +
  "       lore admin grant <orgId> <free|team>  (team org)";
// Valid tiers per target type. effective_tier() reads profiles.tier for personal scopes (free/pro)
// and orgs.tier for team scopes (free/team). Cross-pairing (e.g. an email → 'team') writes a tier the
// client can't act on (currentSyncTier maps only pro/max → pro sync) — so we reject it up front.
const PERSONAL_TIERS = new Set(["free", "pro"]);
const TEAM_TIERS = new Set(["free", "team"]);
// A v4/v7 UUID (org id) vs an email address — decides profiles vs orgs. Anchored: an email that
// merely CONTAINS a uuid substring must still route to the personal (profiles) path.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function commandAdmin(
  positionals: string[],
  _values: Record<string, unknown>,
): Promise<void> {
  const sub = positionals[0];
  if (sub !== "grant") return usage();

  const target = positionals[1];
  const tier = positionals[2];
  if (!target || !tier) return usage();

  const isOrg = UUID_RE.test(target);
  const allowed = isOrg ? TEAM_TIERS : PERSONAL_TIERS;
  if (!allowed.has(tier)) {
    console.error(
      isOrg
        ? `Team orgs accept free|team, not "${tier}".`
        : `Personal accounts accept free|pro, not "${tier}".`,
    );
    process.exitCode = 1;
    return;
  }

  const client = getServiceRoleClient();
  if (!client) {
    console.error(
      "This is an operator-only command. Set SUPABASE_SERVICE_ROLE_KEY (staff-only) to use it.",
    );
    process.exitCode = 1;
    return;
  }

  try {
    if (isOrg) {
      // Team: flip orgs.tier by org id.
      const { data, error } = await client
        .from("orgs")
        .update({ tier })
        .eq("id", target)
        .select("id, kind, tier");
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) {
        console.error(`No org found with id ${target}.`);
        process.exitCode = 1;
        return;
      }
      console.log(`Set org ${target} (${data[0].kind}) tier → ${tier}.`);
    } else {
      // Personal: resolve the email → user id via profiles, then flip profiles.tier. Exact match
      // (.eq, not .ilike) — ilike would treat %/_ in the operator's input as wildcards and could
      // silently promote a single unintended match. profiles.email is stored lowercased (0001).
      const email = target.toLowerCase();
      const { data: prof, error: lookupErr } = await client
        .from("profiles")
        .select("id, email")
        .eq("email", email);
      if (lookupErr) throw new Error(lookupErr.message);
      if (!prof || prof.length === 0) {
        console.error(`No account found for email ${target}.`);
        process.exitCode = 1;
        return;
      }
      if (prof.length > 1) {
        console.error(
          `Multiple accounts match ${target} — refusing to guess. Pass the user's org id instead.`,
        );
        process.exitCode = 1;
        return;
      }
      const { data: updated, error: updErr } = await client
        .from("profiles")
        .update({ tier })
        .eq("id", prof[0].id)
        .select("id");
      if (updErr) throw new Error(updErr.message);
      // Confirm the update hit a row — guards against a silent no-op (profile deleted between the
      // lookup and the write) printing a misleading success.
      if (!updated || updated.length === 0) {
        console.error(`No account found for email ${target}.`);
        process.exitCode = 1;
        return;
      }
      console.log(`Set ${prof[0].email} (personal) tier → ${tier}.`);
    }
  } catch (e) {
    console.error(`lore admin: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

function usage(): void {
  console.error(USAGE);
  process.exitCode = 1;
}
