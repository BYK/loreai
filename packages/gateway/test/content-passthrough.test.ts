/**
 * Lossless content-block passthrough tests.
 *
 * Verifies that image, audio, document, and any unknown/future content block
 * types survive the gateway round-trip faithfully — both as top-level message
 * blocks and as sub-blocks inside tool_result content.
 *
 * These tests guard against the class of bug where the gateway's internal type
 * system silently strips/coerces unrecognized block types, causing downstream
 * LLM calls to receive empty or corrupted content (e.g. Claude Code's `Read`
 * tool on a PNG returned "Tool ran without output or errors").
 */
import { describe, expect, test } from "bun:test";
import {
  parseAnthropicRequest,
  buildAnthropicRequest,
} from "../src/translate/anthropic";
import { parseOpenAIRequest } from "../src/translate/openai";
import { parseOpenAIResponsesRequest } from "../src/translate/openai-responses";
import {
  gatewayMessagesToLore,
  resolveToolResults,
} from "../src/temporal-adapter";
import { loreMessagesToGateway } from "../src/pipeline";
import { blocksToText } from "../src/translate/types";
import type { GatewayContentBlock } from "../src/translate/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const IMAGE_BLOCK = {
  type: "image",
  source: {
    type: "base64",
    media_type: "image/png",
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  },
};

const AUDIO_BLOCK = {
  type: "input_audio",
  input_audio: { data: "AAAA", format: "wav" },
};

const UNKNOWN_FUTURE_BLOCK = {
  type: "hologram_3d",
  data: { mesh: "cube", vertices: 1024 },
  format: "gltf",
};

const HEADERS = { "x-api-key": "sk-test-key" };

// ---------------------------------------------------------------------------
// Anthropic protocol round-trip
// ---------------------------------------------------------------------------

