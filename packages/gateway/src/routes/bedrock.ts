/**
 * Bedrock Runtime API passthrough — `POST /v1/model/{modelId}/{verb}`.
 *
 * Routes the four Bedrock Runtime verbs (converse, converse-stream, invoke,
 * invoke-with-response-stream) to bedrock-runtime.<region>.amazonaws.com
 * verbatim — no translation, no pipeline processing (the AWS SDK already owns
 * retries, streaming, and credential rotation). Region comes from
 * LORE_BEDROCK_REGION / AWS_REGION (loaded into config).
 */
import {
  BEDROCK_RUNTIME_PATH_RE,
  proxyBedrockRuntimeRequest,
} from "../translate/bedrock-runtime";
import { withoutCors } from "../management-access";
import { DATA_PLANE, type RouteModule } from "./types";

export const bedrockRoutes: RouteModule = {
  name: "bedrock",
  plane: DATA_PLANE,
  patterns: [BEDROCK_RUNTIME_PATH_RE],
  register(app, ctx) {
    app.post("*", async (c, next) => {
      if (!BEDROCK_RUNTIME_PATH_RE.test(c.req.path)) return next();
      return withoutCors(
        await proxyBedrockRuntimeRequest(
          c.var.request,
          ctx.config.bedrockRegion,
        ),
      );
    });
  },
};
