/**
 * CLI `lore login` / `lore logout` / `lore whoami` — Folk Lore individual
 * accounts via Supabase Auth.
 *
 *   lore login                 GitHub OAuth — opens a browser when one is
 *                              available, otherwise falls back to a scan-the-QR
 *                              / paste-the-code device flow (auto-detected)
 *   lore login --no-browser    Force the device flow (QR + paste)
 *   lore login --email <addr>  Email one-time code (OTP)
 *   lore logout                Clear the local session
 *   lore whoami                Show the signed-in account
 *
 * Runs without the gateway — talks to Supabase directly. The session is stored
 * locally in the `team_config` table; only the publishable key is shipped.
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import qrcode from "qrcode-terminal";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import {
  clearProviderTokenCache,
  clearSession,
  createSupabaseClient,
  getCurrentUser,
  isLoggedIn,
  loadCachedProviderToken,
  loadPersistedSession,
  persistProviderTokenCache,
  type PersistedSession,
  persistSession,
  sessionToPersisted,
} from "../supabase";

/** GitHub OAuth scopes needed:
 *  - `read:org` — org/team membership mirroring (E-5-a, #827)
 *  - `repo` — list collaborators on private repos (E-5-d, #630)
 *  Collaborator API requires `repo` for private org repos (e.g. getsentry/*).
 */
const OAUTH_SCOPES = "read:org repo";

/** Historical GitHub OAuth App default TTL for read-only tokens (8 hours). */
const GITHUB_PROVIDER_TOKEN_TTL_SECONDS = 8 * 60 * 60;

// ---------------------------------------------------------------------------
// lore login
// ---------------------------------------------------------------------------

