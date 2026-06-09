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
  //    top-left, and a headline + tagline (CTA) below it. Text is built
  //    into an SVG and rasterized so we get clean type without needing to
  //    bundle a font.
  const logoForOg = await sharp(rasterInput, { density: 384 })
    .resize({
      height: OG_LOGO_HEIGHT,
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();

  // SVG with the headline + tagline baked in. The font stack ends with
  // generic sans-serif so the rasterizer falls back gracefully on any
  // system — Inter, SF Pro, Segoe UI, Roboto, Helvetica, etc.
  const textSvg = Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="${OG_WIDTH}" height="${OG_HEIGHT}">
      <style>
        .headline {
          font: 700 64px -apple-system, BlinkMacSystemFont, "Segoe UI",
            Roboto, "Helvetica Neue", Arial, sans-serif;
          fill: #f5efe1;
        }
        .tagline {
          font: 500 32px -apple-system, BlinkMacSystemFont, "Segoe UI",
            Roboto, "Helvetica Neue", Arial, sans-serif;
          fill: #b8c9b8;
        }
      </style>
      <text x="80" y="200" class="headline">${OG_HEADLINE}</text>
      <text x="80" y="260" class="tagline">${OG_TAGLINE}</text>
    </svg>
  `);
  const textRaster = await sharp(textSvg)
    .resize(OG_WIDTH, OG_HEIGHT)
    .png()
    .toBuffer();

  await sharp({
    create: {
      width: OG_WIDTH,
      height: OG_HEIGHT,
      channels: 4,
      background: { r: 26, g: 51, b: 32, alpha: 255 }, // #1a3320 (site's --g0)
    },
  })
    .composite([
      // Logo top-left
      { input: logoForOg, top: 80, left: 80 },
      // Headline + tagline below logo
      { input: textRaster, top: 0, left: 0 },
    ])
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
