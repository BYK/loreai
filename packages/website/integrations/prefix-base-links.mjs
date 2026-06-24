// prefix-base-links.mjs
//
// Astro integration that rewrites internal site-root-absolute links
// (`href="/docs/..."`, `src="/..."`) in the final built HTML so they
// include the configured `base` path.
//
// Why this exists:
//   The docs are authored with site-root-absolute links (`/docs/...`),
//   which is the project convention and resolves correctly in production
//   where `base` is `/`. On PR previews the site is served from
//   `/_preview/pr-<n>/`, so a bare `/docs/...` href would 404.
//
//   Astro/Starlight only base-prefix links they generate themselves
//   (asset URLs, slug-based sidebar nav). Links written in markdown bodies
//   AND links defined in frontmatter (e.g. Starlight `hero.actions[].link`)
//   are emitted verbatim. A rehype plugin can reach the markdown body HAST
//   but NOT frontmatter hero links — so a single post-build HTML pass is
//   used here to cover EVERY source uniformly (body, frontmatter, and any
//   hand-written component links).
//
// Safety:
//   - Only runs when a base is configured (PR previews). No-op in
//     production (base `/`), so links are left untouched.
//   - Skips protocol-relative URLs (`//cdn...`) and links already under
//     the base prefix (idempotent — never double-prefixes the links Astro
//     already prefixed).
//   - Operates on the literal `"` form of href/src. Code samples that
//     display HTML are entity-escaped (`&quot;`), so they are not matched.

import { readFile, writeFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const prNumber = process.env.PR_NUMBER;
// No-trailing-slash prefix so `${prefix}${path}` composes cleanly with
// paths that always start with `/`. Empty string => integration is a no-op.
const basePrefix = prNumber ? `/_preview/pr-${prNumber}` : "";

/** Recursively collect every `.html` file under `dir`. */
function listHtmlFiles(dir) {
  const results = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith(".html")) {
        results.push(full);
      }
    }
  }
  return results;
}

/** Rewrite one HTML document's internal root-absolute href/src attrs. */
export function prefixHtml(html, prefix) {
  return html.replace(/(href|src)="(\/[^"]*)"/g, (match, attr, path) => {
    // Protocol-relative URL (`//cdn.example.com/...`) — leave untouched.
    if (path.startsWith("//")) return match;
    // Already under the base prefix — idempotent, don't double-prefix.
    if (path === prefix || path.startsWith(`${prefix}/`)) return match;
    return `${attr}="${prefix}${path}"`;
  });
}

export default function prefixBaseLinks() {
  return {
    name: "prefix-base-links",
    hooks: {
      "astro:build:done": async ({ dir, logger }) => {
        // Production build (base `/`) — nothing to prefix.
        if (!basePrefix) return;

        const outDir = fileURLToPath(dir);
        const files = listHtmlFiles(outDir);
        let rewritten = 0;
        for (const file of files) {
          const html = await readFile(file, "utf8");
          const next = prefixHtml(html, basePrefix);
          if (next !== html) {
            await writeFile(file, next);
            rewritten++;
          }
        }
        logger.info(
          `prefixed internal links with "${basePrefix}" in ${rewritten} file(s)`,
        );
      },
    },
  };
}
