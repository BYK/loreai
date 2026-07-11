/**
 * Integration tests for migration 0030 — key-rotation foundation (E-4c-3a, #827) against a real
 * Postgres:
 *  - rotate_scope_key atomically bumps scopes.key_epoch and is admin-only;
 *  - the composite PK (scope_id, member_user_id, key_epoch) lets a member hold one wrap PER
 *    epoch (a new-epoch row coexists with the old, so past blobs stay decryptable);
 *  - the immutability guard blocks changing an existing epoch's wrapped_dek (rotation writes a
 *    NEW epoch row, never re-wraps in place).
 *
 * Gated behind LORE_INTEGRATION=1 (needs Docker). Run:
 *   LORE_INTEGRATION=1 pnpm exec vitest run packages/gateway/test/sync-scope-rotation.integration.test.ts
 */
import { execFileSync } from "node:child_process";
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
beforeAll(async () => {
  if (!SKIP) h = await startPgHarness();
}, 180_000);
afterAll(async () => {
  if (h) await h.stop();
});
const gate = () => SKIP;

async function expectError(
  fn: () => Promise<unknown>,
): Promise<{ code?: string }> {
  try {
    await fn();
  } catch (e) {
    return { code: (e as { code?: string }).code };
  }
  throw new Error("expected the query to fail, but it succeeded");
}

const createTeam = (uid: string, name: string) =>
  h.asUser(uid, (c) =>
    c
      .query("select public.create_team($1) as s", [name])
      .then((r) => r.rows[0].s as string),
  );
const rotate = (uid: string, scope: string) =>
  h.asUser(uid, (c) =>
    c
      .query("select public.rotate_scope_key($1) as e", [scope])
      .then((r) => r.rows[0].e as number),
  );
// A scope admin writes a wrap row (author defaults to auth.uid()); RLS requires scope_role=admin.
const putWrap = (
  uid: string,
  scope: string,
  member: string,
  epoch: number,
  dek: string,
) =>
  h.asUser(uid, (c) =>
    c.query(
      "insert into public.scope_keys (scope_id, member_user_id, key_epoch, wrapped_dek) values ($1,$2,$3,$4)",
      [scope, member, epoch, dek],
    ),
  );

describe.skipIf(gate())("0030 key rotation foundation (E-4c-3a, #827)", () => {
  it("rotate_scope_key bumps scopes.key_epoch and returns the new epoch; admin-only", async () => {
    const a = await h.createUser();
    const b = await h.createUser(); // not a member
    const scope = await createTeam(a, "Rot A");
    expect(await rotate(a, scope)).toBe(1); // 0 → 1
    expect(await rotate(a, scope)).toBe(2); // 1 → 2
    expect(
      await h.client
        .query("select key_epoch from public.scopes where id=$1", [scope])
        .then((r) => r.rows[0].key_epoch),
    ).toBe(2);
    expect((await expectError(() => rotate(b, scope))).code).toBe("42501"); // non-admin
  });

  it("a member holds one wrap per epoch — new-epoch rows coexist with old (multi-epoch PK)", async () => {
    const a = await h.createUser();
    const scope = await createTeam(a, "Rot B");
    await putWrap(a, scope, a, 0, "ZDA="); // epoch 0
    await putWrap(a, scope, a, 1, "ZDE="); // epoch 1 — a NEW PK row, not a clobber
    expect(
      await h.client
        .query(
          "select key_epoch from public.scope_keys where scope_id=$1 and member_user_id=$2 order by key_epoch",
          [scope, a],
        )
        .then((r) => r.rows.map((x) => x.key_epoch)),
    ).toEqual([0, 1]); // both retained
  });

  it("a rotation's new-epoch wrap is COUNTED against the row cap (0031 per-epoch probe)", async () => {
    const a = await h.createUser();
    const scope = await createTeam(a, "Rot Quota");
    const setCap = (n: number) =>
      h.client.query(
        "update public.plan_limits set max_rows=$1 where tier='free' and table_name='scope_keys'",
        [n],
      );
    try {
      await setCap(1);
      await putWrap(a, scope, a, 0, "ZDA="); // epoch 0 → count 0→1 (ok)
      // A rotation writes epoch 1 as a NEW physical row for the SAME member. The 0031 probe now
      // matches key_epoch, so this row is counted → it trips the cap (before 0031 the probe
      // matched only (scope,member), early-returned, and let the row escape the cap).
      expect(
        (await expectError(() => putWrap(a, scope, a, 1, "ZDE="))).code,
      ).toBe("23514");
    } finally {
      await setCap(100); // restore the default free scope_keys cap
    }
  });

  it("an existing epoch's wrapped_dek is immutable (rotation writes a new row, never re-wraps)", async () => {
    const a = await h.createUser();
    const scope = await createTeam(a, "Rot C");
    await putWrap(a, scope, a, 0, "ZDA=");
    // In-place re-wrap of the SAME (scope, member, epoch) → blocked as poison.
    const err = await expectError(() =>
      h.asUser(a, (c) =>
        c.query(
          "update public.scope_keys set wrapped_dek=$1 where scope_id=$2 and member_user_id=$3 and key_epoch=0",
          ["Y2xvYmJlcg==", scope, a],
        ),
      ),
    );
    expect(err.code).toBe("23514");
    // A metadata-only UPDATE (same wrapped_dek) is still allowed.
    await h.asUser(a, (c) =>
      c.query(
        "update public.scope_keys set revision=revision+1 where scope_id=$1 and member_user_id=$2 and key_epoch=0",
        [scope, a],
      ),
    );
  });
});
