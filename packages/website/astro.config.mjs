import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import { faviconAssets } from "./integrations/favicon-assets";

const prNumber = process.env.PR_NUMBER;
const base = prNumber ? `/_preview/pr-${prNumber}/` : "/";

export default defineConfig({
  site: "https://withlore.ai",
  base,
  output: "static",
  outDir: "./dist",
  publicDir: "./public",
  build: {
    format: "file",
  },
  integrations: [
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
          ],
        },
        {
          label: "Guides",
          items: [
            { label: "OpenCode", slug: "docs/guides/with-opencode" },
            { label: "Pi", slug: "docs/guides/with-pi" },
            { label: "Claude Code", slug: "docs/guides/with-claude-code" },
            { label: "Codex", slug: "docs/guides/with-codex" },
            { label: "Setup command", slug: "docs/setup" },
            { label: "Custom upstreams", slug: "docs/guides/custom-upstreams" },
            { label: "Local inference", slug: "docs/guides/local-inference" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "Configuration", slug: "docs/configuration" },
            { label: "Environment variables", slug: "docs/environment" },
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
      ],
    }),
  ],
});
