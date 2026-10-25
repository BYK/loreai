import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Tokenizer } from "ai-tokenizer";
import { close, db, ensureProject, saveSessionTracking } from "../src/db";
import {
  evictSession,
  estimateMessages,
  setForceMinLayer,
  setMaxLayer0Tokens,
  setModelLimits,
  transform,
} from "../src/gradient";
import { SemanticTokenCache } from "../src/semantic-token-cache";
import type { LoreMessageWithParts } from "../src/types";

const scope = {
  projectPath: "/test/gradient-token-cache",
  sessionID: "gradient-token-cache",
  noStore: false,
};
const messages: LoreMessageWithParts[] = Array.from(
  { length: 100 },
  (_, i) => ({
    info:
      i % 2
        ? {
            id: `message-${i}`,
            sessionID: scope.sessionID,
            role: "assistant" as const,
            time: { created: 0 },
            parentID: `message-${i - 1}`,
            modelID: "synthetic",
            providerID: "synthetic",
            mode: "build",
            path: { cwd: scope.projectPath, root: scope.projectPath },
            cost: 0,
            tokens: {
              input: 0,
              output: 0,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
          }
        : {
            id: `message-${i}`,
            sessionID: scope.sessionID,
            role: "user" as const,
            time: { created: 0 },
          },
    parts: [
      {
        id: `part-${i}`,
        sessionID: scope.sessionID,
        messageID: `message-${i}`,
        type: "text",
        text: `Review ${i}: exact counting preserves Merhaba 🇹🇷 漢字.`.repeat(
          8,
        ),
      },
    ],
  }),
);

beforeEach(() => {
  ensureProject(scope.projectPath);
  saveSessionTracking(scope.sessionID, { projectPath: scope.projectPath });
  db().exec("DELETE FROM semantic_token_cache");
  evictSession(scope.sessionID);
  setModelLimits({ context: 64_000, output: 2_000 });
  setMaxLayer0Tokens(0);
});

it("recounts changed text and appended messages instead of trusting message IDs", () => {
  transform({ ...scope, messages: structuredClone(messages) });
  const changed = structuredClone(messages);
  const part = changed[0].parts[0];
  if (part.type !== "text") throw new Error("fixture");
  part.text += " changed output ".repeat(20);
  changed[0].hiddenInputTokens = 123;
  changed.push({
    info: { ...changed[0].info, id: "new-message" },
    parts: [
      {
        id: "new-part",
        type: "text",
        text: "Appended source content.".repeat(16),
      },
    ],
  });
  const expected = estimateMessages(changed);
  const count = vi.spyOn(Tokenizer.prototype, "count");
  const result = transform({ ...scope, messages: changed });
  expect(result.totalTokens).toBe(expected);
  expect(count).toHaveBeenCalledTimes(2);
});

it("does not use or update durable counts for no-store and unspecified storage policy", () => {
  const first = transform({ ...scope, messages: structuredClone(messages) });
  const before = db().query("SELECT payload FROM semantic_token_cache").all();
  const count = vi.spyOn(Tokenizer.prototype, "count");
  for (const noStore of [true, undefined]) {
    const result = transform({
      ...scope,
      noStore,
      messages: structuredClone(messages),
    });
    expect(result).toEqual(first);
    expect(count).toHaveBeenCalledTimes(messages.length);
    count.mockClear();
  }
  expect(db().query("SELECT payload FROM semantic_token_cache").all()).toEqual(
    before,
  );
});

it("recomputes safely when the disposable cache is unavailable", () => {
  const first = transform({ ...scope, messages: structuredClone(messages) });
  db().exec(
    "ALTER TABLE semantic_token_cache RENAME TO unavailable_token_cache",
  );
  try {
    const count = vi.spyOn(Tokenizer.prototype, "count");
    expect(
      transform({ ...scope, messages: structuredClone(messages) }),
    ).toEqual(first);
    expect(count).toHaveBeenCalledTimes(messages.length);
  } finally {
    db().exec(
      "ALTER TABLE unavailable_token_cache RENAME TO semantic_token_cache",
    );
  }
});

it.each([0, 1, 2, 3, 4] as const)(
  "matches uncached compression and generated/stripped variants at minimum layer %s",
  (layer) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(123456);
    try {
      const mixed: LoreMessageWithParts[] = messages.map((message, i) => ({
        ...structuredClone(message),
        hiddenInputTokens: i % 9 === 0 ? 31 : 0,
        parts:
          i % 6 === 1
            ? [
                {
                  id: `tool-part-${i}`,
                  sessionID: scope.sessionID,
                  messageID: message.info.id,
                  type: "tool",
                  tool: "read_file",
                  callID: `call-${i}`,
                  state:
                    i % 12 === 1
                      ? {
                          status: "completed",
                          input: { path: `file-${i}.ts` },
                          output:
                            `Output ${i}: ` + "return value; ".repeat(200),
                          time: { start: 0, end: 0 },
                        }
                      : {
                          status: "error",
                          input: {},
                          error:
                            `Error ${i}: ` +
                            "synthetic diagnostic ".repeat(100),
                          time: { start: 0, end: 0 },
                        },
                },
              ]
            : [
                ...structuredClone(message.parts),
                {
                  id: `reasoning-${i}`,
                  sessionID: scope.sessionID,
                  messageID: message.info.id,
                  type: "reasoning",
                  text: `Reasoning ${i}: ` + "unchanged evidence ".repeat(10),
                },
              ],
      }));
      const seed = () => {
        evictSession(scope.sessionID);
        setModelLimits({ context: 16_000, output: 2_000 });
        setMaxLayer0Tokens(4_000);
        setForceMinLayer(layer, scope.sessionID);
      };
      seed();
      const bypass = vi
        .spyOn(SemanticTokenCache.prototype, "runVisible")
        .mockImplementation((fn) => fn());
      const expected = transform({
        ...scope,
        noStore: true,
        messages: structuredClone(mixed),
      });
      bypass.mockRestore();
      seed();
      const actual = transform({
        ...scope,
        noStore: true,
        messages: structuredClone(mixed),
      });
      expect(actual).toEqual(expected);
      expect(actual.layer).toBeGreaterThanOrEqual(layer);
    } finally {
      vi.useRealTimers();
    }
  },
);
afterEach(() => vi.restoreAllMocks());

it.each([false, true])(
  "reuses exact visible counts after another turn (reopen=%s)",
  (reopen) => {
    const first = transform({ ...scope, messages: structuredClone(messages) });
    evictSession(scope.sessionID);
    if (reopen) close();
    const count = vi.spyOn(Tokenizer.prototype, "count");
    const next = transform({ ...scope, messages: structuredClone(messages) });
    expect(next).toEqual(first);
    expect(count).not.toHaveBeenCalled();
  },
);
