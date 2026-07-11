#!/usr/bin/env node
/**
 * Verify OG / Twitter Card meta tags across all built website pages.
 *
 * Builds the website (if dist/ is missing) and asserts every HTML page
 * has the required social-sharing meta tags. Exits 1 with a list of
 * missing/incorrect tags on the first failure.
 *
 * Mirrors the `check-docs` / `check-links` pattern: self-gated,
 * deterministic, runs in CI on every change to the website.
 *
 * Required tags on every page (per the site's social-meta plan):
 *   - og:title, og:description, og:image, og:url, og:type, og:site_name
 *   - og:image:width, og:image:height, og:image:alt
 *   - twitter:card, twitter:title, twitter:description, twitter:image,
 *     twitter:site
 *
 * Image sanity:
 *   - og:image and twitter:image must point at ${SITE}/og-image.png
 *     (build-time artifact at packages/website/public/og-image.png)
 *   - og-image.png must exist and be 1200x630
 *
 * Blog posts get og:type=article; everything else is website.
 *
 * Usage:
 *   pnpm run check:social
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SITE_ROOT = resolve(import.meta.dirname, "..");
const DIST_DIR = join(SITE_ROOT, "packages/website/dist");
const PUBLIC_DIR = join(SITE_ROOT, "packages/website/public");
// The OG image is content-hashed at build time (e.g. `og-image-abc12345.png`)
// to bust CDN/validator caches — see integrations/favicon-assets.ts.
// We discover the current filename from public/ rather than hardcoding it.
const OG_IMAGE_GLOB = /^og-image-[a-f0-9]+\.png$/;
const OG_WIDTH = 1200;
const OG_HEIGHT = 630;
const SITE = "https://withlore.ai";

const REQUIRED_OG_TAGS = [
  "og:title",
  "og:description",
  "og:image",
  "og:image:width",
  "og:image:height",
  "og:image:alt",
  "og:url",
  "og:type",
  "og:site_name",
];

const REQUIRED_TWITTER_TAGS = [
  "twitter:card",
  "twitter:title",
  "twitter:description",
  "twitter:image",
  "twitter:site",
];

// ---------------------------------------------------------------------------
// Build (if needed)
// ---------------------------------------------------------------------------

function ensureBuilt() {
  const indexHtml = join(DIST_DIR, "index.html");
  if (existsSync(indexHtml)) return;

  console.log("[check-social] dist/ missing — building website...");
  const result = spawnSync("pnpm", ["run", "site:build"], {
    cwd: SITE_ROOT,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    console.error("[check-social] site build failed");
    process.exit(1);
  }
}

/**
 * Find the current content-hashed OG image filename in public/.
 * Throws if zero or multiple matches — both indicate a build problem.
 */
function findOgImageFilename() {
  const entries = readdirSync(PUBLIC_DIR);
  const matches = entries.filter((e) => OG_IMAGE_GLOB.test(e));
  if (matches.length === 0) {
    throw new Error(
      `no og-image-*.png in ${relative(SITE_ROOT, PUBLIC_DIR)} — did the favicon-assets integration run?`,
    );
  }
  if (matches.length > 1) {
    console.warn(
      `[check-social] note: ${matches.length} og-image-*.png files in public/ (older builds leaked): ${matches.join(", ")}`,
    );
  }
  // Use the freshest (highest hash, since hashes are non-deterministic; the
  // most recently written file is what the current build emitted).
  return matches.sort().pop();
}

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
  return results.sort();
}

// Social previews truncate descriptions around 125 characters on most
// platforms (X, Facebook, LinkedIn) and even sooner on mobile. 200 is the
// absolute upper bound — over that, Twitter drops the description entirely.
const MAX_DESCRIPTION_LENGTH = 200;
const RECOMMENDED_DESCRIPTION_LENGTH = 160;

