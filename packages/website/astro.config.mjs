import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

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
    starlight({
      title: "Lore",
      components: {
        Header: "./src/components/SiteHeader.astro",
        MobileMenuFooter: "./src/components/MobileMenuFooter.astro",
      },
      logo: {
        light: "./public/brand-mark-light.svg",
        dark: "./public/brand-mark.svg",
        alt: "Lore.AI",
        replacesTitle: true,
      },
      favicon: `${base}favicon.svg`,
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
      ],
      head: [
        {
          tag: "link",
          attrs: { rel: "icon", href: `${base}favicon.ico`, sizes: "any" },
        },
        {
          tag: "link",
          attrs: {
            rel: "apple-touch-icon",
            href: `${base}apple-touch-icon.png`,
          },
        },
      ],
    }),
  ],
});
