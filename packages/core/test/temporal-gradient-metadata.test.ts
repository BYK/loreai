/**
 * Per-turn gradient stats in assistant message metadata (#1924): storing an
 * assistant LoreMessage carrying `info.gradient` records a snake_case
 * `gradient` object plus the message's `usage` block into temporal metadata;
 * without it the stored metadata is byte-identical to before.
 */
import { describe, expect, test } from "vitest";
import { db, ensureProject } from "../src/db";
import * as temporal from "../src/temporal";
import type { LoreAssistantMessage, LorePart } from "../src/types";

let seq = 0;
function freshSession(): { project: string; sid: string } {
  seq++;
  const project = `/test/temporal-gradient/${seq}`;
  ensureProject(project);
  return { project, sid: `sess-${seq}` };
}

function assistant(
  sid: string,
  id: string,
  gradient?: LoreAssistantMessage["gradient"],
): LoreAssistantMessage {
  return {
    id,
    sessionID: sid,
    role: "assistant",
    time: { created: 1000 },
    parentID: "p",
    modelID: "m",
    providerID: "anthropic",
    mode: "build",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: {
      input: 11,
      output: 7,
      reasoning: 0,
      cache: { read: 3, write: 2 },
    },
    ...(gradient ? { gradient } : {}),
  };
}

function parts(sid: string, id: string): LorePart[] {
  return [
    {
      id: `part-${id}`,
      sessionID: sid,
      messageID: id,
      type: "text",
      text: `text ${id}`,
    },
  ];
}

function storedMetadata(sid: string): string[] {
  return (
    db()
      .query(
        "SELECT metadata FROM temporal_messages WHERE session_id = ? ORDER BY created_at, id",
      )
      .all(sid) as Array<{ metadata: string }>
  ).map((r) => r.metadata);
}

describe("assistant gradient metadata", () => {
  test("gradient + usage land in metadata with snake_case keys", () => {
    const { project, sid } = freshSession();
    temporal.store({
      projectPath: project,
      info: assistant(sid, "a1", {
        layer: 2,
        rawTokens: 100,
        totalTokens: 160,
        distilledTokens: 40,
      }),
      parts: parts(sid, "a1"),
    });
    const meta = JSON.parse(storedMetadata(sid)[0]);
    expect(meta.gradient).toEqual({
      layer: 2,
      raw_tokens: 100,
      total_tokens: 160,
      distilled_tokens: 40,
    });
    expect(meta.usage).toEqual({
      input: 11,
      output: 7,
      cache_read: 3,
      cache_write: 2,
    });
    // Existing fields are untouched.
    expect(meta.modelID).toBe("m");
    expect(meta.providerID).toBe("anthropic");
    expect(meta.mode).toBe("build");
  });

  test("no gradient → no new keys, byte-identical metadata", () => {
    const { project, sid } = freshSession();
    temporal.store({
      projectPath: project,
      info: assistant(sid, "a1"),
      parts: parts(sid, "a1"),
    });
    const raw = storedMetadata(sid)[0];
    const meta = JSON.parse(raw);
    expect(meta).toEqual({
      modelID: "m",
      providerID: "anthropic",
      mode: "build",
    });
    expect("gradient" in meta).toBe(false);
    expect("usage" in meta).toBe(false);
    expect(raw).toBe('{"modelID":"m","providerID":"anthropic","mode":"build"}');
  });
});