describe("Anthropic lossless content passthrough", () => {
  test("top-level image block round-trips through parse → build", () => {
    const body = {
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What's in this image?" },
            IMAGE_BLOCK,
          ],
        },
      ],
    };

    const req = parseAnthropicRequest(body, HEADERS);

    // The image block should be preserved as opaque
    expect(req.messages[0].content).toHaveLength(2);
    expect(req.messages[0].content[0].type).toBe("text");
    expect(req.messages[0].content[1].type).toBe("opaque");
    if (req.messages[0].content[1].type === "opaque") {
      expect(req.messages[0].content[1].raw).toEqual(IMAGE_BLOCK);
    }

    // Round-trip: build should re-emit the original block verbatim
    const { body: built } = buildAnthropicRequest(req);
    const builtMessages = (built as Record<string, unknown>).messages as Array<
      Record<string, unknown>
    >;
    const builtContent = builtMessages[0].content as Array<
      Record<string, unknown>
    >;
    expect(builtContent).toHaveLength(2);
    expect(builtContent[0]).toEqual({
      type: "text",
      text: "What's in this image?",
    });
    expect(builtContent[1]).toEqual(IMAGE_BLOCK);
  });

  test("tool_result with image sub-block round-trips (Onur's exact case)", () => {
    // This is the exact shape Claude Code's `Read` tool produces when
    // reading a PNG: a tool_result whose content is an array with a single
    // image block (no text).
    const body = {
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_read_123",
              name: "Read",
              input: { file_path: "/tmp/screenshot.png" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_read_123",
              content: [IMAGE_BLOCK],
            },
          ],
        },
      ],
    };

    const req = parseAnthropicRequest(body, HEADERS);

    // tool_result content should be a block array with the image as opaque
    const toolResult = req.messages[1].content[0];
    expect(toolResult.type).toBe("tool_result");
    if (toolResult.type === "tool_result") {
      expect(toolResult.content).toHaveLength(1);
      expect(toolResult.content[0].type).toBe("opaque");
      if (toolResult.content[0].type === "opaque") {
        expect(toolResult.content[0].raw).toEqual(IMAGE_BLOCK);
      }
    }

    // Round-trip: build should re-emit the image inside tool_result
    const { body: built } = buildAnthropicRequest(req);
    const builtMessages = (built as Record<string, unknown>).messages as Array<
      Record<string, unknown>
    >;
    const builtToolResult = (
      builtMessages[1].content as Array<Record<string, unknown>>
    )[0];
    expect(builtToolResult.type).toBe("tool_result");
    expect(builtToolResult.content).toEqual([IMAGE_BLOCK]);
  });

  test("tool_result with mixed text + image round-trips", () => {
    const body = {
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_123",
              name: "Read",
              input: { file_path: "/tmp/file.png" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_123",
              content: [
                { type: "text", text: "File metadata: 1024x768" },
                IMAGE_BLOCK,
              ],
            },
          ],
        },
      ],
    };

    const req = parseAnthropicRequest(body, HEADERS);
    const toolResult = req.messages[1].content[0];
    if (toolResult.type === "tool_result") {
      expect(toolResult.content).toHaveLength(2);
      expect(toolResult.content[0].type).toBe("text");
      expect(toolResult.content[1].type).toBe("opaque");
    }

    const { body: built } = buildAnthropicRequest(req);
    const builtMessages = (built as Record<string, unknown>).messages as Array<
      Record<string, unknown>
    >;
    const builtToolResult = (
      builtMessages[1].content as Array<Record<string, unknown>>
    )[0];
    expect(builtToolResult.content).toEqual([
      { type: "text", text: "File metadata: 1024x768" },
      IMAGE_BLOCK,
    ]);
  });

  test("tool_result with empty content array round-trips", () => {
    const body = {
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_empty",
              name: "Read",
              input: {},
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_empty",
              content: [],
            },
          ],
        },
      ],
    };

    const req = parseAnthropicRequest(body, HEADERS);
    const toolResult = req.messages[1].content[0];
    if (toolResult.type === "tool_result") {
      expect(toolResult.content).toEqual([]);
    }

    const { body: built } = buildAnthropicRequest(req);
    const builtMessages = (built as Record<string, unknown>).messages as Array<
      Record<string, unknown>
    >;
    const builtToolResult = (
      builtMessages[1].content as Array<Record<string, unknown>>
    )[0];
    expect(builtToolResult.content).toEqual([]);
  });

  test("tool_result with only opaque blocks (no text) round-trips", () => {
    const body = {
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_img_only",
              name: "Screenshot",
              input: {},
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_img_only",
              content: [IMAGE_BLOCK, AUDIO_BLOCK],
            },
          ],
        },
      ],
    };

    const req = parseAnthropicRequest(body, HEADERS);
    const toolResult = req.messages[1].content[0];
    if (toolResult.type === "tool_result") {
      expect(toolResult.content).toHaveLength(2);
      expect(toolResult.content.every((b) => b.type === "opaque")).toBe(true);
    }

    const { body: built } = buildAnthropicRequest(req);
    const builtMessages = (built as Record<string, unknown>).messages as Array<
      Record<string, unknown>
    >;
    const builtToolResult = (
      builtMessages[1].content as Array<Record<string, unknown>>
    )[0];
    expect(builtToolResult.content).toEqual([IMAGE_BLOCK, AUDIO_BLOCK]);
  });

  test("unknown/future block type passes through opaque unchanged", () => {
    const body = {
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Render this" },
            UNKNOWN_FUTURE_BLOCK,
          ],
        },
      ],
    };

    const req = parseAnthropicRequest(body, HEADERS);
    const opaque = req.messages[0].content[1];
    expect(opaque.type).toBe("opaque");
    if (opaque.type === "opaque") {
      expect(opaque.raw).toEqual(UNKNOWN_FUTURE_BLOCK);
    }

    const { body: built } = buildAnthropicRequest(req);
    const builtMessages = (built as Record<string, unknown>).messages as Array<
      Record<string, unknown>
    >;
    const builtContent = builtMessages[0].content as Array<
      Record<string, unknown>
    >;
    expect(builtContent[1]).toEqual(UNKNOWN_FUTURE_BLOCK);
  });
});

// ---------------------------------------------------------------------------
// OpenAI Chat Completions protocol
// ---------------------------------------------------------------------------

