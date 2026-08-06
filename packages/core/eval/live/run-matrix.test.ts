import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("matrix runner", () => {
  it("forwards an explicit OpenCode executable to every driver cell", () => {
    const source = fs.readFileSync(path.join(here, "run-matrix.mjs"), "utf8");
    expect(source).toContain(
      '...(args.opencode ? ["--opencode", args.opencode] : []),',
    );
  });
});
