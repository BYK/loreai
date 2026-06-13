/**
 * Tests for suggest.ts — the tiered project-suggestion engine behind
 * `lore data split`. Covers each signal tier and the dominance / noise rules.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  db,
  ensureProject,
  projectId,
  enableHostedMode,
  _resetHostedModeForTest,
} from "@loreai/core";
import { suggestProjectForSession } from "../src/suggest";

const MAGNET = "/test/suggest/magnet";

function insertMsg(
  projectId: string,
  sessionId: string,
  content: string,
): void {
  db()
    .query(
      `INSERT INTO temporal_messages (id, project_id, session_id, role, content, tokens, distilled, created_at, metadata)
       VALUES (?, ?, ?, 'user', ?, 5, 0, ?, '{}')`,
    )
    .run(`m-${crypto.randomUUID()}`, projectId, sessionId, content, Date.now());
}

function setConfidentState(sessionId: string, projectPath: string): void {
  db()
    .query(
      `INSERT INTO session_state (session_id, force_min_layer, updated_at, project_path, project_path_provisional)
       VALUES (?, 0, ?, ?, 0)
       ON CONFLICT(session_id) DO UPDATE SET project_path = excluded.project_path, project_path_provisional = 0`,
    )
    .run(sessionId, Date.now(), projectPath);
}

describe("suggestProjectForSession", () => {
  let magnetId: string;

  beforeEach(() => {
    db().query("DELETE FROM temporal_messages").run();
    db().query("DELETE FROM session_state").run();
    magnetId = ensureProject(MAGNET);
  });

  afterEach(() => {
    _resetHostedModeForTest();
  });

  test("Tier A: uses confident session_state.project_path", () => {
    const real = "/test/suggest/real-a";
    ensureProject(real);
    const sid = `tierA-${crypto.randomUUID()}`;
    setConfidentState(sid, real);
    // Content is irrelevant when a confident session_state exists.
    insertMsg(magnetId, sid, "no useful paths here");

    const s = suggestProjectForSession(sid, magnetId, MAGNET);
    expect(s.tier).toBe("session_state");
    expect(s.confidence).toBe("high");
    expect(s.suggestedProjectId).toBe(projectId(real));
  });

  test("Tier P: dominant authoritative path in content → high", () => {
    const real = "/test/suggest/real-p";
    ensureProject(real);
    const sid = `tierP-${crypto.randomUUID()}`;
    insertMsg(magnetId, sid, `Working directory: ${real}`);
    insertMsg(magnetId, sid, `again at ${real}/src/index.ts`);

    const s = suggestProjectForSession(sid, magnetId, MAGNET);
    expect(s.tier).toBe("path");
    expect(s.confidence).toBe("high");
    expect(s.suggestedProjectId).toBe(projectId(real));
  });

  test("Tier P: split across projects with no dominant path → no suggestion", () => {
    const a = "/test/suggest/split-a";
    const b = "/test/suggest/split-b";
    ensureProject(a);
    ensureProject(b);
    const sid = `tierPsplit-${crypto.randomUUID()}`;
    // Equal mentions, no dominance (1 vs 1).
    insertMsg(magnetId, sid, `Working directory: ${a}`);
    insertMsg(magnetId, sid, `Working directory: ${b}`);

    const s = suggestProjectForSession(sid, magnetId, MAGNET);
    expect(s.suggestedProjectId).toBeNull();
  });

  test("Tier B: repeated git-remote-shaped slug refs in content → high", () => {
    // A supplied git remote is only trusted (persisted) in hosted mode — which
    // is exactly the central-gateway scenario where the magnet collapse occurs.
    enableHostedMode();
    const real = "/test/suggest/real-b";
    ensureProject(real, undefined, "github.com/onur/widget");
    const sid = `tierB-${crypto.randomUUID()}`;
    // No path signal — only repo-shaped remote references (≥2 → high).
    insertMsg(magnetId, sid, "cloned from github.com/onur/widget earlier");
    insertMsg(magnetId, sid, "remote git@github.com:onur/widget.git");

    const s = suggestProjectForSession(sid, magnetId, MAGNET);
    expect(s.tier).toBe("git_remote");
    expect(s.confidence).toBe("high");
    expect(s.suggestedProjectId).toBe(projectId(real));
    _resetHostedModeForTest();
  });

  test("Tier B: a single in-passing slug mention is only low confidence (S3)", () => {
    enableHostedMode();
    const real = "/test/suggest/real-b2";
    ensureProject(real, undefined, "github.com/onur/gadget");
    const sid = `tierBlow-${crypto.randomUUID()}`;
    insertMsg(magnetId, sid, "for reference see github.com/onur/gadget readme");

    const s = suggestProjectForSession(sid, magnetId, MAGNET);
    expect(s.tier).toBe("git_remote");
    expect(s.confidence).toBe("low");
    _resetHostedModeForTest();
  });

  test("Tier B: a bare owner/repo mention (no host) does NOT attribute (S2/S3)", () => {
    enableHostedMode();
    const real = "/test/suggest/real-b3";
    ensureProject(real, undefined, "github.com/onur/sprocket");
    const sid = `tierBbare-${crypto.randomUUID()}`;
    // Bare slug in prose, and a longer slug it must not substring-match into.
    insertMsg(
      magnetId,
      sid,
      "the onur/sprocket-helper package and onur/sprocket",
    );

    const s = suggestProjectForSession(sid, magnetId, MAGNET);
    expect(s.suggestedProjectId).toBeNull();
    _resetHostedModeForTest();
  });

  test("no usable signal → null suggestion", () => {
    const sid = `none-${crypto.randomUUID()}`;
    insertMsg(magnetId, sid, "just some prose with no project markers");
    const s = suggestProjectForSession(sid, magnetId, MAGNET);
    expect(s.suggestedProjectId).toBeNull();
    expect(s.confidence).toBeNull();
    expect(s.tier).toBeNull();
  });

  test("never suggests the source (magnet) project itself", () => {
    const sid = `selfref-${crypto.randomUUID()}`;
    insertMsg(magnetId, sid, `Working directory: ${MAGNET}`);
    const s = suggestProjectForSession(sid, magnetId, MAGNET);
    expect(s.suggestedProjectId).toBeNull();
  });
});
