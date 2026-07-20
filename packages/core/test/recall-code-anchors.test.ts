import { beforeEach, describe, expect, test } from "vitest";
import { db, ensureProject } from "../src/db";
import * as ltm from "../src/ltm";
import { runRecall } from "../src/recall";

// Recall renders the persisted code anchors (file:line / symbol) for a knowledge
// entry so the agent can jump straight to the code instead of grepping (Modem
// "how coding agents read your code"). The id-detail path (runRecall({ id }))
// bypasses search entirely, giving a deterministic, flake-free rendering test.

const PROJECT = "/test/recall-code-anchors/project";

function seed(title: string, content: string): string {
  return ltm.create({
    projectPath: PROJECT,
    scope: "project",
    crossProject: false,
    category: "gotcha",
    title,
    content,
  });
}

function insertAnchor(
  logicalId: string,
  kind: "file" | "symbol",
  anchor: string,
): void {
  db()
    .query(
      `INSERT INTO knowledge_ref_anchor (logical_id, kind, anchor, updated_at)
         VALUES (?, ?, ?, ?)
       ON CONFLICT(logical_id, kind, anchor) DO UPDATE SET updated_at = excluded.updated_at`,
    )
    .run(logicalId, kind, anchor, Date.now());
}

describe("recall renders code anchors (id-detail path)", () => {
  beforeEach(() => {
    ensureProject(PROJECT);
    db().exec("DELETE FROM knowledge_ref_anchor");
  });

  test("a file anchor is appended after the content with a ↳ marker", async () => {
    const id = seed("Auth header dropped on retry", "the retry path re-signs");
    const lid = ltm.get(id)!.logical_id;
    insertAnchor(lid, "file", "src/auth/retry.ts:42");
    const out = await runRecall({
      query: "",
      id: `k:${id}`,
      projectPath: PROJECT,
    });
    expect(out).toContain("\u21b3 src/auth/retry.ts:42");
  });

  test("a symbol anchor renders with a trailing ()", async () => {
    const id = seed("Signer entry point", "the signer lives in one place");
    const lid = ltm.get(id)!.logical_id;
    insertAnchor(lid, "symbol", "signPayload");
    const out = await runRecall({
      query: "",
      id: `k:${id}`,
      projectPath: PROJECT,
    });
    expect(out).toContain("\u21b3 signPayload()");
  });

  test("file anchors are ordered before symbol anchors", async () => {
    const id = seed("Mixed anchors", "both a file and a symbol are cited");
    const lid = ltm.get(id)!.logical_id;
    insertAnchor(lid, "symbol", "signPayload");
    insertAnchor(lid, "file", "src/sign.ts:10");
    const out = await runRecall({
      query: "",
      id: `k:${id}`,
      projectPath: PROJECT,
    });
    expect(out).toContain("\u21b3 src/sign.ts:10, signPayload()");
  });

  test("an entry with no anchors renders no ↳ marker", async () => {
    const id = seed("No anchors here", "purely prose, nothing to jump to");
    const out = await runRecall({
      query: "",
      id: `k:${id}`,
      projectPath: PROJECT,
    });
    expect(out).not.toContain("\u21b3");
  });

  test("knowledgeRefAnchors caps a single entry at MAX_RECALL_ANCHORS_PER_ENTRY", () => {
    const id = seed("Many anchors", "lots of cited files");
    const lid = ltm.get(id)!.logical_id;
    for (let i = 1; i <= 6; i++) insertAnchor(lid, "file", `src/f${i}.ts:${i}`);
    const anchors = ltm.knowledgeRefAnchors([lid]).get(lid) ?? [];
    expect(anchors.length).toBe(ltm.MAX_RECALL_ANCHORS_PER_ENTRY);
  });

  test("knowledgeRefAnchors with empty input returns an empty map (no query)", () => {
    expect(ltm.knowledgeRefAnchors([]).size).toBe(0);
  });
});
