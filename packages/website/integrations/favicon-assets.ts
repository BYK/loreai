/**
 * Astro integration: generate favicon assets at build/dev time from the
 * source-of-truth logo SVGs in src/assets/logo/. No checked-in raster
 * artifacts — the integration writes favicon.svg, favicon-32.png, and
 * apple-touch-icon.png into public/ on every `astro dev` and `astro build`.
 *
 * Source of truth: src/assets/logo/favicon.svg (cream lily on a dark ink
 * rounded square — reads on both light and dark browser tabs, including
 * Safari's white tab background and Chrome's dark tab background).
 */
import type { AstroIntegration } from "astro";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import { optimize as svgoOptimize } from "svgo";

const SOURCE = "favicon.svg";
const FAVICON_SVG = "favicon.svg";
const PNG_TARGETS = [
  { file: "favicon-32.png", size: 32 },
  { file: "apple-touch-icon.png", size: 180 },
] as const;

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
        },
      },
    },
    "removeDimensions",
    "sortAttrs",
    "cleanupIds",
  ],
};

async function generate(root: string): Promise<void> {
  const sourcePath = resolve(root, "src/assets/logo", SOURCE);
  const publicDir = resolve(root, "public");
  await mkdir(publicDir, { recursive: true });

  const raw = await readFile(sourcePath, "utf8");

  const svgResult = svgoOptimize(raw, svgoConfig);
  if (!("data" in svgResult)) {
    throw new Error(`[favicon-assets] SVGO produced no output for ${sourcePath}`);
  }
  const optimizedSvg = svgResult.data;
  await writeFile(resolve(publicDir, FAVICON_SVG), optimizedSvg);

  const rasterInput = Buffer.from(optimizedSvg);
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
}

export function faviconAssets(): AstroIntegration {
  return {
    name: "favicon-assets",
    hooks: {
      "astro:config:setup": async ({ config }) => {
        await generate(config.root.pathname);
      },
    },
  };
}
