/** `POST /v1/compact` — explicit compaction summary (Pi plugin, etc.). */
import { handleCompactEndpoint } from "../pipeline";
import { withoutCors } from "../management-access";
import { DATA_PLANE, type RouteModule } from "./types";

export const compactRoutes: RouteModule = {
  name: "compact",
  plane: DATA_PLANE,
  paths: ["/v1/compact"],
  register(app, ctx) {
    app.post("/v1/compact", async (c) =>
      withoutCors(await ctx.foreground(handleCompactEndpoint)(c)),
    );
  },
};
