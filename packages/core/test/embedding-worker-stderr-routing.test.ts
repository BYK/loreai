import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE_PATH = join(import.meta.dirname, "../src/embedding-worker.ts");
const SOURCE = readFileSync(SOURCE_PATH, "utf-8");

// Lint CLI regression: older lore CI runs emitted `unreadable result` when an
// embedding worker diagnostic reached the redirected report stdout before its
// JSON envelope. Worker stdout/stderr are now parent-owned and drained (covered
// by embedding-worker-stdio.test.ts); these checks retain the independent
// severity invariant for recoverable diagnostics.
//
// A recoverable auto-heal has no user action and must use `console.debug`, not
// warning severity. Both streams remain contained regardless of console method.

/** Strip single-line `// …` comments so rationale text in comments doesn't
 *  trigger a false positive on a `console.X` substring match. */
function stripComments(src: string): string {
  return src.replace(/\/\/.*$/gm, "");
}

interface SectionSpec {
  /** Anchor regex — the diagnostic message template literal. */
  message: RegExp;
  /** How many chars BEFORE the message the console.X call site sits. */
  backOffset: number;
  /** Label for failure messages. */
  label: string;
}

const SECTIONS: SectionSpec[] = [
  {
    message: /native ONNX could not parse an intact model/,
    backOffset: 200,
    label: "native ONNX parse failure → WASM respawn",
  },
  {
    message: /model parse failed but on-disk files look intact/,
    backOffset: 200,
    label: "warm-up hiccup → retry without purge (PR #1581)",
  },
  {
    message: /model corrupt \(/,
    backOffset: 200,
    label: "model corrupt → purge cache + redownload",
  },
  {
    message: /ONNX OOM at/,
    backOffset: 200,
    label: "ONNX OOM → halve-and-respawn backoff",
  },
];

/** For each recoverable diagnostic, the `console.X(` call sits in the `if
 *  (!stderrSilenced) { … }` block immediately preceding the message template
 *  literal. Verify the call is `console.debug` (not `console.warn`). */
function expectDebugBefore(source: string, spec: SectionSpec): void {
  const messageMatch = source.match(spec.message);
  expect(messageMatch, `message for ${spec.label} not found`).toBeTruthy();
  if (!messageMatch || messageMatch.index === undefined) return;
  const start = Math.max(0, messageMatch.index - spec.backOffset);
  const window = stripComments(source.slice(start, messageMatch.index));
  // The LAST console.X call within the window is the call site for this
  // diagnostic message (the source structure puts `console.debug(\n  \`msg\`)`
  // with the message immediately after the call).
  const debugIdx = window.lastIndexOf("console.debug(");
  const warnIdx = window.lastIndexOf("console.warn(");
  expect(
    debugIdx >= 0,
    `${spec.label}: expected a console.debug( call within ${spec.backOffset} chars before the message, but none found`,
  ).toBe(true);
  expect(
    warnIdx < 0 || warnIdx < debugIdx,
    `${spec.label}: a console.warn( call sits AFTER the console.debug( call (or no console.debug exists)`,
  ).toBe(true);
}

describe("embedding-worker recoverable-path logging", () => {
  it.each(SECTIONS)("$label uses console.debug, not console.warn", (spec) => {
    expectDebugBefore(SOURCE, spec);
  });

  it("the embedding worker contains no console.warn calls in any recoverable path", () => {
    // Final guardrail: script-wide, no `console.warn(` call anywhere in the
    // file (comments stripped). The four recoverable paths are the only places
    // `console.warn` lived in this file before the demotion.
    const stripped = stripComments(SOURCE);
    const warnCalls = (stripped.match(/console\.warn\(/g) ?? []).length;
    expect(
      warnCalls,
      "embedding-worker.ts should not call console.warn — every recoverable-path diagnostic must use console.debug",
    ).toBe(0);
  });
});
