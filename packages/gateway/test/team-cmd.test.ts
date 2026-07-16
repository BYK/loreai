/**
 * Unit coverage for the `lore team` CLI dispatcher (E-4c-4, #827): guards (auth, and
 * encryption+sync for mutating verbs), argument validation, output messages, and error handling.
 * The orchestration (../team) and auth (../supabase) are mocked; the keystore/sync guards are spied.
 */
import { keystore, syncData } from "@loreai/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/supabase", () => ({
  getAuthedClient: vi.fn(),
  getCurrentUser: vi.fn(),
}));
vi.mock("../src/team", () => ({
  createTeam: vi.fn(),
  addTeamMember: vi.fn(),
  removeTeamMember: vi.fn(),
  setTeamRole: vi.fn(),
  listTeams: vi.fn(),
  teamMembers: vi.fn(),
  createTeamInvite: vi.fn(),
  acceptTeamInvite: vi.fn(),
  claimOrgDomain: vi.fn(),
  requestDomainJoin: vi.fn(),
  listDomainJoinRequests: vi.fn(),
  approveDomainJoin: vi.fn(),
  rejectDomainJoin: vi.fn(),
}));

import {
  db,
  effectivePromotionPolicy,
  ensureProject,
  ltm,
  projectScope,
  setProjectScope,
} from "@loreai/core";
import { getAuthedClient, getCurrentUser } from "../src/supabase";
import { commandTeam } from "../src/cli/team-cmd";
import * as team from "../src/team";

const FAKE_CLIENT = { id: "client" } as never;
let logs: string[];
let errs: string[];

async function run(...args: string[]): Promise<void> {
  await commandTeam(args, {});
}

beforeEach(() => {
  vi.clearAllMocks();
  process.exitCode = 0;
  logs = [];
  errs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    logs.push(a.join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    errs.push(a.join(" "));
  });
  vi.mocked(getAuthedClient).mockResolvedValue(FAKE_CLIENT);
  vi.spyOn(keystore, "encryptionState").mockReturnValue("on");
  vi.spyOn(syncData, "isSyncEnabled").mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
});

describe("auth guard", () => {
  it("errors + exits 1 when not logged in (any subcommand)", async () => {
    vi.mocked(getAuthedClient).mockResolvedValue(null);
    await run("list");
    expect(errs.join("\n")).toMatch(/Not logged in/);
    expect(process.exitCode).toBe(1);
    expect(vi.mocked(team.listTeams)).not.toHaveBeenCalled();
  });
});

describe("mutating-verb guards", () => {
  it("blocks when encryption is not unlocked", async () => {
    vi.spyOn(keystore, "encryptionState").mockReturnValue("locked");
    await run("create", "T");
    expect(errs.join("\n")).toMatch(/encryption unlocked/);
    expect(process.exitCode).toBe(1);
    expect(vi.mocked(team.createTeam)).not.toHaveBeenCalled();
  });

  it("blocks when sync is not enabled", async () => {
    vi.spyOn(syncData, "isSyncEnabled").mockReturnValue(false);
    await run("add", "s", "u");
    expect(errs.join("\n")).toMatch(/Sync is not enabled/);
    expect(process.exitCode).toBe(1);
    expect(vi.mocked(team.addTeamMember)).not.toHaveBeenCalled();
  });

  it("does NOT require encryption/sync for read-only list", async () => {
    vi.spyOn(keystore, "encryptionState").mockReturnValue("off");
    vi.spyOn(syncData, "isSyncEnabled").mockReturnValue(false);
    vi.mocked(team.listTeams).mockResolvedValue([]);
    await run("list");
    expect(process.exitCode).toBe(0);
    expect(vi.mocked(team.listTeams)).toHaveBeenCalled();
  });
});

describe("list", () => {
  it("defaults to list when no subcommand is given; prints the empty hint", async () => {
    vi.mocked(team.listTeams).mockResolvedValue([]);
    await run();
    expect(logs.join("\n")).toMatch(/No teams yet/);
  });

  it("prints each team", async () => {
    vi.mocked(team.listTeams).mockResolvedValue([
      { scopeId: "s1", name: "Rockets", role: "admin" },
      { scopeId: "s2", name: "Docs", role: "editor" },
    ]);
    await run("list");
    expect(logs.join("\n")).toContain("s1");
    expect(logs.join("\n")).toContain("Rockets");
    expect(logs.join("\n")).toContain("Docs");
  });
});

