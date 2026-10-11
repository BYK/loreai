import { beforeEach, describe, expect, it } from "vitest";
import { close, db, ensureProject } from "../src/db";
import { deleteProject, moveSessions } from "../src/data";
import {
  DiscussionError,
  addReply,
  blockHashOf,
  createDiscussion,
  createThread,
  deleteDiscussion,
  deleteReply,
  deleteThread,
  getDiscussion,
  getThread,
  knowledgeBlockId,
  knowledgePartHashes,
  listDiscussions,
  listDiscussionsByActivity,
  listReplies,
  listThreads,
  messagePartHashes,
  updateDiscussion,
  updateReply,
  type SourceAnchor,
} from "../src/discussions";
import { contentHash } from "../src/content-hash";
import { contentHash as uiContentHash } from "../../ui/src/lib/hash";
import * as ltm from "../src/ltm";

let seq = 0;
function project(): { id: string; path: string } {
  const path = `/test/discussions/${Date.now()}-${seq++}`;
  return { id: ensureProject(path), path };
}

function message(
  projectId: string,
  sessionId: string,
  content: string,
  role = "user",
  metadata: Record<string, unknown> | null = null,
): string {
  const id = `msg-${Date.now()}-${seq++}`;
  db()
    .query(
      "INSERT INTO temporal_messages (id, project_id, session_id, role, content, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      id,
      projectId,
      sessionId,
      role,
      content,
      Date.now() + seq,
      metadata ? JSON.stringify(metadata) : null,
    );
  return id;
}

function partAnchor(
  messageId: string,
  content: string,
  partIndex: number,
  start: number,
  end: number,
): SourceAnchor {
  return {
    blockId: `m.${messageId}`,
    partIndex,
    start,
    end,
    contentHash: messagePartHashes(content)[partIndex],
  };
}

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof DiscussionError) return e.code;
    throw e;
  }
  return undefined;
}

