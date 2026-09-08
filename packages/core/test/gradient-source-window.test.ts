import { beforeEach, expect, it } from "vitest";
import { ensureProject, loadForceMinLayer } from "../src/db";
import {
  transform,
  estimateMessages,
  setModelLimits,
  setMaxLayer0Tokens,
  evictSession,
  FullSourceRequired,
  inspectSessionState,
  setForceMinLayer,
  needsUrgentDistillation,
  calibrate,
  resetCalibration,
} from "../src/gradient";
import type { LoreMessageWithParts } from "../src/types";

const projectPath = "/test/gradient-source-window";
const sid = "gradient-source-window";
const messages: LoreMessageWithParts[] = Array.from(
  { length: 600 },
  (_, i) => ({
    info: {
      id: `source-${i}`,
      sessionID: sid,
      role: i % 2 ? "assistant" : "user",
      time: { created: i },
    },
    parts: [
      {
        type: "text",
        id: `part-${i}`,
        sessionID: sid,
        messageID: `source-${i}`,
        text: `message ${i}: ` + "useful context ".repeat(25),
      },
    ],
  }),
) as LoreMessageWithParts[];
beforeEach(() => {
  ensureProject(projectPath);
  resetCalibration(sid);
  // The default first-turn overhead exceeds this deliberately small model.
  // Seed measured zero overhead so pin/plain-stage tests actually reach them.
  calibrate(0, sid);
  setModelLimits({ context: 16_000, output: 2_000 });
  setMaxLayer0Tokens(8_000);
});
const metadata = (offset: number) => ({
  offset,
  omittedTokens: estimateMessages(messages.slice(0, offset)),
  prefixTokens: Array.from({ length: offset + 1 }, (_, n) =>
    estimateMessages(messages.slice(0, n)),
  ),
  previousWindowIDs: [] as string[],
});
it("selects exactly the full path's window using omitted source aggregates", () => {
  const expected = transform({
    messages: structuredClone(messages),
    sessionID: sid,
    projectPath,
  });
  evictSession(sid);
  const actual = transform({
    messages: structuredClone(messages.slice(300)),
    sessionID: sid,
    projectPath,
    sourceWindow: metadata(300),
  });
  expect(actual).toEqual(expected);
});
it("requires full source on budget expansion without consuming gradient state", () => {
  const seeded = transform({
    messages: structuredClone(messages),
    sessionID: sid,
    projectPath,
  });
  expect(seeded.layer).toBe(1);
  expect(seeded.usable).toBeGreaterThan(0);
  const before = inspectSessionState(sid);
  expect(before?.hasRawWindowCache).toBe(true);
  expect(() =>
    transform({
      messages: structuredClone(messages.slice(-3)),
      sessionID: sid,
      projectPath,
      sourceWindow: {
        ...metadata(597),
        previousWindowIDs: messages.map((m) => m.info.id),
      },
    }),
  ).toThrow("Full source required: window_exhausted");
  expect(inspectSessionState(sid)).toEqual(before);
});

it.each([2, 4] as const)(
  "retries an exhausted layer %s scan without consuming one-shot escalation",
  (layer) => {
    const seeded = transform({
      messages: structuredClone(messages),
      sessionID: sid,
      projectPath,
    });
    expect(seeded.layer).toBe(1);
    expect(seeded.usable).toBeGreaterThan(0);
    needsUrgentDistillation(sid);
    setForceMinLayer(layer, sid);
    const before = inspectSessionState(sid);
    expect(() =>
      transform({
        messages: structuredClone(messages.slice(-3)),
        sessionID: sid,
        projectPath,
        sourceWindow: {
          ...metadata(597),
          previousWindowIDs: messages.map((m) => m.info.id),
        },
      }),
    ).toThrow("Full source required: window_exhausted");
    expect(loadForceMinLayer(sid)).toBe(layer);
    expect(inspectSessionState(sid)).toEqual(before);
    expect(needsUrgentDistillation(sid)).toBe(false);
  },
);

it("requires the full source for an uninterrupted tool chain", () => {
  const partial = structuredClone(messages.slice(-2));
  expect(() =>
    transform({
      messages: partial,
      sessionID: sid,
      projectPath,
      sourceWindow: metadata(598),
    }),
  ).toThrow(FullSourceRequired);
});
