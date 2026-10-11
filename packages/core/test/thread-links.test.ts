import { describe, expect, it } from "vitest";
import { close, db, ensureProject, mergeProjectInternal } from "../src/db";
import { deleteProject, moveSessions } from "../src/data";
import {
  AnchorError,
  knowledgeBlockId,
  knowledgePartHashes,
  messagePartHashes,
  type SourceAnchor,
} from "../src/source-anchors";
import {
  bindChildSession,
  createThreadLink,
  deleteThreadLink,
  findThreadLink,
  findThreadLinkByChild,
  getThreadLink,
  listThreadLinks,
  listThreadLinksByActivity,
  touchThreadActivity,
  updateThreadLink,
} from "../src/thread-links";
import { createAnchoredNote, listAnchoredNotes } from "../src/anchored-notes";
import * as ltm from "../src/ltm";

let seq = 0;
function project(): { id: string; path: string } {
  const path = `/test/thread-links/${Date.now()}-${seq++}`;
  return { id: ensureProject(path), path };
}

function message(
  projectId: string,
  sessionId: string,
  content: string,
): string {
  const id = `msg-${Date.now()}-${seq++}`;
  db()
    .query(
      "INSERT INTO temporal_messages (id, project_id, session_id, role, content, created_at) VALUES (?, ?, ?, 'user', ?, ?)",
    )
    .run(id, projectId, sessionId, content, Date.now() + seq);
  return id;
}

function anchor(
  messageId: string,
  content: string,
  start = 0,
  end = 4,
): SourceAnchor {
  return {
    blockId: `m.${messageId}`,
    partIndex: 0,
    start,
    end,
    contentHash: messagePartHashes(content)[0],
  };
}

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof AnchorError) return e.code;
    throw e;
  }
  return undefined;
}

function seeded(text = "hello world") {
  const p = project();
  const session = `s-${seq++}`;
  const mid = message(p.id, session, text);
  const link = createThreadLink({
    projectId: p.id,
    source: { kind: "session", id: session },
    anchors: [anchor(mid, text)],
    quote: "hell",
    agent: "claude-code",
    forkMode: "seeded",
  });
  return { p, session, mid, link };
}

