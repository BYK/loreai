/**
 * Unit tests for gateway recall interception helpers.
 *
 * Tests the pure functions in recall.ts:
 *  - Tool definition
 *  - Detection helpers (findRecallToolUse, hasRecallToolUse, hasOtherToolUse)
 *  - Follow-up request builder
 *  - Pending recall injection
 *  - Response stripping
 */
import { describe, test, expect, vi } from "vitest";
import {
  LORE_COMMIT_REMINDER,
  accumulateOpenAINonStreamJSON,
  loreMessagesToGateway,
  responsesProvenanceContent,
  responsesProvenanceByMessageId,
  responsesAnchorContext,
} from "../src/pipeline";
import {
  RECALL_GATEWAY_TOOL,
  RECALL_TOOL_NAME,
  MAX_RECALL_DEPTH,
  findRecallToolUse,
  hasRecallToolUse,
  hasOtherToolUse,
  clientHasRecallTool,
  buildRecallFollowUpRequest,
  runRecallFollowUpStreaming,
  runRecallFollowUpJSON,
  runRecallFollowUpStreamAccumulated,
  type RecallFollowUpCtx,
  buildRecallMarker,
  buildRecallAnchor,
  parseRecallAnchor,
  recallAnchorContext,
  parseRecallMarker,
  isRecallMarker,
  scopeToLabel,
  labelToScope,
  recallStoreKey,
  expandRecallMarkers,
  cleanupRecallStore,
  replaceRecallWithMarker,
  serializeRecallStore,
  deserializeRecallStore,
  addRecallStoreEntry,
  MAX_RECALL_STORE_ENTRIES,
  MAX_RECALL_STORE_BYTES,
  executeRecall,
} from "../src/recall";
import {
  buildOpenAIResponsesUpstreamRequest,
  parseOpenAIResponsesRequest,
} from "../src/translate/openai-responses";
import {
  gatewayMessagesToLore,
  resolveToolResults,
} from "../src/temporal-adapter";
import type {
  GatewayResponse,
  GatewayRequest,
  GatewayToolUseBlock,
  RecallStore,
  StoredRecall,
} from "../src/translate/types";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeResponse(
  content: GatewayResponse["content"],
  stopReason = "end_turn",
): GatewayResponse {
  return {
    id: "msg_test",
    model: "claude-sonnet-4-20250514",
    content,
    stopReason,
    usage: { inputTokens: 100, outputTokens: 50 },
  };
}

function makeRequest(
  messages: GatewayRequest["messages"] = [],
  tools: GatewayRequest["tools"] = [],
): GatewayRequest {
  return {
    protocol: "anthropic",
    model: "claude-sonnet-4-20250514",
    system: "test system",
    messages,
    tools,
    stream: true,
    maxTokens: 1024,
    metadata: {},
    rawHeaders: {},
  };
}

function makeRecallToolUse(
  query = "test query",
  scope = "all",
  id = "toolu_recall_1",
): GatewayToolUseBlock {
  return {
    type: "tool_use",
    id,
    name: RECALL_TOOL_NAME,
    input: { query, scope },
  };
}

function makeStoredRecall(overrides: Partial<StoredRecall> = {}): StoredRecall {
  return {
    toolUseId: "toolu_recall_1",
    input: { query: "test query", scope: "all" },
    position: 1,
    result: "## Recall Results\n* some result",
    anchorContextId: "0".repeat(64),
    ...overrides,
  };
}

function bindCanonicalAnchors(req: GatewayRequest, store: RecallStore): void {
  for (let i = 0; i < req.messages.length; i++) {
    const message = req.messages[i];
    if (message.role !== "assistant") continue;
    for (let j = 0; j < message.content.length; j++) {
      const block = message.content[j];
      if (block.type !== "text") continue;
      const anchorId = parseRecallAnchor(block.text);
      if (!anchorId) continue;
      const stored = store.get(`anchor:${anchorId}`);
      if (stored) {
        stored.anchorContextId = recallAnchorContext(
          req.messages,
          i,
          message.content.slice(0, j),
        );
      }
    }
  }
}

