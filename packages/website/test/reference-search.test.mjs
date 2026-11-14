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
