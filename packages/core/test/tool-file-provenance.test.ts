import { beforeEach, describe, expect, test } from "vitest";
import { db, ensureProject } from "../src/db";
import * as temporal from "../src/temporal";
import {
  extractFilePaths,
  extractFilePathsFromCommand,
} from "../src/tool-trace";
import type { LoreMessage, LorePart } from "../src/types";

// D2c PR-1 (v75) captured a single path per tool call into tool_calls.input_path.
// D2c PR-1b (v76) widens it to a JSON-encoded string[] (input_paths_json) so a
// single bash command (cat a b c, sed -i a, > b, tee d …) can carry all the
// files it touched. The session's touched files = the union over its tool calls.

describe("extractFilePaths", () => {
  test("reads path from an object input ({ path })", () => {
    expect(extractFilePaths({ path: "src/auth/jwt.ts" })).toEqual([
      "src/auth/jwt.ts",
    ]);
  });

  test("reads filePath and file keys", () => {
    expect(extractFilePaths({ filePath: "a/b.ts" })).toEqual(["a/b.ts"]);
    expect(extractFilePaths({ file: "c/d.ts" })).toEqual(["c/d.ts"]);
  });

  test("prefers path over filePath over file", () => {
    expect(
      extractFilePaths({ path: "p.ts", filePath: "fp.ts", file: "f.ts" }),
    ).toEqual(["p.ts"]);
    expect(extractFilePaths({ filePath: "fp.ts", file: "f.ts" })).toEqual([
      "fp.ts",
    ]);
  });

  test("parses a JSON string input", () => {
    expect(extractFilePaths('{"path":"src/x.ts"}')).toEqual(["src/x.ts"]);
  });

  test("falls back to a path-like token in a plain-text string", () => {
    expect(extractFilePaths("editing packages/core/src/db.ts now")).toEqual([
      "packages/core/src/db.ts",
    ]);
  });

  test("returns [] for non-file tool inputs", () => {
    expect(extractFilePaths({ pattern: "TODO" })).toEqual([]);
    expect(extractFilePaths("just some prose with no path")).toEqual([]);
    expect(extractFilePaths(null)).toEqual([]);
    expect(extractFilePaths(undefined)).toEqual([]);
    expect(extractFilePaths(42)).toEqual([]);
  });

  test("ignores an empty-string path", () => {
    expect(extractFilePaths({ path: "" })).toEqual([]);
  });

  test("a `/`-free string is skipped without running the regex", () => {
    // No slash → cannot be a path → cheap early return (also the ReDoS skip).
    expect(extractFilePaths("no slashes here just prose words")).toEqual([]);
  });

  test("does not stall on a pathological long slash-run (ReDoS guard)", () => {
    // A long run of slash-separated tokens with no matching extension is the
    // super-linear-backtracking worst case for the fallback regex. With the
    // length cap + slash skip this must return promptly, not hang.
    const evil = `${"a/".repeat(50_000)}bbbbbbbbbbbb`;
    const start = Date.now();
    const result = extractFilePaths(evil);
    const elapsed = Date.now() - start;
    expect(result).toEqual([]);
    expect(elapsed).toBeLessThan(1000);
  });

  test("dispatches a `{ command }` object to the bash walker", () => {
    expect(extractFilePaths({ command: "cat src/a.ts src/b.ts" })).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
  });

  test("dispatches a JSON-string `command` field to the bash walker", () => {
    expect(extractFilePaths('{"command":"cat src/c.ts"}')).toEqual([
      "src/c.ts",
    ]);
  });
});

