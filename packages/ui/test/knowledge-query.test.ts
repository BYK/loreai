import { describe, expect, it } from "vitest";

import {
  DEFAULT_KNOWLEDGE_QUERY,
  knowledgeQueryKey,
  knowledgeQueryToSearch,
  parseKnowledgeQuery,
} from "~/contracts";

describe("knowledge query URL state", () => {
  it("normalizes unknown values and trims bounded text", () => {
    const query = parseKnowledgeQuery({
      q: "  sqlite  ",
      category: "unknown",
      scope: "project",
      sort: "bad",
      cursor: "next page",
    });
    expect(query).toEqual({
      q: "sqlite",
      category: null,
      scope: "project",
      sort: "updated_desc",
      cursor: "next page",
    });
  });

  it("serializes only non-default values", () => {
    expect(knowledgeQueryToSearch(DEFAULT_KNOWLEDGE_QUERY)).toBe("");
    expect(
      knowledgeQueryToSearch({
        ...DEFAULT_KNOWLEDGE_QUERY,
        q: "wal mode",
        sort: "title_asc",
      }),
    ).toBe("?q=wal%20mode&sort=title_asc");
  });

  it("includes the project in keyed loader identity", () => {
    expect(knowledgeQueryKey("p/1", DEFAULT_KNOWLEDGE_QUERY)).toBe("p/1");
    expect(
      knowledgeQueryKey("p/1", {
        ...DEFAULT_KNOWLEDGE_QUERY,
        cursor: "next",
      }),
    ).toBe("p/1?cursor=next");
  });
});
