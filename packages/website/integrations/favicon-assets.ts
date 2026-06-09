/**
 * Astro integration: generate favicon assets at build/dev time from the
 * source-of-truth logo SVGs in src/assets/logo/. No checked-in raster
 * artifacts — the integration writes favicon.svg, favicon-32.png, and
 * apple-touch-icon.png into public/ on every `astro dev` and `astro build`.
 *
 * Source of truth: src/assets/logo/favicon.svg (light-variant lily on
 * transparent, with embedded <style> + @media (prefers-color-scheme: dark)
 * for adaptive color in Firefox/Chrome/Safari).
 *
 * The PNG outputs are rasterized from the dark variant which reads well on
 * the default light browser tab; for dark mode, the SVG swap handles it.
 */
import type { AstroIntegration } from "astro";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { optimize as svgoOptimize } from "svgo";

const SOURCE = "favicon.svg";
const FAVICON_SVG = "favicon.svg";
const PNG_SOURCE = "loreai-dark.svg";
const PNG_TARGETS = [
  { file: "favicon-32.png", size: 32 },
  { file: "apple-touch-icon.png", size: 180 },
] as const;

const OG_IMAGE = "og-image.png";
const OG_WIDTH = 1200;
const OG_HEIGHT = 630;
const OG_LOGO_HEIGHT = 180;
// Headline + tagline baked into the OG image so social previews show a
// scannable, click-driving message rather than a bare logo. The "Use with
// any agent" line doubles as a CTA — pointing at the proxy that runs
// alongside any AI agent (Claude Code, Codex, Pi, OpenCode, etc.).
const OG_HEADLINE = "Shared context for AI agents";
const OG_TAGLINE = "Local-first. Any agent. Zero setup.";

const svgoConfig = {
  multipass: true,
  js2svg: { pretty: false },
  plugins: [
    {
      name: "preset-default",
      params: {
        overrides: {
          // Keep viewBox for scaling, drop width/height.
          removeViewBox: false,
          // Keep <title>/<desc> for a11y.
          removeTitle: false,
          removeDesc: false,
          // Don't inline <style> rules — the favicon uses
          // @media (prefers-color-scheme) which breaks when inlined.
          inlineStyles: false,
        },
      },
    },
    "removeDimensions",
    "sortAttrs",
    "cleanupIds",
  ],
};

async function generate(root: string): Promise<void> {
  const logoDir = resolve(root, "src/assets/logo");
  const publicDir = resolve(root, "public");
  await mkdir(publicDir, { recursive: true });

  // 1. Generate favicon.svg (with embedded prefers-color-scheme style)
  const svgRaw = await readFile(resolve(logoDir, SOURCE), "utf8");
  const svgResult = svgoOptimize(svgRaw, svgoConfig);
  if (!("data" in svgResult)) {
    throw new Error(`[favicon-assets] SVGO produced no output for ${SOURCE}`);
  }
  await writeFile(resolve(publicDir, FAVICON_SVG), svgResult.data);

  // 2. Generate PNGs from the dark-variant SVG (cream on transparent, reads
  //    well on default light browser tabs; SVG handles dark mode via CSS).
  const pngRaw = await readFile(resolve(logoDir, PNG_SOURCE), "utf8");
  const pngSvgResult = svgoOptimize(pngRaw, svgoConfig);
  if (!("data" in pngSvgResult)) {
    throw new Error(
      `[favicon-assets] SVGO produced no output for ${PNG_SOURCE}`,
    );
  }
  const rasterInput = Buffer.from(pngSvgResult.data);
  for (const { file, size } of PNG_TARGETS) {
    await sharp(rasterInput, { density: 384 })
      .resize(size, size, {
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png({
        palette: true,
        compressionLevel: 9,
        effort: 10,
        quality: 100,
      })
      .toFile(resolve(publicDir, file));
  }

  // 3. Generate og-image.png (1200×630) — dark background, cream lily logo
  //    top-left, and a headline + tagline (CTA) below it. We build the
  //    entire image as a single SVG (background rect, logo image, text
  //    elements) and rasterize once via sharp. Text is rendered using
  //    web-safe SVG <text> attributes (font-family, font-size, font-weight
  //    as separate attributes) — the `font:` shorthand inside a <style>
  //    block isn't reliably parsed by librsvg.
  const logoDataUri = `data:image/svg+xml;base64,${rasterInput.toString("base64")}`;

  const fullSvg = Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg"
         xmlns:xlink="http://www.w3.org/1999/xlink"
         width="${OG_WIDTH}" height="${OG_HEIGHT}">
      <!-- Dark background -->
      <rect width="${OG_WIDTH}" height="${OG_HEIGHT}" fill="#1a3320" />
      <!-- Logo top-left -->
      <image xlink:href="${logoDataUri}"
             x="80" y="80" height="${OG_LOGO_HEIGHT}" />
      <!-- Headline — cream, bold, 72px sans-serif -->
      <text x="80" y="400"
            font-family="Arial, Helvetica, sans-serif"
            font-size="72"
            font-weight="700"
            fill="#f5efe1">${OG_HEADLINE}</text>
      <!-- Tagline (CTA) — sage, medium, 36px sans-serif -->
      <text x="80" y="470"
            font-family="Arial, Helvetica, sans-serif"
            font-size="36"
            font-weight="500"
            fill="#b8c9b8">${OG_TAGLINE}</text>
    </svg>
  `);

  await sharp(fullSvg, { density: 384 })
    .resize(OG_WIDTH, OG_HEIGHT)
    .png({ compressionLevel: 9, effort: 10 })
    .toFile(resolve(publicDir, OG_IMAGE));
}

export function faviconAssets(): AstroIntegration {
  return {
    name: "favicon-assets",
    hooks: {
      "astro:config:setup": async ({ config }) => {
        await generate(fileURLToPath(config.root));
      },
    },
  };
}