describe("OpenAI Chat lossless content passthrough", () => {
  test("image_url user content preserved as opaque", () => {
    const imageUrlBlock = {
      type: "image_url",
      image_url: { url: "https://example.com/cat.jpg" },
    };
    const body = {
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What's in this image?" },
            imageUrlBlock,
          ],
        },
      ],
    };

    const req = parseOpenAIRequest(body, HEADERS);
    expect(req.messages[0].content).toHaveLength(2);
    expect(req.messages[0].content[0].type).toBe("text");
    expect(req.messages[0].content[1].type).toBe("opaque");
    if (req.messages[0].content[1].type === "opaque") {
      expect(req.messages[0].content[1].raw).toEqual(imageUrlBlock);
    }
  });

  test("system/developer array content extracts text instead of coercing to empty", () => {
    const body = {
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: [
            { type: "text", text: "You are helpful." },
            { type: "text", text: "Be concise." },
          ],
        },
        { role: "user", content: "Hello" },
      ],
    };

    const req = parseOpenAIRequest(body, HEADERS);
    expect(req.system).toBe("You are helpful.\nBe concise.");
  });

  test("developer role messages extracted as system prompt", () => {
    const body = {
      model: "gpt-4o",
      messages: [
        { role: "developer", content: "You are a code assistant." },
        { role: "user", content: "Hello" },
      ],
    };

    const req = parseOpenAIRequest(body, HEADERS);
    expect(req.system).toBe("You are a code assistant.");
  });
});

// ---------------------------------------------------------------------------
// OpenAI Responses API protocol
// ---------------------------------------------------------------------------

describe("OpenAI Responses lossless content passthrough", () => {
  test("input_image in message content preserved as opaque", () => {
    const inputImagePart = {
      type: "input_image",
      image_url: "https://example.com/cat.jpg",
    };
    const body = {
      model: "gpt-4o",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "Describe this" },
            inputImagePart,
          ],
        },
      ],
    };

    const req = parseOpenAIResponsesRequest(body, HEADERS);
    expect(req.messages[0].content).toHaveLength(2);
    expect(req.messages[0].content[0].type).toBe("text");
    expect(req.messages[0].content[1].type).toBe("opaque");
    if (req.messages[0].content[1].type === "opaque") {
      expect(req.messages[0].content[1].raw).toEqual(inputImagePart);
    }
  });
});

// ---------------------------------------------------------------------------
// Full pipeline round-trip: gateway → Lore core → gateway
// ---------------------------------------------------------------------------

describe("Full pipeline round-trip (gateway → Lore → gateway)", () => {
  test("image in tool_result survives gatewayMessagesToLore → loreMessagesToGateway", () => {
    const messages = [
      {
        role: "assistant" as const,
        content: [
          {
            type: "tool_use" as const,
            id: "toolu_read_abc",
            name: "Read",
            input: { file_path: "/tmp/test.png" },
          },
        ],
      },
      {
        role: "user" as const,
        content: [
          {
            type: "tool_result" as const,
            toolUseId: "toolu_read_abc",
            content: [
              { type: "opaque" as const, raw: IMAGE_BLOCK },
            ] as GatewayContentBlock[],
          },
        ],
      },
    ];

    // gateway → Lore
    const loreMessages = gatewayMessagesToLore(messages, "test-session");
    resolveToolResults(loreMessages);

    // Lore → gateway
    const roundTripped = loreMessagesToGateway(loreMessages);

    // The assistant message should have tool_use
    expect(roundTripped[0].content[0].type).toBe("tool_use");

    // The user message should have tool_result with the image preserved
    const toolResult = roundTripped[1].content.find(
      (b) => b.type === "tool_result",
    );
    expect(toolResult).toBeDefined();
    if (toolResult?.type === "tool_result") {
      expect(toolResult.content).toHaveLength(1);
      expect(toolResult.content[0].type).toBe("opaque");
      if (toolResult.content[0].type === "opaque") {
        expect(toolResult.content[0].raw).toEqual(IMAGE_BLOCK);
      }
    }
  });

  test("top-level opaque block survives gatewayMessagesToLore → loreMessagesToGateway", () => {
    const messages = [
      {
        role: "user" as const,
        content: [
          { type: "text" as const, text: "See this" },
          { type: "opaque" as const, raw: IMAGE_BLOCK },
        ] as GatewayContentBlock[],
      },
    ];

    const loreMessages = gatewayMessagesToLore(messages, "test-session");
    const roundTripped = loreMessagesToGateway(loreMessages);

    expect(roundTripped[0].content).toHaveLength(2);
    expect(roundTripped[0].content[0].type).toBe("text");
    expect(roundTripped[0].content[1].type).toBe("opaque");
    if (roundTripped[0].content[1].type === "opaque") {
      expect(roundTripped[0].content[1].raw).toEqual(IMAGE_BLOCK);
    }
  });
});

