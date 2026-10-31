import { randomBytes } from "node:crypto";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import type { GatewayConfig } from "./config";
import { errorResponse, json, requestIsHosted } from "./folk-access";
import { isLoopbackAddress } from "./management-access";
import {
  accountDataClient,
  captureLoginRevision,
  createSupabaseClient,
  persistSession,
  sessionToPersisted,
  updateSessionProfile,
} from "./supabase";
import {
  OAUTH_SCOPES,
  cacheProviderTokenFromSession,
  provisionGitHubTeams,
  verifyEmailInput,
} from "./cli/login";

type Attempt = {
  client: SupabaseClient;
  controller: AbortController;
  signal?: AbortSignal;
  revision: string | null;
  expires: number;
  email?: string;
  busy: boolean;
  committed: boolean;
};

const attempts = new Map<string, Attempt>();
const completedAttempts = new Map<string, Attempt>();
const lifetime = 10 * 60_000;
const maxOperations = 16;
const operationTimeout = 30_000;
const operations = { login: 0, optional: 0 };
const maxBodyReads = 16;
const bodyReadTimeout = 30_000;
const startBodies = new Set<AbortController>();
let liveBodyReads = 0;

async function runOperation<T>(
  attempt: Pick<Attempt, "controller" | "signal">,
  requestSignal: AbortSignal | undefined,
  operation: () => PromiseLike<T>,
  kind: "login" | "optional" = "login",
): Promise<T> {
  if (operations[kind] >= maxOperations) throw new Error("Sign-in busy");
  const signal = AbortSignal.any([
    attempt.controller.signal,
    AbortSignal.timeout(operationTimeout),
    ...(requestSignal ? [requestSignal] : []),
  ]);
  if (signal.aborted) throw new Error("Sign-in cancelled");
  attempt.signal = signal;
  operations[kind]++;
  // Capacity belongs to the underlying work, even when abort wins the race.
  const work = Promise.resolve()
    .then(() => {
      if (signal.aborted) throw new Error("Sign-in cancelled");
      return operation();
    })
    .finally(() => {
      operations[kind]--;
    });
  let onAbort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      attempt.controller.abort();
      reject(new Error("Sign-in cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (attempt.signal === signal) attempt.signal = undefined;
  }
}

function retireAttempts(): void {
  for (const attempt of attempts.values()) attempt.controller.abort();
  attempts.clear();
}

async function readBody(
  req: Request,
  controller: AbortController,
): Promise<Record<string, unknown> | null> {
  if (
    !req.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  )
    return null;
  const reader = req.body?.getReader();
  if (!reader) return null;
  if (liveBodyReads >= maxBodyReads) {
    reader.releaseLock();
    return null;
  }
  liveBodyReads++;
  const signal = AbortSignal.any([
    req.signal,
    controller.signal,
    AbortSignal.timeout(bodyReadTimeout),
  ]);
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytes = 0;
  const work = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        // Empty chunks do not advance the byte limit and can starve timers.
        if (value.byteLength === 0) {
          controller.abort();
          await reader.cancel();
          return null;
        }
        bytes += value.byteLength;
        if (bytes > 8192) {
          await reader.cancel();
          return null;
        }
        chunks.push(decoder.decode(value, { stream: true }));
      }
      chunks.push(decoder.decode());
      const body: unknown = JSON.parse(chunks.join(""));
      return body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : null;
    } catch {
      return null;
    } finally {
      reader.releaseLock();
    }
  })();
  let onAbort = () => {};
  const aborted = new Promise<null>((resolve) => {
    onAbort = () => resolve(null);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
    // A hostile reader may ignore cancellation. Retain its slot until both
    // the read and cancellation settle, rather than admitting replacement work.
    const cancellation = signal.aborted
      ? reader.cancel().catch(() => {})
      : Promise.resolve();
    void Promise.allSettled([work, cancellation]).then(() => {
      liveBodyReads--;
    });
  }
}

