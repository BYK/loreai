import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { LoreConfig } from "../../core/src/config.ts";
import { COMMON_SETTING_EXAMPLES } from "../src/lib/reference-examples.ts";
import { buildReferenceDirectory } from "../src/lib/reference-directory.ts";

await test("common examples validate against the real schema and resolve to generated reference fields", () => {
  const body = readFileSync(
    new URL("../src/content/docs/docs/configuration.md", import.meta.url),
    "utf8",
  );
  const headings = [...body.matchAll(/^(#{2,3}) (.+)$/gm)].map((match, i) => ({
    depth: match[1].length,
    text: match[2].replaceAll("`", ""),
    slug: match[2] === "Field reference" ? "field-reference" : `section-${i}`,
  }));
  const directory = buildReferenceDirectory(body, headings, "configuration");
  for (const example of COMMON_SETTING_EXAMPLES) {
    const parsed = LoreConfig.parse(example.value);
    assert.ok(
      directory.settings.some(
        (entry) => entry.slug === `setting-${example.path}`,
      ),
      example.path,
    );
    const parts = example.path.split(".");
    const actual = parts.reduce((value, part) => value[part], parsed);
    const expected = parts.reduce((value, part) => value[part], example.value);
    assert.equal(
      actual,
      expected,
      `${example.path} must survive configuration validation`,
    );
  }
});
