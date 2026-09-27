/**
 * Contracts for the UI-08 project actions (`/api/v1/projects*` and
 * `/api/v1/sessions/move`). The mutation handlers live in the gateway's
 * api.ts dispatcher; only the rename PATCH is served by the dashboard
 * route module. Timestamps are epoch ms as stored.
 */
import "./config";
import { type } from "arktype";

import { nonEmptyString, nonNegInt } from "./primitives";

/** `PATCH /api/v1/projects/:id` — `{id, name}` with the stored trimmed name. */
export const projectRenameResult = type({
  id: nonEmptyString,
  name: "string",
});

export type ProjectRenameResult = typeof projectRenameResult.infer;

/**
 * `POST /api/v1/projects/:id/clear` — the full-clear `ClearResult`, or the
 * selective variant when the request carried flags (only the cleared
 * categories are present), so every key is optional.
 */
export const projectClearResult = type({
  "knowledge_deleted?": nonNegInt,
  "temporal_deleted?": nonNegInt,
  "distillations_deleted?": nonNegInt,
  "sessions_cleared?": nonNegInt,
});

export type ProjectClearResult = typeof projectClearResult.infer;

/** `DELETE /api/v1/projects/:id` — always the full `ClearResult`. */
export const projectDeleteResult = type({
  knowledge_deleted: nonNegInt,
  temporal_deleted: nonNegInt,
  distillations_deleted: nonNegInt,
  sessions_cleared: nonNegInt,
});

export type ProjectDeleteResult = typeof projectDeleteResult.infer;

/**
 * `POST /api/v1/sessions/move` — `MoveSessionsResult` from core.
 * `movedSessionIds` includes BFS-expanded child sessions.
 */
export const sessionsMoveResult = type({
  sessions_moved: nonNegInt,
  messages_moved: nonNegInt,
  distillations_moved: nonNegInt,
  tool_calls_moved: nonNegInt,
  knowledge_moved: nonNegInt,
  movedSessionIds: "string[]",
});

export type SessionsMoveResult = typeof sessionsMoveResult.infer;

/** `POST /api/v1/projects/merge` — the git-remote backfill/merge report. */
export const projectsMergeResult = type({
  updated: nonNegInt,
  merged: nonNegInt,
  namesBackfilled: nonNegInt,
  mergeDetails: type({
    sourcePath: "string",
    targetPath: "string",
    gitRemote: "string",
    result: {
      knowledge_moved: nonNegInt,
      messages_moved: nonNegInt,
      distillations_moved: nonNegInt,
    },
  }).array(),
});

export type ProjectsMergeResult = typeof projectsMergeResult.infer;
