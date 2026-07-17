import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../src/db";
import { storeEmbedding } from "../src/db/vec-store";
import * as embedding from "../src/embedding";
import * as ltm from "../src/ltm";
import {
  changedFiles,
  checkInvariants,
  clusterHunks,
  enforcementLevel,
  gateDecision,
  isEnforceableInvariant,
  isEnumerationInvariant,
  isIgnoredFile,
  overrideMatchesFinding,
  parseInvariantVerdict,
  parseOverrides,
  selectCandidates,
  splitDiff,
  type DiffHunk,
  type Finding,
  type InvariantVec,
  type ResolvedRange,
} from "../src/invariant-check";
import type { LLMClient } from "../src/types";

function v(...xs: number[]): Float32Array {
  return new Float32Array(xs);
}

function stubLLM(responder: (system: string, user: string) => string | null): {
  llm: LLMClient;
  prompt: ReturnType<typeof vi.fn>;
} {
  const prompt = vi.fn(async (system: string, user: string) =>
    responder(system, user),
  );
  return { llm: { prompt }, prompt };
}

async function seed(
  projectPath: string,
  title: string,
  content: string,
  vec: Float32Array,
): Promise<string> {
  const id = ltm.create({
    projectPath,
    category: "gotcha",
    title,
    content,
    scope: "project",
    confidence: 0.9,
  });
  await embedding.settleDocumentEmbeds();
  storeEmbedding(db(), "knowledge", id, vec);
  return id;
}

const FAKE_RANGE: ResolvedRange = {
  base: "aaaa",
  head: "bbbb",
  source: "test",
};

beforeEach(() => {
  vi.spyOn(embedding, "embed").mockResolvedValue([v(0, 0, 1)]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe("splitDiff", () => {
  it("splits a multi-file unified diff into per-file hunks", () => {
    const raw = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "index 111..222 100644",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,3 +1,4 @@",
      " context",
      "+added line",
      " more",
      "diff --git a/src/bar.ts b/src/bar.ts",
      "--- a/src/bar.ts",
      "+++ b/src/bar.ts",
      "@@ -10,2 +10,2 @@",
      "-removed",
      "+replaced",
    ].join("\n");
    const hunks = splitDiff(raw);
    expect(hunks).toHaveLength(2);
    expect(hunks[0].file).toBe("src/foo.ts");
    expect(hunks[0].text).toContain("+added line");
    expect(hunks[1].file).toBe("src/bar.ts");
    expect(hunks[1].text).toContain("+replaced");
  });

  it("handles a file with multiple hunks", () => {
    const raw = [
      "diff --git a/x.ts b/x.ts",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1 +1 @@",
      "+a",
      "@@ -5 +5 @@",
      "+b",
    ].join("\n");
    const hunks = splitDiff(raw);
    expect(hunks).toHaveLength(2);
    expect(hunks.every((h) => h.file === "x.ts")).toBe(true);
  });

  it("returns empty for empty input", () => {
    expect(splitDiff("")).toEqual([]);
  });

  it("parses a DELETED file's hunk (+++ /dev/null) via the --- a/ path", () => {
    // A deletion diff has no `+++ b/` line — only `+++ /dev/null`. The hunk must
    // still be captured (attributed to the old path) so removing the only guard
    // for an invariant is judged, not silently dropped.
    const raw = [
      "diff --git a/src/guard.ts b/src/guard.ts",
      "deleted file mode 100644",
      "index 333..000",
      "--- a/src/guard.ts",
      "+++ /dev/null",
      "@@ -1,3 +0,0 @@",
      "-if (!token) throw new Error('no auth');",
      "-doWork();",
      "-cleanup();",
    ].join("\n");
    const hunks = splitDiff(raw);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].file).toBe("src/guard.ts");
    expect(hunks[0].text).toContain("-if (!token) throw");
  });

  it("drops ignored files (.lore.md, lockfiles, generated) but keeps code", () => {
    const raw = [
      "diff --git a/.lore.md b/.lore.md",
      "--- a/.lore.md",
      "+++ b/.lore.md",
      "@@ -1 +1 @@",
      "+* new invariant text",
      "diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml",
      "--- a/pnpm-lock.yaml",
      "+++ b/pnpm-lock.yaml",
      "@@ -1 +1 @@",
      "+  resolution: {integrity: sha512-xxx}",
      "diff --git a/packages/core/src/real.ts b/packages/core/src/real.ts",
      "--- a/packages/core/src/real.ts",
      "+++ b/packages/core/src/real.ts",
      "@@ -1 +1 @@",
      "+export const x = 1;",
    ].join("\n");
    const hunks = splitDiff(raw);
    // Only the real source file survives.
    expect(hunks).toHaveLength(1);
    expect(hunks[0].file).toBe("packages/core/src/real.ts");
  });
});

