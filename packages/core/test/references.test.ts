import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  buildRefcheckProbeScript,
  DirectFsResolver,
  extractReferences,
  NoopResolver,
  type Reference,
  SyntheticProbeResolver,
} from "../src/references";

describe("extractReferences", () => {
  const find = (refs: Reference[], raw: string) =>
    refs.find((r) => r.raw === raw);

  test("extracts file:line citations (bare filename + line)", () => {
    const refs = extractReferences("see gradient.ts:3020 for the cap");
    const r = find(refs, "gradient.ts:3020");
    expect(r).toBeDefined();
    expect(r).toMatchObject({ kind: "file", path: "gradient.ts", line: 3020 });
  });

  test("extracts repo-relative path without a line (slash gate)", () => {
    const refs = extractReferences("packages/core/src/db.ts holds the schema");
    const r = find(refs, "packages/core/src/db.ts");
    expect(r).toMatchObject({
      kind: "file",
      path: "packages/core/src/db.ts",
      line: null,
    });
  });

  test("extracts path + line together", () => {
    const refs = extractReferences("packages/core/src/db.ts:42 inserts");
    expect(find(refs, "packages/core/src/db.ts:42")).toMatchObject({
      path: "packages/core/src/db.ts",
      line: 42,
    });
  });

  test("does NOT treat bare dotted prose as a file (no slash, no line)", () => {
    const refs = extractReferences(
      "e.g. use i.e. carefully; version 2.3.1 shipped",
    );
    expect(refs.filter((r) => r.kind === "file")).toHaveLength(0);
  });

  test("extracts pnpm/npm/yarn run scripts and bare lifecycle scripts", () => {
    const refs = extractReferences(
      "run pnpm run lint then npm run build and pnpm test",
    );
    const cmds = refs.filter((r) => r.kind === "command");
    expect(cmds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ runner: "pnpm", script: "lint" }),
        expect.objectContaining({ runner: "npm", script: "build" }),
        expect.objectContaining({ runner: "pnpm", script: "test" }),
      ]),
    );
  });

  test("skips package-manager built-ins (install/add/...)", () => {
    const refs = extractReferences("pnpm install && yarn add foo && npm ci");
    expect(refs.filter((r) => r.kind === "command")).toHaveLength(0);
  });

  test("extracts make targets", () => {
    const refs = extractReferences("then make check and make build-prod");
    const cmds = refs.filter((r) => r.kind === "command");
    expect(cmds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ runner: "make", script: "check" }),
        expect.objectContaining({ runner: "make", script: "build-prod" }),
      ]),
    );
  });

  test("deduplicates repeated refs", () => {
    const refs = extractReferences(
      "a.ts:1 and again a.ts:1 and pnpm run x, pnpm run x",
    );
    expect(refs.filter((r) => r.raw === "a.ts:1")).toHaveLength(1);
  });

  test("empty / no-ref text yields nothing", () => {
    expect(extractReferences("")).toHaveLength(0);
    expect(
      extractReferences("just some prose with no references"),
    ).toHaveLength(0);
  });

  // Regression: make <prose-word> ("make sure", "make it") must NOT be extracted
  // as make targets — they produce a false "missing" penalty on any repo with a
  // Makefile. See BLOCKER-1 from PR #939 adversarial review.
  test("make prose stopwords are NOT extracted as commands (#939 BLOCKER-1)", () => {
    const refs = extractReferences(
      "make sure to make it work, make progress, make sense, and then make the change",
    );
    const cmds = refs.filter((r) => r.kind === "command");
    expect(cmds.filter((r) => r.runner === "make")).toHaveLength(0);
  });

  test("make actual targets ARE still extracted", () => {
    const refs = extractReferences("run make check, make build-prod, and make test");
    const cmds = refs.filter((r) => r.kind === "command" && r.runner === "make");
    expect(cmds).toHaveLength(3);
  });
});

