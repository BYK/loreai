/**
 * END-TO-END integration for the `lore team` orchestration (E-4c-4, #827) against a REAL Postgres +
 * PostgREST: create a team, add a member (group-wrap the DEK to their published key), and remove a
 * member (which ROTATES the scope key — the removed member's wraps are gone and a fresh epoch is
 * wrapped only to the remaining members).
 *
 * Gated behind LORE_INTEGRATION=1 (needs Docker). Run:
 *   LORE_INTEGRATION=1 pnpm exec vitest run packages/gateway/test/team.integration.test.ts
 */
import { execFileSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { db, keystore, setKV, syncData } from "@loreai/core";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { publishIdentityPub } from "../src/sync";
import {
  addTeamMember,
  createTeam,
  removeTeamMember,
  teamMembers,
} from "../src/team";
import { type PgHarness, startPgHarness } from "./helpers/pg-harness";

let mockUid = "";
vi.mock("../src/supabase", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/supabase")>()),
  getCurrentUser: () => Promise.resolve(mockUid ? { user_id: mockUid } : null),
}));

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

const FAST = { t: 1, m: 256, p: 1 } as const;
let h: PgHarness;
let admin: string; // A — team creator/admin
let member: string; // B — the member we add then remove

function clientFor(uid: string): SupabaseClient {
  const jwt = h.userJwt(uid);
  const rewriteFetch = (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    return fetch(url.replace("/rest/v1", ""), init);
  };
  return createClient(h.restUrl as string, jwt, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: { Authorization: `Bearer ${jwt}` },
      fetch: rewriteFetch as unknown as typeof fetch,
    },
  });
}

// Everything local to a "device": the SQLite identity/keys + in-memory keystore, plus any
// content rows a prior test file left in the shared local DB (so createTeam's push is clean).
function wipeLocalIdentity(): void {
  keystore.lock();
  db().exec(
    "DELETE FROM account_identity; DELETE FROM account_escrow; DELETE FROM scope_keys;" +
      " DELETE FROM knowledge; DELETE FROM knowledge_meta; DELETE FROM knowledge_meta_crdt;" +
      " DELETE FROM entity_aliases; DELETE FROM entity_relations; DELETE FROM entities;" +
      " DELETE FROM projects; DELETE FROM sync_outbox; DELETE FROM sync_state;" +
      " DELETE FROM temp._sync_applying",
  );
  for (const m of syncData.syncedTables("basic"))
    setKV(`sync.push.${m.table}`, "0");
}

// ALL wraps on the remote for a scope, as canonical "member:epoch" strings, SORTED for an
// order-independent compare (member ids are random UUIDs, so raw row order is nondeterministic).
// Uses the superuser harness connection: scope_keys_read RLS restricts each member to their OWN
// wrap, so an admin client cannot observe co-members' rows — only the DB owner sees the full set.
async function remoteWraps(scopeId: string): Promise<string[]> {
  return h.client
    .query(
      "select member_user_id, key_epoch from public.scope_keys where scope_id=$1",
      [scopeId],
    )
    .then((r) =>
      r.rows.map((x) => `${x.member_user_id}:${x.key_epoch}`).sort(),
    );
}
// Expected wraps as sorted "member:epoch" strings (mirrors remoteWraps' canonical form).
function wraps(...pairs: [string, number][]): string[] {
  return pairs.map(([m, e]) => `${m}:${e}`).sort();
}

beforeAll(async () => {
  if (SKIP) return;
  h = await startPgHarness({ postgrest: true });
  admin = await h.createUser("team-admin@test.dev");
  member = await h.createUser("team-member@test.dev");
}, 240_000);

afterAll(async () => {
  if (h) await h.stop();
});

beforeEach(() => {
  if (SKIP) return;
  wipeLocalIdentity();
});

describe.skipIf(SKIP)(
  "lore team — create / add / remove-with-rotation (E-4c-4)",
  () => {
    it("create → add member (group-wrap) → remove member (rotate) end-to-end", async () => {
      // --- B publishes its identity public key so an admin can wrap the DEK to it. ---
      mockUid = member;
      keystore.setPassphrase("member pass", { params: FAST });
      await publishIdentityPub(clientFor(member));
      expect(
        await h.client
          .query(
            "select count(*)::int n from public.identity_pub where user_id=$1",
            [member],
          )
          .then((r) => r.rows[0].n),
      ).toBe(1);

      // --- Switch to A's device: fresh identity, sync armed. ---
      wipeLocalIdentity();
      mockUid = admin;
      keystore.setPassphrase("admin pass", { params: FAST });
      syncData.enableSync("basic");
      const aClient = clientFor(admin);

      // create: a team scope + the creator's DEK wrap@0 on the remote.
      const scope = await createTeam(aClient, "Rocket Team");
      expect(scope).toMatch(/^[0-9a-f-]{36}$/);
      expect(
        (await teamMembers(aClient, scope)).find((m) => m.userId === admin)
          ?.role,
      ).toBe("admin");
      expect(await remoteWraps(scope)).toEqual(wraps([admin, 0]));

      // add: B joins and the DEK is wrapped to B's published key.
      const added = await addTeamMember(aClient, scope, member);
      expect(added.wrapped).toBe(true);
      expect(
        (await teamMembers(aClient, scope)).map((m) => m.userId).sort(),
      ).toEqual([admin, member].sort());
      expect(await remoteWraps(scope)).toEqual(wraps([admin, 0], [member, 0]));

      // remove: B is dropped AND the key rotates. B's wraps are gone; a fresh epoch-1 DEK is
      // wrapped only to the remaining member (A). B can no longer read future content.
      const removed = await removeTeamMember(aClient, scope, member);
      expect(removed.newEpoch).toBe(1);
      expect(removed.rewrapped).toBe(1); // only A remains
      expect(removed.skipped).toEqual([]);
      expect((await teamMembers(aClient, scope)).map((m) => m.userId)).toEqual([
        admin,
      ]);
      expect(await remoteWraps(scope)).toEqual(wraps([admin, 0], [admin, 1])); // A holds both epochs; NO B rows
      expect(
        await h.client
          .query("select key_epoch from public.scopes where id=$1", [scope])
          .then((r) => r.rows[0].key_epoch),
      ).toBe(1);
    });

    it("a non-admin cannot add or remove members (42501)", async () => {
      mockUid = member;
      keystore.setPassphrase("member pass", { params: FAST });
      await publishIdentityPub(clientFor(member));
      wipeLocalIdentity();
      mockUid = admin;
      keystore.setPassphrase("admin pass", { params: FAST });
      syncData.enableSync("basic");
      const scope = await createTeam(clientFor(admin), "Editors");
      await addTeamMember(clientFor(admin), scope, member, "editor");

      // B (editor, not admin) attempts to add/remove → the RPC raises 42501, surfaced as a throw.
      mockUid = member;
      const bClient = clientFor(member);
      await expect(
        addTeamMember(bClient, scope, admin, "viewer"),
      ).rejects.toThrow(/add_scope_member/);
      await expect(removeTeamMember(bClient, scope, admin)).rejects.toThrow(
        /remove_scope_member/,
      );
    });
  },
);