function bindReplayEntries(req: GatewayRequest, store: RecallStore): void {
  for (let i = 0; i < req.messages.length; i++) {
    const message = req.messages[i];
    if (message.role !== "assistant") continue;
    for (let j = 0; j < message.content.length; j++) {
      const block = message.content[j];
      if (block.type !== "text") continue;
      const anchorId = parseRecallAnchor(block.text);
      const marker = parseRecallMarker(block.text);
      const key = anchorId
        ? `anchor:${anchorId}`
        : marker
          ? recallStoreKey(marker.query, marker.scope, marker.id)
          : undefined;
      const stored = key ? store.get(key) : undefined;
      if (stored) {
        stored.anchorContextId = recallAnchorContext(
          req.messages,
          i,
          message.content.slice(0, j),
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

describe("RECALL_GATEWAY_TOOL", () => {
  test("has correct name and schema", () => {
    expect(RECALL_GATEWAY_TOOL.name).toBe("recall");
    expect(RECALL_GATEWAY_TOOL.description).toBeTruthy();
    const schema = RECALL_GATEWAY_TOOL.inputSchema;
    expect(schema.type).toBe("object");
    const props = schema.properties as Record<string, unknown>;
    expect(props).toHaveProperty("query");
    expect(props).toHaveProperty("scope");
    expect(schema.required).toEqual(["query"]);
    expect(schema.additionalProperties).toBe(false);
  });

  test("instructs resolving named references via recall before exploring", () => {
    // Recall-first directive: the agent must resolve a named project/repo/
    // person/service reference against memory before filesystem exploration.
    expect(RECALL_GATEWAY_TOOL.description).toContain(
      "before searching the filesystem",
    );
  });
});

describe("executeRecall malformed input", () => {
  test.each([
    null,
    [],
    "query",
    { query: null },
    { query: "ok", scope: "invalid" },
    { query: "ok", limit: 0 },
    { query: "ok", limit: 1.5 },
  ])("returns the safe failure result for %#", async (input) => {
    const result = await executeRecall(
      {
        type: "tool_use",
        id: "recall-malformed",
        name: RECALL_TOOL_NAME,
        input,
      },
      process.cwd(),
      "malformed-input",
    );
    expect(result.result).toBe(
      "Recall search failed. The memory system encountered an error.",
    );
    expect(result.input).toEqual({ query: "", scope: "all", id: undefined });
  });

  test('OpenAI arguments "null" reaches the same safe failure path', async () => {
    const parsed = accumulateOpenAINonStreamJSON({
      choices: [
        {
          index: 0,
          finish_reason: "tool_calls",
          message: {
            tool_calls: [
              {
                id: "call-null",
                function: { name: RECALL_TOOL_NAME, arguments: "null" },
              },
            ],
          },
        },
      ],
    });
    const block = parsed.content[0];
    if (block?.type !== "tool_use") throw new Error("missing recall tool use");
    const result = await executeRecall(
      block,
      process.cwd(),
      "openai-null-input",
    );
    expect(result.result).toBe(
      "Recall search failed. The memory system encountered an error.",
    );
  });
});

describe("LORE_COMMIT_REMINDER", () => {
  test("instructs `git add .lore.md` as a concrete pre-commit step", () => {
    expect(LORE_COMMIT_REMINDER).toContain("git add .lore.md");
  });

  test("explicitly forbids `git stash` on .lore.md", () => {
    expect(LORE_COMMIT_REMINDER).toContain("NEVER `git stash` `.lore.md`");
  });

  test("clarifies that background changes must also be committed", () => {
    expect(LORE_COMMIT_REMINDER).toContain("changes you did NOT make");
  });

  test("does not contain the old soft wording (regression guard)", () => {
    expect(LORE_COMMIT_REMINDER).not.toContain("always check if .lore.md");
  });

  test("does not start with whitespace (separator belongs at call site)", () => {
    expect(LORE_COMMIT_REMINDER).toMatch(/^\S/);
  });
});

describe("MAX_RECALL_DEPTH", () => {
  test("is a positive integer safety-net cap", () => {
    expect(MAX_RECALL_DEPTH).toBeGreaterThan(0);
    expect(Number.isInteger(MAX_RECALL_DEPTH)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

describe("findRecallToolUse", () => {
  test("finds recall block in response", () => {
    const recallBlock = makeRecallToolUse();
    const resp = makeResponse([{ type: "text", text: "hello" }, recallBlock]);
    expect(findRecallToolUse(resp)).toBe(recallBlock);
  });

  test("returns undefined when no recall", () => {
    const resp = makeResponse([
      { type: "text", text: "hello" },
      { type: "tool_use", id: "toolu_1", name: "Read", input: { path: "/a" } },
    ]);
    expect(findRecallToolUse(resp)).toBeUndefined();
  });

  test("returns undefined for empty response", () => {
    const resp = makeResponse([]);
    expect(findRecallToolUse(resp)).toBeUndefined();
  });
});

describe("hasRecallToolUse", () => {
  test("returns true when recall present", () => {
    const resp = makeResponse([makeRecallToolUse()]);
    expect(hasRecallToolUse(resp)).toBe(true);
  });

  test("returns false when no recall", () => {
    const resp = makeResponse([{ type: "text", text: "hello" }]);
    expect(hasRecallToolUse(resp)).toBe(false);
  });
});

describe("hasOtherToolUse", () => {
  test("returns true when non-recall tools present", () => {
    const resp = makeResponse([
      makeRecallToolUse(),
      { type: "tool_use", id: "toolu_1", name: "Read", input: {} },
    ]);
    expect(hasOtherToolUse(resp)).toBe(true);
  });

  test("returns false when only recall present", () => {
    const resp = makeResponse([
      { type: "text", text: "let me search" },
      makeRecallToolUse(),
    ]);
    expect(hasOtherToolUse(resp)).toBe(false);
  });

  test("returns false when no tools at all", () => {
    const resp = makeResponse([{ type: "text", text: "hello" }]);
    expect(hasOtherToolUse(resp)).toBe(false);
  });
});

describe("clientHasRecallTool", () => {
  test("returns true when client has recall tool", () => {
    expect(
      clientHasRecallTool([
        { name: "Read", description: "Read a file", inputSchema: {} },
        { name: "recall", description: "Search memory", inputSchema: {} },
      ]),
    ).toBe(true);
  });

  test("returns false when client has no recall tool", () => {
    expect(
      clientHasRecallTool([
        { name: "Read", description: "Read a file", inputSchema: {} },
        { name: "Bash", description: "Run command", inputSchema: {} },
      ]),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Marker utilities
// ---------------------------------------------------------------------------

describe("scopeToLabel / labelToScope", () => {
  test("maps all scopes to labels", () => {
    expect(scopeToLabel("all")).toBe("all archives");
    expect(scopeToLabel("session")).toBe("session history");
    expect(scopeToLabel("project")).toBe("project archives");
    expect(scopeToLabel("knowledge")).toBe("knowledge base");
  });

  test("defaults unknown scope to 'all archives'", () => {
    expect(scopeToLabel("unknown")).toBe("all archives");
    expect(scopeToLabel()).toBe("all archives");
  });

  test("reverse maps labels back to scopes", () => {
    expect(labelToScope("all archives")).toBe("all");
    expect(labelToScope("session history")).toBe("session");
    expect(labelToScope("project archives")).toBe("project");
    expect(labelToScope("knowledge base")).toBe("knowledge");
  });

  test("defaults unknown label to 'all'", () => {
    expect(labelToScope("unknown label")).toBe("all");
  });
});

describe("buildRecallMarker", () => {
  test("builds correct marker with default scope", () => {
    expect(buildRecallMarker("test query")).toBe(
      '📚 Searching all archives for "test query"…',
    );
  });

  test("builds correct marker with explicit scope", () => {
    expect(buildRecallMarker("auth flow", "session")).toBe(
      '📚 Searching session history for "auth flow"…',
    );
    expect(buildRecallMarker("config", "project")).toBe(
      '📚 Searching project archives for "config"…',
    );
    expect(buildRecallMarker("patterns", "knowledge")).toBe(
      '📚 Searching knowledge base for "patterns"…',
    );
  });
});

describe("recall replay anchors", () => {
  test("round-trips a canonical UUID without exposing the recall query", () => {
    const id = "123e4567-e89b-42d3-a456-426614174000";
    const anchor = buildRecallAnchor(id);
    expect(anchor).toBe(`<!-- lore-recall:${id} -->`);
    expect(anchor).not.toContain("Searching");
    expect(parseRecallAnchor(anchor)).toBe(id);
    expect(parseRecallAnchor(`<!-- lore-recall:${id} -->\n`)).toBeNull();
    expect(parseRecallAnchor("<!-- lore-recall:%31 -->")).toBeNull();
    expect(parseRecallAnchor("ordinary assistant text")).toBeNull();
  });

  test("finds an anchored status marker when the query contains newlines", () => {
    const id = "123e4567-e89b-42d3-a456-426614174010";
    const marker = `${buildRecallMarker("line one\nline two")}\n${buildRecallAnchor(id)}`;
    expect(isRecallMarker(marker)).toBe(true);
  });

  test("legacy markers match only an entire text block", () => {
    expect(
      parseRecallMarker(
        `prefix ${buildRecallMarker("auth", "session")} suffix`,
      ),
    ).toBeNull();
    expect(
      parseRecallMarker(`prefix ${buildRecallMarker("", "all", "k:abc")}`),
    ).toBeNull();
  });
});

describe("parseRecallMarker", () => {
  test("parses a valid marker", () => {
    const result = parseRecallMarker(
      '📚 Searching all archives for "gradient cache"…',
    );
    expect(result).toEqual({ query: "gradient cache", scope: "all" });
  });

  test("parses markers with different scopes", () => {
    expect(
      parseRecallMarker('📚 Searching session history for "auth"…'),
    ).toEqual({ query: "auth", scope: "session" });
    expect(
      parseRecallMarker('📚 Searching project archives for "config"…'),
    ).toEqual({ query: "config", scope: "project" });
    expect(
      parseRecallMarker('📚 Searching knowledge base for "patterns"…'),
    ).toEqual({ query: "patterns", scope: "knowledge" });
  });

  test("returns null for non-marker text", () => {
    expect(parseRecallMarker("hello world")).toBeNull();
    expect(parseRecallMarker("[Searching memory...]")).toBeNull();
    expect(parseRecallMarker("")).toBeNull();
  });

  test("parses a query containing double quotes without truncating (#cache-bust)", () => {
    // Regression for the ses_14b9bf3d… recall rewrite: the lazy `(.+?)` query
    // capture stopped at the first `"`, so a query containing quotes parsed to a
    // DIFFERENT string than was stored under. expandRecallMarkers then missed the
    // store, left the raw marker upstream, and rewrote that historical assistant
    // message (tool_use → text) — a deep-history prompt-cache bust.
    const marker = buildRecallMarker('how to use "async" patterns', "project");
    expect(parseRecallMarker(marker)).toEqual({
      query: 'how to use "async" patterns',
      scope: "project",
    });
  });

  test("build → parse round-trips an arbitrary query (store key stays stable)", () => {
    for (const query of [
      'sync tiers "pro" max distillations',
      'a query with a trailing quote"',
      'nested "a" and "b" quotes',
      "plain query",
    ]) {
      const parsed = parseRecallMarker(buildRecallMarker(query, "all"));
      expect(parsed?.query).toBe(query);
      expect(parsed?.scope).toBe("all");
    }
  });
});

describe("serializeRecallStore / deserializeRecallStore", () => {
  test("round-trips a populated store (cross-restart persistence, v46)", () => {
    const store: RecallStore = new Map([
      [
        'all:sync tiers "pro" max',
        {
          toolUseId: "toolu_1",
          anchorId: "resp_1:0:toolu_1",
          input: { query: 'sync tiers "pro" max', scope: "all" },
          position: 2,
          result: "## Results\n\n* entry one\n* entry two",
          anchorContextId: "1".repeat(64),
          companionToolUseIds: ["call_read"],
        },
      ],
      [
        "id:k:abc123",
        {
          toolUseId: "toolu_2",
          input: { query: "", scope: "all", id: "k:abc123" },
          position: 0,
          result: "detail body",
          anchorContextId: "2".repeat(64),
        },
      ],
    ]);
    const restored = deserializeRecallStore(serializeRecallStore(store));
    expect(restored).toEqual(store);
  });

  test("deserialize tolerates corrupt / empty blobs", () => {
    expect(deserializeRecallStore("not json").size).toBe(0);
    expect(deserializeRecallStore("{}").size).toBe(0);
    expect(deserializeRecallStore("[]").size).toBe(0);
    expect(
      deserializeRecallStore(
        JSON.stringify([
          [
            "bad-optional",
            {
              toolUseId: "t",
              input: { query: "q" },
              position: 0,
              result: "r",
              companionToolUses: {},
            },
          ],
        ]),
      ).size,
    ).toBe(0);
    // Entries missing required fields are dropped, valid ones kept.
    const mixed = JSON.stringify([
      ["bad", { toolUseId: 123 }],
      [
        "good",
        {
          toolUseId: "t",
          input: { query: "q" },
          position: 0,
          result: "r",
          anchorContextId: "3".repeat(64),
        },
      ],
    ]);
    const restored = deserializeRecallStore(mixed);
    expect(restored.size).toBe(1);
    expect(restored.get("good")?.result).toBe("r");
  });

  test("restores pre-anchor query-keyed entries without weakening anchor validation", () => {
    const legacy = {
      toolUseId: "legacy-tool",
      input: { query: "old query", scope: "all" },
      position: 0,
      result: "old result",
    };
    const restored = deserializeRecallStore(
      JSON.stringify([
        ["all:old query", legacy],
        [
          "anchor:123e4567-e89b-42d3-a456-426614174099",
          {
            ...legacy,
            anchorId: "123e4567-e89b-42d3-a456-426614174099",
          },
        ],
      ]),
    );
    expect(restored.get("all:old query")).toEqual(legacy);
    expect(restored.size).toBe(1);

    const req = makeRequest([
      {
        role: "assistant",
        content: [
          { type: "text", text: buildRecallMarker("old query", "all") },
        ],
      },
    ]);
    expect(expandRecallMarkers(req, restored)).toBe(true);
    expect(req.messages[0].content[0]).toMatchObject({
      type: "tool_use",
      id: "legacy-tool",
      name: RECALL_TOOL_NAME,
    });
    expect(req.messages[1].content[0]).toMatchObject({
      type: "tool_result",
      toolUseId: "legacy-tool",
    });
  });

  test.each(["xyz", "A".repeat(64), "g".repeat(64)])(
    "rejects query-keyed entry with malformed context hash %s",
    (anchorContextId) => {
      const restored = deserializeRecallStore(
        JSON.stringify([
          [
            "all:old query",
            {
              toolUseId: "legacy-tool",
              input: { query: "old query", scope: "all" },
              position: 0,
              result: "old result",
              anchorContextId,
            },
          ],
        ]),
      );
      expect(restored.size).toBe(0);
    },
  );

  test("rejects a new entry without evicting live anchors at the entry cap", () => {
    const store: RecallStore = new Map();
    for (let i = 0; i < MAX_RECALL_STORE_ENTRIES; i++) {
      addRecallStoreEntry(store, `legacy-${i}`, {
        toolUseId: `tool-${i}`,
        input: { query: `query-${i}` },
        position: 0,
        result: "result",
        anchorContextId: "5".repeat(64),
      });
    }
    expect(() =>
      addRecallStoreEntry(store, "overflow", {
        toolUseId: "overflow",
        input: { query: "overflow" },
        position: 0,
        result: "result",
        anchorContextId: "6".repeat(64),
      }),
    ).toThrow("recall store capacity exceeded");
    expect(store.size).toBe(MAX_RECALL_STORE_ENTRIES);
    expect(store.has("legacy-0")).toBe(true);
  });

  test("bounds restored stores", () => {
    const entries = Array.from(
      { length: MAX_RECALL_STORE_ENTRIES + 1 },
      (_, i) => [
        `legacy-${i}`,
        {
          toolUseId: `tool-${i}`,
          input: { query: `query-${i}` },
          position: 0,
          result: "result",
          anchorContextId: "4".repeat(64),
        },
      ],
    );
    expect(deserializeRecallStore(JSON.stringify(entries)).size).toBe(
      MAX_RECALL_STORE_ENTRIES,
    );
  });

  test("rejects oversized persisted blobs before JSON parsing", () => {
    const parse = vi.spyOn(JSON, "parse");
    expect(
      deserializeRecallStore("[" + " ".repeat(MAX_RECALL_STORE_BYTES)).size,
    ).toBe(0);
    expect(parse).not.toHaveBeenCalled();
    parse.mockRestore();
  });

  test("rejects an oversized entry without mutating the store", () => {
    const store: RecallStore = new Map();
    expect(() =>
      addRecallStoreEntry(store, "oversized", {
        toolUseId: "tool",
        input: { query: "oversized" },
        position: 0,
        result: "x".repeat(MAX_RECALL_STORE_BYTES),
        anchorContextId: "7".repeat(64),
      }),
    ).toThrow("recall store capacity exceeded");
    expect(store.size).toBe(0);
  });

  test.each([
    [
      "anchor key does not match value",
      "123e4567-e89b-42d3-a456-426614174001",
      "123e4567-e89b-42d3-a456-426614174002",
      0,
      undefined,
    ],
    ["non-canonical anchor", "not-a-uuid", "not-a-uuid", 0, undefined],
    [
      "invalid context hash",
      "123e4567-e89b-42d3-a456-426614174001",
      "123e4567-e89b-42d3-a456-426614174001",
      0,
      "xyz",
    ],
    [
      "unsafe position",
      "123e4567-e89b-42d3-a456-426614174001",
      "123e4567-e89b-42d3-a456-426614174001",
      Number.MAX_SAFE_INTEGER + 1,
      undefined,
    ],
  ])(
    "rejects canonical anchor record with %s",
    (_name, keyId, anchorId, position, anchorContextId) => {
      const restored = deserializeRecallStore(
        JSON.stringify([
          [
            `anchor:${keyId}`,
            {
              toolUseId: "call_recall",
              anchorId,
              anchorContextId,
              input: { query: "architecture", scope: "all" },
              position,
              result: "results",
            },
          ],
        ]),
      );
      expect(restored.size).toBe(0);
    },
  );
});

describe("isRecallMarker", () => {
  test("detects search markers", () => {
    expect(isRecallMarker('📚 Searching all archives for "test query"…')).toBe(
      true,
    );
    expect(isRecallMarker('📚 Searching session history for "auth"…')).toBe(
      true,
    );
    expect(isRecallMarker('📚 Searching project archives for "config"…')).toBe(
      true,
    );
    expect(isRecallMarker('📚 Searching knowledge base for "patterns"…')).toBe(
      true,
    );
  });

  test("detects id-based detail markers", () => {
    expect(isRecallMarker("📚 Fetching detail for k:abc123…")).toBe(true);
    expect(isRecallMarker("📚 Fetching detail for d:019abc…")).toBe(true);
  });

  test("rejects non-marker text", () => {
    expect(isRecallMarker("hello world")).toBe(false);
    expect(isRecallMarker("[Searching memory...]")).toBe(false);
    expect(isRecallMarker("")).toBe(false);
    expect(isRecallMarker("📚 Some other text")).toBe(false);
  });
});

describe("recallStoreKey", () => {
  test("creates key from query and scope", () => {
    expect(recallStoreKey("test", "all")).toBe("all:test");
    expect(recallStoreKey("test", "session")).toBe("session:test");
  });

  test("defaults scope to all", () => {
    expect(recallStoreKey("test")).toBe("all:test");
  });
});

// ---------------------------------------------------------------------------
// buildRecallFollowUpRequest
// ---------------------------------------------------------------------------

describe("buildRecallFollowUpRequest", () => {
  test("builds correct follow-up request structure with tool_use/tool_result", () => {
    const req = makeRequest(
      [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      [
        { name: "Read", description: "Read", inputSchema: {} },
        { name: "recall", description: "Recall", inputSchema: {} },
      ],
    );

    const recallBlock = makeRecallToolUse("find config");
    const resp = makeResponse(
      [{ type: "text", text: "Let me search." }, recallBlock],
      "tool_use",
    );

    const followUp = buildRecallFollowUpRequest(
      req,
      resp,
      "## Recall Results\n* config is in /root",
      recallBlock,
      /* stream */ false,
    );

    // Original messages + assistant (tool_use) + user (tool_result)
    expect(followUp.messages).toHaveLength(3);
    expect(followUp.messages[0].role).toBe("user");
    expect(followUp.messages[1].role).toBe("assistant");
    expect(followUp.messages[2].role).toBe("user");

    // Assistant message contains the tool_use block (not marker text)
    expect(followUp.messages[1].content).toHaveLength(1);
    expect(followUp.messages[1].content[0].type).toBe("tool_use");
    const toolUse = followUp.messages[1].content[0] as GatewayToolUseBlock;
    expect(toolUse.name).toBe(RECALL_TOOL_NAME);
    expect(toolUse.id).toBe(recallBlock.id);
    expect(toolUse.input).toEqual(recallBlock.input);

    // User message contains recall results as tool_result
    const resultBlock = followUp.messages[2].content[0];
    expect(resultBlock.type).toBe("tool_result");
    expect(
      (resultBlock as { content: Array<{ type: string; text?: string }> })
        .content,
    ).toEqual([
      { type: "text", text: "## Recall Results\n* config is in /root" },
    ]);
    expect((resultBlock as { toolUseId: string }).toolUseId).toBe(
      recallBlock.id,
    );
    expect((resultBlock as { toolName?: string }).toolName).toBe(
      RECALL_TOOL_NAME,
    );

    // Tools list keeps recall — the continuation is recall-aware and
    // can handle further recall calls (multi-turn recall).
    expect(followUp.tools).toHaveLength(2);
    expect(followUp.tools.map((t) => t.name).sort()).toEqual([
      "Read",
      "recall",
    ]);
  });

  test("keeps distinct provider id/name on a generated follow-up result", () => {
    const call: GatewayToolUseBlock = {
      type: "tool_use",
      id: "call-1",
      name: "lookup",
      input: { query: "x" },
    };
    const followUp = buildRecallFollowUpRequest(
      makeRequest(),
      makeResponse([call], "tool_use"),
      '{"value":1}',
      call,
      false,
    );
    expect(followUp.messages.at(-1)?.content[0]).toMatchObject({
      type: "tool_result",
      toolUseId: "call-1",
      toolName: "lookup",
    });
  });

  test("preserves other request properties", () => {
    const req = makeRequest();
    req.system = "my system prompt";
    req.model = "claude-opus-4";
    req.stream = true; // originalReq.stream is irrelevant — explicit arg wins

    const recallBlock = makeRecallToolUse();
    const resp = makeResponse([recallBlock]);

    const followUp = buildRecallFollowUpRequest(
      req,
      resp,
      "result",
      recallBlock,
      /* stream */ false,
    );

    expect(followUp.system).toBe("my system prompt");
    expect(followUp.model).toBe("claude-opus-4");
    // stream flag comes from the explicit parameter, NOT originalReq.stream
    expect(followUp.stream).toBe(false);
  });

  test("stream flag is set by the explicit parameter (true for SSE)", () => {
    const req = makeRequest();
    req.stream = false; // originalReq says false, but explicit arg overrides

    const recallBlock = makeRecallToolUse();
    const resp = makeResponse([recallBlock]);

    const followUp = buildRecallFollowUpRequest(
      req,
      resp,
      "result",
      recallBlock,
      /* stream */ true,
    );

    // The explicit stream arg wins — this is what the streaming follow-up
    // path needs so parseSSEStream() receives an SSE body.
    expect(followUp.stream).toBe(true);
  });

  test("preserves thinking blocks in assistant message for extended thinking", () => {
    const req = makeRequest(
      [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      [
        { name: "Read", description: "Read", inputSchema: {} },
        { name: "recall", description: "Recall", inputSchema: {} },
      ],
    );

    const recallBlock = makeRecallToolUse("find config");
    const resp = makeResponse(
      [
        {
          type: "thinking",
          thinking: "Let me search for config info...",
          signature: "sig_abc123",
        },
        { type: "text", text: "Let me search." },
        recallBlock,
      ],
      "tool_use",
    );

    const followUp = buildRecallFollowUpRequest(
      req,
      resp,
      "## Recall Results\n* config is in /root",
      recallBlock,
      /* stream */ false,
    );

    // Assistant message should contain thinking block + tool_use
    const assistant = followUp.messages[1];
    expect(assistant.content).toHaveLength(2);
    expect(assistant.content[0].type).toBe("thinking");
    expect((assistant.content[0] as { thinking: string }).thinking).toBe(
      "Let me search for config info...",
    );
    expect((assistant.content[0] as { signature: string }).signature).toBe(
      "sig_abc123",
    );
    expect(assistant.content[1].type).toBe("tool_use");
    expect((assistant.content[1] as GatewayToolUseBlock).name).toBe(
      RECALL_TOOL_NAME,
    );
  });

  test("preserves raw Responses reasoning for a stateless follow-up", () => {
    const req = makeRequest();
    req.protocol = "openai-responses";
    const recallBlock = makeRecallToolUse();
    const resp = makeResponse([recallBlock], "tool_use");
    resp.rawOutputItems = [
      {
        type: "reasoning",
        id: "rs_1",
        encrypted_content: "encrypted",
      },
      {
        type: "item_reference",
        id: "msg_server_only",
      },
      {
        type: "function_call",
        id: "fc_1",
        call_id: recallBlock.id,
        name: "recall",
        arguments: JSON.stringify(recallBlock.input),
      },
    ];

    const followUp = buildRecallFollowUpRequest(
      req,
      resp,
      "result",
      recallBlock,
      true,
    );

    expect(followUp.messages[0].content).toContainEqual({
      type: "opaque",
      responsesItem: true,
      raw: {
        type: "reasoning",
        id: "rs_1",
        encrypted_content: "encrypted",
      },
    });
    expect(followUp.messages[0].content).not.toContainEqual(
      expect.objectContaining({
        type: "opaque",
        raw: expect.objectContaining({ type: "function_call" }),
      }),
    );
    expect(followUp.messages[0].content).not.toContainEqual(
      expect.objectContaining({
        type: "opaque",
        raw: expect.objectContaining({ type: "item_reference" }),
      }),
    );
    const wire = buildOpenAIResponsesUpstreamRequest(
      followUp,
      "https://api.openai.com",
    ).body as { input: Array<Record<string, unknown>> };
    expect(wire.input).toContainEqual({
      type: "reasoning",
      id: "rs_1",
      encrypted_content: "encrypted",
    });
    expect(wire.input).not.toContainEqual(
      expect.objectContaining({ type: "item_reference" }),
    );
  });

  test("excludes text blocks but keeps thinking blocks", () => {
    const req = makeRequest([
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ]);

    const recallBlock = makeRecallToolUse();
    const resp = makeResponse(
      [
        { type: "thinking", thinking: "reasoning...", signature: "sig_1" },
        { type: "text", text: "Some pre-recall text" },
        { type: "text", text: "More text" },
        recallBlock,
      ],
      "tool_use",
    );

    const followUp = buildRecallFollowUpRequest(
      req,
      resp,
      "result",
      recallBlock,
      false,
    );

    const assistant = followUp.messages[1];
    // Only thinking + tool_use — original text blocks excluded
    expect(assistant.content).toHaveLength(2);
    expect(assistant.content[0].type).toBe("thinking");
    expect(assistant.content[1].type).toBe("tool_use");
    expect((assistant.content[1] as GatewayToolUseBlock).name).toBe(
      RECALL_TOOL_NAME,
    );
  });

  test("handles multiple thinking blocks", () => {
    const req = makeRequest([
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ]);

    const recallBlock = makeRecallToolUse();
    const resp = makeResponse(
      [
        { type: "thinking", thinking: "first thought", signature: "sig_1" },
        { type: "thinking", thinking: "second thought", signature: "sig_2" },
        recallBlock,
      ],
      "tool_use",
    );

    const followUp = buildRecallFollowUpRequest(
      req,
      resp,
      "result",
      recallBlock,
      false,
    );

    const assistant = followUp.messages[1];
    expect(assistant.content).toHaveLength(3);
    expect(assistant.content[0].type).toBe("thinking");
    expect(assistant.content[1].type).toBe("thinking");
    expect(assistant.content[2].type).toBe("tool_use");
    expect((assistant.content[2] as GatewayToolUseBlock).name).toBe(
      RECALL_TOOL_NAME,
    );
  });

  test("works without thinking blocks (non-thinking model)", () => {
    const req = makeRequest([
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ]);

    const recallBlock = makeRecallToolUse();
    const resp = makeResponse(
      [{ type: "text", text: "Let me search." }, recallBlock],
      "tool_use",
    );

    const followUp = buildRecallFollowUpRequest(
      req,
      resp,
      "result",
      recallBlock,
      false,
    );

    const assistant = followUp.messages[1];
    // No thinking blocks — just the tool_use
    expect(assistant.content).toHaveLength(1);
    expect(assistant.content[0].type).toBe("tool_use");
    expect((assistant.content[0] as GatewayToolUseBlock).name).toBe(
      RECALL_TOOL_NAME,
    );
  });

  test("uses '[No results found.]' for empty recall result", () => {
    const req = makeRequest([
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ]);

    const recallBlock = makeRecallToolUse();
    const resp = makeResponse([recallBlock], "tool_use");

    const followUp = buildRecallFollowUpRequest(
      req,
      resp,
      "",
      recallBlock,
      false,
    );

    const resultBlock = followUp.messages[2].content[0];
    expect(resultBlock.type).toBe("tool_result");
    expect(
      (resultBlock as { content: Array<{ type: string; text?: string }> })
        .content,
    ).toEqual([{ type: "text", text: "[No results found.]" }]);
    expect((resultBlock as { toolUseId: string }).toolUseId).toBe(
      recallBlock.id,
    );
  });
});

// ---------------------------------------------------------------------------
// runRecallFollowUpStreaming / runRecallFollowUpJSON — coupled helpers
// ---------------------------------------------------------------------------

describe("runRecallFollowUpStreaming", () => {
  const recallBlock = makeRecallToolUse("test query");
  const resp = makeResponse([recallBlock], "tool_use");

  function makeSseResponse(): Response {
    return new Response("data: test\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }

  test("sends stream:true and returns the SSE reader", async () => {
    let capturedReq: GatewayRequest | null = null;
    const ctx: RecallFollowUpCtx = {
      forward: async (r) => {
        capturedReq = r;
        return { response: makeSseResponse(), effectiveProtocol: "anthropic" };
      },
      parseJSON: () => {
        throw new Error("should not be called");
      },
    };

    const result = await runRecallFollowUpStreaming(
      ctx,
      makeRequest(),
      resp,
      "recall results",
      recallBlock,
    );

    expect(capturedReq).not.toBeNull();
    const req = capturedReq as unknown as GatewayRequest;
    expect(req.stream).toBe(true);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.reader).toBeDefined();
      expect(result.followUp).toBeDefined();
      void result.reader.cancel(); // cleanup
    }
  });

  test("passes one abort signal through follow-up forwarding", async () => {
    const controller = new AbortController();
    let forwardedSignal: AbortSignal | undefined;
    const ctx: RecallFollowUpCtx = {
      forward: async (_request, signal) => {
        forwardedSignal = signal;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      },
      parseJSON: () => {
        throw new Error("should not be called");
      },
    };

    const pending = runRecallFollowUpStreaming(
      ctx,
      makeRequest(),
      resp,
      "recall results",
      recallBlock,
      controller.signal,
    );
    controller.abort(new DOMException("client disconnected", "AbortError"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(forwardedSignal).toBe(controller.signal);
  });

  test("settles on abort when follow-up setup ignores its signal", async () => {
    const controller = new AbortController();
    const ctx: RecallFollowUpCtx = {
      forward: () => new Promise(() => {}),
      parseJSON: () => {
        throw new Error("should not be called");
      },
    };
    const pending = runRecallFollowUpStreaming(
      ctx,
      makeRequest(),
      resp,
      "recall results",
      recallBlock,
      controller.signal,
    );
    controller.abort(new DOMException("client disconnected", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  test.each(["abort", "timeout"] as const)(
    "%s cancels both branches of a pending SSE content probe without awaiting hostile cancellation",
    async (mode) => {
      if (mode === "timeout") vi.useFakeTimers();
      const caller = new AbortController();
      let sourceCancelled = false;
      const response = new Response(
        new ReadableStream<Uint8Array>({
          pull() {
            return new Promise(() => {});
          },
          cancel() {
            sourceCancelled = true;
            return new Promise<void>(() => {});
          },
        }),
      );
      const pending = runRecallFollowUpStreaming(
        {
          forward: async () => ({
            response,
            effectiveProtocol: "openai-responses",
          }),
          parseJSON: () => Promise.reject(new Error("should not be called")),
        },
        makeRequest(),
        resp,
        "recall results",
        recallBlock,
        mode === "abort" ? caller.signal : undefined,
      );
      await Promise.resolve();
      const rejected = expect(pending).rejects.toMatchObject({
        name: mode === "abort" ? "AbortError" : "TimeoutError",
      });
      if (mode === "abort") {
        caller.abort(new DOMException("client disconnected", "AbortError"));
      } else {
        await vi.advanceTimersByTimeAsync(10_000);
      }
      await rejected;
      await Promise.resolve();
      expect(sourceCancelled).toBe(true);
      if (mode === "timeout") vi.useRealTimers();
    },
  );

  test("cancellation interrupts a stalled non-OK response body", async () => {
    const controller = new AbortController();
    let bodyCancelled = false;
    const ctx: RecallFollowUpCtx = {
      forward: async () => ({
        response: new Response(
          new ReadableStream<Uint8Array>({
            pull() {
              return new Promise(() => {});
            },
            cancel() {
              bodyCancelled = true;
            },
          }),
          { status: 500 },
        ),
        effectiveProtocol: "openai-responses",
      }),
      parseJSON: () => {
        throw new Error("should not be called");
      },
    };
    const pending = runRecallFollowUpStreaming(
      ctx,
      makeRequest(),
      resp,
      "recall results",
      recallBlock,
      controller.signal,
    );
    await Promise.resolve();
    controller.abort(new DOMException("client disconnected", "AbortError"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(bodyCancelled).toBe(true);
  });

  test("accepts headerless SSE and preserves the stream body", async () => {
    const body =
      'event: response.created\ndata: {"type":"response.created"}\n\n';
    const ctx: RecallFollowUpCtx = {
      forward: async () => ({
        response: new Response(body, { status: 200 }),
        effectiveProtocol: "openai-responses",
      }),
      parseJSON: () => {
        throw new Error("should not be called");
      },
    };

    const result = await runRecallFollowUpStreaming(
      ctx,
      makeRequest(),
      resp,
      "recall results",
      recallBlock,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      const response = new Response(
        new ReadableStream({
          async start(controller) {
            for (;;) {
              const { done, value } = await result.reader.read();
              if (done) break;
              controller.enqueue(value);
            }
            controller.close();
          },
        }),
      );
      expect(await response.text()).toBe(body);
    }
  });

  test("accepts headerless SSE after a leading comment frame", async () => {
    const body =
      ': keepalive\n\nevent: response.created\ndata: {"type":"response.created"}\n\n';
    const ctx: RecallFollowUpCtx = {
      forward: async () => ({
        response: new Response(body, { status: 200 }),
        effectiveProtocol: "openai-responses",
      }),
      parseJSON: () => {
        throw new Error("should not be called");
      },
    };

    const result = await runRecallFollowUpStreaming(
      ctx,
      makeRequest(),
      resp,
      "recall results",
      recallBlock,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      const chunks: Uint8Array[] = [];
      for (;;) {
        const { done, value } = await result.reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
      expect(new TextDecoder().decode(Buffer.concat(chunks))).toBe(body);
    }
  });

  test("rejects headerless JSON after body sniffing", async () => {
    const ctx: RecallFollowUpCtx = {
      forward: async () => ({
        response: new Response('{"type":"message"}', { status: 200 }),
        effectiveProtocol: "openai-responses",
      }),
      parseJSON: () => {
        throw new Error("should not be called");
      },
    };

    await expect(
      runRecallFollowUpStreaming(
        ctx,
        makeRequest(),
        resp,
        "recall results",
        recallBlock,
      ),
    ).rejects.toThrow("a non-SSE body");
  });

  test("returns error when upstream responds with non-OK status", async () => {
    const ctx: RecallFollowUpCtx = {
      forward: async () => ({
        response: new Response("bad request", {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
        effectiveProtocol: "anthropic",
      }),
      parseJSON: () => {
        throw new Error("should not be called");
      },
    };

    const result = await runRecallFollowUpStreaming(
      ctx,
      makeRequest(),
      resp,
      "recall results",
      recallBlock,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.detail).toBe("bad request");
    }
  });

  test("throws on content-type mismatch (JSON instead of SSE) — #511 regression guard", async () => {
    // This is the exact failure shape from #511: the follow-up returns JSON
    // instead of SSE. Without the assertSSEResponse guard, parseSSEStream
    // would silently yield zero events and the client would see dead air.
    const ctx: RecallFollowUpCtx = {
      forward: async () => ({
        response: new Response(JSON.stringify({ type: "message" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
        effectiveProtocol: "anthropic",
      }),
      parseJSON: () => {
        throw new Error("should not be called");
      },
    };

    await expect(
      runRecallFollowUpStreaming(
        ctx,
        makeRequest(),
        resp,
        "recall results",
        recallBlock,
      ),
    ).rejects.toThrow("recall follow-up expected SSE");
  });
});

describe("runRecallFollowUpJSON", () => {
  const recallBlock = makeRecallToolUse("test query");
  const resp = makeResponse([recallBlock], "tool_use");

  test("sends stream:false and returns parsed continuation", async () => {
    let capturedReq: GatewayRequest | null = null;
    const fakeGatewayResponse: GatewayResponse = makeResponse(
      [{ type: "text", text: "Here is the answer." }],
      "end_turn",
    );
    const ctx: RecallFollowUpCtx = {
      forward: async (r) => {
        capturedReq = r;
        return {
          response: new Response(JSON.stringify({}), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
          effectiveProtocol: "anthropic",
        };
      },
      parseJSON: async () => fakeGatewayResponse,
    };

    const result = await runRecallFollowUpJSON(
      ctx,
      makeRequest(),
      resp,
      "recall results",
      recallBlock,
    );

    expect(capturedReq).not.toBeNull();
    const req = capturedReq as unknown as GatewayRequest;
    expect(req.stream).toBe(false);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.continuation).toBe(fakeGatewayResponse);
      expect(result.followUp).toBeDefined();
    }
  });

  test("returns error when upstream responds with non-OK status", async () => {
    const ctx: RecallFollowUpCtx = {
      forward: async () => ({
        response: new Response("server error", {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
        effectiveProtocol: "anthropic",
      }),
      parseJSON: () => {
        throw new Error("should not be called");
      },
    };

    const result = await runRecallFollowUpJSON(
      ctx,
      makeRequest(),
      resp,
      "recall results",
      recallBlock,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(500);
      expect(result.detail).toBe("server error");
    }
  });

  test("throws on content-type mismatch (SSE instead of JSON)", async () => {
    const ctx: RecallFollowUpCtx = {
      forward: async () => ({
        response: new Response("data: test\n\n", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
        effectiveProtocol: "anthropic",
      }),
      parseJSON: () => {
        throw new Error("should not be called after assert");
      },
    };

    await expect(
      runRecallFollowUpJSON(
        ctx,
        makeRequest(),
        resp,
        "recall results",
        recallBlock,
      ),
    ).rejects.toThrow("recall follow-up expected JSON but got SSE");
  });

  test("abort settles when JSON follow-up setup ignores its signal", async () => {
    const controller = new AbortController();
    const pending = runRecallFollowUpJSON(
      {
        forward: () => new Promise(() => {}),
        parseJSON: () => Promise.reject(new Error("should not be called")),
      },
      makeRequest(),
      resp,
      "recall results",
      recallBlock,
      controller.signal,
    );
    controller.abort(new DOMException("client disconnected", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  test("abort settles and cancels the body when JSON parsing ignores its signal", async () => {
    const controller = new AbortController();
    let bodyCancelled = false;
    let markParsing!: () => void;
    const parsing = new Promise<void>((resolve) => (markParsing = resolve));
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          bodyCancelled = true;
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
    const pending = runRecallFollowUpJSON(
      {
        forward: async () => ({ response, effectiveProtocol: "anthropic" }),
        parseJSON: () => {
          markParsing();
          return new Promise(() => {});
        },
      },
      makeRequest(),
      resp,
      "recall results",
      recallBlock,
      controller.signal,
    );
    await parsing;
    controller.abort(new DOMException("client disconnected", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(bodyCancelled).toBe(true);
  });
});

describe("runRecallFollowUpStreamAccumulated", () => {
  const recallBlock = makeRecallToolUse("test query");
  const resp = makeResponse([recallBlock], "tool_use");

  function makeSseResponse(): Response {
    return new Response("data: test\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }

  test("sends stream:true and returns the SSE-accumulated continuation", async () => {
    let capturedReq: GatewayRequest | null = null;
    const fakeGatewayResponse: GatewayResponse = makeResponse(
      [{ type: "text", text: "Here is the answer." }],
      "end_turn",
    );
    const ctx: RecallFollowUpCtx = {
      forward: async (r) => {
        capturedReq = r;
        return { response: makeSseResponse(), effectiveProtocol: "openai" };
      },
      parseJSON: () => {
        throw new Error("should not be called");
      },
      parseSSE: async () => fakeGatewayResponse,
    };

    const result = await runRecallFollowUpStreamAccumulated(
      ctx,
      makeRequest(),
      resp,
      "recall results",
      recallBlock,
    );

    expect(capturedReq).not.toBeNull();
    const req = capturedReq as unknown as GatewayRequest;
    expect(req.stream).toBe(true);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.continuation).toBe(fakeGatewayResponse);
      expect(result.followUp).toBeDefined();
    }
  });

  test("returns error when upstream responds with non-OK status", async () => {
    const ctx: RecallFollowUpCtx = {
      forward: async () => ({
        response: new Response("server error", {
          status: 502,
          headers: { "content-type": "application/json" },
        }),
        effectiveProtocol: "openai",
      }),
      parseJSON: () => {
        throw new Error("should not be called");
      },
      parseSSE: () => {
        throw new Error("should not be called on non-OK");
      },
    };

    const result = await runRecallFollowUpStreamAccumulated(
      ctx,
      makeRequest(),
      resp,
      "recall results",
      recallBlock,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(502);
      expect(result.detail).toBe("server error");
    }
  });

  test("throws on content-type mismatch (JSON instead of SSE)", async () => {
    // Mirror of the streaming guard: if the upstream returns JSON instead of
    // SSE, the accumulator would silently yield zero events. assertSSEResponse
    // converts that into a loud, greppable error before parseSSE is reached.
    let parseSSECalled = false;
    const ctx: RecallFollowUpCtx = {
      forward: async () => ({
        response: new Response(JSON.stringify({ type: "message" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
        effectiveProtocol: "openai",
      }),
      parseJSON: () => {
        throw new Error("should not be called");
      },
      parseSSE: async () => {
        parseSSECalled = true;
        return makeResponse([], "end_turn");
      },
    };

    await expect(
      runRecallFollowUpStreamAccumulated(
        ctx,
        makeRequest(),
        resp,
        "recall results",
        recallBlock,
      ),
    ).rejects.toThrow("recall follow-up expected SSE");
    expect(parseSSECalled).toBe(false);
  });

  test("throws when ctx.parseSSE is not provided", async () => {
    let forwardCalled = false;
    const ctx: RecallFollowUpCtx = {
      forward: async () => {
        forwardCalled = true;
        return { response: makeSseResponse(), effectiveProtocol: "openai" };
      },
      parseJSON: () => {
        throw new Error("should not be called");
      },
      // parseSSE intentionally omitted
    };

    await expect(
      runRecallFollowUpStreamAccumulated(
        ctx,
        makeRequest(),
        resp,
        "recall results",
        recallBlock,
      ),
    ).rejects.toThrow("requires ctx.parseSSE");
    // Must fail fast before forwarding — never send an unaccumulatable request.
    expect(forwardCalled).toBe(false);
  });

  test("abort settles and cancels the body when SSE accumulation ignores its signal", async () => {
    const controller = new AbortController();
    let bodyCancelled = false;
    let markParsing!: () => void;
    const parsing = new Promise<void>((resolve) => (markParsing = resolve));
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(streamController) {
          streamController.enqueue(new TextEncoder().encode("data: test\n\n"));
        },
        cancel() {
          bodyCancelled = true;
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
    const pending = runRecallFollowUpStreamAccumulated(
      {
        forward: async () => ({ response, effectiveProtocol: "openai" }),
        parseJSON: () => Promise.reject(new Error("should not be called")),
        parseSSE: () => {
          markParsing();
          return new Promise(() => {});
        },
      },
      makeRequest(),
      resp,
      "recall results",
      recallBlock,
      controller.signal,
    );
    await parsing;
    controller.abort(new DOMException("client disconnected", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(bodyCancelled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// expandRecallMarkers
// ---------------------------------------------------------------------------

describe("expandRecallMarkers", () => {
  test("expands a hidden Responses anchor without a visible status message", () => {
    const anchorId = "123e4567-e89b-42d3-a456-426614174001";
    const store: RecallStore = new Map([
      [
        `anchor:${anchorId}`,
        makeStoredRecall({
          toolUseId: "call_recall",
          anchorId,
          input: { query: "original request", scope: "session" },
          result: "The original request was to compare hosting options.",
          companionToolUseIds: ["call_read"],
        }),
      ],
    ]);
    const req = makeRequest([
      { role: "user", content: [{ type: "text", text: "continue" }] },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: buildRecallAnchor(anchorId),
          },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_read", name: "read", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "call_read",
            content: [{ type: "text", text: "file" }],
          },
        ],
      },
    ]);
    bindCanonicalAnchors(req, store);

    expect(expandRecallMarkers(req, store)).toBe(true);
    expect(req.messages[1].content[0]).toMatchObject({
      type: "tool_use",
      id: "call_recall",
      name: "recall",
    });
    expect(req.messages[2].content[0]).toMatchObject({
      type: "tool_result",
      toolUseId: "call_recall",
    });
    expect(JSON.stringify(req.messages)).not.toContain("Searching");
  });

  test("rejoins a companion tool that precedes the hidden recall", () => {
    const anchorId = "123e4567-e89b-42d3-a456-426614174002";
    const store: RecallStore = new Map([
      [
        `anchor:${anchorId}`,
        makeStoredRecall({
          toolUseId: "call_recall",
          anchorId,
          companionToolUses: [
            {
              id: "call_read",
              name: "read",
              input: {},
              side: "before",
            },
          ],
        }),
      ],
    ]);
    const req = makeRequest([
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_read", name: "read", input: {} },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: buildRecallAnchor(anchorId) }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "call_read",
            content: [{ type: "text", text: "file" }],
          },
        ],
      },
    ]);
    bindCanonicalAnchors(req, store);

    expect(expandRecallMarkers(req, store)).toBe(true);
    expect(req.messages.map((message) => message.role)).toEqual([
      "assistant",
      "user",
    ]);
    expect(req.messages[0].content.map((block) => block.type)).toEqual([
      "tool_use",
      "tool_use",
    ]);
    expect(
      req.messages[1].content.map((block) =>
        block.type === "tool_result" ? block.toolUseId : "",
      ),
    ).toEqual(["call_read", "call_recall"]);
  });

  test("moves a companion in visible and Responses provenance exactly once", () => {
    const anchorId = "123e4567-e89b-42d3-a456-426614174098";
    const reasoning = {
      type: "opaque" as const,
      responsesItem: true,
      raw: {
        type: "reasoning",
        id: "rs_companion",
        encrypted_content: "encrypted",
      },
    };
    const read = {
      type: "tool_use" as const,
      id: "call_read",
      name: "read",
      input: {},
    };
    const store: RecallStore = new Map([
      [
        `anchor:${anchorId}`,
        makeStoredRecall({
          toolUseId: "call_recall",
          anchorId,
          companionToolUses: [
            { id: "call_read", name: "read", input: {}, side: "before" },
          ],
        }),
      ],
    ]);
    const req = makeRequest([
      {
        role: "assistant",
        content: [read],
        provenanceContent: [reasoning, read],
        provenancePositions: [1],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: buildRecallAnchor(anchorId) }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "call_read",
            content: [{ type: "text", text: "file" }],
          },
        ],
      },
    ]);
    bindCanonicalAnchors(req, store);

    expect(expandRecallMarkers(req, store)).toBe(true);
    const body = buildOpenAIResponsesUpstreamRequest(
      { ...req, protocol: "openai-responses", model: "gpt-5.6" },
      "https://api.openai.com",
    ).body as { input: Array<Record<string, unknown>> };
    expect(body.input.filter((item) => item.type === "reasoning")).toEqual([
      reasoning.raw,
    ]);
    expect(
      body.input.filter(
        (item) => item.type === "function_call" && item.call_id === "call_read",
      ),
    ).toHaveLength(1);
    expect(
      body.input
        .filter((item) => item.type === "function_call")
        .map((item) => item.call_id),
    ).toEqual(["call_read", "call_recall"]);
  });

  test("preserves hidden provenance between multiple moved companions", () => {
    const anchorId = "123e4567-e89b-42d3-a456-426614174097";
    const read = {
      type: "tool_use" as const,
      id: "call_read",
      name: "read",
      input: {},
    };
    const write = {
      type: "tool_use" as const,
      id: "call_write",
      name: "write",
      input: {},
    };
    const reasoning = {
      type: "opaque" as const,
      responsesItem: true,
      raw: {
        type: "reasoning",
        id: "rs_between_companions",
        encrypted_content: "encrypted",
      },
    };
    const store: RecallStore = new Map([
      [
        `anchor:${anchorId}`,
        makeStoredRecall({
          toolUseId: "call_recall",
          anchorId,
          companionToolUses: [
            { id: "call_read", name: "read", input: {}, side: "before" },
            { id: "call_write", name: "write", input: {}, side: "before" },
          ],
        }),
      ],
    ]);
    const req = makeRequest([
      {
        role: "assistant",
        content: [read, write],
        provenanceContent: [read, reasoning, write],
        provenancePositions: [0, 2],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: buildRecallAnchor(anchorId) }],
      },
    ]);
    bindCanonicalAnchors(req, store);

    expect(expandRecallMarkers(req, store)).toBe(true);
    const body = buildOpenAIResponsesUpstreamRequest(
      { ...req, protocol: "openai-responses", model: "gpt-5.6" },
      "https://api.openai.com",
    ).body as { input: Array<Record<string, unknown>> };
    expect(body.input.filter((item) => item.type === "reasoning")).toEqual([
      reasoning.raw,
    ]);
    expect(
      body.input.map((item) =>
        item.type === "function_call" ? item.call_id : item.type,
      ),
    ).toEqual([
      "call_read",
      "reasoning",
      "call_write",
      "call_recall",
      "function_call_output",
    ]);
  });

  test("preserves complete provenance order for following companions", () => {
    const anchorId = "123e4567-e89b-42d3-a456-426614174096";
    const read = {
      type: "tool_use" as const,
      id: "call_read",
      name: "read",
      input: {},
    };
    const write = {
      type: "tool_use" as const,
      id: "call_write",
      name: "write",
      input: {},
    };
    const reasoning = {
      type: "opaque" as const,
      responsesItem: true,
      raw: {
        type: "reasoning",
        id: "rs_after_companions",
        encrypted_content: "encrypted",
      },
    };
    const store: RecallStore = new Map([
      [
        `anchor:${anchorId}`,
        makeStoredRecall({
          toolUseId: "call_recall",
          anchorId,
          companionToolUses: [
            { id: "call_read", name: "read", input: {}, side: "after" },
            { id: "call_write", name: "write", input: {}, side: "after" },
          ],
        }),
      ],
    ]);
    const req = makeRequest([
      {
        role: "assistant",
        content: [{ type: "text", text: buildRecallAnchor(anchorId) }],
      },
      {
        role: "assistant",
        content: [read, write],
        provenanceContent: [read, reasoning, write],
        provenancePositions: [0, 2],
      },
    ]);
    bindCanonicalAnchors(req, store);

    expect(expandRecallMarkers(req, store)).toBe(true);
    const body = buildOpenAIResponsesUpstreamRequest(
      { ...req, protocol: "openai-responses", model: "gpt-5.6" },
      "https://api.openai.com",
    ).body as { input: Array<Record<string, unknown>> };
    expect(
      body.input.map((item) =>
        item.type === "function_call" ? item.call_id : item.type,
      ),
    ).toEqual([
      "call_recall",
      "call_read",
      "reasoning",
      "call_write",
      "function_call_output",
    ]);
  });

  test("rejoins an Anthropic companion suffix while preserving its preamble", () => {
    const anchorId = "123e4567-e89b-42d3-a456-426614174011";
    const user = {
      role: "user" as const,
      content: [{ type: "text" as const, text: "inspect memory" }],
    };
    const originalAssistant = {
      role: "assistant" as const,
      content: [
        { type: "text" as const, text: "I will search and read." },
        {
          type: "tool_use" as const,
          id: "call_read",
          name: "read",
          input: { file: "notes.md" },
        },
        { type: "text" as const, text: "Waiting for both results." },
      ],
    };
    const store: RecallStore = new Map([
      [
        `anchor:${anchorId}`,
        makeStoredRecall({
          toolUseId: "call_recall",
          anchorId,
          anchorContextId: recallAnchorContext([user, originalAssistant]),
          companionToolUses: [
            {
              id: "call_read",
              name: "read",
              input: { file: "notes.md" },
              side: "before",
            },
          ],
        }),
      ],
    ]);
    const req = makeRequest([
      user,
      originalAssistant,
      {
        role: "assistant",
        content: [{ type: "text", text: buildRecallAnchor(anchorId) }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "call_read",
            content: [{ type: "text", text: "notes" }],
          },
        ],
      },
    ]);
    bindCanonicalAnchors(req, store);

    expect(expandRecallMarkers(req, store)).toBe(true);
    expect(req.messages[1].content).toEqual([
      { type: "text", text: "I will search and read." },
      { type: "text", text: "Waiting for both results." },
    ]);
    expect(req.messages[2].content.map((block) => block.type)).toEqual([
      "tool_use",
      "tool_use",
    ]);
    expect(
      req.messages[3].content.map((block) =>
        block.type === "tool_result" ? block.toolUseId : "",
      ),
    ).toEqual(["call_read", "call_recall"]);
  });

  test("replays repeated identical recalls through distinct anchor keys", () => {
    const firstAnchor = "123e4567-e89b-42d3-a456-426614174003";
    const secondAnchor = "123e4567-e89b-42d3-a456-426614174004";
    const store: RecallStore = new Map([
      [
        `anchor:${firstAnchor}`,
        makeStoredRecall({ toolUseId: "call_1", result: "first" }),
      ],
      [
        `anchor:${secondAnchor}`,
        makeStoredRecall({ toolUseId: "call_2", result: "second" }),
      ],
    ]);
    const req = makeRequest([
      { role: "user", content: [{ type: "text", text: "start" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: buildRecallAnchor(firstAnchor) }],
      },
      { role: "user", content: [{ type: "text", text: "next" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: buildRecallAnchor(secondAnchor) }],
      },
    ]);
    bindCanonicalAnchors(req, store);

    expect(expandRecallMarkers(req, store)).toBe(true);
    expect(JSON.stringify(req.messages)).toContain("first");
    expect(JSON.stringify(req.messages)).toContain("second");
  });

  test("validates every anchor against the immutable incoming transcript", () => {
    const firstAnchor = "123e4567-e89b-42d3-a456-426614174012";
    const secondAnchor = "123e4567-e89b-42d3-a456-426614174013";
    const user = {
      role: "user" as const,
      content: [{ type: "text" as const, text: "start" }],
    };
    const firstAssistant = {
      role: "assistant" as const,
      content: [
        { type: "text" as const, text: buildRecallAnchor(firstAnchor) },
      ],
    };
    const nextUser = {
      role: "user" as const,
      content: [{ type: "text" as const, text: "continue" }],
    };
    const store: RecallStore = new Map([
      [
        `anchor:${firstAnchor}`,
        makeStoredRecall({
          toolUseId: "call_1",
          result: "first",
          anchorId: firstAnchor,
          anchorContextId: recallAnchorContext([user]),
        }),
      ],
      [
        `anchor:${secondAnchor}`,
        makeStoredRecall({
          toolUseId: "call_2",
          result: "second",
          anchorId: secondAnchor,
          anchorContextId: recallAnchorContext([
            user,
            firstAssistant,
            nextUser,
          ]),
        }),
      ],
    ]);
    const req = makeRequest([
      user,
      firstAssistant,
      nextUser,
      {
        role: "assistant",
        content: [{ type: "text", text: buildRecallAnchor(secondAnchor) }],
      },
    ]);
    bindCanonicalAnchors(req, store);

    expect(expandRecallMarkers(req, store)).toBe(true);
    expect(JSON.stringify(req.messages)).toContain("first");
    expect(JSON.stringify(req.messages)).toContain("second");
    expect(JSON.stringify(req.messages)).not.toContain("lore-recall");
  });

  test("keeps a recall continuation tool in a later assistant turn", () => {
    const toolUseId = "call_recall";
    const anchorId = "123e4567-e89b-42d3-a456-426614174005";
    const store: RecallStore = new Map([
      [
        `anchor:${anchorId}`,
        makeStoredRecall({
          toolUseId,
          anchorId,
          input: { query: "architecture", scope: "all" },
          result: "architecture results",
        }),
      ],
    ]);
    const req = makeRequest([
      { role: "user", content: [{ type: "text", text: "investigate" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: buildRecallAnchor(anchorId) }],
      },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_read", name: "read", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "call_read",
            content: [{ type: "text", text: "file" }],
          },
        ],
      },
    ]);
    bindCanonicalAnchors(req, store);

    expect(expandRecallMarkers(req, store)).toBe(true);
    expect(req.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
    expect(req.messages[2].content[0]).toMatchObject({
      type: "tool_result",
      toolUseId,
    });
    expect(req.messages[3].content[0]).toMatchObject({
      type: "tool_use",
      id: "call_read",
    });
  });

  test("does not expand a copied anchor under a different user turn", () => {
    const anchorId = "123e4567-e89b-42d3-a456-426614174006";
    const originalUser = {
      role: "user" as const,
      content: [{ type: "text" as const, text: "original request" }],
    };
    const store: RecallStore = new Map([
      [
        `anchor:${anchorId}`,
        makeStoredRecall({
          anchorId,
          anchorContextId: recallAnchorContext([originalUser]),
        }),
      ],
    ]);
    const req = makeRequest([
      { role: "user", content: [{ type: "text", text: "attacker turn" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: buildRecallAnchor(anchorId) }],
      },
    ]);

    expect(expandRecallMarkers(req, store)).toBe(false);
    expect(req.messages[1].content[0]).toMatchObject({ type: "text" });
  });

  test("binds an anchor to request-only Responses reasoning provenance", () => {
    const anchorId = "123e4567-e89b-42d3-a456-426614174012";
    const reasoning = (encrypted: string) => ({
      role: "assistant" as const,
      content: [] as GatewayRequest["messages"][number]["content"],
      provenanceContent: [
        {
          type: "opaque" as const,
          raw: {
            type: "reasoning",
            id: "rs_1",
            encrypted_content: encrypted,
          },
        },
      ],
      provenancePositions: [],
    });
    const user = {
      role: "user" as const,
      content: [{ type: "text" as const, text: "continue" }],
    };
    const storedContext = recallAnchorContext([user, reasoning("original")]);
    const makeReplay = (encrypted: string) =>
      makeRequest([
        user,
        reasoning(encrypted),
        {
          role: "assistant",
          content: [{ type: "text", text: buildRecallAnchor(anchorId) }],
        },
      ]);
    const store: RecallStore = new Map([
      [
        `anchor:${anchorId}`,
        makeStoredRecall({ anchorId, anchorContextId: storedContext }),
      ],
    ]);

    const valid = makeReplay("original");
    expect(expandRecallMarkers(valid, store)).toBe(true);

    const changed = makeReplay("changed");
    expect(expandRecallMarkers(changed, store)).toBe(false);
  });

  test("binds an anchor to request-only Responses refusal provenance", () => {
    const anchorId = "123e4567-e89b-42d3-a456-426614174015";
    const refusal = (text: string) => ({
      role: "assistant" as const,
      content: [] as GatewayRequest["messages"][number]["content"],
      provenanceContent: [
        {
          type: "opaque" as const,
          raw: {
            type: "message",
            id: "msg_refusal",
            content: [{ type: "refusal", refusal: text }],
          },
        },
      ],
      provenancePositions: [],
    });
    const user = {
      role: "user" as const,
      content: [{ type: "text" as const, text: "continue" }],
    };
    const store: RecallStore = new Map([
      [
        `anchor:${anchorId}`,
        makeStoredRecall({
          anchorId,
          anchorContextId: recallAnchorContext([user, refusal("original")]),
        }),
      ],
    ]);
    const replay = (text: string) =>
      makeRequest([
        user,
        refusal(text),
        {
          role: "assistant",
          content: [{ type: "text", text: buildRecallAnchor(anchorId) }],
        },
      ]);

    expect(expandRecallMarkers(replay("original"), store)).toBe(true);
    expect(expandRecallMarkers(replay("changed"), store)).toBe(false);
  });

  test("round-trips producer provenance through Lore and parser replay", () => {
    const anchorId = "123e4567-e89b-42d3-a456-426614174016";
    const refusal = {
      type: "message",
      id: "msg_refusal",
      role: "assistant",
      content: [{ type: "refusal", refusal: "cannot comply" }],
    };
    const unknown = {
      type: "computer_screenshot",
      id: "screen_1",
      image_url: "data:image/png;base64,AAA",
    };
    const anchor = buildRecallAnchor(anchorId);
    const producerResponse: GatewayResponse = {
      id: "resp_producer",
      model: "gpt-5.6",
      content: [
        { type: "opaque", raw: refusal, responsesItem: true },
        { type: "opaque", raw: unknown, responsesItem: true },
        { type: "text", text: anchor },
      ],
      rawOutputItems: [refusal, unknown],
      stopReason: "end_turn",
      usage: { inputTokens: 0, outputTokens: 0 },
    };
    const user = {
      role: "user" as const,
      content: [{ type: "text" as const, text: "continue" }],
    };
    const producerProvenance = [
      ...responsesProvenanceContent(producerResponse),
      { type: "text" as const, text: anchor },
    ];
    const producerMessages = [
      user,
      {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: anchor }],
        provenanceContent: producerProvenance,
        provenancePositions: [producerProvenance.length - 1],
      },
    ];
    const anchorContextId = responsesAnchorContext(
      [user],
      [],
      producerResponse,
      "missing-recall-tool",
    );
    const store: RecallStore = new Map([
      [`anchor:${anchorId}`, makeStoredRecall({ anchorId, anchorContextId })],
    ]);

    const lore = gatewayMessagesToLore(producerMessages, "replay-session");
    const provenanceByMessageId = responsesProvenanceByMessageId(
      producerMessages,
      lore,
    );
    resolveToolResults(lore);
    const transformed = loreMessagesToGateway(lore, provenanceByMessageId);
    const wire = buildOpenAIResponsesUpstreamRequest(
      {
        ...makeRequest(transformed),
        protocol: "openai-responses",
        model: "gpt-5.6",
      },
      "https://api.openai.com",
    ).body;
    const replay = parseOpenAIResponsesRequest(wire, {});

    expect(expandRecallMarkers(replay, store)).toBe(true);
    expect(
      loreMessagesToGateway(lore.slice(1), provenanceByMessageId, false)[0]
        .provenanceContent,
    ).toBeUndefined();
    const changedLore = structuredClone(lore);
    const textPart = changedLore[1].parts.find((part) => part.type === "text");
    if (!textPart || !("text" in textPart)) throw new Error("missing anchor");
    textPart.text = "changed";
    expect(
      loreMessagesToGateway(changedLore, provenanceByMessageId)[1]
        .provenanceContent,
    ).toBeUndefined();
  });

  test("does not expand a copied anchor after an identical later user message", () => {
    const anchorId = "123e4567-e89b-42d3-a456-426614174009";
    const original = [
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: "same" }],
      },
    ];
    const store: RecallStore = new Map([
      [
        `anchor:${anchorId}`,
        makeStoredRecall({
          anchorId,
          anchorContextId: recallAnchorContext(original),
        }),
      ],
    ]);
    const req = makeRequest([
      ...original,
      { role: "assistant", content: [{ type: "text", text: "prior answer" }] },
      { role: "user", content: [{ type: "text", text: "same" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: buildRecallAnchor(anchorId) }],
      },
    ]);

    expect(expandRecallMarkers(req, store)).toBe(false);
  });

  test("does not expand an anchor moved within the same assistant turn", () => {
    const anchorId = "123e4567-e89b-42d3-a456-426614174008";
    const prefix = [
      { type: "text" as const, text: "the original preceding text" },
    ];
    const store: RecallStore = new Map([
      [
        `anchor:${anchorId}`,
        makeStoredRecall({
          anchorId,
          anchorContextId: recallAnchorContext([], 0, prefix),
        }),
      ],
    ]);
    const req = makeRequest([
      {
        role: "assistant",
        content: [
          { type: "text", text: buildRecallAnchor(anchorId) },
          ...prefix,
        ],
      },
    ]);

    expect(expandRecallMarkers(req, store)).toBe(false);
  });

  test("does not coalesce a reused companion ID with different tool content", () => {
    const anchorId = "123e4567-e89b-42d3-a456-426614174007";
    const store: RecallStore = new Map([
      [
        `anchor:${anchorId}`,
        makeStoredRecall({
          anchorId,
          companionToolUses: [
            {
              id: "call_reused",
              name: "read",
              input: { file: "original" },
              side: "before",
            },
          ],
        }),
      ],
    ]);
    const req = makeRequest([
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_reused",
            name: "write",
            input: { file: "different" },
          },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: buildRecallAnchor(anchorId) }],
      },
    ]);
    bindCanonicalAnchors(req, store);

    expect(expandRecallMarkers(req, store)).toBe(true);
    expect(req.messages[0].content[0]).toMatchObject({ name: "write" });
    expect(req.messages[1].content[0]).toMatchObject({ name: "recall" });
  });

  test("never expands a canonical anchor without provenance", () => {
    const anchorId = "123e4567-e89b-42d3-a456-426614174014";
    const store: RecallStore = new Map([
      [
        `anchor:${anchorId}`,
        makeStoredRecall({ anchorId, anchorContextId: undefined }),
      ],
    ]);
    const req = makeRequest([
      { role: "user", content: [{ type: "text", text: "start" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: buildRecallAnchor(anchorId) }],
      },
    ]);

    expect(expandRecallMarkers(req, store)).toBe(false);
  });

  test("expands marker in assistant message back to tool_use + tool_result", () => {
    const store: RecallStore = new Map();
    store.set(recallStoreKey("test query", "all"), makeStoredRecall());

    const req = makeRequest([
      { role: "user", content: [{ type: "text", text: "hello" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I'll read the file." },
          { type: "text", text: buildRecallMarker("test query", "all") },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "Read",
            input: { path: "/a" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "toolu_1",
            content: [{ type: "text", text: "file content" }],
          },
        ],
      },
    ]);
    bindReplayEntries(req, store);

    const result = expandRecallMarkers(req, store);

    expect(result).toBe(true);

    // Assistant message should now have recall tool_use replacing the marker
    const assistant = req.messages[1];
    expect(assistant.content).toHaveLength(3);
    expect(assistant.content[1].type).toBe("tool_use");
    expect((assistant.content[1] as GatewayToolUseBlock).name).toBe("recall");

    // User message should have recall tool_result inserted
    const user = req.messages[2];
    expect(user.content).toHaveLength(2);
    expect(user.content[0].type).toBe("tool_result");
    expect((user.content[0] as { toolUseId: string }).toolUseId).toBe(
      "toolu_recall_1",
    );
  });

  test("returns false when no markers found", () => {
    const store: RecallStore = new Map();
    const req = makeRequest([
      { role: "user", content: [{ type: "text", text: "hello" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "just text" }],
      },
    ]);

    expect(expandRecallMarkers(req, store)).toBe(false);
  });

  test("returns false when marker present but no store entry", () => {
    const store: RecallStore = new Map(); // empty
    const req = makeRequest([
      {
        role: "assistant",
        content: [{ type: "text", text: buildRecallMarker("unknown", "all") }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "thanks" }],
      },
    ]);

    expect(expandRecallMarkers(req, store)).toBe(false);
  });

  test("returns false with empty messages", () => {
    const store: RecallStore = new Map();
    store.set(recallStoreKey("test", "all"), makeStoredRecall());
    const req = makeRequest([]);

    expect(expandRecallMarkers(req, store)).toBe(false);
  });

  test("splits assistant message when continuation text follows marker (recall-only)", () => {
    const store: RecallStore = new Map();
    store.set(
      recallStoreKey("arch query", "all"),
      makeStoredRecall({
        toolUseId: "toolu_recall_split",
        input: { query: "arch query", scope: "all" },
        result: "Found: architecture docs",
      }),
    );

    // Simulate recall-only with follow-up: the client sees one assistant
    // message with marker + continuation text from the follow-up.
    const req = makeRequest([
      { role: "user", content: [{ type: "text", text: "tell me about arch" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: buildRecallMarker("arch query", "all") },
          {
            type: "text",
            text: "Based on the architecture docs, here's what I found...",
          },
        ],
      },
      {
        role: "user",
        content: [{ type: "text", text: "thanks, tell me more" }],
      },
    ]);
    bindReplayEntries(req, store);

    const result = expandRecallMarkers(req, store);
    expect(result).toBe(true);

    // Should split into: assistant[tool_use] → user[tool_result] → assistant[continuation] → user[next]
    expect(req.messages).toHaveLength(5);

    // Message 1: assistant with just the tool_use (truncated)
    expect(req.messages[1].role).toBe("assistant");
    expect(req.messages[1].content).toHaveLength(1);
    expect(req.messages[1].content[0].type).toBe("tool_use");
    expect((req.messages[1].content[0] as GatewayToolUseBlock).id).toBe(
      "toolu_recall_split",
    );

    // Message 2: synthetic user with tool_result
    expect(req.messages[2].role).toBe("user");
    expect(req.messages[2].content).toHaveLength(1);
    expect(req.messages[2].content[0].type).toBe("tool_result");
    expect(
      (req.messages[2].content[0] as { toolUseId: string }).toolUseId,
    ).toBe("toolu_recall_split");
    expect(
      (
        req.messages[2].content[0] as {
          content: Array<{ type: string; text?: string }>;
        }
      ).content,
    ).toEqual([{ type: "text", text: "Found: architecture docs" }]);

    // Message 3: continuation assistant message
    expect(req.messages[3].role).toBe("assistant");
    expect(req.messages[3].content).toHaveLength(1);
    expect((req.messages[3].content[0] as { text: string }).text).toBe(
      "Based on the architecture docs, here's what I found...",
    );

    // Message 4: original next user message (unchanged)
    expect(req.messages[4].role).toBe("user");
    expect((req.messages[4].content[0] as { text: string }).text).toBe(
      "thanks, tell me more",
    );
  });

  test("does NOT split when content after marker is only tool_use blocks (mixed tools)", () => {
    const store: RecallStore = new Map();
    store.set(
      recallStoreKey("mixed query", "all"),
      makeStoredRecall({
        toolUseId: "toolu_recall_mixed",
        input: { query: "mixed query", scope: "all" },
      }),
    );

    const req = makeRequest([
      { role: "user", content: [{ type: "text", text: "search and read" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I'll search and read." },
          { type: "text", text: buildRecallMarker("mixed query", "all") },
          {
            type: "tool_use",
            id: "toolu_read_1",
            name: "Read",
            input: { path: "/a" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "toolu_read_1",
            content: [{ type: "text", text: "file content" }],
          },
        ],
      },
    ]);
    bindReplayEntries(req, store);

    const result = expandRecallMarkers(req, store);
    expect(result).toBe(true);

    // Should NOT split — tool_use blocks stay in the same message
    expect(req.messages).toHaveLength(3);

    const assistant = req.messages[1];
    expect(assistant.content).toHaveLength(3); // text + recall tool_use + Read tool_use
    expect(assistant.content[1].type).toBe("tool_use");
    expect((assistant.content[1] as GatewayToolUseBlock).name).toBe("recall");
    expect(assistant.content[2].type).toBe("tool_use");
    expect((assistant.content[2] as GatewayToolUseBlock).name).toBe("Read");

    // User message has recall tool_result prepended
    const user = req.messages[2];
    expect(user.content).toHaveLength(2);
    expect((user.content[0] as { toolUseId: string }).toolUseId).toBe(
      "toolu_recall_mixed",
    );
    expect((user.content[1] as { toolUseId: string }).toolUseId).toBe(
      "toolu_read_1",
    );
  });

  test("expands markers across multiple assistant messages", () => {
    const store: RecallStore = new Map();
    store.set(
      recallStoreKey("query1", "all"),
      makeStoredRecall({
        toolUseId: "toolu_recall_1",
        input: { query: "query1", scope: "all" },
      }),
    );
    store.set(
      recallStoreKey("query2", "session"),
      makeStoredRecall({
        toolUseId: "toolu_recall_2",
        input: { query: "query2", scope: "session" },
      }),
    );

    const req = makeRequest([
      { role: "user", content: [{ type: "text", text: "first" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: buildRecallMarker("query1", "all") }],
      },
      { role: "user", content: [{ type: "text", text: "second" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: buildRecallMarker("query2", "session") },
        ],
      },
      { role: "user", content: [{ type: "text", text: "third" }] },
    ]);
    bindReplayEntries(req, store);

    const result = expandRecallMarkers(req, store);
    expect(result).toBe(true);

    // Both assistant messages should have tool_use blocks
    expect(req.messages[1].content[0].type).toBe("tool_use");
    expect((req.messages[1].content[0] as GatewayToolUseBlock).id).toBe(
      "toolu_recall_1",
    );
    expect(req.messages[3].content[0].type).toBe("tool_use");
    expect((req.messages[3].content[0] as GatewayToolUseBlock).id).toBe(
      "toolu_recall_2",
    );

    // Both following user messages should have tool_results inserted
    expect(req.messages[2].content[0].type).toBe("tool_result");
    expect(
      (req.messages[2].content[0] as { toolUseId: string }).toolUseId,
    ).toBe("toolu_recall_1");
    expect(req.messages[4].content[0].type).toBe("tool_result");
    expect(
      (req.messages[4].content[0] as { toolUseId: string }).toolUseId,
    ).toBe("toolu_recall_2");
  });
});

// ---------------------------------------------------------------------------
// cleanupRecallStore
// ---------------------------------------------------------------------------

describe("cleanupRecallStore", () => {
  test("removes orphaned entries", () => {
    const store: RecallStore = new Map();
    store.set(recallStoreKey("active", "all"), makeStoredRecall());
    store.set(recallStoreKey("orphaned", "all"), makeStoredRecall());

    const req = makeRequest([
      {
        role: "assistant",
        content: [{ type: "text", text: buildRecallMarker("active", "all") }],
      },
      { role: "user", content: [{ type: "text", text: "next" }] },
    ]);
    bindReplayEntries(req, store);

    expect(cleanupRecallStore(req, store)).toBe(true);

    expect(store.size).toBe(1);
    expect(store.has(recallStoreKey("active", "all"))).toBe(true);
    expect(store.has(recallStoreKey("orphaned", "all"))).toBe(false);
  });

  test("no-op on empty store", () => {
    const store: RecallStore = new Map();
    const req = makeRequest([
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ]);

    expect(cleanupRecallStore(req, store)).toBe(false);
    expect(store.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// replaceRecallWithMarker
// ---------------------------------------------------------------------------

describe("replaceRecallWithMarker", () => {
  test("replaces recall tool_use with marker text", () => {
    const resp = makeResponse([
      { type: "text", text: "hello" },
      makeRecallToolUse("find config", "project"),
      { type: "tool_use", id: "toolu_1", name: "Read", input: {} },
    ]);

    const replaced = replaceRecallWithMarker(resp);
    expect(replaced.content).toHaveLength(3);
    expect(replaced.content[0].type).toBe("text");
    expect(replaced.content[1].type).toBe("text");
    expect((replaced.content[1] as { text: string }).text).toBe(
      buildRecallMarker("find config", "project"),
    );
    expect(replaced.content[2].type).toBe("tool_use");
    expect((replaced.content[2] as GatewayToolUseBlock).name).toBe("Read");
  });

  test("returns same content when no recall present", () => {
    const resp = makeResponse([
      { type: "text", text: "hello" },
      { type: "tool_use", id: "toolu_1", name: "Read", input: {} },
    ]);

    const replaced = replaceRecallWithMarker(resp);
    expect(replaced.content).toHaveLength(2);
  });

  test("does not mutate original response", () => {
    const recallBlock = makeRecallToolUse();
    const resp = makeResponse([recallBlock]);

    const replaced = replaceRecallWithMarker(resp);
    expect(resp.content).toHaveLength(1);
    expect(resp.content[0].type).toBe("tool_use");
    expect(replaced.content).toHaveLength(1);
    expect(replaced.content[0].type).toBe("text");
  });

  test("preserves non-content fields", () => {
    const resp = makeResponse([makeRecallToolUse()]);
    if (resp.usage) resp.usage.inputTokens = 999;

    const replaced = replaceRecallWithMarker(resp);
    expect(replaced.id).toBe(resp.id);
    expect(replaced.model).toBe(resp.model);
    expect(replaced.stopReason).toBe(resp.stopReason);
    expect(replaced.usage?.inputTokens).toBe(999);
  });
});
