import { describe, expect, test } from "vitest";
import {
  buildOolongReplayTurns,
  normalizeOolongExample,
  scoreOolong,
  splitOolongContext,
} from "./oolong";

describe("splitOolongContext", () => {
  test("normalizes public context_window_text records", () => {
    expect(
      normalizeOolongExample(
        {
          id: "native",
          context_window_id: "window",
          context_window_text: "reference material",
          question: "question",
          answer: "['answer']",
        },
        "synth",
      ),
    ).toMatchObject({ dataset: "synth", context: "reference material" });
  });

  test("preserves the source exactly in deterministic chunks", () => {
    const chunks = splitOolongContext("abcdefgh", 3);
    expect(chunks).toEqual(["abc", "def", "gh"]);
    expect(chunks.join("")).toBe("abcdefgh");
  });

  test("rejects an invalid chunk size", () => {
    expect(() => splitOolongContext("x", 0)).toThrow("positive integer");
  });

  test("builds a stable full-history replay with fixed acknowledgements", () => {
    const turns = buildOolongReplayTurns(
      {
        id: "s1",
        context_window_id: "c1",
        dataset: "synth",
        context: "abcdef",
        question: "What is the answer?",
        answer: "['x']",
      },
      3,
    );
    expect(turns).toEqual([
      { role: "user", content: expect.stringContaining("1/2") },
      { role: "assistant", content: "ACK" },
      { role: "user", content: expect.stringContaining("2/2") },
      { role: "assistant", content: "ACK" },
      { role: "user", content: "What is the answer?" },
    ]);
    expect((turns.length - 1) / 2).toBe(2);
  });
});

describe("scoreOolong", () => {
  test("matches Oolong Synth exact-answer and numeric partial credit rules", () => {
    const exact = scoreOolong(
      {
        id: "s1",
        context_window_id: "c1",
        dataset: "synth",
        context: "",
        question: "",
        answer: "['blue']",
      },
      "Answer: [blue]",
    );
    const numeric = scoreOolong(
      {
        id: "s2",
        context_window_id: "c1",
        dataset: "synth",
        context: "",
        question: "",
        answer: "['4']",
        answer_type: "ANSWER_TYPE.NUMERIC",
      },
      "Answer: 6",
    );
    expect(exact.score).toBe(1);
    expect(numeric.score).toBe(0.75 ** 2);
  });

  test("matches Oolong Synth date parsing", () => {
    const result = scoreOolong(
      {
        id: "s3",
        context_window_id: "c1",
        dataset: "synth",
        context: "",
        question: "",
        answer: "['2024-01-02']",
        answer_type: "ANSWER_TYPE.DATE",
      },
      "Date: January 2, 2024",
    );
    expect(result.score).toBe(1);
  });

  test("matches Oolong Synth datetime literal gold answers", () => {
    const result = scoreOolong(
      {
        id: "s4",
        context_window_id: "c1",
        dataset: "synth",
        context: "",
        question: "",
        answer: "[datetime.date(2024, 1, 2)]",
        answer_type: "ANSWER_TYPE.DATE",
      },
      "Date: 2024-01-02",
    );
    expect(result.score).toBe(1);
  });

  test("matches Oolong D&D boxed-answer scoring", () => {
    const result = scoreOolong(
      {
        id: "d1",
        context_window_id: "c1",
        dataset: "dnd",
        context: "",
        question: "",
        answer: "owl,bear",
      },
      "\\boxed{\\text{owl,bear}}",
    );
    expect(result.score).toBe(1);
    expect(result.parseConfidence).toBe("high");
  });

  test("does not give duplicate D&D list answers extra credit", () => {
    const result = scoreOolong(
      {
        id: "d2",
        context_window_id: "c1",
        dataset: "dnd",
        context: "",
        question: "",
        answer: "owl,bear",
      },
      "\\boxed{\\text{owl,owl}}",
    );
    expect(result.score).toBe(0.5);
  });
});
