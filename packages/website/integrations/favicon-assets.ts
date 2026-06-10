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
import { createHash } from "node:crypto";
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

// OG image is content-hashed at build time so the URL changes whenever
// the image changes. This busts CDN/validator caches automatically —
// no upstream can serve a stale version, because the URL is different
// for every distinct image content. The hash sidecar
// (src/generated/og-image.json) lets the Astro components import the
// current filename as a normal TS module.
const OG_IMAGE_PREFIX = "og-image";
const OG_IMAGE_EXTENSION = "png";
const OG_WIDTH = 1200;
const OG_HEIGHT = 630;
// Headline + tagline baked into the OG image so social previews show a
// scannable, click-driving message rather than a bare logo. The "Any
// agent" line doubles as a CTA — pointing at the proxy that runs
// alongside any AI agent (Claude Code, Codex, Pi, OpenCode, etc.).
const OG_HEADLINE = "Shared context for AI agents";
const OG_TAGLINE = "Local-first. Any agent. Never compacted.";
const OG_CTA = "→ withlore.ai";
// Dark green background (site's --g0) and high-contrast text colors.
// The tagline uses a brighter sage than the brand --g2 so it stays
// legible against the dark background without being harsh. The CTA
// reuses the headline cream so it competes for attention rather than
// blending into the sage palette.
const OG_BG_COLOR = "#1a3320";
const OG_HEADLINE_COLOR = "#f5efe1"; // cream (site's --g5)
const OG_TAGLINE_COLOR = "#d8e4d8"; // bright sage, higher contrast than --g2

// Path to the JSON sidecar that exposes the current hashed filename to
// Astro components. Lives in src/ so Astro bundles it (no runtime fetch,
// no public-cache problem). Gitignored — regenerated on every build.
const OG_IMAGE_MANIFEST = "src/generated/og-image.json";
const OG_IMAGE_MANIFEST_DIR = "src/generated";

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

/**
 * Hash the OG image and write it as og-image-{hash}.png into public/.
 * The hash is content-derived, so any change to the image produces a
 * new URL — no upstream cache (CDN, validator, scraper) can serve a
 * stale version of the wrong image.
 */
async function writeOgImage(publicDir: string, buf: Buffer): Promise<string> {
  const hash = createHash("sha256").update(buf).digest("hex").slice(0, 8);
  const file = `${OG_IMAGE_PREFIX}-${hash}.${OG_IMAGE_EXTENSION}`;
  await writeFile(resolve(publicDir, file), buf);
  return file;
}

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

  // 3. Generate the OG image (1200×630) — vertical stack:
  //    small logo top-left, headline below (full-width, no overlap),
  //    tagline below that, CTA at the bottom. Built as a single SVG
  //    and rasterized via sharp; text uses individual font-* attributes
  //    (librsvg drops the `font:` shorthand inside <style> blocks).
  const logoDataUri = `data:image/svg+xml;base64,${rasterInput.toString("base64")}`;

  // Safe-area padding matches social card conventions (Twitter/Facebook
  // crop ~5% off each side). Logo is small and isolated in the upper
  // left, headline gets the visual weight of the card.
  const padX = 90;
  const logoSize = 100;
  const headlineSize = 64;
  const taglineSize = 36;
  const ctaSize = 40;

  // Vertical layout (all in px from top of canvas):
  //   y=70           logo top
  //   y=290          headline baseline (well below logo)
  //   y=370          tagline baseline
  //   y=510          CTA baseline
  const logoY = 70;
  const headlineY = 290;
  const taglineY = 370;
  const ctaY = 510;

  const fullSvg = Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg"
         xmlns:xlink="http://www.w3.org/1999/xlink"
         width="${OG_WIDTH}" height="${OG_HEIGHT}">
      <!-- Dark background -->
      <rect width="${OG_WIDTH}" height="${OG_HEIGHT}" fill="${OG_BG_COLOR}" />
      <!-- Logo top-left, wrapped in a <g transform> because sharp's
           librsvg backend silently ignores x/y on <image> elements
           with data: URIs. We also have to set BOTH width and height
           explicitly: when only height is set, librsvg computes the
           proportional width from the source viewBox and centers the
           image horizontally. -->
      <g transform="translate(${padX}, ${logoY})">
        <image xlink:href="${logoDataUri}"
               width="${logoSize}" height="${logoSize}" />
      </g>
      <!-- Headline — cream, bold, full-width (no logo overlap) -->
      <text x="${padX}" y="${headlineY}"
            font-family="Arial, Helvetica, sans-serif"
            font-size="${headlineSize}"
            font-weight="700"
            fill="${OG_HEADLINE_COLOR}">${OG_HEADLINE}</text>
      <!-- Tagline — bright sage, medium -->
      <text x="${padX}" y="${taglineY}"
            font-family="Arial, Helvetica, sans-serif"
            font-size="${taglineSize}"
            font-weight="500"
            fill="${OG_TAGLINE_COLOR}">${OG_TAGLINE}</text>
      <!-- CTA — cream, bold; the click-driving element -->
      <text x="${padX}" y="${ctaY}"
            font-family="Arial, Helvetica, sans-serif"
            font-size="${ctaSize}"
            font-weight="700"
            fill="${OG_HEADLINE_COLOR}">${OG_CTA}</text>
    </svg>
  `);

  const ogBuffer = await sharp(fullSvg, { density: 384 })
    .resize(OG_WIDTH, OG_HEIGHT)
    .png({ compressionLevel: 9, effort: 10 })
    .toBuffer();

  const ogFilename = await writeOgImage(publicDir, ogBuffer);

  // Write a tiny JSON sidecar that exposes the current hashed filename
  // to Astro components as a normal TS module. Lives in src/ so Astro
  // bundles it (no public-cache problem). Gitignored — regenerated on
  // every build alongside the PNG itself.
  const generatedDir = resolve(root, OG_IMAGE_MANIFEST_DIR);
  await mkdir(generatedDir, { recursive: true });
  await writeFile(
    resolve(root, OG_IMAGE_MANIFEST),
    `${JSON.stringify({ filename: ogFilename }, null, 2)}\n`,
  );
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

/**
 * Eagerly generate the favicon + OG assets and return the OG image's
 * hashed filename. astro.config.mjs calls this at the top of the file
 * so the Starlight `head` array (which is evaluated synchronously at
 * config-load time) can reference the same hashed URL that the rest
 * of the build uses.
 */
export async function generateAssetsEagerly(
  root: string,
): Promise<{ ogFilename: string }> {
  await generate(root);
  // The manifest file is now on disk — re-read it instead of plumbing
  // the value back, since astro.config.mjs may be loaded before/after
  // the integration hook depending on how astro evaluates the config.
  const { readFile } = await import("node:fs/promises");
  const manifest = JSON.parse(
    await readFile(resolve(root, OG_IMAGE_MANIFEST), "utf8"),
  );
  return { ogFilename: manifest.filename };
}
