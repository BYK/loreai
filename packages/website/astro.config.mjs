import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import { fileURLToPath } from "node:url";
import {
  faviconAssets,
  generateAssetsEagerly,
} from "./integrations/favicon-assets";
import prefixBaseLinks from "./integrations/prefix-base-links.mjs";
import { publicationUri } from "./src/lib/standard-site";

const prNumber = process.env.PR_NUMBER;
const base = prNumber ? `/_preview/pr-${prNumber}/` : "/";

// Run the favicon + OG asset generation synchronously at config-load
// time so the Starlight head array can reference the (content-hashed)
// OG image filename. Without this, the static head array would
// hardcode a stale URL and Cloudflare/validators could cache the
// wrong image indefinitely.
const projectRoot = fileURLToPath(new URL(".", import.meta.url));
const { ogFilename } = await generateAssetsEagerly(projectRoot);

export default defineConfig({
  site: "https://withlore.ai",
  base,
  output: "static",
  trailingSlash: "always",
  outDir: "./dist",
  publicDir: "./public",
  build: {
    format: "directory",
  },
  integrations: [
    // Post-build pass that prefixes internal root-absolute links
    // (`/docs/...`) with `base` so they resolve on PR previews
    // (`/_preview/pr-<n>/`). No-op in production. Covers markdown body,
    // frontmatter hero links, and component links. See prefix-base-links.mjs.
    prefixBaseLinks(),
    faviconAssets(),
    starlight({
      title: "Lore",
      components: {
        Header: "./src/components/SiteHeader.astro",
        MobileMenuFooter: "./src/components/MobileMenuFooter.astro",
      },
      // No `logo` config — SiteHeader.astro renders our <Logo> component
      // (image + HTML text) directly, so Starlight's default SiteTitle is
      // never used.
      customCss: ["./src/styles/starlight.css"],
      pagefind: false,
      lastUpdated: false,
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/byk/loreai",
        },
        { icon: "x.com", label: "X", href: "https://x.com/withLoreAI" },
      ],
      sidebar: [
        {
          label: "Lore",
          items: [
            { label: "Overview", slug: "docs" },
            { label: "Install", slug: "docs/install" },
            { label: "Architecture", slug: "docs/architecture" },
            { label: "Team memory", slug: "docs/team-memory" },
          ],
        },
        {
          label: "Guides",
          items: [
            { label: "OpenCode", slug: "docs/guides/with-opencode" },
            { label: "Pi", slug: "docs/guides/with-pi" },
            { label: "Claude Code", slug: "docs/guides/with-claude-code" },
            { label: "Codex", slug: "docs/guides/with-codex" },
            { label: "Custom upstreams", slug: "docs/guides/custom-upstreams" },
            { label: "Local inference", slug: "docs/guides/local-inference" },
            {
              label: "Semantic linter (CI)",
              slug: "docs/guides/semantic-linter",
            },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "Configuration", slug: "docs/configuration" },
            { label: "Environment variables", slug: "docs/environment" },
            { label: "Setup command", slug: "docs/setup" },
            { label: "Import conversations", slug: "docs/import" },
          ],
        },
      ],
      head: [
        {
          tag: "link",
          attrs: {
            rel: "icon",
            type: "image/svg+xml",
            href: `${base}favicon.svg`,
          },
        },
        {
          tag: "link",
          attrs: {
            rel: "icon",
            type: "image/png",
            sizes: "32x32",
            href: `${base}favicon-32.png`,
          },
        },
        {
          tag: "link",
          attrs: {
            rel: "apple-touch-icon",
            sizes: "180x180",
            href: `${base}apple-touch-icon.png`,
          },
        },
        // RSS feed autodiscovery
        {
          tag: "link",
          attrs: {
            rel: "alternate",
            type: "application/rss+xml",
            title: "Lore Blog",
            href: `https://withlore.ai${base}rss.xml`,
          },
        },
        // standard.site publication discovery hint (verified via
        // /.well-known/site.standard.publication)
        {
          tag: "link",
          attrs: {
            rel: "site.standard.publication",
            href: publicationUri(),
          },
        },
        // Open Graph
        {
          tag: "meta",
          attrs: {
            property: "og:title",
            content: "Lore Documentation",
          },
        },
        {
          tag: "meta",
          attrs: {
            property: "og:description",
            content:
              "Install, operate, and understand Lore's local-first context management and long-term memory for AI coding agents.",
          },
        },
        {
          tag: "meta",
          attrs: {
            property: "og:image",
            content: `https://withlore.ai${base}${ogFilename}`,
          },
        },
        {
          tag: "meta",
          attrs: {
            property: "og:image:width",
            content: "1200",
          },
        },
        {
          tag: "meta",
          attrs: {
            property: "og:image:height",
            content: "630",
          },
        },
        {
          tag: "meta",
          attrs: {
            property: "og:image:alt",
            content: "Lore.AI — Shared Context for AI Agents",
          },
        },
        {
          tag: "meta",
          attrs: {
            property: "og:type",
            content: "website",
          },
        },
        {
          tag: "meta",
          attrs: {
            property: "og:site_name",
            content: "Lore.AI",
          },
        },
        // Twitter Card
        {
          tag: "meta",
          attrs: {
            name: "twitter:card",
            content: "summary_large_image",
          },
        },
        {
          tag: "meta",
          attrs: {
            name: "twitter:title",
            content: "Lore Documentation",
          },
        },
        {
          tag: "meta",
          attrs: {
            name: "twitter:description",
            content:
              "Install, operate, and understand Lore's local-first context management and long-term memory for AI coding agents.",
          },
        },
        {
          tag: "meta",
          attrs: {
            name: "twitter:image",
            content: `https://withlore.ai${base}${ogFilename}`,
          },
        },
        {
          tag: "meta",
          attrs: {
            name: "twitter:site",
            content: "@withLoreAI",
          },
        },
        // Mermaid (architecture diagrams). Loaded from jsdelivr ESM build
        // and rendered client-side. Starlight's expressive-code wraps
        // fenced code blocks in styled <div>s without preserving line
        // breaks in textContent, so we extract the source per-line from
        // the .ec-line divs and call mermaid.render() directly. Mermaid's
        // "neutral" theme is a safe default for both light and dark
        // Starlight themes; theme-aware switching (reading
        // document.documentElement.dataset.theme) is a follow-up. The
        // version is pinned to an exact release for reproducible diagram
        // output; SRI is not used because integrity hashes do not apply to
        // bare ESM `import` URLs, and the render call already degrades
        // gracefully to the source text on failure (see the catch below).
        {
          tag: "script",
          attrs: { type: "module" },
          content: [
            'import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11.16.0/dist/mermaid.esm.min.mjs";',
            'mermaid.initialize({ startOnLoad: false, theme: "neutral", securityLevel: "loose", fontFamily: "var(--sl-font)" });',
            "const blocks = document.querySelectorAll('pre[data-language=\"mermaid\"]');",
            "for (const pre of blocks) {",
            "  const source = Array.from(pre.querySelectorAll('.ec-line')).map((l) => l.textContent).join('\\n');",
            "  if (!source.trim()) continue;",
            "  const id = 'mermaid-' + Math.random().toString(36).slice(2, 9);",
            "  try {",
            "    const { svg } = await mermaid.render(id, source);",
            "    const wrap = document.createElement('div');",
            "    wrap.className = 'mermaid';",
            "    wrap.innerHTML = svg;",
            "    pre.replaceWith(wrap);",
            "  } catch (err) {",
            "    console.error('Mermaid render failed:', err);",
            "    pre.textContent = source;",
            "  }",
            "}",
          ].join("\n"),
        },
      ],
    }),
  ],
});
