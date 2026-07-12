import { beforeEach, describe, expect, it } from "vitest";
import {
  db,
  effectivePromotionPolicy,
  ensureProject,
  projectScope,
  resolveWritableScope,
  setProjectScope,
} from "../src/index";

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
