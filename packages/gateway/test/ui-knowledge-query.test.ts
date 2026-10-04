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
        scope: "shared",
        sort: "confidence:desc,title:asc",
        cursor: "cursor-1",
      }),
    ).toEqual({
      q: "wal",
      category: "architecture",
      scope: "shared",
      sort: [
        { field: "confidence", dir: "desc" },
        { field: "title", dir: "asc" },
      ],
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
        sort: [
          { field: "created_at", dir: "desc" },
          { field: "confidence", dir: "asc" },
        ],
        cursor: "next page",
      }),
    ).toBe(
      "?q=wal+mode&category=gotcha&scope=project&sort=created_at%3Adesc%2Cconfidence%3Aasc&cursor=next+page",
    );
  });

  it("identifies defaults and includes the project in the key", () => {
    expect(isDefaultKnowledgeQuery(DEFAULT_KNOWLEDGE_QUERY)).toBe(true);
    const query = { ...DEFAULT_KNOWLEDGE_QUERY, cursor: "next" };
    expect(isDefaultKnowledgeQuery(query)).toBe(false);
    expect(knowledgeQueryKey("p/1", query)).toBe(
      "projectId=p%2F1&q=&category=&scope=&sort=updated_at%3Adesc&cursor=next",
    );
  });
});
