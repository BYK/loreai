import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockAgent } from "undici";
import fc from "fast-check";
import * as core from "@loreai/core";
import type { Harness } from "./helpers/harness";
import { createHarness } from "./helpers/harness";
import { setUpstreamDispatcherForTest } from "../src/fetch";
import {
  getActiveSessions,
  loreMessagesToGateway,
  setBeforeUpstreamCaptureForTest,
  setUpstreamInterceptor,
} from "../src/pipeline";
import {
  gatewayMessagesToLore,
  resolveToolResults,
} from "../src/temporal-adapter";
import { toAnthropicImage, toResponsesImage } from "../src/translate/images";
import { STREAMING_PARSE_SPOOL_BYTES } from "../src/translate/streaming-request";
import {
  buildOpenAIUpstreamRequest,
  parseOpenAIRequest,
} from "../src/translate/openai";
import {
  buildOpenAIResponsesUpstreamRequest,
  parseOpenAIResponsesRequest,
} from "../src/translate/openai-responses";
import { buildAnthropicRequest } from "../src/translate/anthropic";
import { buildGeminiUpstreamRequest } from "../src/translate/gemini";
import { InvalidCrossProviderRequestError } from "../src/translate/errors";
import { boundFallbackHistory } from "../src/fallback-history";
import { _setModelDataForTest, clearModelDataCache } from "../src/worker-model";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9FeAAAAABJRU5ErkJggg==";
const dataURL = `data:image/png;base64,${png}`;

const anthropicReply = {
  id: "msg_conformance",
  type: "message",
  role: "assistant",
  model: "claude-test",
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 10, output_tokens: 2 },
};
const responsesReply = {
  id: "resp_conformance",
  model: "gpt-test",
  status: "completed",
  output: [
    {
      type: "message",
      id: "msg_conformance",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "ok" }],
    },
  ],
  usage: { input_tokens: 10, output_tokens: 2 },
};
const chatReply = {
  id: "chatcmpl_conformance",
  object: "chat.completion",
  model: "gpt-test",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "ok" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 2 },
};
const geminiReply = {
  candidates: [
    {
      content: { role: "model", parts: [{ text: "ok" }] },
      finishReason: "STOP",
    },
  ],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
};

