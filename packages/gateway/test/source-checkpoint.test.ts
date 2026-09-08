import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  db,
  estimateMessages,
  temporal,
  ensureProject,
  saveSessionTracking,
  loadSessionTracking,
  appendSessionPromptDelta,
  listSessionPromptDeltas,
  setModelLimits,
  setMaxLayer0Tokens,
  transform,
  evictSession,
  calibrate,
  saveGradientState,
  SourceWindowStore,
  withSavepoint,
} from "@loreai/core";
import { close } from "../../core/src/db";
import {
  prepareSemanticMessages,
  PreparationTiming,
} from "../src/semantic-preparation";
import { storeTurnTemporal } from "../src/turn-temporal";
import {
  loreMessagesToGateway,
  applySessionPromptDeltas,
} from "../src/pipeline";
import {
  buildRecallAnchor,
  recallAnchorContext,
  serializeRecallStore,
  deserializeRecallStore,
  expandRecallMarkers,
} from "../src/recall";
import type {
  GatewayMessage,
  GatewayRequest,
  RecallStore,
} from "../src/translate/types";
import { semanticHistory } from "./fixtures/semantic-history";
const projectPath = "/test/source-checkpoint";
const sessionID = "source-checkpoint";
const storage = {
  projectPath,
  sessionID,
  noStore: false,
  model: "test",
  usage: { inputTokens: 2000, outputTokens: 10 },
  assistantContentBlocks: [{ type: "text" as const, text: "done" }],
};
const messages: GatewayMessage[] = Array.from({ length: 5580 }, (_, i) => ({
  role: i % 2 ? "assistant" : "user",
  content: [
    { type: "text", text: `message ${i} ` + "useful context ".repeat(15) },
  ],
}));
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-08T00:00:00Z"));
  db().exec("DELETE FROM source_windows; DELETE FROM temporal_messages");
  ensureProject(projectPath);
  saveSessionTracking(sessionID, {});
  evictSession(sessionID);
  setModelLimits({ context: 16000, output: 2000 });
  setMaxLayer0Tokens(8000);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