function extractTags(html) {
  // We pull every <meta ...> tag and key by property (OG) or name (Twitter).
  // Both property and name attributes can be in either order on the tag.
  const metaRegex = /<meta\b([^>]*)\/?>/gi;
  const attributeRegex = /(\w+(?::\w+)?)\s*=\s*["']([^"']*)["']/g;

  const og = {};
  const twitter = {};
  let match;
  while ((match = metaRegex.exec(html)) !== null) {
    const attrs = match[1];
    const map = {};
    let attrMatch;
    while ((attrMatch = attributeRegex.exec(attrs)) !== null) {
      map[attrMatch[1].toLowerCase()] = attrMatch[2];
    }
    const property = map.property?.toLowerCase();
    const name = map.name?.toLowerCase();
    const content = map.content;
    if (property?.startsWith("og:")) og[property] = content;
    if (name?.startsWith("twitter:")) twitter[name] = content;
  }
  return { og, twitter };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function classifyPage(relPath) {
  // Blog posts get og:type=article; everything else (including the blog
  // index listing) is website. With directory-format output the listing is
  // `blog/index.html` and posts are `blog/<slug>/index.html`.
  if (relPath.startsWith("blog/") && relPath !== "blog/index.html") {
    return "article";
  }
  return "website";
}

function validatePage(filePath, expectedImage) {
  const errors = [];
  const html = readFileSync(filePath, "utf8");
  const relPath = relative(DIST_DIR, filePath);
  const { og, twitter } = extractTags(html);

  for (const tag of REQUIRED_OG_TAGS) {
    if (!og[tag]) errors.push(`missing <meta property="${tag}">`);
  }
  for (const tag of REQUIRED_TWITTER_TAGS) {
    if (!twitter[tag]) errors.push(`missing <meta name="${tag}">`);
  }

  // Description length. Social previews truncate around 125 chars;
  // 200 is the hard upper bound. Warn over the recommended, fail over
  // the max.
  if (og["og:description"]) {
    const len = og["og:description"].length;
    if (len > MAX_DESCRIPTION_LENGTH) {
      errors.push(
        `og:description is ${len} chars (max ${MAX_DESCRIPTION_LENGTH}; some platforms will drop it)`,
      );
    } else if (len > RECOMMENDED_DESCRIPTION_LENGTH) {
      errors.push(
        `og:description is ${len} chars (recommended ≤ ${RECOMMENDED_DESCRIPTION_LENGTH} so it doesn't truncate in social previews)`,
      );
    }
  }

  // Image URL must point at the (hashed) og-image on the site origin.
  if (og["og:image"] && og["og:image"] !== expectedImage) {
    errors.push(
      `og:image should be "${expectedImage}" (got "${og["og:image"]}")`,
    );
  }
  if (twitter["twitter:image"] && twitter["twitter:image"] !== expectedImage) {
    errors.push(
      `twitter:image should be "${expectedImage}" (got "${twitter["twitter:image"]}")`,
    );
  }

  // Image dimensions must match the build-time raster.
  if (og["og:image:width"] && og["og:image:width"] !== String(OG_WIDTH)) {
    errors.push(
      `og:image:width should be "${OG_WIDTH}" (got "${og["og:image:width"]}")`,
    );
  }
  if (og["og:image:height"] && og["og:image:height"] !== String(OG_HEIGHT)) {
    errors.push(
      `og:image:height should be "${OG_HEIGHT}" (got "${og["og:image:height"]}")`,
    );
  }
  if (
    twitter["twitter:card"] &&
    twitter["twitter:card"] !== "summary_large_image"
  ) {
    errors.push(
      `twitter:card should be "summary_large_image" (got "${twitter["twitter:card"]}")`,
    );
  }
  if (twitter["twitter:site"] && twitter["twitter:site"] !== "@withLoreAI") {
    errors.push(
      `twitter:site should be "@withLoreAI" (got "${twitter["twitter:site"]}")`,
    );
  }
  if (og["og:site_name"] && og["og:site_name"] !== "Lore.AI") {
    errors.push(
      `og:site_name should be "Lore.AI" (got "${og["og:site_name"]}")`,
    );
  }

  // og:type must match the page kind.
  const expectedType = classifyPage(relPath);
  if (og["og:type"] && og["og:type"] !== expectedType) {
    errors.push(`og:type should be "${expectedType}" (got "${og["og:type"]}")`);
  }

  // og:url should start with the site origin.
  if (og["og:url"] && !og["og:url"].startsWith(`${SITE}/`)) {
    errors.push(`og:url should start with "${SITE}/" (got "${og["og:url"]}")`);
  }

  return { relPath, errors };
}

function validateOgImage(filename) {
  const errors = [];
  const imagePath = join(PUBLIC_DIR, filename);
  if (!existsSync(imagePath)) {
    errors.push(`${relative(SITE_ROOT, imagePath)} does not exist`);
    return errors;
  }
  const stat = statSync(imagePath);
  if (stat.size === 0) {
    errors.push(`${relative(SITE_ROOT, imagePath)} is empty`);
  }
  // Cheap PNG dimension probe — read IHDR width/height (bytes 16-24).
  const buf = readFileSync(imagePath);
  if (
    buf.length < 24 ||
    buf[0] !== 0x89 ||
    buf[1] !== 0x50 ||
    buf[2] !== 0x4e ||
    buf[3] !== 0x47
  ) {
    errors.push(`${relative(SITE_ROOT, imagePath)} is not a valid PNG`);
    return errors;
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width !== OG_WIDTH || height !== OG_HEIGHT) {
    errors.push(
      `${relative(SITE_ROOT, imagePath)} should be ${OG_WIDTH}x${OG_HEIGHT} (got ${width}x${height})`,
    );
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  ensureBuilt();

  const ogFilename = findOgImageFilename();

  const imageErrors = validateOgImage(ogFilename);
  if (imageErrors.length > 0) {
    console.error("[check-social] FAIL: OG image is wrong:");
    for (const err of imageErrors) console.error(`  - ${err}`);
    process.exit(1);
  }

  const expectedImage = `${SITE}/${ogFilename}`;

  const files = listHtmlFiles(DIST_DIR);
  if (files.length === 0) {
    console.error("[check-social] FAIL: no HTML files found in dist/");
    process.exit(1);
  }

  const allErrors = [];
  for (const file of files) {
    const { relPath, errors } = validatePage(file, expectedImage);
    if (errors.length > 0) {
      allErrors.push({ relPath, errors });
    }
  }

  if (allErrors.length > 0) {
    console.error(
      `[check-social] FAIL: ${allErrors.length} page(s) with social-meta issues:`,
    );
    for (const { relPath, errors } of allErrors) {
      console.error(`  ${relPath}:`);
      for (const err of errors) console.error(`    - ${err}`);
    }
    process.exit(1);
  }

  console.log(
    `[check-social] OK: ${files.length} page(s) with complete OG + Twitter Card meta tags.`,
  );
}

try {
  main();
} catch (err) {
  console.error("[check-social] unexpected error:", err);
  process.exit(1);
}
