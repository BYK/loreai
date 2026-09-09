import { afterEach, expect, test, vi } from "vitest";
import { log } from "@loreai/core";
import {
  createRecallDiagnostics,
  MAX_RECALL_DIAGNOSTIC_ROUNDS,
} from "../src/recall-diagnostics";

afterEach(() => vi.restoreAllMocks());

test("distinguishes repeated calls, repeated results, changed results, and ID lookups without exposing content", () => {
  const sink = vi.spyOn(log, "info").mockImplementation(() => {});
  const diagnostics = createRecallDiagnostics();
  const secret = "PRIVATE-recall-content";
  diagnostics.record({ query: secret }, secret);
  diagnostics.record({ query: ` ${secret} ` }, secret);
  diagnostics.record({ query: secret }, "changed result");
  diagnostics.record({ query: "different query" }, secret);
  diagnostics.record({ query: "one", id: "d:PRIVATE-id" }, secret);
  diagnostics.record({ query: "two", id: "d:PRIVATE-id" }, secret);
  diagnostics.record({ query: secret, scope: "session" }, "");
  diagnostics.finish("completed");
  diagnostics.finish("failed");
  diagnostics.record({ query: secret }, secret);
  const messages = sink.mock.calls.map(([message]) => String(message));
  expect(messages).toHaveLength(8);
  expect(messages.join("\n")).not.toContain(secret);
  expect(messages.join("\n")).not.toContain("PRIVATE-id");
  expect(messages.join("\n")).not.toMatch(/[a-f0-9]{64}/);
  expect(
    JSON.parse(messages.at(-1)!.slice("recall-chain ".length)),
  ).toMatchObject({
    outcome: "completed",
    rounds: 7,
    detailCalls: 2,
    repeatedInputs: 3,
    repeatedResults: 4,
    repeatedPairs: 2,
    emptyBodies: 1,
  });
  expect(JSON.parse(messages[2].slice("recall-round ".length))).toMatchObject({
    repeatedInput: true,
    repeatedResult: false,
    repeatedPair: false,
  });
});

test.each([true, false])(
  "diagnostics are bounded and honor no-store (enabled=%s)",
  (enabled) => {
    const sink = vi.spyOn(log, "info").mockImplementation(() => {});
    const diagnostics = createRecallDiagnostics(enabled);
    for (let i = 0; i < 50; i++)
      diagnostics.record({ query: String(i) }, String(i));
    diagnostics.finish("aborted");
    expect(sink).toHaveBeenCalledTimes(
      enabled ? Math.min(50, MAX_RECALL_DIAGNOSTIC_ROUNDS) + 1 : 0,
    );
  },
);
