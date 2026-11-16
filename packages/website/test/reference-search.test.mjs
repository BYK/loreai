import assert from "node:assert/strict";
import { test } from "node:test";
import referenceSearch from "../integrations/reference-search.mjs";
await test("search ignores reference navigation and table headings without removing prose or anchors", () => {
  const heading = {
    type: "element",
    tagName: "h2",
    properties: { id: "field-reference" },
    children: [{ type: "text", value: "Field reference" }],
  };
  const list = { type: "element", tagName: "ul", children: [] };
  const body = {
    type: "element",
    tagName: "p",
    children: [{ type: "text", value: "Knowledge is selected by relevance." }],
  };
  const table = { type: "element", tagName: "thead", children: [] };
  const tree = {
    type: "root",
    children: [heading, { type: "text", value: "\n" }, list, body, table],
  };
  referenceSearch()(tree);
  assert.equal(list.properties?.dataPagefindIgnore, "");
  assert.equal(table.properties?.dataPagefindIgnore, "");
  assert.equal(heading.properties.id, "field-reference");
  assert.equal(body.properties?.dataPagefindIgnore, undefined);
  assert.equal(tree.children.length, 5);
});

await test("Starlight wrapped headings produce exact field records without losing metadata or inline links", () => {
  const node = (tagName, children = [], properties = {}) => ({
    type: "element",
    tagName,
    properties,
    children,
  });
  const text = (value) => ({ type: "text", value });
  const heading = (value) =>
    node("div", [node("h2", [text(value)])], {
      className: ["sl-heading-wrapper"],
    });
  const link = node("a", [text("reference")], { href: "/docs/memory/" });
  const table = node("table", [
    node("thead", [
      node(
        "tr",
        ["Field", "Type", "Default", "Constraints", "Description"].map((v) =>
          node("th", [text(v)]),
        ),
      ),
    ]),
    node("tbody", [
      node("tr", [
        node("td", [node("code", [text("maxEntries")])]),
        node("td", [text("number")]),
        node("td", [node("code", [text("200")])]),
        node("td", [text("min 10")]),
        node("td", [text("Full explanation. "), link]),
      ]),
    ]),
  ]);
  const tree = {
    type: "root",
    children: [heading("Field reference"), heading("curator"), table],
  };
  referenceSearch()(tree);
  const field = tree.children[2].children[0];
  assert.equal(field.properties.id, "setting-curator.maxEntries");
  assert.equal(field.properties.ariaLabel, "curator.maxEntries");
  assert.equal(field.children[2].children.at(-1), link);
  assert.ok(JSON.stringify(field).includes("200"));
  assert.ok(JSON.stringify(field).includes("min 10"));
});
