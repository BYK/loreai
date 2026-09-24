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
import { DatabaseSync } from "node:sqlite";
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
const scratchProjectId = core.ensureProject(scratch, "scratch", null);

const entries = [
  {
    category: "decision",
    title: "Keep SQLite as the only store",
    content:
      "Portability is a requirement: a single-file SQLite database with WAL mode and FTS5 stays the authoritative store.\n\nNo remote cache service; the browser UI is a read projection.\n\n" +
      "SQLite remains the authoritative store for deterministic local-first memory. ".repeat(
        220,
      ),
    confidence: 0.92,
    session: "e2e-session-sqlite",
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
  {
    category: "pattern",
    title: "Validate contracts at the edge",
    content: "Parse every gateway response before it reaches a view.",
    confidence: 0.86,
  },
  {
    category: "preference",
    title: "Prefer explicit route state",
    content: "Keep filters and cursors in the URL so views survive reloads.",
    confidence: 0.78,
  },
  {
    category: "decision",
    title: "Use cursor pagination",
    content:
      "Large project collections use opaque cursors rather than offsets.",
    confidence: 0.82,
  },
  {
    category: "gotcha",
    title: "Do not filter cached pages in the browser",
    content:
      "Filtered and sorted pages are authoritative only when returned by the server.",
    confidence: 0.88,
  },
  {
    category: "architecture",
    title: "Keep the gateway as data authority",
    content:
      "The browser cache is a stale read projection and never a write source.",
    confidence: 0.84,
  },
  {
    category: "pattern",
    title: "Encode query pieces explicitly",
    content:
      "URL query values use deterministic percent encoding for stable requests.",
    confidence: 0.74,
  },
  {
    category: "gotcha",
    title: "Expired source sessions remain identifiable",
    content:
      "When the source session expires, keep the session identifier and retained state without redirecting elsewhere.",
    confidence: 0.77,
    session: "e2e-session-expired",
  },
  {
    category: "gotcha",
    title: "Retained summaries stay readable",
    content:
      "When source messages expire, the retained distillation remains available from the knowledge detail.",
    confidence: 0.76,
    session: "e2e-session-summary",
  },
  {
    category: "pattern",
    title: "SQLite backups stay deterministic",
    content:
      "SQLite backup files remain deterministic when the local store is copied with WAL checkpoints. ".repeat(
        180,
      ),
    confidence: 0.75,
  },
];

let firstKnowledgeId;
for (const entry of entries) {
  const id = core.ltm.create({ ...entry, projectPath: lore, scope: "project" });
  if (!firstKnowledgeId) firstKnowledgeId = id;
}
core.ltm.appendVersion(firstKnowledgeId, {
  content:
    "SQLite remains the authoritative local store, with WAL mode and FTS5 for deterministic recall.",
});
for (const session of [
  {
    id: "e2e-session-sqlite",
    created: 1_700_000_000_000,
    text: "We chose SQLite as the only store for the Lore project.",
  },
  {
    id: "e2e-session-routing",
    created: 1_700_000_100_000,
    text: "The browser UI preserves explicit route state across reloads.",
  },
]) {
  core.temporal.store({
    projectPath: lore,
    info: {
      id: `${session.id}-message`,
      sessionID: session.id,
      role: "user",
      time: { created: session.created },
      agent: "e2e",
      model: { providerID: "e2e", modelID: "seed" },
    },
    parts: [
      {
        id: `${session.id}-part`,
        sessionID: session.id,
        messageID: `${session.id}-message`,
        type: "text",
        text: session.text,
      },
    ],
  });
}
core.ltm.create({
  projectPath: scratch,
  scope: "project",
  category: "preference",
  title: "Prefer terse commit messages",
  content: "Conventional commits, one line, no trailing period.",
  confidence: 0.6,
});

// A session with more messages than one reader page (READER_PAGE_SIZE = 100)
// so the specs can page older history, search unmounted blocks and follow
// deep links through the real /api/v1 paging route. Message `k` mentions
// "needle-k" so a search hit is unambiguous; message 5 carries the passage
// the deep-link scenario anchors.
const SESSION = "e2e-reader";
const MESSAGES = 230;
const T0 = Date.UTC(2026, 4, 3, 8, 0, 0);
for (let k = 0; k < MESSAGES; k++) {
  const user = k % 2 === 0;
  const id = `e2e-m${String(k).padStart(3, "0")}`;
  const created = T0 + k * 60_000;
  const info = user
    ? {
        id,
        sessionID: SESSION,
        role: "user",
        time: { created },
        agent: "build",
        model: { providerID: "anthropic", modelID: "m" },
      }
    : {
        id,
        sessionID: SESSION,
        role: "assistant",
        time: { created },
        parentID: `e2e-m${String(k - 1).padStart(3, "0")}`,
        modelID: "m",
        providerID: "anthropic",
        mode: "build",
        path: { cwd: "/", root: "/" },
        cost: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      };
  const text =
    k === 5
      ? "The anchored passage: portability is a requirement, so SQLite stays the store (needle-5)."
      : `Message ${k} of the e2e reader session discusses needle-${k} and nothing else.`;
  core.temporal.store({
    projectPath: lore,
    info,
    parts: [
      {
        id: `part-${id}`,
        sessionID: SESSION,
        messageID: id,
        type: "text",
        text,
        time: { start: 0, end: 0 },
      },
    ],
  });
}

// Entities for the UI-08 screens: a person with aliases + metadata, an org
// linked by a relation, and a repo. `entities.create` is the same API the
// rebuild pipeline uses.
const ada = core.entities.create({
  projectPath: lore,
  entityType: "person",
  canonicalName: "Ada Lovelace",
  aliases: [{ type: "email", value: "ada@example.com" }],
  metadata: { role: "engineer", notes: "First programmer." },
});
const analyticalEngines = core.entities.create({
  projectPath: lore,
  entityType: "org",
  canonicalName: "Analytical Engines Ltd",
});
const loreRepo = core.entities.create({
  projectPath: lore,
  entityType: "repo",
  canonicalName: "loreai",
});
core.entities.addRelation(ada.id, analyticalEngines.id, "colleague");
core.entities.linkKnowledge(firstKnowledgeId, ada.id);
void loreRepo;

let contradictionFixtureId = 0;
const nextContradictionFixtureId = () =>
  `01996200-1823-7000-8000-${(++contradictionFixtureId).toString(16).padStart(12, "0")}`;

for (const viewport of ["Desktop", "Mobile"]) {
  for (const run of [1, 2]) {
    const label = `${viewport} run ${run}`;
    const conflictA = core.ltm.create({
      // Similar titles are fuzzy-deduplicated by ltm.create unless the fixture
      // supplies explicit ids. Each browser project and retry needs its own
      // independently dismissible pair.
      id: nextContradictionFixtureId(),
      projectPath: scratch,
      scope: "project",
      category: "decision",
      title: `Prefer deterministic ids (${label})`,
      content: `Always preserve stable ids on ${label.toLowerCase()}.`,
    });
    const conflictB = core.ltm.create({
      id: nextContradictionFixtureId(),
      projectPath: scratch,
      scope: "project",
      category: "decision",
      title: `Regenerate ids on every read (${label})`,
      content: `Always replace stable ids on ${label.toLowerCase()}.`,
    });
    core.ltm.recordContradiction({
      logicalIdA: conflictA,
      logicalIdB: conflictB,
      projectId: scratchProjectId,
      similarity: 0.94,
      rationale:
        "Stable identity cannot be preserved and replaced at the same time.",
    });
  }
}

core.close();

// One gen-0 distillation over the first ten messages, written the way
// distillation.ts stores it (core has no public write path for summaries;
// only the distiller produces them). The reader must show it as labelled
// compressed context after message 9, never as speech.
const db = new DatabaseSync(process.env.LORE_DB_PATH);
db.prepare(
  `INSERT INTO distillations (id, project_id, session_id, narrative, facts, observations, source_ids, generation, token_count, created_at, r_compression, c_norm, call_type)
   VALUES (?, (SELECT id FROM projects WHERE name = 'lore'), ?, '', '[]', ?, ?, 0, ?, ?, ?, ?, 'batch')`,
).run(
  "e2e-distillation-0",
  SESSION,
  "Compressed context for messages 0-9: the session opens by walking through needle-0 to needle-9; message 5 fixes SQLite as the store for portability.",
  JSON.stringify(
    Array.from({ length: 10 }, (_, k) => `e2e-m${String(k).padStart(3, "0")}`),
  ),
  38,
  T0 + 9 * 60_000 + 30_000,
  6.4,
  0.9,
);
db.prepare(
  `INSERT INTO distillations (id, project_id, session_id, narrative, facts, observations, source_ids, generation, token_count, created_at, r_compression, c_norm, call_type)
   VALUES (?, (SELECT id FROM projects WHERE name = 'lore'), ?, '', '[]', ?, '[]', 0, ?, ?, ?, ?, 'batch')`,
).run(
  "e2e-distillation-summary",
  "e2e-session-summary",
  "Retained summary for the expired session: the team chose WAL mode.",
  24,
  T0 + 10 * 60_000,
  5.2,
  0.8,
);
db.close();

console.log(
  `seeded ${entries.length + 5} knowledge entries, ${MESSAGES} messages and 2 distillations into ${process.env.LORE_DB_PATH}`,
);
// Core keeps worker pools / maintenance timers alive; the DB is closed, so exit.
process.exit(0);
