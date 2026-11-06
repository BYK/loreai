import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type PgHarness, startPgHarness } from "./helpers/pg-harness";

function dockerReady(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

const enabled = process.env.LORE_INTEGRATION === "1" && dockerReady();
const bundle = { code: "" };
const state = {} as { database: PgHarness };

beforeAll(async () => {
  if (!enabled) return;
  state.database = await startPgHarness();
  // Supabase grants its service role table access; BYPASSRLS alone does not
  // grant SELECT in the minimal test shim. Caller roles receive no new grants.
  await state.database.client.query(
    "grant select on public.pending_invites, public.scopes to service_role",
  );
  const result = await build({
    entryPoints: [
      fileURLToPath(
        new URL(
          "../../../supabase/functions/send-invite-email/index.ts",
          import.meta.url,
        ),
      ),
    ],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    external: ["npm:@supabase/supabase-js@2", "@sentry/deno"],
  });
  bundle.code = result.outputFiles[0].text;
}, 180_000);

afterAll(async () => {
  if (state.database) await state.database.stop();
});

function invitationHandler(
  admin: string,
  githubId: number,
  publicEmail: string | null,
) {
  const h = state.database;
  const delivered: string[] = [];
  const lookups: string[] = [];
  const service = {
    rpc: async (name: string, args: { p_github_ids: number[] }) => {
      expect(name).toBe("lore_emails_for_github_ids");
      lookups.push("private-email");
      const result = await h.asService((client) =>
        client.query(
          "select * from public.lore_emails_for_github_ids($1::bigint[])",
          [args.p_github_ids],
        ),
      );
      return { data: result.rows, error: null };
    },
    from: (table: string) => ({
      select: () => ({
        eq: (column: string, value: string) => ({
          maybeSingle: async () => {
            // Keep authorization and invite contents in the real database; only the
            // Edge SDK transport is adapted to the disposable Postgres harness.
            const result = await h.asService((client) => {
              if (table === "pending_invites" && column === "token")
                return client.query(
                  "select * from public.pending_invites where token = $1",
                  [value],
                );
              if (table === "scopes" && column === "id")
                return client.query(
                  "select name from public.scopes where id = $1",
                  [value],
                );
              throw new Error("Unexpected invitation query");
            });
            return { data: result.rows[0] ?? null, error: null };
          },
        }),
      }),
    }),
  };
  const caller = {
    auth: {
      getUser: async () => ({ data: { user: { id: admin } }, error: null }),
    },
    rpc: async (name: string, args: { p_scope: string }) => {
      expect(name).toBe("scope_role");
      const result = await h.asUser(admin, (client) =>
        client.query("select public.scope_role($1) as role", [args.p_scope]),
      );
      return { data: result.rows[0].role, error: null };
    },
  };
  const env: Record<string, string> = {
    SUPABASE_URL: "https://account.example.test",
    SUPABASE_ANON_KEY: "fixture-anon",
    SUPABASE_SERVICE_ROLE_KEY: "fixture-service",
    SMTP2GO_API_KEY: "fixture-smtp",
    SMTP2GO_API_URL: "https://smtp.example.test/send",
    GITHUB_API_URL: "https://github.example.test",
  };
  const handlers: Array<(request: Request) => Promise<Response>> = [];
  runInNewContext(bundle.code, {
    require: (id: string) => {
      if (id === "npm:@supabase/supabase-js@2")
        return {
          createClient: (_url: string, key: string) =>
            key === "fixture-service" ? service : caller,
        };
      if (id === "@sentry/deno")
        return {
          init() {},
          setTag() {},
          isInitialized: () => true,
          withScope: (run: (scope: { setTag: () => void }) => void) =>
            run({ setTag() {} }),
          captureException() {},
          flush: async () => true,
        };
      throw new Error("Unexpected invitation dependency");
    },
    Deno: {
      env: { get: (key: string) => env[key] },
      serve: (handler: (request: Request) => Promise<Response>) =>
        handlers.push(handler),
    },
    Request,
    Response,
    Headers,
    URL,
    console,
    fetch: async (url: string, init: RequestInit) => {
      if (url === "https://github.example.test/users/genuine-contributor") {
        lookups.push("github");
        return Response.json({ id: githubId, email: publicEmail });
      }
      if (url === "https://smtp.example.test/send") {
        const body = JSON.parse(init.body as string) as { to: string[] };
        delivered.push(...body.to);
        return Response.json({ data: { succeeded: 1 } });
      }
      throw new Error("Unexpected invitation transport");
    },
  });
  return {
    delivered,
    lookups,
    request: (token: string) =>
      handlers[0](
        new Request(
          "https://account.example.test/functions/v1/send-invite-email",
          {
            method: "POST",
            headers: {
              authorization: "Bearer fixture-admin",
              "content-type": "application/json",
            },
            body: JSON.stringify({
              token,
              github_login: "genuine-contributor",
              provider_token: "fixture-github-token",
            }),
          },
        ),
      ),
  };
}

async function mintInvitation(role: "viewer" | "editor", offline = false) {
  const h = state.database;
  const admin = await h.createUser();
  const { rows: orgs } = await h.client.query(
    "insert into public.orgs (owner_user_id) values ($1) returning id",
    [admin],
  );
  const { rows: scopes } = await h.client.query(
    "insert into public.scopes (org_id, kind, name) values ($1, 'team', 'Token fixture') returning id",
    [orgs[0].id],
  );
  await h.client.query(
    "insert into public.org_members (org_id, user_id, role) values ($1, $2, 'owner')",
    [orgs[0].id, admin],
  );
  await h.client.query(
    "insert into public.scope_members (scope_id, user_id, role) values ($1, $2, 'admin')",
    [scopes[0].id, admin],
  );
  const { rows } = await h.asUser(admin, (client) =>
    client.query(
      "select public.create_scope_invite($1, $2, null, $3) as token",
      [
        scopes[0].id,
        role,
        offline ? Buffer.alloc(32, 2).toString("base64") : null,
      ],
    ),
  );
  return {
    admin,
    scope: scopes[0].id as string,
    capability: rows[0].token as string,
  };
}

describe.skipIf(!enabled)(
  "database-backed GitHub invitation recipients",
  () => {
    test.each(["missing", "expired", "noncreator", "nonadmin"] as const)(
      "%s invitations cannot probe private GitHub-linked accounts",
      async (denial) => {
        const h = state.database;
        const invitation = await mintInvitation("viewer");
        const caller =
          denial === "missing" || denial === "noncreator"
            ? await h.createUser()
            : invitation.admin;
        if (denial === "expired")
          await h.client.query(
            "update public.pending_invites set expires_at = now() - interval '1 day' where token = $1",
            [invitation.capability],
          );
        if (denial === "noncreator")
          await h.client.query(
            "insert into public.scope_members (scope_id, user_id, role) values ($1, $2, 'admin')",
            [invitation.scope, caller],
          );
        if (denial === "nonadmin")
          await h.client.query(
            "update public.scope_members set role = 'viewer' where scope_id = $1 and user_id = $2",
            [invitation.scope, caller],
          );
        const githubId =
          730001 +
          ["missing", "expired", "noncreator", "nonadmin"].indexOf(denial);
        const recipient = await h.createUser(
          `private-${githubId}@example.test`,
        );
        await h.client.query(
          "insert into auth.identities (provider_id, user_id, provider) values ($1, $2, 'github')",
          [String(githubId), recipient],
        );
        const bodies: unknown[] = [];
        const statuses: number[] = [];
        const work: string[] = [];
        for (const target of [githubId, githubId + 100]) {
          const handler = invitationHandler(caller, target, null);
          const response = await handler.request(
            denial === "missing" ? "f".repeat(64) : invitation.capability,
          );
          bodies.push(await response.json());
          statuses.push(response.status);
          work.push(...handler.lookups);
          expect(handler.delivered).toEqual([]);
        }
        expect(bodies[0]).toEqual(bodies[1]);
        expect(statuses).toEqual(
          denial === "missing" || denial === "expired"
            ? [404, 404]
            : [403, 403],
        );
        expect(work).toEqual([]);
      },
    );

    test.each(
      (["viewer", "editor"] as const).flatMap((role) =>
        [
          "$(printf injected)",
          "key;printf injected",
          "`printf injected`",
          "\ncommand",
        ].map((suffix) => ({ role, suffix })),
      ),
    )(
      "rejects an unchecked $role invite suffix before email delivery ($suffix)",
      async ({ role, suffix }) => {
        const { admin, capability } = await mintInvitation(role);
        const handler = invitationHandler(
          admin,
          720001,
          "genuine-public@example.test",
        );
        const response = await handler.request(`${capability}.${suffix}`);
        // Exercise a real, authorized pending invite: a prefix-only lookup would
        // otherwise deliver the attacker's full command through genuine Lore mail.
        expect(handler.delivered).toEqual([]);
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
          error: "invalid invite token",
        });
      },
    );

    test.each(
      (["viewer", "editor"] as const).flatMap((role) =>
        [false, true].map((offline) => ({ role, offline })),
      ),
    )(
      "delivers a minted $role invitation (offline=$offline)",
      async ({ role, offline }) => {
        const { admin, capability } = await mintInvitation(role, offline);
        const token = offline
          ? `${capability}.${Buffer.alloc(32, 1).toString("base64url")}`
          : capability;
        const handler = invitationHandler(
          admin,
          720002,
          "genuine-public@example.test",
        );
        const response = await handler.request(token);
        expect(response.status).toBe(200);
        expect(handler.delivered).toEqual(["genuine-public@example.test"]);
      },
    );

    test.each([
      { role: "viewer", linked: false, publicEmail: null, githubId: 710001 },
      { role: "editor", linked: false, publicEmail: null, githubId: 710002 },
      {
        role: "viewer",
        linked: false,
        publicEmail: "genuine-public@example.test",
        githubId: 710003,
      },
      {
        role: "editor",
        linked: false,
        publicEmail: "genuine-public@example.test",
        githubId: 710004,
      },
      { role: "viewer", linked: true, publicEmail: null, githubId: 710005 },
      { role: "editor", linked: true, publicEmail: null, githubId: 710006 },
    ])(
      "an administrator's $role invite ignores forged metadata ($githubId)",
      async ({ role, linked, publicEmail, githubId }) => {
        const h = state.database;
        const admin = await h.createUser();
        const attackerEmail = `attacker-${githubId}@example.test`;
        const attacker = await h.createUser(attackerEmail);
        await h.client.query(
          "update auth.users set raw_user_meta_data = $1::jsonb where id = $2",
          [JSON.stringify({ provider_id: String(githubId) }), attacker],
        );
        const linkedEmail = `genuine-${githubId}@example.test`;
        if (linked) {
          const genuine = await h.createUser(linkedEmail);
          await h.client.query(
            "insert into auth.identities (provider_id, user_id, provider) values ($1, $2, 'github')",
            [String(githubId), genuine],
          );
        }
        const { rows: orgs } = await h.client.query(
          "insert into public.orgs (owner_user_id) values ($1) returning id",
          [admin],
        );
        const { rows: scopes } = await h.client.query(
          "insert into public.scopes (org_id, kind, name) values ($1, 'team', 'Invitation fixture') returning id",
          [orgs[0].id],
        );
        const scope = scopes[0].id as string;
        await h.client.query(
          "insert into public.org_members (org_id, user_id, role) values ($1, $2, 'owner')",
          [orgs[0].id, admin],
        );
        await h.client.query(
          "insert into public.scope_members (scope_id, user_id, role) values ($1, $2, 'admin')",
          [scope, admin],
        );
        const { rows } = await h.asUser(admin, (client) =>
          client.query("select public.create_scope_invite($1, $2) as token", [
            scope,
            role,
          ]),
        );
        const handler = invitationHandler(admin, githubId, publicEmail);
        const response = await handler.request(rows[0].token);
        expect(handler.delivered).not.toContain(attackerEmail);
        expect(handler.delivered).toEqual(
          linked ? [linkedEmail] : publicEmail ? [publicEmail] : [],
        );
        expect(response.status).toBe(linked || publicEmail ? 200 : 404);
        expect(await response.text()).not.toContain(attackerEmail);
        expect(
          (
            await h.client.query(
              "select role from public.pending_invites where token = $1",
              [rows[0].token],
            )
          ).rows,
        ).toEqual([{ role }]);
      },
    );
  },
);
