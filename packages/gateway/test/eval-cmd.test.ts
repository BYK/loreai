import { describe, expect, it } from "vitest";
import {
  formatScorecard,
  parseScoreJson,
  type ScoredArm,
} from "../src/cli/eval-cmd";

const lore: ScoredArm = {
  arm: "lore",
  model: "anthropic/claude-sonnet-4-6",
  probesHeld: "4/4",
  compactions: 0,
  metrics: {
    turns: 23,
    answeringTokens: 2779390,
    peakContext: 150263,
    toolCalls: 13,
    wallSec: 195,
  },
  cost: {
    answeringUsd: 3.34,
    loreWorkerUsd: 1.67,
    grandUsd: 5.01,
    grandTokens: 3549390,
    embeddingsOk: true,
  },
};
const nolore: ScoredArm = {
  arm: "nolore",
  model: "anthropic/claude-sonnet-4-6",
  probesHeld: "0/4",
  compactions: 2,
  metrics: {
    turns: 31,
    answeringTokens: 2886019,
    peakContext: 183178,
    toolCalls: 24,
    wallSec: 240,
  },
  cost: {
    answeringUsd: 4.03,
    loreWorkerUsd: 0,
    grandUsd: 4.03,
    grandTokens: 2886019,
    embeddingsOk: null,
  },
};

describe("parseScoreJson", () => {
  it("extracts the JSON array printed before the SUMMARY block", () => {
    const stdout = `${JSON.stringify([lore, nolore], null, 2)}\n=== SUMMARY ===\nlore | probes 4/4 ...`;
    const rows = parseScoreJson(stdout);
    expect(rows).toHaveLength(2);
    expect(rows[0].arm).toBe("lore");
    expect(rows[1].probesHeld).toBe("0/4");
  });

  it("parses output with no SUMMARY marker (pure JSON)", () => {
    const rows = parseScoreJson(JSON.stringify([lore]));
    expect(rows[0].compactions).toBe(0);
  });

  it("throws on non-JSON so the caller can surface the raw scorer output", () => {
    expect(() => parseScoreJson("harness crashed: no result.json")).toThrow();
  });
});

describe("formatScorecard", () => {
  const card = formatScorecard(
    "cross-session",
    "cross-session (two separate sessions)",
    lore.model,
    [lore, nolore],
  );

  it("shows both arms with retention and compaction counts", () => {
    expect(card).toContain("lore");
    expect(card).toContain("nolore");
    expect(card).toContain("4/4");
    expect(card).toContain("0/4");
    expect(card).toContain("cross-session (two separate sessions)");
  });

  it("renders the model and dollar figures", () => {
    expect(card).toContain("anthropic/claude-sonnet-4-6");
    expect(card).toContain("$5.01");
    expect(card).toContain("$4.03");
  });

  it("calls out that Lore held more facts when it did", () => {
    expect(card).toContain("Lore retained 4/4 vs no-memory 0/4");
    expect(card).toContain("Lore held more of the facts.");
  });

  it("omits the 'held more' verdict on a tie", () => {
    const tie = formatScorecard("x", "x", lore.model, [
      lore,
      { ...nolore, probesHeld: "4/4" },
    ]);
    expect(tie).not.toContain("Lore held more of the facts.");
  });
});
