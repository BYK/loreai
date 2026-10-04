import "./config";
import { type } from "arktype";

export const syncConflictUnrecoverableReason = type(
  "'not_knowledge' | 'remote_delete' | 'entry_missing' | 'unreadable'",
);

export const syncConflictLocal = type({
  title: "string",
  content: "string",
  category: "string",
});

export const syncConflictCurrent = type({
  version_id: "string",
  version: "number.integer >= 1",
  title: "string",
  content: "string",
});

export type SyncConflictCurrent = typeof syncConflictCurrent.infer;

export const syncConflict = type({
  id: "number.integer >= 1",
  table: "string",
  row_id: "string",
  detected_at: "string",
  resolution: "string",
  recoverable: "boolean",
  unrecoverable_reason: syncConflictUnrecoverableReason.or("null"),
  local: syncConflictLocal.or("null"),
  current: syncConflictCurrent.or("null"),
});

export type SyncConflict = typeof syncConflict.infer;

export const syncConflictList = type({
  available: "boolean",
  complete: "boolean",
  conflicts: syncConflict.array(),
});

export type SyncConflictList = typeof syncConflictList.infer;

export const syncConflictKeepReceipt = type({
  kept: "'local'",
  current: syncConflictCurrent,
});

export type SyncConflictKeepReceipt = typeof syncConflictKeepReceipt.infer;

export const syncConflictDiscardReceipt = type({
  discarded: "number.integer >= 1",
});

export type SyncConflictDiscardReceipt =
  typeof syncConflictDiscardReceipt.infer;
