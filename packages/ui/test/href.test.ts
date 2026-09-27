import { describe, expect, it } from "vitest";
import { buildHref, entitiesHref, importsHref, searchHref } from "~/lib/href";

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

  it("encodes query values with %20 for spaces, not +", () => {
    expect(buildHref(["x"], { q: "a b&c" })).toBe("/x?q=a%20b%26c");
  });
});

describe("route hrefs", () => {
  it("searchHref orders q then scope", () => {
    expect(searchHref("p1", "hello world", "session")).toBe(
      "/projects/p1/search?q=hello%20world&scope=session",
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
});