describe("isIgnoredFile", () => {
  it("ignores the knowledge file at any depth", () => {
    expect(isIgnoredFile(".lore.md")).toBe(true);
    expect(isIgnoredFile("some/nested/.lore.md")).toBe(true);
  });
  it("ignores lockfiles and generated artifacts", () => {
    expect(isIgnoredFile("pnpm-lock.yaml")).toBe(true);
    expect(isIgnoredFile("packages/x/package-lock.json")).toBe(true);
    expect(isIgnoredFile("dist/bundle.js")).toBe(true);
    expect(isIgnoredFile("packages/core/dist/index.js")).toBe(true);
    expect(isIgnoredFile("types/foo.d.ts")).toBe(true);
    expect(isIgnoredFile("node_modules/pkg/index.js")).toBe(true);
  });
  it("does NOT ignore real source files", () => {
    expect(isIgnoredFile("packages/core/src/invariant-check.ts")).toBe(false);
    expect(isIgnoredFile("src/index.ts")).toBe(false);
    expect(isIgnoredFile("Makefile")).toBe(false);
  });

  it("ignores ONLY .lore.md among docs — real docs are judged", () => {
    expect(isIgnoredFile(".lore.md")).toBe(true);
    // Real documentation IS judged (a docs change can contradict an invariant).
    expect(isIgnoredFile("README.md")).toBe(false);
    expect(isIgnoredFile("CHANGELOG.md")).toBe(false);
    expect(isIgnoredFile("docs/src/content/docs/getting-started.mdx")).toBe(
      false,
    );
    expect(isIgnoredFile("AGENTS.md")).toBe(false);
    expect(isIgnoredFile(".craft.yml")).toBe(false);
  });
});

describe("isEnforceableInvariant", () => {
  it("keeps prescriptive + code-referencing invariants", () => {
    expect(
      isEnforceableInvariant({
        category: "gotcha",
        title: "node:sqlite boundary",
        content: "node:sqlite must never be imported outside driver.node.ts",
      }),
    ).toBe(true);
    expect(
      isEnforceableInvariant({
        category: "pattern",
        title: "ordering",
        content: "storeTurnTemporal() must run before resolveToolResults()",
      }),
    ).toBe(true);
  });

  it("drops descriptive prose even when it contains always/never", () => {
    expect(
      isEnforceableInvariant({
        category: "preference",
        title: "remote gateway",
        content:
          "Always a remote gateway — it has no shared filesystem with clients",
      }),
    ).toBe(false);
    expect(
      isEnforceableInvariant({
        category: "architecture",
        title: "org",
        content: "Burak reports to Cramer, peer to Rosenthal",
      }),
    ).toBe(false);
  });

  it("drops workflow/session preferences (not code rules)", () => {
    expect(
      isEnforceableInvariant({
        category: "preference",
        title: "reviews",
        content:
          "Always request adversarial subagent review before merging PRs",
      }),
    ).toBe(false);
  });

  it("honors explicit enforce metadata (opt-in and opt-out)", () => {
    // Opt-out beats a strong heuristic match.
    expect(
      isEnforceableInvariant({
        category: "gotcha",
        title: "x",
        content: "node:sqlite must never be imported outside driver.node.ts",
        metadata: { enforce: false },
      }),
    ).toBe(false);
    // Opt-in rescues an entry the heuristic would drop.
    expect(
      isEnforceableInvariant({
        category: "preference",
        title: "prose rule",
        content: "keep the tower honest",
        metadata: { enforce: "strict" },
      }),
    ).toBe(true);
  });
});

