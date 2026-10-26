import { createServer, type IncomingMessage, type Server } from "node:http";
import { expect, test } from "vitest";

import { createApiClient, isApiError } from "~/lib/api";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fixture address");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

function readBody(
  request: IncomingMessage,
  accept: (body: unknown) => void,
): void {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  request.on("end", () =>
    accept(JSON.parse(Buffer.concat(chunks).toString("utf8"))),
  );
}

const codes = [
  "123456",
  "https://example.test/verify?token_hash=fixture-private-hash&type=magiclink",
  "https://example.test/callback?code=fixture-private-oauth-code",
];

test.each(
  [307, 308].flatMap((status) => codes.map((code) => ({ status, code }))),
)(
  "real API transport never replays $code on a $status redirect",
  async ({ status, code }) => {
    const forwarded: unknown[] = [];
    const originals: string[] = [];
    const target = createServer((request, response) => {
      response.setHeader("access-control-allow-origin", "*");
      response.setHeader("access-control-allow-headers", "content-type");
      if (request.method === "OPTIONS") {
        response.writeHead(204);
        response.end();
        return;
      }
      readBody(request, (body) => {
        forwarded.push(body);
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ ok: true }));
      });
    });
    const targetUrl = await listen(target);
    const source = createServer((request, response) => {
      originals.push(request.url ?? "");
      request.resume();
      response.writeHead(status, { location: `${targetUrl}/credential-sink` });
      response.end();
    });
    try {
      const sourceUrl = await listen(source);
      const client = createApiClient({ base: `${sourceUrl}/api/v1` });
      const result = await client
        .verifyEmailLogin("fixture-attempt", code)
        .then(
          (value) => value,
          (error: unknown) => error,
        );
      expect(forwarded).toEqual([]);
      expect(isApiError(result)).toBe(true);
      if (!isApiError(result)) throw new Error("Expected safe API failure");
      expect(result.kind).toBe("unreachable");
      expect(result.message).toBe("Gateway unreachable");
      expect(result.message).not.toContain(code);
      expect(originals).toEqual(["/api/v1/account/login/verify"]);
    } finally {
      await close(source);
      await close(target);
    }
  },
);

test("nonredirected verification preserves the attempt and sign-in input", async () => {
  const received: unknown[] = [];
  const source = createServer((request, response) => {
    readBody(request, (body) => {
      received.push(body);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true }));
    });
  });
  try {
    const sourceUrl = await listen(source);
    const client = createApiClient({ base: `${sourceUrl}/api/v1` });
    for (const code of codes) {
      expect(await client.verifyEmailLogin("fixture-attempt", code)).toEqual({
        ok: true,
      });
    }
    expect(received).toEqual(
      codes.map((code) => ({ attempt: "fixture-attempt", code })),
    );
  } finally {
    await close(source);
  }
});
