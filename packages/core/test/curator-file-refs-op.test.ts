import { beforeEach, describe, expect, test } from "vitest";
import { applyOps } from "../src/curator";
import { db, ensureProject } from "../src/db";
import * as ltm from "../src/ltm";

// D2c PR-2: CuratorOp{create,update}.files — optional file-association
// field on the curator's JSON ops. Recorded into knowledge_file_refs
// sidecar keyed on logical_id. Out-of-set files are accepted with a warn
// log (the curator may name a file the user mentioned without editing it).

const PROJ = "/test/d2c-pr2/curator-files";

describe("curator applyOps with `files` field (D2c PR-2)", () => {
  beforeEach(() => {
    const pid = ensureProject(PROJ);
    db().query("DELETE FROM knowledge WHERE project_id = ?").run(pid);
    db().query("DELETE FROM knowledge_file_refs").run();
  });

  test("create op with files records associations on the new entry", () => {
    const result = applyOps(
      [
        {
          op: "create",
          category: "decision",
          title: "Stripe retry uses idempotency key",
          content: "...",
          scope: "project",
          files: ["src/lib/retry.ts", "src/auth/stripe-client.ts"],
        },
      ],
      { projectPath: PROJ, sessionID: "sess-create" },
    );
    expect(result.created).toBe(1);
    const newId = result.changedEntries[0].id;
    const files = ltm.knowledgeFileRefsBatch([newId]).get(newId);
    expect(files).toEqual(["src/auth/stripe-client.ts", "src/lib/retry.ts"]);
  });

  test("create op WITHOUT files does NOT record an empty association", () => {
    const result = applyOps(
      [
        {
          op: "create",
          category: "preference",
          title: "Always write tests",
          content: "...",
          scope: "project",
        },
      ],
      { projectPath: PROJ, sessionID: "sess-create" },
    );
    const newId = result.changedEntries[0].id;
    expect(ltm.knowledgeFileRefsBatch([newId]).has(newId)).toBe(false);
  });

  test("update op with files REPLACES prior associations", () => {
    const id = ltm.create({
      projectPath: PROJ,
      category: "decision",
      title: "Tagging test",
      content: "...",
      scope: "project",
    });
    ltm.setFileRefs(id, ["old.ts"]);
    applyOps(
      [
        {
          op: "update",
          id,
          content: "updated content",
          files: ["new1.ts", "new2.ts"],
        },
      ],
      { projectPath: PROJ, sessionID: "sess-update" },
    );
    const files = ltm.knowledgeFileRefsBatch([id]).get(id);
    expect(files).toEqual(["new1.ts", "new2.ts"]);
  });

  test("update op WITHOUT files leaves prior associations alone", () => {
    const id = ltm.create({
      projectPath: PROJ,
      category: "decision",
      title: "Leave alone test",
      content: "...",
      scope: "project",
    });
    ltm.setFileRefs(id, ["preserve.ts"]);
    applyOps([{ op: "update", id, content: "content change only" }], {
      projectPath: PROJ,
      sessionID: "sess-update",
    });
    const files = ltm.knowledgeFileRefsBatch([id]).get(id);
    expect(files).toEqual(["preserve.ts"]);
  });

  test("update op with files: [] explicitly CLEARS the associations", () => {
    const id = ltm.create({
      projectPath: PROJ,
      category: "decision",
      title: "Clear test",
      content: "...",
      scope: "project",
    });
    ltm.setFileRefs(id, ["x.ts"]);
    applyOps([{ op: "update", id, content: "now conceptual", files: [] }], {
      projectPath: PROJ,
      sessionID: "sess-update",
    });
    expect(ltm.knowledgeFileRefsBatch([id]).has(id)).toBe(false);
  });

  test("out-of-set files are accepted (warned, not rejected)", () => {
    // Curator may name a file the user mentioned in chat without editing.
    // applyOps records it (after defensive normalize) and the warn is logged
    // but does not block the op.
    const result = applyOps(
      [
        {
          op: "create",
          category: "gotcha",
          title: "Out-of-set reference",
          content: "The user mentioned foo.ts but did not edit it.",
          scope: "project",
          files: ["foo.ts"], // never touched this session
        },
      ],
      { projectPath: PROJ, sessionID: "sess-create" },
    );
    expect(result.created).toBe(1);
    const newId = result.changedEntries[0].id;
    const files = ltm.knowledgeFileRefsBatch([newId]).get(newId);
    expect(files).toEqual(["foo.ts"]);
  });

  test("create op with files exceeding MAX_FILE_REFS_PER_ENTRY is defensively capped", () => {
    const manyFiles = Array.from({ length: 30 }, (_, i) => `src/file-${i}.ts`);
    const result = applyOps(
      [
        {
          op: "create",
          category: "decision",
          title: "Wide entry",
          content: "...",
          scope: "project",
          files: manyFiles,
        },
      ],
      { projectPath: PROJ, sessionID: "sess-create" },
    );
    const newId = result.changedEntries[0].id;
    // Direct DB check: writer capped at MAX_FILE_REFS_PER_ENTRY (20).
    const raw = db()
      .query("SELECT paths_json FROM knowledge_file_refs WHERE logical_id = ?")
      .get(newId) as { paths_json: string };
    const stored = JSON.parse(raw.paths_json);
    expect(stored).toHaveLength(ltm.MAX_FILE_REFS_PER_ENTRY);
    // The batch reader is capped at MAX_RECALL_FILES_PER_ENTRY (3).
    const files = ltm.knowledgeFileRefsBatch([newId]).get(newId);
    expect(files).toHaveLength(ltm.MAX_RECALL_FILES_PER_ENTRY);
  });

  test("update op with a non-array `files` field is silently ignored (defensive guard)", () => {
    // The curator's `files` field is typed as `string[]`, but a model could
    // produce a string/number by accident. The apply path's `Array.isArray`
    // guard must treat a non-array as "don't touch the sidecar" rather than
    // calling setFileRefs with a non-array (which would character-split it).
    const id = ltm.create({
      projectPath: PROJ,
      category: "decision",
      title: "Type guard test",
      content: "...",
      scope: "project",
    });
    ltm.setFileRefs(id, ["preserve.ts"]);
    applyOps(
      [
        // Intentionally bypass the type — simulate a model mistake.
        {
          op: "update",
          id,
          content: "content",
          files: "foo.ts" as unknown as string[],
        },
      ],
      { projectPath: PROJ, sessionID: "sess-update" },
    );
    // The sidecar must be UNCHANGED (Array.isArray guard prevents the
    // character-split path inside setFileRefs).
    expect(ltm.knowledgeFileRefsBatch([id]).get(id)).toEqual(["preserve.ts"]);
  });

  test("dedup-merged create op (existing entry wins) leaves prior associations unchanged", () => {
    // When tryCreate merges the new content into an existing entry via
    // dedup, the create branch continues past the files-handling block. So
    // an `op.files` on a dedup-merged create does NOT change the existing
    // entry's associations — the curator must send a separate update op.
    const id = ltm.create({
      projectPath: PROJ,
      category: "decision",
      title: "Existing tag",
      content: "existing body",
      scope: "project",
    });
    ltm.setFileRefs(id, ["existing.ts"]);
    const result = applyOps(
      [
        {
          op: "create",
          category: "decision",
          title: "Existing tag", // same title → tryCreate merges via dedup
          content: "refined body",
          scope: "project",
          files: ["new.ts"], // should NOT replace the existing sidecar
        },
      ],
      { projectPath: PROJ, sessionID: "sess-create" },
    );
    expect(result.created).toBe(0);
    expect(result.updated).toBe(1);
    expect(ltm.knowledgeFileRefsBatch([id]).get(id)).toEqual(["existing.ts"]);
  });
});
