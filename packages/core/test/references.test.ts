import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  buildRefcheckProbeScript,
  DirectFsResolver,
  extractReferences,
  NoopResolver,
  parseProbeSnapshot,
  type Reference,
  type RepoView,
  resolveRefAgainstView,
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

  test("extracts backticked pnpm/npm/yarn run scripts and bare lifecycle scripts", () => {
    const refs = extractReferences(
      "run `pnpm run lint` then `npm run build` and `pnpm test`",
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
    const refs = extractReferences(
      "`pnpm install` && `yarn add foo` && `npm ci`",
    );
    expect(refs.filter((r) => r.kind === "command")).toHaveLength(0);
  });

  test("extracts backticked make targets", () => {
    const refs = extractReferences("then `make check` and `make build-prod`");
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
      "`a.ts:1` and again a.ts:1 and `pnpm run lint`, `pnpm run lint`",
    );
    expect(refs.filter((r) => r.raw === "a.ts:1")).toHaveLength(1);
    expect(refs.filter((r) => r.raw === "pnpm run lint")).toHaveLength(1);
  });

  test("empty / no-ref text yields nothing", () => {
    expect(extractReferences("")).toHaveLength(0);
    expect(
      extractReferences("just some prose with no references"),
    ).toHaveLength(0);
  });

  // Regression (#939 MUST-FIX, adversarial review): command runners `make` and
  // `yarn` are common English words. Un-backticked prose must NEVER be extracted
  // as a command — on a repo with a Makefile / package.json those words resolve
  // "missing" and falsely penalize valid prose entries (violates the
  // load-bearing invariant). A stopword denylist can't enumerate English, so
  // extraction is gated on backtick code spans instead.
  test("make-prose is NOT extracted as a command (open-set words, no Makefile needed)", () => {
    const refs = extractReferences(
      "we make decisions and make assumptions, make tradeoffs, make mistakes, " +
        "make progress, make sure to make it work, then make the change",
    );
    expect(refs.filter((r) => r.kind === "command")).toHaveLength(0);
  });

  test("yarn-prose is NOT extracted as a command", () => {
    const refs = extractReferences(
      "let me yarn about the architecture for a bit",
    );
    expect(refs.filter((r) => r.kind === "command")).toHaveLength(0);
  });

  test("bare prose pnpm/npm mentions (no backticks) are NOT extracted", () => {
    const refs = extractReferences("run pnpm run lint then npm run build");
    expect(refs.filter((r) => r.kind === "command")).toHaveLength(0);
  });

  test("backticked make/yarn actual targets ARE still extracted", () => {
    const refs = extractReferences(
      "run `make check`, `make build-prod`, and `yarn build`",
    );
    const cmds = refs.filter((r) => r.kind === "command");
    expect(cmds).toHaveLength(3);
  });

  // Regression (#939 re-review): commands are matched PER LINE, so a runner in
  // one backtick span must not fuse with a token in an ADJACENT span (the
  // command regexes use `\s+` and `\n` is whitespace). `make`+`Makefile` and
  // `npm`+`yarn` previously fabricated phantom commands (`make Makefile`,
  // `npm yarn`) that then resolved "missing" → false penalty.
  test("adjacent backtick spans do NOT fuse into a phantom command", () => {
    expect(
      extractReferences("The `make` command reads the `Makefile`.").filter(
        (r) => r.kind === "command",
      ),
    ).toHaveLength(0);
    expect(
      extractReferences("Use `npm` or `yarn` for installs.").filter(
        (r) => r.kind === "command",
      ),
    ).toHaveLength(0);
  });

  test("separate lines inside one fenced span do NOT fuse", () => {
    // `make` and `check` on separate lines must not become `make check`.
    const refs = extractReferences("```\nmake\ncheck\n```");
    expect(refs.filter((r) => r.kind === "command")).toHaveLength(0);
  });

  // Regression (#939 MUST-FIX): bare/relative URLs match FILE_CAND_RE via their
  // `/` and would resolve "missing" on every repo. A path whose first segment
  // looks like a DNS host must be rejected.
  test("bare-domain URLs are NOT extracted as file refs", () => {
    const refs = extractReferences(
      "see github.com/org/repo/wiki/Home.md and www.example.com/page.html for docs",
    );
    expect(refs.filter((r) => r.kind === "file")).toHaveLength(0);
  });

  test("real repo paths with no host-like first segment ARE still extracted", () => {
    const refs = extractReferences(
      "packages/core/src/db.ts and .github/workflows/ci.yml hold config",
    );
    const files = refs.filter((r) => r.kind === "file").map((r) => r.path);
    expect(files).toEqual(
      expect.arrayContaining([
        "packages/core/src/db.ts",
        ".github/workflows/ci.yml",
      ]),
    );
  });
});

