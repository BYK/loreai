#!/usr/bin/env node
/**
 * Seeds the e2e gateway's database (LORE_DB_PATH) with content, duplicate-
 * review and hostile-payload projects, plus 60 filler projects (so the
 * desktop nav overflows and must scroll). Knowledge is created through
 * @loreai/core's public API — the same write path the curator uses — so the
 * specs browse real rows via /api/v1.
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

const loreProjectId = core.ensureProject(lore, "lore", "github.com/BYK/loreai");
const scratchProjectId = core.ensureProject(scratch, "scratch", null);

const dedupReview = join(root, "dedup-review");
mkdirSync(dedupReview, { recursive: true });
core.ensureProject(dedupReview, "dedup-review", null);
for (const [title, content, confidence] of [
  [
    "Duplicate review evidence sample candidate alpha",
    "First project candidate with complete review evidence.",
    0.86,
  ],
  [
    "Duplicate review evidence sample candidate beta",
    "Second project candidate with a separate full content body.",
    0.82,
  ],
  [
    "Shared duplicate review evidence sample candidate alpha",
    "First shared candidate for the no-project duplicate group.",
    0.91,
  ],
  [
    'Shared duplicate review evidence sample <img src=x onerror="window.__pwned=1">',
    'Hostile text stays inert in the review screen: <img src=x onerror="window.__pwned=1">',
    0.88,
  ],
]) {
  core.ltm.create({
    id: crypto.randomUUID(),
    projectPath: title.startsWith("Duplicate review") ? dedupReview : undefined,
    category: "decision",
    title,
    content,
    session: "e2e-dedup-review",
    scope: title.startsWith("Duplicate review") ? "project" : "global",
    confidence,
  });
}
// #1918: five extra empty projects so the sidebar has more entries than the
// Recent limit and the filter / "All projects" surfaces render. They have no
// messages or knowledge, so `last_activity` is null and they sort last.
for (let i = 0; i < 5; i++) {
  const dir = join(root, `archive-${i}`);
  mkdirSync(dir, { recursive: true });
  core.ensureProject(dir, `archive-${i}`, null);
}

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
const knowledgeIds = [];
for (const entry of entries) {
  const id = core.ltm.create({ ...entry, projectPath: lore, scope: "project" });
  if (!firstKnowledgeId) firstKnowledgeId = id;
  knowledgeIds.push(id);
}
core.ltm.create({
  scope: "global",
  category: "decision",
  title: "Shared: prefer inert rendering",
  content: "Knowledge titles and content are untrusted text in every project.",
  confidence: 0.91,
});
core.ltm.appendVersion(firstKnowledgeId, {
  content:
    "SQLite remains the authoritative local store, with WAL mode and FTS5 for deterministic recall.",
});
for (const session of [
  {
    id: "e2e-session-sqlite",
    created: 1_700_000_000_000,
    text: "Refactor the sync outbox pruning",
  },
  {
    id: "e2e-session-routing",
    created: 1_700_000_100_000,
    text: "Investigate FTS tokenizer diacritics",
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

// A session whose first (and only) user message is tool-only: its title
// falls back to the raw session id (#1921).
core.temporal.store({
  projectPath: lore,
  info: {
    id: "e2e-session-tools-message",
    sessionID: "e2e-session-tools",
    role: "user",
    time: { created: 1_700_000_200_000 },
    agent: "e2e",
    model: { providerID: "e2e", modelID: "seed" },
  },
  parts: [
    {
      id: "e2e-session-tools-part",
      sessionID: "e2e-session-tools",
      messageID: "e2e-session-tools-message",
      type: "tool",
      tool: "bash",
      state: { status: "completed", output: "tool output" },
    },
  ],
});
core.ltm.create({
  projectPath: scratch,
  scope: "project",
  category: "preference",
  title: "Prefer terse commit messages",
  content: "Conventional commits, one line, no trailing period.",
  confidence: 0.6,
});
core.ltm.create({
  projectPath: scratch,
  scope: "project",
  crossProject: true,
  category: "gotcha",
  title: "Shared: cross-project filter fixture",
  content: "This project-owned entry is shared across projects.",
});

// Hostile strings exercise every browser-rendered text surface.  Keep this
// project separate so the stable lore counts used by the browsing specs do
// not change.
const hostile = join(root, "hostile");
mkdirSync(hostile, { recursive: true });
const hostileProjectId = core.ensureProject(hostile, "hostile", null);

// Filler projects make the desktop nav overflow its scroll container
// (#1916) — bare projects only, no entries.
for (let i = 1; i <= 60; i++) {
  const dir = join(root, "filler", String(i).padStart(2, "0"));
  mkdirSync(dir, { recursive: true });
  core.ensureProject(dir, `filler-${String(i).padStart(2, "0")}`, null);
}
const hostilePayloads = [
  "<script>window.__pwned=1</script>",
  '<img src=x onerror="window.__pwned=1">',
  '<a href="javascript:window.__pwned=1">link</a>',
  '<iframe srcdoc="<script>window.__pwned=1</script>"></iframe>',
  "[x](javascript:window.__pwned=1)",
  '<svg onload="window.__pwned=1"></svg>',
  '<style>body{background:red}</style><div style="position:fixed;inset:0">clickjack</div>',
];
const hostileText = hostilePayloads.join("\n\n");
const hostileLongTitle = `Hostile ${"x".repeat(180)}`;
const hostileIds = [];
for (let i = 0; i < hostilePayloads.length; i++) {
  hostileIds.push(
    core.ltm.create({
      projectPath: hostile,
      scope: "project",
      category: "gotcha",
      title: `${hostileLongTitle} ${i + 1}: ${hostilePayloads[i]}`,
      content: hostileText,
      confidence: 0.5,
    }),
  );
}
core.ltm.appendVersion(hostileIds[0], { content: hostileText });
for (const role of ["user", "assistant"]) {
  const id = `e2e-hostile-${role}`;
  core.temporal.store({
    projectPath: hostile,
    info: {
      id,
      sessionID: "e2e-hostile-session",
      role,
      time: { created: Date.UTC(2026, 4, 3, 9, role === "user" ? 0 : 1) },
      agent: "e2e",
      model: { providerID: "e2e", modelID: "seed" },
      ...(role === "assistant" ? { parentID: "e2e-hostile-user" } : {}),
    },
    parts: [
      {
        id: `${id}-part`,
        sessionID: "e2e-hostile-session",
        messageID: id,
        type: "text",
        text: hostileText,
      },
    ],
  });
}

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

// Context-window seeding (#1924): an injection batch, one durable prompt
// delta, and per-turn gradient metadata so the pane and the transcript
// markers have real rows to read. The prompt delta's createdAt sits inside
// the first page of loaded messages so its applied_at marker renders there.
core.ltm.recordSessionInjections(SESSION, lore, [
  { logical_id: core.ltm.logicalIdOf(knowledgeIds[0]) },
  { logical_id: core.ltm.logicalIdOf(knowledgeIds[2]) },
]);
core.appendSessionPromptDelta({
  sessionID: SESSION,
  projectID: loreProjectId,
  createdAt: T0 + 228 * 60_000,
  selector: JSON.stringify({
    insertAt: 3,
    mut: {
      changed: [{ id: core.ltm.logicalIdOf(knowledgeIds[0]) }],
      removed: [],
    },
  }),
  content: JSON.stringify([
    {
      role: "user",
      content: [{ type: "text", text: "[memory refreshed] e2e delta text" }],
    },
  ]),
});

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

core.entities.create({
  id: "e2e-hostile-entity",
  projectPath: hostile,
  crossProject: false,
  entityType: "person",
  canonicalName: `Hostile entity ${hostilePayloads[0]}`,
  aliases: [
    { type: "nickname", value: hostilePayloads[1] },
    { type: "email", value: "hostile@example.invalid" },
  ],
  metadata: {
    role: hostilePayloads[2],
    description: hostilePayloads[3],
    notes: hostilePayloads[4],
  },
});

// Import history (UI-08): three imports for `lore`, one of them an update.
core.conversationImport.recordImport(
  lore,
  "claude",
  "claude-session-alpha",
  "hash-alpha",
  { created: 12, updated: 0 },
);
core.conversationImport.recordImport(
  lore,
  "claude",
  "claude-session-beta",
  "hash-beta",
  { created: 5, updated: 2 },
);
core.conversationImport.recordImport(
  lore,
  "codex",
  "codex-thread-9",
  "hash-9",
  { created: 3, updated: 1 },
);

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

const hostileConflictA = core.ltm.create({
  id: nextContradictionFixtureId(),
  projectPath: hostile,
  scope: "project",
  category: "decision",
  title: `Hostile contradiction ${hostilePayloads[0]}`,
  content: hostileText,
});
const hostileConflictB = core.ltm.create({
  id: nextContradictionFixtureId(),
  projectPath: hostile,
  scope: "project",
  category: "decision",
  title: `Hostile opposite ${hostilePayloads[1]}`,
  content: hostileText,
});
core.ltm.recordContradiction({
  logicalIdA: hostileConflictA,
  logicalIdB: hostileConflictB,
  projectId: hostileProjectId,
  similarity: 0.96,
  rationale: hostileText,
});

// One cross-project pair (#1919): an entry in scratch vs an entry in lore, so
// the contradictions page renders a "Cross-project" group after the per-project
// groups.
const crossConflictA = core.ltm.create({
  id: nextContradictionFixtureId(),
  projectPath: scratch,
  scope: "project",
  category: "decision",
  title: "Store timestamps as epoch ms",
  content: "Persist all timestamps as integer epoch milliseconds.",
});
const crossConflictB = core.ltm.create({
  id: nextContradictionFixtureId(),
  projectPath: lore,
  scope: "project",
  category: "decision",
  title: "Store timestamps as ISO strings",
  content: "Persist all timestamps as ISO 8601 strings.",
});
core.ltm.recordContradiction({
  logicalIdA: crossConflictA,
  logicalIdB: crossConflictB,
  projectId: scratchProjectId,
  similarity: 0.95,
  rationale:
    "Epoch milliseconds and ISO strings cannot both be the storage format.",
});

// Project-actions fixtures (UI-08): disposable projects and scratch
// sessions per browser project and retry so a delete/clear/move can never
// race another spec — each test owns `pa-<viewport>-<run>-<letter>` and the
// session `e2e-session-scratch-<viewport>-<run>`.
for (const viewport of ["Desktop", "Mobile"]) {
  const tag = viewport.toLowerCase();
  for (const run of [1, 2]) {
    for (const letter of ["a", "b", "c"]) {
      const path = join(root, `pa-${tag}-${run}-${letter}`);
      mkdirSync(path, { recursive: true });
      core.ensureProject(path, `pa-${tag}-${run}-${letter}`, null);
      core.ltm.create({
        projectPath: path,
        scope: "project",
        category: "gotcha",
        title: `Disposable entry ${viewport} ${run} ${letter}`,
        content: "Seeded for the project-actions e2e spec.",
        confidence: 0.5,
      });
    }
    core.temporal.store({
      projectPath: scratch,
      info: {
        id: `e2e-scratch-${tag}-${run}-message`,
        sessionID: `e2e-session-scratch-${tag}-${run}`,
        role: "user",
        time: { created: 1_700_000_200_000 + run },
        agent: "e2e",
        model: { providerID: "e2e", modelID: "seed" },
      },
      parts: [
        {
          type: "text",
          text: `Scratch session ${run} for ${viewport}, moved to lore by the project-actions spec.`,
        },
      ],
    });
  }
}

// Provider cost + quota snapshot fixtures (#1926): one subscription and one
// API-key account so /ui/costs renders both card shapes.
const todayUTC = new Date().toISOString().slice(0, 10);
core.addProviderCost({
  day: todayUTC,
  provider: "anthropic",
  authKind: "subscription",
  account: "e2e-anth",
  bucket: "conversation",
  cost: 2.5,
  inputTokens: 12_000,
  outputTokens: 3_000,
  cacheReadTokens: 8_000,
  cacheWriteTokens: 400,
  requests: 7,
});
core.addProviderCost({
  day: todayUTC,
  provider: "openai",
  authKind: "api_key",
  account: "e2e-oai",
  bucket: "conversation",
  cost: 0.5,
  inputTokens: 4_000,
  outputTokens: 1_500,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  requests: 3,
});
const nowMs = Date.now();
for (const [window, minutes, used, resetMs] of [
  ["5h", 300, 23, nowMs + 2 * 3600_000],
  ["7d", 10080, 41, nowMs + 3 * 24 * 3600_000],
]) {
  core.upsertProviderQuota({
    provider: "anthropic",
    authKind: "subscription",
    account: "e2e-anth",
    window,
    label: "allowed",
    windowMinutes: minutes,
    usedPercent: used,
    remaining: null,
    limit: null,
    resetsAt: resetMs,
    source: "anthropic-unified",
    observedAt: nowMs,
  });
}

// Per-provider budget (#1927): an 80% cap on Anthropic's weekly quota window.
core.setKV(
  "provider_budgets",
  JSON.stringify([
    {
      provider: "anthropic",
      auth_kind: "subscription",
      account: "e2e-anth",
      unit: "percent",
      window: "7d",
      amount: 80,
    },
  ]),
);

core.close();

// One gen-0 distillation over the first ten messages, written the way
// distillation.ts stores it (core has no public write path for summaries;
// only the distiller produces them). The reader must show it as labelled
// compressed context after message 9, never as speech.
const db = new DatabaseSync(process.env.LORE_DB_PATH);
// FOLK-01: Link scratch to a mirrored team so its sharing panel renders "degraded".
db.prepare(
  "INSERT INTO scopes (id, kind, name, promotion_policy) VALUES ('e2e-team-acme','team','Acme e2e','manual')",
).run();
const linkResult = db
  .prepare("UPDATE projects SET scope_id='e2e-team-acme' WHERE name='scratch'")
  .run();
if (linkResult.changes !== 1) {
  throw new Error("expected to link exactly the seeded scratch project");
}
const conflictLogicalId = core.ltm.logicalIdOf(firstKnowledgeId);
const conflictEntry = db
  .prepare(
    `SELECT title, content, category FROM knowledge_current
      WHERE COALESCE(logical_id, id) = ? LIMIT 1`,
  )
  .get(conflictLogicalId);
if (!conflictEntry) throw new Error("expected seeded knowledge conflict entry");
db.prepare(
  `INSERT INTO sync_conflicts
    (table_name, row_id, detected_at, resolution, local_content)
   VALUES ('knowledge', ?, ?, 'remote_upsert_wins', ?)`,
).run(
  conflictLogicalId,
  Date.UTC(2026, 8, 20, 12),
  JSON.stringify({
    title: "Local discarded version",
    content: "Keep the local-first database.",
    category: conflictEntry.category,
  }),
);
const remoteDeletedLogicalId = core.ltm.create({
  id: "01996200-1823-7000-8000-000000000099",
  projectPath: scratch,
  scope: "project",
  category: "decision",
  title: "Remote-deleted decision",
  content: "The remote copy was removed.",
});
core.ltm.remove(remoteDeletedLogicalId);
const remoteDeathCert = db
  .prepare(
    `SELECT id FROM knowledge
      WHERE COALESCE(logical_id, id) = ? AND is_current = 1 AND is_deleted = 1`,
  )
  .get(remoteDeletedLogicalId);
if (!remoteDeathCert)
  throw new Error("expected remote-delete death certificate");
db.prepare(
  `INSERT INTO sync_conflicts
    (table_name, row_id, detected_at, resolution, local_content)
   VALUES ('knowledge', ?, ?, 'remote_delete_wins', ?)`,
).run(
  remoteDeletedLogicalId,
  Date.UTC(2026, 8, 20, 12, 30),
  JSON.stringify({
    title: "Keep the local copy",
    content: "Keep the local-first database.",
    category: "decision",
  }),
);
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

// Per-turn gradient stats (#1924) the way pipeline.ts writes them via
// messageMetadata(): a passthrough turn early in the loaded page and a
// layer-1 turn near the end so one compaction marker lands in the mounted
// window of the newest 100 messages (k = 130..229).
for (const { id, gradient } of [
  {
    id: "e2e-m211",
    gradient: {
      layer: 0,
      raw_tokens: 4_200,
      total_tokens: 4_200,
      distilled_tokens: 0,
    },
  },
  {
    id: "e2e-m225",
    gradient: {
      layer: 1,
      raw_tokens: 18_400,
      total_tokens: 6_100,
      distilled_tokens: 812,
    },
  },
]) {
  const row = db
    .prepare(
      "SELECT id, metadata FROM temporal_messages WHERE source_id = ? AND session_id = ?",
    )
    .get(id, SESSION);
  if (!row) throw new Error(`seeded message ${id} missing`);
  const metadata = JSON.parse(row.metadata);
  metadata.gradient = gradient;
  metadata.usage = {
    input: gradient.total_tokens,
    output: 40,
    cache_read: 0,
    cache_write: 0,
  };
  db.prepare("UPDATE temporal_messages SET metadata = ? WHERE id = ?").run(
    JSON.stringify(metadata),
    row.id,
  );
}

// The disposable pa-* fixtures are created late in the seed, so their fresh
// knowledge rows would otherwise outrank lore/scratch/hostile in the sidebar's
// recency ordering (last_activity desc) and push them out of Recent. Backdate
// them so the named projects stay visible; the project-actions spec navigates
// by URL and does not care about sidebar order.
db.prepare(
  `UPDATE knowledge SET updated_at = 1600000000000
   WHERE project_id IN (SELECT id FROM projects WHERE name LIKE 'pa-%')`,
).run();
db.close();

console.log(
  `seeded ${entries.length + 1 + contradictionFixtureId} knowledge entries, ${MESSAGES} messages and 2 distillations into ${process.env.LORE_DB_PATH}`,
);
// Core keeps worker pools / maintenance timers alive; the DB is closed, so exit.
process.exit(0);
