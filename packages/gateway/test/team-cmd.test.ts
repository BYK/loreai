/**
 * Unit coverage for the `lore team` CLI dispatcher (E-4c-4, #827): guards (auth, and
 * encryption+sync for mutating verbs), argument validation, output messages, and error handling.
 * The orchestration (../team) and auth (../supabase) are mocked; the keystore/sync guards are spied.
 */
import { keystore, syncData } from "@loreai/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/supabase", () => ({ getAuthedClient: vi.fn() }));
vi.mock("../src/team", () => ({
  createTeam: vi.fn(),
  addTeamMember: vi.fn(),
  removeTeamMember: vi.fn(),
  setTeamRole: vi.fn(),
  listTeams: vi.fn(),
  teamMembers: vi.fn(),
}));

import { getAuthedClient } from "../src/supabase";
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
