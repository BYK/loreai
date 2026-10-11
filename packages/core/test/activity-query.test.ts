import { describe, expect, test } from "vitest";
import {
  ACTIVITY_KINDS,
  DEFAULT_ACTIVITY_QUERY,
  PARTICIPANTS,
  parseActivityQuery,
} from "../src/activity-query";

describe("parseActivityQuery", () => {
  test("exports the append-only kind and participant registries", () => {
    expect(ACTIVITY_KINDS).toEqual([
      "session",
      "knowledge",
      "contradiction",
      "promotion",
    ]);
    expect(PARTICIPANTS.map(({ id }) => id)).toEqual([
      "user",
      "claude-code",
      "codex",
      "opencode",
      "pi",
      "lore",
      "curator",
      "pattern",
      "import",
    ]);
    expect(DEFAULT_ACTIVITY_QUERY).toBe("in:inbox");
  });

  test("parses every filter token and preserves free-term case", () => {
    const parsed = parseActivityQuery(
      'type:session,knowledge project:"Lore Core" with:"claude code" before:2024-03-01 after:2024-02-29 in:inbox in:archive in:"folder:Work Notes" is:unread is:read is:pinned "Free Phrase" MixedCase',
    );

    expect(parsed).toEqual({
      server: {
        types: ["session", "knowledge"],
        projects: ["Lore Core"],
        with: ["claude-code"],
        before: Date.UTC(2024, 2, 1),
        after: Date.UTC(2024, 1, 29),
        terms: ["Free Phrase", "MixedCase"],
      },
      client: {
        in: ["inbox", "archive"],
        folders: ["Work Notes"],
        is: ["unread", "read", "pinned"],
      },
      errors: [],
    });
  });

  test("accepts participant IDs, case-insensitive labels, and the you alias", () => {
    const parsed = parseActivityQuery(
      "with:USER with:Claude-Code with:CODEx with:OpenCode with:pi with:lore with:Curator with:Pattern with:IMPORT with:you",
    );

    expect(parsed.server.with).toEqual([
      "user",
      "claude-code",
      "codex",
      "opencode",
      "pi",
      "lore",
      "curator",
      "pattern",
      "import",
      "user",
    ]);
    expect(parsed.errors).toEqual([]);
  });

  test("intersects repeated type filters", () => {
    const parsed = parseActivityQuery(
      "type:session,knowledge type:knowledge,promotion type:knowledge",
    );

    expect(parsed.server.types).toEqual(["knowledge"]);
    expect(parsed.errors).toEqual([]);
  });

  test("uses the strongest repeated date bounds", () => {
    const parsed = parseActivityQuery(
      "before:2024-06-01 before:2024-05-01 after:2024-01-01 after:2024-02-01",
    );

    expect(parsed.server.before).toBe(Date.UTC(2024, 4, 1));
    expect(parsed.server.after).toBe(Date.UTC(2024, 1, 1));
  });

  test("reports unknown keys, empty values, invalid dates, participants, and quotes with offsets", () => {
    const query =
      'what:value type: with:nobody before:2024-02-30 "unterminated';
    const parsed = parseActivityQuery(query);

    expect(parsed.errors).toHaveLength(5);
    expect(parsed.errors.map(({ token, message }) => [token, message])).toEqual(
      [
        ["what:value", "Unknown filter what:"],
        ["type:", "Filter type: requires a value"],
        ["with:nobody", "Unknown participant nobody"],
        ["before:2024-02-30", "Invalid calendar date for before: 2024-02-30"],
        ['"unterminated', "Unterminated quote"],
      ],
    );
    for (const error of parsed.errors) {
      expect(query.slice(error.start, error.end)).toBe(error.token);
    }
  });

  test("rejects impossible dates while accepting a leap day", () => {
    const parsed = parseActivityQuery(
      "after:2024-02-29 before:2023-02-29 after:2024-13-01",
    );

    expect(parsed.server.after).toBe(Date.UTC(2024, 1, 29));
    expect(parsed.errors.map(({ token }) => token)).toEqual([
      "before:2023-02-29",
      "after:2024-13-01",
    ]);
  });

  test("rejects empty folder names and empty quoted search phrases", () => {
    const parsed = parseActivityQuery('in:folder: ""');

    expect(parsed.errors.map(({ token }) => token)).toEqual([
      "in:folder:",
      '""',
    ]);
  });
});
