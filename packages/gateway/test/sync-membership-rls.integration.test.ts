/**
 * Integration tests for migration 0024 — membership-based RLS (E-2, #827) against a real
 * Postgres. Proves the content-table scope predicate is now `is_member(scope_id)`:
 *  - personal isolation is preserved (a non-member sees nothing) — the behavior-preserving side;
 *  - a scope_members row makes another user see the content (the DISCRIMINATING side — this
 *    would fail under the old `scope_id = auth.uid()` predicate), i.e. team sharing works;
 *  - cross-scope write forgery is rejected by WITH CHECK;
 *  - the pro insert gate now reads effective_tier(scope_id) (still the caller's own tier for a
 *    personal scope), while pulling stays open to any member.
 *
 * Gated behind LORE_INTEGRATION=1 (needs Docker). Run:
 *   LORE_INTEGRATION=1 pnpm exec vitest run packages/gateway/test/sync-membership-rls.integration.test.ts
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

const addKnowledge = (uid: string, id: string) =>
  h.asUser(uid, (c) =>
    c.query(
      "insert into public.knowledge (id, category, title, content) values ($1,'p','T','C')",
      [id],
    ),
  );
const seesKnowledge = (uid: string) =>
  h.asUser(uid, (c) =>
    c.query("select id from public.knowledge").then((r) => r.rowCount),
  );

describe.skipIf(gate())("0024 membership RLS (E-2, #827)", () => {
  it("personal isolation preserved: a non-member sees none of another user's content", async () => {
    const a = await h.createUser();
    const b = await h.createUser();
    await addKnowledge(a, "k-iso");
    expect(await seesKnowledge(a)).toBe(1); // owner still sees own
    expect(await seesKnowledge(b)).toBe(0); // non-member sees nothing
  });

  it("a scope_members row grants visibility — team sharing works (discriminates is_member vs scope_id=auth.uid)", async () => {
    const a = await h.createUser();
    const b = await h.createUser();
    await addKnowledge(a, "k-shared");
    expect(await seesKnowledge(b)).toBe(0); // before: not a member
    // Make B a member of A's (personal) scope. Under the OLD `scope_id = auth.uid()` predicate
    // this would change nothing (scope_id = A ≠ B); under is_member it grants B visibility.
    await h.client.query(
      "insert into public.scope_members (scope_id, user_id, role) values ($1,$2,'editor')",
      [a, b],
    );
    expect(await seesKnowledge(b)).toBe(1); // after: member sees A's content
  });

  it("cross-scope write forgery is rejected by WITH CHECK is_member", async () => {
    const a = await h.createUser();
    const b = await h.createUser();
    // B (not a member of A's scope) tries to write a row owned by A's scope.
    const err = await expectError(() =>
      h.asUser(b, (c) =>
        c.query(
          "insert into public.knowledge (id, scope_id, category, title, content) values ('k-forge',$1,'p','T','C')",
          [a],
        ),
      ),
    );
    expect(err.code).toBe("42501"); // RLS WITH CHECK violation
    expect(err.message).toMatch(/row-level security/i);
  });

  it("an editor member can WRITE to a scope they belong to (write-side of membership)", async () => {
    const a = await h.createUser();
    const b = await h.createUser();
    // b becomes an editor of a's scope.
    await h.client.query(
      "insert into public.scope_members (scope_id, user_id, role) values ($1,$2,'editor')",
      [a, b],
    );
    // b writes a row owned by a's scope, authored by b. Under the old `scope_id = auth.uid()`
    // predicate this would be rejected (scope_id = a ≠ b); under is_member it is allowed.
    await h.asUser(b, (c) =>
      c.query(
        "insert into public.knowledge (id, scope_id, category, title, content) values ('k-ed',$1,'p','T','C')",
        [a],
      ),
    );
    expect(await seesKnowledge(a)).toBe(1); // owner sees the member's contribution
  });

  it("author_id forgery is rejected even within one's own scope", async () => {
    const a = await h.createUser();
    const b = await h.createUser();
    // a writes into a's OWN scope but forges author_id = b → WITH CHECK author_id = auth.uid() fails.
    const err = await expectError(() =>
      h.asUser(a, (c) =>
        c.query(
          "insert into public.knowledge (id, scope_id, author_id, category, title, content) values ('k-fa',$1,$2,'p','T','C')",
          [a, b],
        ),
      ),
    );
    expect(err.code).toBe("42501");
    expect(err.message).toMatch(/row-level security/i);
  });

  it("distillations are isolated cross-tenant: a non-member cannot SELECT another scope's distillations", async () => {
    const a = await h.createUser();
    const b = await h.createUser();
    await h.asService((c) =>
      c.query("update public.profiles set tier='pro' where id=$1", [a]),
    );
    await h.asUser(a, (c) =>
      c.query("insert into public.distillations (id) values ('d-iso')"),
    );
    const seenByB = await h.asUser(b, (c) =>
      c.query("select id from public.distillations").then((r) => r.rowCount),
    );
    expect(seenByB).toBe(0);
  });

  it("pro insert gate uses effective_tier(scope_id): free rejected, pro allowed; pull stays open", async () => {
    const uid = await h.createUser();
    // free tier → distillation write blocked by WITH CHECK effective_tier='pro'.
    const blocked = await expectError(() =>
      h.asUser(uid, (c) =>
        c.query("insert into public.distillations (id) values ('d-free')"),
      ),
    );
    expect(blocked.code).toBe("42501");
    // upgrade to pro (service_role sets profiles.tier) → write allowed.
    await h.asService((c) =>
      c.query("update public.profiles set tier='pro' where id=$1", [uid]),
    );
    await h.asUser(uid, (c) =>
      c.query("insert into public.distillations (id) values ('d-pro')"),
    );
    // downgrade back to free → the row is still PULLABLE (USING is_member, no tier gate).
    await h.asService((c) =>
      c.query("update public.profiles set tier='free' where id=$1", [uid]),
    );
    const pullable = await h.asUser(uid, (c) =>
      c.query("select id from public.distillations").then((r) => r.rowCount),
    );
    expect(pullable).toBe(1);
  });
});
