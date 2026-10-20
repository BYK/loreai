import { afterEach, describe, expect, test, vi } from "vitest";
import { fetchArgUrl } from "./helpers/fetch-url";

vi.mock("../src/fetch", () => ({ upstreamFetch: vi.fn() }));

import { upstreamFetch } from "../src/fetch";
import type { Harness } from "./helpers/harness";
import { createHarness } from "./helpers/harness";
import { anthropicMessageToSSE } from "./helpers/replay";

const mockFetch = vi.mocked(upstreamFetch);
const model = "claude-haiku-5.5";
const controls = {
  temperature: 0.5,
  tool_choice: { type: "auto", disable_parallel_tool_use: true },
  metadata: { user_id: "copilot-test-user" },
};

describe("Copilot native Anthropic routing", () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    if (harness) await harness.teardown();
    harness = undefined;
  });

  async function send(headers: Record<string, string>, stream = false) {
    harness = await createHarness({ fixtures: [] });
    const { setUpstreamInterceptor } = await import("../src/pipeline");
    setUpstreamInterceptor(async (_body, _model, _stream, makeReal) =>
      makeReal(),
    );
    mockFetch.mockReset();
    const reply = {
      id: "msg-copilot-native",
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text: "hello from Copilot" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 4 },
    };
    mockFetch.mockResolvedValue(
      new Response(
        stream ? anthropicMessageToSSE(reply) : JSON.stringify(reply),
        {
          status: 200,
          headers: {
            "content-type": stream ? "text/event-stream" : "application/json",
          },
        },
      ),
    );
    return harness.request("/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-copilot-native-token",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "interleaved-thinking-2025-05-14",
        "x-github-api-version": "2026-08-01",
        "openai-intent": "conversation-edits",
        "x-initiator": "user",
        "x-lore-project": "/tmp/copilot-anthropic-routing-e2e",
        ...headers,
      },
      body: JSON.stringify({
        model,
        stream,
        max_tokens: 1024,
        messages: [{ role: "user", content: "Reply with hello." }],
        tools: [
          {
            name: "read_file",
            description: "Read a file",
            input_schema: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
          },
        ],
        ...controls,
      }),
    });
  }

  test.each<{
    name: string;
    headers: Record<string, string>;
    endpoint: string;
  }>([
    {
      name: "explicit provider",
      headers: { "x-lore-provider": "github-copilot" },
      endpoint: "https://api.githubcopilot.com/v1/messages",
    },
    {
      name: "integration header",
      headers: { "copilot-integration-id": "vscode-chat" },
      endpoint: "https://api.githubcopilot.com/v1/messages",
    },
    {
      name: "OpenCode intercepted endpoint",
      headers: {
        "x-lore-provider": "github-copilot",
        "x-lore-upstream-url": "https://api.githubcopilot.com",
        "x-lore-upstream-path": "/v1/messages?trace=1",
      },
      endpoint: "https://api.githubcopilot.com/v1/messages?trace=1",
    },
    {
      name: "account-specific endpoint",
      headers: {
        "x-lore-provider": "github-copilot",
        "x-lore-upstream-url": "https://api.individual.githubcopilot.com",
        "x-lore-upstream-path": "/v1/messages",
      },
      endpoint: "https://api.individual.githubcopilot.com/v1/messages",
    },
  ])("preserves native controls for $name", async ({ headers, endpoint }) => {
    const response = await send(headers);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      type: "message",
      content: [{ type: "text", text: "hello from Copilot" }],
    });
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0];
    expect(fetchArgUrl(url)).toBe(endpoint);
    if (typeof init?.body !== "string")
      throw new Error("Expected JSON request body");
    const forwarded = JSON.parse(init.body);
    expect(forwarded).toMatchObject({ model, max_tokens: 1024, ...controls });
    expect(forwarded.tools).toContainEqual(
      expect.objectContaining({ name: "read_file" }),
    );
    expect(forwarded).not.toHaveProperty("input");
    const upstreamHeaders = new Headers(init?.headers);
    expect(
      upstreamHeaders.get("authorization") ===
        "Bearer test-copilot-native-token",
    ).toBe(true);
    expect(upstreamHeaders.has("x-api-key")).toBe(false);
    expect(upstreamHeaders.get("anthropic-version")).toBe("2023-06-01");
    expect(upstreamHeaders.get("anthropic-beta")).toContain(
      "interleaved-thinking-2025-05-14",
    );
    expect(upstreamHeaders.get("x-github-api-version")).toBe("2026-08-01");
    expect(upstreamHeaders.get("openai-intent")).toBe("conversation-edits");
    expect(upstreamHeaders.get("x-initiator")).toBe("user");
    expect(upstreamHeaders.has("x-lore-provider")).toBe(false);
  });

  test("streams native Claude replies through Copilot", async () => {
    const response = await send({ "x-lore-provider": "github-copilot" }, true);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(body).toContain("hello from Copilot");
    expect(body).toContain("event: message_stop");
    expect(body).not.toContain("event: error");
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(fetchArgUrl(mockFetch.mock.calls[0][0])).toBe(
      "https://api.githubcopilot.com/v1/messages",
    );
  });

  test.each<{ name: string; headers: Record<string, string> }>([
    {
      name: "explicit foreign provider",
      headers: {
        "copilot-integration-id": "vscode-chat",
        "x-lore-provider": "openai",
      },
    },
    {
      name: "explicit foreign URL",
      headers: {
        "x-lore-provider": "github-copilot",
        "x-lore-upstream-url": "https://api.openai.com",
      },
    },
    {
      name: "Copilot lookalike host",
      headers: {
        "x-lore-provider": "github-copilot",
        "x-lore-upstream-url": "https://api.githubcopilot.com.example.com",
      },
    },
    ...["/chat/completions", "/responses"].map((path) => ({
      name: `explicit ${path} endpoint`,
      headers: {
        "x-lore-provider": "github-copilot",
        "x-lore-upstream-url": "https://api.githubcopilot.com",
        "x-lore-upstream-path": path,
      },
    })),
  ])("retains cross-provider validation for $name", async ({ headers }) => {
    const response = await send(headers);
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(body).toContain("Unsupported cross-provider request");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
