import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  MAX_DIFF_HUNKS,
  MAX_DIFF_TEXT_BYTES,
  MAX_GIT_OUTPUT_BYTES,
  MAX_HUNK_TEXT_BYTES,
  overrideMatchesFinding,
  parseDiffResult,
  parseInvariantVerdict,
  parseOverrides,
  selectCandidates,
  splitDiff,
  type DiffHunk,
  type Finding,
  type InvariantJudge,
  type InvariantVec,
  type JudgeOutcome,
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

function stubJudge(
  responder: (
    input: Parameters<InvariantJudge["judge"]>[0],
    call: number,
  ) => JudgeOutcome,
): { judge: InvariantJudge; judgeCall: ReturnType<typeof vi.fn> } {
  let calls = 0;
  const judgeCall = vi.fn(
    async (input: Parameters<InvariantJudge["judge"]>[0]) =>
      responder(input, ++calls),
  );
  return { judge: { judge: judgeCall }, judgeCall };
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

async function seedCandidateSet(
  projectPath: string,
  count: number,
): Promise<DiffHunk[]> {
  const invariantVec = new Float32Array(count + 1);
  invariantVec[0] = 1;
  await seed(
    projectPath,
    "shared transport boundary",
    "dispatchRequest() must never bypass the shared transport boundary",
    invariantVec,
  );

  const hunkVecs = Array.from({ length: count }, (_, index) => {
    const vec = new Float32Array(count + 1);
    // Unit length: cosine with invariant = 0.8 (admitted), while two distinct
    // hunks have dot=0.64 (not duplicate-clustered).
    vec[0] = 0.8;
    vec[index + 1] = 0.6;
    return vec;
  });
  vi.spyOn(embedding, "embedInTokenBatches").mockResolvedValue(hunkVecs);
  return hunkVecs.map((_, index) => ({
    file: `src/candidate-${index + 1}.ts`,
    text: `@@\n+dispatchRequest(${index + 1})`,
  }));
}

const FAKE_RANGE: ResolvedRange = {
  base: "aaaa",
  head: "bbbb",
  source: "test",
};

function initGitRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "lore-large-diff-"));
  execFileSync("git", ["init", "--quiet"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: repo,
  });
  execFileSync("git", ["config", "user.name", "Lore Test"], { cwd: repo });
  return repo;
}

function commitAll(repo: string, message: string): string {
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync(
    "git",
    [
      "-c",
      "commit.gpgSign=false",
      "commit",
      "--quiet",
      "--no-verify",
      "-m",
      message,
    ],
    { cwd: repo },
  );
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repo,
    encoding: "utf8",
  }).trim();
}

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

  it("does not treat a +++ b/.lore.md line inside a source hunk as metadata", () => {
    const raw = [
      "diff --git a/src/parser.ts b/src/parser.ts",
      "--- a/src/parser.ts",
      "+++ b/src/parser.ts",
      "@@ -1 +1,2 @@",
      " const marker = true;",
      // An added source line beginning with `++ b/` has this exact raw diff
      // shape. It must remain hunk content, not spoof the ignored file path.
      "+++ b/.lore.md",
    ].join("\n");

    expect(splitDiff(raw)).toEqual([
      {
        file: "src/parser.ts",
        text: "@@ -1 +1,2 @@\n const marker = true;\n+++ b/.lore.md",
      },
    ]);
  });
});

