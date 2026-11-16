import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Expressive Code replaces the Markdown <pre>, discarding earlier HAST attributes.
// Mark the final source blocks before Starlight builds its Pagefind index instead.
export function excludeDiagramSource(html) {
  return html.replace(
    /<pre\b[^>]*\bdata-language=("|')mermaid\1[^>]*>/g,
    (tag) =>
      /\bdata-pagefind-ignore(?:\s|=|>)/.test(tag)
        ? tag
        : tag.replace(/>$/, " data-pagefind-ignore>"),
  );
}

export default function searchContent() {
  return {
    name: "lore-search-content",
    hooks: {
      "astro:build:done": async ({ dir }) => {
        async function visit(directory) {
          for (const entry of await readdir(directory, {
            withFileTypes: true,
          })) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) await visit(path);
            else if (entry.isFile() && entry.name.endsWith(".html")) {
              const source = await readFile(path, "utf8");
              const result = excludeDiagramSource(source);
              if (source !== result) await writeFile(path, result);
            }
          }
        }
        await visit(fileURLToPath(dir));
      },
    },
  };
}
