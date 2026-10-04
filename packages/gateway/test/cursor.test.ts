import { describe, expect, it } from "vitest";
import {
  assertCursorBinding,
  BadRequest,
  CURSOR_VERSION,
  decodeCursorObject,
  encodeCursor,
} from "../src/cursor";

function tokenFor(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function expectInvalidCursor(
  operation: () => unknown,
  message = "Malformed cursor",
): void {
  let error: unknown;
  try {
    operation();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(BadRequest);
  expect(error).toMatchObject({ errorType: "invalid_cursor", message });
}

describe("shared cursor codec", () => {
  it("round-trips a generic cursor", () => {
    const payload = {
      v: CURSOR_VERSION,
      kind: "messages",
      project: "project-1",
      session: "session-1",
      created_at: 456,
      id: "message-1",
    } as const;
    expect(decodeCursorObject(encodeCursor(payload))).toEqual(payload);
  });

  it.each([
    ["non-base64url characters", "not a cursor"],
    ["oversized tokens", "a".repeat(4097)],
    ["non-JSON", tokenFor("not JSON")],
    ["arrays", tokenFor([{ v: CURSOR_VERSION }])],
    ["null", tokenFor(null)],
    ["numbers", tokenFor(1)],
    ["wrong versions", tokenFor({ v: CURSOR_VERSION + 1 })],
    ["missing versions", tokenFor({})],
  ])("rejects %s", (_label, token) => {
    expectInvalidCursor(() => decodeCursorObject(token));
  });

  it("reports project and session binding mismatches", () => {
    expectInvalidCursor(
      () => assertCursorBinding("project-a", "project-b", "project"),
      "Cursor was issued for a different project",
    );
    expectInvalidCursor(
      () => assertCursorBinding("session-a", "session-b", "session"),
      "Cursor was issued for a different session",
    );
    expect(() => assertCursorBinding("same", "same", "project")).not.toThrow();
  });

  it.each([
    [
      "session",
      {
        v: CURSOR_VERSION,
        kind: "sessions",
        project: "project-1",
        last_message_at: 123,
        session_id: "session-1",
      },
      "eyJ2IjoxLCJraW5kIjoic2Vzc2lvbnMiLCJwcm9qZWN0IjoicHJvamVjdC0xIiwibGFzdF9tZXNzYWdlX2F0IjoxMjMsInNlc3Npb25faWQiOiJzZXNzaW9uLTEifQ",
    ],
    [
      "message",
      {
        v: CURSOR_VERSION,
        kind: "messages",
        project: "project-1",
        session: "session-1",
        created_at: 456,
        id: "message-1",
      },
      "eyJ2IjoxLCJraW5kIjoibWVzc2FnZXMiLCJwcm9qZWN0IjoicHJvamVjdC0xIiwic2Vzc2lvbiI6InNlc3Npb24tMSIsImNyZWF0ZWRfYXQiOjQ1NiwiaWQiOiJtZXNzYWdlLTEifQ",
    ],
    [
      "search",
      {
        v: CURSOR_VERSION,
        kind: "search",
        project: "project-1",
        session: "session-1",
        mode: "phrase",
        created_at: 789,
        id: "message-2",
      },
      "eyJ2IjoxLCJraW5kIjoic2VhcmNoIiwicHJvamVjdCI6InByb2plY3QtMSIsInNlc3Npb24iOiJzZXNzaW9uLTEiLCJtb2RlIjoicGhyYXNlIiwiY3JlYXRlZF9hdCI6Nzg5LCJpZCI6Im1lc3NhZ2UtMiJ9",
    ],
    [
      "entity",
      { v: CURSOR_VERSION, t: "person", n: "Ada Lovelace", i: "entity-1" },
      "eyJ2IjoxLCJ0IjoicGVyc29uIiwibiI6IkFkYSBMb3ZlbGFjZSIsImkiOiJlbnRpdHktMSJ9",
    ],
    [
      "import",
      { v: CURSOR_VERSION, t: 1600000000, i: "import-1" },
      "eyJ2IjoxLCJ0IjoxNjAwMDAwMDAwLCJpIjoiaW1wb3J0LTEifQ",
    ],
  ])("preserves the %s cursor wire format", (_kind, payload, token) => {
    expect(encodeCursor(payload)).toBe(token);
  });
});