function cleanAttempts(): void {
  for (const [id, attempt] of attempts) {
    if (attempt.expires <= Date.now()) {
      attempt.controller.abort();
      attempts.delete(id);
    }
  }
  for (const [id, attempt] of completedAttempts) {
    if (!attempt.busy && attempt.expires <= Date.now())
      completedAttempts.delete(id);
  }
}

let startGeneration = 0;

function newAttempt(revision: string | null): [string, Attempt] {
  cleanAttempts();
  if (attempts.size + completedAttempts.size >= 128)
    throw new Error("Too many sign-in attempts");
  const id = randomBytes(32).toString("base64url");
  const owner: Pick<Attempt, "controller" | "signal"> = {
    controller: new AbortController(),
  };
  const client = createSupabaseClient(
    () => owner.signal ?? owner.controller.signal,
  );
  const attempt: Attempt = Object.assign(owner, {
    revision,
    client,
    expires: Date.now() + lifetime,
    busy: false,
    committed: false,
  });
  // A new sign-in supersedes all unfinished attempts, including network calls
  // already in flight; they must recheck membership before persisting.
  retireAttempts();
  attempts.set(id, attempt);
  return [id, attempt];
}

function saveSession(
  id: string,
  attempt: Attempt,
  session: Session,
  github: boolean,
): void {
  if (attempt.expires <= Date.now()) throw new Error("Sign-in expired");
  // The revision fences a late browser callback against logout or another login.
  const persisted = sessionToPersisted(session);
  const revision = persistSession(persisted, attempt.revision);
  // Cancellation after this synchronous commit must report that login completed.
  attempt.committed = true;
  completedAttempts.set(id, attempt);
  if (github) {
    try {
      // Browser and CLI OAuth share the intentional, expiring local cache so
      // later team discovery can reuse this authorization without another prompt.
      // Its revision fence and logout/account-switch invalidation still apply.
      cacheProviderTokenFromSession(session, revision);
      // Provisioning is optional and must not hold the committed login open.
      const owner: Pick<Attempt, "controller" | "signal"> = {
        controller: new AbortController(),
      };
      const client = accountDataClient(
        revision,
        persisted,
        () => owner.signal ?? owner.controller.signal,
      );
      void runOperation(
        owner,
        undefined,
        () =>
          provisionGitHubTeams(
            client,
            session.provider_token,
            true,
            owner.signal ?? owner.controller.signal,
            () => captureLoginRevision() === revision,
          ),
        "optional",
      ).catch(() => {});
    } catch {
      // GitHub provisioning is optional and must not fail login.
    }
  }
  // Fence credential dispatch as well as publication. The attempt's auth client
  // can implicitly rotate tokens outside the shared refresh coordinator.
  void (async () => {
    try {
      const { data } = await runOperation(
        attempt,
        undefined,
        () =>
          accountDataClient(
            revision,
            persisted,
            () => attempt.signal ?? attempt.controller.signal,
          )
            .from("profiles")
            .select("github_login, display_name, email")
            .eq("id", persisted.user_id)
            .maybeSingle(),
        "optional",
      );
      if (data) updateSessionProfile(revision, data);
    } catch {
      // Profile refresh is best-effort.
    }
  })();
}

function closeUnreadUpload(response: Response): Response {
  // Early rejections bypass the bounded reader; never leave uploads on keep-alive sockets.
  response.headers.set("connection", "close");
  return response;
}

function redirect(result: "success" | "failed", attempt?: string): Response {
  const query = new URLSearchParams({ login: result });
  if (attempt) query.set("login_attempt", attempt);
  return new Response(null, {
    status: 303,
    headers: {
      location: `/ui?${query}`,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      // GET requests can still arrive with an unread HTTP upload.
      connection: "close",
    },
  });
}

