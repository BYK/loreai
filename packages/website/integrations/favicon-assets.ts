/**
 * Astro integration: generate favicon assets at build/dev time from the
 * source-of-truth logo SVGs in src/assets/logo/. No checked-in raster
 * artifacts — the integration writes favicon.svg, favicon-32.png, and
 * apple-touch-icon.png for both light and dark color-schemes on every
 * `astro dev` and `astro build`.
 *
 * Source of truth:
 *   - src/assets/logo/loreai.svg     (dark lily — for light backgrounds)
 *   - src/assets/logo/loreai-dark.svg (cream lily — for dark backgrounds)
 *
 * Layout files pair these with `media="(prefers-color-scheme: light|dark)"`
 * link tags so the favicon adapts to the user's color-scheme preference.
 */
import type { AstroIntegration } from "astro";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import { optimize as svgoOptimize } from "svgo";

type Variant = {
  /** Source SVG file name in src/assets/logo/ */
  source: string;
  /** Output SVG file name in public/ */
  svgOut: string;
  /** PNG outputs in public/ (each as favicon file and apple-touch-icon file) */
  pngOuts: ReadonlyArray<{ file: string; size: number }>;
};

const VARIANTS: readonly Variant[] = [
  {
    source: "loreai.svg",
    svgOut: "favicon.svg",
    pngOuts: [
      { file: "favicon-32.png", size: 32 },
      { file: "apple-touch-icon.png", size: 180 },
    ],
  },
  {
    source: "loreai-dark.svg",
    svgOut: "favicon-dark.svg",
    pngOuts: [
      { file: "favicon-dark-32.png", size: 32 },
      { file: "apple-touch-icon-dark.png", size: 180 },
    ],
  },
];

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
  const logoDir = resolve(root, "src/assets/logo");
  const publicDir = resolve(root, "public");
  await mkdir(publicDir, { recursive: true });

  for (const variant of VARIANTS) {
    const sourcePath = resolve(logoDir, variant.source);
    const raw = await readFile(sourcePath, "utf8");

    const svgResult = svgoOptimize(raw, svgoConfig);
    if (!("data" in svgResult)) {
      throw new Error(
        `[favicon-assets] SVGO produced no output for ${sourcePath}`,
      );
    }
    const optimizedSvg = svgResult.data;
    await writeFile(resolve(publicDir, variant.svgOut), optimizedSvg);

    const rasterInput = Buffer.from(optimizedSvg);
    for (const { file, size } of variant.pngOuts) {
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
