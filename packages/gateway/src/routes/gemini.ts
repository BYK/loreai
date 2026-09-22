/** Google Gemini protocol — `POST .../models/{model}:generateContent`. */
import type { GatewayConfig } from "../config";
import type { GatewayRequest } from "../translate/types";
import { parseGeminiRequestChunks } from "../translate/gemini";
import { decodedRequestChunks } from "../http-body";
import { headersToRecord } from "../management-access";
import { DATA_PLANE, type RouteModule } from "./types";
import {
  invalidStreamedBody,
  requestBodyLimitsForConfig,
  runPipeline,
} from "./shared";

/**
 * Matches a native Gemini `generateContent` endpoint path, capturing the model
 * id and the verb. Version-prefix-agnostic (`/v1beta/models/...`,
 * `/v1/models/...`, or bare `/models/...`) so both the Gemini CLI
 * (`GOOGLE_GEMINI_BASE_URL` → `/v1beta/...`) and `@ai-sdk/google` (baseURL
 * pinned to `${gateway}/v1` → `/v1/...`) are matched.
 */
export const GEMINI_PATH_RE =
  /\/models\/([^/:]+):(generateContent|streamGenerateContent)$/;

export async function handleGeminiGenerateContent(
  req: Request,
  config: GatewayConfig,
  model: string,
  stream: boolean,
): Promise<Response> {
  // headersToRecord lowercases every key (Web Headers API), so `x-goog-api-key`
  // is the only case that can be present here.
  const headers = headersToRecord(req.headers);
  // Normalize `?key=` query-form auth (REST / google-generativeai clients) to
  // the `x-goog-api-key` header — the upstream URL is rebuilt, so a query param
  // would otherwise be dropped and the call would 401. Header form wins.
  if (!headers["x-goog-api-key"]) {
    const key = new URL(req.url).searchParams.get("key");
    if (key) headers["x-goog-api-key"] = key;
  }

  let gatewayReq: GatewayRequest;
  try {
    gatewayReq = await parseGeminiRequestChunks(
      decodedRequestChunks(
        req,
        req.signal,
        requestBodyLimitsForConfig(config, "gemini"),
      ),
      headers,
      model,
      stream,
    );
    gatewayReq.signal = req.signal;
  } catch (e) {
    return invalidStreamedBody(e);
  }
  return runPipeline(gatewayReq, config);
}

export const geminiRoutes: RouteModule = {
  name: "gemini",
  plane: DATA_PLANE,
  patterns: [GEMINI_PATH_RE],
  register(app, ctx) {
    // The path has an arbitrary version prefix and a `:verb` suffix that Hono
    // patterns cannot express, so match the regex from a POST catch-all and
    // hand anything else on to later routes.
    app.post("*", async (c, next) => {
      const gm = c.req.path.match(GEMINI_PATH_RE);
      if (!gm) return next();
      const [, model, verb] = gm;
      return ctx.foreground((scoped, config) =>
        handleGeminiGenerateContent(
          scoped,
          config,
          model,
          verb === "streamGenerateContent",
        ),
      )(c);
    });
  },
};
