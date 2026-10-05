import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type PgHarness, startPgHarness } from "./helpers/pg-harness";

function dockerReady(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

const RUN = process.env.LORE_INTEGRATION === "1";
const SKIP = !RUN
  ? "LORE_INTEGRATION!=1"
  : !dockerReady()
    ? "docker unavailable"
    : false;

let h: PgHarness;
let adminA: string;
let adminB: string;
let editorC: string;
let editorD: string;
let viewerV: string;
let nonMemberX: string;
let scopeId: string;

beforeAll(async () => {
  if (SKIP) return;
  h = await startPgHarness({ postgrest: true });
  adminA = await h.createUser("promotion-admin-a@test.dev");
  adminB = await h.createUser("promotion-admin-b@test.dev");
  editorC = await h.createUser("promotion-editor@test.dev");
  editorD = await h.createUser("promotion-editor-other@test.dev");
  viewerV = await h.createUser("promotion-viewer@test.dev");
  nonMemberX = await h.createUser("promotion-outsider@test.dev");
  const orgId = randomUUID();
  scopeId = randomUUID();
  await h.client.query(
    "insert into public.orgs (id, kind, owner_user_id, name) values ($1, 'team', $2, 'Promotion Team')",
    [orgId, adminA],
  );
  await h.client.query(
    "insert into public.scopes (id, org_id, kind, name) values ($1, $2, 'team', 'Promotion Team')",
    [scopeId, orgId],
  );
  await h.client.query(
    "insert into public.scope_members (scope_id, user_id, role) values ($1,$2,'admin'),($1,$3,'admin'),($1,$4,'editor'),($1,$5,'editor'),($1,$6,'viewer')",
    [scopeId, adminA, adminB, editorC, editorD, viewerV],
  );
}, 240_000);

afterAll(async () => {
  if (h) await h.stop();
});

const gate = () => SKIP;

async function expectError(fn: () => Promise<unknown>): Promise<{
  code?: string;
  message: string;
}> {
  try {
    await fn();
  } catch (error) {
    return {
      code: (error as { code?: string }).code,
      message: (error as Error).message,
    };
  }
  throw new Error("expected the query to fail, but it succeeded");
}

function requestRow(logicalId: string, createdAt?: string) {
  return {
    id: randomUUID(),
    scope_id: scopeId,
    logical_id: logicalId,
    entry_version_id: `${logicalId}-version`,
    entry_version: 1,
    category: "pattern",
    title_enc: "sealed-title",
    content_enc: "sealed-content",
    ...(createdAt ? { created_at: createdAt } : {}),
  };
}

async function insertAs(uid: string, logicalId: string, id = randomUUID()) {
  const values = requestRow(logicalId);
  values.id = id;
  return h.asUser(uid, (client) =>
    client.query(
      `select * from public.propose_promotion($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        values.id,
        values.scope_id,
        values.logical_id,
        values.entry_version_id,
        values.entry_version,
        values.category,
        values.title_enc,
        values.content_enc,
      ],
    ),
  );
}

async function setPolicy(uid: string, policy: string, expected: string) {
  return h.asUser(uid, (client) =>
    client.query("select public.set_team_promotion_policy($1,$2,$3)", [
      scopeId,
      policy,
      expected,
    ]),
  );
}

async function decide(
  uid: string,
  id: string,
  decision: "approved" | "rejected",
  note: string | null = null,
) {
  return h.asUser(uid, (client) =>
    client.query("select * from public.decide_promotion($1,$2,$3)", [
      id,
      decision,
      note,
    ]),
  );
}

async function withdraw(uid: string, id: string) {
  return h.asUser(uid, (client) =>
    client.query("select * from public.withdraw_promotion($1)", [id]),
  );
}

async function markApplied(
  uid: string,
  id: string,
  outcome: "applied" | "stale",
) {
  return h.asUser(uid, (client) =>
    client.query("select * from public.mark_promotion_applied($1,$2)", [
      id,
      outcome,
    ]),
  );
}

describe.skipIf(gate())("promotion request RLS and decisions (#1807)", () => {
  it("allows team members to see editor proposals and rejects viewer, forged, and direct writes", async () => {
    const inserted = await insertAs(editorC, "visible-proposal");
    const id = inserted.rows[0].id as string;
    for (const uid of [adminA, adminB, viewerV]) {
      const visible = await h.asUser(uid, (client) =>
        client.query("select id from public.promotion_requests where id=$1", [
          id,
        ]),
      );
      expect(visible.rowCount).toBe(1);
    }
    const hidden = await h.asUser(nonMemberX, (client) =>
      client.query("select id from public.promotion_requests where id=$1", [
        id,
      ]),
    );
    expect(hidden.rowCount).toBe(0);

    const viewerInsert = await expectError(() =>
      insertAs(viewerV, "viewer-cannot-propose"),
    );
    expect(viewerInsert.code).toBe("42501");

    const forgedProposer = requestRow("forged-proposer");
    const forged = await expectError(() =>
      h.asUser(editorC, (client) =>
        client.query(
          `insert into public.promotion_requests
             (id, scope_id, logical_id, entry_version_id, entry_version,
              category, title_enc, content_enc, proposer_id)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            forgedProposer.id,
            scopeId,
            forgedProposer.logical_id,
            forgedProposer.entry_version_id,
            forgedProposer.entry_version,
            forgedProposer.category,
            forgedProposer.title_enc,
            forgedProposer.content_enc,
            adminA,
          ],
        ),
      ),
    );
    expect(forged.code).toBe("42501");

    const forgedStatus = requestRow("forged-status");
    const statusError = await expectError(() =>
      h.asUser(editorC, (client) =>
        client.query(
          `insert into public.promotion_requests
             (id, scope_id, logical_id, entry_version_id, entry_version,
              category, title_enc, content_enc, status, decided_by, decided_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,'approved',$9,now())`,
          [
            forgedStatus.id,
            scopeId,
            forgedStatus.logical_id,
            forgedStatus.entry_version_id,
            forgedStatus.entry_version,
            forgedStatus.category,
            forgedStatus.title_enc,
            forgedStatus.content_enc,
            adminA,
          ],
        ),
      ),
    );
    expect(statusError.code).toBe("42501");

    for (const uid of [adminA, adminB, editorC, viewerV, nonMemberX]) {
      const updateError = await expectError(() =>
        h.asUser(uid, (client) =>
          client.query(
            "update public.promotion_requests set status='approved' where id=$1",
            [id],
          ),
        ),
      );
      expect(updateError.code).toBe("42501");
      const deleteError = await expectError(() =>
        h.asUser(uid, (client) =>
          client.query("delete from public.promotion_requests where id=$1", [
            id,
          ]),
        ),
      );
      expect(deleteError.code).toBe("42501");
    }
    const stillPending = await h.client.query(
      "select status from public.promotion_requests where id=$1",
      [id],
    );
    expect(stillPending.rows[0].status).toBe("pending");

    const duplicate = await expectError(() =>
      insertAs(editorC, "visible-proposal"),
    );
    expect(duplicate.code).toBe("23505");

    const withId = await insertAs(editorC, "duplicate-id-original");
    const duplicateId = await expectError(() =>
      insertAs(editorC, "duplicate-id-different-logical", withId.rows[0].id),
    );
    expect(duplicateId.code).toBe("23505");
  });

  it("allows admin self-review and keeps editor decisions from changing requests", async () => {
    const selfReview = await insertAs(adminA, "admin-self-review");
    const selfId = selfReview.rows[0].id as string;
    const selfApproved = await decide(adminA, selfId, "approved");
    expect(selfApproved.rows[0]).toMatchObject({
      status: "approved",
      decided_by: adminA,
    });

    const request = await insertAs(editorC, "editor-needs-review");
    const id = request.rows[0].id as string;
    expect(
      (await expectError(() => decide(nonMemberX, id, "approved"))).code,
    ).toBe("P0002");

    for (const editor of [editorC, editorD]) {
      for (const decision of ["approved", "rejected"] as const) {
        expect(
          (await expectError(() => decide(editor, id, decision))).code,
        ).toBe("42501");
      }
    }
    const unchanged = await h.client.query(
      "select status, decided_by, decided_at, decision_note from public.promotion_requests where id=$1",
      [id],
    );
    expect(unchanged.rows[0]).toEqual({
      status: "pending",
      decided_by: null,
      decided_at: null,
      decision_note: null,
    });

    const approved = await decide(adminB, id, "approved", "Reviewed");
    expect(approved.rows[0]).toMatchObject({
      status: "approved",
      decided_by: adminB,
      decision_note: "Reviewed",
    });
    expect((await expectError(() => decide(adminB, id, "rejected"))).code).toBe(
      "55000",
    );

    const rejected = await insertAs(editorC, "admin-can-reject");
    const rejection = await decide(
      adminB,
      rejected.rows[0].id as string,
      "rejected",
    );
    expect(rejection.rows[0]).toMatchObject({
      status: "rejected",
      decided_by: adminB,
    });

    const oversized = await insertAs(editorC, "oversized-note");
    expect(
      (
        await expectError(() =>
          decide(
            adminB,
            oversized.rows[0].id as string,
            "approved",
            "x".repeat(501),
          ),
        )
      ).code,
    ).toBe("22001");
  });

  it("applies server review policy to proposals and guards policy updates", async () => {
    const manual = await insertAs(editorC, "manual-policy-pending");
    expect(manual.rows[0]).toMatchObject({
      status: "pending",
      decided_by: null,
      decision_note: null,
    });

    expect(
      (await expectError(() => setPolicy(editorC, "auto", "manual"))).code,
    ).toBe("42501");
    expect(
      (await expectError(() => setPolicy(adminA, "invalid", "manual"))).code,
    ).toBe("22023");

    await setPolicy(adminA, "auto", "manual");
    const automatic = await insertAs(editorC, "automatic-policy-approved");
    expect(automatic.rows[0]).toMatchObject({
      status: "approved",
      decided_by: editorC,
      decision_note: "auto-approved: team does not require review",
    });

    expect(
      (await expectError(() => setPolicy(adminA, "manual", "manual"))).code,
    ).toBe("40001");
    const unchanged = await h.client.query(
      "select promotion_policy from public.scopes where id=$1",
      [scopeId],
    );
    expect(unchanged.rows[0].promotion_policy).toBe("auto");
    await setPolicy(adminA, "manual", "auto");
  });

  it("allows proposer-only pending withdrawal and proposer-only one-time applied markers", async () => {
    const pending = await insertAs(editorC, "withdrawal");
    const pendingId = pending.rows[0].id as string;
    expect((await expectError(() => withdraw(adminA, pendingId))).code).toBe(
      "42501",
    );
    expect(
      (await expectError(() => markApplied(editorC, pendingId, "applied")))
        .code,
    ).toBe("55000");
    await withdraw(editorC, pendingId);
    expect((await expectError(() => withdraw(editorC, pendingId))).code).toBe(
      "55000",
    );

    const decided = await insertAs(editorC, "applied-marker");
    const decidedId = decided.rows[0].id as string;
    await decide(adminB, decidedId, "approved");
    expect(
      (await expectError(() => markApplied(adminB, decidedId, "applied"))).code,
    ).toBe("42501");
    const marked = await markApplied(editorC, decidedId, "applied");
    expect(marked.rows[0]).toMatchObject({ applied: "applied" });
    expect(
      (await expectError(() => markApplied(editorC, decidedId, "stale"))).code,
    ).toBe("55000");
  });

  it("stamps created_at server-side and supports the two-account proposal flow", async () => {
    const oldDate = "2000-01-01T00:00:00.000Z";
    const values = requestRow("stamped", oldDate);
    const inserted = await h.client.query(
      `insert into public.promotion_requests
         (id, scope_id, logical_id, entry_version_id, entry_version, category,
          title_enc, content_enc, proposer_id, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
      [
        values.id,
        values.scope_id,
        values.logical_id,
        values.entry_version_id,
        values.entry_version,
        values.category,
        values.title_enc,
        values.content_enc,
        editorC,
        oldDate,
      ],
    );
    const id = inserted.rows[0].id as string;
    expect(new Date(inserted.rows[0].created_at).getTime()).toBeGreaterThan(
      new Date(oldDate).getTime(),
    );
    await decide(adminB, id, "approved");
    const applied = await markApplied(editorC, id, "applied");
    expect(applied.rows[0]).toMatchObject({
      status: "approved",
      applied: "applied",
      proposer_id: editorC,
    });
  });

  it("returns current member profiles only through the scope-authorized RPC", async () => {
    const memberProfiles = await h.asUser(adminA, (client) =>
      client.query("select * from public.team_member_profiles($1)", [scopeId]),
    );
    const editorProfile = memberProfiles.rows.find(
      (row) => row.user_id === editorC,
    );
    expect(editorProfile).toBeDefined();
    expect(Object.keys(editorProfile).sort()).toEqual([
      "display_name",
      "email",
      "github_login",
      "user_id",
    ]);

    const nonmemberError = await expectError(() =>
      h.asUser(nonMemberX, (client) =>
        client.query("select * from public.team_member_profiles($1)", [
          scopeId,
        ]),
      ),
    );
    expect(nonmemberError.code).toBe("42501");

    const directProfile = await h.asUser(nonMemberX, (client) =>
      client.query("select id from public.profiles where id=$1", [editorC]),
    );
    expect(directProfile.rowCount).toBe(0);
  });
});
