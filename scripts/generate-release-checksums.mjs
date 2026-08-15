#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";

const TARGETS = Object.freeze([
  "lore-darwin-arm64",
  "lore-linux-arm64",
  "lore-linux-x64",
  "lore-windows-x64.exe",
]);

const [rawDirectory, compressedDirectory, outputPath] = process.argv.slice(2);
if (!rawDirectory || !compressedDirectory || !outputPath) {
  console.error(
    "Usage: generate-release-checksums.mjs <raw-dir> <compressed-dir> <output>",
  );
  process.exit(2);
}

async function sha256(path) {
  await access(path);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

const files = TARGETS.flatMap((target) => [
  { name: target, path: join(rawDirectory, target) },
  { name: `${target}.gz`, path: join(compressedDirectory, `${target}.gz`) },
]).sort((left, right) =>
  left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
);

const lines = [];
for (const file of files) {
  lines.push(`${await sha256(file.path)}  ${file.name}`);
}

// Fixed target list, lexical order, lowercase SHA-256, two-space separator,
// and one terminal newline make the metadata byte-for-byte deterministic.
await writeFile(outputPath, `${lines.join("\n")}\n`, { mode: 0o644 });
