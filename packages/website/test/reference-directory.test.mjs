import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildReferenceDirectory } from "../src/lib/reference-directory.ts";

await test("nested names retain their real parent anchors and ignore fenced examples", () => {
  const headings = [
    { depth: 2, text: "Field reference", slug: "field-reference" },
    { depth: 2, text: "knowledge", slug: "knowledge" },
    { depth: 3, text: "search.embeddings", slug: "searchembeddings" },
  ];
  const body =
    "## Field reference\n## `knowledge`\n| `enabled` | boolean |\n```md\n## `fake`\n| `leaked` | boolean |\n```\n### `search.embeddings`\n| `model` | string |\n";
  const { settings, categories } = buildReferenceDirectory(
    body,
    headings,
    "configuration",
  );
  assert.ok(
    settings.some(
      (e) => e.label === "knowledge.enabled" && e.slug === "knowledge",
    ),
  );
  assert.ok(
    settings.some(
      (e) =>
        e.label === "search.embeddings.model" && e.slug === "searchembeddings",
    ),
  );
  assert.ok(!settings.some((e) => e.label.includes("leaked")));
  assert.equal(categories.length, 2);
});

await test("every generated setting and variable row is discoverable", () => {
  for (const kind of ["configuration", "environment"]) {
    const body = readFileSync(
      new URL(`../src/content/docs/docs/${kind}.md`, import.meta.url),
      "utf8",
    );
    const headings = [...body.matchAll(/^(#{2,3}) (.+)$/gm)].map((m, i) => ({
      depth: m[1].length,
      text: m[2].replaceAll("`", ""),
      slug: `heading-${i}`,
    }));
    // Use stable known reference roots; subsequent target IDs come from headings.
    const root = headings.find(
      (h) =>
        h.text ===
        (kind === "configuration" ? "Field reference" : "Setting reference"),
    );
    root.slug =
      kind === "configuration" ? "field-reference" : "setting-reference";
    const { settings, categories } = buildReferenceDirectory(
      body,
      headings,
      kind,
    );
    assert.ok(settings.length > 30);
    assert.ok(categories.length > 10);
    // Independently enumerate the first cell rather than reproducing the indexer's matcher.
    const reference = body.slice(
      body.indexOf(
        kind === "configuration"
          ? "## Field reference"
          : "## Setting reference",
      ),
    );
    const keys = reference
      .split("\n")
      .filter((line) => line.startsWith("|"))
      .map((line) => line.split("|")[1]?.match(/`([^`]+)`/)?.[1])
      .filter((key) => key && /^[A-Za-z_][A-Za-z0-9_.]*$/.test(key));
    if (kind === "environment") {
      assert.ok(keys.includes("LORE_LISTEN_PORT"));
      assert.equal(
        settings.filter((e) => /^[A-Z][A-Z0-9_]+$/.test(e.label)).length,
        new Set(keys).size,
      );
    }
    for (const key of keys)
      assert.ok(
        settings.some((e) => e.label === key || e.label.endsWith("." + key)),
        `${kind}: ${key}`,
      );
    for (const entry of settings)
      assert.ok(
        headings.some((h) => h.slug === entry.slug),
        entry.label,
      );
    assert.equal(new Set(settings.map((e) => e.label)).size, settings.length);
  }
});

await test("environment metadata in the first table cell does not hide a variable", () => {
  const body =
    "## Setting reference\n## Startup\n| Variable | Description |\n| `LORE_LISTEN_PORT`<br>**Default:** `6767` | Server port |\n| `LORE_WORKER_API_KEY`<br>**Default:** unset | Worker credential |\n";
  const headings = [
    { depth: 2, text: "Setting reference", slug: "setting-reference" },
    { depth: 2, text: "Startup", slug: "startup" },
  ];
  const { settings } = buildReferenceDirectory(body, headings, "environment");
  assert.deepEqual(
    settings
      .filter((e) => e.label.startsWith("LORE_"))
      .map((e) => ({ label: e.label, slug: e.slug })),
    [
      { label: "LORE_LISTEN_PORT", slug: "startup" },
      { label: "LORE_WORKER_API_KEY", slug: "startup" },
    ],
  );
});

await test("reference descriptions are plain text from real table cells and category prose", () => {
  const body =
    "## Field reference\n## `knowledge`\nLong-term knowledge controls.\n| Field | Type | Default | Constraints | Description |\n|---|---|---|---|---|\n| `enabled` | boolean | true | | Enable **curated** [knowledge](/docs/memory/) and <em>recall</em>. |\n";
  const headings = [
    { depth: 2, text: "Field reference", slug: "field-reference" },
    { depth: 2, text: "knowledge", slug: "knowledge" },
  ];
  const { settings } = buildReferenceDirectory(body, headings, "configuration");
  assert.equal(
    settings.find((e) => e.label === "knowledge").description,
    "Long-term knowledge controls.",
  );
  assert.equal(
    settings.find((e) => e.label === "knowledge.enabled").description,
    "Enable curated knowledge and recall.",
  );
});

await test("description formatting keeps code identifiers and escaped pipes intact", () => {
  const body =
    "## Setting reference\n## Startup\n| Variable | Description |\n| `LORE_TEST` | Keep `SQLITE_BUSY` and A\\|B visible. |\n";
  const { settings } = buildReferenceDirectory(
    body,
    [
      { depth: 2, text: "Setting reference", slug: "setting-reference" },
      { depth: 2, text: "Startup", slug: "startup" },
    ],
    "environment",
  );
  assert.equal(
    settings.find((e) => e.label === "LORE_TEST").description,
    "Keep SQLITE_BUSY and A|B visible.",
  );
});
