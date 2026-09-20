import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  parseContract,
  sessionDetail,
  type TemporalMessage,
} from "~/contracts";
import { contentHash, cyrb53 } from "~/lib/hash";
import {
  CHUNK_SEPARATOR,
  buildBlocks,
  messageBlock,
  messageBlockId,
  originLabel,
  originOf,
  parseMeta,
  parseParts,
} from "~/reader/blocks";

const detail = parseContract(
  "fixture:session-detail",
  sessionDetail,
  JSON.parse(
    readFileSync(join(__dirname, "fixtures", "session-detail.json"), "utf8"),
  ),
);

function msg(over: Partial<TemporalMessage> = {}): TemporalMessage {
  return {
    id: "msg-1",
    source_id: "src-1",
    project_id: "p",
    session_id: "s",
    role: "user",
    content: "hello",
    tokens: 1,
    distilled: 0,
    created_at: 1_700_000_000_000,
    metadata: "{}",
    ...over,
  };
}

describe("hash", () => {
  it("is deterministic and sensitive to single-character edits", () => {
    expect(cyrb53("abc")).toBe(cyrb53("abc"));
    expect(cyrb53("abc")).not.toBe(cyrb53("abd"));
    expect(cyrb53("")).not.toBe(cyrb53(" "));
    expect(contentHash("hello")).toMatch(/^[0-9a-z]{1,11}$/);
  });

  it("matches the reference vector so anchors stay stable across releases", () => {
    // Pinned outputs: a change here invalidates every anchor already shared.
    expect(cyrb53("a")).toBe(7929297801672961);
    expect(contentHash("Replace the SQLite cache with a remote service.")).toBe(
      "1de7e4s9bym",
    );
    expect(contentHash("x".repeat(100_000))).not.toBe(
      contentHash("x".repeat(100_001)),
    );
  });
});

describe("parseParts", () => {
  it("splits on the core chunk separator and classifies envelopes", () => {
    const content = [
      "Plain **markdown** text",
      "[reasoning] thinking out loud",
      '[tool:read] {"path":"a.ts"}',
      "[tool:bash]",
    ].join(CHUNK_SEPARATOR);
    const parts = parseParts(content);
    expect(parts.map((p) => [p.index, p.kind, p.tool])).toEqual([
      [0, "text", null],
      [1, "reasoning", null],
      [2, "tool", "read"],
      [3, "tool", "bash"],
    ]);
    expect(parts[1]?.text).toBe("thinking out loud");
    expect(parts[2]?.text).toBe('{"path":"a.ts"}');
    expect(parts[3]?.text).toBe("");
    for (const p of parts) expect(p.hash).toBe(contentHash(p.text));
  });

  it("does not treat a bare newline or a lone \\x1f as a separator", () => {
    expect(parseParts("a\nb")).toHaveLength(1);
    expect(parseParts("a\x1fb")).toHaveLength(1);
    expect(parseParts("")).toEqual([
      { index: 0, kind: "text", text: "", tool: null, hash: contentHash("") },
    ]);
  });

  it("leaves envelope-like text that is not at the chunk start alone", () => {
    const [p] = parseParts("see [tool:read] later");
    expect(p?.kind).toBe("text");
    expect(p?.text).toBe("see [tool:read] later");
  });

  it("rejects hostile tool names (whitespace, unbounded length)", () => {
    expect(parseParts("[tool:a b] x")[0]?.kind).toBe("text");
    expect(parseParts(`[tool:${"n".repeat(500)}] x`)[0]?.kind).toBe("text");
  });
});