describe("DirectFsResolver", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "lore-refres-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "foo.ts"), "1\n2\n3\n4\n5\n"); // 5 lines
    // mixed-case on-disk filename — exercises the builder's basename/path
    // lowercasing (#969): a lowercase citation must resolve against it.
    writeFileSync(join(root, "src", "Widget.tsx"), "1\n2\n3\n"); // 3 lines
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
    expect(await resolve("`pnpm run lint`")).toBe("ok");
  });
  test("missing package.json script → missing", async () => {
    expect(await resolve("`pnpm run nope`")).toBe("missing");
  });
  test("make target present → ok", async () => {
    expect(await resolve("`make check`")).toBe("ok");
  });
  // make/yarn are English words → an absent target is UNKNOWN (neutral), never
  // "missing" (so a backticked prose phrase like `make sense` can't penalize).
  test("make target absent → unknown (neutral, NOT missing)", async () => {
    expect(await resolve("`make nope`")).toBe("unknown");
  });
  test("backticked make-prose (`make sense`) → unknown, never missing", async () => {
    expect(await resolve("`make sense`")).toBe("unknown");
  });
  test("yarn script absent → unknown (neutral, NOT missing)", async () => {
    expect(await resolve("`yarn about`")).toBe("unknown");
  });
  test("yarn script present → ok", async () => {
    // package.json has a `lint` script in this fixture.
    expect(await resolve("`yarn lint`")).toBe("ok");
  });

  // Regression (#939 round-3 review): pnpm/npm are common technical NOUNS, so a
  // bare `npm registry` / `pnpm workspace` is a noun phrase, not a command. Only
  // an EXPLICIT `<pm> run <script>` may resolve "missing"; a bare `<pm> <word>`
  // that isn't a script is "unknown" (neutral), never penalized.
  test("explicit `pnpm run <absent>` → missing (legit removed-script signal)", async () => {
    expect(await resolve("`pnpm run nope`")).toBe("missing");
  });
  test("bare `npm <noun>` (registry/package) → unknown, never missing", async () => {
    expect(await resolve("`npm registry`")).toBe("unknown");
    expect(await resolve("`npm package`")).toBe("unknown");
    expect(await resolve("`pnpm workspace`")).toBe("unknown");
  });
  test("bare `pnpm <present-script>` still resolves ok", async () => {
    // fixture package.json has a `build` script.
    expect(await resolve("`pnpm build`")).toBe("ok");
  });
  test("bare `pnpm <absent-script>` → unknown (neutral, NOT missing)", async () => {
    expect(await resolve("`pnpm deploy`")).toBe("unknown");
  });

  test("dot-dir file (e.g. .github/workflows/release.yml) resolves ok", async () => {
    expect(await resolve(".github/workflows/release.yml")).toBe("ok");
  });

  // Case-insensitive file resolution (#969): a citation whose case differs from
  // the on-disk file must NOT false-"missing" on a case-sensitive FS (Linux/CI).
  // The actual-case path is what feeds the line-count check, so the line bound is
  // still honored exactly.
  test("wrong-case multi-segment path resolves against actual file → ok", async () => {
    expect(await resolve("src/FOO.ts:3")).toBe("ok"); // file is src/foo.ts
  });
  test("wrong-case path still honors the line bound → missing when out of range", async () => {
    expect(await resolve("src/FOO.ts:99")).toBe("missing");
  });
  test("wrong-case dir AND file segments resolve → ok (no line)", async () => {
    expect(await resolve("SRC/FOO.ts")).toBe("ok");
  });
  test("wrong-case bare basename resolves to the actual-case file → ok", async () => {
    expect(await resolve("UNIQUEBAR.ts:2")).toBe("ok");
  });
  test("case-fold does not mask a genuinely absent file → missing", async () => {
    expect(await resolve("src/GONE.ts:1")).toBe("missing");
  });
  test("lowercase citation resolves a mixed-case on-disk file (multi-segment) → ok", async () => {
    expect(await resolve("src/widget.tsx:2")).toBe("ok"); // file is src/Widget.tsx
  });
  test("lowercase citation resolves a mixed-case on-disk file (bare basename) → ok", async () => {
    expect(await resolve("widget.tsx:3")).toBe("ok");
  });
  test("command refs are unknown when package.json is absent (neutral)", async () => {
    const noPkg = mkdtempSync(join(tmpdir(), "lore-nopkg-"));
    try {
      const refs = extractReferences("`pnpm run lint`");
      const map = await new DirectFsResolver(noPkg).resolve(refs);
      expect(map?.get("pnpm run lint")).toBe("unknown");
    } finally {
      rmSync(noPkg, { recursive: true, force: true });
    }
  });

  test("make refs are unknown when no Makefile (neutral)", async () => {
    const noMake = mkdtempSync(join(tmpdir(), "lore-nomake-"));
    try {
      const refs = extractReferences("`make check`");
      const map = await new DirectFsResolver(noMake).resolve(refs);
      expect(map?.get("make check")).toBe("unknown");
    } finally {
      rmSync(noMake, { recursive: true, force: true });
    }
  });
});

