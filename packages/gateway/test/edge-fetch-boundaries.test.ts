import { createServer, type Server } from "node:http";
import { expect, test } from "vitest";
import { supabaseFetch } from "../../../supabase/functions/_shared/supabase-fetch";
import {
  buildInviteEmail,
  parseInviteToken,
  sendViaSmtp2go,
} from "../../../supabase/functions/send-invite-email/send";

const capability = "a".repeat(64);
const key = Buffer.alloc(32, 1).toString("base64url");

test.each([
  `${capability}\n`,
  `${capability}.${key}\n`,
  `${capability}.${key}=`,
  `${capability}..${key}`,
  `${capability}.${key}.extra`,
  `${capability}.${key.slice(0, -1)}B`,
  `${capability}.${"a".repeat(44)}`,
  `${capability}.$(printf injected)`,
  `${capability} ${key}`,
])(
  "the email builder cannot publish an invalid or noncanonical token (%s)",
  (token) => {
    expect(parseInviteToken(token)).toBeNull();
    expect(() => buildInviteEmail({ token })).toThrow("Invalid invite token");
  },
);

test.each([capability, `${capability}.${key}`])(
  "valid invite commands retain the entire token (%s)",
  (token) => {
    expect(parseInviteToken(token)?.capability).toBe(capability);
    const email = buildInviteEmail({ token, offline: token.includes(".") });
    expect(email.text).toContain(`lore team accept ${token}`);
    expect(email.html).toContain(`lore team accept ${token}`);
  },
);

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

test.each([307, 308])(
  "Edge transports never replay credentials on a %i redirect",
  async (status) => {
    const targets: Array<{
      path: string;
      smtpKey: unknown;
      accountKey: unknown;
    }> = [];
    const originals: string[] = [];
    const target = createServer((request, response) => {
      targets.push({
        path: request.url ?? "",
        smtpKey: request.headers["x-smtp2go-api-key"],
        accountKey: request.headers.apikey,
      });
      request.resume();
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: { succeeded: 1 } }));
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
      const account = await supabaseFetch(`${sourceUrl}/auth`, {
        method: "POST",
        headers: { apikey: "fixture-account-key" },
        body: JSON.stringify({ token: "fixture-one-time-code" }),
      });
      expect(account.status).toBe(499);
      const outcome = await sendViaSmtp2go(
        "recipient@example.test",
        buildInviteEmail({ token: capability }),
        {
          apiKey: "fixture-smtp-key",
          sender: "sender@example.test",
          apiUrl: `${sourceUrl}/smtp`,
        },
      ).then(
        () => "sent",
        () => "rejected",
      );
      expect(targets).toEqual([]);
      expect(outcome).toBe("rejected");
      expect(originals).toEqual(["/auth", "/smtp"]);
    } finally {
      await close(source);
      await close(target);
    }
  },
);