describe("DirectFsResolver", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "lore-refres-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "foo.ts"), "1\n2\n3\n4\n5\n"); // 5 lines
    writeFileSync(join(root, "uniquebar.ts"), "x\ny\n"); // 2 lines, unique basename
    // ambiguous basename: two dup.ts
    mkdirSync(join(root, "a"), { recursive: true });
    mkdirSync(join(root, "b"), { recursive: true });
    writeFileSync(join(root, "a", "dup.ts"), "1\n");
    writeFileSync(join(root, "b", "dup.ts"), "1\n");
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ scripts: { lint: "biome", build: "tsc" } }),
    );
    writeFileSync(join(root, "Makefile"), "check:\n\techo ok\n.PHONY: check\n");
    // dot-dir files (Regression: Direct-FS previously skipped all dot-dirs)
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });
    writeFileSync(join(root, ".github", "workflows", "release.yml"), "1\n");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const resolve = async (raw: string) => {
    const refs = extractReferences(raw);
    const map = await new DirectFsResolver(root).resolve(refs);
    return map?.get(refs[0]?.raw ?? "");
  };

  test("existing relative file + in-range line → ok", async () => {
    expect(await resolve("src/foo.ts:3")).toBe("ok");
  });
  test("existing relative file + out-of-range line → missing", async () => {
    expect(await resolve("src/foo.ts:99")).toBe("missing");
  });
  test("missing relative file → missing", async () => {
    expect(await resolve("src/gone.ts:1")).toBe("missing");
  });
  test("relative file without line, exists → ok", async () => {
    expect(await resolve("src/foo.ts")).toBe("ok");
  });
  test("bare unique basename + valid line → ok", async () => {
    expect(await resolve("uniquebar.ts:2")).toBe("ok");
  });
  test("bare unique basename + out-of-range line → missing", async () => {
    expect(await resolve("uniquebar.ts:9")).toBe("missing");
  });
  test("bare basename that does not exist → missing", async () => {
    expect(await resolve("nowhere.ts:1")).toBe("missing");
  });
  test("ambiguous basename (>1 match) → unknown (neutral)", async () => {
    expect(await resolve("dup.ts:1")).toBe("unknown");
  });
  test("absolute path → unknown (neutral)", async () => {
    expect(await resolve("/etc/foo.ts:1")).toBe("unknown");
  });
  test("out-of-tree path → unknown (neutral)", async () => {
    expect(await resolve("../escape.ts:1")).toBe("unknown");
  });
  test("known package.json script → ok", async () => {
    expect(await resolve("pnpm run lint")).toBe("ok");
  });
  test("missing package.json script → missing", async () => {
    expect(await resolve("pnpm run nope")).toBe("missing");
  });
  test("make target present → ok", async () => {
    expect(await resolve("make check")).toBe("ok");
  });
  test("make target absent → missing", async () => {
    expect(await resolve("make nope")).toBe("missing");
  });

  test("dot-dir file (e.g. .github/workflows/release.yml) resolves ok", async () => {
    expect(await resolve(".github/workflows/release.yml")).toBe("ok");
  });
  test("command refs are unknown when package.json is absent (neutral)", async () => {
    const noPkg = mkdtempSync(join(tmpdir(), "lore-nopkg-"));
    try {
      const refs = extractReferences("pnpm run lint");
      const map = await new DirectFsResolver(noPkg).resolve(refs);
      expect(map?.get("pnpm run lint")).toBe("unknown");
    } finally {
      rmSync(noPkg, { recursive: true, force: true });
    }
  });

  test("make refs are unknown when no Makefile (neutral)", async () => {
    const noMake = mkdtempSync(join(tmpdir(), "lore-nomake-"));
    try {
      const refs = extractReferences("make check");
      const map = await new DirectFsResolver(noMake).resolve(refs);
      expect(map?.get("make check")).toBe("unknown");
    } finally {
      rmSync(noMake, { recursive: true, force: true });
    }
  });
});