// Regression (#939 Seer HIGH): on Windows `path.normalize` emits backslash
// separators, but `view.files` is built with forward slashes on every platform,
// so the resolver must `.replace(/\\/g, "/")` the normalized path or a valid file
// ref would wrongly resolve "missing" (and get penalized). We can't run on Windows
// here, so we drive resolveRefAgainstView with a path that already contains literal
// backslashes (plus one forward slash to clear the multi-segment branch gate) and
// a forward-slash view — exactly what the `.replace` reconciles. Mutation-verified:
// dropping the `.replace`, or its `/g` flag, makes this resolve "missing".
describe("resolveRefAgainstView (Windows backslash normalization)", () => {
  const view: RepoView = {
    files: new Set(["a/b/c/d.ts"]),
    filesLower: new Map([["a/b/c/d.ts", ["a/b/c/d.ts"]]]),
    basenames: new Map([["d.ts", ["a/b/c/d.ts"]]]),
    presentSymbols: null,
    searchedSymbols: null,
    scripts: null,
    makeTargets: null,
    lineCount: (rel) => (rel === "a/b/c/d.ts" ? 5 : null),
  };

  test("file ref with backslash separators matches the forward-slash view → ok", () => {
    const ref: Reference = {
      kind: "file",
      path: "a/b\\c\\d.ts",
      line: 3,
      raw: "a/b\\c\\d.ts:3",
    };
    expect(resolveRefAgainstView(ref, view)).toBe("ok");
  });

  test("backslash separators still honor the line bound → missing when out of range", () => {
    const ref: Reference = {
      kind: "file",
      path: "a/b\\c\\d.ts",
      line: 99,
      raw: "a/b\\c\\d.ts:99",
    };
    expect(resolveRefAgainstView(ref, view)).toBe("missing");
  });
});

// Case-insensitive file resolution (#969), unit-tested directly against
// hand-built RepoViews so the exact-vs-case-folded branches and case-collision
// neutrality are exercised independent of any filesystem. Mutation-verified:
// removing either `.toLowerCase()` in the lookups, or collapsing the
// case-collision `unknown` to a positive verdict, flips one of these.
describe("resolveRefAgainstView (case-insensitive file resolution, #969)", () => {
  // Actual paths are lowercase; indices are keyed lowercase with actual-case
  // values — exactly the shape both builders produce.
  const view: RepoView = {
    files: new Set(["packages/core/src/db.ts", "readme.md"]),
    filesLower: new Map([
      ["packages/core/src/db.ts", ["packages/core/src/db.ts"]],
      ["readme.md", ["readme.md"]],
    ]),
    basenames: new Map([
      ["db.ts", ["packages/core/src/db.ts"]],
      ["readme.md", ["readme.md"]],
    ]),
    presentSymbols: null,
    searchedSymbols: null,
    scripts: null,
    makeTargets: null,
    lineCount: (rel) =>
      rel === "packages/core/src/db.ts" ? 42 : rel === "readme.md" ? 10 : null,
  };
  const status = (path: string, line: number | null) =>
    resolveRefAgainstView(
      {
        kind: "file",
        path,
        line,
        raw: `${path}${line == null ? "" : `:${line}`}`,
      },
      view,
    );

  test("wrong-case multi-segment path → ok (not a false missing)", () => {
    expect(status("packages/core/src/DB.ts", null)).toBe("ok");
  });
  test("wrong-case path + in-range line uses the actual file's count → ok", () => {
    expect(status("packages/core/src/DB.ts", 42)).toBe("ok");
  });
  test("wrong-case path + out-of-range line → missing (bound still honored)", () => {
    expect(status("packages/core/src/DB.ts", 43)).toBe("missing");
  });
  test("exact-case match is still ok", () => {
    expect(status("packages/core/src/db.ts", 42)).toBe("ok");
  });
  test("wrong-case bare basename → ok (resolves to the actual-case file)", () => {
    expect(status("README.MD", 10)).toBe("ok");
  });
  test("genuinely absent file is still missing (case-fold doesn't mask it)", () => {
    expect(status("packages/core/src/gone.ts", null)).toBe("missing");
  });

  // A case-collision (two siblings differing only in case — possible on a
  // case-sensitive FS) is ambiguous: resolution stays NEUTRAL ("unknown") so a
  // line check against the wrong sibling can never emit a false penalty.
  test("multi-segment case-collision (no exact hit) → unknown (neutral)", () => {
    const collide: RepoView = {
      files: new Set(["src/Foo.ts", "src/foo.ts"]),
      filesLower: new Map([["src/foo.ts", ["src/Foo.ts", "src/foo.ts"]]]),
      basenames: new Map([["foo.ts", ["src/Foo.ts", "src/foo.ts"]]]),
      presentSymbols: null,
      searchedSymbols: null,
      scripts: null,
      makeTargets: null,
      lineCount: () => 1,
    };
    expect(
      resolveRefAgainstView(
        { kind: "file", path: "src/FOO.ts", line: 1, raw: "src/FOO.ts:1" },
        collide,
      ),
    ).toBe("unknown");
  });
  test("multi-segment exact case wins over a sibling collision → ok", () => {
    const collide: RepoView = {
      files: new Set(["src/Foo.ts", "src/foo.ts"]),
      filesLower: new Map([["src/foo.ts", ["src/Foo.ts", "src/foo.ts"]]]),
      basenames: new Map([["foo.ts", ["src/Foo.ts", "src/foo.ts"]]]),
      presentSymbols: null,
      searchedSymbols: null,
      scripts: null,
      makeTargets: null,
      lineCount: () => 1,
    };
    expect(
      resolveRefAgainstView(
        { kind: "file", path: "src/foo.ts", line: 1, raw: "src/foo.ts:1" },
        collide,
      ),
    ).toBe("ok");
  });
  test("bare basename collision with a unique exact-case match prefers it → ok", () => {
    const collide: RepoView = {
      files: new Set(["a/Foo.ts", "b/foo.ts"]),
      filesLower: new Map([
        ["a/foo.ts", ["a/Foo.ts"]],
        ["b/foo.ts", ["b/foo.ts"]],
      ]),
      basenames: new Map([["foo.ts", ["a/Foo.ts", "b/foo.ts"]]]),
      presentSymbols: null,
      searchedSymbols: null,
      scripts: null,
      makeTargets: null,
      lineCount: () => 5,
    };
    expect(
      resolveRefAgainstView(
        { kind: "file", path: "foo.ts", line: 5, raw: "foo.ts:5" },
        collide,
      ),
    ).toBe("ok");
  });
  test("bare basename collision with no exact-case match → unknown (neutral)", () => {
    const collide: RepoView = {
      files: new Set(["a/Foo.ts", "b/FOO.ts"]),
      filesLower: new Map([
        ["a/foo.ts", ["a/Foo.ts"]],
        ["b/foo.ts", ["b/FOO.ts"]],
      ]),
      basenames: new Map([["foo.ts", ["a/Foo.ts", "b/FOO.ts"]]]),
      presentSymbols: null,
      searchedSymbols: null,
      scripts: null,
      makeTargets: null,
      lineCount: () => 5,
    };
    expect(
      resolveRefAgainstView(
        { kind: "file", path: "foo.ts", line: 5, raw: "foo.ts:5" },
        collide,
      ),
    ).toBe("unknown");
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
    expect(await resolve("`pnpm run lint`")).toBe("ok");
    expect(await resolve("`pnpm run nope`")).toBe("missing");
  });
  test("make target present → ok, absent → unknown (neutral)", async () => {
    expect(await resolve("`make check`")).toBe("ok");
    expect(await resolve("`make nope`")).toBe("unknown");
  });
  test("malformed / empty probe output → null (whole-batch neutral)", async () => {
    const refs = extractReferences("src/foo.ts:1");
    expect(
      await new SyntheticProbeResolver("garbage with no markers").resolve(refs),
    ).toBeNull();
    expect(await new SyntheticProbeResolver("").resolve(refs)).toBeNull();
  });
  // Regression (#939 MUST-FIX 2b): a probe whose file list is empty (git absent
  // AND find empty, or wrong CWD) is unverifiable — it must go NEUTRAL (null),
  // not treat every file ref as "missing" and mass-penalize.
  test("markers present but empty file list → null (neutral, no mass penalty)", async () => {
    const emptyFiles = [
      "", // no file lines
      "===LORE-PKG===",
      JSON.stringify({ scripts: { lint: "biome" } }),
      "===LORE-MAKE===",
      "",
      "===LORE-LINES===",
      "",
    ].join("\n");
    const refs = extractReferences("src/foo.ts:1");
    expect(
      await new SyntheticProbeResolver(emptyFiles).resolve(refs),
    ).toBeNull();
  });
});