export async function commandLogin(
  _positionals: string[],
  values: Record<string, unknown>,
): Promise<void> {
  const existing = loadPersistedSession();
  if (existing) {
    console.log(
      `Already logged in as ${formatIdentity(existing)}. Run "lore logout" first to switch accounts.`,
    );
    return;
  }

  const email = typeof values.email === "string" ? values.email.trim() : "";
  // Use the headless (paste-the-code) GitHub flow when the user asks for it OR
  // when we can't open a local browser that could reach our loopback (SSH,
  // headless server, CI). A QR code is shown either way so a phone can scan it.
  const explicitNoBrowser = !!values["no-browser"];
  const noBrowser = explicitNoBrowser || !canOpenBrowser();

  try {
    if (email) {
      await loginWithEmail(email);
    } else if (noBrowser) {
      if (!explicitNoBrowser) {
        console.log("No local browser detected — using device sign-in.\n");
      }
      await loginWithGitHubManual();
    } else {
      await loginWithGitHub();
    }
  } catch (err) {
    console.error(
      `Login failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
}

// --- Email magic-link / OTP -------------------------------------------------

async function loginWithEmail(email: string): Promise<void> {
  const client = createSupabaseClient();
  const { error } = await client.auth.signInWithOtp({ email });
  if (error) throw new Error(error.message);

  console.log(`Sent a sign-in code to ${email}. Check your inbox.`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let code: string;
  try {
    code = (await rl.question("Enter the code: ")).trim();
  } finally {
    rl.close();
  }
  if (!code) throw new Error("No code entered.");

  // Guard against pasting the magic-link URL / its `?code=` value instead of
  // the numeric OTP — the most common confusion on headless/remote devices.
  if (code.includes("://") || code.includes("code=")) {
    code = extractCodeFromInput(code);
  }
  if (!/^\d{4,12}$/.test(code)) {
    throw new Error(
      "That doesn't look like a sign-in code. You likely received a magic " +
        'link instead — add `{{ .Token }}` to the "Confirm signup" and ' +
        '"Magic Link" email templates in the Supabase dashboard, then run ' +
        "`lore login --email` again and enter the code from the email.",
    );
  }

  // A brand-new email triggers the "signup" confirmation token; a returning
  // email uses the "email" magic-link OTP. Try the common case, then fall back.
  const session = await verifyEmailOtp(client, email, code);
  await finalizeLogin(client, sessionToPersisted(session));
}

/**
 * Verify an email OTP, trying `type: "email"` (returning user) then
 * `type: "signup"` (first-time email). Returns the session or throws.
 */
async function verifyEmailOtp(
  client: SupabaseClient,
  email: string,
  token: string,
) {
  for (const type of ["email", "signup"] as const) {
    const { data, error } = await client.auth.verifyOtp({ email, token, type });
    if (!error && data.session) return data.session;
    // Only fall through to the other token type on an invalid/expired-token
    // error. Surface anything else (network, rate limit) immediately so we
    // don't mask it behind a misleading "token invalid" or fire a redundant
    // second verifyOtp that could compound a rate limit.
    if (error && !isInvalidTokenError(error.message)) {
      throw new Error(error.message);
    }
  }
  throw new Error("Token has expired or is invalid. Request a new code.");
}

/** True when a verifyOtp error is an invalid/expired-token error (vs network). */
function isInvalidTokenError(message: string | undefined): boolean {
  return /expired|invalid|otp|not found|incorrect/i.test(message ?? "");
}

/** Pull an OTP token out of a pasted magic-link URL, if present. */
function extractCodeFromInput(input: string): string {
  try {
    const url = new URL(input);
    // Supabase OTP links may carry the token as `token` or `token_hash`.
    return (
      url.searchParams.get("token") ??
      url.searchParams.get("token_hash") ??
      input
    );
  } catch {
    return input;
  }
}

// --- GitHub OAuth (loopback + PKCE) ----------------------------------------

async function loginWithGitHub(): Promise<void> {
  const client = createSupabaseClient();

  // Bind a one-shot loopback server on an ephemeral port BEFORE requesting the
  // OAuth URL, so we can build a matching redirectTo.
  const { code, redirectTo, done } = await startLoopbackCallback();

  const { data, error } = await client.auth.signInWithOAuth({
    provider: "github",
    // read:org lets us mirror the user's GitHub org/team memberships into Lore teams at login
    // (E-5-a, #827). Verified server-side via the github-provision Edge Function using the returned
    // provider_token — the client never asserts memberships.
    options: { skipBrowserRedirect: true, redirectTo, scopes: OAUTH_SCOPES },
  });
  if (error || !data.url) {
    done.close();
    throw new Error(error?.message ?? "Could not start GitHub OAuth.");
  }

  console.log("Opening your browser to sign in with GitHub…");
  console.log("If it doesn't open, scan this or visit the URL below:\n");
  await showAuthUrl(data.url);
  openBrowser(data.url);

  const oauthCode = await code; // resolves when the browser hits the callback
  const session = await exchangeOAuthCode(client, oauthCode);

  await finalizeLogin(client, sessionToPersisted(session));
  await provisionGitHubTeams(client, session.provider_token);
}

/**
 * E-5-d (#630): obtain a GitHub `provider_token` for a read-from-GitHub capability
 * (e.g. `lore team discover`). Checks the disk cache first; if the cached token is
 * still valid, returns it (no browser). Otherwise runs the OAuth flow:
 *
 *   - When a local browser is available: loopback callback (127.0.0.1:ephemeral).
 *     While waiting, also listens on stdin for a paste — hybrid mode covers users
 *     who opened the URL on another device even when the loopback started.
 *   - When remote/headless (`--no-browser` or `!canOpenBrowser()`): paste-code flow
 *     (fixed `http://127.0.0.1/callback`, user copies the code from the redirect URL).
 *
 * Returns the fresh token plus the authed client bound to the refreshed session.
 * Throws if the grant yields no provider_token (e.g. an email-only account).
 * Also refreshes the persisted session and caches the provider_token as a side effect.
 */
export async function acquireGitHubProviderToken(opts?: {
  noBrowser?: boolean;
}): Promise<{
  client: SupabaseClient;
  providerToken: string;
}> {
  // Try the disk cache first — avoids re-prompting OAuth within the token TTL.
  const cached = loadCachedProviderToken();
  if (cached) {
    const client = createSupabaseClient();
    // Restore the persisted session so the returned client is usable. If the
    // session can't be restored (e.g. refresh_token expired or revoked), the
    // EF call would 401 with a confusing error — fall through to OAuth instead
    // so the user gets a fresh re-auth.
    const persisted = loadPersistedSession();
    if (persisted) {
      const { error: setErr } = await client.auth.setSession({
        access_token: persisted.access_token,
        refresh_token: persisted.refresh_token,
      });
      if (setErr) {
        // Session unrecoverable — discard the cache and run OAuth.
        clearProviderTokenCache();
      } else {
        return { client, providerToken: cached.provider_token };
      }
    } else {
      // No session to bind the token to — discard the cache.
      clearProviderTokenCache();
    }
  }

  // No cached token — run OAuth.
  const noBrowser = opts?.noBrowser ?? !canOpenBrowser();
  if (noBrowser) return acquireGitHubProviderTokenPaste();

  return acquireGitHubProviderTokenLoopback();
}

/**
 * Loopback + hybrid-stdin variant: sets up the 127.0.0.1 callback and simultaneously
 * watches stdin for a paste. This covers the case where a user's browser is on a
 * different machine — the loopback never fires, but they can paste the code from
 * the redirect URL on that machine.
 */
async function acquireGitHubProviderTokenLoopback(): Promise<{
  client: SupabaseClient;
  providerToken: string;
}> {
  const client = createSupabaseClient();
  const { code: cbCode, redirectTo, done } = await startLoopbackCallback();
  const { data, error } = await client.auth.signInWithOAuth({
    provider: "github",
    options: { skipBrowserRedirect: true, redirectTo, scopes: OAUTH_SCOPES },
  });
  if (error || !data.url) {
    done.close();
    throw new Error(error?.message ?? "Could not start GitHub OAuth.");
  }

  console.log("Opening your browser to authorize GitHub access…");
  console.log("If it doesn't open, scan this or visit the URL below:\n");
  await showAuthUrl(data.url);
  openBrowser(data.url);
  console.log(
    "If you authorized from another device, paste the code (or redirect URL) here:\n",
  );

  // Race: loopback callback vs stdin paste. Empty stdin input is ignored so a
  // user reflexively pressing Enter can't win the race with a blank code.
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const emptyInput = new Error("__skip__");
  const pastePromise = rl.question("").then(
    (line) => {
      const code = extractAuthCode(line.trim());
      if (!code) throw emptyInput;
      return code;
    },
    () => {
      // loser-side rejection when Node rejects a pending question on close —
      // swallow so we don't surface an unhandled rejection.
      throw emptyInput;
    },
  );
  let oauthCode: string;
  try {
    oauthCode = await Promise.race([cbCode, pastePromise]);
  } catch (e) {
    if (e === emptyInput) throw new Error("No code provided.");
    throw e;
  } finally {
    rl.close();
    done.close();
  }

  const session = await exchangeOAuthCode(client, oauthCode);
  await finalizeLogin(client, sessionToPersisted(session));
  const providerToken = session.provider_token;
  if (!providerToken) throw new Error("GitHub did not return an access token.");
  // GitHub provider_tokens issued via Supabase don't carry an explicit expiry;
  // bound the cache by whichever runs out first: the access_token expiry, or
  // 8h (historical GitHub OAuth App default for read-only flows).
  const sessionTtl = session.expires_at
    ? session.expires_at - Math.floor(Date.now() / 1000)
    : undefined;
  const ttl = Math.min(
    sessionTtl ?? GITHUB_PROVIDER_TOKEN_TTL_SECONDS,
    GITHUB_PROVIDER_TOKEN_TTL_SECONDS,
  );
  persistProviderTokenCache(providerToken, ttl);
  return { client, providerToken };
}

/**
 * Paste-code variant for remote/headless machines. Same PKCE concept as the
 * loopback path, but uses the fixed `http://127.0.0.1/callback` redirect (the
 * browser lands on a dead page — user copies the `code=` from the URL bar).
 */
async function acquireGitHubProviderTokenPaste(): Promise<{
  client: SupabaseClient;
  providerToken: string;
}> {
  const client = createSupabaseClient();

  const redirectTo = "http://127.0.0.1/callback";
  const { data, error } = await client.auth.signInWithOAuth({
    provider: "github",
    options: { skipBrowserRedirect: true, redirectTo, scopes: OAUTH_SCOPES },
  });
  if (error || !data.url) {
    throw new Error(error?.message ?? "Could not start GitHub OAuth.");
  }

  console.log("Scan this with your phone, or open the URL on any device:\n");
  await showAuthUrl(data.url);
  console.log(
    "After authorizing, your browser will try to open " +
      `${redirectTo}?code=…\n` +
      "That page won't load — copy the value after `code=` (or paste the " +
      "whole URL) here.\n",
  );

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let pasted: string;
  try {
    pasted = (await rl.question("Paste the code (or redirect URL): ")).trim();
  } finally {
    rl.close();
  }
  const oauthCode = extractAuthCode(pasted);
  if (!oauthCode) throw new Error("No code provided.");

  const session = await exchangeOAuthCode(client, oauthCode);
  await finalizeLogin(client, sessionToPersisted(session));
  const providerToken = session.provider_token;
  if (!providerToken) throw new Error("GitHub did not return an access token.");
  const ttl = session.expires_at
    ? session.expires_at - Math.floor(Date.now() / 1000)
    : undefined;
  persistProviderTokenCache(providerToken, ttl);
  return { client, providerToken };
}

// --- GitHub OAuth, headless (manual code paste, no loopback) ----------------

/**
 * Headless GitHub login for remote/SSH boxes where a browser can't reach this
 * machine's localhost. The CLI prints the OAuth URL; the user opens it on ANY
 * device, authorizes, and pastes back the `code` from the redirect URL. Works
 * because the PKCE code_verifier lives in THIS process's memory — so the same
 * client instance can exchange the pasted code regardless of which device's
 * browser completed the sign-in.
 */
async function loginWithGitHubManual(): Promise<void> {
  const client = createSupabaseClient();

  // A stable, allow-listed redirect. The browser will land on a page that does
  // not load on a remote box, but the address bar still shows `?code=…`.
  const redirectTo = "http://127.0.0.1/callback";
  const { data, error } = await client.auth.signInWithOAuth({
    provider: "github",
    options: { skipBrowserRedirect: true, redirectTo, scopes: OAUTH_SCOPES },
  });
  if (error || !data.url) {
    throw new Error(error?.message ?? "Could not start GitHub OAuth.");
  }

  console.log("Scan this with your phone, or open the URL on any device:\n");
  await showAuthUrl(data.url);
  console.log(
    "After authorizing, your browser will try to open " +
      `${redirectTo}?code=…\n` +
      "That page won't load — copy the value after `code=` (or paste the " +
      "whole URL) here.\n",
  );

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let pasted: string;
  try {
    pasted = (await rl.question("Paste the code (or redirect URL): ")).trim();
  } finally {
    rl.close();
  }
  const oauthCode = extractAuthCode(pasted);
  if (!oauthCode) throw new Error("No code provided.");

  const { data: sess, error: exchErr } =
    await client.auth.exchangeCodeForSession(oauthCode);
  if (exchErr) throw new Error(exchErr.message);
  if (!sess.session) throw new Error("No session returned after OAuth.");

  await finalizeLogin(client, sessionToPersisted(sess.session));
  await provisionGitHubTeams(client, sess.session.provider_token);
}

/**
 * Best-effort: mirror the user's GitHub org/team memberships into Lore teams via the
 * `github-provision` Edge Function (E-5-a, #827). The OAuth `provider_token` is only present on the
 * fresh session (not persisted, not re-issued on refresh), so provisioning runs at login time only.
 * A failure NEVER fails login — it simply retries on the next login.
 */
async function provisionGitHubTeams(
  client: SupabaseClient,
  providerToken?: string | null,
): Promise<void> {
  if (!providerToken) return; // no read:org grant (older session / non-github login)
  try {
    const { data, error } = await client.functions.invoke("github-provision", {
      body: { provider_token: providerToken },
    });
    if (error) return; // best-effort — Edge Function not deployed, GitHub error, etc.
    const teams = (data as { teams?: number } | null)?.teams ?? 0;
    if (teams > 0) {
      console.log(
        `Synced ${teams} GitHub team${teams === 1 ? "" : "s"} to Lore.`,
      );
    }
  } catch {
    // Best-effort — provisioning retries on next login.
  }
}

/**
 * Exchange an OAuth code for a session, returning the full `Session` object.
 * Shared by all OAuth paths (loopback, paste, hybrid) so the provider_token
 * extraction and expiry logic is in one place.
 */
async function exchangeOAuthCode(
  client: SupabaseClient,
  oauthCode: string,
): Promise<Session> {
  const { data, error } = await client.auth.exchangeCodeForSession(oauthCode);
  if (error) throw new Error(error.message);
  if (!data.session) throw new Error("No session returned after OAuth.");
  return data.session;
}

/** Pull the OAuth `code` out of a pasted redirect URL, or return the raw code. */
function extractAuthCode(input: string): string {
  try {
    const url = new URL(input);
    return url.searchParams.get("code") ?? input;
  } catch {
    return input;
  }
}

interface LoopbackHandle {
  /** Resolves with the `code` query param once the browser hits /callback. */
  code: Promise<string>;
  /** The loopback redirect URL to pass to Supabase. */
  redirectTo: string;
  /** The underlying server (close on error). */
  done: { close: () => void };
}

/** Start a localhost HTTP server that captures the OAuth `?code=` callback. */
function startLoopbackCallback(): Promise<LoopbackHandle> {
  return new Promise((resolveHandle, rejectHandle) => {
    let settle: (code: string) => void;
    let fail: (err: Error) => void;
    const code = new Promise<string>((res, rej) => {
      settle = res;
      fail = rej;
    });

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const err = url.searchParams.get("error_description");
      const got = url.searchParams.get("code");
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:3rem;text-align:center">${
          got
            ? "<h2>You're signed in to Folk Lore.</h2><p>You can close this tab and return to the terminal.</p>"
            : `<h2>Sign-in failed.</h2><p>${escapeHtml(err ?? "No authorization code received.")}</p>`
        }</body>`,
      );
      // Give the response a tick to flush before closing the server.
      setTimeout(() => server.close(), 50);
      clearTimeout(timer);
      if (got) settle(got);
      else fail(new Error(err ?? "No authorization code received."));
    });

    // 10-minute safety timeout.
    const timer = setTimeout(
      () => {
        server.close();
        fail(new Error("Timed out waiting for the browser callback."));
      },
      10 * 60 * 1000,
    );
    timer.unref?.();

    server.on("error", rejectHandle);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        rejectHandle(new Error("Could not bind a loopback callback port."));
        return;
      }
      resolveHandle({
        code,
        redirectTo: `http://127.0.0.1:${addr.port}/callback`,
        done: { close: () => server.close() },
      });
    });
  });
}

