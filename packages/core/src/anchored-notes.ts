/**
 * Anchored notes (#1809): a human note on a selection is a knowledge entry
 * whose `metadata.anchor` records the selection. It goes through
 * `ltm.create`, so team approval and export behave as for any other entry;
 * there is no notes table.
 */
import { uuidv7 } from "uuidv7";
import { db, projectPath } from "./db";
import * as ltm from "./ltm";
import {
  anchorStatusOf,
  checkSelection,
  fail,
  loadSource,
  sourceHashOf,
  type AnchorSource,
  type AnchorStatus,
  type SourceAnchor,
} from "./source-anchors";
import { sql } from "./sql";

export const NOTE_CATEGORIES = [
  "decision",
  "pattern",
  "preference",
  "architecture",
  "gotcha",
] as const;
export type NoteCategory = (typeof NOTE_CATEGORIES)[number];
export const NOTE_TITLE_MAX = 200;
export const NOTE_CONTENT_MAX = 1200;

export interface AnchoredNote {
  /** Logical id of the knowledge entry. */
  id: string;
  projectId: string;
  category: string;
  title: string;
  content: string;
  source: AnchorSource;
  anchors: SourceAnchor[];
  quote: string;
  sourceHash: string;
  anchorStatus: AnchorStatus;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateAnchoredNoteInput {
  projectId: string;
  source: AnchorSource;
  anchors: unknown;
  quote: unknown;
  category: unknown;
  title: unknown;
  content: unknown;
  createdBy?: string;
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") fail("invalid", `${field} must be a string`);
  const v = value.trim();
  if (v.length === 0 || v.length > max) {
    fail("invalid", `${field} must be 1-${max} characters`);
  }
  return v;
}

export function createAnchoredNote(
  input: CreateAnchoredNoteInput,
): AnchoredNote {
  if (!NOTE_CATEGORIES.includes(input.category as NoteCategory)) {
    fail("invalid", `category must be one of ${NOTE_CATEGORIES.join(", ")}`);
  }
  const title = text(input.title, "title", NOTE_TITLE_MAX);
  const content = text(input.content, "content", NOTE_CONTENT_MAX);
  const { anchors, quote } = checkSelection(
    input.projectId,
    input.source,
    input.anchors,
    input.quote,
  );
  const path = projectPath(input.projectId);
  if (!path) fail("not_found", "project not found");
  // An explicit id skips ltm.create's title dedup: a note must never be
  // folded into an unrelated entry that happens to share its title.
  const id = ltm.create({
    id: uuidv7(),
    projectPath: path,
    scope: "project",
    category: input.category as NoteCategory,
    title,
    content,
    session: input.source.kind === "session" ? input.source.id : undefined,
    createdBy: input.createdBy,
    metadata: {
      anchor: {
        source_kind: input.source.kind,
        source_id: input.source.id,
        anchors,
        quote,
        source_hash: sourceHashOf(anchors),
      },
    },
  });
  const note = listAnchoredNotes({
    projectId: input.projectId,
    source: input.source,
  }).find((n) => n.id === id);
  if (!note) fail("not_found", "note was not stored");
  return note;
}

interface NoteRow {
  logical_id: string;
  project_id: string;
  category: string;
  title: string;
  content: string;
  metadata: string;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

/** A source's current anchored notes, oldest first, with live anchor status. */
export function listAnchoredNotes(input: {
  projectId: string;
  source: AnchorSource;
}): AnchoredNote[] {
  const rows = sql.all<NoteRow>(
    db(),
    sql`SELECT logical_id, project_id, category, title, content, metadata,
               created_by, created_at, updated_at
          FROM knowledge_current
         WHERE project_id = ${input.projectId}
           AND json_extract(metadata, '$.anchor.source_kind') = ${input.source.kind}
           AND json_extract(metadata, '$.anchor.source_id') = ${input.source.id}
         ORDER BY created_at, logical_id`,
  );
  const notes = rows.map((row) => {
    const anchor = (JSON.parse(row.metadata) as ltm.KnowledgeMetadata).anchor!;
    return { row, anchor };
  });
  const live = loadSource(
    input.projectId,
    input.source,
    notes.flatMap((n) => n.anchor.anchors),
  );
  return notes.map(({ row, anchor }) => ({
    id: row.logical_id,
    projectId: row.project_id,
    category: row.category,
    title: row.title,
    content: row.content,
    source: input.source,
    anchors: anchor.anchors,
    quote: anchor.quote,
    sourceHash: anchor.source_hash,
    anchorStatus: anchorStatusOf(anchor.anchors, live),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}