// A REAL parity check: build a fixture once, materialize it on disk for
// DirectFsResolver AND derive the matching probe snapshot for
// SyntheticProbeResolver from the SAME fixture, then assert the two modes return
// an IDENTICAL status for every ref. (The previous "parity" test only checked
// the synthetic result was a member of {ok,missing,unknown} — it would have
// passed even if the two modes disagreed on every input. #939 review CONCERN-4d.)
describe("Direct-FS ↔ SyntheticProbe parity (real ref-by-ref comparison)", () => {
  // path -> file contents (newline count drives line resolution).
  const fixture: Record<string, string> = {
    "src/foo.ts": "1\n2\n3\n4\n5\n",
    "src/Widget.tsx": "1\n2\n3\n", // mixed-case on disk (#969 builder lowercasing)
    "uniquebar.ts": "x\ny\n",
    "a/dup.ts": "1\n",
    "b/dup.ts": "1\n",
    ".github/workflows/release.yml": "1\n",
    "package.json": JSON.stringify({
      scripts: { lint: "biome", build: "tsc" },
    }),
    Makefile: "check:\n\techo ok\n.PHONY: check\n",
  };

  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "lore-parity-"));
    for (const [rel, content] of Object.entries(fixture)) {
      const full = join(root, rel);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, content);
    }
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  // Derive the probe snapshot from the SAME fixture so the two can't drift.
  const buildSnapshot = (): string => {
    const filePaths = Object.keys(fixture).filter(
      (p) => p !== "package.json" && p !== "Makefile",
    );
    const lines = filePaths.map(
      // wc -l semantics = newline count; parseProbeSnapshot adds +1 to match
      // Direct-FS's split("\n").length.
      (p) => `${p}\t${(fixture[p].match(/\n/g) ?? []).length}`,
    );
    return [
      ...filePaths,
      "===LORE-PKG===",
      fixture["package.json"],
      "===LORE-MAKE===",
      fixture.Makefile,
      "===LORE-LINES===",
      ...lines,
    ].join("\n");
  };

  test.each([
    "src/foo.ts:3", // in range
    "src/foo.ts:6", // boundary (5 newlines + 1)
    "src/foo.ts:7", // out of range
    "src/foo.ts", // exists, no line
    "src/FOO.ts:3", // wrong-case multi-segment, in range (#969)
    "src/FOO.ts:7", // wrong-case multi-segment, out of range (#969)
    "SRC/FOO.ts", // wrong-case dir + file, no line (#969)
    "src/widget.tsx:2", // lowercase ref → mixed-case on-disk file (#969 builders)
    "widget.tsx:3", // lowercase bare basename → mixed-case on-disk file (#969)
    "src/gone.ts:1", // missing file
    "uniquebar.ts:2", // bare unique basename, in range
    "UNIQUEBAR.ts:2", // wrong-case bare basename, in range (#969)
    "uniquebar.ts:99", // bare unique basename, out of range
    "dup.ts:1", // ambiguous basename
    "/etc/foo.ts:1", // absolute
    "../escape.ts:1", // out of tree
    ".github/workflows/release.yml", // dot-dir file
    "`pnpm run lint`", // explicit present script
    "`pnpm run nope`", // explicit absent script → missing
    "`pnpm build`", // bare present script → ok
    "`npm registry`", // bare absent (noun phrase) → unknown
    "`make check`", // present target
    "`make nope`", // absent target → unknown
  ])("Direct-FS and SyntheticProbe agree on %j", async (raw) => {
    const refs = extractReferences(raw);
    expect(refs.length).toBeGreaterThan(0);
    const key = refs[0].raw;
    const direct = (await new DirectFsResolver(root).resolve(refs))?.get(key);
    const synthetic = (
      await new SyntheticProbeResolver(buildSnapshot()).resolve(refs)
    )?.get(key);
    expect(direct).toBe(synthetic);
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

  // Case-insensitive line-count emission (#969): the refset is lowercased and the
  // shell lowercases each on-disk basename (`tr`), so a wrong-case citation
  // (`DB.ts`) still gets the actual file's line count emitted → remote parity
  // with Direct-FS. Mutation-verified: dropping `.toLowerCase()` on the refset
  // leaves `|DB.ts|`, which the lowercased shell basename never matches.
  test("lowercases referenced basenames in the filter set + the shell basename", () => {
    const script = buildRefcheckProbeScript(
      extractReferences("see src/DB.ts:10"),
    );
    expect(script).toContain("|db.ts|");
    expect(script).not.toContain("|DB.ts|");
    expect(script).toContain("tr '[:upper:]' '[:lower:]'");
  });

  // Regression (#939 MUST-FIX 2a): the snapshot must run from the repo ROOT, not
  // the client CWD, so a subdir-launched agent doesn't mass-false-penalize
  // root-relative refs. The cd runs in a subshell so it can't leak into a
  // combined probe's resolution section.
  test("cd's to the git toplevel inside a subshell", () => {
    const script = buildRefcheckProbeScript(extractReferences("src/db.ts:1"));
    expect(script).toContain("git rev-parse --show-toplevel");
    expect(script.trim().startsWith("(")).toBe(true);
    expect(script.trim().endsWith(")")).toBe(true);
  });

  // Defense-in-depth (#939 security review): even if extraction ever broadened,
  // a basename with shell metacharacters must never reach the interpolated
  // `__refset='…'` sink.
  test("drops basenames with shell metacharacters from the refset", () => {
    const malicious: Reference[] = [
      { kind: "file", path: "a$(rm -rf ~).ts", line: 1, raw: "x" },
      { kind: "file", path: "ok.ts", line: 1, raw: "y" },
    ];
    const script = buildRefcheckProbeScript(malicious);
    expect(script).toContain("|ok.ts|");
    // The malicious payload never reaches the script (neither the basename nor
    // its command-substitution prefix). Note the script legitimately contains
    // its OWN `$(...)` substitutions, so we assert on the payload specifically.
    expect(script).not.toContain("rm -rf");
    expect(script).not.toContain("a$(");
  });
});