async function prepare(source: GatewayMessage[], forceFull = false) {
  const timing = new PreparationTiming({
    protocol: "openai-responses",
    stream: true,
  });
  return {
    timing,
    prepared: await prepareSemanticMessages({
      messages: source,
      projectPath,
      sessionID,
      noStore: false,
      protocol: "openai-responses",
      forceFull,
      timing,
    }),
  };
}
function accept(prepared: Awaited<ReturnType<typeof prepare>>["prepared"]) {
  const result = transform({
    messages: prepared.loreMessages,
    projectPath,
    sessionID,
    sourceWindow: prepared.sourceWindow,
  });
  prepared.checkpoint?.finish(result.messages);
  storeTurnTemporal({ ...storage, temporalInput: prepared.temporalInput });
  return result;
}
it("converts only the appended suffix after warm and database-reopen resumes", async () => {
  accept((await prepare(messages)).prepared);
  expect(
    (await prepare(messages)).timing.observations.source_estimated_messages,
  ).toBe(0);
  for (const restart of [false, true]) {
    if (restart) {
      evictSession(sessionID);
      close();
    }
    const source = [
      ...messages,
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: "continue" }],
      },
    ];
    const { prepared, timing } = await prepare(source);
    expect(timing.observations.source_converted_messages).toBe(1);
    expect(timing.observations.source_estimated_messages).toBe(1);
    expect(prepared.loreMessages.length).toBeLessThanOrEqual(2049);
    expect(timing.counts.parts).toBe(prepared.loreMessages.length);
    expect(prepared.temporalInput.assistantIndex).toBe(5581);
    const actual = transform({
      messages: prepared.loreMessages,
      projectPath,
      sessionID,
      sourceWindow: prepared.sourceWindow,
    });
    evictSession(sessionID);
    const full = (await prepare(source, true)).prepared;
    const expected = transform({
      messages: full.loreMessages,
      projectPath,
      sessionID,
    });
    expect(
      loreMessagesToGateway(actual.messages, prepared.provenanceByMessageId),
    ).toEqual(
      loreMessagesToGateway(expected.messages, full.provenanceByMessageId),
    );
  }
});
it.each([false, true])(
  "reuses and advances a complete checkpoint with offset zero (restart=%s)",
  async (restart) => {
    setModelLimits({ context: 1_000_000, output: 2_000 });
    setMaxLayer0Tokens(500_000);
    const source = semanticHistory(6).messages;
    expect(accept((await prepare(source)).prepared).layer).toBe(0);
    const saved = new SourceWindowStore(storage).load() as {
      sourceCount: number;
      window: { offset: number };
    };
    expect(saved.sourceCount).toBe(source.length);
    expect(saved.window.offset).toBe(0);
    if (restart) {
      close();
      evictSession(sessionID);
    }

    const unchanged = await prepare(source);
    expect(unchanged.timing.observations.source_checkpoint_hit).toBe(1);
    expect(unchanged.timing.observations.source_converted_messages).toBe(0);
    expect(unchanged.timing.observations.source_estimated_messages).toBe(0);
    expect(unchanged.timing.observations.stored_id_resolutions).toBe(0);
    expect(unchanged.prepared.loreMessages).toHaveLength(source.length);
    accept(unchanged.prepared);
    expect(unchanged.timing.observations.source_checkpoint_published).toBe(1);

    const next: GatewayMessage[] = [
      ...source,
      { role: "assistant", content: [{ type: "text", text: "done" }] },
      { role: "user", content: [{ type: "text", text: "continue" }] },
    ];
    const appended = await prepare(next);
    expect(appended.timing.observations.source_checkpoint_hit).toBe(1);
    expect(appended.timing.observations.source_converted_messages).toBe(2);
    expect(appended.timing.observations.source_estimated_messages).toBe(2);
    expect(appended.prepared.temporalInput.assistantIndex).toBe(next.length);
    const actual = accept(appended.prepared);
    expect(actual.layer).toBe(0);
    expect(appended.timing.observations.source_checkpoint_published).toBe(1);
    expect(new SourceWindowStore(storage).load()).toMatchObject({
      sourceCount: next.length,
      window: { offset: 0 },
    });
    evictSession(sessionID);
    const full = (await prepare(next, true)).prepared;
    const expected = transform({
      messages: full.loreMessages,
      projectPath,
      sessionID,
    });
    // Exercise the same complete-source provenance gate as the pipeline.
    const render = (result: typeof actual, prepared: typeof full) =>
      loreMessagesToGateway(
        result.messages,
        prepared.provenanceByMessageId,
        !prepared.sourceWindow &&
          result.messages.length === prepared.loreMessages.length &&
          result.messages.every(
            (message, index) =>
              message.info.id === prepared.loreMessages[index]?.info.id,
          ),
      );
    const actualWire = render(actual, appended.prepared);
    expect(JSON.stringify(actualWire)).toContain("synthetic-encrypted-state-");
    expect(actualWire).toEqual(render(expected, full));
  },
);

it("reconciles historical edits even when the old boundary is unchanged", async () => {
  accept((await prepare(messages)).prepared);
  const edited = structuredClone(messages);
  edited[0].content = [{ type: "text", text: "historical branch edit" }];
  const { prepared, timing } = await prepare(edited);
  expect(prepared.sourceWindow).toBeUndefined();
  expect(timing.observations.source_converted_messages).toBe(5580);
});

it.each(["rewind", "protocol", "corrupt", "adapter"])(
  "fully reconciles a %s boundary",
  async (mode) => {
    accept((await prepare(messages)).prepared);
    let source = messages;
    if (mode === "rewind") source = messages.slice(0, -10);
    else {
      const store = new SourceWindowStore(storage);
      const payload = store.load() as Record<string, unknown>;
      if (mode === "protocol") payload.protocol = "anthropic";
      if (mode === "adapter") payload.version = "obsolete";
      if (mode === "corrupt")
        payload.raw = [
          {
            info: {
              id: "bad",
              sessionID,
              role: "assistant",
              time: { created: 1 },
            },
            parts: [{ id: "part", type: "tool" }],
          },
        ];
      withSavepoint("alter_checkpoint", () => {
        expect(store.claim()).toBe(true);
        expect(store.publish(payload)).toBe(true);
      });
    }
    const { prepared, timing } = await prepare(source);
    expect(prepared.sourceWindow).toBeUndefined();
    expect(timing.observations.source_converted_messages).toBe(source.length);
  },
);

