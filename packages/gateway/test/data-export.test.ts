/**
 * Tests for `lore data export` — regenerates .lore.md / AGENTS.md from the
 * current DB for a project, on demand. Used to reconcile a drifted file (e.g.
 * stale entries that consolidation/tombstones removed from the DB but still
 * linger in a committed .lore.md / AGENTS.md) without waiting for the idle
 * exporter or running a destructive `clear`.
 *
 * Config is pinned explicitly per test (via a written .lore.json) rather than
 * relying on defaults, so the tests don't silently change meaning if defaults
 * move, and so every loreFile/agentsFile combination is covered.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load, ltm } from "@loreai/core";
import { commandData } from "../src/cli/data";

let projectDir: string;

/** Write a .lore.json with the given overrides and load it into config. */
async function setConfig(overrides: Record<string, unknown>): Promise<void> {
  writeFileSync(
    join(projectDir, ".lore.json"),
    JSON.stringify(overrides),
    "utf8",
  );
  await load(projectDir);
}

function seed(title: string, content = "x"): string {
  return ltm.create({
    projectPath: projectDir,
    category: "decision",
    title,
    content,
    scope: "project",
  });
}

const loreFilePath = () => join(projectDir, ".lore.md");
const agentsFilePath = () => join(projectDir, "AGENTS.md");
const read = (p: string) => readFileSync(p, "utf8");

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "lore-export-"));
});

afterEach(async () => {
  rmSync(projectDir, { recursive: true, force: true });
  // Reset global config so other suites aren't affected by our overrides.
  await load(process.cwd());
});

describe("lore data export — default config (.lore.md + AGENTS.md pointer)", () => {
  beforeEach(async () => {
    await setConfig({
      loreFile: { enabled: true },
      agentsFile: { enabled: true },
    });
  });

  test("regenerates .lore.md + AGENTS.md pointer from the DB", async () => {
    seed("Export A", "first");
    seed("Export B", "second");

    await commandData(["export"], { project: projectDir });

    expect(existsSync(loreFilePath())).toBe(true);
    const lore = read(loreFilePath());
    expect(lore).toContain("Export A");
    expect(lore).toContain("Export B");
    expect(existsSync(agentsFilePath())).toBe(true);
    expect(read(agentsFilePath())).toContain(".lore.md");
  });

  test("excludes entries deleted via remove() (tombstoned)", async () => {
    const keep = seed("Keep", "stays");
    const drop = seed("Drop", "removed");
    ltm.remove(drop);

    await commandData(["export"], { project: projectDir });

    const lore = read(loreFilePath());
    expect(lore).toContain("Keep");
    expect(lore).not.toContain("Drop");
    expect(ltm.get(keep)).not.toBeNull();
  });

  test("at 0 entries: removes .lore.md AND strips the AGENTS.md pointer (no dangling link)", async () => {
    const id = seed("Temp");
    await commandData(["export"], { project: projectDir });
    expect(existsSync(loreFilePath())).toBe(true);
    expect(read(agentsFilePath())).toContain(".lore.md");

    ltm.remove(id);
    await commandData(["export"], { project: projectDir });

    // .lore.md gone, and the AGENTS.md pointer to it must not survive.
    expect(existsSync(loreFilePath())).toBe(false);
    if (existsSync(agentsFilePath())) {
      expect(read(agentsFilePath())).not.toContain(".lore.md");
    }
  });

  test("preserves user content in AGENTS.md when stripping the lore section at 0 entries", async () => {
    const id = seed("Temp");
    // Pre-seed AGENTS.md with user content, then export to add the lore pointer.
    writeFileSync(
      agentsFilePath(),
      "# My Project\n\nHand-written notes.\n",
      "utf8",
    );
    await commandData(["export"], { project: projectDir });
    expect(read(agentsFilePath())).toContain(".lore.md");

    ltm.remove(id);
    await commandData(["export"], { project: projectDir });

    const agents = read(agentsFilePath());
    expect(agents).toContain("Hand-written notes.");
    expect(agents).not.toContain(".lore.md");
  });
});

describe("lore data export — agentsFile-only (inline) config", () => {
  beforeEach(async () => {
    await setConfig({
      loreFile: { enabled: false },
      agentsFile: { enabled: true },
    });
  });

  test("writes the inline knowledge section into AGENTS.md (no .lore.md)", async () => {
    seed("Inline entry", "body");
    await commandData(["export"], { project: projectDir });

    expect(existsSync(loreFilePath())).toBe(false);
    expect(existsSync(agentsFilePath())).toBe(true);
    expect(read(agentsFilePath())).toContain("Inline entry");
  });

  test("at 0 entries: strips the stale inline section from AGENTS.md", async () => {
    const id = seed("Inline entry", "body");
    writeFileSync(agentsFilePath(), "# Notes\n\nKeep me.\n", "utf8");
    await commandData(["export"], { project: projectDir });
    expect(read(agentsFilePath())).toContain("Inline entry");

    ltm.remove(id);
    await commandData(["export"], { project: projectDir });

    const agents = read(agentsFilePath());
    expect(agents).toContain("Keep me.");
    expect(agents).not.toContain("Inline entry");
  });
});

describe("lore data export — both files disabled", () => {
  test("writes nothing", async () => {
    await setConfig({
      loreFile: { enabled: false },
      agentsFile: { enabled: false },
    });
    seed("Nowhere");
    await commandData(["export"], { project: projectDir });
    expect(existsSync(loreFilePath())).toBe(false);
    expect(existsSync(agentsFilePath())).toBe(false);
  });
});
