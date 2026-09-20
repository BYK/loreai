/** `GET /v1/models` — passthrough to the upstream model list. */
import {
  extraHeadersForUpstream,
  GEMINI_DEFAULT_UPSTREAM,
  type GatewayConfig,
} from "../config";
import { applyUpstreamExtraHeaders } from "../translate/types";
import { copyProviderAuthHeaders, hasConflictingAuthHeaders } from "../auth";
import { createForegroundAbortScope, wrapBodyWithCleanup } from "../pipeline";
import { upstreamFetch } from "../fetch";
import { responseAgainstAbort } from "../abort-race";
import {
  errorResponse,
  headersToRecord,
  withoutCors,
} from "../management-access";
import { DATA_PLANE, type RouteModule } from "./types";

/** Select the models upstream from the request's credential shape. */
export type ModelsUpstreamProvider = "anthropic" | "openai" | "gemini";

export interface ModelsUpstream {
  provider: ModelsUpstreamProvider;
  url: string;
}

export function selectModelsUpstream(
  headers: Record<string, string>,
  config: Pick<GatewayConfig, "upstreamAnthropic" | "upstreamOpenAI">,
): ModelsUpstream {
  if (hasConflictingAuthHeaders(headers)) {
    return {
      provider: "anthropic",
      url: `${config.upstreamAnthropic}/v1/models`,
    };
  }
  if ("x-api-key" in headers || "anthropic-version" in headers) {
    return {
      provider: "anthropic",
      url: `${config.upstreamAnthropic}/v1/models`,
    };
  }
  if ("x-goog-api-key" in headers) {
    return {
      provider: "gemini",
      url: `${GEMINI_DEFAULT_UPSTREAM}/v1beta/models`,
    };
  }
  if (/^Bearer\s+\S+$/i.test(headers.authorization ?? "")) {
    return {
      provider: "openai",
      url: `${config.upstreamOpenAI}/v1/models`,
    };
  }
  return {
    provider: "anthropic",
    url: `${config.upstreamAnthropic}/v1/models`,
  };
}

export async function handleModelsPassthrough(
  req: Request,
  config: GatewayConfig,
): Promise<Response> {
  const abortScope = createForegroundAbortScope(req.signal);
  try {
    const requestHeaders = headersToRecord(req.headers);
    const modelsUpstream = selectModelsUpstream(requestHeaders, config);
    // Forward auth headers from the original request so upstream
    // providers that require authentication don't reject with 401.
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    Object.assign(headers, copyProviderAuthHeaders(requestHeaders));
    // Anthropic requires the version header
    const anthropicVersion = requestHeaders["anthropic-version"];
    if (modelsUpstream.provider === "anthropic" && anthropicVersion) {
      headers["anthropic-version"] = anthropicVersion;
    }
    // Apply administrator credentials as one auth overlay: if configured auth
    // is present it replaces every client auth variant rather than competing.
    const upstreamUrl = modelsUpstream.url;
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