it("preserves parallel cross-frontier tool results, errors, and encrypted/opaque Responses provenance", async () => {
  const tail = semanticHistory(4).messages;
  const source = [...messages, ...tail.slice(0, -1)];
  accept((await prepare(source)).prepared);
  close();
  evictSession(sessionID);
  const result = structuredClone(tail.at(-1)!);
  const tool = result.content.find((b) => b.type === "tool_result");
  if (tool?.type === "tool_result") {
    tool.isError = true;
    tool.content.push({
      type: "opaque",
      raw: {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: "synthetic-image",
        },
      },
    });
  }
  result.content.reverse();
  const resumed = [...source, result];
  const actual = await prepare(resumed);
  expect(actual.timing.observations.source_converted_messages).toBe(1);
  expect(actual.timing.observations.stored_id_resolutions).toBe(1);
  const full = (await prepare(resumed, true)).prepared;
  const offset = actual.prepared.sourceWindow!.offset;
  expect(
    loreMessagesToGateway(
      actual.prepared.loreMessages,
      actual.prepared.provenanceByMessageId,
    ),
  ).toEqual(
    loreMessagesToGateway(
      full.loreMessages.slice(offset),
      full.provenanceByMessageId,
    ),
  );
  expect(JSON.stringify([...actual.prepared.provenanceByMessageId])).toContain(
    "synthetic-encrypted-state",
  );
  expect(actual.prepared.temporalInput.latestUser).toEqual(
    full.temporalInput.latestUser,
  );
});

it.each(["call", "result"])(
  "reconciles a new %s reusing an omitted tool ID",
  async (kind) => {
    const early: GatewayMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "ancient-call", name: "read", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "ancient-call",
            content: [{ type: "text", text: "old result" }],
          },
        ],
      },
    ];
    const source = [...early, ...messages];
    accept((await prepare(source)).prepared);
    const next: GatewayMessage =
      kind === "call"
        ? {
            role: "assistant",
            content: [
              { type: "tool_use", id: "ancient-call", name: "read", input: {} },
            ],
          }
        : {
            role: "user",
            content: [
              {
                type: "tool_result",
                toolUseId: "ancient-call",
                isError: true,
                content: [{ type: "text", text: "replacement result" }],
              },
            ],
          };
    const { prepared, timing } = await prepare([...source, next]);
    expect(prepared.sourceWindow).toBeUndefined();
    expect(timing.observations.source_fallback_tool_boundary).toBe(1);
  },
);

it("rebuilds only suffix tool IDs against a legacy temporal row", async () => {
  const source = [...messages, ...semanticHistory(4).messages];
  const first = await prepare(source);
  const user = first.prepared.temporalInput.latestUser!;
  const pid = ensureProject(projectPath);
  db()
    .query(
      `INSERT INTO temporal_messages(id, project_id, session_id, role, content, tokens, distilled, created_at) VALUES (?, ?, ?, 'user', 'legacy output', 1, 0, 1)`,
    )
    .run(user.legacySourceID!, pid, sessionID);
  accept((await prepare(source)).prepared);
  const next = [
    ...source,
    {
      role: "user" as const,
      content: [{ type: "text" as const, text: "continue" }],
    },
  ];
  const { prepared, timing } = await prepare(next);
  expect(timing.observations.source_converted_messages).toBe(1);
  expect(timing.observations.stored_id_resolutions).toBe(0);
  const full = (await prepare(next, true)).prepared;
  expect(
    loreMessagesToGateway(
      prepared.loreMessages,
      prepared.provenanceByMessageId,
    ),
  ).toEqual(
    loreMessagesToGateway(
      full.loreMessages.slice(prepared.sourceWindow!.offset),
      full.provenanceByMessageId,
    ),
  );
});

it("keeps calibrated warm and restart sizing equivalent to the full path", async () => {
  const initial = (await prepare(messages)).prepared;
  const first = accept(initial);
  calibrate(first.totalTokens + 500, sessionID, first.messages.length);
  saveGradientState(sessionID);
  close();
  evictSession(sessionID);
  const next = [
    ...messages,
    {
      role: "user" as const,
      content: [{ type: "text" as const, text: "continue" }],
    },
  ];
  const resumed = (await prepare(next)).prepared;
  const actual = transform({
    messages: resumed.loreMessages,
    sourceWindow: resumed.sourceWindow,
    projectPath,
    sessionID,
  });
  evictSession(sessionID);
  const full = (await prepare(next, true)).prepared;
  const expected = transform({
    messages: full.loreMessages,
    projectPath,
    sessionID,
  });
  expect(
    loreMessagesToGateway(actual.messages, resumed.provenanceByMessageId),
  ).toEqual(
    loreMessagesToGateway(expected.messages, full.provenanceByMessageId),
  );
  expect(actual.totalTokens).toBe(expected.totalTokens);
});