// True end-to-end parity: EXECUTE the generated probe under a POSIX shell against
// a mixed-case fixture, feed the REAL output through SyntheticProbeResolver, and
// compare ref-by-ref to DirectFsResolver. Unlike the JS-derived parity suite
// above (which emits every line count unconditionally), this exercises the
// shell's refset filter + `tr` case-fold, so it behaviorally guards the
// case-insensitive line-count emission (#969) — not just a string match.
// (Skipped on Windows; vitest CI runs on Linux and the script is POSIX-only.)
describe.skipIf(process.platform === "win32")(
  "buildRefcheckProbeScript real-shell ↔ Direct-FS parity (#969)",
  () => {
    let root: string;
    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), "lore-shellparity-"));
      mkdirSync(join(root, "src"), { recursive: true });
      // mixed-case on-disk filename; 3 newlines → 4 lines via split("\n").
      writeFileSync(join(root, "src", "Db.ts"), "1\n2\n3\n");
      writeFileSync(join(root, "src", "foo.ts"), "1\n2\n");
    });
    afterAll(() => rmSync(root, { recursive: true, force: true }));

    // Run the actual probe (git absent in a tmp dir → its `find` fallback fires).
    const runProbe = (refs: ReturnType<typeof extractReferences>): string =>
      execFileSync("sh", ["-c", buildRefcheckProbeScript(refs)], {
        cwd: root,
        encoding: "utf8",
      });

    test.each([
      ["src/DB.ts:2", "ok"], // wrong-case path, in range
      ["src/DB.ts:99", "missing"], // wrong-case path, out of range
      ["SRC/DB.ts", "ok"], // wrong-case dir+file, no line
      ["DB.ts:3", "ok"], // wrong-case bare basename, in range
      ["src/Db.ts:2", "ok"], // exact case still works
    ])("real probe and Direct-FS agree on %j (expect %s)", async (raw, expected) => {
      const refs = extractReferences(raw);
      const key = refs[0].raw;
      const direct = (await new DirectFsResolver(root).resolve(refs))?.get(key);
      // The real shell output drives the synthetic resolver — if the shell's
      // `tr` fold or lowercased refset regressed, the wrong-case line count
      // would be absent and the line-bound rows would diverge to "unknown".
      const synthetic = (
        await new SyntheticProbeResolver(runProbe(refs)).resolve(refs)
      )?.get(key);
      expect(direct).toBe(expected);
      expect(synthetic).toBe(expected);
    });
  },
);

