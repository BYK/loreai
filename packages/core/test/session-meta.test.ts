/**
 * Tests for the session_meta derived cache (#1921): refresh-on-list,
 * staleness rules, invalidation on edits/deletes/moves, and title search on
 * `listSessionsPage`.
 */
import { describe, expect, test, afterEach } from "vitest";
import { uuidv7 } from "uuidv7";
import { db, ensureProject } from "../src/db";
import * as log from "../src/log";
import * as temporal from "../src/temporal";
import {
  deleteSession,
  listSessions,
  moveSessions,
  sessionTitle,
  setSessionTitle,
} from "../src/data";
import { listSessionsPage } from "../src/list-query";
import { refreshSessionMeta } from "../src/session-meta";
import type { LoreMessage, LorePart } from "../src/types";

let seq = 0;
function freshProject(tag: string): string {
  return `/test/session-meta/${tag}/${++seq}`;
}

function msg(sessionID: string, id: string, created: number): LoreMessage {
  return {
    id,
    sessionID,
    role: "user",
    time: { created },
    agent: "build",
    model: { providerID: "anthropic", modelID: "m" },
  };
}

function textParts(
  sessionID: string,
  messageID: string,
  text: string,
): LorePart[] {
  return [
    {
      id: `part-${messageID}`,
      sessionID,
      messageID,
      type: "text",
      text,
      time: { start: 0, end: 0 },
    },
  ];
}

function toolParts(sessionID: string, messageID: string): LorePart[] {
  return [
    {
      id: `part-${messageID}`,
      sessionID,
      messageID,
      type: "tool",
      tool: "bash",
      state: { status: "completed", output: "tool output" },
      time: { start: 0, end: 0 },
    },
  ];
}

function store(
  project: string,
  sid: string,
  mid: string,
  created: number,
  text: string,
) {
  temporal.store({
    projectPath: project,
    info: msg(sid, mid, created),
    parts: textParts(sid, mid, text),
  });
}

function storeToolOnly(
  project: string,
  sid: string,
  mid: string,
  created: number,
) {
  temporal.store({
    projectPath: project,
    info: msg(sid, mid, created),
    parts: toolParts(sid, mid),
  });
}

function insertDistillation(project: string, sid: string, narrative: string) {
  const pid = (
    db().query("SELECT id FROM projects WHERE path = ?").get(project) as {
      id: string;
    }
  ).id;
  db()
    .query(
      `INSERT INTO distillations (id, project_id, session_id, narrative, facts, observations, source_ids, generation, token_count, archived, created_at)
       VALUES (?, ?, ?, ?, '', ?, '[]', 0, 10, 0, ?)`,
    )
    .run(uuidv7(), pid, sid, narrative, narrative, Date.now());
}

function pidOf(project: string): string {
  return (
    db().query("SELECT id FROM projects WHERE path = ?").get(project) as {
      id: string;
    }
  ).id;
}

// session_meta is keyed (project_id, session_id); other tests reuse the same
// session ids under different projects, so always scope the probe.
function metaRow(project: string, sid: string) {
  return db()
    .query(
      "SELECT title, title_source, message_count, distillation_count FROM session_meta WHERE project_id = ? AND session_id = ?",
    )
    .get(pidOf(project), sid) as {
    title: string;
    title_source: string;
    message_count: number;
    distillation_count: number;
  } | null;
}

/** Count session_meta INSERTs (recomputes) executed while `fn` runs. */
function countRecomputes(fn: () => void): number {
  let writes = 0;
  log.registerSink({
    info() {},
    warn() {},
    error() {},
    captureException() {},
    withDbSpan(sql, run) {
      if (/INSERT INTO session_meta/i.test(sql)) writes++;
      return run();
    },
  });
  try {
    fn();
  } finally {
    log.registerSink({
      info() {},
      warn() {},
      error() {},
      captureException() {},
    });
  }
  return writes;
}

afterEach(() => {
  log.registerSink({
    info() {},
    warn() {},
    error() {},
    captureException() {},
  });
});