// ---------------------------------------------------------------------------
// Deterministic ID collision guard
// ---------------------------------------------------------------------------

describe("deterministicID collision guard", () => {
  test("messages differing only in image content produce different IDs", () => {
    const msg1Content: GatewayContentBlock[] = [
      { type: "text", text: "See this" },
      { type: "opaque", raw: IMAGE_BLOCK },
    ];
    const msg2Content: GatewayContentBlock[] = [
      { type: "text", text: "See this" },
      {
        type: "opaque",
        raw: {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/jpeg",
            data: "DIFFERENT_DATA",
          },
        },
      },
    ];
    const msg3Content: GatewayContentBlock[] = [
      { type: "text", text: "See this" },
    ];

    const lore1 = gatewayMessagesToLore(
      [{ role: "user", content: msg1Content }],
      "s",
    );
    const lore2 = gatewayMessagesToLore(
      [{ role: "user", content: msg2Content }],
      "s",
    );
    const lore3 = gatewayMessagesToLore(
      [{ role: "user", content: msg3Content }],
      "s",
    );

    // All three should have distinct IDs
    const ids = new Set([lore1[0].info.id, lore2[0].info.id, lore3[0].info.id]);
    expect(ids.size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// blocksToText projection
// ---------------------------------------------------------------------------

describe("blocksToText", () => {
  test("text blocks are joined", () => {
    const blocks: GatewayContentBlock[] = [
      { type: "text", text: "hello" },
      { type: "text", text: "world" },
    ];
    expect(blocksToText(blocks)).toBe("hello\nworld");
  });

  test("opaque image block produces a placeholder", () => {
    const blocks: GatewayContentBlock[] = [
      { type: "opaque", raw: IMAGE_BLOCK },
    ];
    const text = blocksToText(blocks);
    expect(text).toContain("[image");
    expect(text).toContain("image/png");
    expect(text).toContain("chars]");
    // Must NOT contain the base64 payload
    expect(text).not.toContain("iVBORw0KGgo");
  });

  test("nested tool_result blocks are recursed", () => {
    const blocks: GatewayContentBlock[] = [
      {
        type: "tool_result",
        toolUseId: "t1",
        content: [
          { type: "text", text: "file content" },
          { type: "opaque", raw: IMAGE_BLOCK },
        ],
      },
    ];
    const text = blocksToText(blocks);
    expect(text).toContain("file content");
    expect(text).toContain("[image");
  });

  test("empty array returns empty string", () => {
    expect(blocksToText([])).toBe("");
  });

  test("opaque block with no source/data/media_type produces minimal placeholder", () => {
    const blocks: GatewayContentBlock[] = [
      { type: "opaque", raw: { type: "custom_widget", payload: 42 } },
    ];
    expect(blocksToText(blocks)).toBe("[custom_widget]");
  });

  test("audio block placeholder includes type", () => {
    const blocks: GatewayContentBlock[] = [
      { type: "opaque", raw: AUDIO_BLOCK },
    ];
    const text = blocksToText(blocks);
    expect(text).toContain("[input_audio");
  });

  test("depth guard prevents stack overflow on deeply nested content", () => {
    // Build 15 levels of nesting (exceeds the depth=10 guard)
    let inner: GatewayContentBlock[] = [{ type: "text", text: "deep" }];
    for (let i = 0; i < 15; i++) {
      inner = [{ type: "tool_result", toolUseId: `t${i}`, content: inner }];
    }
    const text = blocksToText(inner);
    // Should hit the guard and produce the fallback instead of stack overflow
    expect(text).toContain("[nested content]");
  });
});
