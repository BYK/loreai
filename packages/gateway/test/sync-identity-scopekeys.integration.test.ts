/**
 * Integration tests for migration 0025 — identity_pub directory + member-aware scope_keys RLS
 * (E-3, #827) against a real Postgres. Proves:
 *  - identity_pub: publish/rotate OWN pubkey only; read own + co-members' (never a global
 *    directory) — discriminated by a scope_members row flipping shares_scope();
 *  - identity_pub size cap;
 *  - scope_keys: a MEMBER reads only their own wrap; only a scope ADMIN may write wraps
 *    (group wrapping) — an editor/non-member is rejected;
 *  - behavior-preserving for a personal scope (owner reads/writes own self-wrap as before).
 *
 * Gated behind LORE_INTEGRATION=1 (needs Docker). Run:
 *   LORE_INTEGRATION=1 pnpm exec vitest run packages/gateway/test/sync-identity-scopekeys.integration.test.ts
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

async function expectError(fn: () => Promise<unknown>): Promise<{
  code?: string;
  message: string;
}> {
  try {
    await fn();
  } catch (e) {
    return {
      code: (e as { code?: string }).code,
      message: (e as Error).message,
    };
  }
  throw new Error("expected the query to fail, but it succeeded");
}

// A member's published key travels as base64 TEXT (0026 — the wire convention for all key
// material). `raw` = the number of raw key bytes; the stored value is their base64.
const pubkey = (raw = 32) => Buffer.alloc(raw, 7).toString("base64");
const publishPub = (uid: string, bytes = 32) =>
  h.asUser(uid, (c) =>
    c.query("insert into public.identity_pub (public_key) values ($1)", [
      pubkey(bytes),
    ]),
  );
// member reads via RLS how many identity_pub rows for a given target user.
const canReadPub = (viewer: string, target: string) =>
  h.asUser(viewer, (c) =>
    c
      .query("select 1 from public.identity_pub where user_id=$1", [target])
      .then((r) => r.rowCount),
  );
const addMember = (scope: string, user: string, role: string) =>
  h.client.query(
    "insert into public.scope_members (scope_id, user_id, role) values ($1,$2,$3)",
    [scope, user, role],
  );

describe.skipIf(gate())(
  "0025 identity_pub + member-aware scope_keys RLS (E-3, #827)",
  () => {
    it("identity_pub: a user publishes their own pubkey; cannot write another user's", async () => {
      const a = await h.createUser();
      const b = await h.createUser();
      await publishPub(a); // own row (user_id defaults to auth.uid())
      expect(await canReadPub(a, a)).toBe(1);
      // forging another user's row is rejected by RLS WITH CHECK user_id = auth.uid().
      const err = await expectError(() =>
        h.asUser(a, (c) =>
          c.query(
            "insert into public.identity_pub (user_id, public_key) values ($1,$2)",
            [b, pubkey(32)],
          ),
        ),
      );
      expect(err.code).toBe("42501");
    });

    it("identity_pub read: co-membership grants pubkey visibility (discriminates shares_scope)", async () => {
      const a = await h.createUser();
      const b = await h.createUser();
      await publishPub(a);
      expect(await canReadPub(b, a)).toBe(0); // not sharing a scope → invisible (no global directory)
      await addMember(a, b, "editor"); // now B co-inhabits A's scope
      expect(await canReadPub(b, a)).toBe(1); // B can now read A's pubkey (to be wrapped to)
    });

    it("identity_pub: exactly one permissive SELECT policy (advisor 0038)", async () => {
      // 0038 collapsed the FOR ALL owner policy + standalone co-member read into
      // a single SELECT policy, so a read no longer evaluates two permissive
      // policies (multiple_permissive_policies advisor). Writes stay owner-only.
      const rows = await h.asService((c) =>
        c
          .query(
            `select policyname, cmd
               from pg_policies
              where schemaname = 'public' and tablename = 'identity_pub'
              order by policyname`,
          )
          .then((r) => r.rows as Array<{ policyname: string; cmd: string }>),
      );
      // A FOR ALL policy would count toward SELECT too; there must be none, and
      // exactly ONE policy whose command applies to SELECT.
      const selectApplicable = rows.filter(
        (p) => p.cmd === "SELECT" || p.cmd === "ALL",
      );
      expect(selectApplicable.map((p) => p.policyname)).toEqual([
        "identity_pub_read",
      ]);
      // Owner writes are split into dedicated INSERT + UPDATE policies.
      const names = rows.map((p) => p.policyname).sort();
      expect(names).toEqual([
        "identity_pub_insert",
        "identity_pub_read",
        "identity_pub_update",
      ]);
    });

    it("identity_pub: the unused updated_at index is dropped (advisor 0040)", async () => {
      // identity_pub is publish-only (upsert by user_id, read by exact user_id),
      // never scanned by updated_at, so 0040 dropped idx_identity_pub_updated.
      const rows = await h.asService((c) =>
        c
          .query(
            `select indexname from pg_indexes
              where schemaname = 'public' and tablename = 'identity_pub'`,
          )
          .then((r) => r.rows as Array<{ indexname: string }>),
      );
      const names = rows.map((r) => r.indexname);
      expect(names).not.toContain("idx_identity_pub_updated");
    });

    it("identity_pub: an oversized public key is rejected (anti-abuse cap)", async () => {
      const a = await h.createUser();
      // base64 of 512 raw bytes is ~684 chars > the 512-char text cap → rejected.
      const err = await expectError(() => publishPub(a, 512));
      expect(err.code).toBe("23514"); // check_violation
    });

    it("scope_keys: a member reads only their OWN wrap", async () => {
      const a = await h.createUser();
      const b = await h.createUser();
      await addMember(a, b, "editor");
      // A (admin of own scope) writes its own self-wrap AND a wrap for B.
      await h.asUser(a, (c) =>
        c.query(
          "insert into public.scope_keys (member_user_id, wrapped_dek) values ($1,'wa')",
          [a],
        ),
      );
      await h.asUser(a, (c) =>
        c.query(
          "insert into public.scope_keys (scope_id, author_id, member_user_id, wrapped_dek) values ($1,$1,$2,'wb')",
          [a, b],
        ),
      );
      // A sees only its own wrap (member_user_id = A), not B's.
      const seenByA = await h.asUser(a, (c) =>
        c
          .query("select member_user_id from public.scope_keys")
          .then((r) => r.rows.map((x) => x.member_user_id)),
      );
      expect(seenByA).toEqual([a]);
      // B sees only its own wrap (member_user_id = B).
      const seenByB = await h.asUser(b, (c) =>
        c
          .query("select member_user_id from public.scope_keys")
          .then((r) => r.rows.map((x) => x.member_user_id)),
      );
      expect(seenByB).toEqual([b]);
    });

    it("scope_keys: only a scope admin may write wraps (editor + non-member rejected)", async () => {
      const a = await h.createUser();
      const b = await h.createUser();
      const c = await h.createUser();
      await addMember(a, b, "editor");
      // editor B cannot write a wrap in A's scope (scope_role != 'admin').
      const editorErr = await expectError(() =>
        h.asUser(b, (cl) =>
          cl.query(
            "insert into public.scope_keys (scope_id, author_id, member_user_id, wrapped_dek) values ($1,$2,$3,'x')",
            [a, b, b],
          ),
        ),
      );
      expect(editorErr.code).toBe("42501");
      // non-member C cannot write a wrap in A's scope either.
      const nonMemberErr = await expectError(() =>
        h.asUser(c, (cl) =>
          cl.query(
            "insert into public.scope_keys (scope_id, author_id, member_user_id, wrapped_dek) values ($1,$2,$3,'x')",
            [a, c, c],
          ),
        ),
      );
      expect(nonMemberErr.code).toBe("42501");
      // admin A can (behavior-preserving: owner writes own scope's wraps).
      await h.asUser(a, (cl) =>
        cl.query(
          "insert into public.scope_keys (member_user_id, wrapped_dek) values ($1,'ok')",
          [a],
        ),
      );
      const n = await h.asUser(a, (cl) =>
        cl.query("select 1 from public.scope_keys").then((r) => r.rowCount),
      );
      expect(n).toBe(1);
    });

    it("scope_keys: an editor member cannot DELETE a wrap (delete gated to admin)", async () => {
      const a = await h.createUser();
      const b = await h.createUser();
      await addMember(a, b, "editor");
      await h.asUser(a, (cl) =>
        cl.query(
          "insert into public.scope_keys (member_user_id, wrapped_dek) values ($1,'w')",
          [a],
        ),
      );
      // editor B's DELETE matches no row under its USING (scope_role != 'admin') → no-op, wrap survives.
      await h.asUser(b, (cl) =>
        cl.query("delete from public.scope_keys where scope_id=$1", [a]),
      );
      const survived = await h.asUser(a, (cl) =>
        cl.query("select 1 from public.scope_keys").then((r) => r.rowCount),
      );
      expect(survived).toBe(1);
    });

    it("identity_pub: a user cannot modify another user's pubkey row (update-forge is a no-op)", async () => {
      const a = await h.createUser();
      const b = await h.createUser();
      await publishPub(a, 32); // A's key = base64 of 32×0x07
      await addMember(a, b, "editor"); // B can even READ A's key now, but still cannot write it
      // B's UPDATE matches no row under the owner policy USING (user_id = auth.uid()) → no-op.
      await h.asUser(b, (cl) =>
        cl.query(
          "update public.identity_pub set public_key=$1 where user_id=$2",
          [Buffer.alloc(32, 9).toString("base64"), a],
        ),
      );
      const k = await h.client
        .query(
          "select public_key as k from public.identity_pub where user_id=$1",
          [a],
        )
        .then((r) => r.rows[0].k);
      expect(k).toBe(pubkey(32)); // unchanged — still A's original key, not B's 0x09
    });

    it("identity_pub: public_key is stored as base64 text (wire convention, not \\x-hex bytea)", async () => {
      const a = await h.createUser();
      await publishPub(a, 32);
      const k = await h.client
        .query(
          "select public_key as k from public.identity_pub where user_id=$1",
          [a],
        )
        .then((r) => r.rows[0].k);
      expect(typeof k).toBe("string");
      expect(k).toBe(Buffer.alloc(32, 7).toString("base64")); // decodes with Buffer.from(k,'base64')
    });
  },
);