describe("cross-provider request conformance through real forwarding", () => {
  let harness: Harness | undefined;
  let mock: MockAgent | undefined;
  let projectPath: string | undefined;
  let originalQueryExpansion: boolean | undefined;

  afterEach(async () => {
    if (originalQueryExpansion !== undefined) {
      core.config().search.queryExpansion = originalQueryExpansion;
      originalQueryExpansion = undefined;
    }
    try {
      await harness?.teardown();
    } finally {
      harness = undefined;
      setBeforeUpstreamCaptureForTest(undefined);
      setUpstreamInterceptor(undefined);
      setUpstreamDispatcherForTest(null);
      try {
        await mock?.close();
      } finally {
        mock = undefined;
        if (projectPath) rmSync(projectPath, { recursive: true, force: true });
        projectPath = undefined;
      }
    }
  });

  async function forward(
    path: string,
    provider: "anthropic" | "openai" | "openrouter" | "gemini",
    body: Record<string, unknown>,
    shouldDispatch = true,
    beforeRequest?: () => void | Promise<void>,
    options?: { upstreamCalls?: number; headers?: Record<string, string> },
  ): Promise<{
    response: Response;
    upstream: Record<string, unknown>;
    headers: Record<string, string>;
  }> {
    mock = new MockAgent();
    mock.disableNetConnect();
    setUpstreamDispatcherForTest(mock);
    projectPath = mkdtempSync(join(tmpdir(), "lore-protocol-conformance-"));
    harness = await createHarness({ fixtures: [], projectPath });
    originalQueryExpansion = core.config().search.queryExpansion;
    core.config().search.queryExpansion = false;
    setUpstreamInterceptor((_body, _model, _stream, makeReal) => makeReal());

    const upstream = {
      body: undefined as Record<string, unknown> | undefined,
      headers: undefined as Record<string, string> | undefined,
    };
    mock
      .get(
        provider === "anthropic"
          ? "https://api.anthropic.com"
          : provider === "gemini"
            ? "https://generativelanguage.googleapis.com"
            : provider === "openrouter"
              ? "https://openrouter.ai"
              : "https://api.openai.com",
      )
      .intercept({
        method: "POST",
        path:
          provider === "anthropic"
            ? "/v1/messages"
            : provider === "gemini"
              ? "/v1beta/models/gemini-test:generateContent"
              : provider === "openrouter"
                ? "/api/v1/chat/completions"
                : "/v1/responses",
      })
      .reply((opts) => {
        if (
          typeof opts.body !== "string" &&
          !(opts.body instanceof Uint8Array)
        ) {
          throw new Error("Unexpected upstream body type");
        }
        const bodyText =
          typeof opts.body === "string"
            ? opts.body
            : Buffer.from(opts.body).toString("utf8");
        upstream.body = JSON.parse(bodyText) as Record<string, unknown>;
        upstream.headers = opts.headers as Record<string, string>;
        return {
          statusCode: 200,
          data: JSON.stringify(
            provider === "anthropic"
              ? anthropicReply
              : provider === "gemini"
                ? geminiReply
                : provider === "openrouter"
                  ? chatReply
                  : responsesReply,
          ),
          responseOptions: { headers: { "content-type": "application/json" } },
        };
      })
      .times(options?.upstreamCalls ?? 1);

    await beforeRequest?.();
    const response = await harness.request(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
        ...(provider === "gemini" ? {} : { "x-lore-provider": provider }),
        "x-lore-project": projectPath,
        "x-lore-agent": "coder",
        "x-lore-no-store": "true",
        ...options?.headers,
      },
      body: JSON.stringify(body),
    });
    if (shouldDispatch) {
      expect(response.status, await response.clone().text()).toBe(200);
      expect(mock.pendingInterceptors()).toEqual([]);
      expect(upstream.body).toBeDefined();
    } else {
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(mock.pendingInterceptors()).toHaveLength(1);
      if ((options?.upstreamCalls ?? 1) === 1) {
        expect(upstream.body).toBeUndefined();
      }
    }
    return {
      response,
      upstream: upstream.body ?? {},
      headers: upstream.headers ?? {},
    };
  }

  it("keeps Chat developer instructions, an image and a tool pair on Anthropic upstream", async () => {
    const { upstream } = await forward("/v1/chat/completions", "anthropic", {
      model: "claude-test",
      max_tokens: 128,
      messages: [
        { role: "system", content: "system instruction" },
        {
          role: "user",
          content: [
            { type: "text", text: "inspect the picture" },
            { type: "image_url", image_url: { url: dataURL } },
            {
              type: "image_url",
              image_url: { url: "https://example.test/picture.webp" },
            },
          ],
        },
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_read",
              type: "function",
              function: { name: "read", arguments: '{"path":"a.txt"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_read", content: "file body" },
        { role: "user", content: "answer now" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "read",
            description: "read a file",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
            },
          },
        },
      ],
    });
    expect(JSON.stringify(upstream.system)).toContain("system instruction");
    expect(upstream.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: expect.arrayContaining([
            expect.objectContaining({
              type: "text",
              text: "inspect the picture",
            }),
            expect.objectContaining({
              type: "image",
              source: { type: "base64", media_type: "image/png", data: png },
            }),
            {
              type: "image",
              source: { type: "url", url: "https://example.test/picture.webp" },
            },
          ]),
        }),
        expect.objectContaining({
          role: "assistant",
          content: expect.arrayContaining([
            expect.objectContaining({
              type: "tool_use",
              id: "call_read",
              name: "read",
            }),
          ]),
        }),
        expect.objectContaining({
          role: "user",
          content: expect.arrayContaining([
            expect.objectContaining({
              type: "tool_result",
              tool_use_id: "call_read",
              content: expect.arrayContaining([
                { type: "text", text: "file body" },
              ]),
            }),
          ]),
        }),
      ]),
    );
    expect(upstream.tools).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "read" })]),
    );
  });

  it.each([false, true])(
    "rejects malformed Chat image_url string before Anthropic dispatch (streamed=%s)",
    async (streamed) => {
      const { response } = await forward(
        "/v1/chat/completions",
        "anthropic",
        {
          model: "claude-test",
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image_url",
                  image_url: "https://example.test/picture.png",
                },
              ],
            },
          ],
          ...(streamed
            ? { padding: "x".repeat(STREAMING_PARSE_SPOOL_BYTES + 1) }
            : {}),
        },
        false,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: {
          type: "invalid_request_error",
          message: "Unsupported cross-provider request",
        },
      });
    },
  );

  it.each([false, true])(
    "rejects a foreign input_image part on Chat ingress (streamed=%s)",
    async (streamed) => {
      const { response } = await forward(
        "/v1/chat/completions",
        "anthropic",
        {
          model: "claude-test",
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "input_image",
                  image_url: "https://example.test/a.png",
                },
              ],
            },
          ],
          ...(streamed
            ? { padding: "x".repeat(STREAMING_PARSE_SPOOL_BYTES + 1) }
            : {}),
        },
        false,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: {
          type: "invalid_request_error",
          message: "Unsupported cross-provider request",
        },
      });
    },
  );

  it.each([false, true])(
    "converts a valid Chat image_url object on Anthropic (streamed=%s)",
    async (streamed) => {
      const { upstream } = await forward("/v1/chat/completions", "anthropic", {
        model: "claude-test",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: { url: "https://example.test/a.png" },
              },
            ],
          },
        ],
        ...(streamed
          ? { padding: "x".repeat(STREAMING_PARSE_SPOOL_BYTES + 1) }
          : {}),
      });
      expect(upstream.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "user",
            content: expect.arrayContaining([
              expect.objectContaining({
                type: "image",
                source: { type: "url", url: "https://example.test/a.png" },
              }),
            ]),
          }),
        ]),
      );
    },
  );

  it.each([
    { provider: "anthropic" as const, streamed: false },
    { provider: "anthropic" as const, streamed: true },
    { provider: "openai" as const, streamed: false },
    { provider: "openai" as const, streamed: true },
  ])(
    "rejects a foreign Chat assistant image on $provider (streamed=$streamed)",
    async ({ provider, streamed }) => {
      const { response } = await forward(
        "/v1/chat/completions",
        provider,
        {
          model: provider === "anthropic" ? "claude-test" : "gpt-test",
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "image_url",
                  image_url: { url: "https://example.test/a.png" },
                },
              ],
            },
            { role: "user", content: "continue" },
          ],
          ...(streamed
            ? { padding: "x".repeat(STREAMING_PARSE_SPOOL_BYTES + 1) }
            : {}),
        },
        false,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: {
          type: "invalid_request_error",
          message: "Unsupported cross-provider request",
        },
      });
    },
  );

  it.each([false, true])(
    "rejects a Chat tool-result image on Anthropic (streamed=%s)",
    async (streamed) => {
      const { response } = await forward(
        "/v1/chat/completions",
        "anthropic",
        {
          model: "claude-test",
          messages: [
            {
              role: "assistant",
              tool_calls: [
                {
                  id: "call_read",
                  type: "function",
                  function: { name: "read", arguments: "{}" },
                },
              ],
            },
            {
              role: "tool",
              tool_call_id: "call_read",
              content: [{ type: "image_url", image_url: { url: dataURL } }],
            },
            { role: "user", content: "continue" },
          ],
          ...(streamed
            ? { padding: "x".repeat(STREAMING_PARSE_SPOOL_BYTES + 1) }
            : {}),
        },
        false,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: {
          type: "invalid_request_error",
          message: "Unsupported cross-provider request",
        },
      });
    },
  );

  it("rejects Chat developer instructions that Anthropic would promote to system", async () => {
    const { response } = await forward(
      "/v1/chat/completions",
      "anthropic",
      {
        model: "claude-test",
        messages: [
          { role: "system", content: "system authority" },
          { role: "developer", content: "developer authority" },
          { role: "user", content: "question" },
        ],
      },
      false,
    );
    expect(response.status).toBe(400);
    expect((await response.json()) as unknown).toMatchObject({
      error: {
        type: "invalid_request_error",
        message: "Unsupported cross-provider request",
      },
    });
  });

  it("keeps Anthropic instructions, an image and a tool pair on Responses upstream", async () => {
    const { upstream } = await forward("/v1/messages", "openai", {
      model: "gpt-test",
      max_tokens: 128,
      system: "system instruction",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "inspect the picture" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: png },
            },
          ],
        },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_read",
              name: "read",
              input: { path: "a.txt" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_read",
              content: "file body",
            },
          ],
        },
        { role: "user", content: "answer now" },
      ],
      tools: [
        {
          name: "read",
          description: "read a file",
          input_schema: {
            type: "object",
            properties: { path: { type: "string" } },
          },
        },
      ],
    });
    expect(upstream.instructions).toContain("system instruction");
    expect(upstream.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "message",
          role: "user",
          content: expect.arrayContaining([
            { type: "input_text", text: "inspect the picture" },
            { type: "input_image", image_url: dataURL, detail: "auto" },
          ]),
        }),
        expect.objectContaining({
          type: "function_call",
          call_id: "call_read",
          name: "read",
        }),
        {
          type: "function_call_output",
          call_id: "call_read",
          output: "file body",
        },
      ]),
    );
    expect(upstream.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "function", name: "read" }),
      ]),
    );
  });

  it("rejects a forced Anthropic tool choice before forwarding to Responses", async () => {
    const { response } = await forward(
      "/v1/messages",
      "openai",
      {
        model: "gpt-test",
        max_tokens: 128,
        messages: [{ role: "user", content: "use the selected tool" }],
        tools: [
          { name: "read", input_schema: { type: "object" } },
          { name: "write", input_schema: { type: "object" } },
        ],
        tool_choice: { type: "tool", name: "read" },
      },
      false,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        type: "invalid_request_error",
        message: "Unsupported cross-provider request",
      },
    });
  });

  it.each([false, true])(
    "rejects a forced Chat tool choice before forwarding to Anthropic (streamed=%s)",
    async (streamed) => {
      const { response } = await forward(
        "/v1/chat/completions",
        "anthropic",
        {
          model: "claude-test",
          ...(streamed
            ? { padding: "x".repeat(STREAMING_PARSE_SPOOL_BYTES + 1) }
            : {}),
          messages: [{ role: "user", content: "use read" }],
          tools: [
            {
              type: "function",
              function: { name: "read", parameters: { type: "object" } },
            },
            {
              type: "function",
              function: { name: "write", parameters: { type: "object" } },
            },
          ],
          tool_choice: { type: "function", function: { name: "read" } },
        },
        false,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: {
          type: "invalid_request_error",
          message: "Unsupported cross-provider request",
        },
      });
    },
  );

  it.each([false, true])(
    "keeps a forced Chat tool choice on a Chat upstream (streamed=%s)",
    async (streamed) => {
      const toolChoice = { type: "function", function: { name: "read" } };
      const { upstream } = await forward("/v1/chat/completions", "openrouter", {
        model: "gpt-test",
        ...(streamed
          ? { padding: "x".repeat(STREAMING_PARSE_SPOOL_BYTES + 1) }
          : {}),
        messages: [{ role: "user", content: "use read" }],
        tools: [
          {
            type: "function",
            function: { name: "read", parameters: { type: "object" } },
          },
        ],
        tool_choice: toolChoice,
      });
      expect(upstream.tool_choice).toEqual(toolChoice);
    },
  );

  it.each([false, true])(
    "keeps a Responses no-parallel-tools constraint (streamed=%s)",
    async (streamed) => {
      const { upstream } = await forward("/v1/responses", "openai", {
        model: "gpt-test",
        ...(streamed
          ? { padding: "x".repeat(STREAMING_PARSE_SPOOL_BYTES + 1) }
          : {}),
        input: [{ role: "user", content: "use read" }],
        parallel_tool_calls: false,
      });
      expect(upstream.parallel_tool_calls).toBe(false);
    },
  );

  it("rejects a forced Codex tool choice before forwarding to Anthropic", async () => {
    const { response } = await forward(
      "/v1/codex/responses",
      "anthropic",
      {
        model: "claude-test",
        input: [{ role: "user", content: "use read" }],
        tools: [
          { type: "function", name: "read", parameters: { type: "object" } },
          { type: "function", name: "write", parameters: { type: "object" } },
        ],
        tool_choice: { type: "function", name: "read" },
      },
      false,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        type: "invalid_request_error",
        message: "Unsupported cross-provider request",
      },
    });
  });

  it.each([
    ["include", ["reasoning.encrypted_content"]],
    ["prompt_cache_key", "session-1"],
    ["parallel_tool_calls", false],
    ["service_tier", "priority"],
  ])("rejects Codex-only %s on Anthropic", async (field, value) => {
    const { response } = await forward(
      "/v1/codex/responses",
      "anthropic",
      {
        model: "claude-test",
        input: [{ role: "user", content: "answer" }],
        [field]: value,
      },
      false,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        type: "invalid_request_error",
        message: "Unsupported cross-provider request",
      },
    });
  });

  it.each([false, true])(
    "keeps a Responses tool choice and disables upstream storage (streamed=%s)",
    async (streamed) => {
      const toolChoice = { type: "function", name: "read" };
      const { upstream } = await forward("/v1/responses", "openai", {
        model: "gpt-test",
        ...(streamed
          ? {
              metadata: {
                padding: "x".repeat(STREAMING_PARSE_SPOOL_BYTES + 1),
              },
            }
          : {}),
        input: [{ role: "user", content: "use read" }],
        tools: [
          { type: "function", name: "read", parameters: { type: "object" } },
        ],
        tool_choice: toolChoice,
        store: true,
      });
      expect(upstream.tool_choice).toEqual(toolChoice);
      expect(upstream.store).toBe(false);
    },
  );

  it.each([false, true])(
    "rejects a Responses no-parallel-tools constraint that Anthropic cannot carry (streamed=%s)",
    async (streamed) => {
      const { response } = await forward(
        "/v1/responses",
        "anthropic",
        {
          model: "claude-test",
          ...(streamed
            ? { padding: "x".repeat(STREAMING_PARSE_SPOOL_BYTES + 1) }
            : {}),
          input: [{ role: "user", content: "use one tool at a time" }],
          tools: ["recall", "read", "write"].map((name) => ({
            type: "function",
            name,
            parameters: { type: "object" },
          })),
          parallel_tool_calls: false,
        },
        false,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: {
          type: "invalid_request_error",
          message: "Unsupported cross-provider request",
        },
      });
    },
  );

  it.each([false, true])(
    "rejects a malformed Responses parallel-tool constraint (streamed=%s)",
    async (streamed) => {
      const { response } = await forward(
        "/v1/responses",
        "anthropic",
        {
          model: "claude-test",
          ...(streamed
            ? { padding: "x".repeat(STREAMING_PARSE_SPOOL_BYTES + 1) }
            : {}),
          input: [{ role: "user", content: "use a tool" }],
          tools: [{ type: "function", name: "read", parameters: {} }],
          parallel_tool_calls: "false",
        },
        false,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: {
          type: "invalid_request_error",
          message: "Unsupported cross-provider request",
        },
      });
    },
  );

  it.each([false, true])(
    "rejects foreign Responses truncation and preserves it natively (streamed=%s)",
    async (streamed) => {
      const body = {
        model: "gpt-test",
        ...(streamed
          ? { padding: "x".repeat(STREAMING_PARSE_SPOOL_BYTES + 1) }
          : {}),
        input: [{ role: "user", content: "hello" }],
        truncation: "auto",
      };
      const { response } = await forward(
        "/v1/responses",
        "anthropic",
        { ...body, model: "claude-test" },
        false,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: {
          type: "invalid_request_error",
          message: "Unsupported cross-provider request",
        },
      });
      const native = buildOpenAIResponsesUpstreamRequest(
        parseOpenAIResponsesRequest(body, { authorization: "Bearer test-key" }),
        "https://api.openai.com",
      ).body as Record<string, unknown>;
      expect(native.truncation).toBe("auto");
    },
  );

  it.each([false, true])(
    "forwards native Responses truncation on the real route (streamed=%s)",
    async (streamed) => {
      const { upstream } = await forward("/v1/responses", "openai", {
        model: "gpt-test",
        ...(streamed
          ? { padding: "x".repeat(STREAMING_PARSE_SPOOL_BYTES + 1) }
          : {}),
        input: [{ role: "user", content: "hello" }],
        truncation: "auto",
      });
      expect(upstream.truncation).toBe("auto");
    },
  );

  it.each([false, true])(
    "preserves native Responses strict tools and rejects foreign translation (streamed=%s)",
    async (streamed) => {
      const tool = {
        type: "function",
        name: "read",
        description: "Read a file",
        parameters: {
          type: "object",
          properties: {},
          required: [],
          additionalProperties: false,
        },
        strict: true,
      };
      const body = {
        model: "gpt-test",
        ...(streamed
          ? { padding: "x".repeat(STREAMING_PARSE_SPOOL_BYTES + 1) }
          : {}),
        input: [{ role: "user", content: "read" }],
        tools: [tool],
      };
      const { upstream } = await forward("/v1/responses", "openai", body);
      const forwarded = (upstream.tools as Array<Record<string, unknown>>).find(
        (item) => item.name === "read",
      );
      expect(forwarded?.strict).toBe(true);
      expect(forwarded?.parameters).toEqual(tool.parameters);
    },
  );

  it.each([false, true])(
    "rejects strict Responses tools on an Anthropic route (streamed=%s)",
    async (streamed) => {
      const { response } = await forward(
        "/v1/responses",
        "anthropic",
        {
          model: "claude-test",
          ...(streamed
            ? { padding: "x".repeat(STREAMING_PARSE_SPOOL_BYTES + 1) }
            : {}),
          input: [{ role: "user", content: "read" }],
          tools: [
            {
              type: "function",
              name: "read",
              parameters: { type: "object" },
              strict: true,
            },
          ],
        },
        false,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: {
          type: "invalid_request_error",
          message: "Unsupported cross-provider request",
        },
      });
    },
  );

  it("keeps another provider's security token off a Responses destination", async () => {
    const { headers } = await forward(
      "/v1/responses",
      "openai",
      { model: "gpt-test", input: [{ role: "user", content: "hello" }] },
      true,
      undefined,
      { headers: { "x-amz-security-token": "synthetic-secret" } },
    );
    expect(Object.keys(headers).map((key) => key.toLowerCase())).not.toContain(
      "x-amz-security-token",
    );
  });

  it.each([false, true])(
    "projects a completed Responses user item on an Anthropic meta request (streamed=%s)",
    async (streamed) => {
      const { upstream } = await forward(
        "/v1/responses",
        "anthropic",
        {
          model: "claude-test",
          ...(streamed
            ? { padding: "x".repeat(STREAMING_PARSE_SPOOL_BYTES + 1) }
            : {}),
          input: [
            {
              type: "message",
              role: "user",
              id: "msg_user",
              status: "completed",
              content: [{ type: "input_text", text: "hello from user" }],
            },
          ],
        },
        true,
        undefined,
        { headers: { "x-lore-agent": "summary" } },
      );
      expect(JSON.stringify(upstream.messages)).toContain("hello from user");
      expect(JSON.stringify(upstream.messages)).not.toContain("msg_user");
    },
  );

  it("projects a completed Responses user item on a Chat upstream", () => {
    const req = parseOpenAIResponsesRequest(
      {
        model: "gpt-test",
        input: [
          {
            type: "message",
            role: "user",
            id: "msg_user",
            status: "completed",
            content: [{ type: "input_text", text: "hello from user" }],
          },
        ],
      },
      { authorization: "Bearer test-key" },
    );
    const body = buildOpenAIUpstreamRequest(req, "https://openrouter.ai/api")
      .body as Record<string, unknown>;
    expect(body.messages).toContainEqual({
      role: "user",
      content: "hello from user",
    });
  });

  it.each([false, true])(
    "rejects a native Responses tool definition it cannot forward (streamed=%s)",
    async (streamed) => {
      const { response } = await forward(
        "/v1/responses",
        "openai",
        {
          model: "gpt-test",
          ...(streamed
            ? { padding: "x".repeat(STREAMING_PARSE_SPOOL_BYTES + 1) }
            : {}),
          input: [{ role: "user", content: "search the web" }],
          tools: [{ type: "unsupported_tool_kind" }],
        },
        false,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: {
          type: "invalid_request_error",
          message: "Unsupported cross-provider request",
        },
      });
    },
  );

  it.each([false, true])(
    "forwards a supported native Responses web-search tool (streamed=%s)",
    async (streamed) => {
      const { upstream } = await forward("/v1/responses", "openai", {
        model: "gpt-test",
        ...(streamed
          ? { padding: "x".repeat(STREAMING_PARSE_SPOOL_BYTES + 1) }
          : {}),
        input: [{ role: "user", content: "search the web" }],
        tools: [{ type: "web_search_preview" }],
      });
      expect(upstream.tools).toEqual([{ type: "web_search_preview" }]);
    },
  );

  it.each([false, true])(
    "preserves client parallel tool calls on native Responses (streamed=%s)",
    async (streamed) => {
      const tool = {
        type: "function",
        name: "read",
        description: "",
        parameters: { type: "object", properties: {} },
      };
      const { upstream } = await forward("/v1/responses", "openai", {
        model: "gpt-test",
        ...(streamed
          ? { padding: "x".repeat(STREAMING_PARSE_SPOOL_BYTES + 1) }
          : {}),
        input: [{ role: "user", content: "read" }],
        tools: [tool],
        parallel_tool_calls: true,
      });
      expect(upstream.parallel_tool_calls).toBe(true);
      expect(upstream.tools).toEqual([tool]);
    },
  );

  it.each([false, true])(
    "preserves client parallel tool calls on native Chat (streamed=%s)",
    async (streamed) => {
      const tool = {
        type: "function",
        function: {
          name: "read",
          description: "read a file",
          parameters: { type: "object", properties: {} },
        },
      };
      const { upstream } = await forward("/v1/chat/completions", "openrouter", {
        model: "gpt-test",
        ...(streamed
          ? { padding: "x".repeat(STREAMING_PARSE_SPOOL_BYTES + 1) }
          : {}),
        messages: [{ role: "user", content: "read" }],
        tools: [tool],
        parallel_tool_calls: true,
      });
      expect(upstream.parallel_tool_calls).toBe(true);
      expect(upstream.tools).toMatchObject([tool]);
    },
  );

  it.each([false, true])(
    "rejects client Chat parallel calls on an Anthropic route (streamed=%s)",
    async (streamed) => {
      const { response } = await forward(
        "/v1/chat/completions",
        "anthropic",
        {
          model: "claude-test",
          ...(streamed
            ? { padding: "x".repeat(STREAMING_PARSE_SPOOL_BYTES + 1) }
            : {}),
          messages: [{ role: "user", content: "read" }],
          tools: [
            {
              type: "function",
              function: {
                name: "read",
                parameters: { type: "object", properties: {} },
              },
            },
          ],
          parallel_tool_calls: true,
        },
        false,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: {
          type: "invalid_request_error",
          message: "Unsupported cross-provider request",
        },
      });
    },
  );

  it.each([false, true])(
    "rejects malformed Chat parallel-tool controls (streamed=%s)",
    async (streamed) => {
      const { response } = await forward(
        "/v1/chat/completions",
        "openrouter",
        {
          model: "gpt-test",
          ...(streamed
            ? { padding: "x".repeat(STREAMING_PARSE_SPOOL_BYTES + 1) }
            : {}),
          messages: [{ role: "user", content: "read" }],
          parallel_tool_calls: "true",
        },
        false,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: {
          type: "invalid_request_error",
          message: "Unsupported cross-provider request",
        },
      });
    },
  );

  it.each([
    ["system", false],
    ["system", true],
    ["developer", false],
    ["developer", true],
  ] as const)(
    "replays empty native Responses %s instructions (streamed=%s)",
    async (role, streamed) => {
      const instruction = {
        type: "message",
        role,
        content: [{ type: "input_text", text: "" }],
      };
      const { upstream } = await forward("/v1/responses", "openai", {
        model: "gpt-test",
        ...(streamed
          ? { padding: "x".repeat(STREAMING_PARSE_SPOOL_BYTES + 1) }
          : {}),
        input: [instruction, { role: "user", content: "hello" }],
      });
      expect((upstream.input as unknown[])[0]).toEqual(instruction);
    },
  );

  it.each([
    ["system", false, false],
    ["system", false, true],
    ["system", true, false],
    ["system", true, true],
    ["developer", false, false],
    ["developer", false, true],
    ["developer", true, false],
    ["developer", true, true],
  ] as const)(
    "replays native Responses string %s instruction with type=%s (streamed=%s)",
    async (role, explicitType, streamed) => {
      const instruction = {
        ...(explicitType ? { type: "message" } : {}),
        role,
        content: "native instruction",
      };
      const { upstream } = await forward("/v1/responses", "openai", {
        model: "gpt-test",
        ...(streamed
          ? { padding: "x".repeat(STREAMING_PARSE_SPOOL_BYTES + 1) }
          : {}),
        input: [instruction, { role: "user", content: "hello" }],
      });
      expect((upstream.input as unknown[])[0]).toEqual(instruction);
    },
  );

  it.each([
    ["text", false],
    ["text", true],
    ["output_text", false],
    ["output_text", true],
  ] as const)(
    "rejects request-only Responses user %s metadata before storage and dispatch (streamed=%s)",
    async (partType, streamed) => {
      const { response } = await forward(
        "/v1/responses",
        "openai",
        {
          model: "gpt-test",
          ...(streamed
            ? { padding: "x".repeat(STREAMING_PARSE_SPOOL_BYTES + 1) }
            : {}),
          input: [
            {
              role: "user",
              content: [
                partType === "text"
                  ? {
                      type: "text",
                      text: "private words",
                      vendor_metadata: "private",
                    }
                  : {
                      type: "output_text",
                      text: "private words",
                      vendor_metadata: "private",
                    },
              ],
            },
          ],
        },
        false,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: {
          type: "invalid_request_error",
          message: "Unsupported cross-provider request",
        },
      });
    },
  );

  it.each([false, true])(
    "rejects unsupported native Responses user output-text metadata (streamed=%s)",
    async (streamed) => {
      const { response } = await forward(
        "/v1/responses",
        "openai",
        {
          model: "gpt-test",
          ...(streamed
            ? { padding: "x".repeat(STREAMING_PARSE_SPOOL_BYTES + 1) }
            : {}),
          input: [
            {
              type: "message",
              role: "user",
              id: "msg_user",
              status: "completed",
              content: [
                {
                  type: "output_text",
                  text: "hello",
                  cache_control: { type: "ephemeral" },
                },
              ],
            },
          ],
        },
        false,
      );
      expect(response.status).toBe(400);
    },
  );

  it.each([false, true])(
    "replays valid native Responses user output-text parts (streamed=%s)",
    async (streamed) => {
      const user = {
        type: "message",
        role: "user",
        id: "msg_user",
        status: "completed",
        content: [{ type: "output_text", text: "hello" }],
      };
      const { upstream } = await forward("/v1/responses", "openai", {
        model: "gpt-test",
        ...(streamed
          ? { padding: "x".repeat(STREAMING_PARSE_SPOOL_BYTES + 1) }
          : {}),
        input: [user],
      });
      expect(upstream.input).toContainEqual(user);
    },
  );

  it.each([false, true])(
    "rejects a native Responses web-search tool on an Anthropic route (streamed=%s)",
    async (streamed) => {
      const { response } = await forward(
        "/v1/responses",
        "anthropic",
        {
          model: "claude-test",
          ...(streamed
            ? { padding: "x".repeat(STREAMING_PARSE_SPOOL_BYTES + 1) }
            : {}),
          input: [{ role: "user", content: "search the web" }],
          tools: [{ type: "web_search_preview" }],
        },
        false,
      );
      expect(response.status).toBe(400);
    },
  );

  it.each([false, true])(
    "rejects incomplete native Responses function calls (streamed=%s)",
    async (streamed) => {
      const { response } = await forward(
        "/v1/responses",
        "openai",
        {
          model: "gpt-test",
          ...(streamed
            ? { padding: "x".repeat(STREAMING_PARSE_SPOOL_BYTES + 1) }
            : {}),
          input: [
            {
              type: "function_call",
              call_id: "call_read",
              name: "read",
              arguments: "{}",
              status: "incomplete",
            },
            {
              type: "function_call_output",
              call_id: "call_read",
              output: "done",
            },
          ],
        },
        false,
      );
      expect(response.status).toBe(400);
    },
  );

  it.each([false, true])(
    "rejects malformed native Responses function-call arguments (streamed=%s)",
    async (streamed) => {
      const { response } = await forward(
        "/v1/responses",
        "openai",
        {
          model: "gpt-test",
          ...(streamed
            ? { padding: "x".repeat(STREAMING_PARSE_SPOOL_BYTES + 1) }
            : {}),
          input: [
            {
              type: "function_call",
              call_id: "call_read",
              name: "read",
              arguments: "not json",
            },
            {
              type: "function_call_output",
              call_id: "call_read",
              output: "done",
            },
          ],
        },
        false,
      );
      expect(response.status).toBe(400);
    },
  );

  it.each([false, true])(
    "rejects malformed native Responses array-output envelopes (streamed=%s)",
    async (streamed) => {
      const { response } = await forward(
        "/v1/responses",
        "openai",
        {
          model: "gpt-test",
          ...(streamed
            ? { padding: "x".repeat(STREAMING_PARSE_SPOOL_BYTES + 1) }
            : {}),
          input: [
            {
              type: "function_call",
              call_id: "call_read",
              name: "read",
              arguments: "{}",
            },
            {
              type: "function_call_output",
              call_id: "call_read",
              status: "incomplete",
              output: [{ type: "output_text", text: "partial" }],
            },
          ],
        },
        false,
      );
      expect(response.status).toBe(400);
    },
  );

  it.each([false, true])(
    "rejects unknown native Responses array-output fields (streamed=%s)",
    async (streamed) => {
      const { response } = await forward(
        "/v1/responses",
        "openai",
        {
          model: "gpt-test",
          ...(streamed
            ? { padding: "x".repeat(STREAMING_PARSE_SPOOL_BYTES + 1) }
            : {}),
          input: [
            {
              type: "function_call",
              call_id: "call_read",
              name: "read",
              arguments: "{}",
            },
            {
              type: "function_call_output",
              call_id: "call_read",
              extra: "not representable",
              output: [{ type: "output_text", text: "done" }],
            },
          ],
        },
        false,
      );
      expect(response.status).toBe(400);
    },
  );

  it.each([false, true])(
    "replays valid native Responses function calls and array results (streamed=%s)",
    async (streamed) => {
      const call = {
        type: "function_call",
        call_id: "call_read",
        name: "read",
        arguments: "{}",
        status: "completed",
      };
      const result = {
        type: "function_call_output",
        call_id: "call_read",
        status: "completed",
        output: [{ type: "output_text", text: "done" }],
      };
      const { upstream } = await forward("/v1/responses", "openai", {
        model: "gpt-test",
        ...(streamed
          ? { padding: "x".repeat(STREAMING_PARSE_SPOOL_BYTES + 1) }
          : {}),
        input: [call, result],
      });
      expect(upstream.input).toContainEqual(call);
      expect(upstream.input).toContainEqual(result);
    },
  );

  it("does not replay stripped session markers in native Responses user provenance", async () => {
    const { upstream } = await forward("/v1/responses", "openai", {
      model: "gpt-test",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "work\n[lore:session-id=12345678]" },
          ],
        },
      ],
    });
    expect(JSON.stringify(upstream.input)).toContain("work");
    expect(JSON.stringify(upstream.input)).not.toContain("lore:session-id");
  });

  it("does not replay stripped session markers in native Chat text parts", async () => {
    const { upstream } = await forward("/v1/chat/completions", "openrouter", {
      model: "gpt-test",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "work\n[lore:session-id=12345678]",
              cache_control: { type: "ephemeral" },
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(upstream.messages)).toContain("work");
    expect(JSON.stringify(upstream.messages)).not.toContain("lore:session-id");
  });

  it.each([false, true])(
    "keeps both text parts of a native Responses tool result (streamed=%s)",
    async (streamed) => {
      const call = {
        type: "function_call",
        call_id: "call_parts",
        name: "read",
        arguments: "{}",
      };
      const result = {
        type: "function_call_output",
        call_id: "call_parts",
        output: [
          { type: "output_text", text: "first part" },
          { type: "output_text", text: "second part" },
        ],
      };
      const user = { type: "message", role: "user", content: "continue" };
      const { upstream } = await forward("/v1/responses", "openai", {
        model: "gpt-test",
        ...(streamed
          ? { padding: "x".repeat(STREAMING_PARSE_SPOOL_BYTES + 1) }
          : {}),
        input: [call, result, user],
      });
      expect(upstream.input).toEqual(
        expect.arrayContaining([call, result, user]),
      );
      expect(
        (upstream.input as Array<{ type?: string }>).filter(
          (item) => item.type === "function_call_output",
        ),
      ).toEqual([result]);
    },
  );

  it.each([
    [1, false, "second part"],
    [1, true, "second part"],
    [4, false, "second part"],
    [4, true, "second part"],
    [4, false, ""],
    [4, true, ""],
  ] as const)(
    "keeps a native Responses tool-output array across Layer %i (streamed=%s, last=%s)",
    async (layer, streamed, lastPart) => {
      const sessionID = `cross-provider-tool-array-layer-${layer}-${streamed}-${lastPart.length}`;
      const result = {
        type: "function_call_output",
        call_id: "call_layer_parts",
        output: [
          { type: "output_text", text: "first part" },
          { type: "output_text", text: lastPart },
        ],
      };
      const { upstream } = await forward(
        "/v1/responses",
        "openai",
        {
          model: "gpt-test",
          ...(streamed
            ? { padding: "x".repeat(STREAMING_PARSE_SPOOL_BYTES + 1) }
            : {}),
          input: [
            {
              type: "function_call",
              call_id: "call_layer_parts",
              name: "read",
              arguments: "{}",
            },
            result,
            { role: "user", content: "continue" },
          ],
        },
        true,
        async () => {
          const accepted = await harness!.request("/v1/responses", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: "Bearer test-key",
              "x-lore-provider": "openai",
              "x-lore-project": projectPath!,
              "x-lore-agent": "coder",
              "x-lore-session-id": sessionID,
            },
            body: JSON.stringify({
              model: "gpt-test",
              input: [{ role: "user", content: "start" }],
            }),
          });
          expect(accepted.status, await accepted.text()).toBe(200);
          const session = [...getActiveSessions().values()].find(
            (candidate) => candidate.headerSessionId === sessionID,
          );
          if (!session || session.storageTenantId === undefined)
            throw new Error("missing accepted session owner");
          core.withTenant(session.storageTenantId, () =>
            core.setForceMinLayer(layer, session.sessionID),
          );
        },
        { upstreamCalls: 2, headers: { "x-lore-session-id": sessionID } },
      );
      expect(upstream.input).toContainEqual(result);
    },
  );

  it.each([
    [1, false, false, "", "array"],
    [1, true, false, "", "array"],
    [4, false, true, "", "array"],
    [4, false, false, "result", "array"],
    [4, false, true, "result", "array"],
    [4, false, false, "result", "string"],
    [4, false, false, "", "string"],
    [4, false, false, "", "empty-array"],
  ] as const)(
    "keeps one native Responses tool-output part across Layer %i (envelope=%s, streamed=%s, text=%s, kind=%s)",
    async (layer, withEnvelope, streamed, text, kind) => {
      const sessionID = `cross-provider-tool-one-layer-${layer}-${withEnvelope}-${streamed}-${text.length}-${kind}`;
      const result = {
        type: "function_call_output",
        call_id: "call_empty_part",
        ...(withEnvelope ? { id: "fc_empty", status: "completed" } : {}),
        output:
          kind === "string"
            ? text
            : kind === "empty-array"
              ? []
              : [{ type: "output_text", text }],
      };
      const { upstream } = await forward(
        "/v1/responses",
        "openai",
        {
          model: "gpt-test",
          ...(streamed
            ? { padding: "x".repeat(STREAMING_PARSE_SPOOL_BYTES + 1) }
            : {}),
          input: [
            {
              type: "function_call",
              call_id: "call_empty_part",
              name: "read",
              arguments: "{}",
            },
            result,
            { role: "user", content: "continue" },
          ],
        },
        true,
        async () => {
          const accepted = await harness!.request("/v1/responses", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: "Bearer test-key",
              "x-lore-provider": "openai",
              "x-lore-project": projectPath!,
              "x-lore-agent": "coder",
              "x-lore-session-id": sessionID,
            },
            body: JSON.stringify({
              model: "gpt-test",
              input: [{ role: "user", content: "start" }],
            }),
          });
          expect(accepted.status, await accepted.text()).toBe(200);
          const session = [...getActiveSessions().values()].find(
            (candidate) => candidate.headerSessionId === sessionID,
          );
          if (!session || session.storageTenantId === undefined)
            throw new Error("missing accepted session owner");
          core.withTenant(session.storageTenantId, () =>
            core.setForceMinLayer(layer, session.sessionID),
          );
        },
        { upstreamCalls: 2, headers: { "x-lore-session-id": sessionID } },
      );
      expect(upstream.input).toContainEqual(result);
    },
  );

  it.each([false, true])(
    "keeps a compressed older native Responses output array at Layer 2 (streamed=%s)",
    async (streamed) => {
      const sessionID = `cross-provider-compressed-tool-array-${streamed}`;
      const { upstream } = await forward(
        "/v1/responses",
        "openai",
        {
          model: "gpt-test",
          ...(streamed
            ? { padding: "x".repeat(STREAMING_PARSE_SPOOL_BYTES + 1) }
            : {}),
          input: [
            { role: "user", content: "earlier turn" },
            {
              type: "function_call",
              call_id: "call_old",
              name: "read",
              arguments: "{}",
            },
            {
              type: "function_call_output",
              call_id: "call_old",
              output: [{ type: "output_text", text: "old result" }],
            },
            { role: "user", content: "next turn" },
            {
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "done" }],
            },
            { role: "user", content: "continue" },
          ],
        },
        true,
        async () => {
          const accepted = await harness!.request("/v1/responses", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: "Bearer test-key",
              "x-lore-provider": "openai",
              "x-lore-project": projectPath!,
              "x-lore-agent": "coder",
              "x-lore-session-id": sessionID,
            },
            body: JSON.stringify({
              model: "gpt-test",
              input: [{ role: "user", content: "start" }],
            }),
          });
          expect(accepted.status, await accepted.text()).toBe(200);
          const session = [...getActiveSessions().values()].find(
            (candidate) => candidate.headerSessionId === sessionID,
          );
          if (!session || session.storageTenantId === undefined)
            throw new Error("missing accepted session owner");
          core.withTenant(session.storageTenantId, () =>
            core.setForceMinLayer(2, session.sessionID),
          );
        },
        { upstreamCalls: 2, headers: { "x-lore-session-id": sessionID } },
      );
      expect(upstream.input).toContainEqual({
        type: "function_call_output",
        call_id: "call_old",
        output: [{ type: "output_text", text: expect.any(String) }],
      });
      const session = [...getActiveSessions().values()].find(
        (candidate) => candidate.headerSessionId === sessionID,
      );
      if (!session) throw new Error("missing accepted session");
      expect(core.getLastLayer(session.sessionID)).toBe(2);
      const output = (upstream.input as Array<{ output?: unknown }>).find(
        (item) => Array.isArray(item.output),
      )?.output as Array<{ text: string }> | undefined;
      expect(output?.[0]?.text).toBe(
        core.toolStripAnnotation("read", "old result"),
      );
    },
  );

  it("keeps cited Responses tool text in memory while replaying native citations", async () => {
    const result = {
      type: "function_call_output",
      call_id: "call_cited",
      output: [
        {
          type: "output_text",
          text: "the cited result",
          annotations: [
            { type: "url_citation", url: "https://example.test/source" },
          ],
        },
      ],
    };
    const input = [
      {
        type: "function_call",
        call_id: "call_cited",
        name: "read",
        arguments: "{}",
      },
      result,
      { role: "user", content: "continue" },
    ];
    const parsed = parseOpenAIResponsesRequest(
      { model: "gpt-test", input },
      { authorization: "Bearer test-key" },
    );
    const loreMessages = gatewayMessagesToLore(parsed.messages, "cited-tool");
    const toolPart = loreMessages
      .flatMap((message) => message.parts)
      .find(
        (part) =>
          core.isToolPart(part) &&
          part.tool === "result" &&
          part.callID === "call_cited",
      );
    if (!toolPart || !core.isToolPart(toolPart))
      throw new Error("missing cited tool result");
    expect(toolPart.state).toMatchObject({
      status: "completed",
      output: "the cited result",
    });
    expect(JSON.stringify(toolPart.state)).not.toContain("example.test");

    const { upstream } = await forward("/v1/responses", "openai", {
      model: "gpt-test",
      input,
    });
    expect(upstream.input).toContainEqual(result);
  });

  it.each(
    (
      [
        "citations",
        "envelope",
        "empty-envelope",
        "input-text",
        "empty-annotations",
      ] as const
    ).flatMap((metadata) =>
      [false, true].map((streamed) => [metadata, streamed] as const),
    ),
  )(
    "rejects native tool-output %s when emergency Layer 4 cannot replay it (streamed=%s)",
    async (metadata, streamed) => {
      const sessionID = `cross-provider-tool-metadata-layer-four-${metadata}-${streamed}`;
      const { response } = await forward(
        "/v1/responses",
        "openai",
        {
          model: "gpt-test",
          ...(streamed
            ? { padding: "x".repeat(STREAMING_PARSE_SPOOL_BYTES + 1) }
            : {}),
          input: [
            {
              type: "function_call",
              call_id: "call_cited_layer",
              name: "read",
              arguments: "{}",
            },
            {
              type: "function_call_output",
              call_id: "call_cited_layer",
              ...(metadata === "envelope" || metadata === "empty-envelope"
                ? { id: "fc_output_layer", status: "completed" }
                : {}),
              output: [
                {
                  type:
                    metadata === "input-text" ? "input_text" : "output_text",
                  text: metadata === "empty-envelope" ? "" : "cited result",
                  ...(metadata === "citations"
                    ? {
                        annotations: [
                          {
                            type: "url_citation",
                            url: "https://example.test/source",
                          },
                        ],
                      }
                    : metadata === "empty-annotations"
                      ? { annotations: [] }
                      : {}),
                },
              ],
            },
            { role: "user", content: "continue" },
          ],
        },
        false,
        async () => {
          const accepted = await harness!.request("/v1/responses", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: "Bearer test-key",
              "x-lore-provider": "openai",
              "x-lore-project": projectPath!,
              "x-lore-agent": "coder",
              "x-lore-session-id": sessionID,
            },
            body: JSON.stringify({
              model: "gpt-test",
              input: [{ role: "user", content: "start" }],
            }),
          });
          expect(accepted.status, await accepted.text()).toBe(200);
          const session = [...getActiveSessions().values()].find(
            (candidate) => candidate.headerSessionId === sessionID,
          );
          if (!session || session.storageTenantId === undefined)
            throw new Error("missing accepted session owner");
          core.withTenant(session.storageTenantId, () =>
            core.setForceMinLayer(4, session.sessionID),
          );
        },
        { upstreamCalls: 2, headers: { "x-lore-session-id": sessionID } },
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: {
          type: "invalid_request_error",
          message: "Unsupported cross-provider request",
        },
      });
    },
  );

  it("rejects cited Responses tool output before forwarding to Anthropic", async () => {
    const { response } = await forward(
      "/v1/responses",
      "anthropic",
      {
        model: "claude-test",
        input: [
          {
            type: "function_call",
            call_id: "call_foreign_citation",
            name: "read",
            arguments: "{}",
          },
          {
            type: "function_call_output",
            call_id: "call_foreign_citation",
            output: [
              {
                type: "output_text",
                text: "cited result",
                annotations: [
                  { type: "url_citation", url: "https://example.test/source" },
                ],
              },
            ],
          },
          { role: "user", content: "continue" },
        ],
      },
      false,
    );
    expect(response.status).toBe(400);
  });

  it.each([false, true])(
    "preserves native Chat strict tools (streamed=%s)",
    async (streamed) => {
      const { upstream } = await forward("/v1/chat/completions", "openrouter", {
        model: "gpt-test",
        ...(streamed
          ? { padding: "x".repeat(STREAMING_PARSE_SPOOL_BYTES + 1) }
          : {}),
        messages: [{ role: "user", content: "read" }],
        tools: [
          {
            type: "function",
            function: {
              name: "read",
              description: "Read a file",
              parameters: { type: "object", properties: {} },
              strict: true,
            },
          },
        ],
      });
      const forwarded = (
        upstream.tools as Array<{ function?: Record<string, unknown> }>
      ).find((tool) => tool.function?.name === "read");
      expect(forwarded?.function?.strict).toBe(true);
    },
  );

  it.each([false, true])(
    "rejects Chat strict tools on an Anthropic route (streamed=%s)",
    async (streamed) => {
      const { response } = await forward(
        "/v1/chat/completions",
        "anthropic",
        {
          model: "claude-test",
          ...(streamed
            ? { padding: "x".repeat(STREAMING_PARSE_SPOOL_BYTES + 1) }
            : {}),
          messages: [{ role: "user", content: "read" }],
          tools: [
            {
              type: "function",
              function: {
                name: "read",
                parameters: { type: "object", properties: {} },
                strict: true,
              },
            },
          ],
        },
        false,
      );
      expect(response.status).toBe(400);
    },
  );

  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ] as const)(
    "blocks client proof headers from another provider (streamed=%s, meta=%s)",
    async (streamed, meta) => {
      const { headers } = await forward(
        "/v1/responses",
        "openai",
        {
          model: "gpt-test",
          ...(streamed
            ? { padding: "x".repeat(STREAMING_PARSE_SPOOL_BYTES + 1) }
            : {}),
          input: [{ role: "user", content: "hello" }],
        },
        true,
        undefined,
        {
          headers: {
            DPoP: "synthetic-oauth-proof",
            "x-forwarded-client-cert": "synthetic-client-identity",
            "x-ssl-client-cert": "synthetic-ssl-client-identity",
            "x-client-cert": "synthetic-short-client-identity",
            "x-client-certificate": "synthetic-client-certificate",
            "ssl-client-cert": "synthetic-ssl-certificate",
            ...(meta ? { "x-lore-agent": "summary" } : {}),
          },
        },
      );
      const names = Object.keys(headers).map((key) => key.toLowerCase());
      expect(names).not.toContain("dpop");
      expect(names).not.toContain("x-forwarded-client-cert");
      expect(names).not.toContain("x-ssl-client-cert");
      expect(names).not.toContain("x-client-cert");
      expect(names).not.toContain("x-client-certificate");
      expect(names).not.toContain("ssl-client-cert");
    },
  );

  it("rejects malformed native Responses assistant content before dispatch", async () => {
    const { response } = await forward(
      "/v1/responses",
      "openai",
      {
        model: "gpt-test",
        input: [
          {
            type: "message",
            role: "assistant",
            content: { type: "output_text", text: "hidden" },
          },
          { role: "user", content: "continue" },
        ],
      },
      false,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        type: "invalid_request_error",
        message: "Unsupported cross-provider request",
      },
    });
  });

  it.each([false, true])(
    "rejects malformed top-level Responses input before dispatch (streamed=%s)",
    async (streamed) => {
      const { response } = await forward(
        "/v1/responses",
        "openai",
        {
          model: "gpt-test",
          ...(streamed
            ? {
                metadata: {
                  padding: "x".repeat(STREAMING_PARSE_SPOOL_BYTES + 1),
                },
              }
            : {}),
          input: { type: "message", role: "user", content: "hidden" },
        },
        false,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: {
          type: "invalid_request_error",
          message: "Unsupported cross-provider request",
        },
      });
    },
  );

  it("rejects Responses developer instructions that Anthropic would elevate to system", async () => {
    const { response } = await forward(
      "/v1/responses",
      "anthropic",
      {
        model: "claude-test",
        max_output_tokens: 128,
        instructions: "system instruction",
        input: [
          {
            role: "developer",
            content: [{ type: "input_text", text: "developer instruction" }],
          },
          {
            role: "user",
            content: [
              { type: "input_text", text: "user question" },
              { type: "input_image", image_url: dataURL },
            ],
          },
          {
            type: "function_call",
            call_id: "call_read",
            name: "read",
            arguments: '{"path":"a.txt"}',
          },
          {
            type: "function_call_output",
            call_id: "call_read",
            output: "file body",
          },
          { role: "user", content: "answer now" },
        ],
        tools: [
          {
            type: "function",
            name: "read",
            description: "read a file",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
            },
          },
        ],
      },
      false,
    );
    expect(response.status).toBe(400);
    const error = (await response.json()) as {
      error: { type: string; message: string };
    };
    expect(error.error).toEqual({
      type: "invalid_request_error",
      message: "Unsupported cross-provider request",
    });
  });

  it("rejects Responses reasoning controls before Anthropic dispatch", async () => {
    const { response } = await forward(
      "/v1/responses",
      "anthropic",
      {
        model: "claude-test",
        reasoning: { effort: "high" },
        input: [{ role: "user", content: "question" }],
      },
      false,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        type: "invalid_request_error",
        message: "Unsupported cross-provider request",
      },
    });
  });

  it("retains Responses reasoning controls on a native route", async () => {
    const reasoning = { effort: "high" };
    const { upstream } = await forward("/v1/responses", "openai", {
      model: "gpt-test",
      reasoning,
      input: [{ role: "user", content: "question" }],
    });
    expect(upstream.reasoning).toEqual(reasoning);
  });

  it("keeps Responses developer instructions above user input on a native Responses route", async () => {
    const { upstream } = await forward("/v1/responses", "openai", {
      model: "gpt-test",
      instructions: "system instruction",
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: "input system instruction" }],
        },
        {
          role: "developer",
          content: [{ type: "input_text", text: "developer instruction" }],
        },
        {
          role: "user",
          content: [{ type: "input_text", text: "user question" }],
        },
      ],
    });
    expect(upstream.instructions).toContain("system instruction");
    expect(upstream.instructions).not.toContain("input system instruction");
    expect(upstream.instructions).not.toContain("developer instruction");
    expect(
      (upstream.input as Array<{ role: string }>).map((item) => item.role),
    ).toEqual(["system", "developer", "user"]);
    expect(upstream.input).toEqual(
      expect.arrayContaining([
        {
          role: "system",
          content: [{ type: "input_text", text: "input system instruction" }],
        },
        {
          role: "developer",
          content: [{ type: "input_text", text: "developer instruction" }],
        },
      ]),
    );
    expect(JSON.stringify(upstream.input)).toContain("user question");
  });

  it("preserves separate native Responses developer text parts", async () => {
    const parts = [
      { type: "input_text", text: "first directive" },
      { type: "input_text", text: "second directive" },
    ];
    const { upstream } = await forward("/v1/responses", "openai", {
      model: "gpt-test",
      input: [
        { type: "message", role: "developer", content: parts },
        { type: "message", role: "user", content: "question" },
      ],
    });
    const input = upstream.input as Array<Record<string, unknown>>;
    expect(input[0]).toEqual({
      type: "message",
      role: "developer",
      content: parts,
    });
    expect(input[1]).toMatchObject({ role: "user" });
  });

  it.each(["anthropic", "openai"] as const)(
    "rejects unrepresented Responses instruction envelope fields on %s",
    async (provider) => {
      const { response } = await forward(
        "/v1/responses",
        provider,
        {
          model: provider === "anthropic" ? "claude-test" : "gpt-test",
          input: [
            {
              type: "message",
              role: "system",
              status: "incomplete",
              content: [{ type: "input_text", text: "rule" }],
            },
            { role: "user", content: "question" },
          ],
        },
        false,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: {
          type: "invalid_request_error",
          message: "Unsupported cross-provider request",
        },
      });
    },
  );

  it("rejects annotated Responses instructions before Anthropic dispatch", async () => {
    const { response } = await forward(
      "/v1/responses",
      "anthropic",
      {
        model: "claude-test",
        input: [
          {
            type: "message",
            role: "system",
            content: [
              {
                type: "input_text",
                text: "rule",
                annotations: [
                  { type: "url_citation", url: "https://example.test/rule" },
                ],
              },
            ],
          },
          { type: "message", role: "user", content: "question" },
        ],
      },
      false,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        type: "invalid_request_error",
        message: "Unsupported cross-provider request",
      },
    });
  });

  it("rejects native Responses instructions after conversation items instead of reordering", async () => {
    const { response } = await forward(
      "/v1/responses",
      "openai",
      {
        model: "gpt-test",
        input: [
          { type: "message", role: "user", content: "A" },
          {
            type: "message",
            role: "developer",
            content: [{ type: "input_text", text: "B" }],
          },
          { type: "message", role: "user", content: "C" },
        ],
      },
      false,
    );
    expect(response.status).toBe(400);
  });

  it("rejects native Responses developer items after a reasoning item", async () => {
    const { response } = await forward(
      "/v1/responses",
      "openai",
      {
        model: "gpt-test",
        input: [
          {
            type: "reasoning",
            summary: [{ type: "summary_text", text: "prior reasoning" }],
          },
          {
            role: "developer",
            content: [{ type: "input_text", text: "late directive" }],
          },
          { role: "user", content: "question" },
        ],
      },
      false,
    );
    expect(response.status).toBe(400);
  });

  it("keeps Gemini instructions, inline images and function results on Anthropic upstream", async () => {
    const { upstream } = await forward(
      "/v1beta/models/claude-test:generateContent",
      "anthropic",
      {
        systemInstruction: { parts: [{ text: "Gemini system instruction" }] },
        contents: [
          {
            role: "user",
            parts: [
              { text: "inspect the picture" },
              { inlineData: { mimeType: "image/png", data: png } },
            ],
          },
          {
            role: "model",
            parts: [
              {
                functionCall: {
                  id: "call_read",
                  name: "read",
                  args: { path: "a.txt" },
                },
              },
            ],
          },
          {
            role: "user",
            parts: [
              {
                functionResponse: {
                  id: "call_read",
                  name: "read",
                  response: { text: "file body" },
                },
              },
            ],
          },
          { role: "user", parts: [{ text: "answer now" }] },
        ],
        tools: [
          {
            functionDeclarations: [
              {
                name: "read",
                description: "read a file",
                parameters: {
                  type: "object",
                  properties: { path: { type: "string" } },
                },
              },
            ],
          },
        ],
      },
    );
    expect(JSON.stringify(upstream.system)).toContain(
      "Gemini system instruction",
    );
    expect(upstream.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: expect.arrayContaining([
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: png },
            },
          ]),
        }),
        expect.objectContaining({
          role: "assistant",
          content: expect.arrayContaining([
            expect.objectContaining({
              type: "tool_use",
              id: "call_read",
              name: "read",
            }),
          ]),
        }),
        expect.objectContaining({
          role: "user",
          content: expect.arrayContaining([
            expect.objectContaining({
              type: "tool_result",
              tool_use_id: "call_read",
            }),
          ]),
        }),
      ]),
    );
    expect(upstream.tools).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "read" })]),
    );
  });

  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ] as const)(
    "rejects signed Gemini history on Anthropic (streamed=%s, meta=%s)",
    async (streamed, meta) => {
      const { response } = await forward(
        "/v1beta/models/claude-test:generateContent",
        "anthropic",
        {
          ...(streamed
            ? { padding: "x".repeat(STREAMING_PARSE_SPOOL_BYTES + 1) }
            : {}),
          contents: [
            {
              role: "model",
              parts: [
                { text: "signed output", thoughtSignature: "signed-proof" },
              ],
            },
            { role: "user", parts: [{ text: "continue" }] },
          ],
        },
        false,
        undefined,
        meta ? { headers: { "x-lore-agent": "summary" } } : undefined,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: {
          type: "invalid_request_error",
          message: "Unsupported cross-provider request",
        },
      });
    },
  );

  it.each([false, true])(
    "rejects Gemini safety settings on Anthropic before dispatch (streamed=%s)",
    async (streamed) => {
      const { response } = await forward(
        "/v1beta/models/claude-test:generateContent",
        "anthropic",
        {
          contents: [{ role: "user", parts: [{ text: "hello" }] }],
          ...(streamed
            ? { padding: "x".repeat(STREAMING_PARSE_SPOOL_BYTES + 1) }
            : {}),
          safetySettings: [
            {
              category: "HARM_CATEGORY_DANGEROUS_CONTENT",
              threshold: "BLOCK_LOW_AND_ABOVE",
            },
          ],
        },
        false,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: {
          type: "invalid_request_error",
          message: "Unsupported cross-provider request",
        },
      });
    },
  );

  it.each([
    ["function thought", false, false],
    ["function thought", true, false],
    ["function thought", false, true],
    ["function thought", true, true],
    ["signed system", false, false],
    ["signed system", true, false],
    ["signed system", false, true],
    ["signed system", true, true],
  ] as const)(
    "rejects Gemini %s on Anthropic (streamed=%s, meta=%s)",
    async (kind, streamed, meta) => {
      const { response } = await forward(
        "/v1beta/models/claude-test:generateContent",
        "anthropic",
        {
          ...(streamed
            ? { padding: "x".repeat(STREAMING_PARSE_SPOOL_BYTES + 1) }
            : {}),
          ...(kind === "signed system"
            ? {
                systemInstruction: {
                  parts: [
                    { text: "private instruction", thoughtSignature: "proof" },
                  ],
                },
              }
            : {}),
          contents:
            kind === "function thought"
              ? [
                  {
                    role: "model",
                    parts: [
                      {
                        functionCall: {
                          id: "call_read",
                          name: "read",
                          args: {},
                        },
                        thought: true,
                      },
                    ],
                  },
                  {
                    role: "user",
                    parts: [
                      {
                        functionResponse: {
                          id: "call_read",
                          name: "read",
                          response: { output: "ok" },
                        },
                      },
                    ],
                  },
                ]
              : [{ role: "user", parts: [{ text: "continue" }] }],
        },
        false,
        undefined,
        meta ? { headers: { "x-lore-agent": "summary" } } : undefined,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: {
          type: "invalid_request_error",
          message: "Unsupported cross-provider request",
        },
      });
    },
  );

  it("keeps Gemini thought-marked function calls on its native route", async () => {
    const part = {
      functionCall: { id: "call_read", name: "read", args: {} },
      thought: true,
    };
    const { upstream } = await forward(
      "/v1beta/models/gemini-test:generateContent",
      "gemini",
      {
        contents: [
          { role: "model", parts: [part] },
          {
            role: "user",
            parts: [
              {
                functionResponse: {
                  id: "call_read",
                  name: "read",
                  response: { output: "ok" },
                },
              },
            ],
          },
        ],
      },
    );
    expect(upstream.contents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "model", parts: [part] }),
      ]),
    );
  });

  it.each([false, true])(
    "rejects signed Gemini system parts when native system text changes (streamed=%s)",
    async (streamed) => {
      const { response } = await forward(
        "/v1beta/models/gemini-test:generateContent",
        "gemini",
        {
          systemInstruction: {
            parts: [
              {
                text: "native signed instruction",
                thoughtSignature: "native-proof",
              },
            ],
          },
          contents: [{ role: "user", parts: [{ text: "continue" }] }],
          ...(streamed
            ? { padding: "x".repeat(STREAMING_PARSE_SPOOL_BYTES + 1) }
            : {}),
        },
        false,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: {
          type: "invalid_request_error",
          message: "Unsupported cross-provider request",
        },
      });
    },
  );

  it.each([false, true])(
    "preserves signed Gemini system parts on an unchanged native meta route (streamed=%s)",
    async (streamed) => {
      const signedPart = {
        text: "native signed instruction",
        thoughtSignature: "native-proof",
      };
      const { upstream } = await forward(
        "/v1beta/models/gemini-test:generateContent",
        "gemini",
        {
          systemInstruction: { parts: [signedPart] },
          contents: [{ role: "user", parts: [{ text: "continue" }] }],
          ...(streamed
            ? { padding: "x".repeat(STREAMING_PARSE_SPOOL_BYTES + 1) }
            : {}),
        },
        true,
        undefined,
        { headers: { "x-lore-agent": "summary" } },
      );
      expect(upstream.systemInstruction).toEqual({ parts: [signedPart] });
    },
  );

  it.each([false, true])(
    "preserves Gemini googleSearch on its native route (streamed=%s)",
    async (streamed) => {
      const tools = [{ googleSearch: {} }];
      const { upstream } = await forward(
        "/v1beta/models/gemini-test:generateContent",
        "gemini",
        {
          contents: [{ role: "user", parts: [{ text: "search" }] }],
          tools,
          ...(streamed
            ? { padding: "x".repeat(STREAMING_PARSE_SPOOL_BYTES + 1) }
            : {}),
        },
      );
      expect(upstream.tools).toEqual(tools);
    },
  );

  it.each([false, true])(
    "preserves mixed native Gemini search and function tools (streamed=%s)",
    async (streamed) => {
      const tools = [
        { googleSearch: {} },
        {
          functionDeclarations: [
            {
              name: "read",
              description: "read a file",
              parameters: { type: "object" },
            },
          ],
        },
      ];
      const { upstream } = await forward(
        "/v1beta/models/gemini-test:generateContent",
        "gemini",
        {
          contents: [{ role: "user", parts: [{ text: "search, then read" }] }],
          tools,
          ...(streamed
            ? { padding: "x".repeat(STREAMING_PARSE_SPOOL_BYTES + 1) }
            : {}),
        },
      );
      expect(upstream.tools).toEqual(tools);
    },
  );

  it.each([false, true])(
    "preserves native Gemini parametersJsonSchema declarations (streamed=%s)",
    async (streamed) => {
      const tools = [
        {
          functionDeclarations: [
            {
              name: "read",
              description: "read a file",
              parametersJsonSchema: {
                type: "object",
                properties: { path: { type: "string" } },
                required: ["path"],
              },
            },
          ],
        },
      ];
      const { upstream } = await forward(
        "/v1beta/models/gemini-test:generateContent",
        "gemini",
        {
          contents: [{ role: "user", parts: [{ text: "read" }] }],
          tools,
          ...(streamed
            ? { padding: "x".repeat(STREAMING_PARSE_SPOOL_BYTES + 1) }
            : {}),
        },
      );
      expect(upstream.tools).toEqual(tools);
    },
  );

  it.each([false, true])(
    "rejects Gemini parametersJsonSchema before Anthropic dispatch (streamed=%s)",
    async (streamed) => {
      const { response } = await forward(
        "/v1beta/models/claude-test:generateContent",
        "anthropic",
        {
          contents: [{ role: "user", parts: [{ text: "read" }] }],
          tools: [
            {
              functionDeclarations: [
                {
                  name: "read",
                  parametersJsonSchema: { type: "object", required: ["path"] },
                },
              ],
            },
          ],
          ...(streamed
            ? { padding: "x".repeat(STREAMING_PARSE_SPOOL_BYTES + 1) }
            : {}),
        },
        false,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: {
          type: "invalid_request_error",
          message: "Unsupported cross-provider request",
        },
      });
    },
  );

  it.each([false, true])(
    "rejects Gemini googleSearch before Anthropic dispatch (streamed=%s)",
    async (streamed) => {
      const { response } = await forward(
        "/v1beta/models/claude-test:generateContent",
        "anthropic",
        {
          contents: [{ role: "user", parts: [{ text: "search" }] }],
          tools: [{ googleSearch: {} }],
          ...(streamed
            ? { padding: "x".repeat(STREAMING_PARSE_SPOOL_BYTES + 1) }
            : {}),
        },
        false,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: {
          type: "invalid_request_error",
          message: "Unsupported cross-provider request",
        },
      });
    },
  );

  it("keeps Chat JSON-schema output constraints on Responses upstream", async () => {
    const schema = {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    };
    const { upstream } = await forward("/v1/chat/completions", "openai", {
      model: "gpt-test",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "extract the name" },
            { type: "image_url", image_url: { url: dataURL, detail: "high" } },
          ],
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "person",
          description: "The person's name",
          strict: true,
          schema,
        },
      },
    });
    expect(upstream.text).toEqual({
      format: {
        type: "json_schema",
        name: "person",
        description: "The person's name",
        strict: true,
        schema,
      },
    });
    expect(upstream.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: expect.arrayContaining([
            { type: "input_image", image_url: dataURL, detail: "high" },
          ]),
        }),
      ]),
    );
  });

  it.each(["json_object", "text"] as const)(
    "keeps the Chat %s output mode on Responses upstream",
    async (type) => {
      const { upstream } = await forward("/v1/chat/completions", "openai", {
        model: "gpt-test",
        messages: [{ role: "user", content: "write a name" }],
        response_format: { type },
      });
      expect(upstream.text).toEqual({ format: { type } });
    },
  );

  it("retains a native Responses JSON-schema constraint during gateway forwarding", async () => {
    const format = {
      type: "json_schema",
      name: "person",
      strict: true,
      schema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        additionalProperties: false,
      },
    };
    const { upstream } = await forward("/v1/responses", "openai", {
      model: "gpt-test",
      max_output_tokens: 128,
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "extract the name" }],
        },
      ],
      text: { format },
    });
    expect(upstream.text).toEqual({ format });
  });

  it("retains a Chat JSON-schema constraint on an OpenAI Chat upstream", async () => {
    const responseFormat = {
      type: "json_schema",
      json_schema: {
        name: "person",
        strict: true,
        schema: { type: "object", properties: { name: { type: "string" } } },
      },
    };
    const { upstream } = await forward("/v1/chat/completions", "openrouter", {
      model: "gpt-test",
      messages: [{ role: "user", content: "extract a name" }],
      response_format: responseFormat,
    });
    expect(upstream.response_format).toEqual(responseFormat);
  });

  it("rejects a Responses JSON schema routed to an incompatible Chat endpoint", async () => {
    const schema = { type: "object", properties: { name: { type: "string" } } };
    const { response } = await forward(
      "/v1/responses",
      "openrouter",
      {
        model: "gpt-test",
        input: [{ role: "user", content: "extract a name" }],
        text: {
          format: { type: "json_schema", name: "person", strict: true, schema },
        },
      },
      false,
    );
    expect(response.status).toBe(400);
  });

  it("rejects Responses output controls a Chat destination cannot carry", async () => {
    const { response } = await forward(
      "/v1/responses",
      "openrouter",
      {
        model: "gpt-test",
        input: [{ role: "user", content: "hello" }],
        text: { format: { type: "text" }, verbosity: "high" },
      },
      false,
    );
    expect(response.status).toBe(400);
  });

  it("rejects an Anthropic image on a Chat route before dispatch", async () => {
    const { response } = await forward(
      "/v1/messages",
      "openrouter",
      {
        model: "gpt-test",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: png },
              },
            ],
          },
        ],
      },
      false,
    );
    expect(response.status).toBe(400);
  });

  it("routes valid Gemini text through the real upstream builder", async () => {
    const { upstream } = await forward(
      "/v1beta/models/gemini-test:generateContent",
      "gemini",
      { contents: [{ role: "user", parts: [{ text: "hello" }] }] },
    );
    expect(upstream.contents).toEqual([
      { role: "user", parts: [{ text: "hello" }] },
    ]);
  });

  it("rejects a foreign image on a Gemini route before dispatch", async () => {
    const { response } = await forward(
      "/v1beta/models/gemini-test:generateContent",
      "gemini",
      {
        contents: [
          {
            role: "user",
            parts: [{ type: "input_image", image_url: dataURL }],
          },
        ],
      },
      false,
    );
    expect(response.status).toBe(400);
  });

  it("rejects a Gemini fileData image on an Anthropic route", async () => {
    const { response } = await forward(
      "/v1beta/models/claude-test:generateContent",
      "anthropic",
      {
        contents: [
          {
            role: "user",
            parts: [
              {
                fileData: {
                  mimeType: "image/png",
                  fileUri: "gs://images/photo.png",
                },
              },
            ],
          },
        ],
      },
      false,
    );
    expect(response.status).toBe(400);
    expect((await response.json()) as unknown).toMatchObject({
      error: {
        type: "invalid_request_error",
        message: "Unsupported cross-provider request",
      },
    });
  });

  it.each(["openrouter", "openai"] as const)(
    "rejects an image-bearing Anthropic tool result on %s upstream",
    async (provider) => {
      const { response } = await forward(
        "/v1/messages",
        provider,
        {
          model: "gpt-test",
          messages: [
            {
              role: "assistant",
              content: [
                { type: "tool_use", id: "tool_1", name: "read", input: {} },
              ],
            },
            {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "tool_1",
                  content: [
                    { type: "text", text: "image follows" },
                    {
                      type: "image",
                      source: {
                        type: "base64",
                        media_type: "image/png",
                        data: png,
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
        false,
      );
      expect(response.status).toBe(400);
    },
  );

  it("rejects an image the target provider cannot fetch before any upstream call", async () => {
    const { response } = await forward(
      "/v1/chat/completions",
      "anthropic",
      {
        model: "claude-test",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: { url: "file:///private/photo.png" },
              },
            ],
          },
        ],
      },
      false,
    );
    expect(response.status).toBe(400);
    expect((await response.json()) as unknown).toMatchObject({
      error: {
        type: "invalid_request_error",
        message: "Unsupported cross-provider request",
      },
    });
  });

  it("rejects unknown nested Chat image controls without dispatch", async () => {
    const { response } = await forward(
      "/v1/chat/completions",
      "anthropic",
      {
        model: "claude-test",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: {
                  url: "https://example.test/picture.png",
                  detail: "auto",
                  crop: "left",
                },
              },
            ],
          },
        ],
      },
      false,
    );
    expect(response.status).toBe(400);
  });

  it("rejects unknown Responses image controls without dispatch", async () => {
    const { response } = await forward(
      "/v1/responses",
      "anthropic",
      {
        model: "claude-test",
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_image",
                image_url: "https://example.test/picture.png",
                crop: "left",
              },
            ],
          },
        ],
      },
      false,
    );
    expect(response.status).toBe(400);
  });

  it("normalizes a foreign image block even on a native Responses route", async () => {
    const { upstream } = await forward("/v1/responses", "openai", {
      model: "gpt-test",
      input: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: png },
            },
          ],
        },
      ],
    });
    expect(upstream.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: [
            { type: "input_image", image_url: dataURL, detail: "auto" },
          ],
        }),
      ]),
    );
  });

  it("rejects foreign images inside a native Responses assistant replay before dispatch", async () => {
    const { response } = await forward(
      "/v1/responses",
      "openai",
      {
        model: "gpt-test",
        input: [
          {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: png },
              },
            ],
          },
          { type: "message", role: "user", content: "answer" },
        ],
      },
      false,
    );
    expect(response.status).toBe(400);
  });

  it("projects a Responses assistant text item to Anthropic without a foreign envelope", async () => {
    const { upstream } = await forward("/v1/responses", "anthropic", {
      model: "claude-test",
      input: [
        {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "prior answer" }],
        },
        { type: "message", role: "user", content: "continue" },
      ],
    });
    expect(upstream.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: expect.arrayContaining([
            { type: "text", text: "prior answer" },
          ]),
        }),
      ]),
    );
  });

  it("rejects an incomplete Responses assistant answer on Anthropic before dispatch", async () => {
    const { response } = await forward(
      "/v1/responses",
      "anthropic",
      {
        model: "claude-test",
        input: [
          {
            type: "message",
            role: "assistant",
            status: "incomplete",
            content: [{ type: "output_text", text: "unfinished answer" }],
          },
          { type: "message", role: "user", content: "continue" },
        ],
      },
      false,
    );
    expect(response.status).toBe(400);
    expect((await response.json()) as unknown).toMatchObject({
      error: {
        type: "invalid_request_error",
        message: "Unsupported cross-provider request",
      },
    });
  });

  it("forwards a text-only Responses assistant without status to Anthropic", async () => {
    const parsed = parseOpenAIResponsesRequest(
      {
        model: "claude-test",
        input: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "finished answer" }],
          },
          { role: "user", content: "continue" },
        ],
      },
      { authorization: "Bearer test-key" },
    );
    const built = buildAnthropicRequest(parsed);
    expect((built.body as { messages: unknown[] }).messages).toContainEqual({
      role: "assistant",
      content: [{ type: "text", text: "finished answer" }],
    });
    const { upstream } = await forward("/v1/responses", "anthropic", {
      model: "claude-test",
      input: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "finished answer" }],
        },
        { role: "user", content: "continue" },
      ],
    });
    expect(upstream.messages).toContainEqual({
      role: "assistant",
      content: [{ type: "text", text: "finished answer" }],
    });
  });

  it.each([
    {
      name: "shorthand",
      assistant: { role: "assistant", content: "prior answer" },
    },
    {
      name: "completed message ID",
      assistant: {
        type: "message",
        role: "assistant",
        id: "msg_prior",
        status: "completed",
        content: [{ type: "output_text", text: "prior answer" }],
      },
    },
  ])(
    "forwards a Responses assistant with $name to Anthropic",
    async ({ assistant }) => {
      const { upstream } = await forward("/v1/responses", "anthropic", {
        model: "claude-test",
        input: [assistant, { role: "user", content: "continue" }],
      });
      expect(upstream.messages).toContainEqual(
        expect.objectContaining({
          role: "assistant",
          content: expect.arrayContaining([
            { type: "text", text: "prior answer" },
          ]),
        }),
      );
    },
  );

  it("rejects an empty cited Responses assistant part before Anthropic dispatch", async () => {
    const { response } = await forward(
      "/v1/responses",
      "anthropic",
      {
        model: "claude-test",
        input: [
          {
            type: "message",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: "",
                annotations: [
                  { type: "url_citation", url: "https://example.test/hidden" },
                ],
              },
              { type: "output_text", text: "visible answer" },
            ],
          },
          { role: "user", content: "continue" },
        ],
      },
      false,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        type: "invalid_request_error",
        message: "Unsupported cross-provider request",
      },
    });
  });

  it("retains an empty cited assistant part on the native Responses route", async () => {
    const parts = [
      {
        type: "output_text",
        text: "",
        annotations: [
          { type: "url_citation", url: "https://example.test/hidden" },
        ],
      },
      { type: "output_text", text: "visible answer" },
    ];
    const { upstream } = await forward("/v1/responses", "openai", {
      model: "gpt-6-sol",
      input: [
        {
          type: "message",
          role: "assistant",
          status: "completed",
          content: parts,
        },
        { role: "user", content: "continue" },
      ],
    });
    expect(upstream.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: parts,
        }),
      ]),
    );
  });

  it.each([
    { name: "empty text", content: [{ type: "output_text", text: "" }] },
    { name: "empty parts", content: [] },
  ])(
    "rejects an incomplete Responses assistant with $name before Anthropic dispatch",
    async ({ content }) => {
      const { response } = await forward(
        "/v1/responses",
        "anthropic",
        {
          model: "claude-test",
          input: [
            {
              type: "message",
              role: "assistant",
              status: "incomplete",
              content,
            },
            { role: "user", content: "continue" },
          ],
        },
        false,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: {
          type: "invalid_request_error",
          message: "Unsupported cross-provider request",
        },
      });
    },
  );

  it("rejects an unrepresentable Responses assistant envelope before Anthropic dispatch", async () => {
    const { response } = await forward(
      "/v1/responses",
      "anthropic",
      {
        model: "claude-test",
        input: [
          {
            type: "message",
            role: "assistant",
            status: "completed",
            phase: "commentary",
            content: [{ type: "output_text", text: "prior answer" }],
          },
          { role: "user", content: "continue" },
        ],
      },
      false,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        type: "invalid_request_error",
        message: "Unsupported cross-provider request",
      },
    });
  });

  it("rejects an unrepresentable shorthand Responses assistant before Anthropic dispatch", async () => {
    const { response } = await forward(
      "/v1/responses",
      "anthropic",
      {
        model: "claude-test",
        input: [
          { role: "assistant", phase: "commentary", content: "prior answer" },
          { role: "user", content: "continue" },
        ],
      },
      false,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        type: "invalid_request_error",
        message: "Unsupported cross-provider request",
      },
    });
  });

  it("rejects Responses assistant citations before Anthropic dispatch", async () => {
    const { response } = await forward(
      "/v1/responses",
      "anthropic",
      {
        model: "claude-test",
        input: [
          {
            type: "message",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: "cited answer",
                annotations: [
                  { type: "url_citation", url: "https://example.test/a" },
                ],
              },
            ],
          },
          { role: "user", content: "continue" },
        ],
      },
      false,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        type: "invalid_request_error",
        message: "Unsupported cross-provider request",
      },
    });
  });

  it("rejects an incomplete string-valued Responses assistant answer before Anthropic dispatch", async () => {
    const { response } = await forward(
      "/v1/responses",
      "anthropic",
      {
        model: "claude-test",
        input: [
          {
            type: "message",
            role: "assistant",
            status: "incomplete",
            content: "unfinished answer",
          },
          { role: "user", content: "continue" },
        ],
      },
      false,
    );
    expect(response.status).toBe(400);
    expect((await response.json()) as unknown).toMatchObject({
      error: {
        type: "invalid_request_error",
        message: "Unsupported cross-provider request",
      },
    });
  });

  it("keeps a completed string-valued Responses assistant answer on Anthropic", async () => {
    const { upstream } = await forward("/v1/responses", "anthropic", {
      model: "claude-test",
      input: [
        {
          type: "message",
          role: "assistant",
          status: "completed",
          content: "finished answer",
        },
        { role: "user", content: "continue" },
      ],
    });
    expect(upstream.messages).toContainEqual({
      role: "assistant",
      content: [{ type: "text", text: "finished answer" }],
    });
  });

  it("keeps native string-valued Responses assistant provenance intact", async () => {
    const assistant = {
      type: "message",
      role: "assistant",
      status: "completed",
      content: "finished answer",
    };
    const { upstream } = await forward("/v1/responses", "openai", {
      model: "gpt-test",
      input: [assistant, { role: "user", content: "continue" }],
    });
    expect(upstream.input).toContainEqual(assistant);
  });

  it.each(["string", "array"] as const)(
    "projects a completed %s Responses assistant message onto Chat text blocks",
    (shape) => {
      const request = parseOpenAIResponsesRequest(
        {
          model: "gpt-test",
          input: [
            {
              type: "message",
              role: "assistant",
              status: "completed",
              content:
                shape === "string"
                  ? "finished answer"
                  : [{ type: "output_text", text: "finished answer" }],
            },
            { role: "user", content: "continue" },
          ],
        },
        { authorization: "Bearer test-key" },
      );
      const { body } = buildOpenAIUpstreamRequest(
        request,
        "https://openrouter.ai/api/v1",
      );
      expect((body as { messages: unknown[] }).messages).toContainEqual({
        role: "assistant",
        content: "finished answer",
      });
    },
  );

  it.each([false, true])(
    "rejects a late Chat system instruction before native Chat dispatch (large=%s)",
    async (large) => {
      const { response } = await forward(
        "/v1/chat/completions",
        "openrouter",
        {
          model: "openai/gpt-test",
          messages: [
            {
              role: "user",
              content: large
                ? "u".repeat(STREAMING_PARSE_SPOOL_BYTES + 1)
                : "first user turn",
            },
            { role: "system", content: "later system instruction" },
            { role: "user", content: "second user turn" },
          ],
        },
        false,
      );
      expect(response.status).toBe(400);
      expect((await response.json()) as unknown).toMatchObject({
        error: {
          type: "invalid_request_error",
          message: "Unsupported cross-provider request",
        },
      });
    },
  );

  it("rejects Chat input_audio before Anthropic dispatch", async () => {
    const { response } = await forward(
      "/v1/chat/completions",
      "anthropic",
      {
        model: "claude-test",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "input_audio",
                input_audio: { data: "invented", format: "wav" },
              },
            ],
          },
        ],
      },
      false,
    );
    expect(response.status).toBe(400);
    expect((await response.json()) as unknown).toMatchObject({
      error: {
        type: "invalid_request_error",
        message: "Unsupported cross-provider request",
      },
    });
  });

  it("rejects Chat input_audio when building a Gemini-native request", () => {
    const request = parseOpenAIRequest(
      {
        model: "gemini-test",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "input_audio",
                input_audio: { data: "invented", format: "wav" },
              },
            ],
          },
        ],
      },
      { authorization: "Bearer test-key" },
    );
    expect(() =>
      buildGeminiUpstreamRequest(
        request,
        "https://generativelanguage.googleapis.com",
      ),
    ).toThrow(InvalidCrossProviderRequestError);
  });

  it("keeps the fixed 400 when bounded timeout fallback rejects a Chat output constraint", async () => {
    const history = Array.from({ length: 2049 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `turn ${index}`,
    }));
    const responseFormat = {
      type: "json_schema",
      json_schema: {
        name: "person",
        schema: { type: "object", properties: { name: { type: "string" } } },
      },
    };
    expect(
      boundFallbackHistory(
        parseOpenAIRequest(
          {
            model: "claude-test",
            messages: history,
            response_format: responseFormat,
          },
          { authorization: "Bearer test-key" },
        ),
        1_000_000,
        8_192,
        "anthropic",
      ),
    ).not.toBeNull();
    const state = { captured: false, timedOut: false };
    const restore: Array<() => void> = [];
    try {
      const { response } = await forward(
        "/v1/chat/completions",
        "anthropic",
        {
          model: "claude-test",
          messages: history,
          response_format: responseFormat,
        },
        false,
        () => {
          const originalNow = Date.now();
          const clock = vi
            .spyOn(Date, "now")
            .mockImplementation(
              () => originalNow + (state.timedOut ? 120_000 : 0),
            );
          setBeforeUpstreamCaptureForTest(async () => {
            state.captured = true;
            state.timedOut = true;
            throw new core.ReadPreparationUnavailableError(
              "knowledge",
              "timeout",
            );
          });
          restore.push(() => clock.mockRestore());
          _setModelDataForTest(
            { "claude-test": { id: "claude-test" } },
            {
              "anthropic/claude-test": {
                id: "claude-test",
                limit: { context: 1_000_000, output: 8_192 },
              },
            },
          );
        },
      );
      expect(state.captured).toBe(true);
      expect(response.status).toBe(400);
      expect((await response.json()) as unknown).toMatchObject({
        error: {
          type: "invalid_request_error",
          message: "Unsupported cross-provider request",
        },
      });
    } finally {
      setBeforeUpstreamCaptureForTest(undefined);
      for (const restoreStub of restore) restoreStub();
      clearModelDataCache();
    }
  });

  it.each([
    { streamed: false, omitType: false, emptyPart: false },
    { streamed: true, omitType: false, emptyPart: false },
    { streamed: false, omitType: true, emptyPart: false },
    { streamed: true, omitType: true, emptyPart: false },
    { streamed: false, omitType: true, emptyPart: true },
    { streamed: true, omitType: true, emptyPart: true },
  ])(
    "keeps a marker-cleaned native Responses envelope in timeout fallback (streamed=$streamed, omitType=$omitType, emptyPart=$emptyPart)",
    async ({ streamed, omitType, emptyPart }) => {
      const history = Array.from({ length: 2048 }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `turn ${index}`,
      }));
      const nativeUser = {
        ...(omitType ? {} : { type: "message" }),
        role: "user",
        id: "msg_fallback_native",
        status: "completed",
        content: [
          { type: "input_text", text: emptyPart ? "" : "first part" },
          {
            type: "input_text",
            text: "second part\n[lore:session-id=12345678]",
          },
        ],
      };
      const state = { captured: false, timedOut: false };
      const restore: Array<() => void> = [];
      try {
        const { upstream } = await forward(
          "/v1/responses",
          "openai",
          {
            model: "gpt-test",
            ...(streamed
              ? { padding: "x".repeat(STREAMING_PARSE_SPOOL_BYTES + 1) }
              : {}),
            input: [...history, nativeUser],
          },
          true,
          () => {
            const originalNow = Date.now();
            const clock = vi
              .spyOn(Date, "now")
              .mockImplementation(
                () => originalNow + (state.timedOut ? 120_000 : 0),
              );
            setBeforeUpstreamCaptureForTest(async () => {
              state.captured = true;
              state.timedOut = true;
              throw new core.ReadPreparationUnavailableError(
                "knowledge",
                "timeout",
              );
            });
            restore.push(() => clock.mockRestore());
            _setModelDataForTest(
              { "gpt-test": { id: "gpt-test" } },
              {
                "openai/gpt-test": {
                  id: "gpt-test",
                  limit: { context: 1_000_000, output: 8_192 },
                },
              },
            );
          },
        );
        expect(state.captured).toBe(true);
        expect(upstream.input).toContainEqual({
          ...nativeUser,
          content: [
            nativeUser.content[0],
            { type: "input_text", text: "second part" },
          ],
        });
        expect(JSON.stringify(upstream.input)).not.toContain("lore:session-id");
      } finally {
        setBeforeUpstreamCaptureForTest(undefined);
        for (const restoreStub of restore) restoreStub();
        clearModelDataCache();
      }
    },
  );

  it.each([false, true])(
    "keeps a type-omitted native Responses user item in timeout fallback (streamed=%s)",
    async (streamed) => {
      const history = Array.from({ length: 2048 }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `turn ${index}`,
      }));
      const nativeUser = {
        role: "user",
        id: "msg_shorthand_fallback",
        status: "completed",
        content: [
          { type: "input_text", text: "first part" },
          { type: "input_text", text: "second part" },
        ],
      };
      const state = { timedOut: false, captured: false };
      const restore: Array<() => void> = [];
      try {
        const { upstream } = await forward(
          "/v1/responses",
          "openai",
          {
            model: "gpt-test",
            input: [...history, nativeUser],
            ...(streamed
              ? { padding: "x".repeat(STREAMING_PARSE_SPOOL_BYTES + 1) }
              : {}),
          },
          true,
          () => {
            const originalNow = Date.now();
            const clock = vi
              .spyOn(Date, "now")
              .mockImplementation(
                () => originalNow + (state.timedOut ? 120_000 : 0),
              );
            restore.push(() => clock.mockRestore());
            setBeforeUpstreamCaptureForTest(async () => {
              state.captured = true;
              state.timedOut = true;
              throw new core.ReadPreparationUnavailableError(
                "knowledge",
                "timeout",
              );
            });
            _setModelDataForTest(
              { "gpt-test": { id: "gpt-test" } },
              {
                "openai/gpt-test": {
                  id: "gpt-test",
                  limit: { context: 1_000_000, output: 8_192 },
                },
              },
            );
          },
        );
        expect(state.captured).toBe(true);
        expect(upstream.input).toContainEqual(nativeUser);
      } finally {
        setBeforeUpstreamCaptureForTest(undefined);
        for (const restoreStub of restore) restoreStub();
        clearModelDataCache();
      }
    },
  );

  it.each([false, true])(
    "rejects late Responses instructions before an amnesia slash command (streamed=%s)",
    async (streamed) => {
      const sessionID = `late-responses-slash-${streamed}`;
      const { response } = await forward(
        "/v1/responses",
        "openai",
        {
          model: "gpt-test",
          input: [
            { role: "user", content: "earlier turn" },
            { role: "developer", content: "late instruction" },
            { role: "user", content: "/lore:amnesia:off" },
          ],
          ...(streamed
            ? { padding: "x".repeat(STREAMING_PARSE_SPOOL_BYTES + 1) }
            : {}),
        },
        false,
        async () => {
          const headers = {
            "content-type": "application/json",
            authorization: "Bearer test-key",
            "x-lore-provider": "openai",
            "x-lore-project": projectPath!,
            "x-lore-agent": "coder",
            "x-lore-session-id": sessionID,
          };
          const accepted = await harness!.request("/v1/responses", {
            method: "POST",
            headers,
            body: JSON.stringify({
              model: "gpt-test",
              input: [{ role: "user", content: "start" }],
            }),
          });
          expect(accepted.status, await accepted.text()).toBe(200);
          const on = await harness!.request("/v1/responses", {
            method: "POST",
            headers,
            body: JSON.stringify({
              model: "gpt-test",
              input: [{ role: "user", content: "/lore:amnesia:on" }],
            }),
          });
          expect(on.status, await on.text()).toBe(200);
          const session = [...getActiveSessions().values()].find(
            (candidate) => candidate.headerSessionId === sessionID,
          );
          expect(session?.amnesia).toBe(true);
        },
        { upstreamCalls: 2, headers: { "x-lore-session-id": sessionID } },
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: {
          type: "invalid_request_error",
          message: "Unsupported cross-provider request",
        },
      });
      const session = [...getActiveSessions().values()].find(
        (candidate) => candidate.headerSessionId === sessionID,
      );
      expect(session?.amnesia).toBe(true);
    },
  );

  it("rejects Anthropic encrypted reasoning on a Responses destination before dispatch", async () => {
    const { response } = await forward(
      "/v1/messages",
      "openai",
      {
        model: "gpt-test",
        messages: [
          {
            role: "assistant",
            content: [
              { type: "redacted_thinking", data: "encrypted-sentinel" },
              { type: "text", text: "previous answer" },
            ],
          },
          { role: "user", content: "continue" },
        ],
      },
      false,
    );
    expect(response.status).toBe(400);
    expect((await response.json()) as unknown).toMatchObject({
      error: {
        type: "invalid_request_error",
        message: "Unsupported cross-provider request",
      },
    });
  });

  it("rejects Chat JSON-schema output when building a Gemini-native request", () => {
    const request = parseOpenAIRequest(
      {
        model: "gemini-test",
        messages: [{ role: "user", content: "extract a name" }],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "person",
            schema: {
              type: "object",
              properties: { name: { type: "string" } },
            },
          },
        },
      },
      { authorization: "Bearer test-key" },
    );
    expect(() =>
      buildGeminiUpstreamRequest(
        request,
        "https://generativelanguage.googleapis.com",
      ),
    ).toThrow(InvalidCrossProviderRequestError);
  });

  it.each([
    ["chat", 8],
    ["chat", STREAMING_PARSE_SPOOL_BYTES + 1],
    ["responses", 8],
    ["responses", STREAMING_PARSE_SPOOL_BYTES + 1],
  ] as const)(
    "returns the fixed unsupported-request error for %s ingress with %i user bytes",
    async (ingress, size) => {
      const developerContent =
        ingress === "chat"
          ? [{ type: "image_url", image_url: { url: dataURL } }]
          : [{ type: "input_image", image_url: dataURL }];
      const body =
        ingress === "chat"
          ? {
              model: "gpt-test",
              messages: [
                { role: "developer", content: developerContent },
                { role: "user", content: "x".repeat(size) },
              ],
            }
          : {
              model: "gpt-test",
              input: [
                {
                  type: "message",
                  role: "developer",
                  content: developerContent,
                },
                { type: "message", role: "user", content: "x".repeat(size) },
              ],
            };
      const { response } = await forward(
        ingress === "chat" ? "/v1/chat/completions" : "/v1/responses",
        ingress === "chat" ? "openrouter" : "openai",
        body,
        false,
      );
      expect(response.status).toBe(400);
      expect((await response.json()) as unknown).toMatchObject({
        error: {
          type: "invalid_request_error",
          message: "Unsupported cross-provider request",
        },
      });
    },
  );

  it("rejects an unrepresentable Responses assistant item on Anthropic before dispatch", async () => {
    const { response } = await forward(
      "/v1/responses",
      "anthropic",
      {
        model: "claude-test",
        input: [
          {
            type: "message",
            role: "assistant",
            content: [
              { type: "future_content", private_payload: "must-not-forward" },
            ],
          },
          { type: "message", role: "user", content: "continue" },
        ],
      },
      false,
    );
    expect(response.status).toBe(400);
  });

  it("preserves separate native Chat system and developer roles in order", async () => {
    const { upstream } = await forward("/v1/chat/completions", "openrouter", {
      model: "gpt-test",
      messages: [
        { role: "system", content: "system rule" },
        { role: "developer", content: "developer rule" },
        { role: "user", content: "question" },
      ],
    });
    const messages = upstream.messages as Array<{
      role: string;
      content: string | Array<{ text: string }>;
    }>;
    const text = (message: (typeof messages)[number]) =>
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => part.text).join("");
    expect(messages[0].role).toBe("system");
    expect(text(messages[0])).toBe("system rule");
    const developerIndex = messages.findIndex(
      (message) => message.role === "developer",
    );
    expect(developerIndex).toBeGreaterThan(0);
    expect(
      messages
        .slice(0, developerIndex)
        .every((message) => message.role === "system"),
    ).toBe(true);
    expect(text(messages[developerIndex])).toBe("developer rule");
    expect(
      messages
        .filter((message) => message.role === "system")
        .map(text)
        .join("\n"),
    ).not.toContain("developer rule");
    expect(messages[messages.length - 1].role).toBe("user");
    expect(text(messages[messages.length - 1])).toBe("question");
  });

  it("preserves a native Chat system cache breakpoint on OpenRouter", async () => {
    const control = { type: "ephemeral", ttl: "1h" };
    const { upstream } = await forward("/v1/chat/completions", "openrouter", {
      model: "gpt-test",
      messages: [
        {
          role: "system",
          content: [
            { type: "text", text: "system rule", cache_control: control },
          ],
        },
        { role: "user", content: "question" },
      ],
    });
    expect(upstream.messages).toContainEqual({
      role: "system",
      content: [{ type: "text", text: "system rule", cache_control: control }],
    });
  });

  it("rejects a native Chat cache breakpoint on an incompatible route", async () => {
    const { response } = await forward(
      "/v1/chat/completions",
      "anthropic",
      {
        model: "claude-test",
        messages: [
          {
            role: "system",
            content: [
              {
                type: "text",
                text: "system rule",
                cache_control: { type: "ephemeral", ttl: "1h" },
              },
            ],
          },
          { role: "user", content: "question" },
        ],
      },
      false,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        type: "invalid_request_error",
        message: "Unsupported cross-provider request",
      },
    });
  });

  it("rejects a late native Chat developer instruction rather than moving it ahead of the user", async () => {
    const { response } = await forward(
      "/v1/chat/completions",
      "openrouter",
      {
        model: "gpt-test",
        messages: [
          { role: "user", content: "earlier question" },
          { role: "developer", content: "late developer rule" },
          { role: "user", content: "later question" },
        ],
      },
      false,
    );
    expect(response.status).toBe(400);
  });

  it("normalizes a foreign image block even on a native Anthropic route", async () => {
    const { upstream } = await forward("/v1/messages", "anthropic", {
      model: "claude-test",
      messages: [
        {
          role: "user",
          content: [{ type: "input_image", image_url: dataURL }],
        },
      ],
    });
    expect(upstream.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: [
            expect.objectContaining({
              type: "image",
              source: { type: "base64", media_type: "image/png", data: png },
            }),
          ],
        }),
      ]),
    );
  });

  it.each(["A", "AA=", "AB=="])(
    "rejects malformed image base64 %s before upstream dispatch",
    async (encoded) => {
      const { response } = await forward(
        "/v1/chat/completions",
        "anthropic",
        {
          model: "claude-test",
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image_url",
                  image_url: { url: `data:image/png;base64,${encoded}` },
                },
              ],
            },
          ],
        },
        false,
      );
      expect(response.status).toBe(400);
    },
  );

  it("rejects image detail that Anthropic cannot represent", async () => {
    await forward(
      "/v1/chat/completions",
      "anthropic",
      {
        model: "claude-test",
        messages: [
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: dataURL, detail: "low" } },
            ],
          },
        ],
      },
      false,
    );
  });

  it("rejects a Chat JSON-schema constraint that Anthropic cannot represent", async () => {
    const { response } = await forward(
      "/v1/chat/completions",
      "anthropic",
      {
        model: "claude-test",
        messages: [{ role: "user", content: "extract a name" }],
        response_format: {
          type: "json_schema",
          json_schema: { name: "person", schema: { type: "object" } },
        },
      },
      false,
    );
    expect(response.status).toBe(400);
    expect((await response.json()) as unknown).toMatchObject({
      error: {
        type: "invalid_request_error",
        message: "Unsupported cross-provider request",
      },
    });
  });

  it("forwards an explicit plain-text Chat response format to Anthropic", async () => {
    const { upstream } = await forward("/v1/chat/completions", "anthropic", {
      model: "claude-test",
      messages: [{ role: "user", content: "answer in plain text" }],
      response_format: { type: "text" },
    });
    expect(upstream.messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "user" })]),
    );
  });

  it("rejects Chat format fields that Responses cannot preserve", async () => {
    await forward(
      "/v1/chat/completions",
      "openai",
      {
        model: "gpt-test",
        messages: [{ role: "user", content: "extract a name" }],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "person",
            schema: { type: "object" },
            unknown_control: true,
          },
        },
      },
      false,
    );
  });

  it("rejects a Responses JSON-schema constraint that Anthropic cannot represent", async () => {
    await forward(
      "/v1/responses",
      "anthropic",
      {
        model: "claude-test",
        input: [{ role: "user", content: "extract a name" }],
        text: {
          format: {
            type: "json_schema",
            name: "person",
            schema: { type: "object" },
          },
        },
      },
      false,
    );
  });

  it("rejects unknown Responses text controls before Anthropic forwarding", async () => {
    await forward(
      "/v1/responses",
      "anthropic",
      {
        model: "claude-test",
        input: [{ role: "user", content: "extract a name" }],
        text: { format: { type: "text", unknown_control: true } },
      },
      false,
    );
  });

  it.each(["openai", "openrouter"] as const)(
    "rejects failed Anthropic tool results before %s dispatch",
    async (provider) => {
      const { response } = await forward(
        "/v1/messages",
        provider,
        {
          model: "gpt-test",
          max_tokens: 64,
          messages: [
            {
              role: "assistant",
              content: [
                { type: "tool_use", id: "tool_call", name: "read", input: {} },
              ],
            },
            {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "tool_call",
                  is_error: true,
                  content: "permission denied",
                },
              ],
            },
          ],
        },
        false,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: {
          type: "invalid_request_error",
          message: "Unsupported cross-provider request",
        },
      });
    },
  );

  it("rejects an Anthropic document before Responses dispatch", async () => {
    const { response } = await forward(
      "/v1/messages",
      "openai",
      {
        model: "gpt-test",
        max_tokens: 64,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document",
                source: {
                  type: "base64",
                  media_type: "application/pdf",
                  data: "JVBERi0xLjQ=",
                },
              },
            ],
          },
        ],
      },
      false,
    );
    expect(response.status).toBe(400);
  });

  it("rejects an Anthropic document before Chat dispatch", async () => {
    const { response } = await forward(
      "/v1/messages",
      "openrouter",
      {
        model: "gpt-test",
        max_tokens: 64,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document",
                source: {
                  type: "base64",
                  media_type: "application/pdf",
                  data: "JVBERi0xLjQ=",
                },
              },
            ],
          },
        ],
      },
      false,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        type: "invalid_request_error",
        message: "Unsupported cross-provider request",
      },
    });
  });

  it("rejects a Chat file part before Responses dispatch", async () => {
    const { response } = await forward(
      "/v1/chat/completions",
      "openai",
      {
        model: "gpt-test",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "file",
                file: {
                  filename: "notes.txt",
                  file_data: "data:text/plain;base64,SGVsbG8=",
                },
              },
            ],
          },
        ],
      },
      false,
    );
    expect(response.status).toBe(400);
  });

  it("accepts completed Responses text with empty annotations on Anthropic", async () => {
    const { upstream } = await forward("/v1/responses", "anthropic", {
      model: "claude-test",
      input: [
        {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            { type: "output_text", text: "prior answer", annotations: [] },
          ],
        },
        { role: "user", content: "continue" },
      ],
    });
    expect(upstream.messages).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        content: expect.arrayContaining([
          expect.objectContaining({ type: "text", text: "prior answer" }),
        ]),
      }),
    );
    const request = parseOpenAIResponsesRequest(
      {
        model: "claude-test",
        input: [
          {
            type: "message",
            role: "assistant",
            status: "completed",
            content: [
              { type: "output_text", text: "prior answer", annotations: [] },
            ],
          },
        ],
      },
      { authorization: "Bearer test-key" },
    );
    const { body } = buildAnthropicRequest(request);
    expect((body as { messages: unknown[] }).messages).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        content: expect.arrayContaining([
          expect.objectContaining({ type: "text", text: "prior answer" }),
        ]),
      }),
    );
  });

  it("replays a native Responses tool output array with its image", async () => {
    const output = [
      { type: "output_text", text: "image follows" },
      { type: "input_image", image_url: dataURL },
    ];
    const input = [
      {
        type: "function_call",
        call_id: "call_image",
        name: "read",
        arguments: "{}",
      },
      { type: "function_call_output", call_id: "call_image", output },
      { role: "user", content: "describe the image" },
    ];
    const request = parseOpenAIResponsesRequest(
      { model: "gpt-test", input },
      { authorization: "Bearer test-key" },
    );
    expect(() =>
      buildOpenAIResponsesUpstreamRequest(request, "https://api.openai.com"),
    ).not.toThrow();
    const { upstream } = await forward("/v1/responses", "openai", {
      model: "gpt-test",
      input,
    });
    expect(upstream.input).toContainEqual({
      type: "function_call_output",
      call_id: "call_image",
      output,
    });
  });

  it.each([
    {
      part: {
        type: "image_url",
        image_url: { url: "https://example.test/a.png" },
      },
      streamed: false,
    },
    {
      part: {
        type: "image_url",
        image_url: { url: "https://example.test/a.png" },
      },
      streamed: true,
    },
    {
      part: {
        type: "input_image",
        image_url: { url: "https://example.test/a.png" },
      },
      streamed: false,
    },
    {
      part: {
        type: "input_image",
        image_url: { url: "https://example.test/a.png" },
      },
      streamed: true,
    },
  ])(
    "rejects an invalid image in a type-omitted native Responses assistant item ($part.type, streamed=$streamed)",
    async ({ part, streamed }) => {
      const { response } = await forward(
        "/v1/responses",
        "openai",
        {
          model: "gpt-test",
          input: [
            { role: "assistant", content: [part] },
            { role: "user", content: "continue" },
          ],
          ...(streamed
            ? { padding: "x".repeat(STREAMING_PARSE_SPOOL_BYTES + 1) }
            : {}),
        },
        false,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: {
          type: "invalid_request_error",
          message: "Unsupported cross-provider request",
        },
      });
    },
  );

  it.each([false, true])(
    "rejects a malformed native Responses assistant text part (streamed=%s)",
    async (streamed) => {
      const { response } = await forward(
        "/v1/responses",
        "openai",
        {
          model: "gpt-test",
          input: [
            {
              role: "assistant",
              content: [{ type: "output_text", text: { hidden: "value" } }],
            },
            { role: "user", content: "continue" },
          ],
          ...(streamed
            ? { padding: "x".repeat(STREAMING_PARSE_SPOOL_BYTES + 1) }
            : {}),
        },
        false,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: {
          type: "invalid_request_error",
          message: "Unsupported cross-provider request",
        },
      });
    },
  );

  it.each([
    { streamed: false, omitType: false },
    { streamed: true, omitType: false },
    { streamed: false, omitType: true },
    { streamed: true, omitType: true },
  ])(
    "rejects a valid native Responses image in assistant history (streamed=$streamed, omitType=$omitType)",
    async ({ streamed, omitType }) => {
      const { response } = await forward(
        "/v1/responses",
        "openai",
        {
          model: "gpt-test",
          input: [
            {
              ...(omitType ? {} : { type: "message" }),
              role: "assistant",
              content: [{ type: "input_image", image_url: dataURL }],
            },
            { role: "user", content: "continue" },
          ],
          ...(streamed
            ? { padding: "x".repeat(STREAMING_PARSE_SPOOL_BYTES + 1) }
            : {}),
        },
        false,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: {
          type: "invalid_request_error",
          message: "Unsupported cross-provider request",
        },
      });
    },
  );

  it.each([false, true])(
    "rejects an all-empty native Responses user item rather than dropping it (streamed=%s)",
    async (streamed) => {
      const { response } = await forward(
        "/v1/responses",
        "openai",
        {
          model: "gpt-test",
          input: [
            {
              role: "user",
              content: [{ type: "input_text", text: "" }],
            },
            { role: "user", content: "continue" },
          ],
          ...(streamed
            ? { padding: "x".repeat(STREAMING_PARSE_SPOOL_BYTES + 1) }
            : {}),
        },
        false,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: {
          type: "invalid_request_error",
          message: "Unsupported cross-provider request",
        },
      });
    },
  );

  it("forwards a text-only Responses tool output array as an Anthropic tool result", async () => {
    const input = [
      {
        type: "function_call",
        call_id: "call_text",
        name: "read",
        arguments: "{}",
      },
      {
        type: "function_call_output",
        call_id: "call_text",
        output: [{ type: "output_text", text: "read result" }],
      },
      { role: "user", content: "continue" },
    ];
    const parsed = parseOpenAIResponsesRequest(
      { model: "claude-test", input },
      { authorization: "Bearer test-key" },
    );
    expect(
      (buildAnthropicRequest(parsed).body as { messages: unknown[] }).messages,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: expect.arrayContaining([
            expect.objectContaining({
              type: "tool_result",
              tool_use_id: "call_text",
              content: [{ type: "text", text: "read result" }],
            }),
          ]),
        }),
      ]),
    );
    const { upstream } = await forward("/v1/responses", "anthropic", {
      model: "claude-test",
      input,
    });
    expect(upstream.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: expect.arrayContaining([
            expect.objectContaining({
              type: "tool_result",
              tool_use_id: "call_text",
              content: [{ type: "text", text: "read result" }],
            }),
          ]),
        }),
      ]),
    );
  });

  it("forwards a Responses tool output with empty annotations to Anthropic", async () => {
    const { upstream } = await forward("/v1/responses", "anthropic", {
      model: "claude-test",
      input: [
        {
          type: "function_call",
          call_id: "call_empty",
          name: "read",
          arguments: "{}",
        },
        {
          type: "function_call_output",
          call_id: "call_empty",
          output: [
            { type: "output_text", text: "read result", annotations: [] },
          ],
        },
        { role: "user", content: "continue" },
      ],
    });
    expect(upstream.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: expect.arrayContaining([
            expect.objectContaining({
              type: "tool_result",
              tool_use_id: "call_empty",
              content: [{ type: "text", text: "read result" }],
            }),
          ]),
        }),
      ]),
    );
  });

  it("forwards a completed Responses tool output with standard metadata to Anthropic", async () => {
    const { upstream } = await forward("/v1/responses", "anthropic", {
      model: "claude-test",
      input: [
        {
          type: "function_call",
          call_id: "call_done",
          name: "read",
          arguments: "{}",
        },
        {
          type: "function_call_output",
          id: "fc_output_done",
          status: "completed",
          call_id: "call_done",
          output: [
            { type: "output_text", text: "read result", annotations: [] },
          ],
        },
        { role: "user", content: "continue" },
      ],
    });
    expect(upstream.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: expect.arrayContaining([
            expect.objectContaining({
              type: "tool_result",
              tool_use_id: "call_done",
              content: [{ type: "text", text: "read result" }],
            }),
          ]),
        }),
      ]),
    );
  });

  it("rejects an incomplete Responses tool output before Anthropic dispatch", async () => {
    const { response } = await forward(
      "/v1/responses",
      "anthropic",
      {
        model: "claude-test",
        input: [
          {
            type: "function_call",
            call_id: "call_pending",
            name: "read",
            arguments: "{}",
          },
          {
            type: "function_call_output",
            id: "fc_output_pending",
            status: "incomplete",
            call_id: "call_pending",
            output: [{ type: "output_text", text: "partial" }],
          },
          { role: "user", content: "continue" },
        ],
      },
      false,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        type: "invalid_request_error",
        message: "Unsupported cross-provider request",
      },
    });
  });

  it("forwards a completed string Responses tool output to Anthropic", async () => {
    const { upstream } = await forward("/v1/responses", "anthropic", {
      model: "claude-test",
      input: [
        {
          type: "function_call",
          call_id: "call_string",
          name: "read",
          arguments: "{}",
        },
        {
          type: "function_call_output",
          id: "fc_output_string",
          status: "completed",
          call_id: "call_string",
          output: "read result",
        },
        { role: "user", content: "continue" },
      ],
    });
    expect(upstream.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: expect.arrayContaining([
            expect.objectContaining({
              type: "tool_result",
              tool_use_id: "call_string",
              content: [{ type: "text", text: "read result" }],
            }),
          ]),
        }),
      ]),
    );
  });

  it("replays a completed string Responses tool output with its metadata natively", async () => {
    const output = {
      type: "function_call_output",
      id: "fc_output_native",
      status: "completed",
      call_id: "call_native",
      output: "read result",
    };
    const { upstream } = await forward("/v1/responses", "openai", {
      model: "gpt-test",
      input: [
        {
          type: "function_call",
          call_id: "call_native",
          name: "read",
          arguments: "{}",
        },
        output,
        { role: "user", content: "continue" },
      ],
    });
    expect(upstream.input).toEqual(expect.arrayContaining([output]));
  });

  it("rejects an incomplete string Responses tool output in a streamed body", async () => {
    const { response } = await forward(
      "/v1/responses",
      "anthropic",
      {
        model: "claude-test",
        metadata: { padding: "x".repeat(262145) },
        input: [
          {
            type: "function_call",
            call_id: "call_large",
            name: "read",
            arguments: "{}",
          },
          {
            type: "function_call_output",
            status: "incomplete",
            call_id: "call_large",
            output: "partial",
          },
          { role: "user", content: "continue" },
        ],
      },
      false,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        type: "invalid_request_error",
        message: "Unsupported cross-provider request",
      },
    });
  });

  it.each([
    { status: "incomplete" },
    { provider_metadata: { source: "private-reference" } },
  ])(
    "rejects a string Responses tool output with unsupported envelope %#",
    async (extra) => {
      const { response } = await forward(
        "/v1/responses",
        "anthropic",
        {
          model: "claude-test",
          input: [
            {
              type: "function_call",
              call_id: "call_bad_string",
              name: "read",
              arguments: "{}",
            },
            {
              type: "function_call_output",
              call_id: "call_bad_string",
              output: "partial",
              ...extra,
            },
            { role: "user", content: "continue" },
          ],
        },
        false,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: {
          type: "invalid_request_error",
          message: "Unsupported cross-provider request",
        },
      });
    },
  );

  it("rejects a cited Anthropic tool-result text before Responses dispatch", async () => {
    const cited = {
      type: "text",
      text: "source answer",
      citations: [
        {
          type: "web_search_result_location",
          cited_text: "source",
          url: "https://example.test/source",
          title: "source",
        },
      ],
    };
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_cited", name: "read", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_cited", content: [cited] },
        ],
      },
      { role: "user", content: "continue" },
    ];
    const { response } = await forward(
      "/v1/messages",
      "openai",
      { model: "gpt-test", max_tokens: 128, messages },
      false,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        type: "invalid_request_error",
        message: "Unsupported cross-provider request",
      },
    });
  });

  it("retains Anthropic tool-result text citations on the native route", async () => {
    const cited = {
      type: "text",
      text: "source answer",
      citations: [
        {
          type: "web_search_result_location",
          cited_text: "source",
          url: "https://example.test/source",
          title: "source",
        },
      ],
    };
    const { upstream } = await forward("/v1/messages", "anthropic", {
      model: "claude-test",
      max_tokens: 128,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "call_cited", name: "read", input: {} },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_cited",
              content: [cited],
            },
          ],
        },
        { role: "user", content: "continue" },
      ],
    });
    expect(upstream.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: expect.arrayContaining([
            expect.objectContaining({
              type: "tool_result",
              tool_use_id: "call_cited",
              content: [cited],
            }),
          ]),
        }),
      ]),
    );
  });

  it("rejects an unrepresentable Responses item before Anthropic dispatch", async () => {
    const { response } = await forward(
      "/v1/responses",
      "anthropic",
      {
        model: "claude-test",
        input: [
          {
            type: "web_search_call",
            id: "search_1",
            status: "completed",
            query: "private source",
          },
          { role: "user", content: "continue" },
        ],
      },
      false,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        type: "invalid_request_error",
        message: "Unsupported cross-provider request",
      },
    });
  });

  it.each([
    { status: "incomplete" },
    { provider_metadata: { source: "private-reference" } },
  ])("rejects an unrepresentable Responses function call %#", async (extra) => {
    const { response } = await forward(
      "/v1/responses",
      "anthropic",
      {
        model: "claude-test",
        input: [
          {
            type: "function_call",
            call_id: "call_state",
            name: "read",
            arguments: "{}",
            ...extra,
          },
          {
            type: "function_call_output",
            call_id: "call_state",
            output: "result",
          },
          { role: "user", content: "continue" },
        ],
      },
      false,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        type: "invalid_request_error",
        message: "Unsupported cross-provider request",
      },
    });
  });

  it("forwards a completed Responses function call with its result to Anthropic", async () => {
    const { upstream } = await forward("/v1/responses", "anthropic", {
      model: "claude-test",
      input: [
        {
          type: "function_call",
          id: "fc_1",
          status: "completed",
          call_id: "call_state",
          name: "read",
          arguments: "{}",
        },
        {
          type: "function_call_output",
          call_id: "call_state",
          output: "result",
        },
        { role: "user", content: "continue" },
      ],
    });
    expect(upstream.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: expect.arrayContaining([
            expect.objectContaining({
              type: "tool_use",
              id: "call_state",
              name: "read",
            }),
          ]),
        }),
        expect.objectContaining({
          role: "user",
          content: expect.arrayContaining([
            expect.objectContaining({
              type: "tool_result",
              tool_use_id: "call_state",
            }),
          ]),
        }),
      ]),
    );
  });

  it("replays a Responses function call with its native envelope", async () => {
    const call = {
      type: "function_call",
      id: "fc_native",
      status: "completed",
      call_id: "call_native_state",
      name: "read",
      arguments: "{}",
    };
    const { upstream } = await forward("/v1/responses", "openai", {
      model: "gpt-test",
      input: [
        call,
        {
          type: "function_call_output",
          call_id: "call_native_state",
          output: "result",
        },
        { role: "user", content: "continue" },
      ],
    });
    expect(upstream.input).toEqual(expect.arrayContaining([call]));
  });

  it.each([
    { status: "incomplete" },
    { provider_metadata: { source: "private-reference" } },
    { role: "moderator" },
  ])("rejects an unrepresentable Responses user message %#", async (extra) => {
    const { response } = await forward(
      "/v1/responses",
      "anthropic",
      {
        model: "claude-test",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hello" }],
            ...extra,
          },
          { role: "user", content: "continue" },
        ],
      },
      false,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        type: "invalid_request_error",
        message: "Unsupported cross-provider request",
      },
    });
  });

  it("forwards a completed Responses user message to Anthropic", async () => {
    const { upstream } = await forward("/v1/responses", "anthropic", {
      model: "claude-test",
      input: [
        {
          type: "message",
          role: "user",
          status: "completed",
          content: [{ type: "input_text", text: "hello" }],
        },
      ],
    });
    expect(upstream.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: expect.arrayContaining([
            expect.objectContaining({ type: "text", text: "hello" }),
          ]),
        }),
      ]),
    );
  });

  it.each([
    {
      type: "output_text",
      text: "claim",
      annotations: [{ type: "url_citation", url: "https://example.test/a" }],
    },
    {
      type: "text",
      text: "claim",
      provider_metadata: { source: "private-reference" },
    },
  ])(
    "rejects an annotated Responses user text part on Anthropic %#",
    async (part) => {
      const { response } = await forward(
        "/v1/responses",
        "anthropic",
        {
          model: "claude-test",
          input: [
            { type: "message", role: "user", content: [part] },
            { role: "user", content: "continue" },
          ],
        },
        false,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: {
          type: "invalid_request_error",
          message: "Unsupported cross-provider request",
        },
      });
    },
  );

  it("replays annotated Responses user text on its native route", async () => {
    const part = {
      type: "output_text",
      text: "claim",
      annotations: [{ type: "url_citation", url: "https://example.test/a" }],
    };
    const { upstream } = await forward("/v1/responses", "openai", {
      model: "gpt-test",
      input: [
        { type: "message", role: "user", content: [part] },
        { role: "user", content: "continue" },
      ],
    });
    expect(upstream.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "message",
          role: "user",
          content: expect.arrayContaining([part]),
        }),
      ]),
    );
  });

  it("replays a native Responses user item's completed envelope", async () => {
    const item = {
      type: "message",
      role: "user",
      id: "msg_client_user",
      status: "completed",
      content: [{ type: "input_text", text: "retain my envelope" }],
    };
    const { upstream } = await forward("/v1/responses", "openai", {
      model: "gpt-test",
      input: [item, { role: "user", content: "continue" }],
    });
    expect(upstream.input).toEqual(expect.arrayContaining([item]));
  });

  it.each([false, true])(
    "keeps adjacent native Responses user envelopes separate (streamed=%s)",
    async (streamed) => {
      const input = [
        {
          type: "message",
          role: "user",
          status: "completed",
          content: [{ type: "input_text", text: "first" }],
        },
        {
          type: "message",
          role: "user",
          status: "completed",
          content: [{ type: "input_text", text: "second" }],
        },
      ];
      const { upstream } = await forward("/v1/responses", "openai", {
        model: "gpt-test",
        ...(streamed ? { metadata: { padding: "x".repeat(262145) } } : {}),
        input,
      });
      expect(upstream.input).toEqual(input);
    },
  );

  it.each([false, true])(
    "keeps adjacent native Responses user items without IDs separate (streamed=%s)",
    async (streamed) => {
      const input = [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "first" }],
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "second" }],
        },
      ];
      const { upstream } = await forward("/v1/responses", "openai", {
        model: "gpt-test",
        ...(streamed ? { metadata: { padding: "x".repeat(262145) } } : {}),
        input,
      });
      expect(upstream.input).toEqual(input);
    },
  );

  it.each([false, true])(
    "rejects reasoning stranded between a native call and its output (streamed=%s)",
    async (streamed) => {
      const { response } = await forward(
        "/v1/responses",
        "openai",
        {
          model: "gpt-test",
          ...(streamed ? { metadata: { padding: "x".repeat(262145) } } : {}),
          input: [
            {
              type: "function_call",
              call_id: "call_1",
              name: "lookup",
              arguments: "{}",
            },
            {
              type: "reasoning",
              id: "rs_1",
              summary: [],
              encrypted_content: "private-reasoning",
            },
            { type: "function_call_output", call_id: "call_1", output: "ok" },
            { type: "message", role: "user", content: "continue" },
          ],
        },
        false,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: {
          type: "invalid_request_error",
          message: "Unsupported cross-provider request",
        },
      });
    },
  );

  it.each([false, true])(
    "rejects reasoning stranded before a native user item (streamed=%s)",
    async (streamed) => {
      const { response } = await forward(
        "/v1/responses",
        "openai",
        {
          model: "gpt-test",
          ...(streamed ? { metadata: { padding: "x".repeat(262145) } } : {}),
          input: [
            { type: "reasoning", id: "rs_1", summary: [] },
            { type: "message", role: "user", content: "continue" },
          ],
        },
        false,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: {
          type: "invalid_request_error",
          message: "Unsupported cross-provider request",
        },
      });
    },
  );

  it.each([
    { streamed: false, omitType: false },
    { streamed: true, omitType: false },
    { streamed: false, omitType: true },
    { streamed: true, omitType: true },
  ])(
    "rejects a native assistant warning that would discard an incomplete cited item (streamed=$streamed, omitType=$omitType)",
    async ({ streamed, omitType }) => {
      const { response } = await forward(
        "/v1/responses",
        "openai",
        {
          model: "gpt-test",
          ...(streamed ? { metadata: { padding: "x".repeat(262145) } } : {}),
          input: [
            {
              ...(omitType ? {} : { type: "message" }),
              role: "assistant",
              status: "incomplete",
              content: [
                { type: "output_text", text: "[lore:context-warning] old" },
                {
                  type: "output_text",
                  text: "cited claim",
                  annotations: [
                    { type: "url_citation", url: "https://example.test/a" },
                  ],
                },
              ],
            },
            { role: "user", content: "continue" },
          ],
        },
        false,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: {
          type: "invalid_request_error",
          message: "Unsupported cross-provider request",
        },
      });
    },
  );

  it.each([false, true])(
    "rejects a warning-stripped type-omitted assistant image before native replay (streamed=%s)",
    async (streamed) => {
      const { response } = await forward(
        "/v1/responses",
        "openai",
        {
          model: "gpt-test",
          ...(streamed ? { metadata: { padding: "x".repeat(262145) } } : {}),
          input: [
            {
              role: "assistant",
              content: [
                { type: "output_text", text: "[lore:context-warning] old" },
                { type: "input_image", image_url: dataURL },
              ],
            },
            { role: "user", content: "continue" },
          ],
        },
        false,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: {
          type: "invalid_request_error",
          message: "Unsupported cross-provider request",
        },
      });
    },
  );

  it("rejects annotated text in a completed Responses user envelope on Anthropic", async () => {
    const { response } = await forward(
      "/v1/responses",
      "anthropic",
      {
        model: "claude-test",
        input: [
          {
            type: "message",
            role: "user",
            id: "msg_annotated",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: "claim",
                annotations: [
                  { type: "url_citation", url: "https://example.test/a" },
                ],
              },
            ],
          },
          { role: "user", content: "continue" },
        ],
      },
      false,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        type: "invalid_request_error",
        message: "Unsupported cross-provider request",
      },
    });
  });

  it("replays native Responses user provenance with an empty cited part", async () => {
    const { upstream } = await forward("/v1/responses", "openai", {
      model: "gpt-test",
      input: [
        {
          type: "message",
          role: "user",
          id: "msg_empty_citation",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: "",
              annotations: [
                { type: "url_citation", url: "https://example.test/a" },
              ],
            },
            { type: "input_text", text: "continue" },
          ],
        },
      ],
    });
    expect(upstream.input).toEqual([
      {
        type: "message",
        role: "user",
        id: "msg_empty_citation",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: "",
            annotations: [
              { type: "url_citation", url: "https://example.test/a" },
            ],
          },
          { type: "input_text", text: "continue" },
        ],
      },
    ]);
  });

  it("rejects object-valued Responses image URLs on Anthropic before dispatch", async () => {
    const { response } = await forward(
      "/v1/responses",
      "anthropic",
      {
        model: "claude-test",
        input: [
          {
            role: "user",
            content: [{ type: "input_image", image_url: { url: dataURL } }],
          },
        ],
      },
      false,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        type: "invalid_request_error",
        message: "Unsupported cross-provider request",
      },
    });
  });

  it.each(["openai", "anthropic"] as const)(
    "rejects malformed Responses user content before %s dispatch",
    async (provider) => {
      const { response } = await forward(
        "/v1/responses",
        provider,
        {
          model: provider === "openai" ? "gpt-test" : "claude-test",
          input: [
            {
              type: "message",
              role: "user",
              content: { type: "input_text", text: "secret" },
            },
            { role: "user", content: "continue" },
          ],
        },
        false,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: {
          type: "invalid_request_error",
          message: "Unsupported cross-provider request",
        },
      });
    },
  );

  it("rejects a native Responses user envelope whose empty content would disappear", async () => {
    const { response } = await forward(
      "/v1/responses",
      "openai",
      {
        model: "gpt-test",
        input: [
          {
            type: "message",
            role: "user",
            id: "msg_empty",
            status: "completed",
            content: [],
          },
          { role: "user", content: "continue" },
        ],
      },
      false,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        type: "invalid_request_error",
        message: "Unsupported cross-provider request",
      },
    });
  });

  it.each([false, true])(
    "rejects a malformed native Responses user image before dispatch (streamed=%s)",
    async (streamed) => {
      const { response } = await forward(
        "/v1/responses",
        "openai",
        {
          model: "gpt-test",
          ...(streamed ? { metadata: { padding: "x".repeat(262145) } } : {}),
          input: [
            {
              role: "user",
              content: [{ type: "input_image", image_url: { url: dataURL } }],
            },
          ],
        },
        false,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: {
          type: "invalid_request_error",
          message: "Unsupported cross-provider request",
        },
      });
    },
  );

  it("replays valid native Responses user image URLs and file IDs unchanged", async () => {
    const parts = [
      { type: "input_image", image_url: dataURL, detail: "high" },
      { type: "input_image", file_id: "file_native_image", detail: "low" },
    ];
    const { upstream } = await forward("/v1/responses", "openai", {
      model: "gpt-test",
      input: [{ role: "user", content: parts }],
    });
    expect(upstream.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: expect.arrayContaining(parts),
        }),
      ]),
    );
  });

  it.each(["user", "assistant"])(
    "preserves native Chat %s text metadata and rejects it on Anthropic",
    async (role) => {
      const part = {
        type: "text",
        text: "visible",
        cache_control: { type: "ephemeral" },
      };
      const messages = [
        { role, content: [part] },
        { role: "user", content: "continue" },
      ];
      const { upstream } = await forward("/v1/chat/completions", "openrouter", {
        model: "gpt-test",
        messages,
      });
      expect(upstream.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role,
            content: expect.arrayContaining([part]),
          }),
        ]),
      );
    },
  );

  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ] as const)(
    "preserves the final native Chat cache TTL (streamed=%s, meta=%s)",
    async (streamed, meta) => {
      const part = {
        type: "text",
        text: "visible",
        cache_control: { type: "ephemeral", ttl: "1h" },
      };
      const { upstream } = await forward(
        "/v1/chat/completions",
        "openrouter",
        {
          model: "gpt-test",
          ...(streamed
            ? { padding: "x".repeat(STREAMING_PARSE_SPOOL_BYTES + 1) }
            : {}),
          messages: [{ role: "user", content: [part] }],
        },
        true,
        undefined,
        meta ? { headers: { "x-lore-agent": "summary" } } : undefined,
      );
      expect(upstream.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: "user", content: [part] }),
        ]),
      );
    },
  );

  it("replays native Chat text metadata across an accepted layer transition", async () => {
    const sessionID = "cross-provider-chat-text-layer";
    const part = {
      type: "text",
      text: "visible",
      cache_control: { type: "ephemeral" },
    };
    const { upstream } = await forward(
      "/v1/chat/completions",
      "openrouter",
      {
        model: "gpt-test",
        messages: [
          { role: "user", content: [part] },
          { role: "user", content: "continue" },
        ],
      },
      true,
      async () => {
        const accepted = await harness!.request("/v1/chat/completions", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer test-key",
            "x-lore-provider": "openrouter",
            "x-lore-project": projectPath!,
            "x-lore-agent": "coder",
            "x-lore-session-id": sessionID,
          },
          body: JSON.stringify({
            model: "gpt-test",
            messages: [{ role: "user", content: "start" }],
          }),
        });
        expect(accepted.status, await accepted.text()).toBe(200);
        const session = [...getActiveSessions().values()].find(
          (candidate) => candidate.headerSessionId === sessionID,
        );
        if (!session || session.storageTenantId === undefined)
          throw new Error("missing accepted session owner");
        core.withTenant(session.storageTenantId, () =>
          core.setForceMinLayer(1, session.sessionID),
        );
      },
      { upstreamCalls: 2, headers: { "x-lore-session-id": sessionID } },
    );
    expect(upstream.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: expect.arrayContaining([part]),
        }),
      ]),
    );
  });

  it.each(["user", "assistant"])(
    "rejects Chat %s text metadata before Anthropic dispatch",
    async (role) => {
      const { response } = await forward(
        "/v1/chat/completions",
        "anthropic",
        {
          model: "claude-test",
          messages: [
            {
              role,
              content: [
                {
                  type: "text",
                  text: "visible",
                  cache_control: { type: "ephemeral" },
                },
              ],
            },
            { role: "user", content: "continue" },
          ],
        },
        false,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: {
          type: "invalid_request_error",
          message: "Unsupported cross-provider request",
        },
      });
    },
  );

  it.each(["openai", "anthropic"] as const)(
    "rejects Chat tool-result text metadata before %s dispatch",
    async (provider) => {
      const { response } = await forward(
        "/v1/chat/completions",
        provider,
        {
          model: provider === "openai" ? "gpt-test" : "claude-test",
          messages: [
            {
              role: "assistant",
              tool_calls: [
                {
                  id: "call_metadata",
                  type: "function",
                  function: { name: "read", arguments: "{}" },
                },
              ],
            },
            {
              role: "tool",
              tool_call_id: "call_metadata",
              content: [
                {
                  type: "text",
                  text: "result",
                  cache_control: { type: "ephemeral" },
                },
              ],
            },
            { role: "user", content: "continue" },
          ],
        },
        false,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: {
          type: "invalid_request_error",
          message: "Unsupported cross-provider request",
        },
      });
    },
  );

  it.each(["claim", ""])(
    "replays native cited user text across an accepted layer transition (text=%j)",
    async (text) => {
      const sessionID = `cross-provider-cited-layer-${text.length}`;
      const part = {
        type: "output_text",
        text,
        annotations: [{ type: "url_citation", url: "https://example.test/a" }],
      };
      const { response, upstream } = await forward(
        "/v1/responses",
        "openai",
        {
          model: "gpt-test",
          input: [
            {
              type: "message",
              role: "user",
              content: [part, { type: "input_text", text: "continue" }],
            },
          ],
        },
        text.length > 0,
        async () => {
          const accepted = await harness!.request("/v1/responses", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: "Bearer test-key",
              "x-lore-provider": "openai",
              "x-lore-project": projectPath!,
              "x-lore-agent": "coder",
              "x-lore-session-id": sessionID,
            },
            body: JSON.stringify({
              model: "gpt-test",
              input: [{ role: "user", content: "start" }],
            }),
          });
          expect(accepted.status, await accepted.text()).toBe(200);
          const session = [...getActiveSessions().values()].find(
            (candidate) => candidate.headerSessionId === sessionID,
          );
          if (!session) throw new Error("missing accepted session");
          if (session.storageTenantId === undefined)
            throw new Error("missing accepted session owner");
          core.withTenant(session.storageTenantId, () =>
            core.setForceMinLayer(1, session.sessionID),
          );
        },
        { upstreamCalls: 2, headers: { "x-lore-session-id": sessionID } },
      );
      if (text.length === 0) {
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
          error: {
            type: "invalid_request_error",
            message: "Unsupported cross-provider request",
          },
        });
        return;
      }
      expect(upstream.input).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "message",
            role: "user",
            content: expect.arrayContaining([
              part,
              { type: "input_text", text: "continue" },
            ]),
          }),
        ]),
      );
    },
  );

  it.each([
    { text: "claim", shouldDispatch: true },
    { text: "", shouldDispatch: false },
  ])(
    "preserves shorthand native user citations across an accepted layer transition (text=%j)",
    async ({ text, shouldDispatch }) => {
      const sessionID = `cross-provider-shorthand-layer-${text.length}`;
      const nativeUser = {
        role: "user",
        id: "msg_shorthand_citation",
        status: "completed",
        content: [
          {
            type: "output_text",
            text,
            annotations: [
              { type: "url_citation", url: "https://example.test/a" },
            ],
          },
          { type: "input_text", text: "continue" },
        ],
      };
      const { response, upstream } = await forward(
        "/v1/responses",
        "openai",
        { model: "gpt-test", input: [nativeUser] },
        shouldDispatch,
        async () => {
          const accepted = await harness!.request("/v1/responses", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: "Bearer test-key",
              "x-lore-provider": "openai",
              "x-lore-project": projectPath!,
              "x-lore-agent": "coder",
              "x-lore-session-id": sessionID,
            },
            body: JSON.stringify({
              model: "gpt-test",
              input: [{ role: "user", content: "start" }],
            }),
          });
          expect(accepted.status, await accepted.text()).toBe(200);
          const session = [...getActiveSessions().values()].find(
            (candidate) => candidate.headerSessionId === sessionID,
          );
          if (!session || session.storageTenantId === undefined)
            throw new Error("missing accepted session owner");
          core.withTenant(session.storageTenantId, () =>
            core.setForceMinLayer(1, session.sessionID),
          );
        },
        { upstreamCalls: 2, headers: { "x-lore-session-id": sessionID } },
      );
      if (shouldDispatch) {
        expect(upstream.input).toContainEqual(nativeUser);
      } else {
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
          error: {
            type: "invalid_request_error",
            message: "Unsupported cross-provider request",
          },
        });
      }
    },
  );

  it.each([
    { provider: "anthropic" as const, streamed: false },
    { provider: "anthropic" as const, streamed: true },
    { provider: "openai" as const, streamed: false },
    { provider: "openai" as const, streamed: true },
  ])(
    "rejects an unresolvable Responses item reference %#",
    async ({ provider, streamed }) => {
      const { response } = await forward(
        "/v1/responses",
        provider,
        {
          model: provider === "openai" ? "gpt-test" : "claude-test",
          ...(streamed ? { metadata: { padding: "x".repeat(262145) } } : {}),
          input: [
            { type: "item_reference", id: "upstream-only-id" },
            { role: "user", content: "continue" },
          ],
        },
        false,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: {
          type: "invalid_request_error",
          message: "Unsupported cross-provider request",
        },
      });
    },
  );

  it("rejects a cited Anthropic assistant text before Responses dispatch", async () => {
    const { response } = await forward(
      "/v1/messages",
      "openai",
      {
        model: "gpt-test",
        max_tokens: 128,
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "text",
                text: "source answer",
                citations: [
                  {
                    type: "web_search_result_location",
                    cited_text: "source",
                    url: "https://example.test/source",
                    title: "source",
                  },
                ],
              },
            ],
          },
          { role: "user", content: "continue" },
        ],
      },
      false,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        type: "invalid_request_error",
        message: "Unsupported cross-provider request",
      },
    });
  });

  it("retains Anthropic assistant text citations on the native route", async () => {
    const cited = {
      type: "text",
      text: "source answer",
      citations: [
        {
          type: "web_search_result_location",
          cited_text: "source",
          url: "https://example.test/source",
          title: "source",
        },
      ],
    };
    const { upstream } = await forward("/v1/messages", "anthropic", {
      model: "claude-test",
      max_tokens: 128,
      messages: [
        { role: "assistant", content: [cited] },
        { role: "user", content: "continue" },
      ],
    });
    expect(upstream.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: expect.arrayContaining([cited]),
        }),
      ]),
    );
  });

  it("rejects Responses user text metadata before Anthropic dispatch", async () => {
    const { response } = await forward(
      "/v1/responses",
      "anthropic",
      {
        model: "claude-test",
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "question",
                source_ref: "private-reference",
              },
            ],
          },
        ],
      },
      false,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        type: "invalid_request_error",
        message: "Unsupported cross-provider request",
      },
    });
  });

  it("rejects unsupported Responses user text fields on the native route", async () => {
    const part = {
      type: "input_text",
      text: "question",
      source_ref: "private-reference",
    };
    const { response } = await forward(
      "/v1/responses",
      "openai",
      {
        model: "gpt-test",
        input: [{ type: "message", role: "user", content: [part] }],
      },
      false,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        type: "invalid_request_error",
        message: "Unsupported cross-provider request",
      },
    });
  });

  it("rejects annotated Responses tool output arrays before Anthropic dispatch", async () => {
    const { response } = await forward(
      "/v1/responses",
      "anthropic",
      {
        model: "claude-test",
        input: [
          {
            type: "function_call",
            call_id: "call_annotated",
            name: "read",
            arguments: "{}",
          },
          {
            type: "function_call_output",
            call_id: "call_annotated",
            output: [
              {
                type: "output_text",
                text: "read result",
                annotations: [
                  { type: "url_citation", url: "https://example.test/a" },
                ],
              },
            ],
          },
          { role: "user", content: "continue" },
        ],
      },
      false,
    );
    expect(response.status).toBe(400);
  });

  it("rejects unsupported native Responses tool output text fields before dispatch", async () => {
    const { response } = await forward(
      "/v1/responses",
      "openai",
      {
        model: "gpt-test",
        input: [
          {
            type: "function_call",
            call_id: "call_extra",
            name: "read",
            arguments: "{}",
          },
          {
            type: "function_call_output",
            call_id: "call_extra",
            output: [
              {
                type: "output_text",
                text: "read result",
                cache_control: { type: "ephemeral" },
              },
            ],
          },
          { role: "user", content: "continue" },
        ],
      },
      false,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        type: "invalid_request_error",
        message: "Unsupported cross-provider request",
      },
    });
  });

  it("rejects a foreign image nested in a native Responses tool output", async () => {
    const { response } = await forward(
      "/v1/responses",
      "openai",
      {
        model: "gpt-test",
        input: [
          {
            type: "function_call",
            call_id: "call_image",
            name: "read",
            arguments: "{}",
          },
          {
            type: "function_call_output",
            call_id: "call_image",
            output: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: png },
              },
            ],
          },
          { role: "user", content: "continue" },
        ],
      },
      false,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        type: "invalid_request_error",
        message: "Unsupported cross-provider request",
      },
    });
  });

  it("rejects a native Responses tool image with an object URL before dispatch", async () => {
    const { response } = await forward(
      "/v1/responses",
      "openai",
      {
        model: "gpt-test",
        input: [
          {
            type: "function_call",
            call_id: "call_image",
            name: "read",
            arguments: "{}",
          },
          {
            type: "function_call_output",
            call_id: "call_image",
            output: [
              {
                type: "input_image",
                image_url: { url: "https://example.test/a.png" },
              },
            ],
          },
          { role: "user", content: "continue" },
        ],
      },
      false,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        type: "invalid_request_error",
        message: "Unsupported cross-provider request",
      },
    });
  });

  it("replays a native Responses tool image referenced by file_id", async () => {
    const output = [{ type: "input_image", file_id: "file_test_image" }];
    const { upstream } = await forward("/v1/responses", "openai", {
      model: "gpt-test",
      input: [
        {
          type: "function_call",
          call_id: "call_file_image",
          name: "read",
          arguments: "{}",
        },
        {
          type: "function_call_output",
          call_id: "call_file_image",
          output,
        },
        { role: "user", content: "continue" },
      ],
    });
    expect(upstream.input).toContainEqual({
      type: "function_call_output",
      call_id: "call_file_image",
      output,
    });
  });

  it.each(
    [
      ["empty ID", { type: "input_file", file_id: "" }],
      [
        "conflicting references",
        {
          type: "input_file",
          file_id: "file_valid",
          filename: "notes.pdf",
          file_data: "data:application/pdf;base64,JVBERi0xLjQ=",
        },
      ],
      [
        "malformed data",
        { type: "input_file", filename: "notes.pdf", file_data: "invalid" },
      ],
    ].flatMap(([name, file]) =>
      [false, true].map((streamed) => [name, file, streamed] as const),
    ),
  )(
    "rejects malformed native Responses tool file parts (%s, %j, streamed=%s)",
    async (_name, file, streamed) => {
      const { response } = await forward(
        "/v1/responses",
        "openai",
        {
          model: "gpt-test",
          ...(streamed
            ? { padding: "x".repeat(STREAMING_PARSE_SPOOL_BYTES + 1) }
            : {}),
          input: [
            {
              type: "function_call",
              call_id: "call_file",
              name: "read",
              arguments: "{}",
            },
            {
              type: "function_call_output",
              call_id: "call_file",
              output: [file],
            },
            { role: "user", content: "continue" },
          ],
        },
        false,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: {
          type: "invalid_request_error",
          message: "Unsupported cross-provider request",
        },
      });
    },
  );

  it.each([
    { type: "input_file", file_id: "file_valid" },
    {
      type: "input_file",
      filename: "notes.pdf",
      file_data: "data:application/pdf;base64,JVBERi0xLjQ=",
    },
    { type: "input_file", file_url: "https://example.test/notes.pdf" },
  ])("replays a valid native Responses tool file part %#", async (file) => {
    const { upstream } = await forward("/v1/responses", "openai", {
      model: "gpt-test",
      input: [
        {
          type: "function_call",
          call_id: "call_file",
          name: "read",
          arguments: "{}",
        },
        { type: "function_call_output", call_id: "call_file", output: [file] },
        { role: "user", content: "continue" },
      ],
    });
    expect(upstream.input).toContainEqual({
      type: "function_call_output",
      call_id: "call_file",
      output: [file],
    });
  });

  it.each([false, true])(
    "rejects an invalid native file inside a shorthand Responses user item (streamed=%s)",
    async (streamed) => {
      const { response } = await forward(
        "/v1/responses",
        "openai",
        {
          model: "gpt-test",
          ...(streamed
            ? { padding: "x".repeat(STREAMING_PARSE_SPOOL_BYTES + 1) }
            : {}),
          input: [
            {
              role: "user",
              id: "msg_file",
              status: "completed",
              content: [
                {
                  type: "input_file",
                  filename: "notes.pdf",
                  file_data: "invalid",
                },
              ],
            },
          ],
        },
        false,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: {
          type: "invalid_request_error",
          message: "Unsupported cross-provider request",
        },
      });
    },
  );

  it("rejects a native Responses assistant image with an object URL before dispatch", async () => {
    const { response } = await forward(
      "/v1/responses",
      "openai",
      {
        model: "gpt-test",
        input: [
          {
            type: "message",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "input_image",
                image_url: { url: "https://example.test/a.png" },
              },
            ],
          },
          { role: "user", content: "continue" },
        ],
      },
      false,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        type: "invalid_request_error",
        message: "Unsupported cross-provider request",
      },
    });
  });

  it.each([false, true])(
    "replays native Responses tool output with text annotations and image=%s",
    async (withImage) => {
      const output = [
        {
          type: "output_text",
          text: "read result",
          annotations: [
            { type: "url_citation", url: "https://example.test/a" },
          ],
        },
        ...(withImage ? [{ type: "input_image", image_url: dataURL }] : []),
      ];
      const input = [
        {
          type: "function_call",
          call_id: "call_annotated",
          name: "read",
          arguments: "{}",
        },
        {
          type: "function_call_output",
          call_id: "call_annotated",
          output,
        },
        { role: "user", content: "continue" },
      ];
      const request = parseOpenAIResponsesRequest(
        { model: "gpt-test", input },
        { authorization: "Bearer test-key" },
      );
      const lore = gatewayMessagesToLore(request.messages, "conformance");
      const provenance = new Map(
        lore.flatMap((message, index) => {
          const original = request.messages[index];
          return original?.provenanceContent
            ? [
                [
                  message.info.id,
                  {
                    content: original.content,
                    provenanceContent: original.provenanceContent,
                    provenancePositions: original.provenancePositions,
                  },
                ] as const,
              ]
            : [];
        }),
      );
      resolveToolResults(lore);
      const replayed = loreMessagesToGateway(lore, provenance);
      expect(
        replayed.flatMap((message) => message.provenanceContent ?? []),
      ).toContainEqual({
        type: "opaque",
        raw: input[1],
        responsesItem: true,
      });
      const { upstream } = await forward("/v1/responses", "openai", {
        model: "gpt-test",
        input,
      });
      expect(upstream.input).toContainEqual({
        type: "function_call_output",
        call_id: "call_annotated",
        output,
      });
    },
  );

  it("rejects cited Responses assistant text on Chat conversion", () => {
    // Responses ingress currently routes only to Responses or Anthropic. Exercise
    // the Chat converter directly so future routing cannot silently drop citations.
    const request = parseOpenAIResponsesRequest(
      {
        model: "gpt-test",
        input: [
          {
            type: "message",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: "cited claim",
                annotations: [
                  { type: "url_citation", url: "https://example.test/source" },
                ],
              },
            ],
          },
          { role: "user", content: "continue" },
        ],
      },
      { authorization: "Bearer test-key" },
    );
    expect(() =>
      buildOpenAIUpstreamRequest(request, "https://openrouter.ai/api/v1"),
    ).toThrow("Unsupported cross-provider request");
  });

  it("rejects a non-text Responses developer item instead of lowering its priority", async () => {
    const { response } = await forward(
      "/v1/responses",
      "anthropic",
      {
        model: "claude-test",
        input: [
          {
            role: "developer",
            content: [{ type: "input_image", image_url: dataURL }],
          },
          { role: "user", content: "question" },
        ],
      },
      false,
    );
    expect(response.status).toBe(400);
    expect((await response.json()) as unknown).toMatchObject({
      error: {
        type: "invalid_request_error",
        message: "Unsupported cross-provider request",
      },
    });
  });
});

it("round-trips supported base64 image bytes across Anthropic and Responses", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("image/png", "image/jpeg", "image/gif", "image/webp"),
      fc.uint8Array({ minLength: 1, maxLength: 128 }),
      (mediaType, bytes) => {
        const original = {
          type: "image",
          source: {
            type: "base64",
            media_type: mediaType,
            data: Buffer.from(bytes).toString("base64"),
          },
        };
        expect(
          toAnthropicImage(
            toResponsesImage(original, "anthropic"),
            "openai-responses",
          ),
        ).toEqual(original);
      },
    ),
  );
});