describe("parseDiffResult", () => {
  it("bounds hunks from diffs larger than Node's default buffer before judging", async () => {
    const repo = initGitRepo();
    try {
      writeFileSync(join(repo, "large.txt"), "");
      const base = commitAll(repo, "base");

      writeFileSync(join(repo, "large.txt"), `${"x".repeat(1_100_000)}\n`);
      const head = commitAll(repo, "large diff");

      const result = parseDiffResult(repo, base, head);
      expect(result.kind).toBe("success");
      if (result.kind === "success") {
        expect(result.hunks).toHaveLength(1);
        expect(result.hunks[0].file).toBe("large.txt");
        expect(Buffer.byteLength(result.hunks[0].text)).toBeLessThanOrEqual(
          MAX_HUNK_TEXT_BYTES,
        );
        expect(result.hunks[0].text).toContain("hunk truncated by Lore");

        await seed(
          repo,
          "large file boundary",
          "large.txt must never bypass the shared boundary",
          v(1, 0, 0),
        );
        vi.spyOn(embedding, "embedInTokenBatches").mockResolvedValue([
          v(1, 0, 0),
        ]);
        const { judge, judgeCall } = stubJudge(() => ({
          kind: "verdict",
          verdict: "satisfies",
          reason: "bounded",
          stats: { semanticCalls: 1, transportAttempts: 1 },
        }));
        await checkInvariants({
          projectPath: repo,
          diff: result,
          range: { base, head, source: "test" },
          judge,
          sessionID: "large-real-git-hunk",
        });
        expect(judgeCall).toHaveBeenCalledWith(
          expect.objectContaining({ hunk: result.hunks[0].text }),
        );
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("returns diff-too-large before embedding excessive hunk counts", () => {
    const repo = initGitRepo();
    try {
      const blocks = Array.from({ length: MAX_DIFF_HUNKS + 1 }, (_, index) =>
        [
          `old-${index}`,
          ...Array.from(
            { length: 7 },
            (__, offset) => `context-${index}-${offset}`,
          ),
        ].join("\n"),
      );
      writeFileSync(join(repo, "many.txt"), `${blocks.join("\n")}\n`);
      const base = commitAll(repo, "base");
      writeFileSync(
        join(repo, "many.txt"),
        `${blocks.map((block, index) => block.replace(`old-${index}`, `new-${index}`)).join("\n")}\n`,
      );
      const head = commitAll(repo, "many hunks");

      expect(parseDiffResult(repo, base, head)).toMatchObject({
        kind: "failure",
        failure: { code: "diff-too-large" },
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("keeps aggregate parsed hunk text bounded", () => {
    const hunkCount = Math.floor(MAX_DIFF_TEXT_BYTES / MAX_HUNK_TEXT_BYTES) + 1;
    const raw = Array.from(
      { length: hunkCount },
      (_, index) =>
        `diff --git a/file-${index}.txt b/file-${index}.txt\n--- a/file-${index}.txt\n+++ b/file-${index}.txt\n@@ -0,0 +1 @@\n+${"x".repeat(MAX_HUNK_TEXT_BYTES)}`,
    ).join("\n");

    expect(() => splitDiff(raw)).toThrow(/parsed text bytes/);
  });

  it("rejects Git output above the 16 MiB security ceiling", () => {
    const repo = initGitRepo();
    try {
      writeFileSync(join(repo, "oversized.txt"), "");
      const base = commitAll(repo, "base");
      writeFileSync(
        join(repo, "oversized.txt"),
        `${"x".repeat(MAX_GIT_OUTPUT_BYTES + 1024)}\n`,
      );
      const head = commitAll(repo, "oversized diff");

      expect(parseDiffResult(repo, base, head)).toMatchObject({
        kind: "failure",
        failure: { code: "diff-command-failed" },
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
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
    expect(
      parseInvariantVerdict('{"verdict": "violates", "reason": "x"}'),
    ).toEqual({ verdict: "violates", reason: "x" });
  });
  it("parses each of the four verdict categories", () => {
    for (const v of ["violates", "fixes", "satisfies", "unrelated"] as const) {
      expect(parseInvariantVerdict(`{"verdict":"${v}","reason":"ok"}`)).toEqual(
        {
          verdict: v,
          reason: "ok",
        },
      );
    }
  });
  it("returns null for an unknown verdict string (not coerced to satisfies)", () => {
    // An unknown verdict must NOT be silently coerced to a non-finding —
    // surface the failure so a drift in the model's vocabulary is visible.
    expect(parseInvariantVerdict('{"verdict":"probably_violates"}')).toBeNull();
  });
  it("strips ```json fences", () => {
    expect(
      parseInvariantVerdict(
        '```json\n{"verdict": "satisfies", "reason": "consistent"}\n```',
      ),
    ).toEqual({ verdict: "satisfies", reason: "consistent" });
  });
  it("returns null for junk, missing fields, and invalid field types", () => {
    expect(parseInvariantVerdict(null)).toBeNull();
    expect(parseInvariantVerdict("not json")).toBeNull();
    expect(parseInvariantVerdict('{"reason": "no verdict field"}')).toBeNull();
    expect(parseInvariantVerdict("{}")).toBeNull();
    expect(
      parseInvariantVerdict('{"verdict": 42, "reason": "wrong type"}'),
    ).toBeNull();
  });
  it("rejects JSON embedded in prose or followed by trailing prose", () => {
    expect(
      parseInvariantVerdict(
        'Sure: {"verdict":"unrelated","reason":"different scope"}',
      ),
    ).toBeNull();
    expect(
      parseInvariantVerdict(
        '{"verdict":"fixes","reason":"moves payload"}\nDone.',
      ),
    ).toBeNull();
  });
  it("requires exactly verdict+reason and a bounded non-empty reason", () => {
    expect(
      parseInvariantVerdict(
        '{"verdict":"satisfies","reason":"ok","extra":true}',
      ),
    ).toBeNull();
    expect(
      parseInvariantVerdict('{"verdict":"satisfies","reason":"   "}'),
    ).toBeNull();
    expect(
      parseInvariantVerdict(
        JSON.stringify({ verdict: "satisfies", reason: "x".repeat(401) }),
      ),
    ).toBeNull();
  });
  it("rejects legacy booleans and incomplete or non-json fences", () => {
    expect(
      parseInvariantVerdict('{"violates":true,"reason":"legacy"}'),
    ).toBeNull();
    expect(
      parseInvariantVerdict('```\n{"verdict":"satisfies","reason":"ok"}\n```'),
    ).toBeNull();
    expect(
      parseInvariantVerdict('```json\n{"verdict":"satisfies","reason":"ok"}'),
    ).toBeNull();
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
        verdict: "violates",
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
      JSON.stringify({ verdict: "unrelated", reason: "docs change" }),
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

  it("repairs invalid prose once, then records an unresolved candidate", async () => {
    const project = "/tmp/ic-test-proj-unparseable";
    await seed(
      project,
      "sqlite boundary",
      "node:sqlite must never be imported outside driver.node.ts",
      v(1, 0, 0),
    );
    vi.spyOn(embedding, "embedInTokenBatches").mockResolvedValue([v(1, 0, 0)]);
    // Both initial and repair calls violate the exact whole-response schema.
    const { llm, prompt } = stubLLM(
      () => "I don't think this violates anything, looks fine to me.",
    );
    const result = await checkInvariants({
      projectPath: project,
      hunks: [{ file: "src/other.ts", text: '@@\n+import "node:sqlite"' }],
      range: FAKE_RANGE,
      llm,
      sessionID: "s-unparseable",
    });
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(result.judgeCalls).toBe(2);
    expect(result.unparseable).toBe(1);
    expect(result.unresolved).toBe(1);
    expect(result.status).toBe("failed");
    expect(result.health.judge.status).toBe("failed");
    expect(result.candidateOutcomes[0]).toMatchObject({
      state: "unresolved",
      failure: { code: "invalid-verdict", scope: "candidate" },
      stats: { semanticCalls: 2, transportAttempts: 2 },
    });
    expect(result.findings).toHaveLength(0);
  });

  it("records null text as an explicit empty-response failure", async () => {
    const project = "/tmp/ic-test-proj-null-text";
    await seed(
      project,
      "sqlite boundary",
      "node:sqlite must never be imported outside driver.node.ts",
      v(1, 0, 0),
    );
    vi.spyOn(embedding, "embedInTokenBatches").mockResolvedValue([v(1, 0, 0)]);
    const { llm } = stubLLM(() => null);

    const result = await checkInvariants({
      projectPath: project,
      hunks: [{ file: "src/other.ts", text: '@@\n+import "node:sqlite"' }],
      range: FAKE_RANGE,
      llm,
      sessionID: "s-null-text",
      model: { providerID: "github-copilot", modelID: "gpt-5.6-luna" },
    });

    expect(result.unparseable).toBe(1);
    expect(result.status).toBe("failed");
    expect(result.candidateOutcomes[0]).toMatchObject({
      state: "unresolved",
      failure: { code: "empty-response", scope: "candidate" },
    });
    expect(result.findings).toHaveLength(0);
  });

  it("does not scan prose for JSON and accepts only the exact repair", async () => {
    const project = "/tmp/ic-test-proj-prosejson";
    await seed(
      project,
      "sqlite boundary",
      "node:sqlite must never be imported outside driver.node.ts",
      v(1, 0, 0),
    );
    vi.spyOn(embedding, "embedInTokenBatches").mockResolvedValue([v(1, 0, 0)]);
    let call = 0;
    const { llm, prompt } = stubLLM(() => {
      call++;
      return call === 1
        ? 'Sure: {"verdict":"violates","reason":"adds node:sqlite import"}'
        : '{"verdict":"violates","reason":"adds node:sqlite import"}';
    });
    const result = await checkInvariants({
      projectPath: project,
      hunks: [{ file: "src/other.ts", text: '@@\n+import "node:sqlite"' }],
      range: FAKE_RANGE,
      llm,
      sessionID: "s-prosejson",
    });
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(result.semanticCalls).toBe(2);
    expect(result.unparseable).toBe(0);
    expect(result.resolved).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].reason).toContain("node:sqlite");
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
      JSON.stringify({ verdict: "satisfies", reason: "consistent" }),
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
      JSON.stringify({
        verdict: "violates",
        reason: "adds node:sqlite import",
      }),
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
      JSON.stringify({
        verdict: "violates",
        reason: "extends the silenced set",
      }),
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

  // ---------------------------------------------------------------------
  // Four-verdict round-trip: validates the PR #1490 fix-as-violation class.
  // The binary {violates: boolean} verdict space could not express "this
  // change is the fix", so a fix was reported as a violation. The new
  // {verdict: "violates"|"fixes"|"satisfies"|"unrelated"} frame lets the
  // judge return the correct answer for each outcome.
  // ---------------------------------------------------------------------

  it("a 'fixes' verdict produces NO finding (PR #1490 regression)", async () => {
    // Mirrors PR #1490's invariant: assistant-role knowledge-delta payload
    // must never be visible output. The PR's diff MOVES the payload off the
    // assistant turn — i.e. it IS the fix, but the old binary verdict space
    // forced a "violates: true" response.
    const project = "/tmp/ic-test-proj-fixes";
    await seed(
      project,
      "knowledge-delta assistant-payload visibility",
      "knowledge-delta assistant-role injection must not cause visible dumps; " +
        "the assistant turn must never carry the raw ## Long-term Knowledge payload",
      v(1, 0, 0),
    );
    vi.spyOn(embedding, "embedInTokenBatches").mockResolvedValue([v(1, 0, 0)]);
    const { llm, prompt } = stubLLM(() =>
      JSON.stringify({
        verdict: "fixes",
        reason:
          "moves payload off assistant turn onto user turn; adds migration that rewrites legacy blocks to the new shape; regression-guard test asserts assistant turn never carries the markdown payload",
      }),
    );
    const result = await checkInvariants({
      projectPath: project,
      hunks: [
        // The actual PR #1490 hunks, simplified to the relevant moves.
        {
          file: "src/pipeline.ts",
          text:
            "@@\n" +
            "+function parseDeltaMessages(raw: string): GatewayMessage[] {\n" +
            "+  // Legacy pair: move the assistant payload onto the framing-note user message.\n" +
            '+  return [{ role: "user", content: [...] }, { role: "assistant", content: [{ type: "text", text: "Understood." }] }];\n' +
            "+}",
        },
        {
          file: "src/pipeline.ts",
          text:
            "@@\n" +
            "-      text: rendered + tocRendered,\n" +
            "+      text: KNOWLEDGE_DELTA_ASSISTANT_CLOSER, // inert closer; payload moved to user turn",
        },
      ],
      range: FAKE_RANGE,
      llm,
      sessionID: "s-fixes",
    });
    expect(prompt).toHaveBeenCalledTimes(1);
    // The fix is recognized → NO findings, despite the high cosine match.
    // (Both hunks are pipeline.ts, so the (invariant, file) dedup collapses
    // them into a single representative judge call — that's a separate
    // property of the funnel, not what this test is about.)
    expect(result.findings).toHaveLength(0);
    expect(result.judgeCalls).toBe(1);
  });

  it("a 'satisfies' verdict produces NO finding", async () => {
    const project = "/tmp/ic-test-proj-satisfies";
    await seed(
      project,
      "tabs rule",
      "always use tabs for indentation",
      v(1, 0, 0),
    );
    vi.spyOn(embedding, "embedInTokenBatches").mockResolvedValue([v(1, 0, 0)]);
    const { llm } = stubLLM(() =>
      JSON.stringify({
        verdict: "satisfies",
        reason: "formatting tweak in unrelated function; tabs rule unchanged",
      }),
    );
    const result = await checkInvariants({
      projectPath: project,
      hunks: [{ file: "src/unrelated.ts", text: "@@\n+reformat whitespace" }],
      range: FAKE_RANGE,
      llm,
      sessionID: "s-satisfies",
    });
    expect(result.findings).toHaveLength(0);
  });

  it("an 'unrelated' verdict corrects cosine-prefilter false positives", async () => {
    // Cosine prefilter said "near" (same embedding), but the judge is the
    // last stage of the funnel and can correct the prefilter when the diff
    // doesn't actually touch the invariant's subject/scope.
    const project = "/tmp/ic-test-proj-unrelated";
    await seed(
      project,
      "node:sqlite import boundary",
      "node:sqlite must never be imported outside driver.node.ts",
      v(1, 0, 0),
    );
    vi.spyOn(embedding, "embedInTokenBatches").mockResolvedValue([v(1, 0, 0)]);
    const { llm } = stubLLM(() =>
      JSON.stringify({
        verdict: "unrelated",
        reason:
          "diff renames a helper in the same file but does not import node:sqlite",
      }),
    );
    const result = await checkInvariants({
      projectPath: project,
      hunks: [
        {
          file: "src/driver.node.ts",
          text: "@@\n-const old = foo;\n+const renamed = foo;",
        },
      ],
      range: FAKE_RANGE,
      llm,
      sessionID: "s-unrelated",
    });
    expect(result.findings).toHaveLength(0);
  });

  it("a 'violates' verdict still produces a finding (no recall regression)", async () => {
    const project = "/tmp/ic-test-proj-violates-still-flags";
    await seed(
      project,
      "node:sqlite import boundary",
      "node:sqlite must never be imported outside driver.node.ts",
      v(1, 0, 0),
    );
    vi.spyOn(embedding, "embedInTokenBatches").mockResolvedValue([v(1, 0, 0)]);
    const { llm } = stubLLM(() =>
      JSON.stringify({
        verdict: "violates",
        reason:
          'diff adds `import ... from "node:sqlite"` in a non-driver file',
      }),
    );
    const result = await checkInvariants({
      projectPath: project,
      hunks: [
        { file: "src/other.ts", text: '@@\n+import { X } from "node:sqlite"' },
      ],
      range: FAKE_RANGE,
      llm,
      sessionID: "s-violates",
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].file).toBe("src/other.ts");
  });

  // ---------------------------------------------------------------------
  // Subject/scope disambiguation (PR #1228 regression).
  //
  // The invariant constrains the *compactor's output* ("assembleOfflineCompaction
  // drops raw temporal facts"). PR #1228 added a READ path that surfaces raw
  // temporal messages as context for the model. The judge previously conflated
  // "the change touches raw temporal data" with "the change violates the rule
  // about dropping raw temporal data" — those are NOT the same subject. The
  // read path is in a different scope (assembly of context, not compaction
  // output). The prompt's tightened subject/scope disambiguation should make
  // the judge return "unrelated" or "satisfies", not "violates".
  // ---------------------------------------------------------------------

  it("a change that READS the invariant's subject is not 'violates' (scope check)", async () => {
    const project = "/tmp/ic-test-proj-scope-read";
    await seed(
      project,
      "assembleOfflineCompaction drops raw temporal facts",
      "the compactor must drop raw temporal facts because the distiller can lose concrete values",
      v(1, 0, 0),
    );
    vi.spyOn(embedding, "embedInTokenBatches").mockResolvedValue([v(1, 0, 0)]);
    const { llm } = stubLLM(() =>
      JSON.stringify({
        verdict: "unrelated",
        reason:
          "invariant constrains the compactor's output (assembleOfflineCompaction); " +
          "the diff adds a separate READ path that surfaces raw temporal messages as context " +
          "for the model — different subject/scope, the read path is not governed by the compactor rule",
      }),
    );
    const result = await checkInvariants({
      projectPath: project,
      hunks: [
        {
          file: "packages/core/src/ltm.ts",
          text:
            "@@\n" +
            "+async function loadContextSourceCandidates(pid: string, contextVec: Float32Array, sources: ContextSource[], limit: number) {\n" +
            "+  // Reads raw temporal_messages to surface them as context — NOT the compactor.\n" +
            '+  const rows = db.prepare("SELECT * FROM temporal_messages WHERE ...").all();\n' +
            "+  return rows.map(...);\n" +
            "+}",
        },
      ],
      range: FAKE_RANGE,
      llm,
      sessionID: "s-scope-read",
    });
    expect(result.findings).toHaveLength(0);
  });

  it("passes a self-contained minimum judge budget that survives an empty models.dev cache", async () => {
    // The gateway's `workerReasoningHeadroomFloor` only applies for OpenAI/Gemini
    // protocols when `workerModelReasons(model)` returns true — which itself
    // depends on `getModelEntrySync` returning an entry with non-empty
    // `reasoning_options`. When models.dev is unreachable (CI pre-warm timeout,
    // 503, etc.), `getModelEntrySync` falls back to a stripped entry with no
    // reasoning_options and the floor collapses to 0. Without a self-contained
    // caller maxTokens, the linter's tiny default budget (256 tokens) would be
    // entirely burned on hidden reasoning by OpenAI reasoning models like
    // gpt-5-mini → empty content → "unparseable". The judge MUST therefore pass
    // a budget that wins regardless of the gateway's reasoning-floor logic.
    const captured: Array<{ maxTokens?: number; reasoningEffort?: string }> =
      [];
    const prompt = vi.fn(
      async (
        _system: string,
        _user: string,
        opts?: { maxTokens?: number; reasoningEffort?: string },
      ) => {
        captured.push(opts ?? {});
        return JSON.stringify({ verdict: "satisfies", reason: "consistent" });
      },
    );
    const llm: LLMClient = { prompt };

    for (const effort of [undefined, "off", "low", "medium", "high"] as const) {
      const project = `/tmp/ic-test-proj-budget-floor-${effort ?? "default"}`;
      await seed(
        project,
        "node:sqlite import boundary",
        "node:sqlite must never be imported outside driver.node.ts",
        v(1, 0, 0),
      );
      vi.spyOn(embedding, "embedInTokenBatches").mockResolvedValue([
        v(1, 0, 0),
      ]);
      captured.length = 0;
      await checkInvariants({
        projectPath: project,
        hunks: [
          {
            file: "src/other.ts",
            text: '@@\n+import { X } from "node:sqlite"',
          },
        ],
        range: FAKE_RANGE,
        llm,
        sessionID: `s-budget-${effort ?? "default"}`,
        ...(effort !== undefined ? { effort } : {}),
      });
      expect(captured).toHaveLength(1);
      // Floor MUST clear 25600 so the verdict is parseable even with no models.dev data.
      expect(captured[0].maxTokens).toBeGreaterThanOrEqual(25_600);
    }
  });
});

describe("checkInvariants typed judge outcomes", () => {
  it.each([
    {
      name: "zero hunks",
      projectPath: "/tmp/ic-test-aborted-zero-hunks",
      hunks: [] as DiffHunk[],
    },
    {
      name: "zero enforceable invariants",
      projectPath: "/tmp/ic-test-aborted-zero-invariants",
      hunks: [{ file: "src/a.ts", text: "@@\n+const value = 1;" }],
    },
  ])("does not report healthy for $name after abort", async (input) => {
    const controller = new AbortController();
    const reason = new DOMException(
      "Semantic lint deadline exceeded",
      "TimeoutError",
    );
    controller.abort(reason);

    await expect(
      checkInvariants({
        projectPath: input.projectPath,
        hunks: input.hunks,
        range: FAKE_RANGE,
        sessionID: `typed-aborted-${input.name}`,
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
  });

  it("keeps diff command failure distinct from a healthy empty diff", async () => {
    const result = await checkInvariants({
      projectPath: "/tmp/ic-test-diff-failure",
      diff: {
        kind: "failure",
        failure: {
          code: "diff-command-failed",
          message: "unknown revision",
        },
      },
      range: FAKE_RANGE,
      sessionID: "typed-diff-failure",
    });

    expect(result.status).toBe("failed");
    expect(result.health).toMatchObject({
      diff: {
        status: "failed",
        failure: { code: "diff-command-failed" },
      },
      invariantVectors: { status: "not-run" },
      hunkVectors: { status: "not-run" },
      judge: { status: "not-run" },
    });

    const empty = await checkInvariants({
      projectPath: "/tmp/ic-test-empty-diff",
      diff: { kind: "success", hunks: [] },
      range: FAKE_RANGE,
      sessionID: "typed-empty-diff",
    });
    expect(empty.status).toBe("complete");
    expect(empty.health.diff.status).toBe("healthy");
    expect(empty.health.judge.status).toBe("healthy");
  });

  it("fails explicitly when all non-empty hunk vectors are unavailable", async () => {
    const project = "/tmp/ic-test-hunk-vector-failure";
    await seed(
      project,
      "shared transport boundary",
      "dispatchRequest() must never bypass the shared transport boundary",
      v(1, 0, 0),
    );
    vi.spyOn(embedding, "embedInTokenBatches").mockRejectedValue(
      new Error("embed worker unavailable"),
    );
    const { judge, judgeCall } = stubJudge(() => ({
      kind: "verdict",
      verdict: "satisfies",
      reason: "not reached",
      stats: { semanticCalls: 1, transportAttempts: 1 },
    }));

    const result = await checkInvariants({
      projectPath: project,
      hunks: [{ file: "src/a.ts", text: "@@\n+dispatchRequest()" }],
      range: FAKE_RANGE,
      judge,
      sessionID: "typed-hunk-vector-failure",
    });

    expect(judgeCall).not.toHaveBeenCalled();
    expect(result.status).toBe("failed");
    expect(result.health.hunkVectors).toMatchObject({
      status: "failed",
      expected: 1,
      available: 0,
      missing: 1,
      failure: { code: "hunk-vector-embedding-failed" },
    });
    expect(result.health.judge.status).toBe("not-run");
  });

  it("returns failed health promptly when in-flight hunk embedding exceeds its deadline", async () => {
    const project = "/tmp/ic-test-hunk-vector-deadline";
    await seed(
      project,
      "shared transport boundary",
      "dispatchRequest() must never bypass the shared transport boundary",
      v(1, 0, 0),
    );
    vi.spyOn(embedding, "embedInTokenBatches").mockImplementation(
      () => new Promise<Float32Array[]>(() => {}),
    );

    const result = await checkInvariants({
      projectPath: project,
      hunks: [{ file: "src/a.ts", text: "@@\n+dispatchRequest()" }],
      range: FAKE_RANGE,
      sessionID: "typed-hunk-vector-deadline",
      deadlineMs: 10,
    });

    expect(result.status).toBe("failed");
    expect(result.health.hunkVectors).toMatchObject({
      status: "failed",
      failure: {
        code: "hunk-vector-embedding-failed",
        message: "Hunk embedding deadline exceeded",
      },
    });
    expect(result.health.judge.status).toBe("not-run");
  });

  it("reports a healthy run only when every selected candidate resolves", async () => {
    const project = "/tmp/ic-test-typed-healthy";
    const hunks = await seedCandidateSet(project, 3);
    const { judge, judgeCall } = stubJudge(() => ({
      kind: "verdict",
      verdict: "satisfies",
      reason: "The shared transport remains in use",
      stats: { semanticCalls: 1, transportAttempts: 2 },
    }));

    const result = await checkInvariants({
      projectPath: project,
      hunks,
      range: FAKE_RANGE,
      judge,
      sessionID: "typed-healthy",
    });

    expect(judgeCall).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({
      status: "complete",
      candidates: 3,
      attempted: 3,
      resolved: 3,
      unresolved: 0,
      notAttempted: 0,
      semanticCalls: 3,
      transportAttempts: 6,
    });
    expect(result.health.judge.status).toBe("healthy");
    expect(result.candidateOutcomes.every((o) => o.state === "resolved")).toBe(
      true,
    );
    expect(new Set(result.candidateOutcomes.map((o) => o.id)).size).toBe(3);
  });

  it("fails health when all selected candidates are unresolved", async () => {
    const project = "/tmp/ic-test-typed-unresolved";
    const hunks = await seedCandidateSet(project, 3);
    const { judge } = stubJudge(() => ({
      kind: "unresolved",
      failure: {
        code: "invalid-verdict",
        message: "Repair still had an extra key",
        scope: "candidate",
      },
      stats: { semanticCalls: 2, transportAttempts: 2 },
    }));

    const result = await checkInvariants({
      projectPath: project,
      hunks,
      range: FAKE_RANGE,
      judge,
      sessionID: "typed-unresolved",
    });

    expect(result).toMatchObject({
      status: "failed",
      attempted: 3,
      resolved: 0,
      unresolved: 3,
      notAttempted: 0,
      semanticCalls: 6,
      transportAttempts: 6,
    });
    expect(result.health.judge.status).toBe("failed");
  });

  it("stops after a run-scoped failure and reports a mixed degraded run", async () => {
    const project = "/tmp/ic-test-typed-mixed";
    const hunks = await seedCandidateSet(project, 3);
    const { judge, judgeCall } = stubJudge((_input, call) =>
      call === 1
        ? {
            kind: "verdict",
            verdict: "unrelated",
            reason: "Different request path",
            stats: { semanticCalls: 1, transportAttempts: 1 },
          }
        : {
            kind: "unresolved",
            failure: {
              code: "no-auth",
              message: "No credential is available for the judge",
              scope: "run",
            },
            stats: { semanticCalls: 0, transportAttempts: 0 },
          },
    );

    const result = await checkInvariants({
      projectPath: project,
      hunks,
      range: FAKE_RANGE,
      judge,
      sessionID: "typed-mixed",
    });

    expect(judgeCall).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      status: "partial",
      candidates: 3,
      attempted: 2,
      resolved: 1,
      unresolved: 1,
      notAttempted: 1,
      semanticCalls: 1,
      transportAttempts: 1,
    });
    expect(result.health.judge.status).toBe("degraded");
    expect(result.candidateOutcomes[2]).toMatchObject({
      state: "not-attempted",
      failure: { code: "no-auth", scope: "run" },
      stats: { semanticCalls: 0, transportAttempts: 0 },
    });
  });

  it("caps repairs at 20 semantic calls and accounts for displaced candidates", async () => {
    const project = "/tmp/ic-test-typed-budget";
    const hunks = await seedCandidateSet(project, 20);
    const { judge, judgeCall } = stubJudge((input) => {
      expect(input.semanticCallBudget).toBe(2);
      return {
        kind: "unresolved",
        failure: {
          code: "invalid-verdict",
          message: "Initial and repair responses were invalid",
          scope: "candidate",
        },
        stats: { semanticCalls: 2, transportAttempts: 2 },
      };
    });

    const result = await checkInvariants({
      projectPath: project,
      hunks,
      range: FAKE_RANGE,
      judge,
      sessionID: "typed-budget",
    });

    expect(judgeCall).toHaveBeenCalledTimes(10);
    expect(result).toMatchObject({
      status: "failed",
      candidates: 20,
      attempted: 10,
      resolved: 0,
      unresolved: 10,
      notAttempted: 10,
      semanticCalls: 20,
      transportAttempts: 20,
    });
    expect(
      result.candidateOutcomes
        .slice(10)
        .every(
          (outcome) =>
            outcome.state === "not-attempted" &&
            outcome.failure.code === "semantic-budget-exhausted" &&
            outcome.stats.semanticCalls === 0,
        ),
    ).toBe(true);
    expect(
      result.candidateOutcomes.reduce(
        (sum, outcome) => sum + outcome.stats.semanticCalls,
        0,
      ),
    ).toBe(result.semanticCalls);
    expect(
      result.candidateOutcomes.reduce(
        (sum, outcome) => sum + outcome.stats.transportAttempts,
        0,
      ),
    ).toBe(result.transportAttempts);
  });
});
