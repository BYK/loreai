/** Native harness tools share the gateway's authenticated memory owner. */
import { handleNativeRecallEndpoint } from "../pipeline";
import { isLoopbackAddress } from "../management-access";
import { DATA_PLANE, type RouteModule } from "./types";

export const recallRoutes: RouteModule = {
  name: "recall",
  plane: DATA_PLANE,
  paths: ["/v1/recall"],
  register(app, ctx) {
    app.post("/v1/recall", (c) =>
      ctx.foreground((req, config) =>
        handleNativeRecallEndpoint(
          req,
          config,
          isLoopbackAddress(c.env.peerAddress),
        ),
      )(c),
    );
  },
};