describe("parseMeta / originOf", () => {
  it("reads user-row and assistant-row metadata shapes", () => {
    expect(
      parseMeta(
        JSON.stringify({
          agent: "opencode",
          model: { providerID: "anthropic", modelID: "claude" },
          mode: "build",
        }),
      ),
    ).toMatchObject({
      agent: "opencode",
      modelId: "claude",
      providerId: "anthropic",
      mode: "build",
    });
    expect(
      parseMeta(
        JSON.stringify({
          modelID: "gpt",
          providerID: "openai",
          tools: ["read", 3],
        }),
      ),
    ).toMatchObject({ modelId: "gpt", providerId: "openai", tools: ["read"] });
  });

  it("survives malformed metadata", () => {
    for (const raw of ["", "not json", "[]", "null", "42", '"str"']) {
      expect(parseMeta(raw)).toEqual({
        agent: null,
        modelId: null,
        providerId: null,
        mode: null,
        tools: [],
        synthetic: false,
      });
    }
  });

  it("labels Lore-injected and system content distinctly (#1508)", () => {
    const plain = parseMeta("{}");
    expect(originOf("user", plain)).toBe("user");
    expect(originOf("assistant", plain)).toBe("agent");
    expect(originOf("system", plain)).toBe("system");
    expect(originOf("lore", plain)).toBe("lore");
    expect(originOf("tool", plain)).toBe("unknown");
    expect(originOf("user", parseMeta('{"synthetic":true}'))).toBe("lore");
    expect(originOf("user", parseMeta('{"lore":true}'))).toBe("lore");
    expect(originOf("assistant", parseMeta('{"agent":"lore"}'))).toBe("lore");

    expect(originLabel(messageBlock(msg({ role: "system" })))).toBe(
      "System prompt",
    );
    expect(originLabel(messageBlock(msg({ role: "weird" })))).toBe("weird");
    expect(originLabel(messageBlock(msg({ role: "" })))).toBe("Unknown role");
  });
});

describe("messageBlock", () => {
  it("derives the id from the server message id, never the position", () => {
    const a = messageBlock(msg({ id: "01ABC" }));
    expect(a.id).toBe(messageBlockId("01ABC"));
    expect(a.id).toBe("m.01ABC");
    expect(a.messageId).toBe("01ABC");
    expect(a.sourceId).toBe("src-1");
  });

  it("never manufactures a timestamp", () => {
    expect(messageBlock(msg({ created_at: 0 })).createdAt).toBeNull();
    expect(messageBlock(msg({ created_at: 1_700_000_000_000 })).createdAt).toBe(
      1_700_000_000_000,
    );
  });

  it("keeps a missing source_id as null", () => {
    expect(messageBlock(msg({ source_id: null })).sourceId).toBeNull();
    const { source_id: _dropped, ...rest } = msg();
    expect(messageBlock(rest).sourceId).toBeNull();
  });
});

describe("buildBlocks", () => {
  it("projects the UI-03 contract fixture", () => {
    const blocks = buildBlocks(detail);
    expect(blocks.messages).toHaveLength(detail.messages.length);
    expect(blocks.distillations).toHaveLength(detail.distillations.length);
    for (const m of detail.messages) {
      expect(blocks.byId.get(`m.${m.id}`)?.kind).toBe("message");
    }
    for (const d of detail.distillations) {
      expect(blocks.byId.get(`d.${d.id}`)?.kind).toBe("distillation");
    }
  });

  it("keeps server order and drops duplicate ids (adversarial page overlap)", () => {
    const m1 = msg({ id: "a", created_at: 1 });
    const m2 = msg({ id: "b", created_at: 2, content: "second" });
    const dup = msg({ id: "a", created_at: 1, content: "changed copy" });
    const blocks = buildBlocks({ messages: [m1, m2, dup], distillations: [] });
    expect(blocks.messages.map((b) => b.id)).toEqual(["m.a", "m.b"]);
    expect(blocks.messages[0]?.parts[0]?.text).toBe("hello");
  });

  it("orders distillations by generation then time and never as messages", () => {
    const d = (id: string, generation: number, created_at: number) => ({
      id,
      session_id: "s",
      generation,
      token_count: 10,
      r_compression: 2,
      c_norm: null,
      archived: 0,
      created_at,
      call_type: null,
    });
    const blocks = buildBlocks({
      messages: [],
      distillations: [d("z", 1, 5), d("y", 0, 9), d("x", 0, 3), d("x", 0, 3)],
    });
    expect(blocks.distillations.map((b) => b.id)).toEqual([
      "d.x",
      "d.y",
      "d.z",
    ]);
    expect(blocks.messages).toHaveLength(0);
  });
});
