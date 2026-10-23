/** Offline loopback capture. No upstream dispatch, config access, or DB access. */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { pathToFileURL } from "node:url";
import { compareCopilotChatRequests } from "../src/copilot-chat-comparison";
import {
  buildOpenAIUpstreamRequest,
  parseOpenAIRequest,
} from "../src/translate/openai";

export function createCaptureServer(report: (value: unknown) => void) {
  async function capture(request: IncomingMessage, response: ServerResponse) {
    response.setHeader("content-type", "application/json");
    response.setHeader("connection", "close");
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200).end('{"status":"offline-capture"}');
      return;
    }
    if (
      request.method !== "POST" ||
      request.url?.split("?")[0] !== "/v1/chat/completions"
    ) {
      request.resume();
      response
        .writeHead(404)
        .end('{"error":{"message":"Offline capture endpoint only"}}');
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    try {
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) {
          response
            .writeHead(413)
            .end('{"error":{"message":"Offline capture size limit"}}');
          request.resume();
          return;
        }
        chunks.push(Buffer.from(chunk));
      }
      const original = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (original?.model === "gemini-4-argon") {
        // Deliberately discard all incoming headers, including credentials.
        const parsed = parseOpenAIRequest(original, {});
        const build = (cache: boolean) =>
          buildOpenAIUpstreamRequest(
            parsed,
            "https://api.githubcopilot.com",
            cache
              ? {
                  systemTTL: "5m",
                  cacheTools: true,
                  cacheConversation: true,
                  conversationTTL: "5m",
                }
              : undefined,
          ).body;
        report({
          bodyBytes: bytes,
          serializer: compareCopilotChatRequests(original, build(false)),
          withGatewayCache: compareCopilotChatRequests(original, build(true)),
        });
      }
      response
        .writeHead(400)
        .end(
          '{"error":{"message":"Offline capture complete; no upstream call was made"}}',
        );
    } catch {
      response
        .writeHead(400)
        .end(
          '{"error":{"message":"Offline capture could not parse or rebuild request"}}',
        );
    }
  }
  return createServer((request, response) => {
    void capture(request, response);
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const server = createCaptureServer((value) =>
    console.log(JSON.stringify(value)),
  );
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.on("error", () => {
    console.error("Offline capture could not bind loopback port 3219");
    process.exitCode = 1;
  });
  server.listen(3219, "127.0.0.1", () => {
    console.error(
      "Offline capture listening at http://127.0.0.1:3219/v1; Ctrl-C to stop",
    );
  });
}
