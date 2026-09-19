#!/usr/bin/env node
/**
 * Seeds the e2e gateway's database (LORE_DB_PATH) with two projects and a
 * handful of knowledge entries through @loreai/core's public API — the same
 * write path the curator uses — so the specs browse real rows via /api/v1.
 *
 * Usage: node e2e/seed.mjs <projects-root>
 */
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const core = require(
  join(here, "..", "..", "core", "dist", "node", "index.js"),
);

const root = process.argv[2];
if (!root) throw new Error("usage: seed.mjs <projects-root>");
if (!process.env.LORE_DB_PATH) throw new Error("LORE_DB_PATH must be set");

const lore = join(root, "lore");
const scratch = join(root, "scratch");
mkdirSync(lore, { recursive: true });
mkdirSync(scratch, { recursive: true });

core.ensureProject(lore, "lore", "github.com/BYK/loreai");
core.ensureProject(scratch, "scratch", null);

const entries = [
  {
    category: "decision",
    title: "Keep SQLite as the only store",
    content:
      "Portability is a requirement: a single-file SQLite database with WAL mode and FTS5 stays the authoritative store.\n\nNo remote cache service; the browser UI is a read projection.",
    confidence: 0.92,
  },
  {
    category: "gotcha",
    title: "Management routes hide behind a bodyless 404",
    content:
      "Non-loopback peers get an empty 404 for /api and /ui unless LORE_ALLOW_REMOTE_MANAGEMENT is enabled. Clients must treat that as unauthorized, not as a missing route.",
    confidence: 0.8,
  },
  {
    category: "architecture",
    title: "Gateway serves the SPA from embedded assets",
    content:
      "The UI build is embedded into the gateway bundle at build time; index.html is served with no-cache and hashed assets with immutable caching.",
    confidence: 0.7,
    crossProject: true,
  },
];

for (const entry of entries) {
  core.ltm.create({ ...entry, projectPath: lore, scope: "project" });
}
core.ltm.create({
  projectPath: scratch,
  scope: "project",
  category: "preference",
  title: "Prefer terse commit messages",
  content: "Conventional commits, one line, no trailing period.",
  confidence: 0.6,
});

core.close();
console.log(
  `seeded ${entries.length + 1} knowledge entries into ${process.env.LORE_DB_PATH}`,
);
// Core keeps worker pools / maintenance timers alive; the DB is closed, so exit.
process.exit(0);