describe("isEnumerationInvariant + enforcementLevel", () => {
  it("detects enumeration/whitelist prose", () => {
    expect(
      isEnumerationInvariant({
        title: "silencing rules",
        content:
          "error-reporting.ts silencing rules: which error types are silenced and why",
      }),
    ).toBe(true);
    expect(
      isEnumerationInvariant({
        title: "auth precedence",
        content:
          "Auth token override: SENTRY_AUTH_TOKEN > SENTRY_TOKEN > SQLite",
      }),
    ).toBe(true);
    expect(
      isEnumerationInvariant({
        title: "ordering",
        content: "storeTurnTemporal() must run before resolveToolResults()",
      }),
    ).toBe(false);
  });

  it("defaults everything to advisory", () => {
    expect(
      enforcementLevel({ title: "x", content: "foo() must never bar()" }),
    ).toBe("advisory");
  });

  it("escalates only on explicit enforce metadata", () => {
    expect(
      enforcementLevel({
        title: "x",
        content: "foo() must never bar()",
        metadata: { enforce: "strict" },
      }),
    ).toBe("strict");
    expect(
      enforcementLevel({
        title: "x",
        content: "foo() must never bar()",
        metadata: { enforce: "soft" },
      }),
    ).toBe("soft");
  });

  it("CLAMPS enumeration invariants to advisory even with enforce:strict", () => {
    // The Seer error-reporting cluster lesson: never hard-gate on "you added a
    // new enum member".
    expect(
      enforcementLevel({
        title: "silencing rules",
        content: "which error types are silenced and why",
        metadata: { enforce: "strict" },
      }),
    ).toBe("advisory");
  });
});

function mkFinding(over: Partial<Finding> = {}): Finding {
  return {
    invariantId: "id-1",
    invariantTitle: "node:sqlite import boundary",
    invariantContent:
      "node:sqlite must never be imported outside driver.node.ts",
    file: "src/a.ts",
    similarity: 0.9,
    refHit: false,
    reason: "adds a node:sqlite import",
    hunk: "@@",
    severity: "soft",
    ...over,
  };
}

describe("parseOverrides", () => {
  it("parses em-dash, hyphen, and colon separators", () => {
    const msgs = [
      "fix: something\n\nlore-override: node:sqlite import boundary — vendored shim, reviewed",
      "chore\n\nlore-override: Auth precedence -- intentional reorder for OAuth",
      "lore-override: silencing rules: extending the set on purpose",
    ];
    const o = parseOverrides(msgs);
    expect(o).toHaveLength(3);
    expect(o[0]).toEqual({
      target: "node:sqlite import boundary",
      reason: "vendored shim, reviewed",
    });
    expect(o[1].target).toBe("Auth precedence");
    expect(o[2].reason).toBe("extending the set on purpose");
  });

  it("drops a target with no reason (a bare mute is not a decision)", () => {
    expect(parseOverrides(["lore-override: some invariant"])).toEqual([]);
    expect(parseOverrides(["lore-override: some invariant — "])).toEqual([]);
  });

  it("is idempotent — the same trailer in two commits yields one override", () => {
    const line = "lore-override: X — because reasons";
    expect(parseOverrides([line, line])).toHaveLength(1);
  });

  it("ignores non-trailer lines", () => {
    expect(parseOverrides(["just a normal commit\nwith a body"])).toEqual([]);
  });

  it("colon fallback splits at the LAST colon-space, preserving titles with colons", () => {
    // Title itself contains colon-space; the reason is the trailing segment.
    const o = parseOverrides([
      "lore-override: sync.ts: per-table cursor isolation: intentional change here",
    ]);
    expect(o).toHaveLength(1);
    expect(o[0].target).toBe("sync.ts: per-table cursor isolation");
    expect(o[0].reason).toBe("intentional change here");
  });
});

