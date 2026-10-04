import { describe, expect, it } from "vitest";
import { DEFAULT_ALL_KNOWLEDGE_QUERY } from "~/contracts";
import {
  allKnowledgeHref,
  buildHref,
  entitiesHref,
  globalKnowledgeHref,
  importsHref,
  searchHref,
  workspaceSearchHref,
} from "~/lib/href";

describe("buildHref", () => {
  it("encodes every segment", () => {
    expect(buildHref(["projects", "a/b%c"])).toBe("/projects/a%2Fb%25c");
  });

  it("omits null, undefined and empty query values", () => {
    expect(buildHref(["x"], { a: "1", b: null, c: undefined, d: "" })).toBe(
      "/x?a=1",
    );
    expect(buildHref(["x"], { b: null })).toBe("/x");
    expect(buildHref(["x"])).toBe("/x");
  });

  it("encodes query values the same way apiPath does", () => {
    expect(buildHref(["x"], { q: "a b&c" })).toBe("/x?q=a+b%26c");
  });
});

describe("route hrefs", () => {
  it("allKnowledgeHref serializes workspace filters", () => {
    expect(allKnowledgeHref()).toBe("/knowledge");
    expect(
      allKnowledgeHref({
        ...DEFAULT_ALL_KNOWLEDGE_QUERY,
        q: "SQLite",
        project: "p/1",
      }),
    ).toBe("/knowledge?q=SQLite&project=p%2F1");
  });

  it("globalKnowledgeHref encodes the id as one path segment", () => {
    expect(globalKnowledgeHref("a/b c")).toBe("/knowledge/a%2Fb%20c");
  });

  it("searchHref orders q then scope", () => {
    expect(searchHref("p1", "hello world", "session")).toBe(
      "/projects/p1/search?q=hello+world&scope=session",
    );
    expect(searchHref("p1", "q")).toBe("/projects/p1/search?q=q&scope=all");
    expect(searchHref("p1", "", "knowledge")).toBe(
      "/projects/p1/search?scope=knowledge",
    );
  });

  it("entitiesHref lists and pages", () => {
    expect(entitiesHref()).toBe("/entities");
    expect(entitiesHref("repo", "c")).toBe("/entities?type=repo&cursor=c");
    expect(entitiesHref(null, "a/b")).toBe("/entities?cursor=a%2Fb");
  });

  it("importsHref omits the query when there is no cursor", () => {
    expect(importsHref("p1", null)).toBe("/projects/p1/imports");
    expect(importsHref("p1")).toBe("/projects/p1/imports");
    expect(importsHref("p1", "tok==")).toBe(
      "/projects/p1/imports?cursor=tok%3D%3D",
    );
  });

  it("workspaceSearchHref preserves its established query encoding", () => {
    expect(workspaceSearchHref("a b")).toBe("/search?q=a%20b");
    expect(workspaceSearchHref("a b+!'()*~")).toBe("/search?q=a%20b%2B!'()*~");
    expect(workspaceSearchHref("")).toBe("/search?q=");
  });
});