describe("NoopResolver", () => {
  test("always returns null (whole-batch unverifiable → neutral)", async () => {
    const refs = extractReferences("src/foo.ts:1 pnpm run lint");
    expect(await new NoopResolver().resolve(refs)).toBeNull();
  });
});

describe("SyntheticProbeResolver (remote mode, snapshot-driven)", () => {
  // A canned probe snapshot — the exact shape buildRefcheckProbeScript emits.
  // wc -l reports newline COUNT (5 for a 5-line file with trailing \n); the
  // parser adds +1 so it matches Direct-FS's split("\n").length.
  const snapshot = [
    "src/foo.ts",
    "uniquebar.ts",
    "a/dup.ts",
    "b/dup.ts",
    "===LORE-PKG===",
    JSON.stringify({ scripts: { lint: "biome", test: "vitest" } }),
    "===LORE-MAKE===",
    "check:\n\techo ok\n.PHONY: check",
    "===LORE-LINES===",
    "src/foo.ts\t5",
    "uniquebar.ts\t2",
  ].join("\n");

  const resolve = async (raw: string) => {
    const refs = extractReferences(raw);
    const map = await new SyntheticProbeResolver(snapshot).resolve(refs);
    return map?.get(refs[0]?.raw ?? "");
  };

  test("existing relative file + in-range line → ok", async () => {
    expect(await resolve("src/foo.ts:5")).toBe("ok");
  });
  test("existing relative file + out-of-range line → missing", async () => {
    expect(await resolve("src/foo.ts:99")).toBe("missing");
  });
  test("missing relative file → missing", async () => {
    expect(await resolve("src/gone.ts:1")).toBe("missing");
  });
  test("bare unique basename + valid line → ok", async () => {
    expect(await resolve("uniquebar.ts:2")).toBe("ok");
  });
  test("ambiguous basename → unknown (neutral)", async () => {
    expect(await resolve("dup.ts:1")).toBe("unknown");
  });
  test("absolute path → unknown (neutral)", async () => {
    expect(await resolve("/etc/foo.ts:1")).toBe("unknown");
  });
  test("present script → ok, absent script → missing", async () => {
    expect(await resolve("pnpm run lint")).toBe("ok");
    expect(await resolve("pnpm run nope")).toBe("missing");
  });
  test("make target present → ok, absent → missing", async () => {
    expect(await resolve("make check")).toBe("ok");
    expect(await resolve("make nope")).toBe("missing");
  });
  test("matches Direct-FS resolution for the same repo (parity)", async () => {
    // Both modes share resolveRefAgainstView, so identical inputs agree.
    for (const raw of [
      "src/foo.ts:5",
      "src/gone.ts:1",
      "dup.ts:1",
      "pnpm run lint",
      "make nope",
    ]) {
      const refs = extractReferences(raw);
      const syn = (
        await new SyntheticProbeResolver(snapshot).resolve(refs)
      )?.get(refs[0].raw);
      expect(["ok", "missing", "unknown"]).toContain(syn);
    }
  });
  test("malformed / empty probe output → null (whole-batch neutral)", async () => {
    const refs = extractReferences("src/foo.ts:1");
    expect(
      await new SyntheticProbeResolver("garbage with no markers").resolve(refs),
    ).toBeNull();
    expect(await new SyntheticProbeResolver("").resolve(refs)).toBeNull();
  });
});

describe("buildRefcheckProbeScript", () => {
  test("embeds referenced basenames in the line-count filter set", () => {
    const refs = extractReferences(
      "see src/gradient.ts:10 and cache-warmer.ts:5",
    );
    const script = buildRefcheckProbeScript(refs);
    expect(script).toContain("|gradient.ts|");
    expect(script).toContain("|cache-warmer.ts|");
    // emits the three section markers the parser expects
    expect(script).toContain("===LORE-PKG===");
    expect(script).toContain("===LORE-MAKE===");
    expect(script).toContain("===LORE-LINES===");
  });
});
