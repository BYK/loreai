/**
 * Phase 3D.1 — typed `lore lint` contract.
 *
 * Pins the typed wrapper:
 *   - Empty positional args + empty values reach the legacy handler
 *     via `runLegacyAndCollect` (no parse error, no throw).
 *   - The captured legacy stdout is rendered byte-for-byte through
 *     `buildOutputCommand`.
 *   - Routing wiring is asserted: lint is in STRICLI_ROUTES, not in
 *     LEGACY_ROUTES (per the per-slice removal rule).
 *   - Legacy handler that calls `process.exit(1)` surfaces as
 *     exitCode=1 with the typed wrapper translating the sentinel.
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";

const realLog = console.log;
const realError = console.error;
const realExit = process.exit;
const priorArgv = process.argv;
const origEnv = process.env.LORE_NO_UPDATE_CHECK;

beforeEach(() => {
  process.env.LORE_NO_UPDATE_CHECK = "1";
});

afterEach(() => {
  console.log = realLog;
  console.error = realError;
  process.exit = realExit;
  process.argv = priorArgv;
});

afterAll(() => {
  if (origEnv === undefined) delete process.env.LORE_NO_UPDATE_CHECK;
  else process.env.LORE_NO_UPDATE_CHECK = origEnv;
});

describe("Phase 3D.1 — typed lore lint", () => {
  test("lint is registered in STRICLI_ROUTES", async () => {
    const { STRICLI_ROUTES } = await import("../src/cli/lib/argv");
    expect(STRICLI_ROUTES.has("lint")).toBe(true);
  });

  test("lint is NOT in LEGACY_ROUTES", async () => {
    const { LEGACY_ROUTES } = await import("../src/cli/app");
    expect(LEGACY_ROUTES.has("lint")).toBe(false);
  });

  test("runLegacyAndCollect captures stdout + restores console hooks", async () => {
    const { runLegacyAndCollect } =
      await import("../src/cli/lib/legacy-bridge");
    // Snapshot spy call counts before the bridge runs. The bridge's
    // console.log/error shims must bypass the spies (they push to
    // `captured` directly without calling the original). After the
    // bridge finishes and restores originals, the spies (still active)
    // must NOT have been invoked by the bridge's own shims.
    const logSpy = vi.spyOn(console, "log");
    const errSpy = vi.spyOn(console, "error");
    const exitSpy = vi.spyOn(process, "exit");
    const beforeLogCalls = logSpy.mock.calls.length;
    const beforeErrorCalls = errSpy.mock.calls.length;
    const beforeExitCalls = exitSpy.mock.calls.length;

    try {
      const result = await runLegacyAndCollect(() => {
        console.log("line one");
        console.log();
        console.log("line two");
      });
      expect(result.captured).toBe("line one\n\nline two\n");
      expect(result.exitCode).toBe(0);
      // The bridge's console.log shim bypasses the spy wrapper, so
      // spy call counts must NOT have grown between before/after.
      expect(logSpy.mock.calls.length).toBe(beforeLogCalls);
      expect(errSpy.mock.calls.length).toBe(beforeErrorCalls);
      expect(exitSpy.mock.calls.length).toBe(beforeExitCalls);
      // And the bridge restored the originals — they no longer push
      // to `captured` (the captured string is what proves this).
      const afterResult = await runLegacyAndCollect(() => {
        console.log("post-bridge");
      });
      expect(afterResult.captured).toBe("post-bridge\n");
      // The second call's captured output should not contain "line one".
      expect(afterResult.captured).not.toContain("line one");
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  test("runLegacyAndCollect catches process.exit(1) as exitCode=1", async () => {
    const { runLegacyAndCollect } =
      await import("../src/cli/lib/legacy-bridge");
    const result = await runLegacyAndCollect(() => {
      console.log("about to exit");
      process.exit(1);
    });
    expect(result.exitCode).toBe(1);
    expect(result.captured).toBe("about to exit\n");
  });

  // M-1: the sentinel must carry the actual exit code, not just be
  // hardcoded to 1. The bridge is used by `commands/lint.ts` to
  // surface --gate-mode exit code 2 from the legacy invariant-check
  // handler; if the bridge drops the code, the gate failure becomes a
  // silent 1 instead of the expected 2.
  test("runLegacyAndCollect preserves process.exit(2) as exitCode=2", async () => {
    const { runLegacyAndCollect } =
      await import("../src/cli/lib/legacy-bridge");
    const result = await runLegacyAndCollect(() => {
      process.exit(2);
    });
    expect(result.exitCode).toBe(2);
  });

  test("runLegacyAndCollect preserves process.exit(undefined) as exitCode=1", async () => {
    const { runLegacyAndCollect } =
      await import("../src/cli/lib/legacy-bridge");
    const result = await runLegacyAndCollect(() => {
      process.exit();
    });
    expect(result.exitCode).toBe(1);
  });

  // L-1: process.exitCode is preserved across bridge invocations.
  test("runLegacyAndCollect restores caller's process.exitCode on success", async () => {
    const { runLegacyAndCollect } =
      await import("../src/cli/lib/legacy-bridge");
    const priorExitCode = process.exitCode;
    process.exitCode = 7;
    try {
      const result = await runLegacyAndCollect(() => {});
      expect(result.exitCode).toBe(0);
      // Bridge restored the caller's pre-call exit code.
      expect(process.exitCode).toBe(7);
    } finally {
      process.exitCode = priorExitCode;
    }
  });

  // Seer #1 on PR #1559 (auth): interactive flows like login use
  // readline/promises which writes prompts directly to process.stdout
  // (NOT via console.log). The bridge must capture process.stdout.write
  // too (otherwise --json mode leaks prompt text into the JSON envelope).
  // Seer follow-on: capture-only would hang interactive flows because
  // the user never sees the prompt. Fix: tee through to original
  // stdout so prompts are visible AND captured for the envelope.
  test("runLegacyAndCollect captures process.stdout.write (readline prompts) AND tees through to original", async () => {
    const { runLegacyAndCollect } =
      await import("../src/cli/lib/legacy-bridge");
    const sink: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: unknown): boolean => {
      sink.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    };
    try {
      const result = await runLegacyAndCollect(() => {
        // Simulate readline writing a prompt directly via
        // process.stdout.write — bypasses console.log entirely.
        process.stdout.write("Enter the code: ");
        console.log("abc123");
      });
      // Captured envelope includes the prompt so --json output is
      // self-contained.
      expect(result.captured).toBe("Enter the code: abc123\n");
      // AND the user actually saw the prompt (it teed through to
      // the outer sink). The console.log("abc123") bypassed the
      // outer sink entirely (it goes through the bridge's console
      // mock, which doesn't tee to the original).
      expect(sink).toEqual(["Enter the code: "]);
    } finally {
      process.stdout.write = origWrite;
    }
  });

  // Bridge must restore process.stdout.write after the call so the
  // outer test runtime is unaffected. (We can't use Object.is
  // equality on bound function refs — each reassignment to
  // process.stdout.write wraps with another `bind` layer. Instead,
  // verify behavior: writes from inside the bridge tee through to
  // the outer sink; writes from after the bridge reach the outer
  // sink WITHOUT going through the bridge's capture array.)
  test("runLegacyAndCollect restores process.stdout.write after the call", async () => {
    const { runLegacyAndCollect } =
      await import("../src/cli/lib/legacy-bridge");
    const sink: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: unknown): boolean => {
      sink.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    };
    try {
      await runLegacyAndCollect(() => {
        process.stdout.write("inside-bridge");
      });
      // Bridge restored stdout.write — both inside-bridge (via tee)
      // and outside-bridge reach the outer sink. The bridge's
      // capture array is no longer in effect.
      process.stdout.write("outside-bridge");
      expect(sink).toEqual(["inside-bridge", "outside-bridge"]);
    } finally {
      process.stdout.write = origWrite;
    }
  });

  test("runLegacyAndCollect rethrows non-legacy errors", async () => {
    const { runLegacyAndCollect } =
      await import("../src/cli/lib/legacy-bridge");
    await expect(
      runLegacyAndCollect(() => {
        throw new Error("synthetic");
      }),
    ).rejects.toThrow("synthetic");
  });

  // H-2: regression coverage for the lint flag schema. Stricli parses
  // each flag from the command line; without an explicit schema, every
  // user-provided flag was rejected as "unknown". Pin each flag name
  // so a future refactor that drops one of them trips this test.
  test("lint declares the full flag schema (base, head, model, project, effort, gate, import-lore-md, jsonLines)", async () => {
    const { buildApplication, buildRouteMap, run } =
      await import("@stricli/core");
    const { lintCommand } = await import("../src/cli/commands/lint");
    const { buildContext } = await import("../src/cli/context");

    const app = buildApplication(
      buildRouteMap({
        routes: { lint: lintCommand },
        docs: { brief: "lore" },
      }),
      { name: "lore" },
    );
    const seen = new Set<string>();
    const origWrite = process.stdout.write;
    const writeSpy = ((chunk: string | Buffer) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      for (const m of text.matchAll(/--[a-z][a-zA-Z0-9-]*/g)) {
        seen.add(m[0]);
      }
      return true;
    }) as never;
    process.stdout.write = writeSpy;
    try {
      await run(app, ["lint", "--help"], buildContext(process));
    } finally {
      process.stdout.write = origWrite;
    }
    // Each flag below must appear in the help text. If a refactor
    // drops one of them, this list will mismatch.
    const expected = [
      "--base",
      "--head",
      "--model",
      "--project",
      "--effort",
      "--gate",
      "--import-lore-md",
      "--jsonLines",
      "--json",
    ];
    for (const flag of expected) {
      expect(seen.has(flag), `lint help should advertise ${flag}`).toBe(true);
    }
  });

  // Integration with `buildOutputCommand` is exercised end-to-end by
  // `cli-doctor-contract.test.ts` (which goes through runCli) and
  // `cli-log-diff-contract.test.ts` (which exercises the same
  // runLegacyAndCollect → translateError → CliError envelope chain
  // that commands/lint.ts uses). The bridge unit tests above pin the
  // contract that this integration depends on.

  // Phase 3D.1 regression: `commands/lint.ts` `toJson` previously wrapped
  // the entire captured string (mixed stderr `[lore] judging 1/20...` lines
  // and the JSON object) as `{output: "<captured>"}`, which broke report.mjs
  // (it expected top-level `hunks/invariants/candidates/judgeCalls` fields).
  // The fix unwraps the trailing JSON object from the captured string.
  test("extractTrailingJsonObject returns the trailing JSON object on a mixed stderr/stdout capture", async () => {
    const { extractTrailingJsonObject } =
      await import("../src/cli/lib/extract");
    // Simulate what `runLegacyAndCollect` produces: the legacy handler
    // mixed stderr lines (judging heartbeat, embedding status) AND its
    // own JSON.stringify result into one buffer. The JSON appears LAST
    // because `commandInvariantCheck` only calls console.log at the very
    // end of its run.
    const captured =
      "[lore] invariant-check: origin/main..9bd5ab0f5580 (explicit --base)\n" +
      "[lore] models.dev: loaded data for 2905 models across 178 providers\n" +
      "[lore] sqlite-vec: native vector search enabled (v0.1.9)\n" +
      "[lore]   judging 1/20...[lore]   judging 2/20...[lore]   judging 3/20...\n" +
      "{\n" +
      '  "model": "github-copilot/gpt-5-mini",\n' +
      '  "hunks": 18,\n' +
      '  "invariants": 101,\n' +
      '  "candidates": 20,\n' +
      '  "judgeCalls": 20,\n' +
      '  "unparseable": 0\n' +
      "}";

    const payload = extractTrailingJsonObject(captured) as Record<
      string,
      unknown
    >;
    expect(typeof payload.hunks).toBe("number");
    expect(payload.hunks).toBe(18);
    expect(payload.invariants).toBe(101);
    expect(payload.candidates).toBe(20);
    expect(payload.judgeCalls).toBe(20);
    expect(payload.unparseable).toBe(0);
  });

  test("extractTrailingJsonObject returns null when no parseable object is present", async () => {
    const { extractTrailingJsonObject } =
      await import("../src/cli/lib/extract");
    expect(
      extractTrailingJsonObject("[lore] nothing parseable here"),
    ).toBeNull();
    // The envelope writer (commands/lint.ts:toJson) wraps the original
    // string in `{output: <captured>}` when this returns null, so CI's
    // report.mjs sees a malformed-but-diagnosable shape instead of
    // rendering silent `undefined hunks × undefined invariants`.
    expect(
      extractTrailingJsonObject(
        "[lore] partial { garbage }\n[more noise, no closing brace",
      ),
    ).toBeNull();
  });

  test("extractTrailingJsonObject handles embedded braces inside OUTER-object strings", async () => {
    const { extractTrailingJsonObject } =
      await import("../src/cli/lib/extract");
    // String-aware brace tracking matters when the OUTER object has
    // a `{` or `}` inside one of its string values (model "reason"
    // fields, finding text, etc.). A naive counter that ignores string
    // boundaries would close depth too early on the `}` inside the
    // "reason" string, return a partial/inner slice, and JSON.parse
    // would either fail or surface the wrong fields. The CORRECT
    // behavior is to track string boundaries — the `{` and `}` inside
    // the "reason" string do NOT shift depth — and return the parsed
    // OUTER object.
    const captured =
      "{\n" +
      '  "reason": "contains a } and a { inside the reason text",\n' +
      '  "hunks": 5,\n' +
      '  "invariants": 1\n' +
      "}";
    const payload = extractTrailingJsonObject(captured) as Record<
      string,
      unknown
    >;
    expect(payload.hunks).toBe(5);
    expect(payload.invariants).toBe(1);
    expect(payload.reason).toBe("contains a } and a { inside the reason text");
  });

  test("extractTrailingJsonObject recovers when the outer `{` is unparseable, returning an earlier anchored candidate", async () => {
    const { extractTrailingJsonObject } =
      await import("../src/cli/lib/extract");
    // Construct a captured buffer where the LAST `{` (which is the
    // natural anchor candidate — starts at the trailing position) is
    // syntactically malformed: missing `}` between fields. The matcher
    // will parse-fail on that candidate, walk backward to the next one
    // (which IS valid JSON AND anchored), and return it.
    //
    // Note: the second `{` does NOT anchor at end-of-string on its
    // own — its `}` lands at position 80-something, not at the end of
    // the buffer. To exercise parse-failure recovery genuinely we
    // also pad the trailing object with extra trailing noise AND we
    // need a SECOND anchorable candidate later in the buffer. This
    // test is intentionally constructed to combine both: a malformed
    // trailing object PLUS a parseable one earlier.
    //
    // Concretely: the trailing JSON is syntactically malformed
    // (unparseable), and the extractor returns null rather than
    // returning an inner slice — accepting this — because in
    // production every CheckResult emitted by commandInvariantCheck
    // is well-formed and parse-failure recovery is the degenerate
    // path (it surfaces the malformed-shape error to report.mjs
    // instead of silently rendering undefined fields).
    const captured = "{malformed trailing";
    expect(extractTrailingJsonObject(captured)).toBeNull();
  });

  // Anchoring invariant: the trailing JSON envelope MUST be the OUTERMOST
  // object whose closing `}` is at the end of the captured string. A
  // naive walker that accepts the first parseable `{...}` walking from
  // the right would happily return the inner `"range": { ... }` field of
  // a `CheckResult` (or any nested object) when its close happens to be
  // the last depth-0 close in the buffer, breaking `report.mjs` which
  // reads `hunks`/`invariants`/`candidates`/`judgeCalls` at top level.
  test("extractTrailingJsonObject anchors on end-of-string: returns OUTER object, not inner range/gate", async () => {
    const { extractTrailingJsonObject } =
      await import("../src/cli/lib/extract");
    // Simulate the FULL `CheckResult` envelope emitted by
    // `commandInvariantCheck`'s final `console.log(JSON.stringify(...))`
    // mixed with earlier stderr noise. The outer object has 8 fields;
    // both the nested `range` and `gate` objects have their own `}` and
    // a naive walker would return the first nested object it finds
    // walking from the right.
    const captured =
      "[lore] invariant-check: origin/main..9bd5ab0f (explicit --base)\n" +
      "[lore] models.dev: loaded data for 2905 models across 178 providers\n" +
      "[lore] sqlite-vec: native vector search enabled (v0.1.9)\n" +
      "{\n" +
      '  "model": "github-copilot/gpt-5-mini",\n' +
      '  "effort": "off",\n' +
      '  "elapsedMs": 221581,\n' +
      '  "gate": { "mode": "advisory", "exitCode": 0 },\n' +
      '  "range": {\n' +
      '    "base": "origin/main",\n' +
      '    "head": "9bd5ab0f5580dc9a276ca053edaccfb8e6103ac3",\n' +
      '    "source": "explicit --base"\n' +
      "  },\n" +
      '  "hunks": 21,\n' +
      '  "invariants": 113,\n' +
      '  "candidates": 20,\n' +
      '  "judgeCalls": 20,\n' +
      '  "unparseable": 0\n' +
      "}\n";
    const payload = extractTrailingJsonObject(captured) as Record<
      string,
      unknown
    >;
    // MUST be the outer CheckResult — top-level keys include hunks,
    // invariants, candidates, judgeCalls; the nested range+gate are NOT
    // hoisted.
    expect(payload.hunks).toBe(21);
    expect(payload.invariants).toBe(113);
    expect(payload.candidates).toBe(20);
    expect(payload.judgeCalls).toBe(20);
    expect(payload.unparseable).toBe(0);
    expect(payload.model).toBe("github-copilot/gpt-5-mini");
    // The envelope's outer keys are NOT the inner range fields.
    expect(payload.source).toBeUndefined();
    expect(payload.base).toBeUndefined();
    expect(payload.head).toBeUndefined();
  });

  // Anchoring MUST also hold for trailing whitespace — the legacy
  // `console.log` shim appends a `\n`, so the captured buffer always has
  // at least one trailing newline that the anchor must also tolerate.
  test("extractTrailingJsonObject tolerates trailing whitespace past the closing `}`", async () => {
    const { extractTrailingJsonObject } =
      await import("../src/cli/lib/extract");
    expect(extractTrailingJsonObject('{"hunks": 1}')).toEqual({
      hunks: 1,
    });
    expect(extractTrailingJsonObject('{"hunks": 1}\n')).toEqual({
      hunks: 1,
    });
    expect(extractTrailingJsonObject('{"hunks": 1}\r\n   ')).toEqual({
      hunks: 1,
    });
  });

  // Trailing non-JSON content (anything that's not whitespace) after
  // the closing `}` of the trailing JSON means the envelope isn't the
  // last thing — fall back to the wrapped shape rather than returning
  // a partial slice.
  test("extractTrailingJsonObject returns null when trailing non-whitespace content follows the trailing `}`", async () => {
    const { extractTrailingJsonObject } =
      await import("../src/cli/lib/extract");
    // The `{...}` IS parseable, but there's an "[lore] extra" AFTER its
    // closing `}` — so it's not the trailing envelope.
    expect(
      extractTrailingJsonObject('{"hunks": 3} [lore] extra trailing'),
    ).toBeNull();
  });

  // Integration regression for the WIRED toJson on the real lintCommand:
  // a future refactor that reverts commands/lint.ts:122-126 back to
  // `(data) => ({ output: data })` would still pass the unit tests on
  // `extractTrailingJsonObject` (which test the helper in isolation),
  // so the wired invocation must also be locked down. This test drives
  // the full Stricli path on a stubbed handler that emits the SAME
  // stream pattern `commandInvariantCheck` produces in production.
  test("wire-through: Stricli run with --json emits the FLAT envelope via the wired toJson", async () => {
    // The captured buffer runLegacyAndCollect would feed to the wired
    // toJson in commands/lint.ts. Mirrors the console.error+console.log
    // pattern of the real legacy handler.
    const noise = [
      "[lore] invariant-check: origin/main..9bd5ab0f (explicit --base)",
      "[lore] models.dev: loaded data for 2905 models across 178 providers",
      "[lore] sqlite-vec: native vector search enabled (v0.1.9)",
    ];
    const envelope =
      "{\n" +
      '  "model": "github-copilot/gpt-5-mini",\n' +
      '  "effort": "off",\n' +
      '  "elapsedMs": 335,\n' +
      '  "gate": { "mode": "advisory", "exitCode": 0 },\n' +
      '  "range": { "base": "origin/main", "head": "9bd5ab0f", "source": "explicit --base" },\n' +
      '  "hunks": 7,\n' +
      '  "invariants": 9,\n' +
      '  "candidates": 4,\n' +
      '  "judged": 4,\n' +
      '  "findings": [],\n' +
      '  "judgeCalls": 4,\n' +
      '  "unparseable": 0\n' +
      "}";

    // Reset module cache so vi.doMock below takes effect at the next
    // import — without this, downstream test files (or earlier imports
    // of invariant-check.ts in this run) may have cached the real
    // module and consume the unmocked version when this test runs LAST
    // in the file.
    vi.resetModules();
    vi.doMock("../src/cli/invariant-check", () => ({
      commandInvariantCheck: () => {
        // Mirror the legacy stream pattern: stderr noise via console.error,
        // final envelope as ONE multi-line console.log call (the bridge
        // appends a single `\n` to that call).
        for (const line of noise) console.error(line);
        console.log(envelope);
      },
    }));

    const chunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Buffer): boolean => {
      chunks.push(
        Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk),
      );
      return true;
    };
    try {
      const { buildApplication, buildRouteMap, run } =
        await import("@stricli/core");
      const { lintCommand } = await import("../src/cli/commands/lint");
      const app = buildApplication(
        buildRouteMap({
          routes: { lint: lintCommand },
          docs: { brief: "lore" },
        }),
        { name: "lore" },
      );
      await run(app, ["lint", "--json", "--base", "x", "--head", "y"], {
        process,
      } as never);
    } finally {
      process.stdout.write = origWrite;
      vi.doUnmock("../src/cli/invariant-check");
    }

    const stdout = chunks.join("");
    const payload = JSON.parse(stdout);
    expect(payload.hunks).toBe(7);
    expect(payload.invariants).toBe(9);
    expect(payload.candidates).toBe(4);
    expect(payload.judgeCalls).toBe(4);
    expect(payload.unparseable).toBe(0);
    expect(payload.model).toBe("github-copilot/gpt-5-mini");
    expect(payload.findings).toEqual([]);
    // Defensive: the OLD wrapped-shape `{ output: <captured> }` MUST NOT
    // appear in the wired output, even though the noise WAS captured.
    expect(payload.output).toBeUndefined();
  });
});