describe("members", () => {
  it("requires a scope arg", async () => {
    await run("members");
    expect(errs.join("\n")).toMatch(/Usage: lore team/);
    expect(process.exitCode).toBe(1);
  });

  it("prints members of the scope", async () => {
    vi.mocked(team.teamMembers).mockResolvedValue([
      { userId: "u1", role: "admin" },
      { userId: "u2", role: "viewer" },
    ]);
    await run("members", "s1");
    expect(vi.mocked(team.teamMembers)).toHaveBeenCalledWith(FAKE_CLIENT, "s1");
    expect(logs.join("\n")).toContain("u1  admin");
    expect(logs.join("\n")).toContain("u2  viewer");
  });
});

describe("create", () => {
  it("requires a name", async () => {
    await run("create");
    expect(errs.join("\n")).toMatch(/Usage: lore team/);
    expect(process.exitCode).toBe(1);
  });

  it("creates a team and prints the id (joins a multi-word name)", async () => {
    vi.mocked(team.createTeam).mockResolvedValue("scope-9");
    await run("create", "My", "Team");
    expect(vi.mocked(team.createTeam)).toHaveBeenCalledWith(
      FAKE_CLIENT,
      "My Team",
    );
    expect(logs.join("\n")).toContain('Created team "My Team" (scope-9).');
  });
});

describe("add", () => {
  it("requires scope + userId", async () => {
    await run("add", "s");
    expect(errs.join("\n")).toMatch(/Usage: lore team/);
    expect(process.exitCode).toBe(1);
  });

  it("rejects an invalid role", async () => {
    await run("add", "s", "u", "boss");
    expect(errs.join("\n")).toMatch(/Usage: lore team/);
    expect(vi.mocked(team.addTeamMember)).not.toHaveBeenCalled();
  });

  it("adds with the default editor role and reports the key was shared", async () => {
    vi.mocked(team.addTeamMember).mockResolvedValue({ wrapped: true });
    await run("add", "s", "u");
    expect(vi.mocked(team.addTeamMember)).toHaveBeenCalledWith(
      FAKE_CLIENT,
      "s",
      "u",
      "editor",
    );
    expect(logs.join("\n")).toMatch(/shared the team key/);
  });

  it("warns when the member has not published a key yet", async () => {
    vi.mocked(team.addTeamMember).mockResolvedValue({ wrapped: false });
    await run("add", "s", "u", "viewer");
    expect(vi.mocked(team.addTeamMember)).toHaveBeenCalledWith(
      FAKE_CLIENT,
      "s",
      "u",
      "viewer",
    );
    expect(logs.join("\n")).toMatch(/have not published an encryption key/);
  });
});