// --- #911 cited-symbol validation ------------------------------------------

describe("extractReferences — cited symbols (#911)", () => {
  const syms = (text: string): string[] =>
    extractReferences(text)
      .filter((r) => r.kind === "symbol")
      .map((r) => (r as { name: string }).name);

  test("a codey symbol co-cited with a file ref is extracted", () => {
    expect(
      syms("`evaluateCacheStrategy` called from cache-warmer.ts:1252"),
    ).toContain("evaluateCacheStrategy");
  });

  test("PascalCase / snake_case / call-like all qualify as codey", () => {
    const s = syms(
      "see refs.ts:1 — `RepoView`, `last_reinforced_at`, `walk()`",
    );
    expect(s).toEqual(
      expect.arrayContaining(["RepoView", "last_reinforced_at", "walk"]),
    );
  });

  // Gate B (adjacency bound): a backtick identifier with NO co-cited file ref is
  // too unmoored to act on — never a symbol ref.
  test("a backtick identifier WITHOUT any co-cited file ref is NOT a symbol", () => {
    expect(syms("`shouldHoldPrefixWarm` is a pure helper")).toEqual([]);
  });

  // Gate C (codey shape): the false-positive killer. Bare marker-free lowercase
  // prose words in backticks must never become symbol refs.
  test("bare lowercase prose words in backticks are rejected (codey gate)", () => {
    const s = syms("the `total` and `run` of src/foo.ts:1");
    expect(s).not.toContain("total");
    expect(s).not.toContain("run");
  });

  test("`foo` and `foo()` dedupe to a single symbol", () => {
    const s = syms("`fooBar` then `fooBar()` near src/a.ts:1");
    expect(s.filter((n) => n === "fooBar")).toHaveLength(1);
  });

  test("a command token is not also captured as a symbol", () => {
    const refs = extractReferences("run `pnpm run lint` in src/a.ts:1");
    expect(refs.some((r) => r.kind === "symbol")).toBe(false);
  });
});

describe("resolveRefAgainstView (symbol presence, #911)", () => {
  const mk = (
    present: Set<string> | null,
    searched: Set<string> | null = present,
  ): RepoView => ({
    files: new Set(),
    filesLower: new Map(),
    basenames: new Map(),
    presentSymbols: present,
    searchedSymbols: searched,
    scripts: null,
    makeTargets: null,
    lineCount: () => null,
  });
  const sym = (name: string): Reference => ({
    kind: "symbol",
    name,
    raw: name,
  });

  test("present anywhere → ok", () => {
    expect(resolveRefAgainstView(sym("foo"), mk(new Set(["foo"])))).toBe("ok");
  });
  test("searched and absent repo-wide → missing", () => {
    // searched contains foo (it was looked for) but present does not.
    expect(
      resolveRefAgainstView(sym("foo"), mk(new Set(), new Set(["foo"]))),
    ).toBe("missing");
  });
  test("presence unavailable (null) → unknown (neutral)", () => {
    expect(resolveRefAgainstView(sym("foo"), mk(null, null))).toBe("unknown");
  });
  // SF1: a grep that errored leaves the name out of BOTH sets → unsearched →
  // unknown, never a false "missing".
  test("not in the searched set (grep errored) → unknown (neutral)", () => {
    expect(
      resolveRefAgainstView(sym("foo"), mk(new Set(["bar"]), new Set(["bar"]))),
    ).toBe("unknown");
  });
});