it("refreshes cumulative calibration counts when a pending call completes", async () => {
  setModelLimits({ context: 100000, output: 2000 });
  setMaxLayer0Tokens(80000);
  const source: GatewayMessage[] = Array.from({ length: 400 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    content: [{ type: "text", text: `tiny ${i}` }],
  }));
  source[51] = {
    role: "assistant",
    content: [{ type: "tool_use", id: "late-result", name: "read", input: {} }],
  };
  accept((await prepare(source)).prepared);
  const appended: GatewayMessage[] = [
    ...source,
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolUseId: "late-result",
          content: [{ type: "text", text: "substantial output ".repeat(300) }],
        },
      ],
    },
  ];
  const resumed = await prepare(appended);
  expect(resumed.timing.observations.source_converted_messages).toBe(1);
  expect(resumed.timing.observations.source_estimated_messages).toBe(2);
  accept(resumed.prepared);
  const saved = new SourceWindowStore(storage).load() as {
    window: { prefixTokens: number[] };
  };
  const full = (await prepare(appended, true)).prepared;
  expect(saved.window.prefixTokens[52]).toBe(
    estimateMessages(full.loreMessages.slice(0, 52)),
  );
});

it("rolls back temporal rows and the frontier together, then accepts an idempotent retry", async () => {
  accept((await prepare(messages)).prepared);
  const appended = [
    ...messages,
    {
      role: "user" as const,
      content: [{ type: "text" as const, text: "retry this input" }],
    },
  ];
  const next = (await prepare(appended)).prepared;
  const model = transform({
    messages: next.loreMessages,
    sourceWindow: next.sourceWindow,
    projectPath,
    sessionID,
  });
  next.checkpoint?.finish(model.messages);
  const before = new SourceWindowStore(storage).load();
  const failure = vi
    .spyOn(temporal, "recordToolCalls")
    .mockImplementationOnce(() => {
      throw new Error("storage interrupted");
    });
  expect(() =>
    storeTurnTemporal({ ...storage, temporalInput: next.temporalInput }),
  ).toThrow("storage interrupted");
  expect(new SourceWindowStore(storage).load()).toEqual(before);
  expect(
    db()
      .query(
        "SELECT id FROM temporal_messages WHERE content = 'retry this input'",
      )
      .all(),
  ).toHaveLength(0);
  failure.mockRestore();
  storeTurnTemporal({ ...storage, temporalInput: next.temporalInput });
  storeTurnTemporal({ ...storage, temporalInput: next.temporalInput });
  expect(
    db()
      .query(
        "SELECT id FROM temporal_messages WHERE content = 'retry this input'",
      )
      .all(),
  ).toHaveLength(1);
  // An identical accepted retry may invalidate its old checkpoint through
  // storage writes, but it must never skip unaccepted input or duplicate rows.
  const resumed = await prepare([
    ...appended,
    { role: "assistant", content: [{ type: "text", text: "done" }] },
  ]);
  const full = (
    await prepare(
      [
        ...appended,
        { role: "assistant", content: [{ type: "text", text: "done" }] },
      ],
      true,
    )
  ).prepared;
  expect(
    loreMessagesToGateway(
      resumed.prepared.loreMessages,
      resumed.prepared.provenanceByMessageId,
    ),
  ).toEqual(
    loreMessagesToGateway(
      full.loreMessages.slice(resumed.prepared.sourceWindow?.offset ?? 0),
      full.provenanceByMessageId,
    ),
  );
});

