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
import { describe, test, expect } from "vitest";
import { LORE_COMMIT_REMINDER } from "../src/pipeline";
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
  type RecallFollowUpCtx,
  buildRecallMarker,
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
} from "../src/recall";
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
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

describe("RECALL_GATEWAY_TOOL", () => {
  test("has correct name and schema", () => {
    expect(RECALL_GATEWAY_TOOL.name).toBe("recall");
    expect(RECALL_GATEWAY_TOOL.description).toBeTruthy();
    const schema = RECALL_GATEWAY_TOOL.inputSchema as Record<string, unknown>;
    expect(schema.type).toBe("object");
    const props = schema.properties as Record<string, unknown>;
    expect(props).toHaveProperty("query");
    expect(props).toHaveProperty("scope");
    expect(schema.required).toEqual(["query"]);
  });

  test("instructs resolving named references via recall before exploring", () => {
    // Recall-first directive: the agent must resolve a named project/repo/
    // person/service reference against memory before filesystem exploration.
    expect(RECALL_GATEWAY_TOOL.description).toContain(
      "before searching the filesystem",
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
          input: { query: 'sync tiers "pro" max', scope: "all" },
          position: 2,
          result: "## Results\n\n* entry one\n* entry two",
        },
      ],
      [
        "id:k:abc123",
        {
          toolUseId: "toolu_2",
          input: { query: "", scope: "all", id: "k:abc123" },
          position: 0,
          result: "detail body",
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
    // Entries missing required fields are dropped, valid ones kept.
    const mixed = JSON.stringify([
      ["bad", { toolUseId: 123 }],
      [
        "good",
        { toolUseId: "t", input: { query: "q" }, position: 0, result: "r" },
      ],
    ]);
    const restored = deserializeRecallStore(mixed);
    expect(restored.size).toBe(1);
    expect(restored.get("good")?.result).toBe("r");
  });
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

    // Tools list keeps recall — the continuation is recall-aware and
    // can handle further recall calls (multi-turn recall).
    expect(followUp.tools).toHaveLength(2);
    expect(followUp.tools.map((t) => t.name).sort()).toEqual([
      "Read",
      "recall",
    ]);
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
      result.reader.cancel(); // cleanup
    }
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
});

// ---------------------------------------------------------------------------
// expandRecallMarkers
// ---------------------------------------------------------------------------

describe("expandRecallMarkers", () => {
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

    cleanupRecallStore(req, store);

    expect(store.size).toBe(1);
    expect(store.has(recallStoreKey("active", "all"))).toBe(true);
    expect(store.has(recallStoreKey("orphaned", "all"))).toBe(false);
  });

  test("no-op on empty store", () => {
    const store: RecallStore = new Map();
    const req = makeRequest([
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ]);

    cleanupRecallStore(req, store);
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
