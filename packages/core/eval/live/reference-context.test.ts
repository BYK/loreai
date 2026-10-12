import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderReferenceContext } from "./reference-context.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("tool-readable workflow references", () => {
  it("puts necessary source contracts in bounded artifacts, not repeated prompt filler", () => {
    const task = JSON.parse(
      fs.readFileSync(path.join(here, "task-iterative-orders.json"), "utf8"),
    );
    const turns = task.sessions[0].turns;
    for (const turn of turns) {
      const reference = renderReferenceContext(turn);
      expect(Buffer.byteLength(reference)).toBe(90 * 1024);
      expect(reference).toContain(
        `## Change contract\n${turn.toolContext.spec}`,
      );
      expect(reference).toContain("SKU-000000");
      expect(reference).toContain("SKU-000100");
      expect(reference).not.toContain("STATUS-ONE");
    }
    expect(turns[2].prompt).not.toContain("799");
    expect(renderReferenceContext(turns[2])).toContain(
      "REMOTE costs 799 cents",
    );
    expect(turns[4].toolContext.spec).not.toContain("{{fact.status}}");
  });
});