// ---------------------------------------------------------------------------
// lore logout
// ---------------------------------------------------------------------------

export async function commandLogout(): Promise<void> {
  const existing = loadPersistedSession();
  if (!existing) {
    console.log("Not logged in.");
    return;
  }
  // Best-effort server-side sign-out; always clear the local session.
  try {
    const client = createSupabaseClient();
    await client.auth.setSession({
      access_token: existing.access_token,
      refresh_token: existing.refresh_token,
    });
    await client.auth.signOut();
  } catch {
    // Ignore network/auth errors — local logout is what matters.
  }
  clearSession();
  console.log("Logged out.");
}

// ---------------------------------------------------------------------------
// lore whoami
// ---------------------------------------------------------------------------

export async function commandWhoami(
  _positionals: string[],
  values: Record<string, unknown>,
): Promise<void> {
  const verify = !!values.verify;
  // When verifying, a locally-persisted session that the server rejects
  // (expired/revoked refresh token) is dead — clear it so the user isn't stuck
  // seeing "Already logged in" from `lore login` until a manual `lore logout`.
  const hadSession = isLoggedIn();
  const user = await getCurrentUser({ verify });
  if (!user) {
    if (verify && hadSession) {
      clearSession();
      console.log('Session expired. Run "lore login" to sign in again.');
    } else {
      console.log('Not logged in. Run "lore login" to sign in.');
    }
    process.exitCode = 1;
    return;
  }
  console.log(formatIdentity(user));
  if (values.json) {
    console.log(
      JSON.stringify(
        {
          user_id: user.user_id,
          email: user.email,
          github_login: user.github_login,
          display_name: user.display_name,
        },
        null,
        2,
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Persist the session, fetch the profile row (confirms RLS), print identity. */
async function finalizeLogin(
  client: SupabaseClient,
  session: PersistedSession,
): Promise<void> {
  persistSession(session);

  // Fetch the auto-provisioned profile (RLS scopes it to us). Best-effort —
  // a failure here doesn't undo a successful login.
  try {
    const { data } = await client
      .from("profiles")
      .select("github_login, display_name, email")
      .eq("id", session.user_id)
      .maybeSingle();
    if (data) {
      persistSession({
        ...session,
        github_login: data.github_login ?? session.github_login,
        display_name: data.display_name ?? session.display_name,
        email: data.email ?? session.email,
      });
    }
  } catch {
    // Ignore — profile fetch is informational.
  }

  console.log(
    `Signed in as ${formatIdentity(loadPersistedSession() ?? session)}.`,
  );
}

function formatIdentity(s: PersistedSession): string {
  if (s.github_login) return `@${s.github_login}`;
  if (s.email) return s.email;
  if (s.display_name) return s.display_name;
  return s.user_id || "unknown";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Heuristic: can we open a browser ON THIS machine that could reach our
 * loopback callback? False for SSH sessions, headless Linux (no display), and
 * CI — in those cases the user's browser is elsewhere, so we use the
 * scan-the-QR / paste-the-code device flow instead. `LORE_NO_BROWSER=1`
 * forces it off explicitly.
 */
export function canOpenBrowser(): boolean {
  const env = process.env;
  if (env.LORE_NO_BROWSER === "1" || env.LORE_NO_BROWSER === "true") {
    return false;
  }
  if (env.CI) return false;
  // SSH session → the user's browser is on another machine; a 127.0.0.1
  // callback on THIS host is unreachable from there.
  if (env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT) return false;
  // Headless Linux: no X11 / Wayland display means nothing to open. WSL is an
  // exception — it can launch the Windows browser and localhost is forwarded.
  if (
    process.platform === "linux" &&
    !env.DISPLAY &&
    !env.WAYLAND_DISPLAY &&
    !env.WSL_DISTRO_NAME
  ) {
    return false;
  }
  return true;
}

/** Print a scannable terminal QR code for `url`, followed by the raw URL. */
async function showAuthUrl(url: string): Promise<void> {
  try {
    // Lowest error-correction level → fewest modules → smallest QR for a given
    // (long) auth URL. `small: true` then renders it with half-height blocks.
    qrcode.setErrorLevel("L");
    const qr = await new Promise<string>((resolve) => {
      qrcode.generate(url, { small: true }, resolve);
    });
    console.log(qr);
  } catch {
    // QR rendering is a nicety — never block login on it.
  }
  console.log(`  ${url}\n`);
}

/** Open a URL in the user's default browser (best-effort, non-blocking). */
function openBrowser(url: string): void {
  const platform = process.platform;
  const cmd =
    platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {
      /* Browser open is best-effort; the URL was already printed. */
    });
    child.unref();
  } catch {
    // Ignore — the URL is printed for manual navigation.
  }
}