describe("overrideMatchesFinding", () => {
  const f = mkFinding();
  it("matches on exact id", () => {
    expect(overrideMatchesFinding({ target: "id-1", reason: "r" }, f)).toBe(
      true,
    );
  });
  it("matches on case-insensitive title substring (either direction)", () => {
    expect(
      overrideMatchesFinding({ target: "NODE:SQLITE import", reason: "r" }, f),
    ).toBe(true);
    expect(
      overrideMatchesFinding(
        { target: "the node:sqlite import boundary rule", reason: "r" },
        f,
      ),
    ).toBe(true);
  });
  it("does not match an unrelated target", () => {
    expect(
      overrideMatchesFinding({ target: "auth precedence", reason: "r" }, f),
    ).toBe(false);
  });
  it("empty target never matches", () => {
    expect(overrideMatchesFinding({ target: "  ", reason: "r" }, f)).toBe(
      false,
    );
  });

  it("rejects a SHORT generic substring target (no accidental blanket clear)", () => {
    // "rule" appears in the title but is too short/generic to be a real target.
    expect(overrideMatchesFinding({ target: "rule", reason: "r" }, f)).toBe(
      false,
    );
    // "auth" (title of some OTHER short finding) must not be cleared by a long
    // unrelated target that happens to contain it.
    const shortTitle = mkFinding({ invariantTitle: "auth" });
    expect(
      overrideMatchesFinding(
        { target: "oauth flow rewrite for the login page", reason: "r" },
        shortTitle,
      ),
    ).toBe(false);
  });

  it("honors an EXACT short title match regardless of length", () => {
    const shortTitle = mkFinding({ invariantTitle: "auth" });
    expect(
      overrideMatchesFinding({ target: "auth", reason: "r" }, shortTitle),
    ).toBe(true);
  });
});

describe("gateDecision", () => {
  const strict = mkFinding({
    severity: "strict",
    invariantTitle: "strict rule",
  });
  const soft = mkFinding({ severity: "soft", invariantTitle: "soft rule" });
  const adv = mkFinding({ severity: "advisory", invariantTitle: "adv rule" });

  it("advisory mode NEVER blocks — exit 0 even with strict findings", () => {
    const r = gateDecision([strict, soft, adv], [], "advisory");
    expect(r.exitCode).toBe(0);
    // ...but it still classifies what WOULD block.
    expect(r.blocking).toHaveLength(2); // strict + un-overridden soft
    expect(r.advisory).toHaveLength(1);
  });

  it("gate mode blocks on strict (non-overridable)", () => {
    const r = gateDecision(
      [strict],
      [{ target: "strict rule", reason: "I really want to" }],
      "gate",
    );
    // Strict cannot be overridden.
    expect(r.exitCode).toBe(2);
    expect(r.blocking).toHaveLength(1);
    expect(r.overridden).toHaveLength(0);
  });

  it("gate mode blocks un-overridden soft, clears overridden soft", () => {
    const blocked = gateDecision([soft], [], "gate");
    expect(blocked.exitCode).toBe(2);
    expect(blocked.blocking).toHaveLength(1);

    const cleared = gateDecision(
      [soft],
      [{ target: "soft rule", reason: "intentional" }],
      "gate",
    );
    expect(cleared.exitCode).toBe(0);
    expect(cleared.blocking).toHaveLength(0);
    expect(cleared.overridden).toHaveLength(1);
    expect(cleared.overridden[0].override.reason).toBe("intentional");
  });

  it("gate mode never blocks on advisory findings", () => {
    const r = gateDecision([adv], [], "gate");
    expect(r.exitCode).toBe(0);
    expect(r.advisory).toHaveLength(1);
  });

  it("an override with no reason does NOT clear a soft finding", () => {
    // parseOverrides drops these, but gateDecision must be defensive too.
    const r = gateDecision(
      [soft],
      [{ target: "soft rule", reason: "  " }],
      "gate",
    );
    expect(r.exitCode).toBe(2);
    expect(r.blocking).toHaveLength(1);
  });

  it("mixed: strict blocks even when the soft beside it is overridden", () => {
    const r = gateDecision(
      [strict, soft],
      [{ target: "soft rule", reason: "ok" }],
      "gate",
    );
    expect(r.exitCode).toBe(2);
    expect(r.blocking).toEqual([strict]);
    expect(r.overridden).toHaveLength(1);
  });
});