// Symbol presence needs a real git work tree (`git grep`). Build a git fixture so
// both the "ok"/"missing" verdicts AND the non-git → neutral path are exercised.
describe.skipIf(process.platform === "win32")(
  "DirectFsResolver symbol resolution (#911)",
  () => {
    let root: string;
    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), "lore-sym-"));
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(
        join(root, "src", "code.ts"),
        "export function evaluateCacheStrategy() {\n  return 1;\n}\nconst fooBarBaz = 2;\n",
      );
      execFileSync("git", ["init", "-q"], { cwd: root });
      execFileSync("git", ["add", "-A"], { cwd: root });
    });
    afterAll(() => rmSync(root, { recursive: true, force: true }));

    const symStatus = async (raw: string): Promise<string | undefined> => {
      const refs = extractReferences(raw);
      const sym = refs.find((r) => r.kind === "symbol");
      expect(sym).toBeDefined();
      const map = await new DirectFsResolver(root).resolve(refs);
      return map?.get((sym as { raw: string }).raw);
    };

    test("present symbol → ok", async () => {
      expect(await symStatus("`evaluateCacheStrategy` in src/code.ts:1")).toBe(
        "ok",
      );
    });
    test("absent symbol → missing", async () => {
      expect(await symStatus("`removedHelperFn` in src/code.ts:1")).toBe(
        "missing",
      );
    });
    // `git grep -w` is a whole-word match, so a camelCase token present only as a
    // substring (`fooBar` inside `fooBarBaz`) is genuinely absent → missing.
    test("camelCase token present only as a substring → missing (word boundary)", async () => {
      expect(await symStatus("`fooBar` in src/code.ts:1")).toBe("missing");
    });
    test("non-git root → symbol unknown (neutral), never a false missing", async () => {
      const plain = mkdtempSync(join(tmpdir(), "lore-nogit-"));
      try {
        mkdirSync(join(plain, "src"), { recursive: true });
        writeFileSync(join(plain, "src", "code.ts"), "nope\n");
        const refs = extractReferences(
          "`evaluateCacheStrategy` in src/code.ts:1",
        );
        const sym = refs.find((r) => r.kind === "symbol") as { raw: string };
        const map = await new DirectFsResolver(plain).resolve(refs);
        expect(map?.get(sym.raw)).toBe("unknown");
      } finally {
        rmSync(plain, { recursive: true, force: true });
      }
    });

    // SF3: resolving with a SUBDIRECTORY root must still find a symbol defined in
    // a SIBLING package, because the grep runs from the git TOPLEVEL — matching
    // the probe's `cd $(git rev-parse --show-toplevel)`. (Pre-fix, Direct-FS
    // greped `git -C <subdir>`, scoped to that subtree → false "missing" on a
    // sibling-defined symbol + a silent divergence from the probe. Verified:
    // `git -C pkgA grep <pkgB-only-symbol>` exits 1.)
    test("subdirectory root greps from the toplevel → sibling-package symbol → ok", async () => {
      const repo = mkdtempSync(join(tmpdir(), "lore-symsub-"));
      try {
        mkdirSync(join(repo, "pkgA"), { recursive: true });
        mkdirSync(join(repo, "pkgB"), { recursive: true });
        // The symbol is defined ONLY in pkgB; pkgA never mentions it.
        writeFileSync(join(repo, "pkgA", "a.ts"), "const x = 1;\n");
        writeFileSync(
          join(repo, "pkgB", "b.ts"),
          "export const siblingOnlySymbol = 1;\n",
        );
        execFileSync("git", ["init", "-q"], { cwd: repo });
        execFileSync("git", ["add", "-A"], { cwd: repo });
        const refs = extractReferences("`siblingOnlySymbol` in pkgA/a.ts:1");
        const sym = refs.find((r) => r.kind === "symbol") as { raw: string };
        // Resolver root is the pkgA subdir; the symbol lives in the pkgB sibling.
        const map = await new DirectFsResolver(join(repo, "pkgA")).resolve(
          refs,
        );
        expect(map?.get(sym.raw)).toBe("ok");
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    });

    // SF2: an inherited GIT_DIR / GIT_INDEX_FILE must not redirect the grep to the
    // wrong repo (which would mass-false-miss). The env is scrubbed, so a present
    // symbol still resolves ok even with a bogus GIT_DIR set.
    test("inherited bogus GIT_DIR does not cause a false missing (env scrubbed)", async () => {
      const prevDir = process.env.GIT_DIR;
      const prevIdx = process.env.GIT_INDEX_FILE;
      process.env.GIT_DIR = join(tmpdir(), "lore-bogus-gitdir-does-not-exist");
      process.env.GIT_INDEX_FILE = "/dev/null";
      try {
        expect(
          await symStatus("`evaluateCacheStrategy` in src/code.ts:1"),
        ).toBe("ok");
      } finally {
        if (prevDir === undefined) delete process.env.GIT_DIR;
        else process.env.GIT_DIR = prevDir;
        if (prevIdx === undefined) delete process.env.GIT_INDEX_FILE;
        else process.env.GIT_INDEX_FILE = prevIdx;
      }
    });
  },
);

describe("buildRefcheckProbeScript symbol section (#911)", () => {
  test("emits the symbol section, git guard, OK+DONE markers, and a per-symbol grep", () => {
    const script = buildRefcheckProbeScript(
      extractReferences("`evaluateCacheStrategy` and `RepoView` in refs.ts:1"),
    );
    expect(script).toContain("===LORE-SYMS===");
    expect(script).toContain("git rev-parse --is-inside-work-tree");
    expect(script).toContain("===LORE-SYMS-OK===");
    expect(script).toContain("===LORE-SYMS-DONE===");
    // per-symbol grep that emits `name\t1` / `name\t0` based on exit status.
    expect(script).toContain("git grep -qwF -- 'evaluateCacheStrategy'");
    expect(script).toContain("git grep -qwF -- 'RepoView'");
    expect(script).toContain("case $? in 0)");
  });

  // Defense-in-depth: a symbol name outside the identifier charset must never be
  // coined into a grep argument (extraction guarantees the charset; assert the
  // interpolation-site guard independently).
  test("never coins a grep arg outside the identifier charset", () => {
    const malicious: Reference[] = [
      { kind: "symbol", name: "a';rm -rf ~;'", raw: "x" },
      { kind: "symbol", name: "okName", raw: "y" },
    ];
    const script = buildRefcheckProbeScript(malicious);
    expect(script).toContain("'okName'");
    expect(script).not.toContain("rm -rf");
  });
});

