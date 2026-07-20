import { describe, test, expect, beforeEach } from "vitest";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { ensureProject } from "../src/db";
import * as ltm from "../src/ltm";

const P = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "__tmp_tombstone_by_title__",
);

describe("ltm.findTombstonedByTitle", () => {
  beforeEach(() => {
    ensureProject(P);
  });

  test("false when no entry with the title exists", () => {
    expect(
      ltm.findTombstonedByTitle({ title: "Never existed", projectId: null }),
    ).toBe(false);
  });

  test("true when the only same-title entry in scope is tombstoned", () => {
    const id = ltm.create({
      projectPath: P,
      category: "pattern",
      title: "Deleted concept",
      content: "body",
      scope: "project",
    });
    ltm.remove(id);
    const pid = ensureProject(P);
    expect(
      ltm.findTombstonedByTitle({ title: "Deleted concept", projectId: pid }),
    ).toBe(true);
  });

  test("false when a LIVE same-title entry exists (live takes precedence)", () => {
    // Guard under test: a live current row with this title is an UPDATE target,
    // not a resurrection. Even if a same-title death-cert also exists in scope,
    // the live row must win → findTombstonedByTitle returns false. Removing the
    // `if (live) return false` short-circuit flips this to true.
    const pid = ensureProject(P);

    ltm.create({
      projectPath: P,
      category: "pattern",
      title: "Contested title",
      content: "live body",
      scope: "project",
    });

    const crossId = ltm.create({
      category: "pattern",
      title: "Contested title",
      content: "cross body",
      scope: "global",
      crossProject: true,
    });
    ltm.remove(crossId);

    expect(
      ltm.findTombstonedByTitle({ title: "Contested title", projectId: pid }),
    ).toBe(false);
  });
});
