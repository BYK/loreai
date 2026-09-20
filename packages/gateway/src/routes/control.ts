/**
 * Gateway self-service endpoints, outside both access planes:
 *   GET      /health         → public health check
 *   GET/POST /_lore/control  → owner-only process control (`lore stop`)
 */
import { timingSafeEqual } from "node:crypto";
import { embedding, log } from "@loreai/core";
import { workerHealthSummary } from "../worker-health";
import { VERSION } from "../cli/version";
import { errorResponse, jsonResponse } from "../management-access";
import type { RouteModule } from "./types";

/**
 * Callbacks the node:http bridge runs once a response has fully flushed to
 * the client. Keyed by Response identity, so handlers must return the exact
 * object they registered (Hono passes handler responses through untouched).
 */
export const responseCompletionCallbacks = new WeakMap<Response, () => void>();

export function handleHealth(): Response {
  // Subsystem health so silent degradation (embeddings dropping to FTS-only,
  // background workers stalling) is observable via `lore doctor` / monitoring
  // instead of only a one-time gateway log line.
  const embeddings = embedding.embeddingStatus();
  const worker = workerHealthSummary();
  return jsonResponse({
    status: "ok",
    version: VERSION,
    embeddings: {
      available: embeddings.available,
      state: embeddings.state,
      provider: embeddings.provider,
      detail: embeddings.detail,
    },
    worker: {
      ok: worker.ok,
      degradedSessions: worker.degradedSessions,
      detail: worker.detail,
    },
  });
}

/**
 * Bearer check for the owner-only `/_lore/control` route. `lore stop` and the
 * `lore start` probes (`cli/start.ts`) send `Authorization: Bearer <token>`
 * with the per-process control token from the run record to read the PID and
 * request shutdown. A mismatch is answered with the same 404 as an absent
 * route so the endpoint is invisible without the token.
 */
function controlTokenMatches(req: Request, token: string): boolean {
  const authorization = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${token}`;
  const actualBytes = Buffer.from(authorization);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

export const controlRoutes: RouteModule = {
  name: "control",
  plane: null,
  paths: ["/health", "/_lore/control"],
  register(app, ctx) {
    app.get(
      "/health",
      ctx.declaredMethodsOnly(["GET"], () => handleHealth()),
    );

    // Public health omits the PID because a public response cannot prove
    // process ownership. Every unauthorized method is the same 404 as an
    // absent route.
    const { options } = ctx;
    app.on(
      ["GET", "POST"],
      "/_lore/control",
      ctx.declaredMethodsOnly(["GET", "POST"], (c) => {
        const method = c.req.method;
        if (
          !options.controlToken ||
          !controlTokenMatches(c.var.request, options.controlToken) ||
          (method === "POST" && !options.onShutdown)
        ) {
          return errorResponse(
            404,
            "not_found",
            `No route for ${method} /_lore/control`,
          );
        }
        const response = jsonResponse({
          status: "ok",
          service: "lore",
          pid: process.pid,
          ...(method === "POST" ? { shutdown: "requested" } : {}),
        });
        if (method === "POST") {
          responseCompletionCallbacks.set(response, () => {
            try {
              void Promise.resolve(options.onShutdown?.()).catch((error) => {
                log.error("remote shutdown callback failed:", error);
              });
            } catch (error) {
              log.error("remote shutdown callback failed:", error);
            }
          });
        }
        return response;
      }),
    );
  },
};
