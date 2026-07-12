import { beforeEach, describe, expect, it } from "vitest";
import {
  db,
  effectivePromotionPolicy,
  ensureProject,
  projectScope,
  resolveWritableScope,
  setProjectScope,
} from "../src/index";
import {
  approveForTeam,
  create,
  listPendingTeamPromotions,
  rejectForTeam,
  update,
} from "../src/ltm";

function approvalOf(logicalId: string): string | undefined {
  return (
    db()
      .query(
        "SELECT approval_status FROM knowledge_current WHERE logical_id = ?",
      )
      .get(logicalId) as { approval_status?: string } | undefined
  )?.approval_status;
}

// E-5-F3-1: producer-side scope selection & team-promotion policy plumbing (behavior-preserving).

function seedScope(
  id: string,
  name: string,
  policy: string,
  kind = "team",
): void {
  db()
    .query(
      "INSERT INTO scopes (id, org_id, kind, name, promotion_policy, created_at, updated_at) VALUES (?,?,?,?,?,0,0)",
    )
    .run(id, "org1", kind, name, policy);
}

function seedMember(scopeId: string, userId: string, role: string): void {
  db()
    .query(
      "INSERT INTO scope_members (scope_id, user_id, role, created_at, updated_at) VALUES (?,?,?,0,0)",
    )
    .run(scopeId, userId, role);
}

beforeEach(() => {
  db().exec("DELETE FROM knowledge");
  db().exec("DELETE FROM knowledge_meta");
  db().exec("DELETE FROM projects");
  db().exec("DELETE FROM scopes");
  db().exec("DELETE FROM scope_members");
});

describe("E-5-F3 scope selection & promotion policy", () => {
  it("projectScope binds and unbinds a project to a team scope", () => {
    const pid = ensureProject("/test/f3/p1");
    expect(projectScope(pid)).toBeNull(); // default: personal
    setProjectScope(pid, "scopeA");
    expect(projectScope(pid)).toBe("scopeA");
    setProjectScope(pid, null);
    expect(projectScope(pid)).toBeNull();
  });

  it("effectivePromotionPolicy precedence: project override > scope default > manual", () => {
    const pid = ensureProject("/test/f3/p2");
    // Unbound project → always manual (never auto-promote without review).
    expect(effectivePromotionPolicy(pid)).toBe("manual");

    // Bound to an auto-policy team → inherits the team default.
    seedScope("s1", "Team One", "auto");
    setProjectScope(pid, "s1");
    expect(effectivePromotionPolicy(pid)).toBe("auto");

    // Project override wins over the team default.
    db()
      .query("UPDATE projects SET promotion_policy='manual' WHERE id=?")
      .run(pid);
    expect(effectivePromotionPolicy(pid)).toBe("manual");

    // A manual-default team with no override → manual.
    setProjectScope(pid, "s1");
    db().query("UPDATE projects SET promotion_policy=NULL WHERE id=?").run(pid);
    db()
      .query("UPDATE scopes SET promotion_policy='manual' WHERE id='s1'")
      .run();
    expect(effectivePromotionPolicy(pid)).toBe("manual");
  });

  it("resolveWritableScope: by id or name, gated on write membership (admin|editor)", () => {
    seedScope("s2", "Rockets", "manual");
    seedMember("s2", "u1", "editor");
    seedMember("s2", "u2", "viewer");

    expect(resolveWritableScope("s2", "u1")?.id).toBe("s2"); // exact id, editor
    expect(resolveWritableScope("Rockets", "u1")?.id).toBe("s2"); // by name
    expect(resolveWritableScope("rockets", "u1")?.id).toBe("s2"); // case-insensitive
    expect(resolveWritableScope("s2", "u2")).toBeNull(); // viewer → not writable
    expect(resolveWritableScope("s2", "u3")).toBeNull(); // non-member
    expect(resolveWritableScope("nope", "u1")).toBeNull(); // unknown ref
  });

  it("resolveWritableScope only matches team scopes by name (not personal)", () => {
    seedScope("p-scope", "Personal", "manual", "personal");
    seedMember("p-scope", "u1", "admin");
    // A personal scope should not be linkable by name.
    expect(resolveWritableScope("Personal", "u1")).toBeNull();
    // But an exact id still resolves (admin is writable) — name-gating is kind='team' only.
    expect(resolveWritableScope("p-scope", "u1")?.id).toBe("p-scope");
  });
});