describe("parseProbeSnapshot symbol section (#911)", () => {
  const base = [
    "src/foo.ts",
    "===LORE-PKG===",
    "{}",
    "===LORE-MAKE===",
    "",
    "===LORE-LINES===",
    "src/foo.ts\t5",
  ];

  test("OK+DONE with name\\t1 / name\\t0 → present and searched populated correctly", () => {
    const text = [
      ...base,
      "===LORE-SYMS===",
      "===LORE-SYMS-OK===",
      "evaluateCacheStrategy\t1",
      "removedFn\t0",
      "===LORE-SYMS-DONE===",
    ].join("\n");
    const view = parseProbeSnapshot(text);
    expect(view?.presentSymbols?.has("evaluateCacheStrategy")).toBe(true);
    expect(view?.presentSymbols?.has("removedFn")).toBe(false);
    // both were definitively searched
    expect(view?.searchedSymbols?.has("evaluateCacheStrategy")).toBe(true);
    expect(view?.searchedSymbols?.has("removedFn")).toBe(true);
  });

  test("OK+DONE with no symbol lines → empty sets (real misses, NOT neutral)", () => {
    const text = [
      ...base,
      "===LORE-SYMS===",
      "===LORE-SYMS-OK===",
      "===LORE-SYMS-DONE===",
    ].join("\n");
    const view = parseProbeSnapshot(text);
    expect(view?.presentSymbols).not.toBeNull();
    expect(view?.searchedSymbols).not.toBeNull();
    expect(view?.presentSymbols?.size).toBe(0);
  });

  // SF4: OK but NO DONE → output was truncated mid-section → null (neutral), so
  // an un-emitted symbol is never falsely read as absent.
  test("OK but NO DONE marker (truncated) → null (neutral)", () => {
    const text = [
      ...base,
      "===LORE-SYMS===",
      "===LORE-SYMS-OK===",
      "evaluateCacheStrategy\t1",
    ].join("\n");
    const view = parseProbeSnapshot(text);
    expect(view?.presentSymbols).toBeNull();
    expect(view?.searchedSymbols).toBeNull();
  });

  test("section present but NO OK marker (git absent) → null (neutral)", () => {
    const text = [...base, "===LORE-SYMS==="].join("\n");
    expect(parseProbeSnapshot(text)?.presentSymbols).toBeNull();
  });

  test("old probe with no symbol section → null (neutral, back-compat)", () => {
    expect(parseProbeSnapshot(base.join("\n"))?.presentSymbols).toBeNull();
  });
});

// End-to-end: EXECUTE the generated probe under a POSIX shell against a git
// fixture so the real `git grep -qwF` runs, feed the output through
// SyntheticProbeResolver, and confirm it agrees with DirectFsResolver ref-by-ref.
describe.skipIf(process.platform === "win32")(
  "symbol probe real-shell ↔ Direct-FS parity (#911)",
  () => {
    let root: string;
    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), "lore-symparity-"));
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(
        join(root, "src", "code.ts"),
        "export function evaluateCacheStrategy() {}\nconst fooBarBaz = 1;\n",
      );
      execFileSync("git", ["init", "-q"], { cwd: root });
      execFileSync("git", ["add", "-A"], { cwd: root });
    });
    afterAll(() => rmSync(root, { recursive: true, force: true }));

    test.each([
      ["`evaluateCacheStrategy` in src/code.ts:1", "ok"],
      ["`removedHelper` in src/code.ts:1", "missing"],
      ["`fooBar` in src/code.ts:1", "missing"], // substring only → word-boundary miss
    ])("real probe and Direct-FS agree on %j (symbol → %s)", async (raw, expected) => {
      const refs = extractReferences(raw);
      const sym = refs.find((r) => r.kind === "symbol") as { raw: string };
      const direct = (await new DirectFsResolver(root).resolve(refs))?.get(
        sym.raw,
      );
      const probeOut = execFileSync(
        "sh",
        ["-c", buildRefcheckProbeScript(refs)],
        {
          cwd: root,
          encoding: "utf8",
        },
      );
      const synthetic = (
        await new SyntheticProbeResolver(probeOut).resolve(refs)
      )?.get(sym.raw);
      expect(direct).toBe(expected);
      expect(synthetic).toBe(expected);
    });

    // The probe must exit 0 even when the last symbol grep finds nothing —
    // otherwise the client tool flags `isError` and the WHOLE batch goes neutral.
    test("probe exits 0 when a symbol is absent (no silent batch abort)", () => {
      const refs = extractReferences(
        "`definitelyNotPresentXyz` in src/code.ts:1",
      );
      const r = spawnSync("sh", ["-c", buildRefcheckProbeScript(refs)], {
        cwd: root,
        encoding: "utf8",
      });
      expect(r.status).toBe(0);
    });
  },
);