describe("listSessions titles", () => {
  test("list returns derived titles with sources", () => {
    const project = freshProject("list");
    store(project, "s-a", "m1", 1000, "Fix the login redirect");
    storeToolOnly(project, "s-b", "m2", 2000);
    const rows = listSessions(project, 50);
    const byId = new Map(rows.map((r) => [r.session_id, r]));
    expect(byId.get("s-a")).toMatchObject({
      title: "Fix the login redirect",
      title_source: "first_message",
    });
    expect(byId.get("s-b")).toMatchObject({
      title: "s-b",
      title_source: "id",
    });
  });

  test("the first list creates cache rows; the second recomputes nothing", () => {
    const project = freshProject("cache");
    store(project, "s-a", "m1", 1000, "hello world");
    let writes = countRecomputes(() => listSessions(project));
    expect(writes).toBe(1);
    expect(metaRow(project, "s-a")).toMatchObject({
      title: "hello world",
      title_source: "first_message",
    });
    writes = countRecomputes(() => listSessions(project));
    expect(writes).toBe(0);
  });

  test("stale 'id' row recomputes when a distillation arrives; 'first_message' does not", () => {
    const project = freshProject("stale");
    storeToolOnly(project, "s-tools", "t1", 1000);
    store(project, "s-text", "x1", 2000, "plain text");
    listSessions(project);
    expect(metaRow(project, "s-tools")?.title_source).toBe("id");

    insertDistillation(project, "s-tools", "# Deploy pipeline work");
    // More messages on the first_message session should NOT recompute it.
    store(project, "s-text", "x2", 3000, "more chatter");

    let writes = countRecomputes(() => listSessions(project));
    expect(writes).toBe(1);
    expect(metaRow(project, "s-tools")).toMatchObject({
      title: "Deploy pipeline work",
      title_source: "distillation",
    });
    expect(metaRow(project, "s-text")?.title).toBe("plain text");
  });

  test("editing a user message's content invalidates the cached title", () => {
    const project = freshProject("edit");
    store(project, "s-e", "m1", 1000, "original title");
    listSessions(project);
    expect(metaRow(project, "s-e")?.title).toBe("original title");

    // Re-store the same message id with different content → UPDATE branch.
    store(project, "s-e", "m1", 1000, "edited title");
    expect(metaRow(project, "s-e")).toBeNull();
    listSessions(project);
    expect(metaRow(project, "s-e")?.title).toBe("edited title");
  });

  test("setSessionTitle wins over everything and invalidates the cache", () => {
    const project = freshProject("explicit");
    store(project, "s-x", "m1", 1000, "first message text");
    listSessions(project);
    setSessionTitle("s-x", "  Custom  Title ");
    const rows = listSessions(project);
    expect(rows[0]).toMatchObject({
      title: "Custom Title",
      title_source: "explicit",
    });
    // Clearing falls back to first message again.
    setSessionTitle("s-x", null);
    expect(listSessions(project)[0]?.title).toBe("first message text");
  });

  test("a stale/wrong meta row present before the list is corrected", () => {
    const project = freshProject("adversarial");
    const pid = ensureProject(project);
    // Seed a bogus row BEFORE the session even produces its data.
    db()
      .query(
        `INSERT INTO session_meta (project_id, session_id, title, title_norm, title_source, message_count, distillation_count, computed_at)
         VALUES (?, 's-z', 'WRONG', 'wrong', 'id', 0, 0, 0)`,
      )
      .run(pid);
    store(project, "s-z", "m1", 1000, "real first message");
    const rows = listSessions(project);
    expect(rows[0]).toMatchObject({
      title: "real first message",
      title_source: "first_message",
    });
  });

  test("deleteSession removes the meta row; moveSessions relocates it", () => {
    const project = freshProject("del");
    const target = freshProject("del-target");
    store(project, "s-gone", "m1", 1000, "bye");
    store(project, "s-move", "m2", 2000, "move me");
    listSessions(project);
    expect(metaRow(project, "s-gone")).not.toBeNull();

    deleteSession(project, "s-gone");
    expect(metaRow(project, "s-gone")).toBeNull();

    const pid = pidOf(project);
    moveSessions(["s-move"], pid, target);
    // Gone from the source project key; recomputed under the target.
    const stale = db()
      .query(
        "SELECT COUNT(*) AS c FROM session_meta WHERE project_id = ? AND session_id = 's-move'",
      )
      .get(pid) as { c: number };
    expect(stale.c).toBe(0);
    const rows = listSessions(target);
    expect(rows[0]).toMatchObject({ session_id: "s-move", title: "move me" });
  });
});

