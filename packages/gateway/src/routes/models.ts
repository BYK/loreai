/** `GET /v1/models` — passthrough to the upstream model list. */
import { extraHeadersForUpstream, type GatewayConfig } from "../config";
import { applyUpstreamExtraHeaders } from "../translate/types";
import { copyProviderAuthHeaders } from "../auth";
import { createForegroundAbortScope, wrapBodyWithCleanup } from "../pipeline";
import { upstreamFetch } from "../fetch";
import { responseAgainstAbort } from "../abort-race";
import {
  errorResponse,
  headersToRecord,
  withoutCors,
} from "../management-access";
import { DATA_PLANE, type RouteModule } from "./types";

// NOTE: This endpoint only supports the Anthropic upstream. OpenAI clients
// calling GET /v1/models will have their request forwarded to Anthropic,
// which will likely reject the OpenAI API key. A proper fix would route
// based on auth header type, but that's a separate enhancement.
export async function handleModelsPassthrough(
  req: Request,
  config: GatewayConfig,
): Promise<Response> {
  const abortScope = createForegroundAbortScope(req.signal);
  try {
    // Forward auth headers from the original request so upstream
    // providers that require authentication don't reject with 401.
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    Object.assign(
      headers,
      copyProviderAuthHeaders(headersToRecord(req.headers)),
    );
    // Anthropic requires the version header
    const anthropicVersion = req.headers.get("anthropic-version");
    if (anthropicVersion) headers["anthropic-version"] = anthropicVersion;
    // Apply administrator credentials as one auth overlay: if configured auth
    // is present it replaces every client auth variant rather than competing.
    const upstreamUrl = `${config.upstreamAnthropic}/v1/models`;
    applyUpstreamExtraHeaders(
      headers,
      extraHeadersForUpstream(config, upstreamUrl),
    );

    const upstream = await responseAgainstAbort(
      () =>
        upstreamFetch(upstreamUrl, {
          headers,
          signal: abortScope.signal,
        }),
      abortScope.signal,
    );
    // Clone to attach foreground cleanup and strip any upstream CORS headers.
    const response = wrapBodyWithCleanup(
      upstream,
      abortScope.dispose,
      abortScope.signal,
    );
    return withoutCors(response);
  } catch (e) {
    abortScope.dispose();
    const msg = e instanceof Error ? e.message : "Upstream unreachable";
    return errorResponse(502, "api_error", `Failed to fetch models: ${msg}`);
  }
}

export const modelsRoutes: RouteModule = {
  name: "models",
  plane: DATA_PLANE,
  paths: ["/v1/models"],
  register(app, ctx) {
    app.get(
      "/v1/models",
      ctx.declaredMethodsOnly(["GET"], (c) =>
        handleModelsPassthrough(c.var.request, ctx.config),
      ),
    );
  },
};