describe("clusterHunks", () => {
  it("collapses near-identical hunks into one cluster", () => {
    const vecs = [v(1, 0, 0), v(0.99, 0.01, 0), v(0, 1, 0)];
    const clusters = clusterHunks(vecs, 0.92);
    expect(clusters).toHaveLength(2);
    const rep0 = clusters.find((c) => c.repIdx === 0)!;
    expect(rep0.memberIdxs.sort((a, b) => a - b)).toEqual([0, 1]);
    const rep2 = clusters.find((c) => c.repIdx === 2)!;
    expect(rep2.memberIdxs).toEqual([2]);
  });

  it("keeps distinct hunks in separate clusters", () => {
    const vecs = [v(1, 0, 0), v(0, 1, 0), v(0, 0, 1)];
    expect(clusterHunks(vecs, 0.92)).toHaveLength(3);
  });

  it("treats null-vector hunks as their own cluster", () => {
    const vecs = [v(1, 0, 0), null, v(1, 0, 0)];
    const clusters = clusterHunks(vecs, 0.92);
    // hunk 1 (null) is its own cluster; 0 and 2 cluster together.
    expect(clusters).toHaveLength(2);
    expect(
      clusters.some(
        (c) => c.memberIdxs.includes(1) && c.memberIdxs.length === 1,
      ),
    ).toBe(true);
  });
});

describe("selectCandidates", () => {
  function inv(refFiles: string[], vec: Float32Array | null): InvariantVec {
    return {
      entry: {
        id: "x",
        logical_id: "x",
        title: "t",
        content: "c",
        confidence: 0.9,
      } as never,
      vec,
      refFiles: new Set(refFiles),
    };
  }
  const hunks: DiffHunk[] = [
    { file: "a.ts", text: "@@a" },
    { file: "b.ts", text: "@@b" },
  ];

  it("always includes ref-hits even when cosine is below the floor", () => {
    const hunkVecs = [v(1, 0, 0), v(0, 1, 0)];
    const clusters = clusterHunks(hunkVecs, 0.92);
    const invariants = [inv(["a.ts"], v(0, 0, 1))]; // orthogonal but ref-hits a.ts
    const sel = selectCandidates(clusters, hunkVecs, invariants, hunks, {
      floor: 0.72,
    });
    // a.ts gets the ref-hit; b.ts has no admission.
    expect(sel.some((c) => c.hunkIdx === 0 && c.refHit)).toBe(true);
    expect(sel.every((c) => c.hunkIdx !== 1)).toBe(true);
  });

  it("spreads the budget across distinct hunks (round-robin, coverage)", () => {
    const hunkVecs = [v(1, 0, 0), v(0, 1, 0)];
    const clusters = clusterHunks(hunkVecs, 0.92);
    // Two invariants near hunk 0, one near hunk 1.
    const invariants = [
      inv([], v(1, 0, 0)),
      inv([], v(0.99, 0.01, 0)),
      inv([], v(0, 1, 0)),
    ];
    const sel = selectCandidates(clusters, hunkVecs, invariants, hunks, {
      floor: 0.72,
      cap: 2,
    });
    // With cap=2 and round-robin, both hunks should be represented, not two
    // for hunk 0 only.
    expect(sel).toHaveLength(2);
    expect(new Set(sel.map((c) => c.hunkIdx))).toEqual(new Set([0, 1]));
  });

  it("respects the cap", () => {
    const hunkVecs = [v(1, 0, 0)];
    const clusters = clusterHunks(hunkVecs, 0.92);
    const invariants = [
      inv([], v(1, 0, 0)),
      inv([], v(0.99, 0.01, 0)),
      inv([], v(0.98, 0.02, 0)),
    ];
    const sel = selectCandidates(clusters, hunkVecs, invariants, hunks, {
      floor: 0.72,
      perHunk: 5,
      cap: 2,
    });
    expect(sel.length).toBeLessThanOrEqual(2);
  });
});

