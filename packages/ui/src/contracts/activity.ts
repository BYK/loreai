import "./config";
import { type } from "arktype";

import { epochMs, nonEmptyString, nonNegInt } from "./primitives";

export const activityKind = type(
  "'session' | 'knowledge' | 'contradiction' | 'promotion'",
);

export const activityParticipant = type({
  id: nonEmptyString,
  kind: "'user' | 'agent' | 'lore'",
  label: nonEmptyString,
});

export const activityItem = type({
  kind: activityKind,
  id: nonEmptyString,
  project_id: "string",
  project_name: "string",
  title: "string",
  snippet: "string",
  participants: activityParticipant.array(),
  last_activity_at: epochMs,
  total: nonNegInt,
  match: "'exact' | 'fuzzy'",
});

export const activityPage = type({
  items: activityItem.array(),
  next_cursor: nonEmptyString.or("null"),
});

export type ActivityKind = typeof activityKind.infer;
export type ActivityParticipant = typeof activityParticipant.infer;
export type ActivityItem = typeof activityItem.infer;
export type ActivityPage = typeof activityPage.infer;