describe("discussions", () => {
  let p: { id: string; path: string };
  let msgId: string;
  const content =
    "Hello there\n\x1f[reasoning] think hard\n\x1f[tool:bash] ls -la";

  beforeEach(() => {
    p = project();
    msgId = message(p.id, "s1", content);
  });

  function start(body?: string) {
    return createDiscussion({
      projectId: p.id,
      source: { kind: "session", id: "s1" },
      anchors: [partAnchor(msgId, content, 0, 0, 5)],
      quote: "Hello",
      body,
    });
  }

  it("mirrors the UI reader's part hashing", () => {
    for (const text of ["", "hello", "héllo — ✓", "a\n\x1fb"]) {
      expect(contentHash(text)).toBe(uiContentHash(text));
    }
    expect(messagePartHashes(content)).toEqual([
      contentHash("Hello there"),
      contentHash("think hard"),
      contentHash("ls -la"),
    ]);
    expect(knowledgePartHashes("a\n\n\n  b  \n\n")).toEqual([
      contentHash("a"),
      contentHash("b"),
    ]);
    expect(blockHashOf(["x"])).toBe("x");
  });

  it("persists identity across reload and connection/cache reset", () => {
    const { discussion, reply } = start("first");
    close();
    const again = getDiscussion(p.id, discussion.id);
    expect(again.id).toBe(discussion.id);
    expect(again.anchors).toEqual(discussion.anchors);
    expect(again.quote).toBe("Hello");
    expect(again.revision).toBe(1);
    expect(again.replyCount).toBe(1);
    const replies = listReplies(p.id, discussion.id).replies;
    expect(replies.map((r) => r.id)).toEqual([reply!.id]);
  });

  it("orders replies deterministically and rejects concurrent writers on the same revision", () => {
    const { discussion } = start();
    const a = addReply(p.id, discussion.id, {
      expectedRevision: 1,
      body: "a",
    });
    // A second writer that read revision 1 concurrently loses.
    expect(
      code(() =>
        addReply(p.id, discussion.id, { expectedRevision: 1, body: "b" }),
      ),
    ).toBe("revision_conflict");
    const b = addReply(p.id, discussion.id, {
      expectedRevision: a.discussion.revision,
      body: "b",
      parentReplyId: a.reply.id,
    });
    addReply(p.id, discussion.id, {
      expectedRevision: b.discussion.revision,
      body: "c",
      author: "agent:claude",
    });
    const replies = listReplies(p.id, discussion.id).replies;
    expect(replies.map((r) => [r.seq, r.content])).toEqual([
      [1, { kind: "text", body: "a" }],
      [2, { kind: "text", body: "b" }],
      [3, { kind: "text", body: "c" }],
    ]);
    expect(replies[1].parentReplyId).toBe(a.reply.id);
    const d = getDiscussion(p.id, discussion.id);
    expect(d.replyCount).toBe(3);
    expect(d.participants).toEqual(["user", "agent:claude"]);
    const paged = listReplies(p.id, discussion.id, { limit: 2 });
    expect(paged.nextSeq).toBe(2);
    expect(
      listReplies(p.id, discussion.id, { afterSeq: 2 }).replies.map(
        (r) => r.seq,
      ),
    ).toEqual([3]);
  });

  it("requires exactly one of authored text or a bound response", () => {
    const { discussion } = start();
    const answer = message(p.id, "s1", "the answer", "assistant", {
      agent: "codex",
    });
    expect(
      code(() =>
        addReply(p.id, discussion.id, {
          expectedRevision: 1,
          body: "x",
          responseMessageId: answer,
        }),
      ),
    ).toBe("invalid");
    expect(
      code(() => addReply(p.id, discussion.id, { expectedRevision: 1 })),
    ).toBe("invalid");
    const bound = addReply(p.id, discussion.id, {
      expectedRevision: 1,
      responseMessageId: answer,
    });
    expect(bound.reply.author).toBe("agent:codex");
    expect(bound.reply.content).toMatchObject({
      kind: "response",
      binding: { messageId: answer, sessionId: "s1", agent: "codex" },
    });
    expect(
      code(() =>
        updateReply(p.id, discussion.id, bound.reply.id, {
          expectedRevision: 1,
          body: "edited",
        }),
      ),
    ).toBe("invalid");
    // Only assistant messages of this project verify.
    expect(
      code(() =>
        addReply(p.id, discussion.id, {
          expectedRevision: 2,
          responseMessageId: msgId,
        }),
      ),
    ).toBe("invalid");
    const other = project();
    const foreign = message(other.id, "s9", "elsewhere", "assistant");
    expect(
      code(() =>
        addReply(p.id, discussion.id, {
          expectedRevision: 2,
          responseMessageId: foreign,
        }),
      ),
    ).toBe("not_found");
    // The DB enforces the XOR even for direct writes.
    expect(() =>
      db()
        .query(
          "INSERT INTO discussion_replies (id, discussion_id, project_id, seq, author, body, response_binding_id, created_at, updated_at) VALUES ('x', ?, ?, 99, 'user', 'both', ?, 0, 0)",
        )
        .run(
          discussion.id,
          p.id,
          bound.reply.content.kind === "response"
            ? bound.reply.content.binding.id
            : "",
        ),
    ).toThrow();
  });

  it("rejects stale expected_revision on every mutation", () => {
    const { discussion } = start();
    expect(
      code(() =>
        updateDiscussion(p.id, discussion.id, {
          expectedRevision: 7,
          state: "resolved",
        }),
      ),
    ).toBe("revision_conflict");
    const resolved = updateDiscussion(p.id, discussion.id, {
      expectedRevision: 1,
      state: "resolved",
    });
    expect(resolved).toMatchObject({ state: "resolved", revision: 2 });
    expect(code(() => deleteDiscussion(p.id, discussion.id, 1))).toBe(
      "revision_conflict",
    );
    try {
      deleteDiscussion(p.id, discussion.id, 1);
    } catch (e) {
      expect((e as DiscussionError).currentRevision).toBe(2);
    }
    deleteDiscussion(p.id, discussion.id, 2);
    expect(code(() => getDiscussion(p.id, discussion.id))).toBe("not_found");
  });

  it("refuses to anchor to a source that already changed", () => {
    expect(
      code(() =>
        createDiscussion({
          projectId: p.id,
          source: { kind: "session", id: "s1" },
          anchors: [
            { ...partAnchor(msgId, content, 0, 0, 5), contentHash: "zz" },
          ],
          quote: "Hello",
        }),
      ),
    ).toBe("source_changed");
    expect(
      code(() =>
        createDiscussion({
          projectId: p.id,
          source: { kind: "session", id: "other-session" },
          anchors: [partAnchor(msgId, content, 0, 0, 5)],
          quote: "Hello",
        }),
      ),
    ).toBe("not_found");
  });

  it("validates one ordered, non-overlapping selection", () => {
    const base = partAnchor(msgId, content, 0, 0, 5);
    const create = (anchors: unknown) =>
      code(() =>
        createDiscussion({
          projectId: p.id,
          source: { kind: "session", id: "s1" },
          anchors,
          quote: "q",
        }),
      );
    expect(create([])).toBe("invalid");
    expect(create([{ ...base, start: 3, end: 3 }])).toBe("invalid");
    expect(create([base, { ...base, start: 2, end: 8 }])).toBe("invalid");
    expect(create([{ ...base, blockId: "k.x" }])).toBe("invalid");
    expect(create([base, partAnchor(msgId, content, 1, 0, 4)])).toBeUndefined();
    const whole = {
      blockId: `m.${msgId}`,
      start: 0,
      end: 0,
      contentHash: contentHash(messagePartHashes(content).join("|")),
    };
    expect(create([whole])).toBeUndefined();
    expect(create([{ ...whole, end: 4 }])).toBe("invalid");
  });

  it("marks stale_anchor when the source changes and never re-anchors", () => {
    const logicalId = ltm.create({
      projectPath: p.path,
      scope: "project",
      category: "gotcha",
      title: "Anchored entry",
      content: "First paragraph.\n\nSecond paragraph.",
    });
    const anchor: SourceAnchor = {
      blockId: knowledgeBlockId(logicalId),
      partIndex: 1,
      start: 0,
      end: 6,
      contentHash: contentHash("Second paragraph."),
    };
    const { discussion } = createDiscussion({
      projectId: p.id,
      source: { kind: "knowledge", id: logicalId },
      anchors: [anchor],
      quote: "Second",
    });
    expect(discussion.anchorStatus).toBe("current");
    ltm.update(logicalId, {
      content: "First paragraph.\n\nSecond paragraph, edited.",
    });
    const stale = getDiscussion(p.id, discussion.id);
    expect(stale.anchorStatus).toBe("stale_anchor");
    expect(stale.anchors).toEqual([anchor]);
    expect(stale.sourceHash).toBe(discussion.sourceHash);
    // One-way: restoring the text does not silently re-attach.
    ltm.update(logicalId, {
      content: "First paragraph.\n\nSecond paragraph.",
    });
    expect(getDiscussion(p.id, discussion.id).anchorStatus).toBe(
      "stale_anchor",
    );
  });

  it("marks source_missing when the anchored message is gone", () => {
    const { discussion } = start();
    db().query("DELETE FROM temporal_messages WHERE id = ?").run(msgId);
    expect(getDiscussion(p.id, discussion.id).anchorStatus).toBe(
      "source_missing",
    );
    expect(
      listDiscussions({ projectId: p.id, limit: 10 }).discussions[0]
        ?.anchorStatus,
    ).toBe("source_missing");
  });

  it("marks source_missing when an anchored paragraph is removed", () => {
    const logicalId = ltm.create({
      projectPath: p.path,
      scope: "project",
      category: "gotcha",
      title: "Two paragraphs",
      content: "One.\n\nTwo.",
    });
    const { discussion } = createDiscussion({
      projectId: p.id,
      source: { kind: "knowledge", id: logicalId },
      anchors: [
        {
          blockId: knowledgeBlockId(logicalId),
          partIndex: 1,
          start: 0,
          end: 3,
          contentHash: contentHash("Two."),
        },
      ],
      quote: "Two",
    });
    ltm.update(logicalId, { content: "One." });
    expect(getDiscussion(p.id, discussion.id).anchorStatus).toBe(
      "source_missing",
    );
  });

  it("binds only responses from a session discussion's own session", () => {
    const { discussion } = start();
    const elsewhere = message(p.id, "s2", "other session", "assistant");
    expect(
      code(() =>
        addReply(p.id, discussion.id, {
          expectedRevision: 1,
          responseMessageId: elsewhere,
        }),
      ),
    ).toBe("invalid");
  });

  it("moves session discussions with their session and drops stranded bound replies", () => {
    const { discussion } = start();
    const answer = message(p.id, "s1", "the answer", "assistant");
    addReply(p.id, discussion.id, {
      expectedRevision: 1,
      responseMessageId: answer,
    });
    const logicalId = ltm.create({
      projectPath: p.path,
      scope: "project",
      category: "gotcha",
      title: "Stays behind",
      content: "Para.",
    });
    const k = createDiscussion({
      projectId: p.id,
      source: { kind: "knowledge", id: logicalId },
      anchors: [
        {
          blockId: knowledgeBlockId(logicalId),
          partIndex: 0,
          start: 0,
          end: 4,
          contentHash: contentHash("Para."),
        },
      ],
      quote: "Para",
    });
    const bound = addReply(p.id, k.discussion.id, {
      expectedRevision: k.discussion.revision,
      responseMessageId: answer,
    });
    const text = addReply(p.id, k.discussion.id, {
      expectedRevision: bound.discussion.revision,
      body: "kept",
    });

    const target = `/test/discussions/move-${Date.now()}-${seq++}`;
    moveSessions(["s1"], p.id, target);
    const to = ensureProject(target);

    expect(code(() => getDiscussion(p.id, discussion.id))).toBe("not_found");
    expect(listReplies(to, discussion.id).replies).toHaveLength(1);
    const kept = listReplies(p.id, k.discussion.id).replies;
    expect(kept.map((r) => r.id)).toEqual([text.reply.id]);
    expect(getDiscussion(p.id, k.discussion.id).revision).toBeGreaterThan(
      text.discussion.revision,
    );
    const orphans = db()
      .query(
        "SELECT COUNT(*) AS n FROM discussion_replies r JOIN response_bindings b ON b.id = r.response_binding_id WHERE r.project_id <> b.project_id",
      )
      .get() as { n: number };
    expect(orphans.n).toBe(0);
  });

  it("isolates projects", () => {
    const { discussion } = start("mine");
    const other = project();
    expect(code(() => getDiscussion(other.id, discussion.id))).toBe(
      "not_found",
    );
    expect(code(() => listReplies(other.id, discussion.id))).toBe("not_found");
    expect(
      code(() =>
        addReply(other.id, discussion.id, { expectedRevision: 1, body: "x" }),
      ),
    ).toBe("not_found");
    expect(
      code(() =>
        updateDiscussion(other.id, discussion.id, {
          expectedRevision: 1,
          state: "resolved",
        }),
      ),
    ).toBe("not_found");
    expect(
      listDiscussions({ projectId: other.id, limit: 10 }).discussions,
    ).toEqual([]);
    // Anchoring to another project's message is a missing source.
    expect(
      code(() =>
        createDiscussion({
          projectId: other.id,
          source: { kind: "session", id: "s1" },
          anchors: [partAnchor(msgId, content, 0, 0, 5)],
          quote: "Hello",
        }),
      ),
    ).toBe("not_found");
    const otherThread = createThread({ projectId: other.id, title: "theirs" });
    expect(
      code(() =>
        updateDiscussion(p.id, discussion.id, {
          expectedRevision: 1,
          threadId: otherThread.id,
        }),
      ),
    ).toBe("not_found");
    expect(
      listDiscussionsByActivity({ projectId: other.id, limit: 10 }).discussions,
    ).toEqual([]);
  });

  it("pages by (last_activity_at DESC, id DESC) and filters by source", () => {
    const made = [start(), start(), start()].map((r) => r.discussion);
    addReply(p.id, made[0].id, { expectedRevision: 1, body: "bump" });
    const first = listDiscussions({ projectId: p.id, limit: 2 });
    expect(first.discussions.map((d) => d.id)).toEqual([
      made[0].id,
      made[2].id,
    ]);
    const rest = listDiscussions({
      projectId: p.id,
      limit: 2,
      after: first.next!,
    });
    expect(rest.discussions.map((d) => d.id)).toEqual([made[1].id]);
    expect(rest.next).toBeNull();
    expect(
      listDiscussions({
        projectId: p.id,
        limit: 10,
        source: { kind: "session", id: "nope" },
      }).discussions,
    ).toEqual([]);
    const activity = listDiscussionsByActivity({ limit: 100 }).discussions.map(
      (d) => d.id,
    );
    expect(activity.indexOf(made[0].id)).toBeLessThan(
      activity.indexOf(made[2].id),
    );
  });

  it("deleting a reply is activity: the discussion moves to the top", () => {
    const older = start().discussion;
    const { reply } = addReply(p.id, older.id, {
      expectedRevision: 1,
      body: "to delete",
    });
    const newer = start().discussion;
    const order = () =>
      listDiscussions({ projectId: p.id, limit: 10 }).discussions.map(
        (d) => d.id,
      );
    expect(order()).toEqual([newer.id, older.id]);
    deleteReply(p.id, older.id, reply.id, reply.revision);
    expect(order()).toEqual([older.id, newer.id]);
    expect(
      listDiscussionsByActivity({ projectId: p.id, limit: 10 }).discussions[0]
        ?.id,
    ).toBe(older.id);
  });

  it("links discussions to threads and unlinks on thread delete", () => {
    const thread = createThread({ projectId: p.id, title: "Auth rework" });
    const { discussion } = start();
    const linked = updateDiscussion(p.id, discussion.id, {
      expectedRevision: 1,
      threadId: thread.id,
    });
    expect(linked.threadId).toBe(thread.id);
    expect(getThread(p.id, thread.id).discussionCount).toBe(1);
    expect(listThreads({ projectId: p.id, limit: 10 }).threads[0]?.id).toBe(
      thread.id,
    );
    expect(code(() => deleteThread(p.id, thread.id, 9))).toBe(
      "revision_conflict",
    );
    deleteThread(p.id, thread.id, 1);
    expect(getDiscussion(p.id, discussion.id)).toMatchObject({
      threadId: null,
      revision: 3,
    });
  });

  it("deletes a project's discussions with the project", () => {
    const { discussion } = start("bye");
    createThread({ projectId: p.id, title: "t" });
    expect(deleteProject(p.id)).not.toBeNull();
    for (const table of [
      "discussions",
      "discussion_replies",
      "threads",
      "response_bindings",
    ]) {
      const row = db()
        .query(`SELECT COUNT(*) AS c FROM ${table} WHERE project_id = ?`)
        .get(p.id) as { c: number };
      expect(row.c).toBe(0);
    }
    expect(code(() => getDiscussion(p.id, discussion.id))).toBe("not_found");
  });
});
