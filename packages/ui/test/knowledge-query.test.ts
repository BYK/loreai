import { describe, expect, it } from "vitest";

import {
  DEFAULT_KNOWLEDGE_QUERY,
  DEFAULT_ALL_KNOWLEDGE_QUERY,
  allKnowledgeQueryKey,
  allKnowledgeQueryToSearch,
  isDefaultAllKnowledgeQuery,
  isDefaultKnowledgeQuery,
  knowledgeQueryKey,
  knowledgeQueryToSearch,
  parseKnowledgeQuery,
  parseAllKnowledgeQuery,
} from "~/contracts";
import {
  allKnowledgeHref,
  globalKnowledgeHref,
  workspaceSearchHref,
} from "~/routes/Browse";

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

  it("parses a bounded, trimmed project filter", () => {
    expect(
      parseAllKnowledgeQuery({
        project: "  p-1  ",
        category: "gotcha",
      }),
    ).toEqual({
      ...DEFAULT_ALL_KNOWLEDGE_QUERY,
      project: "p-1",
      category: "gotcha",
    });
    expect(parseAllKnowledgeQuery({ project: "   " }).project).toBeNull();
    expect(parseAllKnowledgeQuery({ project: "p".repeat(201) }).project).toBe(
      null,
    );
    expect(parseAllKnowledgeQuery({})).toEqual(DEFAULT_ALL_KNOWLEDGE_QUERY);
  });

  it("serializes all-knowledge state in stable route parameter order", () => {
    expect(allKnowledgeQueryToSearch(DEFAULT_ALL_KNOWLEDGE_QUERY)).toBe("");
    expect(
      allKnowledgeQueryToSearch({
        ...DEFAULT_ALL_KNOWLEDGE_QUERY,
        q: "sqlite wal",
        category: "gotcha",
        scope: "project",
        project: "p/1",
        sort: "title_asc",
        cursor: "next page",
      }),
    ).toBe(
      "?q=sqlite+wal&category=gotcha&scope=project&project=p%2F1&sort=title_asc&cursor=next+page",
    );
  });

  it("identifies the default query and separates keys from project queries", () => {
    expect(isDefaultAllKnowledgeQuery(DEFAULT_ALL_KNOWLEDGE_QUERY)).toBe(true);
    expect(
      isDefaultAllKnowledgeQuery({
        ...DEFAULT_ALL_KNOWLEDGE_QUERY,
        project: "p1",
      }),
    ).toBe(false);
    const query = {
      ...DEFAULT_ALL_KNOWLEDGE_QUERY,
      project: "p1",
      q: "sqlite",
    };
    expect(allKnowledgeQueryKey(query)).toMatch(/^all:/);
    expect(allKnowledgeQueryKey(query)).not.toBe(
      knowledgeQueryKey("p1", query),
    );
    expect(allKnowledgeQueryKey(query)).not.toBe(
      allKnowledgeQueryKey({ ...query, project: "p2" }),
    );
  });

  it("builds stable all-knowledge and workspace search links", () => {
    expect(allKnowledgeHref()).toBe("/knowledge");
    expect(
      allKnowledgeHref({
        ...DEFAULT_ALL_KNOWLEDGE_QUERY,
        q: "SQLite",
        project: "p/1",
      }),
    ).toBe("/knowledge?q=SQLite&project=p%2F1");
    expect(globalKnowledgeHref("a/b c")).toBe("/knowledge/a%2Fb%20c");
    expect(workspaceSearchHref("a b")).toBe("/search?q=a%20b");
  });
});