describe("thread links", () => {
  it("derives parent session and fork point from the selection", () => {
    const { session, mid, link } = seeded();
    expect(link).toMatchObject({
      parentSessionId: session,
      forkPoint: mid,
      state: "starting",
      anchorStatus: "current",
      revision: 1,
      childSessionId: null,
      worktree: null,
    });
  });

  it("survives a reload with the same identity", () => {
    const { p, link } = seeded();
    close();
    expect(getThreadLink(p.id, link.id)).toEqual(link);
  });

  it("rejects a selection whose source changed before creation", () => {
    const p = project();
    const mid = message(p.id, "s", "hello world");
    const bad = { ...anchor(mid, "hello world"), contentHash: "zzz" };
    expect(
      code(() =>
        createThreadLink({
          projectId: p.id,
          source: { kind: "session", id: "s" },
          anchors: [bad],
          quote: "hell",
          agent: "claude-code",
          forkMode: "native",
        }),
      ),
    ).toBe("source_changed");
  });

  it("enforces revisions and lifecycle transitions", () => {
    const { p, link } = seeded();
    expect(
      code(() =>
        updateThreadLink(p.id, link.id, {
          expectedRevision: 9,
          state: "running",
        }),
      ),
    ).toBe("revision_conflict");
    const running = updateThreadLink(p.id, link.id, {
      expectedRevision: 1,
      state: "running",
      acpSessionId: "acp-1",
      worktree: { path: "/tmp/wt", branch: "lore/thread-1" },
    });
    expect(running).toMatchObject({
      state: "running",
      revision: 2,
      acpSessionId: "acp-1",
      worktree: { path: "/tmp/wt", branch: "lore/thread-1" },
    });
    expect(
      code(() =>
        updateThreadLink(p.id, link.id, {
          expectedRevision: 2,
          state: "failed",
        }),
      ),
    ).toBe("invalid");
    const failed = updateThreadLink(p.id, link.id, {
      expectedRevision: 2,
      state: "failed",
      error: "agent exited",
    });
    expect(failed.error).toBe("agent exited");
    expect(
      code(() =>
        updateThreadLink(p.id, link.id, {
          expectedRevision: 3,
          state: "running",
        }),
      ),
    ).toBe("invalid");
    const closed = updateThreadLink(p.id, link.id, {
      expectedRevision: 3,
      state: "closed",
    });
    expect(closed).toMatchObject({ state: "closed", error: null });
  });

  it("binds a child session once and orders by its activity", () => {
    const a = seeded();
    const b = seeded();
    expect(bindChildSession(a.link.id, "child-a")).toBe(true);
    expect(bindChildSession(a.link.id, "child-a")).toBe(true);
    expect(bindChildSession(a.link.id, "other")).toBe(false);
    expect(bindChildSession(b.link.id, "child-a")).toBe(false);
    expect(findThreadLinkByChild("child-a")?.id).toBe(a.link.id);
    expect(findThreadLink(a.link.id)?.childSessionId).toBe("child-a");
    touchThreadActivity("child-a");
    const ids = listThreadLinksByActivity({ limit: 500 }).threads.map(
      (t) => t.id,
    );
    expect(ids.indexOf(a.link.id)).toBeLessThan(ids.indexOf(b.link.id));
  });

  it("pages a project by (last_activity_at DESC, id DESC) and isolates projects", () => {
    const { p, session, mid } = seeded();
    for (let i = 0; i < 2; i++) {
      createThreadLink({
        projectId: p.id,
        source: { kind: "session", id: session },
        anchors: [anchor(mid, "hello world")],
        quote: "hell",
        agent: "opencode",
        forkMode: "native",
      });
    }
    const first = listThreadLinks({ projectId: p.id, limit: 2 });
    expect(first.threads).toHaveLength(2);
    const rest = listThreadLinks({
      projectId: p.id,
      limit: 2,
      after: first.next!,
    });
    expect(rest.threads).toHaveLength(1);
    expect(rest.next).toBeNull();
    const other = project();
    expect(listThreadLinks({ projectId: other.id, limit: 10 }).threads).toEqual(
      [],
    );
    expect(code(() => getThreadLink(other.id, first.threads[0].id))).toBe(
      "not_found",
    );
  });

  it("marks stale and missing anchors without re-anchoring", () => {
    const { p, mid, link } = seeded();
    db()
      .query("UPDATE temporal_messages SET content = 'changed' WHERE id = ?")
      .run(mid);
    const stale = getThreadLink(p.id, link.id);
    expect(stale.anchorStatus).toBe("stale_anchor");
    expect(stale.anchors).toEqual(link.anchors);
    db().query("DELETE FROM temporal_messages WHERE id = ?").run(mid);
    expect(getThreadLink(p.id, link.id).anchorStatus).toBe("source_missing");
  });

  it("follows its source session on move and its project on merge", () => {
    const { p, session, link } = seeded();
    const to = project();
    moveSessions([session], p.id, to.path);
    expect(getThreadLink(to.id, link.id).projectId).toBe(to.id);
    const target = project();
    mergeProjectInternal(to.id, target.id);
    expect(getThreadLink(target.id, link.id).projectId).toBe(target.id);
    deleteProject(target.id);
    expect(findThreadLink(link.id)).toBeNull();
  });

  it("deletes with an expected revision", () => {
    const { p, link } = seeded();
    expect(code(() => deleteThreadLink(p.id, link.id, 2))).toBe(
      "revision_conflict",
    );
    deleteThreadLink(p.id, link.id, 1);
    expect(findThreadLink(link.id)).toBeNull();
  });
});

describe("anchored notes", () => {
  it("creates a knowledge entry carrying the anchor, without title dedup", () => {
    const { p, session, mid } = seeded();
    const existing = ltm.create({
      projectPath: p.path,
      scope: "project",
      category: "pattern",
      title: "Same title",
      content: "unrelated",
    });
    const note = createAnchoredNote({
      projectId: p.id,
      source: { kind: "session", id: session },
      anchors: [anchor(mid, "hello world")],
      quote: "hell",
      category: "gotcha",
      title: "Same title",
      content: "my note",
      createdBy: "user",
    });
    expect(note.id).not.toBe(existing);
    expect(note).toMatchObject({
      category: "gotcha",
      content: "my note",
      anchorStatus: "current",
    });
    expect(ltm.get(existing)?.content).toBe("unrelated");
    const listed = listAnchoredNotes({
      projectId: p.id,
      source: { kind: "session", id: session },
    });
    expect(listed.map((n) => n.id)).toEqual([note.id]);
  });

  it("anchors on a knowledge entry and rejects bad categories", () => {
    const p = project();
    const entry = ltm.create({
      projectPath: p.path,
      scope: "project",
      category: "decision",
      title: `Entry ${seq++}`,
      content: "first paragraph",
    });
    const kAnchor = {
      blockId: knowledgeBlockId(entry),
      partIndex: 0,
      start: 0,
      end: 5,
      contentHash: knowledgePartHashes("first paragraph")[0],
    };
    const input = {
      projectId: p.id,
      source: { kind: "knowledge" as const, id: entry },
      anchors: [kAnchor],
      quote: "first",
      title: "Note",
      content: "body",
    };
    expect(code(() => createAnchoredNote({ ...input, category: "nope" }))).toBe(
      "invalid",
    );
    const note = createAnchoredNote({ ...input, category: "pattern" });
    expect(note.source).toEqual({ kind: "knowledge", id: entry });
  });
});
