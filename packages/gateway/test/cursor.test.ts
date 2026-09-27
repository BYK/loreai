import { describe, expect, it } from "vitest";
import {
  assertCursorBinding,
  CURSOR_VERSION,
  decodeCursor,
  decodeKnowledgeCursor,
  encodeCursor,
  encodeKnowledgeCursor,
  InvalidCursor,
} from "../src/cursor";

function tokenFor(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

describe("shared cursor codec", () => {
  it("round-trips a generic cursor", () => {
    const payload = {
      v: CURSOR_VERSION,
      kind: "messages",
      project: "project-1",
      session: "session-1",
      created_at: 123,
      id: "message-1",
    } as const;
    expect(decodeCursor(encodeCursor(payload))).toEqual(payload);
  });

  it.each([
    ["non-base64url characters", "not a cursor"],
    ["oversized tokens", "a".repeat(4097)],
    ["non-JSON", Buffer.from("not JSON", "utf8").toString("base64url")],
    ["arrays", tokenFor([{ v: CURSOR_VERSION }])],
    ["null", tokenFor(null)],
    ["numbers", tokenFor(1)],
    ["wrong versions", tokenFor({ v: 2 })],
    ["missing versions", tokenFor({})],
  ])("rejects %s", (_label, token) => {
    expect(() => decodeCursor(token)).toThrow(
      new InvalidCursor("Malformed cursor"),
    );
  });

  it("reports project and session binding mismatches", () => {
    expect(() =>
      assertCursorBinding("project-a", "project-b", "project"),
    ).toThrow(new InvalidCursor("Cursor was issued for a different project"));
    expect(() =>
      assertCursorBinding("session-a", "session-b", "session"),
    ).toThrow(new InvalidCursor("Cursor was issued for a different session"));
    expect(() => assertCursorBinding("same", "same", "project")).not.toThrow();
  });

  it("pins the existing knowledge and entity cursor wire formats", () => {
    expect(
      encodeKnowledgeCursor("knowledge", "project-1", "title_asc", {
        key: "Alpha",
        id: "entry-1",
      }),
    ).toBe(
      "eyJ2IjoxLCJraW5kIjoia25vd2xlZGdlIiwicHJvamVjdCI6InByb2plY3QtMSIsInNvcnQiOiJ0aXRsZV9hc2MiLCJrZXkiOiJBbHBoYSIsImlkIjoiZW50cnktMSJ9",
    );
    expect(
      encodeCursor({
        v: CURSOR_VERSION,
        t: "person",
        n: "Ada Lovelace",
        i: "entity-1",
      }),
    ).toBe(
      "eyJ2IjoxLCJ0IjoicGVyc29uIiwibiI6IkFkYSBMb3ZlbGFjZSIsImkiOiJlbnRpdHktMSJ9",
    );
  });

  describe("knowledge cursors", () => {
    it("round-trips project and all-knowledge cursors", () => {
      const projectKeyset = { key: "Alpha", id: "entry-1" };
      const allKeyset = { key: 123, id: "entry-2" };
      expect(
        decodeKnowledgeCursor(
          encodeKnowledgeCursor(
            "knowledge",
            "project-1",
            "title_asc",
            projectKeyset,
          ),
          "knowledge",
          "project-1",
          "title_asc",
        ),
      ).toEqual(projectKeyset);
      expect(
        decodeKnowledgeCursor(
          encodeKnowledgeCursor(
            "knowledge_all",
            null,
            "updated_desc",
            allKeyset,
          ),
          "knowledge_all",
          null,
          "updated_desc",
        ),
      ).toEqual(allKeyset);
    });

    it("rejects cross-kind and malformed project bindings", () => {
      const projectCursor = encodeKnowledgeCursor(
        "knowledge",
        "project-1",
        "title_asc",
        { key: "Alpha", id: "entry-1" },
      );
      const allCursor = encodeKnowledgeCursor(
        "knowledge_all",
        null,
        "title_asc",
        { key: "Alpha", id: "entry-1" },
      );
      expect(() =>
        decodeKnowledgeCursor(
          projectCursor,
          "knowledge_all",
          "project-1",
          "title_asc",
        ),
      ).toThrow("Malformed cursor");
      expect(() =>
        decodeKnowledgeCursor(allCursor, "knowledge", "project-1", "title_asc"),
      ).toThrow("Malformed cursor");
      expect(() =>
        decodeKnowledgeCursor(
          tokenFor({
            v: CURSOR_VERSION,
            kind: "knowledge",
            project: null,
            sort: "title_asc",
            key: "Alpha",
            id: "entry-1",
          }),
          "knowledge",
          null,
          "title_asc",
        ),
      ).toThrow("Malformed cursor");
      expect(() =>
        decodeKnowledgeCursor(
          projectCursor,
          "knowledge",
          "project-2",
          "title_asc",
        ),
      ).toThrow("different project");
    });

    it("rejects unknown sorts, sort mismatches, and keys inconsistent with sort", () => {
      const cursor = (sort: unknown, key: unknown) =>
        tokenFor({
          v: CURSOR_VERSION,
          kind: "knowledge",
          project: "project-1",
          sort,
          key,
          id: "entry-1",
        });
      expect(() =>
        decodeKnowledgeCursor(
          cursor("unknown", "Alpha"),
          "knowledge",
          "project-1",
          "title_asc",
        ),
      ).toThrow("Malformed cursor");
      expect(() =>
        decodeKnowledgeCursor(
          cursor("title_asc", "Alpha"),
          "knowledge",
          "project-1",
          "updated_desc",
        ),
      ).toThrow(
        "Cursor was issued for sort=title_asc; request uses sort=updated_desc",
      );
      expect(() =>
        decodeKnowledgeCursor(
          cursor("title_asc", 123),
          "knowledge",
          "project-1",
          "title_asc",
        ),
      ).toThrow("Malformed cursor");
    });

    it("rejects empty ids", () => {
      expect(() =>
        decodeKnowledgeCursor(
          tokenFor({
            v: CURSOR_VERSION,
            kind: "knowledge_all",
            project: null,
            sort: "title_asc",
            key: "Alpha",
            id: "",
          }),
          "knowledge_all",
          null,
          "title_asc",
        ),
      ).toThrow("Malformed cursor");
    });
  });
});
