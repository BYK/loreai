import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import { SETUP_AGENTS } from "../src/lib/agent-setup.ts";
await test("every website launch command uses the actual registered client binary", () => {
  const text = readFileSync(
      new URL("../../gateway/src/cli/agents.ts", import.meta.url),
      "utf8",
    ),
    source = ts.createSourceFile(
      "agents.ts",
      text,
      ts.ScriptTarget.Latest,
      true,
    );
  let registry;
  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(source) === "AGENTS"
    )
      registry = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(registry && ts.isArrayLiteralExpression(registry));
  const clients = new Map(
    registry.elements.map((object) => {
      const fields = new Map(
        object.properties
          .filter(ts.isPropertyAssignment)
          .map((property) => [
            property.name.getText(source),
            property.initializer,
          ]),
      );
      return [fields.get("name").text, fields.get("binary").text];
    }),
  );
  for (const agent of SETUP_AGENTS)
    for (const line of agent.command.split("\n")) {
      if (line.startsWith("lore run ")) {
        const id = agent.id === "codex-desktop" ? "codex" : agent.id;
        assert.equal(
          line.split(" ")[2],
          clients.get(id),
          `${agent.name} must launch its binary`,
        );
      }
      if (line.startsWith("lore setup "))
        assert.ok(clients.has(line.split(" ")[2]));
    }
});
