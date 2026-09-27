/**
 * Contracts for `GET /api/v1/projects/:id/imports` (UI-08 import history).
 * One row per completed agent-conversation import; timestamps are epoch ms.
 */
import "./config";
import { type } from "arktype";

import { epochMs, nonEmptyString, nonNegInt } from "./primitives";

/** `ImportRecord` in core (`packages/core/src/import/history.ts`). */
export const importRecord = type({
  id: nonEmptyString,
  project_id: "string",
  agent_name: "string",
  source_id: "string",
  source_hash: "string",
  entries_created: nonNegInt,
  entries_updated: nonNegInt,
  imported_at: epochMs,
});

export type ImportRecord = typeof importRecord.infer;

/** Keyset-paged imports envelope: `{ imports, next_cursor, total }`. */
export const importListPage = type({
  imports: importRecord.array(),
  next_cursor: "string | null",
  total: nonNegInt,
});

export type ImportListPage = typeof importListPage.infer;
