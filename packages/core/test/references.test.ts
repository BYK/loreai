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
    basenames: new Map([["d.ts", ["a/b/c/d.ts"]]]),
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
    "src/gone.ts:1", // missing file
    "uniquebar.ts:2", // bare unique basename, in range
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
