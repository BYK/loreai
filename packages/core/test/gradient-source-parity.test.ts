import { afterEach, expect, it, vi } from "vitest";
import { ensureProject } from "../src/db";
import {
  calibrate,
  estimateMessages,
  FullSourceRequired,
  getCacheSizeSnapshot,
  resetCalibration,
  setForceMinLayer,
  setMaxLayer0Tokens,
  setModelLimits,
  transform,
} from "../src/gradient";
import type { LoreMessageWithParts } from "../src/types";

afterEach(() => vi.useRealTimers());

it("matches full-source windows across mixed tools, calibration, and budget changes", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(12345);
  const projectPath = "/test/source-parity";
  ensureProject(projectPath);
  let hits = 0;
  for (let scenario = 0; scenario < 40; scenario++) {
    const sessionID = `source-parity-${scenario}`;
    const messages = Array.from({ length: 700 }, (_, index) => ({
      info: {
        id: `message-${index}`,
        sessionID,
        role: index % 2 ? "assistant" : "user",
        time: { created: 0 },
      },
      hiddenInputTokens: index % 13 === 0 ? scenario * 3 : 0,
      parts: [
        index % 6 === 1
          ? {
              id: `part-${index}`,
              type: "tool",
              tool: "read",
              callID: `call-${index}`,
              state: {
                status: "completed",
                input: { path: `file-${index % 17}` },
                output:
                  `file-${index % 17}: ` +
                  "return value ".repeat(15 + (scenario % 20)),
                time: { start: 0, end: 0 },
              },
            }
          : {
              id: `part-${index}`,
              type: "text",
              text:
                `line-${index} ` +
                "ordinary prose ".repeat(3 + (scenario % 10)),
            },
      ],
    })) as LoreMessageWithParts[];
    const seedState = () => {
      // Calibration also changes the global first-turn overhead fallback.
      // Reset both copies so the comparison starts from identical state.
      resetCalibration(sessionID);
      calibrate(0, sessionID);
      setModelLimits({ context: 8000 + (scenario % 3) * 4000, output: 1000 });
      setMaxLayer0Tokens(4000);
      const previous = transform({
        messages: structuredClone(messages.slice(0, 690)),
        projectPath,
        sessionID,
      });
      if (scenario % 2)
        calibrate(
          previous.totalTokens + 500,
          sessionID,
          previous.messages.length,
        );
      if (scenario % 7 === 0) setForceMinLayer(4, sessionID);
      setModelLimits({ context: 8000 + (scenario % 5) * 4000, output: 1000 });
      return previous;
    };
    const previous = seedState();
    const expected = transform({
      messages: structuredClone(messages),
      projectPath,
      sessionID,
    });
    const expectedSizes = getCacheSizeSnapshot(sessionID);
    seedState();
    const offset = 400;
    const prefixTokens = [0];
    for (const message of messages.slice(0, offset))
      prefixTokens.push(prefixTokens.at(-1)! + estimateMessages([message]));
    let actual;
    try {
      actual = transform({
        messages: structuredClone(messages.slice(offset)),
        sourceWindow: {
          offset,
          omittedTokens: prefixTokens[offset],
          prefixTokens,
          previousWindowIDs: previous.messages.map(
            (message) => message.info.id,
          ),
        },
        projectPath,
        sessionID,
      });
    } catch (error) {
      if (error instanceof FullSourceRequired) continue;
      throw error;
    }
    expect(actual, `scenario ${scenario}`).toEqual(expected);
    expect(getCacheSizeSnapshot(sessionID)).toEqual(expectedSizes);
    hits++;
  }
  // A battery that always falls back would prove nothing about the fast path.
  expect(hits).toBeGreaterThan(10);
});
