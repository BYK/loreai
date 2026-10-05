/**
 * Reviewed dedup apply (MEM-02, #1804): revision checks, per-group atomicity,
 * idempotent receipts, provenance, recoverability and a single export per
 * operation. State is set up in adversarial order (edits land BETWEEN the
 * preview snapshot and the apply) per quality/REVIEW.md.
 */
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uuidv7 } from "uuidv7";

vi.mock("../src/agents-file", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/agents-file")>();
  return { ...mod, exportLoreFile: vi.fn(mod.exportLoreFile) };
});

import * as agentsFile from "../src/agents-file";
import {
  close,
  db,
  ensureProject,
  MIGRATIONS,
  PROJECT_MERGE_TABLES,
  withTransaction,
} from "../src/db";
import * as data from "../src/data";
import * as ltm from "../src/ltm";
import { currentTenantId } from "../src/tenant";
import {
  applyDedupDecisions,
  currentRevisions,
  DedupApplyError,
  dedupApplyPayloadHash,
  dedupProvenanceFor,
  parseDedupApplyRequest,
  type DedupApplyRequest,
  type DedupDecision,
} from "../src/dedup-apply";

const exportLoreFile = vi.mocked(agentsFile.exportLoreFile);

const ROOT = mkdtempSync(join(tmpdir(), "lore-dedup-apply-"));
const PROJECT = join(ROOT, "project-a");
const PROJECT_B = join(ROOT, "project-b");
mkdirSync(PROJECT);
mkdirSync(PROJECT_B);
let projectId: string;

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function createEntry(title: string, projectPath = PROJECT): string {
  return ltm.create({
    id: uuidv7(), // explicit id bypasses the create-time title dedup guard
    projectPath,
    category: "gotcha",
    title,
    content: `Content for ${title}`,
    scope: "project",
    session: "test-session",
  });
}

function createGlobalEntry(title: string): string {
  return ltm.create({
    id: uuidv7(),
    category: "gotcha",
    title,
    content: `Global content for ${title}`,
    scope: "global",
    crossProject: true,
    session: "test-session",
  });
}

function revisionOf(id: string): number {
  const row = db()
    .query(
      "SELECT version FROM knowledge WHERE logical_id = ? AND is_current = 1",
    )
    .get(ltm.logicalIdOf(id)) as { version: number } | null;
  if (!row) throw new Error(`no current version for ${id}`);
  return row.version;
}

/** Snapshot the revisions a reviewer would have seen in the preview. */
function decision(keepId: string, ...mergeIds: string[]): DedupDecision {
  const expectedRevisions: Record<string, number> = {};
  for (const id of [keepId, ...mergeIds])
    expectedRevisions[id] = revisionOf(id);
  return { keepId, mergeIds, expectedRevisions };
}

let counter = 0;
function request(
  decisions: DedupDecision[],
  overrides: Partial<DedupApplyRequest> = {},
): DedupApplyRequest {
  counter++;
  return {
    projectId,
    operationId: `op-${Date.now()}-${counter}`,
    reviewedAt: Date.now() - 1_000,
    actor: "reviewer@test",
    decisions,
    ...overrides,
  };
}

function apply(req: DedupApplyRequest) {
  return applyDedupDecisions(db(), req);
}

function isLive(id: string): boolean {
  return ltm.getByLogical(ltm.logicalIdOf(id)) !== null;
}

beforeEach(() => {
  projectId = ensureProject(PROJECT, "dedup-apply-a");
  ensureProject(PROJECT_B, "dedup-apply-b");
  db().exec("DELETE FROM dedup_provenance");
  db().exec("DELETE FROM dedup_operations");
  db().exec("DELETE FROM knowledge");
  exportLoreFile.mockClear();
});

