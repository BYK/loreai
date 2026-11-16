import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import searchContent, {
  excludeDiagramSource,
} from "../integrations/search-content.mjs";

await test("final Expressive Code sources are ignored without hiding captions, assets or ordinary code", () => {
  const html =
    '<div class="expressive-code"><link rel="stylesheet" href="/_astro/ec.css"><figure class="frame"><figcaption>Context flow</figcaption><pre data-language="mermaid"><code>classDef search fill:#fff</code></pre></figure></div><pre data-language="bash"><code>lore start</code></pre>';
  const result = excludeDiagramSource(html);
  assert.equal(
    result,
    html.replace(
      '<pre data-language="mermaid">',
      '<pre data-language="mermaid" data-pagefind-ignore>',
    ),
  );
  assert.equal(excludeDiagramSource(result), result);
  assert.equal(
    excludeDiagramSource(
      "<pre data-language='mermaid' data-pagefind-ignore='all'>source</pre>",
    ),
    "<pre data-language='mermaid' data-pagefind-ignore='all'>source</pre>",
  );
  assert.equal(
    excludeDiagramSource('&lt;pre data-language="mermaid"&gt;'),
    '&lt;pre data-language="mermaid"&gt;',
  );
});

await test("the pre-index build hook handles nested public and docs HTML while preserving other files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lore-search-content-"));
  try {
    await mkdir(join(dir, "docs"));
    const source =
      '<p>Searchable explanation</p><pre data-language="mermaid">graph LR</pre>';
    await writeFile(join(dir, "index.html"), source);
    await writeFile(join(dir, "docs", "index.html"), source);
    await writeFile(join(dir, "readme.txt"), source);
    await searchContent().hooks["astro:build:done"]({
      dir: pathToFileURL(dir + "/"),
    });
    for (const path of ["index.html", "docs/index.html"])
      assert.equal(
        await readFile(join(dir, path), "utf8"),
        excludeDiagramSource(source),
      );
    assert.equal(await readFile(join(dir, "readme.txt"), "utf8"), source);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