describe("listSessionsPage search (q)", () => {
  test("matches title substring case-insensitively, incl. unicode", () => {
    const project = freshProject("q");
    store(project, "s-u", "m1", 1000, "Ünïcode deploy notes");
    store(project, "s-v", "m2", 2000, "totally different topic");
    const page = listSessionsPage(project, { limit: 50, q: "ünïcode" });
    expect(page.items.map((s) => s.session_id)).toEqual(["s-u"]);
    expect(page.items[0]?.title).toBe("Ünïcode deploy notes");
    expect(page.next).toBeNull();
  });

  test("matches session-id prefix; LIKE metacharacters are literal", () => {
    const project = freshProject("q2");
    store(project, "sess-abc", "m1", 1000, "alpha");
    store(project, "sess-abd", "m2", 2000, "beta");
    store(project, "other", "m3", 3000, "gamma");
    expect(
      listSessionsPage(project, { limit: 50, q: "sess-ab" }).items.map(
        (s) => s.session_id,
      ),
    ).toEqual(["sess-abd", "sess-abc"]);
    // `%` and `_` in q are literal, not wildcards.
    expect(
      listSessionsPage(project, { limit: 50, q: "sess-ab%" }).items,
    ).toHaveLength(0);
    expect(
      listSessionsPage(project, { limit: 50, q: "sess_ab" }).items,
    ).toHaveLength(0);
  });

  test("no match → empty items and null next; paging with after works", () => {
    const project = freshProject("q3");
    for (let i = 0; i < 5; i++) {
      store(project, `s-${i}`, `m${i}`, 1000 + i, `needle ${i}`);
    }
    const none = listSessionsPage(project, { limit: 50, q: "absent" });
    expect(none.items).toHaveLength(0);
    expect(none.next).toBeNull();

    const p1 = listSessionsPage(project, { limit: 2, q: "needle" });
    expect(p1.items.map((s) => s.session_id)).toEqual(["s-4", "s-3"]);
    const p2 = listSessionsPage(project, {
      limit: 2,
      q: "needle",
      after: p1.next!,
    });
    expect(p2.items.map((s) => s.session_id)).toEqual(["s-2", "s-1"]);
    const p3 = listSessionsPage(project, {
      limit: 2,
      q: "needle",
      after: p2.next!,
    });
    expect(p3.items.map((s) => s.session_id)).toEqual(["s-0"]);
    expect(p3.next).toBeNull();
  });

  test("deleted sessions never appear in search results", () => {
    const project = freshProject("q4");
    store(project, "s-del", "m1", 1000, "needle removal");
    listSessionsPage(project, { limit: 50, q: "needle" });
    deleteSession(project, "s-del");
    const page = listSessionsPage(project, { limit: 50, q: "needle" });
    expect(page.items).toHaveLength(0);
  });

  test("sessionTitle computes a single session's title (no messages → id)", () => {
    const project = freshProject("single");
    store(project, "s-one", "m1", 1000, "only message");
    expect(sessionTitle(project, "s-one")).toEqual({
      title: "only message",
      title_source: "first_message",
    });
    expect(sessionTitle(project, "s-nothing")).toEqual({
      title: "s-nothing",
      title_source: "id",
    });
  });
});

describe("refreshSessionMeta", () => {
  test("force re-derives fresh-looking rows", () => {
    const project = freshProject("force");
    store(project, "s-f", "m1", 1000, "hello");
    const pid = pidOf(project);
    refreshSessionMeta(pid, [
      { session_id: "s-f", message_count: 1, distillation_count: 0 },
    ]);
    const writes = countRecomputes(() => {
      refreshSessionMeta(
        pid,
        [{ session_id: "s-f", message_count: 1, distillation_count: 0 }],
        { force: true },
      );
    });
    expect(writes).toBe(1);
  });
});

describe("temporal.prune — session_meta cache drop", () => {
  test("a prune that deletes messages drops the cached title", () => {
    const project = freshProject("prune");
    const day = 24 * 60 * 60 * 1000;
    // First message is old enough to age out; second is recent — after the
    // prune, the title must be re-derived from the second message, not served
    // from the cached first_message row.
    store(project, "s-prune", "m1", Date.now() - 10 * day, "old first message");
    store(project, "s-prune", "m2", Date.now(), "recent second message");
    // TTL pass only deletes distilled messages.
    db()
      .query(
        "UPDATE temporal_messages SET distilled = 1 WHERE source_id = 'm1'",
      )
      .run();

    expect(
      listSessions(project).find((s) => s.session_id === "s-prune")?.title,
    ).toBe("old first message");
    expect(metaRow(project, "s-prune")?.title_source).toBe("first_message");

    const result = temporal.prune({
      projectPath: project,
      retentionDays: 5,
      maxStorageMB: 1024,
      skipSizeCap: true,
    });
    expect(result.ttlDeleted).toBe(1);

    const after = listSessions(project).find((s) => s.session_id === "s-prune");
    expect(after?.title).toBe("recent second message");
    expect(after?.title_source).toBe("first_message");
  });

  test("a prune with nothing to delete leaves session_meta in place", () => {
    const project = freshProject("prune-noop");
    store(project, "s-keep", "m1", Date.now(), "keep me");
    listSessions(project);
    expect(metaRow(project, "s-keep")).toBeTruthy();

    const result = temporal.prune({
      projectPath: project,
      retentionDays: 5,
      maxStorageMB: 1024,
      skipSizeCap: true,
    });
    expect(result).toEqual({ ttlDeleted: 0, capDeleted: 0 });
    expect(metaRow(project, "s-keep")?.title).toBe("keep me");
  });
});
