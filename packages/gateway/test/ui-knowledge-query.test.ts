import { describe, expect, it } from "vitest";

import {
  DEFAULT_KNOWLEDGE_QUERY,
  isDefaultKnowledgeQuery,
  knowledgeQueryKey,
  knowledgeQueryToSearch,
  parseKnowledgeQuery,
} from "../../ui/src/contracts/knowledge-query";

describe("UI knowledge query contract", () => {
  it("parses supported values and normalizes absent values", () => {
    expect(
      parseKnowledgeQuery({
        q: "  wal  ",
        category: "architecture",
        scope: "global",
        sort: "confidence_desc",
        cursor: "cursor-1",
      }),
    ).toEqual({
      q: "wal",
      category: "architecture",
      scope: "global",
      sort: "confidence_desc",
      cursor: "cursor-1",
    });
    expect(parseKnowledgeQuery({})).toEqual(DEFAULT_KNOWLEDGE_QUERY);
  });

  it("serializes every field in URL order", () => {
    expect(
      knowledgeQueryToSearch({
        q: "wal mode",
        category: "gotcha",
        scope: "project",
        sort: "created_desc",
        cursor: "next page",
      }),
    ).toBe(
      "?q=wal+mode&category=gotcha&scope=project&sort=created_desc&cursor=next+page",
    );
  });

  it("identifies defaults and includes the project in the key", () => {
    expect(isDefaultKnowledgeQuery(DEFAULT_KNOWLEDGE_QUERY)).toBe(true);
    const query = { ...DEFAULT_KNOWLEDGE_QUERY, cursor: "next" };
    expect(isDefaultKnowledgeQuery(query)).toBe(false);
    expect(knowledgeQueryKey("p/1", query)).toBe(
      "projectId=p%2F1&q=&category=&scope=&sort=updated_desc&cursor=next",
    );
  });
});
