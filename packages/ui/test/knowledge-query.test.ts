import { describe, expect, it } from "vitest";

import {
  DEFAULT_KNOWLEDGE_QUERY,
  isDefaultKnowledgeQuery,
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

  it("parses every supported filter and uses defaults when values are absent", () => {
    expect(
      parseKnowledgeQuery({
        category: "architecture",
        scope: "global",
        sort: "confidence_desc",
        q: "  wal  ",
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

  it("serializes only non-default values", () => {
    expect(knowledgeQueryToSearch(DEFAULT_KNOWLEDGE_QUERY)).toBe("");
    expect(
      knowledgeQueryToSearch({
        ...DEFAULT_KNOWLEDGE_QUERY,
        q: "wal mode",
        sort: "title_asc",
      }),
    ).toBe("?q=wal+mode&sort=title_asc");
  });

  it("serializes every query field in a stable order", () => {
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

  it("identifies the default query without treating filters as default", () => {
    expect(isDefaultKnowledgeQuery(DEFAULT_KNOWLEDGE_QUERY)).toBe(true);
    expect(
      isDefaultKnowledgeQuery({
        ...DEFAULT_KNOWLEDGE_QUERY,
        cursor: "next",
      }),
    ).toBe(false);
  });

  it("includes the project in keyed loader identity", () => {
    expect(knowledgeQueryKey("p/1", DEFAULT_KNOWLEDGE_QUERY)).toBe(
      "projectId=p%2F1&q=&category=&scope=&sort=updated_desc&cursor=",
    );
    expect(
      knowledgeQueryKey("p/1", {
        ...DEFAULT_KNOWLEDGE_QUERY,
        cursor: "next",
      }),
    ).toBe("projectId=p%2F1&q=&category=&scope=&sort=updated_desc&cursor=next");
  });
});