describe("changedFiles", () => {
  it("collects the unique file set", () => {
    expect(
      [
        ...changedFiles([
          { file: "a.ts", text: "@@" },
          { file: "b.ts", text: "@@" },
          { file: "a.ts", text: "@@" },
        ]),
      ].sort(),
    ).toEqual(["a.ts", "b.ts"]);
  });
});

describe("parseInvariantVerdict", () => {
  it("parses a plain JSON verdict", () => {
    expect(parseInvariantVerdict('{"violates": true, "reason": "x"}')).toEqual({
      violates: true,
      reason: "x",
    });
  });
  it("strips ```json fences", () => {
    expect(parseInvariantVerdict('```json\n{"violates": false}\n```')).toEqual({
      violates: false,
      reason: null,
    });
  });
  it("returns null for junk / non-JSON / missing field", () => {
    expect(parseInvariantVerdict(null)).toBeNull();
    expect(parseInvariantVerdict("not json")).toBeNull();
    expect(parseInvariantVerdict('{"reason": "no verdict field"}')).toBeNull();
  });
});

describe("checkInvariants (funnel, stubbed LLM)", () => {
  it("flags a hunk that the judge says violates a cosine-near invariant", async () => {
    const project = "/tmp/ic-test-proj-1";
    // Invariant embedded at a specific vector; the hunk will be embedded at the
    // same vector so it clears the cosine floor (Stage 1).
    await seed(
      project,
      "node:sqlite import boundary",
      "node:sqlite must never be imported outside driver.node.ts",
      v(1, 0, 0),
    );

    // Diff parse + hunk embedding are the two seams we stub.
    // Hunk embeds to the same vector as the invariant → high cosine.
    vi.spyOn(embedding, "embedInTokenBatches").mockResolvedValue([v(1, 0, 0)]);
    const hunks = [
      { file: "src/other.ts", text: '@@\n+import { X } from "node:sqlite"' },
    ];

    const { llm, prompt } = stubLLM(() =>
      JSON.stringify({
        violates: true,
        reason: "adds node:sqlite import outside driver.node.ts",
      }),
    );

    const result = await checkInvariants({
      projectPath: project,
      hunks,
      range: FAKE_RANGE,
      llm,
      sessionID: "s1",
    });

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].file).toBe("src/other.ts");
    expect(result.findings[0].reason).toContain("node:sqlite");
    expect(result.judgeCalls).toBe(1);
  });

  it("does NOT flag when the judge says no violation", async () => {
    const project = "/tmp/ic-test-proj-2";
    await seed(
      project,
      "tabs rule",
      "always use tabs for indentation",
      v(1, 0, 0),
    );
    vi.spyOn(embedding, "embedInTokenBatches").mockResolvedValue([v(1, 0, 0)]);
    const { llm, prompt } = stubLLM(() =>
      JSON.stringify({ violates: false, reason: "docs change, unrelated" }),
    );
    const result = await checkInvariants({
      projectPath: project,
      hunks: [{ file: "README.md", text: "@@\n+some docs" }],
      range: FAKE_RANGE,
      llm,
      sessionID: "s2",
    });
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(result.findings).toHaveLength(0);
  });

  it("makes ZERO judge calls when nothing clears the funnel (cost floor)", async () => {
    const project = "/tmp/ic-test-proj-3";
    // Invariant vector orthogonal to the hunk vector, no ref overlap.
    await seed(
      project,
      "far invariant",
      "something totally unrelated",
      v(0, 1, 0),
    );
    vi.spyOn(embedding, "embedInTokenBatches").mockResolvedValue([v(1, 0, 0)]); // orthogonal
    const { llm, prompt } = stubLLM(() => "{}");
    const result = await checkInvariants({
      projectPath: project,
      hunks: [{ file: "src/zzz.ts", text: "@@\n+unrelated change" }],
      range: FAKE_RANGE,
      llm,
      sessionID: "s3",
    });
    expect(prompt).not.toHaveBeenCalled();
    expect(result.judgeCalls).toBe(0);
    expect(result.candidates).toBe(0);
  });

  it("admits a candidate via a ref hit even when cosine is low", async () => {
    const project = "/tmp/ic-test-proj-4";
    // Invariant cites a file:line; the diff touches that exact file. Cosine is
    // orthogonal, so ONLY the Stage-0 ref gate can admit it.
    await seed(
      project,
      "driver import rule",
      "see `packages/core/src/driver.node.ts:42` — never import node:sqlite elsewhere",
      v(0, 1, 0),
    );
    vi.spyOn(embedding, "embedInTokenBatches").mockResolvedValue([v(1, 0, 0)]); // orthogonal
    const { llm, prompt } = stubLLM(() =>
      JSON.stringify({ violates: false, reason: "ok" }),
    );
    const result = await checkInvariants({
      projectPath: project,
      hunks: [
        { file: "packages/core/src/driver.node.ts", text: "@@\n+something" },
      ],
      range: FAKE_RANGE,
      llm,
      sessionID: "s4",
    });
    // Ref hit admitted the pair despite orthogonal cosine → judge was called.
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(result.candidates).toBe(1);
  });

  it("fans a violation out to all near-duplicate hunks with ONE judge call", async () => {
    const project = "/tmp/ic-test-proj-5";
    await seed(
      project,
      "node:sqlite import boundary",
      "node:sqlite must never be imported outside driver.node.ts",
      v(1, 0, 0),
    );
    // Two near-identical hunks (same import added in two files) + embed maps
    // both to the same vector as the invariant → one cluster, high cosine.
    vi.spyOn(embedding, "embedInTokenBatches").mockResolvedValue([
      v(1, 0, 0),
      v(1, 0, 0),
    ]);
    const { llm, prompt } = stubLLM(() =>
      JSON.stringify({ violates: true, reason: "adds node:sqlite import" }),
    );
    const result = await checkInvariants({
      projectPath: project,
      hunks: [
        { file: "src/a.ts", text: '@@\n+import "node:sqlite"' },
        { file: "src/b.ts", text: '@@\n+import "node:sqlite"' },
      ],
      range: FAKE_RANGE,
      llm,
      sessionID: "s5",
    });
    // Exactly ONE judge call (only the cluster representative)...
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(result.judgeCalls).toBe(1);
    // ...but BOTH files are flagged (verdict fanned out to cluster members).
    expect(result.findings).toHaveLength(2);
    expect(result.findings.map((f) => f.file).sort()).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
  });

  it("dedups the same invariant flagged across multiple hunks of ONE file", async () => {
    const project = "/tmp/ic-test-proj-6";
    await seed(
      project,
      "silencing rules",
      "error-reporting.ts classifySilenced() must only silence which error types are listed here: OutputError, network_error",
      v(1, 0, 0),
    );
    // Two DISTINCT hunks (different vectors → separate clusters, each judged)
    // but both in the SAME file, both flagged against the same invariant. Both
    // clear the cosine floor vs the invariant (v(1,0,0)) yet are far enough
    // apart (cos ≈ 0.76 < 0.92) to NOT cluster together.
    vi.spyOn(embedding, "embedInTokenBatches").mockResolvedValue([
      v(1, 0.4, 0),
      v(1, 0, 0.7),
    ]);
    const { llm } = stubLLM(() =>
      JSON.stringify({ violates: true, reason: "extends the silenced set" }),
    );
    const result = await checkInvariants({
      projectPath: project,
      hunks: [
        { file: "src/lib/error-reporting.ts", text: "@@\n+first change" },
        { file: "src/lib/error-reporting.ts", text: "@@\n+second change" },
      ],
      range: FAKE_RANGE,
      llm,
      sessionID: "s6",
    });
    // One drift per (invariant, file) — NOT one per hunk.
    expect(result.findings).toHaveLength(1);
    // Enumeration invariant → advisory severity even though prescriptive.
    expect(result.findings[0].severity).toBe("advisory");
  });
});
