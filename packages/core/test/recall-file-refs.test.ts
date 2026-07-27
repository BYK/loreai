import { beforeEach, describe, expect, test } from "vitest";
import { db, ensureProject } from "../src/db";
import * as ltm from "../src/ltm";
import { runRecall } from "../src/recall";

// D2c PR-2: recall renders file-path associations as a `↳ files: …` line
// alongside the anchor line in the id-detail path. Mirrors the anchor
// rendering surface, parallel cap (MAX_RECALL_FILES_PER_ENTRY=3).

const PROJECT = "/test/recall-file-refs/project";

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

describe("recall renders file-path associations (D2c PR-2, id-detail path)", () => {
  beforeEach(() => {
    ensureProject(PROJECT);
    db().exec("DELETE FROM knowledge_file_refs");
  });

  test("a single path renders as `↳ files: path/to/file`", async () => {
    const id = seed("Tagged entry", "entry content");
    const lid = ltm.get(id)!.logical_id;
    ltm.setFileRefs(lid, ["src/auth/retry.ts"]);
    const out = await runRecall({
      query: "",
      id: `k:${id}`,
      projectPath: PROJECT,
    });
    expect(out).toContain("\u21b3 files: src/auth/retry.ts");
  });

  test("multiple paths render comma-separated, sorted", async () => {
    const id = seed("Tagged entry", "entry content");
    const lid = ltm.get(id)!.logical_id;
    ltm.setFileRefs(lid, ["src/lib/retry.ts", "src/auth/stripe-client.ts"]);
    const out = await runRecall({
      query: "",
      id: `k:${id}`,
      projectPath: PROJECT,
    });
    expect(out).toContain(
      "\u21b3 files: src/auth/stripe-client.ts, src/lib/retry.ts",
    );
  });

  test("recall caps at MAX_RECALL_FILES_PER_ENTRY (3) for rendering", async () => {
    const id = seed("Wide tagged entry", "entry content");
    const lid = ltm.get(id)!.logical_id;
    // Write 5 — recall should render 3 (alphabetical first 3).
    ltm.setFileRefs(lid, [
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
      "src/d.ts",
      "src/e.ts",
    ]);
    const out = await runRecall({
      query: "",
      id: `k:${id}`,
      projectPath: PROJECT,
    });
    expect(out).toContain("\u21b3 files: src/a.ts, src/b.ts, src/c.ts");
    expect(out).not.toContain("src/d.ts");
    expect(out).not.toContain("src/e.ts");
  });

  test("entries with no file refs render WITHOUT a `↳ files:` line", async () => {
    const id = seed("Untagged entry", "entry content");
    const out = await runRecall({
      query: "",
      id: `k:${id}`,
      projectPath: PROJECT,
    });
    expect(out).not.toContain("\u21b3 files:");
  });

  test("renderFileRefs is order-deterministic across same set", async () => {
    const id = seed("Determinism test", "entry content");
    const lid = ltm.get(id)!.logical_id;
    ltm.setFileRefs(lid, ["x.ts", "y.ts", "z.ts"]);
    const out1 = await runRecall({
      query: "",
      id: `k:${id}`,
      projectPath: PROJECT,
    });
    const out2 = await runRecall({
      query: "",
      id: `k:${id}`,
      projectPath: PROJECT,
    });
    // Same input → same output bytes (cache-friendly).
    expect(out1).toBe(out2);
  });
});

describe("recall renders file-path associations (D2c PR-2, cross-knowledge branch)", () => {
  const ORIGIN = "/test/recall-file-refs/origin";
  const FOREIGN = "/test/recall-file-refs/foreign";

  beforeEach(() => {
    ensureProject(ORIGIN);
    ensureProject(FOREIGN);
    db().exec("DELETE FROM knowledge_file_refs");
  });

  test("a cross-knowledge (project-scoped, recalled from another project) entry surfaces its file refs", async () => {
    // To trigger the cross-knowledge RENDERING branch (recall.ts:629), the
    // entry must be project-scoped (crossProject=false) in ORIGIN so that
    // searchScoredOtherProjects (ltm.ts:3561) picks it up when searching
    // from FOREIGN. crossProject=true entries surface in the regular search
    // and tag as "knowledge", not "cross-knowledge" — that's a separate code
    // path with identical renderFiles wiring but different label.
    const id = ltm.create({
      projectPath: ORIGIN,
      scope: "project",
      crossProject: false,
      category: "decision",
      title: "Use Stripe idempotency keys",
      content: "All charge creation must include Idempotency-Key header.",
    });
    const lid = ltm.get(id)!.logical_id;
    ltm.setFileRefs(lid, ["src/auth/stripe-client.ts", "src/lib/retry.ts"]);
    // Recall from FOREIGN with a matching query — must surface as
    // cross-knowledge (project_id = ORIGIN != FOREIGN). The
    // renderResultLine cross-knowledge branch (recall.ts:629) is exercised.
    const out = await runRecall({
      query: "Stripe idempotency",
      projectPath: FOREIGN,
    });
    expect(out).toContain(
      "\u21b3 files: src/auth/stripe-client.ts, src/lib/retry.ts",
    );
    // The cross-knowledge branch adds a `from: <label>` marker.
    expect(out).toMatch(/from: /);
  });
});
