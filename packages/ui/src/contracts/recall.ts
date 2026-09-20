import "./config";
import { type } from "arktype";

export const RECALL_SCOPES = [
  "all",
  "session",
  "project",
  "knowledge",
] as const;
export type RecallScope = (typeof RECALL_SCOPES)[number];

export const recallResponse = type({
  query: "string",
  scope: "'all'|'session'|'project'|'knowledge'",
  projectPath: "string",
  result: "string",
});

export type RecallResponse = typeof recallResponse.infer;