it.each(["hidden tokens", "prefix subtotal", "resolved estimate"])(
  "rejects corrupt %s in a saved checkpoint",
  async (field) => {
    const source = messages.slice(0, 100);
    accept((await prepare(source)).prepared);
    const store = new SourceWindowStore(storage);
    const payload = store.load() as {
      raw: Array<{ hiddenInputTokens?: number }>;
      resolvedTokens: number[];
      window: { omittedTokens: number };
    };
    if (field === "hidden tokens") payload.raw[0].hiddenInputTokens = -1;
    if (field === "prefix subtotal") payload.window.omittedTokens++;
    if (field === "resolved estimate") payload.resolvedTokens = [-1];
    withSavepoint("corrupt_counts", () => {
      expect(store.claim()).toBe(true);
      expect(store.publish(payload)).toBe(true);
    });
    const next = await prepare(source);
    expect(next.timing.observations.source_checkpoint_hit).toBe(0);
    expect(next.timing.observations.source_fallback_checkpoint).toBe(1);
    expect(next.timing.observations.source_converted_messages).toBe(
      source.length,
    );
  },
);

it("replays durable recall, distillations, and knowledge deltas identically after restart", async () => {
  const source = structuredClone(messages);
  const anchorId = "123e4567-e89b-42d3-a456-426614174014";
  const anchorIndex = source.length - 3;
  source[anchorIndex].content = [
    { type: "text", text: buildRecallAnchor(anchorId) },
  ];
  const recalls: RecallStore = new Map([
    [
      `anchor:${anchorId}`,
      {
        anchorId,
        anchorContextId: recallAnchorContext(source, anchorIndex, []),
        toolUseId: "restored-recall-call",
        input: { query: "source context", scope: "session" },
        result: "Recalled source context survives a process restart.",
        position: 0,
      },
    ],
  ]);
  saveSessionTracking(sessionID, {
    recallStore: serializeRecallStore(recalls),
  });
  const projectID = ensureProject(projectPath);
  db()
    .query(`INSERT INTO distillations
    (id, project_id, session_id, narrative, facts, observations, source_ids,
     generation, token_count, archived, created_at)
    VALUES (?, ?, ?, ?, '[]', ?, '[]', 0, 30, 0, 1)`)
    .run(
      "source-window-distillation",
      projectID,
      sessionID,
      "Distilled source context remains available.",
      "Distilled source context remains available.",
    );
  const expand = (history: GatewayMessage[]) => {
    const request: GatewayRequest = {
      protocol: "openai-responses",
      model: "test",
      system: "test system",
      messages: structuredClone(history),
      tools: [],
      stream: true,
      maxTokens: 1024,
      metadata: {},
      rawHeaders: {},
    };
    const durable = loadSessionTracking(sessionID)?.recallStore;
    expect(durable).toBeTruthy();
    expect(expandRecallMarkers(request, deserializeRecallStore(durable!))).toBe(
      true,
    );
    return request.messages;
  };
  const initial = (await prepare(expand(source))).prepared;
  accept(initial);
  appendSessionPromptDelta({
    sessionID,
    projectID,
    selector: JSON.stringify({ target: "messages", insertAt: 2 }),
    content: JSON.stringify([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Lore knowledge update: durable source decision.",
          },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Acknowledged durable source decision." },
        ],
      },
    ]),
  });
  const durableDelta = listSessionPromptDeltas(sessionID);
  close();
  evictSession(sessionID);
  const next = [
    ...source,
    {
      role: "user" as const,
      content: [
        { type: "text" as const, text: "continue from the recalled source" },
      ],
    },
  ];
  const resumed = await prepare(expand(next));
  expect(resumed.timing.observations.source_converted_messages).toBe(1);
  expect(resumed.prepared.sourceWindow?.offset).toBeGreaterThan(0);
  const render = (prepared: typeof initial) => {
    const result = transform({
      messages: prepared.loreMessages,
      projectPath,
      sessionID,
      sourceWindow: prepared.sourceWindow,
    });
    const gateway = loreMessagesToGateway(
      result.messages,
      prepared.provenanceByMessageId,
      false,
    );
    return applySessionPromptDeltas(gateway, sessionID);
  };
  const actual = render(resumed.prepared);
  evictSession(sessionID);
  const full = (await prepare(expand(next), true)).prepared;
  const expected = render(full);
  expect(actual).toEqual(expected);
  const wire = JSON.stringify(actual);
  expect(wire).toContain("Recalled source context survives");
  expect(wire).toContain("Distilled source context remains available");
  expect(wire).toContain("Lore knowledge update: durable source decision");
  expect(listSessionPromptDeltas(sessionID)).toEqual(durableDelta);
});
