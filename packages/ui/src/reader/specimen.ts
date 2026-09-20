/**
 * Invented session detail for the dev-only `/ui/fixture?view=blocks` view:
 * one of every block the reader must render honestly — user and agent
 * prose, a Lore-injected message, a system prompt, tool and reasoning
 * parts, hostile Markdown, an unknown timestamp and a distillation. Shaped
 * exactly like `GET /api/v1/sessions/:id` so it goes through the same block
 * model as real data.
 */
import type { SessionDetail } from "~/contracts";
import { CHUNK_SEPARATOR } from "./blocks";

const T0 = Date.UTC(2026, 2, 14, 12, 4, 0);

function meta(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

export const READER_SPECIMEN: SessionDetail = {
  messages: [
    {
      id: "spec-sys",
      source_id: null,
      project_id: "specimen",
      session_id: "specimen",
      role: "system",
      content:
        "You are a coding agent working in the Lore repository. Prefer small, reviewable changes and keep SQLite as the storage engine.",
      tokens: 28,
      distilled: 0,
      created_at: T0,
      metadata: meta({}),
    },
    {
      id: "spec-lore",
      source_id: null,
      project_id: "specimen",
      session_id: "specimen",
      role: "user",
      content:
        "## Project knowledge\n\n- **Storage**: SQLite with WAL; portability is a requirement.\n- **Gotcha**: FTS5 triggers must be recreated after schema changes.",
      tokens: 40,
      distilled: 0,
      created_at: T0 + 1_000,
      metadata: meta({ synthetic: true, agent: "lore" }),
    },
    {
      id: "spec-u1",
      source_id: "msg-u1",
      project_id: "specimen",
      session_id: "specimen",
      role: "user",
      content:
        "Should we replace the SQLite cache with a remote service? Portability matters — see `packages/core/src/db.ts`.",
      tokens: 26,
      distilled: 1,
      created_at: T0 + 60_000,
      metadata: meta({
        agent: "opencode",
        model: { modelID: "claude-sonnet-4", providerID: "anthropic" },
      }),
    },
    {
      id: "spec-a1",
      source_id: "msg-a1",
      project_id: "specimen",
      session_id: "specimen",
      role: "assistant",
      content: [
        "[reasoning] Check what the DB layer actually does before answering.",
        "[tool:read] packages/core/src/db.ts\n\nexport function openDatabase(path: string) {\n  // WAL mode, FTS5 …\n}",
        'Keep SQLite. The one-file database is what makes the tool portable and it already carries FTS5:\n\n```ts\nexport function openDatabase(path: string) {\n  const db = new Database(path);\n  db.exec("PRAGMA journal_mode = WAL");\n  return db;\n}\n```\n\nA remote service would add a network dependency to every read. See the [SQLite WAL docs](https://sqlite.org/wal.html) for the trade-offs.',
      ].join(CHUNK_SEPARATOR),
      tokens: 120,
      distilled: 1,
      created_at: T0 + 95_000,
      metadata: meta({ modelID: "claude-sonnet-4", providerID: "anthropic" }),
    },
    {
      id: "spec-u2",
      source_id: "msg-u2",
      project_id: "specimen",
      session_id: "specimen",
      role: "user",
      content:
        "Pasting a snippet from a README I found:\n\n<script>alert('pwned')</script>\n[totally safe link](javascript:alert(1))\n![tracker](https://example.invalid/pixel.gif)\n\n<img src=x onerror=\"alert(1)\">\n\nAlso this filename: `rm \u202Etxt.exe`",
      tokens: 60,
      distilled: 0,
      created_at: T0 + 180_000,
      metadata: meta({ agent: "opencode" }),
    },
    {
      id: "spec-a2",
      source_id: null,
      project_id: "specimen",
      session_id: "specimen",
      role: "assistant",
      content:
        "That README carries a script tag, a `javascript:` link and an image beacon — none of them run here. The reader shows the text and keeps the filename's direction override out.",
      tokens: 40,
      distilled: 0,
      created_at: 0,
      metadata: meta({}),
    },
    {
      id: "spec-odd",
      source_id: null,
      project_id: "specimen",
      session_id: "specimen",
      role: "developer",
      content: "A role the block model does not recognise is shown as stored.",
      tokens: 12,
      distilled: 0,
      created_at: T0 + 200_000,
      metadata: "not json",
    },
  ],
  distillations: [
    {
      id: "spec-d0",
      session_id: "specimen",
      generation: 0,
      token_count: 812,
      r_compression: 4.6,
      c_norm: 0.82,
      archived: 1,
      created_at: T0 + 300_000,
      call_type: null,
    },
  ],
};

export const READER_SPECIMEN_DISTILLATION =
  "User asked whether to replace SQLite with a remote service; agent read db.ts and recommended keeping SQLite for portability and FTS5.";