describe("remove", () => {
  it("requires scope + userId", async () => {
    await run("remove", "s");
    expect(errs.join("\n")).toMatch(/Usage: lore team/);
    expect(process.exitCode).toBe(1);
  });

  it("reports the rotation", async () => {
    vi.mocked(team.removeTeamMember).mockResolvedValue({
      newEpoch: 3,
      rewrapped: 2,
      skipped: [],
    });
    await run("remove", "s", "u");
    expect(logs.join("\n")).toMatch(
      /rotated the team key to epoch 3 \(2 member/,
    );
    expect(logs.join("\n")).not.toMatch(/Warning/);
  });

  it("warns about members that lost access (no published key)", async () => {
    vi.mocked(team.removeTeamMember).mockResolvedValue({
      newEpoch: 1,
      rewrapped: 1,
      skipped: ["x", "y"],
    });
    await run("remove", "s", "u");
    expect(logs.join("\n")).toMatch(
      /Warning: 2 member\(s\) had no published key/,
    );
    expect(logs.join("\n")).toContain("x, y");
  });
});

describe("set-role", () => {
  it("requires scope + userId + role", async () => {
    await run("set-role", "s", "u");
    expect(errs.join("\n")).toMatch(/Usage: lore team/);
    expect(process.exitCode).toBe(1);
  });

  it("rejects an invalid role", async () => {
    await run("set-role", "s", "u", "boss");
    expect(errs.join("\n")).toMatch(/Usage: lore team/);
    expect(vi.mocked(team.setTeamRole)).not.toHaveBeenCalled();
  });

  it("sets the role", async () => {
    await run("set-role", "s", "u", "admin");
    expect(vi.mocked(team.setTeamRole)).toHaveBeenCalledWith(
      FAKE_CLIENT,
      "s",
      "u",
      "admin",
    );
    expect(logs.join("\n")).toContain("Set u to admin.");
  });
});

describe("invite (E-5-c)", () => {
  it("requires a scope", async () => {
    await run("invite");
    expect(errs.join("\n")).toMatch(/Usage: lore team/);
    expect(process.exitCode).toBe(1);
  });

  it("rejects an invalid role", async () => {
    await commandTeam(["invite", "s"], { role: "admin" });
    expect(errs.join("\n")).toMatch(/Usage: lore team/);
    expect(vi.mocked(team.createTeamInvite)).not.toHaveBeenCalled();
  });

  it("mints an invite (default editor) and prints the accept command", async () => {
    vi.mocked(team.createTeamInvite).mockResolvedValue("tok-abc");
    await commandTeam(["invite", "s-1"], {});
    expect(vi.mocked(team.createTeamInvite)).toHaveBeenCalledWith(
      FAKE_CLIENT,
      "s-1",
      "editor",
      undefined,
      { offline: false },
    );
    expect(logs.join("\n")).toContain("lore team accept tok-abc");
  });

  it("passes --role and --email through to the client", async () => {
    vi.mocked(team.createTeamInvite).mockResolvedValue("tok-xyz");
    await commandTeam(["invite", "s-2"], { role: "viewer", email: "a@b.dev" });
    expect(vi.mocked(team.createTeamInvite)).toHaveBeenCalledWith(
      FAKE_CLIENT,
      "s-2",
      "viewer",
      "a@b.dev",
      { offline: false },
    );
    expect(logs.join("\n")).toMatch(/for a@b.dev/);
  });

  it("passes --offline through and warns the token carries a key", async () => {
    vi.mocked(team.createTeamInvite).mockResolvedValue("tok-abc.SECRET");
    await commandTeam(["invite", "s-3"], { offline: true });
    expect(vi.mocked(team.createTeamInvite)).toHaveBeenCalledWith(
      FAKE_CLIENT,
      "s-3",
      "editor",
      undefined,
      { offline: true },
    );
    expect(logs.join("\n")).toMatch(/one-time decryption key/i);
    expect(logs.join("\n")).toContain("lore team accept tok-abc.SECRET");
  });
});

describe("accept (E-5-c)", () => {
  it("requires a token", async () => {
    await run("accept");
    expect(errs.join("\n")).toMatch(/Usage: lore team/);
    expect(process.exitCode).toBe(1);
  });

  it("redeems the token and reports the joined scope + role", async () => {
    vi.mocked(team.acceptTeamInvite).mockResolvedValue({
      scopeId: "s-9",
      role: "editor",
    });
    await run("accept", "tok-abc");
    expect(vi.mocked(team.acceptTeamInvite)).toHaveBeenCalledWith(
      FAKE_CLIENT,
      "tok-abc",
    );
    expect(logs.join("\n")).toMatch(/Joined team scope s-9 as editor/);
  });
});

describe("domain (E-5-b)", () => {
  it("claim requires org + domain", async () => {
    await run("domain", "claim", "org-1");
    expect(errs.join("\n")).toMatch(/Usage: lore team/);
    expect(process.exitCode).toBe(1);
  });

  it("claim rejects an invalid join role", async () => {
    await commandTeam(["domain", "claim", "org-1", "acme.dev"], {
      role: "admin",
    });
    expect(errs.join("\n")).toMatch(/Usage: lore team/);
    expect(vi.mocked(team.claimOrgDomain)).not.toHaveBeenCalled();
  });

  it("claim passes org/domain/default-role through", async () => {
    await commandTeam(["domain", "claim", "org-1", "acme.dev"], {});
    expect(vi.mocked(team.claimOrgDomain)).toHaveBeenCalledWith(
      FAKE_CLIENT,
      "org-1",
      "acme.dev",
      "member",
    );
    expect(logs.join("\n")).toMatch(/Claimed acme.dev/);
  });

  it("request requires org + domain and reports the request id", async () => {
    vi.mocked(team.requestDomainJoin).mockResolvedValue("req-7");
    await run("domain", "request", "org-1", "acme.dev");
    expect(vi.mocked(team.requestDomainJoin)).toHaveBeenCalledWith(
      FAKE_CLIENT,
      "org-1",
      "acme.dev",
    );
    expect(logs.join("\n")).toContain("req-7");
  });

  it("requests lists pending join requests", async () => {
    vi.mocked(team.listDomainJoinRequests).mockResolvedValue([
      {
        id: "req-1",
        domain: "acme.dev",
        userId: "u-2",
        status: "pending",
        requestedAt: "t",
      },
    ]);
    await run("domain", "requests", "org-1");
    expect(logs.join("\n")).toContain("req-1");
    expect(logs.join("\n")).toContain("u-2");
  });

  it("requests prints a friendly message when there are none", async () => {
    vi.mocked(team.listDomainJoinRequests).mockResolvedValue([]);
    await run("domain", "requests", "org-1");
    expect(logs.join("\n")).toMatch(/No pending join requests/);
  });

  it("approve requires an id and calls approveDomainJoin", async () => {
    await run("domain", "approve", "req-9");
    expect(vi.mocked(team.approveDomainJoin)).toHaveBeenCalledWith(
      FAKE_CLIENT,
      "req-9",
    );
    expect(logs.join("\n")).toMatch(/Approved join request req-9/);
  });

  it("reject calls rejectDomainJoin", async () => {
    await run("domain", "reject", "req-9");
    expect(vi.mocked(team.rejectDomainJoin)).toHaveBeenCalledWith(
      FAKE_CLIENT,
      "req-9",
    );
    expect(logs.join("\n")).toMatch(/Rejected join request req-9/);
  });

  it("an unknown domain verb prints usage", async () => {
    await run("domain", "bogus");
    expect(errs.join("\n")).toMatch(/Usage: lore team/);
    expect(process.exitCode).toBe(1);
  });

  it("does NOT require encryption/sync (org membership only, no DEK)", async () => {
    vi.spyOn(keystore, "encryptionState").mockReturnValue("off");
    vi.spyOn(syncData, "isSyncEnabled").mockReturnValue(false);
    await run("domain", "requests", "org-1");
    // No "run `lore sync enable`" guard fired — the RPC path was reached.
    expect(errs.join("\n")).not.toMatch(/sync enable/);
  });
});

describe("unknown subcommand + errors", () => {
  it("prints usage for an unknown subcommand", async () => {
    await run("bogus");
    expect(errs.join("\n")).toMatch(/Usage: lore team/);
    expect(process.exitCode).toBe(1);
  });

  it("catches an orchestration throw → 'lore team: …' + exit 1", async () => {
    vi.mocked(team.listTeams).mockRejectedValue(new Error("boom"));
    await run("list");
    expect(errs.join("\n")).toMatch(/lore team: boom/);
    expect(process.exitCode).toBe(1);
  });
});

describe("link / unlink (E-5-F3-1)", () => {
  const PROJECT = "/test/f3cli/proj";
  let pid: string;

  beforeEach(() => {
    db().exec("DELETE FROM scopes");
    db().exec("DELETE FROM scope_members");
    pid = ensureProject(PROJECT);
    setProjectScope(pid, null);
    // A team the caller (u1) can write to, in the local registry mirror.
    db()
      .query(
        "INSERT INTO scopes (id, org_id, kind, name, promotion_policy, created_at, updated_at) VALUES ('s9','o1','team','Rockets','manual',0,0)",
      )
      .run();
    db()
      .query(
        "INSERT INTO scope_members (scope_id, user_id, role, created_at, updated_at) VALUES ('s9','u1','editor',0,0)",
      )
      .run();
    vi.mocked(getCurrentUser).mockResolvedValue({ user_id: "u1" } as never);
  });

  it("binds the project to a team resolved by name", async () => {
    await commandTeam(["link", "Rockets"], { project: PROJECT });
    expect(process.exitCode).toBe(0);
    expect(projectScope(pid)).toBe("s9");
    expect(logs.join("\n")).toContain("Rockets");
    expect(logs.join("\n")).toContain("MANUAL"); // manual policy surfaced
  });

  it("unlink clears the binding", async () => {
    setProjectScope(pid, "s9");
    await commandTeam(["unlink"], { project: PROJECT });
    expect(process.exitCode).toBe(0);
    expect(projectScope(pid)).toBeNull();
  });

  it("refuses to link to a team the caller cannot write to (no bind)", async () => {
    db()
      .query("UPDATE scope_members SET role='viewer' WHERE scope_id='s9'")
      .run();
    await commandTeam(["link", "Rockets"], { project: PROJECT });
    expect(process.exitCode).toBe(1);
    expect(projectScope(pid)).toBeNull();
    expect(errs.join("\n")).toMatch(/No team "Rockets" you can write to/);
  });

  it("errors when the directory has no lore project (no bind)", async () => {
    await commandTeam(["link", "Rockets"], { project: "/test/f3cli/absent" });
    expect(process.exitCode).toBe(1);
    expect(errs.join("\n")).toMatch(/No lore project/);
  });

  it("link with no team argument prints usage", async () => {
    await commandTeam(["link"], { project: PROJECT });
    expect(errs.join("\n")).toMatch(/Usage: lore team/);
    expect(process.exitCode).toBe(1);
  });
});

describe("review / approve / reject / policy (E-5-F3-2)", () => {
  const PROJECT = "/test/f3cli2/proj";
  let pid: string;
  let id: string;

  function approvalOf(logicalId: string): string | undefined {
    return (
      db()
        .query(
          "SELECT approval_status FROM knowledge_current WHERE logical_id = ?",
        )
        .get(logicalId) as { approval_status?: string } | undefined
    )?.approval_status;
  }

  beforeEach(() => {
    db().exec("DELETE FROM scopes");
    db().exec("DELETE FROM knowledge");
    db().exec("DELETE FROM knowledge_meta");
    pid = ensureProject(PROJECT);
    db()
      .query(
        "INSERT INTO scopes (id, org_id, kind, name, promotion_policy, created_at, updated_at) VALUES ('sc','o','team','T','manual',0,0)",
      )
      .run();
    setProjectScope(pid, "sc"); // manual policy → new entries land 'pending'
    id = ltm.create({
      projectPath: PROJECT,
      category: "pattern",
      title: "Reviewable",
      content: "c",
      scope: "project",
    });
  });

  it("review lists the pending entry", async () => {
    await commandTeam(["review"], { project: PROJECT });
    expect(process.exitCode).toBe(0);
    expect(logs.join("\n")).toContain(id);
  });

  it("review prints nothing-pending when clear", async () => {
    ltm.approveForTeam(id, "u1");
    await commandTeam(["review"], { project: PROJECT });
    expect(logs.join("\n")).toMatch(/Nothing pending/);
  });

  it("review with an unknown --project errors (does not silently list all)", async () => {
    await commandTeam(["review"], { project: "/test/f3cli2/absent" });
    expect(process.exitCode).toBe(1);
    expect(errs.join("\n")).toMatch(/No lore project/);
  });

  it("approve transitions to approved", async () => {
    await commandTeam(["approve", id], {});
    expect(process.exitCode).toBe(0);
    expect(approvalOf(id)).toBe("approved");
  });

  it("reject transitions to rejected", async () => {
    await commandTeam(["reject", id], {});
    expect(process.exitCode).toBe(0);
    expect(approvalOf(id)).toBe("rejected");
  });

  it("approve an unknown id → error + exit 1", async () => {
    await commandTeam(["approve", "nope"], {});
    expect(process.exitCode).toBe(1);
    expect(errs.join("\n")).toMatch(/No current knowledge entry/);
  });

  it("policy sets the project override", async () => {
    await commandTeam(["policy", "auto"], { project: PROJECT });
    expect(process.exitCode).toBe(0);
    expect(effectivePromotionPolicy(pid)).toBe("auto");
  });

  it("policy with an invalid value → usage + exit 1", async () => {
    await commandTeam(["policy", "bogus"], { project: PROJECT });
    expect(process.exitCode).toBe(1);
    expect(errs.join("\n")).toMatch(/Usage: lore team/);
  });
});
