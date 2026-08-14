import { createServer } from "node:http";
import { afterEach, describe, expect, test } from "vitest";
import { loopbackRequest } from "./helpers/loopback-request";

describe("loopbackRequest", () => {
  const servers: ReturnType<typeof createServer>[] = [];

  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map(
          (server) =>
            new Promise<void>((resolve) => server.close(() => resolve())),
        ),
    );
  });

  test.each([204, 205, 304])(
    "constructs a bodyless Response for status %s",
    async (status) => {
      const server = createServer((_request, response) => {
        response.writeHead(status);
        response.end();
      });
      servers.push(server);
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("no address");

      const response = await loopbackRequest(
        `http://127.0.0.1:${address.port}/${status}`,
      );
      expect(response.status).toBe(status);
      expect(response.body).toBeNull();
    },
  );

  test.each(["http://example.com/", "http://192.0.2.1/"])(
    "rejects non-loopback destination %s",
    async (url) => {
      await expect(loopbackRequest(url)).rejects.toThrow(
        "loopbackRequest requires a loopback host",
      );
    },
  );
});
