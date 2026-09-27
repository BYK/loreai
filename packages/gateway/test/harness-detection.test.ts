import { describe, expect, test } from "vitest";
import { detectHarness, KNOWN_HARNESSES } from "../src/harness";

describe("detectHarness", () => {
  test("x-claude-code-session-id identifies claude-code", () => {
    expect(detectHarness({ "x-claude-code-session-id": "uuid-1" })).toBe(
      "claude-code",
    );
  });

  test("x-lore-agent identifies opencode regardless of its value", () => {
    // The header's value is OpenCode's internal agent name, not a harness.
    expect(detectHarness({ "x-lore-agent": "build" })).toBe("opencode");
  });

  test.each([
    ["codex_cli_rs", "codex"],
    ["pi", "pi"],
  ])("originator %s → %s", (value, expected) => {
    expect(detectHarness({ originator: value })).toBe(expected);
  });

  test.each([
    ["claude-cli/2.0.0", "claude-code"],
    ["codex_cli_rs/0.4.0", "codex"],
  ])("user-agent %s → %s", (value, expected) => {
    expect(detectHarness({ "user-agent": value })).toBe(expected);
  });

  test("header lookup is case-insensitive", () => {
    expect(detectHarness({ "X-Claude-Code-Session-Id": "uuid-1" })).toBe(
      "claude-code",
    );
    expect(detectHarness({ Originator: "codex_cli_rs" })).toBe("codex");
    expect(detectHarness({ "User-Agent": "claude-cli/2.0.0" })).toBe(
      "claude-code",
    );
  });

  test("claude-code session header beats a codex user-agent", () => {
    expect(
      detectHarness({
        "x-claude-code-session-id": "uuid-1",
        "user-agent": "codex_cli_rs/0.4.0",
      }),
    ).toBe("claude-code");
  });

  test("x-lore-agent beats originator", () => {
    expect(
      detectHarness({ "x-lore-agent": "build", originator: "codex_cli_rs" }),
    ).toBe("opencode");
  });

  test("unknown originator and unknown user-agent → undefined", () => {
    expect(
      detectHarness({ originator: "mystery", "user-agent": "curl/8.0" }),
    ).toBeUndefined();
  });

  test("empty headers → undefined", () => {
    expect(detectHarness({})).toBeUndefined();
  });

  test("empty-string header values are ignored", () => {
    expect(detectHarness({ "x-claude-code-session-id": "" })).toBeUndefined();
    expect(detectHarness({ "x-lore-agent": "" })).toBeUndefined();
    expect(detectHarness({ originator: "  " })).toBeUndefined();
  });

  test("never returns a value outside KNOWN_HARNESSES", () => {
    const cases: Array<Record<string, string>> = [
      { "x-claude-code-session-id": "uuid-1" },
      { "x-lore-agent": "build" },
      { originator: "codex_cli_rs" },
      { originator: "pi" },
      { "user-agent": "claude-cli/2.0.0" },
      { "user-agent": "codex_cli_rs/0.4.0" },
      { originator: "other", "user-agent": "Mozilla/5.0" },
      {},
    ];
    const known: readonly string[] = KNOWN_HARNESSES;
    for (const headers of cases) {
      const result = detectHarness(headers);
      expect(result === undefined || known.includes(result)).toBe(true);
    }
  });
});