describe("extractFilePathsFromCommand (bash, unbash AST walk)", () => {
  test("cat with multiple operands", () => {
    expect(extractFilePathsFromCommand("cat src/a.ts src/b.ts")).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
  });

  test("redirects: `>` and `>>` targets are file paths", () => {
    expect(extractFilePathsFromCommand("echo x > out.ts")).toEqual(["out.ts"]);
    expect(extractFilePathsFromCommand("echo x >> log/append.txt")).toEqual([
      "log/append.txt",
    ]);
  });

  test("input redirect `< file` is a file path", () => {
    expect(extractFilePathsFromCommand("sort < data/inputs.csv")).toEqual([
      "data/inputs.csv",
    ]);
  });

  test("tee operand is a file path", () => {
    expect(extractFilePathsFromCommand("tee build/out.bin")).toEqual([
      "build/out.bin",
    ]);
  });

  test("chained: `&&` and `;` — both commands contribute (union, order-agnostic)", () => {
    // Note: within a single compound command (`cat y > out`) we report the
    // redirect target AFTER the operands, but when a command CHAIN crosses
    // multiple Commands, the visitor order interleaves redirects from later
    // Commands with operands from earlier ones. We only require that the SET
    // of touched files is correct — provenance is a bag, not a sequence.
    expect(
      new Set(
        extractFilePathsFromCommand("rm old/x.ts && cat src/y.ts > out.ts"),
      ),
    ).toEqual(new Set(["old/x.ts", "src/y.ts", "out.ts"]));
  });

  test("pipe: redirect target on the LAST stage surfaces", () => {
    // `cat src/in.ts | wc -l > out/match.ts` — wc (not grep) as the second
    // stage so the visitor doesn't pick up the pattern-looking word.
    expect(
      new Set(
        extractFilePathsFromCommand("cat src/in.ts | wc -l > out/match.ts"),
      ),
    ).toEqual(new Set(["src/in.ts", "out/match.ts"]));
  });

  test("skip flags (`-i`, `--color=auto`, etc.)", () => {
    // `cat` is the simplest case: `-n` is a flag, operands are files.
    expect(extractFilePathsFromCommand("cat -n src/a.ts src/b.ts")).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
    // `rm` with a short flag cluster.
    expect(extractFilePathsFromCommand("rm -rf build/")).toEqual(["build/"]);
  });

  test("`--in-place` and `--file` style long-opts are not relevant (sed/awk excluded)", () => {
    // We don't model per-tool option tables. The token-eating behavior is only
    // relevant for commands whose long-opts take a value — sed/awk have one,
    // but they're excluded (their first non-flag is a script, not a file).
    // For the commands we DO support (cat/tee/cp/mv/rm/…), no long-opt takes
    // a value that looks like a path, so we can skip the next token safely.
    expect(extractFilePathsFromCommand("cat --number src/a.ts")).toEqual([
      "src/a.ts",
    ]);
  });

  test("non-file-command positional args are skipped", () => {
    // `cd` / `export` / `echo` take no file operands; only their redirect
    // targets (if any) are paths.
    expect(extractFilePathsFromCommand("cd /tmp")).toEqual([]);
    expect(extractFilePathsFromCommand("echo done")).toEqual([]);
  });

  test("de-duplicates while preserving first-seen order", () => {
    expect(
      extractFilePathsFromCommand("cat a/x.ts; cat a/x.ts; cat a/x.ts"),
    ).toEqual(["a/x.ts"]);
    expect(extractFilePathsFromCommand("cat a.ts; cat b.ts; cat a.ts")).toEqual(
      ["a.ts", "b.ts"],
    );
  });

  test("expansions (`$1`, `$(cmd)`, `~`) are skipped — we can't resolve them", () => {
    // The expansion makes the word non-static, so we skip it.
    expect(extractFilePathsFromCommand("cat $1")).toEqual([]);
    expect(extractFilePathsFromCommand("cat $(echo src/a.ts)")).toEqual([]);
    expect(extractFilePathsFromCommand("cat ~/a.ts")).toEqual([]);
  });

  test("bare relative file operands (no `/`) are valid for AST-derived words", () => {
    // A literal `cat db.ts` is a valid relative-path touched file. The slash
    // requirement lives only in the plaintext regex fallback (prose risk); the
    // AST walk knows the token came from a real shell construct.
    expect(extractFilePathsFromCommand("cat db.ts")).toEqual(["db.ts"]);
  });

  test("control flow: `for … do … done` recurses into the body and wordlist", () => {
    // The `for` wordlist (src/a.ts, src/b.ts) is a set of static file paths;
    // each is a touched file. The `cat $f` body is skipped because $f expands.
    expect(
      extractFilePathsFromCommand(
        "for f in src/a.ts src/b.ts; do cat $f; done",
      ),
    ).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("B2: brace-list body is walked", () => {
    // `{ cat a.ts; cat b.ts; }` is a compound list — each statement's
    // command must be visited, not just the outer wrapper.
    expect(extractFilePathsFromCommand("{ cat a.ts; cat b.ts; }")).toEqual([
      "a.ts",
      "b.ts",
    ]);
  });

  test("B2: subshell redirect surfaces both operand and target (set-equal)", () => {
    // `(cat a.ts) > out.ts` — the trailing redirect lives on the outer
    // Statement, not the inner Command.
    expect(new Set(extractFilePathsFromCommand("(cat a.ts) > out.ts"))).toEqual(
      new Set(["a.ts", "out.ts"]),
    );
  });

  test("B2: `if … fi > out.ts` surfaces the body and the trailing redirect", () => {
    expect(
      new Set(
        extractFilePathsFromCommand("if true; then cat a.ts; fi > out.ts"),
      ),
    ).toEqual(new Set(["a.ts", "out.ts"]));
  });

  test("B2: `while … done < input.ts > out.ts` surfaces both redirects", () => {
    expect(
      new Set(
        extractFilePathsFromCommand(
          "while read l; do echo $l; done < input.ts > out.ts",
        ),
      ),
    ).toEqual(new Set(["input.ts", "out.ts"]));
  });

  test("B2: function body is walked", () => {
    expect(extractFilePathsFromCommand("function f { cat a.ts; }; f")).toEqual([
      "a.ts",
    ]);
  });

  test("B3: single-quoted paths are accepted and the quote is stripped", () => {
    // B3 was a type-discriminator typo (`SingleQuotedPart` vs `SingleQuoted`)
    // AND pushing `w.text` (with quotes) instead of `w.value` (without).
    expect(extractFilePathsFromCommand("cat 'db.ts'")).toEqual(["db.ts"]);
    expect(extractFilePathsFromCommand("cat 'src/a.ts'")).toEqual(["src/a.ts"]);
  });

  test("S1: glob metacharacters are NOT treated as literal paths", () => {
    // unbash doesn't tag glob expansions with a part type, so the
    // `parts: undefined` lazy-getter fallback would otherwise treat
    // `src/*` as a static path-shaped token. The glob guard rejects it.
    expect(extractFilePathsFromCommand("cat src/*")).toEqual([]);
    expect(extractFilePathsFromCommand("cat src/*.ts")).toEqual([]);
    expect(extractFilePathsFromCommand("cat [abc].ts")).toEqual([]);
    expect(extractFilePathsFromCommand("cat src/file?.ts")).toEqual([]);
  });

  test("S2: heredoc/herestring targets are NOT file paths", () => {
    // `<<data.txt` target is the heredoc delimiter; `<<<` target is inline
    // content. Both must be skipped, not pushed as a path.
    expect(extractFilePathsFromCommand("cat <<data.txt")).toEqual([]);
    expect(extractFilePathsFromCommand('cat <<<"hi there"')).toEqual([]);
  });

  test("S3: Case clause bodies are walked", () => {
    // The pattern `*.ts) cat src/a.ts ;; esac` puts the body command inside
    // `items[i].body`, which the visitor must descend into.
    expect(
      extractFilePathsFromCommand("case $x in *.ts) cat src/a.ts ;; esac"),
    ).toEqual(["src/a.ts"]);
  });

  test("N2: function-level redirect is surfaced", () => {
    // `function foo { … } > log.txt` — the trailing redirect lives on the
    // outer Function node, not the inner Command.
    expect(
      new Set(
        extractFilePathsFromCommand("function foo { cat a.ts; } > log.txt"),
      ),
    ).toEqual(new Set(["a.ts", "log.txt"]));
  });

  test("re-review: double-quoted purely-literal path is accepted", () => {
    // SHOULD-FIX-1 (re-review): `DoubleQuoted` with all-`Literal` children
    // must be accepted (bash strips quotes; the path is real).
    expect(extractFilePathsFromCommand('cat "src/a.ts"')).toEqual(["src/a.ts"]);
    expect(extractFilePathsFromCommand('cat "db.ts"')).toEqual(["db.ts"]);
  });

  test("re-review: double-quoted path with $VAR is rejected", () => {
    // `cat "$HOME/src/a.ts"` — DoubleQuoted with a SimpleExpansion child.
    // Should NOT be surfaced as a static path.
    expect(extractFilePathsFromCommand('cat "$HOME/src/a.ts"')).toEqual([]);
    expect(extractFilePathsFromCommand('cat "${X}/src/a.ts"')).toEqual([]);
    expect(extractFilePathsFromCommand('cat "$(echo src/a.ts)"')).toEqual([]);
  });

  test("re-review: `&>` and `&>>` (stdout+stderr combined) redirect target is surfaced", () => {
    // SHOULD-FIX-2 (re-review): bash 4+ shorthand for `> file 2>&1`.
    expect(extractFilePathsFromCommand("echo done &> combined.log")).toEqual([
      "combined.log",
    ]);
    expect(extractFilePathsFromCommand("echo done &>> combined.log")).toEqual([
      "combined.log",
    ]);
  });

  test("tolerant of syntax errors (unbash never throws; empty result)", () => {
    // An unterminated quote is a parse error in tolerant mode. We expect
    // `[]` rather than a throw, and no event-loop stall.
    const start = Date.now();
    const result = extractFilePathsFromCommand("cat src/a.ts 'unterminated");
    const elapsed = Date.now() - start;
    expect(Array.isArray(result)).toBe(true);
    expect(elapsed).toBeLessThan(1000);
  });

  test("bounds a pathological multi-KB command", () => {
    // A 200KB command with one trailing valid path: slice cap (8KB) cuts the
    // path off, so it shouldn't be found. Truncation-only direction is safe.
    const big = `echo ${"x ".repeat(100_000)}src/late.ts`;
    const result = extractFilePathsFromCommand(big);
    expect(result).toEqual([]);
  });
});

const TOOL_PROJECT = "/test/temporal/input-path";

function makeMessage(id: string, sessionID: string): LoreMessage {
  return {
    id,
    sessionID,
    role: "assistant",
    time: { created: 1_700_000_000_000 },
    parentID: "parent-1",
    modelID: "claude-sonnet-4-20250514",
    providerID: "anthropic",
    mode: "build",
    path: { cwd: "/test", root: "/test" },
    cost: 0,
    tokens: {
      input: 100,
      output: 50,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  };
}

function toolPart(
  messageID: string,
  callID: string,
  tool: string,
  state: Record<string, unknown>,
): LorePart {
  return {
    id: `tp-${callID}`,
    sessionID: "sess-ip",
    messageID,
    type: "tool",
    tool,
    callID,
    state,
  };
}

function pathsOf(pid: string, callId: string): string[] | null {
  const row = db()
    .query(
      "SELECT input_paths_json FROM tool_calls WHERE project_id = ? AND call_id = ?",
    )
    .get(pid, callId) as { input_paths_json: string | null } | null;
  if (!row || row.input_paths_json === null) return null;
  return JSON.parse(row.input_paths_json);
}

describe("recordToolCalls populates input_paths_json (D2c PR-1b)", () => {
  beforeEach(() => {
    const pid = ensureProject(TOOL_PROJECT);
    db().query("DELETE FROM tool_calls WHERE project_id = ?").run(pid);
  });

  test("stores file-tool paths as a JSON array; NULL for non-file tools", () => {
    const pid = ensureProject(TOOL_PROJECT);
    const info = makeMessage("m-ip", "sess-ip");
    const parts: LorePart[] = [
      toolPart("m-ip", "r1", "read", {
        status: "pending",
        input: { path: "src/auth/jwt.ts" },
      }),
      toolPart("m-ip", "e1", "edit", {
        status: "pending",
        input: { filePath: "src/config.ts" },
      }),
      toolPart("m-ip", "b1", "bash", {
        status: "pending",
        input: { command: "pnpm test" },
      }),
      toolPart("m-ip", "g1", "grep", {
        status: "pending",
        input: { pattern: "TODO" },
      }),
    ];
    temporal.recordToolCalls({ projectPath: TOOL_PROJECT, info, parts });

    expect(pathsOf(pid, "r1")).toEqual(["src/auth/jwt.ts"]);
    expect(pathsOf(pid, "e1")).toEqual(["src/config.ts"]);
    expect(pathsOf(pid, "b1")).toBeNull();
    expect(pathsOf(pid, "g1")).toBeNull();
  });

  test("a bash command touching multiple files stores all of them", () => {
    const pid = ensureProject(TOOL_PROJECT);
    const info = makeMessage("m-bash", "sess-ip");
    const parts: LorePart[] = [
      toolPart("m-bash", "c1", "bash", {
        status: "pending",
        input: { command: "cat src/a.ts src/b.ts" },
      }),
    ];
    temporal.recordToolCalls({ projectPath: TOOL_PROJECT, info, parts });
    expect(pathsOf(pid, "c1")).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("a `> redirect` command stores the redirect target", () => {
    const pid = ensureProject(TOOL_PROJECT);
    const info = makeMessage("m-redir", "sess-ip");
    const parts: LorePart[] = [
      toolPart("m-redir", "w1", "bash", {
        status: "pending",
        input: { command: "echo done > logs/out.txt" },
      }),
    ];
    temporal.recordToolCalls({ projectPath: TOOL_PROJECT, info, parts });
    expect(pathsOf(pid, "w1")).toEqual(["logs/out.txt"]);
  });

  test("a re-seed never clobbers a captured path list (COALESCE keeps first non-null)", () => {
    const pid = ensureProject(TOOL_PROJECT);
    const info = makeMessage("m-re", "sess-ip");
    const withPaths: LorePart[] = [
      toolPart("m-re", "rx", "read", {
        status: "pending",
        input: { path: "src/first.ts" },
      }),
    ];
    temporal.recordToolCalls({
      projectPath: TOOL_PROJECT,
      info,
      parts: withPaths,
    });
    // Re-seed with no path (retry / re-delivery) — first wins.
    const noPath: LorePart[] = [
      toolPart("m-re", "rx", "read", { status: "pending", input: {} }),
    ];
    temporal.recordToolCalls({
      projectPath: TOOL_PROJECT,
      info,
      parts: noPath,
    });
    expect(pathsOf(pid, "rx")).toEqual(["src/first.ts"]);

    // Re-seed with a different list — still first wins.
    const otherList: LorePart[] = [
      toolPart("m-re", "rx", "read", {
        status: "pending",
        input: { path: "src/second.ts" },
      }),
    ];
    temporal.recordToolCalls({
      projectPath: TOOL_PROJECT,
      info,
      parts: otherList,
    });
    expect(pathsOf(pid, "rx")).toEqual(["src/first.ts"]);
  });
});
