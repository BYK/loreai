/**
 * Contracts for the APP-01 discussion API (`/api/v1/discussions*`,
 * `/api/v1/projects/:id/threads*`). Anchors are the reader's logical
 * `SourceAnchor` in wire (snake_case) form; timestamps are epoch ms.
 */
import "./config";
import { type } from "arktype";

import { epochMs, nonEmptyString, nonNegInt } from "./primitives";

export const discussionAnchor = type({
  block_id: nonEmptyString,
  "part_index?": nonNegInt,
  start: nonNegInt,
  end: nonNegInt,
  content_hash: nonEmptyString,
});

export type DiscussionAnchor = typeof discussionAnchor.infer;

export const discussionSourceKind = type("'session' | 'knowledge'");
export type DiscussionSourceKind = typeof discussionSourceKind.infer;

export const discussion = type({
  id: nonEmptyString,
  project_id: nonEmptyString,
  thread_id: "string | null",
  kind: "'discussion' | 'note'",
  source: { kind: discussionSourceKind, id: nonEmptyString },
  anchors: discussionAnchor.array(),
  quote: "string",
  source_hash: "string",
  state: "'open' | 'resolved'",
  anchor_status: "'current' | 'stale_anchor' | 'source_missing'",
  revision: nonNegInt,
  created_by: nonEmptyString,
  created_at: epochMs,
  updated_at: epochMs,
  last_activity_at: epochMs,
  reply_count: nonNegInt,
  participants: "string[]",
});

export type Discussion = typeof discussion.infer;

export const discussionReply = type({
  id: nonEmptyString,
  discussion_id: nonEmptyString,
  seq: nonNegInt,
  parent_reply_id: "string | null",
  author: nonEmptyString,
  content: type({ kind: "'text'", body: "string" }).or({
    kind: "'response'",
    binding: {
      id: nonEmptyString,
      session_id: nonEmptyString,
      message_id: nonEmptyString,
      agent: "string",
      verified_at: epochMs,
    },
  }),
  revision: nonNegInt,
  created_at: epochMs,
  updated_at: epochMs,
});

export type DiscussionReply = typeof discussionReply.infer;

export const discussionPage = type({
  discussions: discussion.array(),
  next_cursor: "string | null",
});
export type DiscussionPage = typeof discussionPage.infer;

export const discussionResult = type({ discussion });
export type DiscussionResult = typeof discussionResult.infer;

export const discussionCreated = type({
  discussion,
  reply: discussionReply.or("null"),
});
export type DiscussionCreated = typeof discussionCreated.infer;

export const discussionReplyPage = type({
  replies: discussionReply.array(),
  next_after: "number | null",
});
export type DiscussionReplyPage = typeof discussionReplyPage.infer;

export const discussionReplyCreated = type({
  reply: discussionReply,
  discussion,
});
export type DiscussionReplyCreated = typeof discussionReplyCreated.infer;