describe("schema", () => {
  test("migration 88 creates the ledger and normalizes the version", () => {
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(88);
    const tables = (
      db()
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('dedup_operations', 'dedup_provenance')",
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(tables.sort()).toEqual(["dedup_operations", "dedup_provenance"]);
    expect(PROJECT_MERGE_TABLES).toContain("dedup_operations");
  });

  test("a v87 database gains the ledger on reopen and keeps knowledge intact", () => {
    const keep = createEntry("Migrate Keep");
    const dupe = createEntry("Migrate Dupe");
    db().exec(
      "DROP TABLE dedup_provenance; DROP TABLE dedup_operations; UPDATE schema_version SET version = 87",
    );
    close();
    expect(db().query("SELECT version FROM schema_version").get()).toEqual({
      version: MIGRATIONS.length,
    });
    expect(isLive(keep)).toBe(true);
    const receipt = apply(request([decision(keep, dupe)]));
    expect(receipt.applied).toHaveLength(1);
    expect(dedupProvenanceFor(receipt.operationId)).toHaveLength(1);
  });

  test("operations follow a project merge", () => {
    const sourcePath = join(ROOT, "merge-source");
    const sourceId = ensureProject(sourcePath, "merge-source");
    const targetId = ensureProject(join(ROOT, "merge-target"), "merge-target");
    const keep = createEntry("Merge Keep", sourcePath);
    const dupe = createEntry("Merge Dupe", sourcePath);
    const req = request([decision(keep, dupe)], { projectId: sourceId });
    apply(req);
    data.mergeProjects(sourceId, targetId);
    const row = db()
      .query("SELECT project_id FROM dedup_operations WHERE operation_id = ?")
      .get(req.operationId) as { project_id: string };
    expect(row.project_id).toBe(targetId);
    expect(dedupProvenanceFor(req.operationId)).toHaveLength(1);
  });
});

describe("happy path", () => {
  test("merges every group, keeps survivors, writes provenance and one receipt", () => {
    const keepA = createEntry("Keep A");
    const dupeA1 = createEntry("Keep A (dupe 1)");
    const dupeA2 = createEntry("Keep A (dupe 2)");
    const keepB = createEntry("Keep B");
    const dupeB = createEntry("Keep B (dupe)");
    const req = request([
      decision(keepA, dupeA1, dupeA2),
      decision(keepB, dupeB),
    ]);

    const receipt = apply(req);

    expect(receipt.operationId).toBe(req.operationId);
    expect(receipt.projectId).toBe(projectId);
    expect(receipt.replayed).toBe(false);
    expect(receipt.refused).toEqual([]);
    expect(receipt.applied.map((g) => g.groupIndex)).toEqual([0, 1]);
    expect(receipt.applied[0].keepId).toBe(keepA);
    expect(receipt.applied[0].keepRevision).toBe(1);
    expect(receipt.applied[0].merged.map((m) => m.id)).toEqual([
      dupeA1,
      dupeA2,
    ]);
    expect(receipt.startedAt).toBeLessThanOrEqual(receipt.finishedAt);

    expect(isLive(keepA)).toBe(true);
    expect(isLive(keepB)).toBe(true);
    for (const id of [dupeA1, dupeA2, dupeB]) expect(isLive(id)).toBe(false);
    // The survivor is untouched: no new version was appended to it.
    expect(revisionOf(keepA)).toBe(1);

    const provenance = dedupProvenanceFor(req.operationId);
    expect(provenance.map((p) => p.merged_logical_id)).toEqual([
      dupeA1,
      dupeA2,
      dupeB,
    ]);
    expect(provenance[0]).toMatchObject({
      group_index: 0,
      keep_logical_id: keepA,
      expected_revision: 1,
      actual_revision: 1,
      keep_expected_revision: 1,
      keep_actual_revision: 1,
      actor: "reviewer@test",
      reviewed_at: req.reviewedAt,
      merged_version_id: receipt.applied[0].merged[0].tombstoneVersionId,
    });
    expect(provenance[2].group_index).toBe(1);

    const stored = db()
      .query(
        "SELECT payload_hash, receipt, finished_at FROM dedup_operations WHERE operation_id = ?",
      )
      .get(req.operationId) as {
      payload_hash: string;
      receipt: string;
      finished_at: number;
    };
    expect(stored.payload_hash).toBe(dedupApplyPayloadHash(req));
    expect(JSON.parse(stored.receipt).applied).toHaveLength(2);
    expect(stored.finished_at).toBe(receipt.finishedAt);
  });

  test("accepts current version ids as well as logical ids", () => {
    const keep = createEntry("Versioned Keep");
    const dupe = createEntry("Versioned Dupe");
    ltm.update(keep, { content: "edited before the preview" });
    const currentId = ltm.getByLogical(keep)?.id ?? "";
    expect(currentId).not.toBe(keep);
    const req = request([decision(currentId, dupe)]);
    expect(req.decisions[0].expectedRevisions[currentId]).toBe(2);

    const receipt = apply(req);

    expect(receipt.refused).toEqual([]);
    expect(receipt.applied[0].keepRevision).toBe(2);
    expect(dedupProvenanceFor(req.operationId)[0].keep_logical_id).toBe(keep);
  });

  test("global scope merges project_id IS NULL entries", () => {
    const keep = createGlobalEntry("Global Keep");
    const dupe = createGlobalEntry("Global Dupe");
    const receipt = apply(request([decision(keep, dupe)], { projectId: null }));
    expect(receipt.refused).toEqual([]);
    expect(isLive(dupe)).toBe(false);
    expect(exportLoreFile).not.toHaveBeenCalled();
  });
});

describe("stale revisions", () => {
  test("an edit between preview and apply refuses the group and writes nothing", () => {
    const keep = createEntry("Stale Keep");
    const dupe = createEntry("Stale Dupe");
    const other = createEntry("Stale Other");
    const preview = decision(keep, dupe, other);
    // Adversarial order: the reviewer is looking at revision 1 while another
    // writer lands an edit on one of the merge candidates.
    ltm.update(dupe, { content: "edited after the preview" });
    const req = request([preview]);

    const receipt = apply(req);

    expect(receipt.applied).toEqual([]);
    expect(receipt.refused).toHaveLength(1);
    expect(receipt.refused[0]).toMatchObject({
      groupIndex: 0,
      keepId: keep,
      mergeIds: [dupe, other],
      error: {
        code: "stale_revision",
        details: [
          {
            id: dupe,
            reason: "stale_revision",
            expectedRevision: 1,
            actualRevision: 2,
          },
        ],
      },
    });
    // No partial writes: the still-fresh candidate survived too.
    expect(isLive(dupe)).toBe(true);
    expect(isLive(other)).toBe(true);
    expect(ltm.versionHistory(other)).toHaveLength(1);
    expect(dedupProvenanceFor(req.operationId)).toEqual([]);
    expect(exportLoreFile).not.toHaveBeenCalled();
  });

  test("an edit to the survivor is stale too", () => {
    const keep = createEntry("Stale Survivor");
    const dupe = createEntry("Stale Survivor Dupe");
    const preview = decision(keep, dupe);
    ltm.update(keep, { content: "survivor edited" });

    const receipt = apply(request([preview]));

    expect(receipt.refused[0].error.code).toBe("stale_revision");
    expect(receipt.refused[0].error.details[0].id).toBe(keep);
    expect(isLive(dupe)).toBe(true);
  });

  test("a candidate deleted after the preview is not_found", () => {
    const keep = createEntry("Gone Keep");
    const dupe = createEntry("Gone Dupe");
    const preview = decision(keep, dupe);
    ltm.remove(dupe);

    const receipt = apply(request([preview]));

    expect(receipt.refused[0].error.code).toBe("not_found");
    expect(receipt.refused[0].error.details).toEqual([
      { id: dupe, reason: "not_found", expectedRevision: 1 },
    ]);
  });
});

describe("per-group atomicity", () => {
  test("group 1 stays committed when group 2 is refused, and the receipt says so", () => {
    const keepA = createEntry("Atomic Keep A");
    const dupeA = createEntry("Atomic Dupe A");
    const keepB = createEntry("Atomic Keep B");
    const dupeB1 = createEntry("Atomic Dupe B1");
    const dupeB2 = createEntry("Atomic Dupe B2");
    const groupA = decision(keepA, dupeA);
    const groupB = decision(keepB, dupeB1, dupeB2);
    ltm.update(dupeB2, { content: "edited after the preview" });
    const req = request([groupA, groupB]);

    const receipt = apply(req);

    expect(receipt.applied.map((g) => g.groupIndex)).toEqual([0]);
    expect(receipt.refused.map((g) => g.groupIndex)).toEqual([1]);
    expect(receipt.refused[0].error.code).toBe("stale_revision");
    expect(isLive(dupeA)).toBe(false);
    expect(isLive(dupeB1)).toBe(true);
    expect(isLive(dupeB2)).toBe(true);
    expect(
      dedupProvenanceFor(req.operationId).map((p) => p.merged_logical_id),
    ).toEqual([dupeA]);
    // A partially applied operation still exports exactly once.
    expect(exportLoreFile).toHaveBeenCalledTimes(1);
  });

  test("refuses to run inside a caller's transaction, claiming and writing nothing", () => {
    const keep = createEntry("Txn Keep");
    const dupe = createEntry("Txn Dupe");
    const req = request([decision(keep, dupe)]);

    expect(() => withTransaction(() => apply(req))).toThrow(
      expect.objectContaining({
        code: "invalid_request",
        message: expect.stringContaining("inside a transaction"),
      }),
    );

    expect(isLive(dupe)).toBe(true);
    expect(
      db().query("SELECT COUNT(*) AS n FROM dedup_operations").get() as {
        n: number;
      },
    ).toEqual({ n: 0 });
    expect(exportLoreFile).not.toHaveBeenCalled();
    // The same request is accepted at the top level.
    expect(apply(req).applied).toHaveLength(1);
  });

  test("the same id in two groups refuses both groups but not a third", () => {
    const keepA = createEntry("Overlap Keep A");
    const keepB = createEntry("Overlap Keep B");
    const shared = createEntry("Overlap Shared");
    const keepC = createEntry("Overlap Keep C");
    const dupeC = createEntry("Overlap Dupe C");
    const req = request([
      decision(keepA, shared),
      decision(keepB, shared),
      decision(keepC, dupeC),
    ]);

    const receipt = apply(req);

    expect(receipt.refused.map((g) => g.groupIndex)).toEqual([0, 1]);
    for (const refused of receipt.refused) {
      expect(refused.error.code).toBe("conflicting_groups");
      expect(refused.error.details).toEqual([
        { id: shared, reason: "conflicting_groups" },
      ]);
    }
    expect(receipt.applied.map((g) => g.groupIndex)).toEqual([2]);
    expect(isLive(shared)).toBe(true);
    expect(isLive(dupeC)).toBe(false);
  });

  test("overlap is detected across logical and version ids of the same entry", () => {
    const keepA = createEntry("Alias Keep A");
    const keepB = createEntry("Alias Keep B");
    const shared = createEntry("Alias Shared");
    ltm.update(shared, { content: "now has a second version id" });
    const versionId = ltm.getByLogical(shared)?.id ?? "";
    const req = request([decision(keepA, shared), decision(keepB, versionId)]);

    const receipt = apply(req);

    expect(receipt.refused.map((g) => g.error.code)).toEqual([
      "conflicting_groups",
      "conflicting_groups",
    ]);
    expect(isLive(shared)).toBe(true);
  });

  test("a group whose keepId and mergeId alias the same entry is refused, never self-merged", () => {
    const keep = createEntry("Self Alias Keep");
    const dupe = createEntry("Self Alias Dupe");
    ltm.update(keep, { content: "second version" });
    const keepVersionId = ltm.getByLogical(keep)?.id ?? "";
    expect(keepVersionId).not.toBe(keep);
    const other = createEntry("Self Alias Other");
    const otherDupe = createEntry("Self Alias Other Dupe");

    // keepId is the version id, mergeIds contains its logical id: the same
    // entry twice, which parse-time string checks cannot see.
    const receipt = apply(
      request([
        {
          keepId: keepVersionId,
          mergeIds: [keep, dupe],
          expectedRevisions: {
            [keepVersionId]: 2,
            [keep]: 2,
            [dupe]: 1,
          },
        },
        decision(other, otherDupe),
      ]),
    );

    expect(receipt.refused).toHaveLength(1);
    expect(receipt.refused[0].groupIndex).toBe(0);
    expect(receipt.refused[0].error.code).toBe("conflicting_groups");
    expect(receipt.refused[0].error.details).toEqual([
      { id: keepVersionId, reason: "conflicting_groups" },
      { id: keep, reason: "conflicting_groups" },
    ]);
    expect(isLive(keep)).toBe(true);
    expect(isLive(dupe)).toBe(true);
    expect(receipt.applied.map((g) => g.keepId)).toEqual([other]);
    expect(isLive(otherDupe)).toBe(false);
  });

  test("a survivor merged away by an earlier group makes the later group not_found", () => {
    const keepA = createEntry("Chain Keep A");
    const middle = createEntry("Chain Middle");
    const dupe = createEntry("Chain Dupe");
    // middle is merged INTO keepA, then a later group wants to keep middle.
    // These overlap, so both are refused up front rather than chained.
    const receipt = apply(
      request([decision(keepA, middle), decision(middle, dupe)]),
    );
    expect(receipt.refused).toHaveLength(2);
    expect(isLive(middle)).toBe(true);
  });
});

describe("idempotency", () => {
  test("re-submitting the same operation replays the stored receipt without re-applying", () => {
    const keep = createEntry("Idem Keep");
    const dupe = createEntry("Idem Dupe");
    const req = request([decision(keep, dupe)]);

    const first = apply(req);
    const historyAfterFirst = ltm.versionHistory(dupe).length;
    const second = apply({ ...req, decisions: [...req.decisions] });

    expect(second.replayed).toBe(true);
    expect({ ...second, replayed: false }).toEqual(first);
    expect(ltm.versionHistory(dupe)).toHaveLength(historyAfterFirst);
    expect(dedupProvenanceFor(req.operationId)).toHaveLength(1);
    expect(exportLoreFile).toHaveBeenCalledTimes(1);
  });

  test("equivalent payloads with reordered groups and ids share a receipt", () => {
    const keepA = createEntry("Order Keep A");
    const dupeA1 = createEntry("Order Dupe A1");
    const dupeA2 = createEntry("Order Dupe A2");
    const keepB = createEntry("Order Keep B");
    const dupeB = createEntry("Order Dupe B");
    const req = request([
      decision(keepA, dupeA1, dupeA2),
      decision(keepB, dupeB),
    ]);
    const reordered: DedupApplyRequest = {
      ...req,
      decisions: [decision(keepB, dupeB), decision(keepA, dupeA2, dupeA1)],
    };
    expect(dedupApplyPayloadHash(reordered)).toBe(dedupApplyPayloadHash(req));

    const first = apply(req);
    const second = apply(reordered);
    expect(second.replayed).toBe(true);
    expect(second.applied).toEqual(first.applied);
  });

  test("a stale refusal is replayed as-is even once the entry is fresh again", () => {
    const keep = createEntry("Replay Keep");
    const dupe = createEntry("Replay Dupe");
    const preview = decision(keep, dupe);
    ltm.update(dupe, { content: "edited" });
    const req = request([preview]);
    const first = apply(req);
    expect(first.refused[0].error.code).toBe("stale_revision");

    const second = apply(req);
    expect(second.replayed).toBe(true);
    expect(second.refused).toEqual(first.refused);
    expect(isLive(dupe)).toBe(true);
  });

  test("a different payload under the same operation id is operation_conflict", () => {
    const keep = createEntry("Conflict Keep");
    const dupe = createEntry("Conflict Dupe");
    const extra = createEntry("Conflict Extra");
    const req = request([decision(keep, dupe)]);
    apply(req);

    const attempt = () => apply({ ...req, decisions: [decision(keep, extra)] });
    expect(attempt).toThrow(DedupApplyError);
    try {
      attempt();
    } catch (e) {
      expect((e as DedupApplyError).code).toBe("operation_conflict");
    }
    expect(isLive(extra)).toBe(true);
    expect(dedupProvenanceFor(req.operationId)).toHaveLength(1);
  });

  test("a different actor under the same operation id is operation_conflict", () => {
    const keep = createEntry("Actor Keep");
    const dupe = createEntry("Actor Dupe");
    const req = request([decision(keep, dupe)]);
    apply(req);
    expect(() => apply({ ...req, actor: "someone-else" })).toThrow(
      /different payload/,
    );
  });

  test("an interrupted operation cannot be resumed under the same id", () => {
    const keep = createEntry("Interrupted Keep");
    const dupe = createEntry("Interrupted Dupe");
    const req = request([decision(keep, dupe)]);
    db()
      .query(
        `INSERT INTO dedup_operations (tenant_id, operation_id, project_id, actor, reviewed_at, payload_hash, receipt, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL)`,
      )
      .run(
        currentTenantId(),
        req.operationId,
        projectId,
        req.actor,
        req.reviewedAt,
        dedupApplyPayloadHash(req),
        Date.now(),
      );

    expect(() => apply(req)).toThrow(/never finished/);
    expect(isLive(dupe)).toBe(true);
  });
});

describe("currentRevisions", () => {
  test("reports the revision apply will check, for logical and version ids", () => {
    const keep = createEntry("Rev Keep");
    const edited = createEntry("Rev Edited");
    const gone = createEntry("Rev Gone");
    ltm.update(edited, { content: "second version" });
    const editedV2 = ltm.getByLogical(edited)?.id ?? "";
    ltm.remove(gone);

    const revs = currentRevisions([keep, edited, editedV2, gone, "nope", keep]);

    expect(revs.get(keep)).toBe(1);
    expect(revs.get(edited)).toBe(2);
    expect(revs.get(editedV2)).toBe(2);
    expect(revs.has(gone)).toBe(false);
    expect(revs.has("nope")).toBe(false);
    expect(revs.size).toBe(3);

    // A decision built from these revisions is exactly what apply accepts.
    const receipt = apply(
      request([
        {
          keepId: keep,
          mergeIds: [editedV2],
          expectedRevisions: {
            [keep]: revs.get(keep) ?? -1,
            [editedV2]: revs.get(editedV2) ?? -1,
          },
        },
      ]),
    );
    expect(receipt.refused).toEqual([]);
    expect(receipt.applied[0].merged[0].revision).toBe(2);
  });
});

describe("scope", () => {
  test("an entry from another project is scope_mismatch and nothing is written", () => {
    const keep = createEntry("Scope Keep");
    const dupe = createEntry("Scope Dupe");
    const foreign = createEntry("Scope Foreign", PROJECT_B);
    const receipt = apply(request([decision(keep, dupe, foreign)]));

    expect(receipt.refused[0].error.code).toBe("scope_mismatch");
    expect(receipt.refused[0].error.details).toEqual([
      { id: foreign, reason: "scope_mismatch", expectedRevision: 1 },
    ]);
    expect(isLive(dupe)).toBe(true);
    expect(isLive(foreign)).toBe(true);
  });

  test("a global entry cannot be merged under a project scope", () => {
    const keep = createEntry("Scope Project Keep");
    const global = createGlobalEntry("Scope Global");
    const receipt = apply(request([decision(keep, global)]));
    expect(receipt.refused[0].error.code).toBe("scope_mismatch");
    expect(isLive(global)).toBe(true);
  });

  test("an unknown project is not_found before anything is claimed", () => {
    const keep = createEntry("Missing Project Keep");
    const dupe = createEntry("Missing Project Dupe");
    const req = request([decision(keep, dupe)], {
      projectId: "no-such-project",
    });
    expect(() => apply(req)).toThrow(DedupApplyError);
    expect(
      db()
        .query(
          "SELECT COUNT(*) AS n FROM dedup_operations WHERE operation_id = ?",
        )
        .get(req.operationId),
    ).toEqual({ n: 0 });
    expect(isLive(dupe)).toBe(true);
  });
});

describe("validation", () => {
  const base = () => ({
    projectId: "p",
    operationId: "op-1",
    reviewedAt: 1,
    actor: "a",
    decisions: [
      { keepId: "k", mergeIds: ["m"], expectedRevisions: { k: 1, m: 1 } },
    ],
  });

  test.each<[string, (r: ReturnType<typeof base>) => unknown]>([
    ["non-object body", () => "nope"],
    ["missing operationId", (r) => ({ ...r, operationId: undefined })],
    ["operationId with spaces", (r) => ({ ...r, operationId: "op 1" })],
    ["numeric projectId", (r) => ({ ...r, projectId: 5 })],
    ["negative reviewedAt", (r) => ({ ...r, reviewedAt: -1 })],
    ["string reviewedAt", (r) => ({ ...r, reviewedAt: "2026-01-01" })],
    ["blank actor", (r) => ({ ...r, actor: "  " })],
    ["empty decisions", (r) => ({ ...r, decisions: [] })],
    [
      "empty mergeIds",
      (r) => ({ ...r, decisions: [{ ...r.decisions[0], mergeIds: [] }] }),
    ],
    [
      "keepId inside mergeIds",
      (r) => ({ ...r, decisions: [{ ...r.decisions[0], mergeIds: ["k"] }] }),
    ],
    [
      "duplicate mergeIds",
      (r) => ({
        ...r,
        decisions: [
          {
            keepId: "k",
            mergeIds: ["m", "m"],
            expectedRevisions: { k: 1, m: 1 },
          },
        ],
      }),
    ],
    [
      "missing expected revision for a merge id",
      (r) => ({
        ...r,
        decisions: [{ ...r.decisions[0], expectedRevisions: { k: 1 } }],
      }),
    ],
    [
      "non-integer revision",
      (r) => ({
        ...r,
        decisions: [{ ...r.decisions[0], expectedRevisions: { k: 1, m: 1.5 } }],
      }),
    ],
    [
      "zero revision",
      (r) => ({
        ...r,
        decisions: [{ ...r.decisions[0], expectedRevisions: { k: 0, m: 1 } }],
      }),
    ],
  ])("rejects %s as invalid_request", (_label, mutate) => {
    try {
      parseDedupApplyRequest(mutate(base()));
      throw new Error("expected invalid_request");
    } catch (e) {
      expect(e).toBeInstanceOf(DedupApplyError);
      expect((e as DedupApplyError).code).toBe("invalid_request");
    }
  });

  test("ignores expected revisions for ids that are not referenced", () => {
    const parsed = parseDedupApplyRequest({
      ...base(),
      decisions: [
        {
          keepId: "k",
          mergeIds: ["m"],
          expectedRevisions: { k: 1, m: 2, x: 9 },
        },
      ],
    });
    expect(parsed.decisions[0].expectedRevisions).toEqual({ k: 1, m: 2 });
  });

  test("an invalid request never claims the operation id", () => {
    const keep = createEntry("Invalid Keep");
    const req = request([
      { keepId: keep, mergeIds: [], expectedRevisions: {} },
    ]);
    expect(() => apply(req)).toThrow(DedupApplyError);
    expect(
      db()
        .query(
          "SELECT COUNT(*) AS n FROM dedup_operations WHERE operation_id = ?",
        )
        .get(req.operationId),
    ).toEqual({ n: 0 });
  });
});

describe("recoverability and downstream effects", () => {
  test("a merged entry keeps its history and can be restored from it", () => {
    const keep = createEntry("Restore Keep");
    const dupe = createEntry("Restore Dupe");
    ltm.update(dupe, { content: "second version" });
    const receipt = apply(request([decision(keep, dupe)]));
    expect(receipt.refused).toEqual([]);

    const history = ltm.versionHistory(dupe);
    expect(history.map((v) => [v.version, v.is_deleted, v.is_current])).toEqual(
      [
        [1, 0, 0],
        [2, 0, 0],
        [3, 1, 1],
      ],
    );
    expect(history[2].id).toBe(receipt.applied[0].merged[0].tombstoneVersionId);
    expect(history[2].content).toBe("second version");

    // Restore the last live version through the ordinary versioning primitive.
    const last = history[1];
    const restoredId = ltm.appendVersion(dupe, {
      title: last.title,
      content: last.content,
      category: last.category,
      isDeleted: false,
    });
    expect(restoredId).not.toBeNull();
    const restored = ltm.getByLogical(dupe);
    expect(restored?.content).toBe("second version");
    expect(restored?.title).toBe("Restore Dupe");
    expect(ltm.versionHistory(dupe)).toHaveLength(4);
    // The provenance of the original merge is untouched by the restore.
    expect(dedupProvenanceFor(receipt.operationId)[0].merged_logical_id).toBe(
      dupe,
    );
  });

  test("the .lore.md export runs once per operation, not once per merged entry", () => {
    const keepA = createEntry("Export Keep A");
    const dupeA1 = createEntry("Export Dupe A1");
    const dupeA2 = createEntry("Export Dupe A2");
    const keepB = createEntry("Export Keep B");
    const dupeB = createEntry("Export Dupe B");

    const receipt = apply(
      request([decision(keepA, dupeA1, dupeA2), decision(keepB, dupeB)]),
    );

    expect(receipt.applied).toHaveLength(2);
    expect(exportLoreFile).toHaveBeenCalledTimes(1);
    expect(exportLoreFile).toHaveBeenCalledWith(PROJECT);
  });

  test("a fully refused operation does not export", () => {
    const keep = createEntry("No Export Keep");
    const dupe = createEntry("No Export Dupe");
    const preview = decision(keep, dupe);
    ltm.update(dupe, { content: "edited" });
    apply(request([preview]));
    expect(exportLoreFile).not.toHaveBeenCalled();
  });

  test("merging clears the merged entry's cross-references like a normal delete", () => {
    const keep = createEntry("Refs Keep");
    const dupe = createEntry("Refs Dupe");
    db()
      .query("INSERT INTO knowledge_refs (from_id, to_id) VALUES (?, ?)")
      .run(dupe, keep);
    apply(request([decision(keep, dupe)]));
    expect(
      db()
        .query("SELECT COUNT(*) AS n FROM knowledge_refs WHERE from_id = ?")
        .get(dupe),
    ).toEqual({ n: 0 });
  });
});

describe("shared pool", () => {
  const PROJECT_Q = join(ROOT, "project-q");
  mkdirSync(PROJECT_Q, { recursive: true });

  /** Promoted entry: project_id = its origin project, cross_project = 1. */
  function createPromoted(title: string, projectPath = PROJECT_Q): string {
    const id = ltm.create({
      id: uuidv7(),
      projectPath,
      category: "gotcha",
      title,
      content: `Promoted content for ${title}`,
      scope: "project",
      crossProject: true,
      session: "test-session",
    });
    return id;
  }

  function row(id: string) {
    return db()
      .query(
        "SELECT version, project_id, cross_project, is_deleted FROM knowledge WHERE logical_id = ? AND is_current = 1",
      )
      .get(ltm.logicalIdOf(id)) as {
      version: number;
      project_id: string | null;
      cross_project: number;
      is_deleted: number;
    };
  }

  test("projectId null merges a promoted entry into a NULL keep", () => {
    const keep = createGlobalEntry("Shared Pool Keep");
    const dupe = createPromoted("Shared Pool Dupe");
    const receipt = apply(request([decision(keep, dupe)], { projectId: null }));

    expect(receipt.refused).toEqual([]);
    expect(receipt.applied).toHaveLength(1);
    expect(isLive(keep)).toBe(true);
    expect(isLive(dupe)).toBe(false);
    // Keep row untouched: still version 1, still NULL/shared.
    expect(row(keep)).toMatchObject({
      version: 1,
      project_id: null,
      cross_project: 1,
    });
    expect(dedupProvenanceFor(receipt.operationId)[0]).toMatchObject({
      keep_logical_id: keep,
      merged_logical_id: dupe,
    });
    // Recoverable like any other merge: history ends in a tombstone and the
    // last live version restores.
    const history = ltm.versionHistory(dupe);
    expect(history.at(-1)?.is_deleted).toBe(1);
    const last = history[history.length - 2];
    const restoredId = ltm.appendVersion(dupe, {
      title: last.title,
      content: last.content,
      category: last.category,
      isDeleted: false,
    });
    expect(restoredId).not.toBeNull();
    expect(ltm.getByLogical(dupe)?.title).toBe("Shared Pool Dupe");
    // The merged row was Q-promoted: Q's .lore.md still listed it.
    expect(exportLoreFile).toHaveBeenCalledTimes(1);
    expect(exportLoreFile).toHaveBeenCalledWith(PROJECT_Q);
  });

  test("projectId null refuses a P-private member and writes nothing", () => {
    const keep = createGlobalEntry("Shared Null Keep");
    const priv = createEntry("Shared Null Private");
    const receipt = apply(request([decision(keep, priv)], { projectId: null }));
    expect(receipt.applied).toEqual([]);
    expect(receipt.refused[0].error.code).toBe("scope_mismatch");
    expect(receipt.refused[0].error.details).toEqual([
      { id: priv, reason: "scope_mismatch", expectedRevision: 1 },
    ]);
    expect(isLive(keep)).toBe(true);
    expect(isLive(priv)).toBe(true);
    expect(dedupProvenanceFor(receipt.operationId)).toEqual([]);
  });

  test("projectId P merges P-private entries into shared keepers", () => {
    const nullKeep = createGlobalEntry("P Null Keep");
    const promotedKeep = createPromoted("P Promoted Keep");
    const privA = createEntry("P Private Dupe A");
    const privB = createEntry("P Private Dupe B");
    const receipt = apply(
      request([decision(nullKeep, privA), decision(promotedKeep, privB)]),
    );

    expect(receipt.refused).toEqual([]);
    expect(receipt.applied).toHaveLength(2);
    expect(isLive(privA)).toBe(false);
    expect(isLive(privB)).toBe(false);
    // The shared keepers are untouched: same version, same scope fields.
    expect(row(nullKeep)).toMatchObject({
      version: 1,
      project_id: null,
      cross_project: 1,
    });
    expect(row(promotedKeep)).toMatchObject({
      version: 1,
      project_id: ensureProject(PROJECT_Q),
      cross_project: 1,
    });
    const provenance = dedupProvenanceFor(receipt.operationId);
    expect(provenance.map((p) => p.keep_logical_id)).toEqual([
      nullKeep,
      promotedKeep,
    ]);
    // The operation ran under the project scope, so P's .lore.md exports.
    expect(exportLoreFile).toHaveBeenCalledTimes(1);
    expect(exportLoreFile).toHaveBeenCalledWith(PROJECT);
  });

  test("NULL merged into a P-private keep is scope_mismatch and writes nothing", () => {
    const keep = createEntry("Scope Priv Keep");
    const global = createGlobalEntry("Scope Null Merge");
    const receipt = apply(request([decision(keep, global)]));
    expect(receipt.applied).toEqual([]);
    expect(receipt.refused[0].error.code).toBe("scope_mismatch");
    expect(isLive(keep)).toBe(true);
    expect(isLive(global)).toBe(true);
    expect(dedupProvenanceFor(receipt.operationId)).toEqual([]);
  });

  test("P-promoted merged into a P-private keep is scope_mismatch and writes nothing", () => {
    const keep = createEntry("Scope Priv Keep 2");
    const promoted = createPromoted("Scope P-Promoted Merge", PROJECT);
    const receipt = apply(request([decision(keep, promoted)]));
    expect(receipt.applied).toEqual([]);
    expect(receipt.refused[0].error.code).toBe("scope_mismatch");
    expect(isLive(keep)).toBe(true);
    expect(isLive(promoted)).toBe(true);
    expect(dedupProvenanceFor(receipt.operationId)).toEqual([]);
  });

  test("NULL keep + Q-promoted merge under P is scope_mismatch and writes nothing", () => {
    const keep = createGlobalEntry("Scope Null Keep Under P");
    const merge = createPromoted("Scope Q-Promoted Merge");
    const receipt = apply(request([decision(keep, merge)]));
    expect(receipt.applied).toEqual([]);
    expect(receipt.refused[0].error.code).toBe("scope_mismatch");
    expect(receipt.refused[0].error.details).toEqual([
      { id: merge, reason: "scope_mismatch", expectedRevision: 1 },
    ]);
    expect(isLive(keep)).toBe(true);
    expect(isLive(merge)).toBe(true);
    expect(dedupProvenanceFor(receipt.operationId)).toEqual([]);
  });

  test("Q-private keep under P is scope_mismatch and writes nothing", () => {
    const keep = createEntry("Scope Q Keep", PROJECT_B);
    const dupe = createEntry("Scope P Dupe");
    const receipt = apply(request([decision(keep, dupe)]));
    expect(receipt.applied).toEqual([]);
    expect(receipt.refused[0].error.code).toBe("scope_mismatch");
    expect(receipt.refused[0].error.details).toEqual([
      { id: keep, reason: "scope_mismatch", expectedRevision: 1 },
    ]);
    expect(isLive(keep)).toBe(true);
    expect(isLive(dupe)).toBe(true);
    expect(dedupProvenanceFor(receipt.operationId)).toEqual([]);
  });
});

describe("shared-pool merge exports", () => {
  const PROJECT_Q2 = join(ROOT, "project-q2");
  const PROJECT_R2 = join(ROOT, "project-r2");
  mkdirSync(PROJECT_Q2, { recursive: true });
  mkdirSync(PROJECT_R2, { recursive: true });

  function createPromoted(title: string, projectPath: string): string {
    return ltm.create({
      id: uuidv7(),
      projectPath,
      category: "gotcha",
      title,
      content: `Promoted content for ${title}`,
      scope: "project",
      crossProject: true,
      session: "test-session",
    });
  }

  test("a shared-pool merge of a Q-promoted entry exports Q's .lore.md exactly once", () => {
    ensureProject(PROJECT_Q2, "dedup-apply-q2");
    const keep = createGlobalEntry("Export Null Keep");
    const dupe = createPromoted("Export Q-Promoted Dupe", PROJECT_Q2);
    const receipt = apply(request([decision(keep, dupe)], { projectId: null }));

    expect(receipt.refused).toEqual([]);
    expect(exportLoreFile).toHaveBeenCalledTimes(1);
    expect(exportLoreFile).toHaveBeenCalledWith(PROJECT_Q2);
  });

  test("a shared-pool merge of two NULL entries exports nothing", () => {
    const keep = createGlobalEntry("Export Null Keep 2");
    const dupe = createGlobalEntry("Export Null Dupe 2");
    const receipt = apply(request([decision(keep, dupe)], { projectId: null }));
    expect(receipt.refused).toEqual([]);
    expect(exportLoreFile).not.toHaveBeenCalled();
  });

  test("a mixed operation exports each origin project once", () => {
    ensureProject(PROJECT_Q2, "dedup-apply-q2");
    ensureProject(PROJECT_R2, "dedup-apply-r2");
    const keepA = createGlobalEntry("Export Mixed Keep A");
    const dupeQ = createPromoted("Export Mixed Dupe Q", PROJECT_Q2);
    const keepB = createGlobalEntry("Export Mixed Keep B");
    const dupeR = createPromoted("Export Mixed Dupe R", PROJECT_R2);
    const receipt = apply(
      request([decision(keepA, dupeQ), decision(keepB, dupeR)], {
        projectId: null,
      }),
    );

    expect(receipt.refused).toEqual([]);
    expect(exportLoreFile).toHaveBeenCalledTimes(2);
    expect(exportLoreFile).toHaveBeenCalledWith(PROJECT_Q2);
    expect(exportLoreFile).toHaveBeenCalledWith(PROJECT_R2);
  });

  test("a replayed operation does not export again", () => {
    ensureProject(PROJECT_Q2, "dedup-apply-q2");
    const keep = createGlobalEntry("Export Replay Keep");
    const dupe = createPromoted("Export Replay Dupe", PROJECT_Q2);
    const req = request([decision(keep, dupe)], { projectId: null });
    apply(req);
    expect(exportLoreFile).toHaveBeenCalledTimes(1);
    exportLoreFile.mockClear();

    const second = apply(req);
    expect(second.replayed).toBe(true);
    expect(exportLoreFile).not.toHaveBeenCalled();
  });
});

describe("keep content from a merged entry", () => {
  const PROJECT_CF_Q = join(ROOT, "project-cf-q");
  mkdirSync(PROJECT_CF_Q, { recursive: true });
  let qProjectId = "";

  function createPromoted(title: string): string {
    return ltm.create({
      id: uuidv7(),
      projectPath: PROJECT_CF_Q,
      category: "gotcha",
      title,
      content: `Promoted content for ${title}`,
      scope: "project",
      crossProject: true,
      session: "test-session",
    });
  }

  function rowOf(id: string) {
    return db()
      .query(
        "SELECT id, version, project_id, cross_project, is_deleted, title, content FROM knowledge WHERE logical_id = ? AND is_current = 1",
      )
      .get(ltm.logicalIdOf(id)) as {
      id: string;
      version: number;
      project_id: string | null;
      cross_project: number;
      is_deleted: number;
      title: string;
      content: string;
    };
  }

  const survivorCases: Array<{
    label: string;
    make: (title: string) => string;
    /** Extra .lore.md export expected besides the request project's. */
    extraExportPath: string | null;
  }> = [
    {
      label: "NULL-project global survivor",
      make: (title) => createGlobalEntry(title),
      extraExportPath: null,
    },
    {
      label: "promoted survivor from another project",
      make: (title) => createPromoted(title),
      extraExportPath: PROJECT_CF_Q,
    },
  ];

  test.each(survivorCases)(
    "$label: replaces the survivor's content and tombstones the source",
    ({ make, extraExportPath }) => {
      qProjectId = ensureProject(PROJECT_CF_Q, "dedup-apply-cf-q");
      const s = make("CF Shared Survivor Title");
      const sBefore = rowOf(s);
      const p = createEntry("CF Private Source Title");
      const pRevision = revisionOf(p);
      const d = decision(s, p);
      const receipt = apply(
        request([{ ...d, contentFromId: p }], { projectId }),
      );

      expect(receipt.refused).toEqual([]);
      expect(receipt.applied).toHaveLength(1);
      const sAfter = rowOf(s);
      // The survivor took p's title/content as a new version — scope untouched.
      expect(sAfter.title).toBe("CF Private Source Title");
      expect(sAfter.content).toBe(`Content for CF Private Source Title`);
      expect(sAfter.project_id).toBe(sBefore.project_id);
      expect(sAfter.cross_project).toBe(sBefore.cross_project);
      expect(sAfter.version).toBe(sBefore.version + 1);
      // The old version is still in history for recovery.
      const history = ltm.versionHistory(ltm.logicalIdOf(s));
      expect(
        history.some(
          (v) => v.version === sBefore.version && v.content === sBefore.content,
        ),
      ).toBe(true);
      expect(isLive(p)).toBe(false);
      const provenance = dedupProvenanceFor(receipt.operationId);
      expect(provenance).toHaveLength(1);
      expect(provenance[0]).toMatchObject({
        keep_logical_id: ltm.logicalIdOf(s),
        merged_logical_id: ltm.logicalIdOf(p),
      });
      const appliedGroup = receipt.applied[0];
      expect(appliedGroup.keepRevision).toBe(sAfter.version);
      expect(appliedGroup.contentFrom).toEqual({
        id: p,
        revision: pRevision,
        replacedKeepRevision: sBefore.version,
        keepVersionId: sAfter.id,
      });
      expect(exportLoreFile).toHaveBeenCalledWith(PROJECT);
      expect(exportLoreFile).toHaveBeenCalledTimes(extraExportPath ? 2 : 1);
      if (extraExportPath)
        expect(exportLoreFile).toHaveBeenCalledWith(extraExportPath);
      void qProjectId;
    },
  );

  test.each(survivorCases)(
    "$label: a stale survivor revision refuses and changes nothing",
    ({ make }) => {
      const s = make("CF Stale Survivor Title");
      const p = createEntry("CF Stale Source Title");
      const d = decision(s, p);
      ltm.update(ltm.logicalIdOf(s), { content: "edited after preview" });
      const receipt = apply(
        request([{ ...d, contentFromId: p }], { projectId }),
      );
      expect(receipt.applied).toEqual([]);
      expect(receipt.refused[0].error.code).toBe("stale_revision");
      expect(rowOf(s).content).toBe("edited after preview");
      expect(isLive(p)).toBe(true);
      expect(dedupProvenanceFor(receipt.operationId)).toEqual([]);
      expect(exportLoreFile).not.toHaveBeenCalled();
    },
  );

  test("a stale source revision refuses and changes nothing", () => {
    const s = createGlobalEntry("CF Stale Source Survivor");
    const p = createEntry("CF Stale Source Entry");
    const d = decision(s, p);
    ltm.update(ltm.logicalIdOf(p), { content: "source edited after preview" });
    const receipt = apply(request([{ ...d, contentFromId: p }], { projectId }));
    expect(receipt.applied).toEqual([]);
    expect(receipt.refused[0].error.code).toBe("stale_revision");
    expect(rowOf(s).title).toBe("CF Stale Source Survivor");
    expect(isLive(p)).toBe(true);
    expect(dedupProvenanceFor(receipt.operationId)).toEqual([]);
  });

  test("the same request replays the receipt without re-applying", () => {
    const s = createGlobalEntry("CF Replay Survivor Title");
    const p = createEntry("CF Replay Source Title");
    const req = request([{ ...decision(s, p), contentFromId: p }], {
      projectId,
    });
    const first = apply(req);
    expect(first.applied).toHaveLength(1);
    const versionAfterFirst = rowOf(s).version;
    exportLoreFile.mockClear();

    const second = apply(req);
    expect(second.replayed).toBe(true);
    expect(second.applied).toEqual(first.applied);
    expect(second.refused).toEqual(first.refused);
    expect(rowOf(s).version).toBe(versionAfterFirst);
    expect(exportLoreFile).not.toHaveBeenCalled();
  });

  test.each(survivorCases)(
    "$label: a same-scope title collision refuses the whole group",
    ({ make }) => {
      const s = make("CF Conflict Survivor Title");
      const p = createEntry("CF Conflict Source Title");
      // A third shared entry whose title equals the source's, case-insensitively.
      const blocker = createGlobalEntry("cf conflict source title");
      expect(ltm.getByLogical(ltm.logicalIdOf(blocker))).not.toBeNull();
      expect(blocker).not.toBe(p);
      const d = decision(s, p);
      const receipt = apply(
        request([{ ...d, contentFromId: p }], { projectId }),
      );

      expect(receipt.applied).toEqual([]);
      const refused = receipt.refused[0];
      expect(refused.error.code).toBe("title_conflict");
      expect(refused.error.details).toEqual([
        {
          id: p,
          reason: "title_conflict",
          expectedRevision: d.expectedRevisions[p],
        },
      ]);
      // Rolled back: the merges never committed, no provenance, no export.
      const sAfter = rowOf(s);
      expect(sAfter.version).toBe(1);
      expect(sAfter.title).toBe("CF Conflict Survivor Title");
      expect(isLive(p)).toBe(true);
      expect(dedupProvenanceFor(receipt.operationId)).toEqual([]);
      expect(exportLoreFile).not.toHaveBeenCalled();
    },
  );

  test("a source title equal to the survivor's title applies cleanly", () => {
    const s = createGlobalEntry("CF Same Title For Both");
    const p = createEntry("CF Same Title For Both");
    const receipt = apply(
      request([{ ...decision(s, p), contentFromId: p }], { projectId }),
    );
    expect(receipt.refused).toEqual([]);
    expect(receipt.applied).toHaveLength(1);
    expect(rowOf(s).content).toBe("Content for CF Same Title For Both");
    expect(rowOf(s).title).toBe("CF Same Title For Both");
  });

  test("contentFromId outside mergeIds (and equal to keepId) is invalid", () => {
    const base = {
      projectId: "p",
      operationId: "op-x",
      reviewedAt: 1,
      actor: "a",
    };
    const decisionBase = {
      keepId: "k",
      mergeIds: ["m"],
      expectedRevisions: { k: 1, m: 1 },
    };
    expect(() =>
      parseDedupApplyRequest({
        ...base,
        decisions: [{ ...decisionBase, contentFromId: "other" }],
      }),
    ).toThrowError(DedupApplyError);
    expect(() =>
      parseDedupApplyRequest({
        ...base,
        decisions: [{ ...decisionBase, contentFromId: "k" }],
      }),
    ).toThrowError(DedupApplyError);
    try {
      parseDedupApplyRequest({
        ...base,
        decisions: [{ ...decisionBase, contentFromId: "other" }],
      });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as DedupApplyError).code).toBe("invalid_request");
    }
  });

  test("the payload hash is unchanged without contentFromId and differs with it", () => {
    const fixed = {
      projectId: "p1",
      operationId: "op-hash-stability",
      reviewedAt: 1700000000000,
      actor: "tester",
      decisions: [
        {
          keepId: "keep-1",
          mergeIds: ["m1", "m2"],
          expectedRevisions: { "keep-1": 2, m1: 1, m2: 3 },
        },
      ],
    };
    expect(dedupApplyPayloadHash(fixed)).toBe(
      "5b9e4e6d4bc7abe7fc970750d6ec58aeef6f61fddaf9394ecfbc5276ce0170f0",
    );
    expect(
      dedupApplyPayloadHash({
        ...fixed,
        decisions: [{ ...fixed.decisions[0], contentFromId: "m1" }],
      }),
    ).not.toBe(
      "5b9e4e6d4bc7abe7fc970750d6ec58aeef6f61fddaf9394ecfbc5276ce0170f0",
    );
  });

  test("private survivor takes a private source's content in the project pool", () => {
    const p1 = createEntry("CF Private Keep Title");
    const p2 = createEntry("CF Private Drop Title");
    const receipt = apply(
      request([{ ...decision(p1, p2), contentFromId: p2 }], { projectId }),
    );
    expect(receipt.refused).toEqual([]);
    const after = rowOf(p1);
    expect(after.title).toBe("CF Private Drop Title");
    expect(after.content).toBe("Content for CF Private Drop Title");
    expect(after.project_id).toBe(projectId);
    expect(after.cross_project).toBe(0);
    expect(isLive(p2)).toBe(false);
  });
});
