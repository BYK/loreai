import { describe, expect, test } from "vitest";
import * as esbuild from "esbuild";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { jsoncParserEsmPlugin } from "../script/jsonc-parser-plugin";

const packageDir = join(fileURLToPath(import.meta.url), "..", "..");
const require = createRequire(import.meta.url);

describe("jsonc-parser bundle resolver", () => {
  test("produces a self-contained Node bundle with working JSONC parsing", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "lore-jsonc-bundle-"));
    const outputFile = join(outputDir, "json-config.cjs");

    try {
      await esbuild.build({
        entryPoints: [join(packageDir, "src/cli/json-config.ts")],
        bundle: true,
        format: "cjs",
        target: "node22",
        platform: "node",
        outfile: outputFile,
        plugins: [jsoncParserEsmPlugin(packageDir)],
      });

      const bundledSource = readFileSync(outputFile, "utf8");
      expect(bundledSource).not.toMatch(/["']\.\/impl\//);

      const bundled = require(outputFile) as {
        parseJsonConfigText(
          text: string,
          file: string,
        ): Record<string, unknown>;
      };
      expect(
        bundled.parseJsonConfigText(
          '{\n  // accepted JSONC\n  "enabled": true,\n}',
          "config.jsonc",
        ),
      ).toEqual({ enabled: true });
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
});