export async function handleWebLoginRequest(
  req: Request,
  url: URL,
  config: GatewayConfig,
): Promise<Response | null> {
  const path = url.pathname;
  if (!path.startsWith("/api/v1/account/login/")) return null;
  if (requestIsHosted(config))
    return closeUnreadUpload(
      errorResponse(403, "forbidden", "Sign-in is unavailable in hosted mode."),
    );
  cleanAttempts();
  if (path === "/api/v1/account/login/callback" && req.method === "GET") {
    const id = url.searchParams.get("attempt") ?? "";
    const attempt = attempts.get(id);
    const code = url.searchParams.get("code");
    if (!attempt || attempt.email) return redirect("failed");
    if (attempt.busy || attempt.committed || !code) {
      // A failed callback must fence any exchange already in flight.
      if (!attempt.committed) {
        attempt.controller.abort();
        attempts.delete(id);
      }
      return redirect("failed", id);
    }
    attempt.busy = true;
    try {
      const { data, error } = await runOperation(attempt, req.signal, () =>
        attempt.client.auth.exchangeCodeForSession(code),
      );
      if (error || !data.session) return redirect("failed", id);
      if (
        attempts.get(id) !== attempt ||
        req.signal.aborted ||
        attempt.controller.signal.aborted
      )
        return redirect("failed", id);
      saveSession(id, attempt, data.session, true);
      return redirect("success", id);
    } catch {
      return redirect("failed", id);
    } finally {
      if (attempts.get(id) === attempt && !attempt.committed)
        attempts.delete(id);
      attempt.busy = false;
    }
  }
  if (req.method !== "POST")
    return closeUnreadUpload(
      errorResponse(405, "invalid_request", "Method not allowed."),
    );
  const isStart =
    path === "/api/v1/account/login/email" ||
    path === "/api/v1/account/login/github";
  // Assign ordering and account ownership before waiting for an untrusted body.
  const start = isStart
    ? (() => {
        const generation = ++startGeneration;
        // Admission supersedes unfinished attempts even if the new body is
        // invalid or never arrives; old completions must not persist meanwhile.
        retireAttempts();
        for (const body of startBodies) body.abort();
        try {
          return { generation, revision: captureLoginRevision(true) };
        } catch {
          return null;
        }
      })()
    : null;
  if (isStart && !start)
    return closeUnreadUpload(
      errorResponse(
        409,
        "login_failed",
        "Could not start sign-in. Check your account and try again.",
      ),
    );
  const bodyController = new AbortController();
  if (isStart) startBodies.add(bodyController);
  const body = await readBody(req, bodyController).finally(() => {
    startBodies.delete(bodyController);
  });
  if (!body) {
    const superseded = start && start.generation !== startGeneration;
    const response = superseded
      ? errorResponse(
          409,
          "login_failed",
          "Sign-in was superseded. Please try again.",
        )
      : errorResponse(400, "invalid_request", "Invalid sign-in request.");
    // Rejected or incomplete uploads must not retain a keep-alive socket.
    response.headers.set("connection", "close");
    return response;
  }
  if (start) {
    try {
      if (
        start.generation !== startGeneration ||
        captureLoginRevision(true) !== start.revision
      )
        return errorResponse(
          409,
          "login_failed",
          "Sign-in was superseded. Please try again.",
        );
    } catch {
      return errorResponse(
        409,
        "login_failed",
        "Sign-in was superseded. Please try again.",
      );
    }
  }
  if (path === "/api/v1/account/login/cancel") {
    const id = typeof body.attempt === "string" ? body.attempt : "";
    // Unknown attempts may have committed before expiry or a gateway restart.
    if (!id || completedAttempts.has(id) || !attempts.has(id))
      return json({ ok: false });
    attempts.get(id)?.controller.abort();
    attempts.delete(id);
    return json({ ok: true });
  }
  if (path === "/api/v1/account/login/email") {
    const email = typeof body.email === "string" ? body.email.trim() : "";
    if (
      !email ||
      email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    )
      return errorResponse(
        400,
        "invalid_request",
        "Enter a valid email address.",
      );
    const pending = (() => {
      try {
        return newAttempt(start!.revision);
      } catch {
        return null;
      }
    })();
    if (!pending)
      return errorResponse(
        409,
        "login_failed",
        "Could not start sign-in. Check your account and try again.",
      );
    const [id, attempt] = pending;
    try {
      attempt.email = email;
      const { error } = await runOperation(attempt, req.signal, () =>
        attempt.client.auth.signInWithOtp({
          email,
          options: { emailRedirectTo: "http://127.0.0.1/callback" },
        }),
      );
      if (attempts.get(id) !== attempt)
        return errorResponse(
          409,
          "login_failed",
          "Sign-in was superseded. Please try again.",
        );
      if (error) {
        attempts.delete(id);
        return errorResponse(
          400,
          "login_failed",
          "Could not send a sign-in email. Please try again.",
        );
      }
      return json({ attempt: id });
    } catch {
      attempts.delete(id);
      return errorResponse(
        409,
        "login_failed",
        "Could not start sign-in. Check your account and try again.",
      );
    }
  }
  if (path === "/api/v1/account/login/github") {
    // The listener URL is not necessarily the browser URL (e.g. SSH forwarding).
    // Origin is checked by management middleware; only loopback may receive the callback.
    const origin = req.headers.get("origin");
    const browserUrl = origin && URL.canParse(origin) ? new URL(origin) : url;
    const hostname = browserUrl.hostname.replace(/^\[|\]$/g, "");
    if (
      browserUrl.protocol !== "http:" ||
      (hostname !== "localhost" && !isLoopbackAddress(hostname))
    )
      return errorResponse(
        400,
        "invalid_request",
        "GitHub sign-in requires a local browser. Use email sign-in instead.",
      );
    const pending = (() => {
      try {
        return newAttempt(start!.revision);
      } catch {
        return null;
      }
    })();
    if (!pending)
      return errorResponse(
        409,
        "login_failed",
        "Could not start sign-in. Check your account and try again.",
      );
    const [id, attempt] = pending;
    try {
      // Preserve the validated browser host: localhost can use an IPv6-only listener.
      const callback = new URL(
        "/api/v1/account/login/callback",
        browserUrl.origin,
      );
      callback.searchParams.set("attempt", id);
      const { data, error } = await runOperation(attempt, req.signal, () =>
        attempt.client.auth.signInWithOAuth({
          provider: "github",
          options: {
            skipBrowserRedirect: true,
            redirectTo: callback.toString(),
            scopes: OAUTH_SCOPES,
          },
        }),
      );
      if (attempts.get(id) !== attempt)
        return errorResponse(
          409,
          "login_failed",
          "Sign-in was superseded. Please try again.",
        );
      if (error || !data.url) {
        attempts.delete(id);
        return errorResponse(
          400,
          "login_failed",
          "Could not start GitHub sign-in.",
        );
      }
      return json({ url: data.url, attempt: id });
    } catch {
      attempts.delete(id);
      return errorResponse(
        409,
        "login_failed",
        "Could not start sign-in. Check your account and try again.",
      );
    }
  }
  if (path === "/api/v1/account/login/verify") {
    const id = typeof body.attempt === "string" ? body.attempt : "";
    const input = typeof body.code === "string" ? body.code.trim() : "";
    const attempt = attempts.get(id);
    if (
      !attempt?.email ||
      attempt.busy ||
      attempt.committed ||
      !input ||
      input.length > 4096
    )
      return errorResponse(
        400,
        "invalid_request",
        "Sign-in has expired. Request a new email.",
      );
    attempt.busy = true;
    try {
      const session = await runOperation(attempt, req.signal, () =>
        verifyEmailInput(attempt.client, attempt.email!, input),
      );
      if (
        attempts.get(id) !== attempt ||
        req.signal.aborted ||
        attempt.controller.signal.aborted
      )
        throw new Error("Sign-in was superseded");
      saveSession(id, attempt, session, false);
      return json({ ok: true });
    } catch {
      if (attempt.controller.signal.aborted || req.signal.aborted) {
        if (attempts.get(id) === attempt) attempts.delete(id);
        return errorResponse(
          400,
          "login_failed",
          "Sign-in expired. Request a new email.",
        );
      }
      return errorResponse(
        400,
        "login_failed",
        "Could not verify that code or link. Try again or request a new email.",
      );
    } finally {
      attempt.busy = false;
    }
  }
  return errorResponse(404, "not_found", "Not found.");
}
