/**
 * Real-Postgres integration harness for the sync migrations + engine.
 *
 * Spins up a disposable Postgres container (via Docker), applies the Supabase
 * shim + supabase/migrations/0001..NNNN, and exposes helpers to run SQL AS a
 * given PostgREST role (anon / authenticated / service_role) with JWT claims —
 * exactly how PostgREST behaves after validating a token. This is what the
 * hand-written mock cannot do: it exercises the REAL RLS policies, triggers,
 * CHECK constraints, type coercion, and quota logic.
 *
 * Gated by callers behind `LORE_INTEGRATION=1` + `dockerAvailable()`.
 */
import { execFile } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client, type ClientConfig } from "pg";

const exec = promisify(execFile);
// Test-only HS256 secret: signs tokens for the throwaway local Postgres only.
// Not a prod secret (prod uses Supabase GoTrue's own secret) and never shipped
// (test/** is excluded from the published package). Env-overridable to make the
// test-only nature explicit.
const JWT_SECRET =
  process.env.LORE_TEST_JWT_SECRET ??
  "lore-integration-test-jwt-secret-min-32-bytes-long";

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/** Mint an HS256 JWT PostgREST will accept (validates against JWT_SECRET). */
function mintJwt(claims: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({ ...claims, iat: Math.floor(Date.now() / 1000) }),
  );
  const sig = b64url(
    createHmac("sha256", JWT_SECRET).update(`${header}.${payload}`).digest(),
  );
  return `${header}.${payload}.${sig}`;
}
const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(
  HERE,
  "..",
  "..",
  "..",
  "..",
  "supabase",
  "migrations",
);
const SHIM = join(HERE, "supabase-shim.sql");

export interface PgHarness {
  client: Client;
  /** Run `fn` inside a transaction as `authenticated` with the given user's JWT. */
  asUser<T>(uid: string, fn: (c: Client) => Promise<T>): Promise<T>;
  asService<T>(fn: (c: Client) => Promise<T>): Promise<T>;
  asAnon<T>(fn: (c: Client) => Promise<T>): Promise<T>;
  /** Create an auth user (fires handle_new_user → profiles). Returns the uid. */
  createUser(email?: string): Promise<string>;
  /** PostgREST base URL (only when started with { postgrest: true }). */
  restUrl?: string;
  /** Mint a JWT for a user (role=authenticated, sub=uid). */
  userJwt(uid: string): string;
  stop(): Promise<void>;
}

export interface HarnessOptions {
  /** Also start PostgREST (for real engine push/pull tests). */
  postgrest?: boolean;
}

export async function dockerAvailable(): Promise<boolean> {
  try {
    await exec("docker", ["info"], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

async function waitForPg(cfg: ClientConfig, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const c = new Client(cfg);
    try {
      await c.connect();
      await c.query("select 1");
      await c.end();
      return;
    } catch (e) {
      await c.end().catch(() => {});
      if (Date.now() > deadline) throw e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

async function waitForRest(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await fetch(`${url}/`, { method: "GET" });
      // PostgREST answers the root with the OpenAPI spec once schema is loaded.
      if (r.status < 500) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline)
      throw new Error("PostgREST did not become ready");
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Start Postgres in Docker, apply shim + all migrations, return a harness. */
export async function startPgHarness(
  opts: HarnessOptions = {},
): Promise<PgHarness> {
  const name = `lore-sync-it-${randomBytes(4).toString("hex")}`;
  const restName = `${name}-rest`;
  const password = "postgres";
  // -P maps the container's 5432 to a random free host port.
  const { stdout } = await exec("docker", [
    "run",
    "-d",
    "--rm",
    "--name",
    name,
    "-e",
    `POSTGRES_PASSWORD=${password}`,
    "-P",
    "postgres:16-alpine",
  ]);
  const containerId = stdout.trim();

  const stop = async () => {
    await exec("docker", ["rm", "-f", restName]).catch(() => {});
    await exec("docker", ["rm", "-f", name]).catch(() => {});
  };

  try {
    // Resolve the mapped host port.
    const { stdout: portOut } = await exec("docker", [
      "inspect",
      "--format",
      '{{ (index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort }}',
      containerId,
    ]);
    const port = Number(portOut.trim());
    const cfg: ClientConfig = {
      host: "127.0.0.1",
      port,
      user: "postgres",
      password,
      database: "postgres",
    };

    await waitForPg(cfg);

    const client = new Client(cfg);
    await client.connect();

    // Apply shim, then every migration in filename order.
    await client.query(readFileSync(SHIM, "utf8"));
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const f of files) {
      await client.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    }

    // Optionally bring up PostgREST in front of this Postgres, so the REAL sync
    // engine (supabase-js → PostgREST) can be exercised end-to-end.
    let restUrl: string | undefined;
    if (opts.postgrest) {
      const { stdout: restOut } = await exec("docker", [
        "run",
        "-d",
        "--rm",
        "--name",
        restName,
        "--add-host",
        "host.docker.internal:host-gateway",
        "-e",
        `PGRST_DB_URI=postgres://authenticator:authenticator@host.docker.internal:${port}/postgres`,
        "-e",
        "PGRST_DB_SCHEMAS=public",
        "-e",
        "PGRST_DB_ANON_ROLE=anon",
        "-e",
        `PGRST_JWT_SECRET=${JWT_SECRET}`,
        "-P",
        "postgrest/postgrest:v12.2.3",
      ]);
      const restId = restOut.trim();
      const { stdout: restPortOut } = await exec("docker", [
        "inspect",
        "--format",
        '{{ (index (index .NetworkSettings.Ports "3000/tcp") 0).HostPort }}',
        restId,
      ]);
      restUrl = `http://127.0.0.1:${restPortOut.trim()}`;
      await waitForRest(restUrl);
    }

    const runAs = async <T>(
      role: string,
      claims: Record<string, unknown> | null,
      fn: (c: Client) => Promise<T>,
    ): Promise<T> => {
      await client.query("begin");
      try {
        await client.query(`set local role ${role}`);
        if (claims) {
          await client.query(
            "select set_config('request.jwt.claims', $1, true)",
            [JSON.stringify(claims)],
          );
        }
        const out = await fn(client);
        await client.query("commit");
        return out;
      } catch (e) {
        await client.query("rollback").catch(() => {});
        throw e;
      }
    };

    return {
      client,
      restUrl,
      userJwt: (uid: string) => mintJwt({ sub: uid, role: "authenticated" }),
      asUser: (uid, fn) =>
        runAs("authenticated", { sub: uid, role: "authenticated" }, fn),
      asService: (fn) => runAs("service_role", { role: "service_role" }, fn),
      asAnon: (fn) => runAs("anon", { role: "anon" }, fn),
      async createUser(email = `u${randomBytes(4).toString("hex")}@test.dev`) {
        const { rows } = await client.query(
          "insert into auth.users (email) values ($1) returning id",
          [email],
        );
        return rows[0].id as string;
      },
      async stop() {
        await client.end().catch(() => {});
        await stop();
      },
    };
  } catch (e) {
    await stop();
    throw e;
  }
}