describe("E-5-F3-2 team-promotion review gate", () => {
  it("create() gates approval_status by the effective policy", () => {
    // Unbound project → 'auto' (legacy/neutral; never team-synced).
    const id1 = create({
      projectPath: "/test/f3gate/personal",
      category: "pattern",
      title: "Personal entry",
      content: "c",
      scope: "project",
    });
    expect(approvalOf(id1)).toBe("auto");

    // Bound to a MANUAL-policy team → new entry is 'pending' (needs review).
    const pid = ensureProject("/test/f3gate/team");
    seedScope("sT", "TeamT", "manual");
    setProjectScope(pid, "sT");
    const id2 = create({
      projectPath: "/test/f3gate/team",
      category: "pattern",
      title: "Manual entry",
      content: "c",
      scope: "project",
    });
    expect(approvalOf(id2)).toBe("pending");

    // Flip the team to AUTO → new entries are 'approved' immediately.
    db().query("UPDATE scopes SET promotion_policy='auto' WHERE id='sT'").run();
    const id3 = create({
      projectPath: "/test/f3gate/team",
      category: "pattern",
      title: "Auto entry",
      content: "c",
      scope: "project",
    });
    expect(approvalOf(id3)).toBe("approved");
  });

  it("approve/reject transitions + listPendingTeamPromotions", () => {
    const pid = ensureProject("/test/f3gate/rev");
    seedScope("sR", "Rev", "manual");
    setProjectScope(pid, "sR");
    const id = create({
      projectPath: "/test/f3gate/rev",
      category: "gotcha",
      title: "Pending Q",
      content: "c",
      scope: "project",
    });
    expect(listPendingTeamPromotions(pid).map((x) => x.logicalId)).toContain(
      id,
    );

    expect(approveForTeam(id, "u1")).toBe(true);
    expect(approvalOf(id)).toBe("approved");
    expect(listPendingTeamPromotions(pid)).toHaveLength(0);

    const id2 = create({
      projectPath: "/test/f3gate/rev",
      category: "gotcha",
      title: "Rejected R",
      content: "c",
      scope: "project",
    });
    expect(rejectForTeam(id2)).toBe(true);
    expect(approvalOf(id2)).toBe("rejected");

    // Unknown id → false, no throw.
    expect(approveForTeam("nope")).toBe(false);
    expect(rejectForTeam("nope")).toBe(false);
  });

  it("approval survives a content edit (appendVersion copies it forward)", () => {
    const pid = ensureProject("/test/f3gate/edit");
    seedScope("sE", "Edit", "manual");
    setProjectScope(pid, "sE");
    const id = create({
      projectPath: "/test/f3gate/edit",
      category: "pattern",
      title: "Editable",
      content: "c",
      scope: "project",
    });
    expect(approveForTeam(id, "u1")).toBe(true);
    update(id, { content: "new content" }); // appends a new immutable version
    expect(approvalOf(id)).toBe("approved");
  });

  it("review queue surfaces pre-existing 'auto' entries once linked, never personal knowledge", () => {
    // Created BEFORE linking → 'auto', in an unbound project.
    const pid = ensureProject("/test/f3gate/preexisting");
    const legacyId = create({
      projectPath: "/test/f3gate/preexisting",
      category: "pattern",
      title: "Legacy entry",
      content: "c",
      scope: "project",
    });
    expect(approvalOf(legacyId)).toBe("auto");
    expect(listPendingTeamPromotions(pid)).toHaveLength(0); // project not bound yet

    // A separate, unbound personal project's entry must NEVER be reviewable.
    const personalPid = ensureProject("/test/f3gate/personal2");
    const personalId = create({
      projectPath: "/test/f3gate/personal2",
      category: "pattern",
      title: "Personal entry 2",
      content: "c",
      scope: "project",
    });

    // Link the first project → its legacy 'auto' entry is now reviewable.
    seedScope("sL", "Linked", "manual");
    setProjectScope(pid, "sL");
    expect(listPendingTeamPromotions(pid).map((x) => x.logicalId)).toContain(
      legacyId,
    );
    // The still-unbound personal project surfaces nothing.
    expect(listPendingTeamPromotions(personalPid)).toHaveLength(0);
    expect(listPendingTeamPromotions().map((x) => x.logicalId)).not.toContain(
      personalId,
    );
  });

  it("effective policy 'auto' via a project override auto-approves even under a manual team", () => {
    const pid = ensureProject("/test/f3gate/override");
    seedScope("sO", "Override", "manual"); // team default = manual
    setProjectScope(pid, "sO");
    db()
      .query("UPDATE projects SET promotion_policy='auto' WHERE id=?")
      .run(pid);
    const id = create({
      projectPath: "/test/f3gate/override",
      category: "pattern",
      title: "Override entry",
      content: "c",
      scope: "project",
    });
    expect(approvalOf(id)).toBe("approved");
  });
});
