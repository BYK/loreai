/**
 * Unit tests for the byte-driven CLI progress bar.
 *
 * The bar is cosmetic-only and must never abort the operation it decorates.
 * These cover: determinate fraction rendering, indeterminate byte counter,
 * non-TTY header-only behavior, byte accumulation across calls, and the
 * never-throws contract (a failing output stream must not propagate).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { makeByteProgress } from "../src/cli/lib/progress";

type FakeOut = {
  isTTY: boolean;
  writes: string[];
  write: (s: string) => boolean;
};

function fakeOut(isTTY: boolean): FakeOut {
  const writes: string[] = [];
  return {
    isTTY,
    writes,
    write(s: string) {
      writes.push(s);
      return true;
    },
  };
}

describe("makeByteProgress", () => {
  it("renders a determinate bar advancing with reported bytes on a TTY", () => {
    const out = fakeOut(true);
    const p = makeByteProgress("Applying 3 patches", 1000, out);
    p.onProgress(500);
    p.onProgress(500);
    p.done();

    const last = out.writes.at(-2); // last real line before the clear
    expect(last).toContain("Applying 3 patches");
    expect(last).toContain("█");
    // 1000/1000 -> full bar; 1000 B is below the 1024 threshold, shown as bytes
    expect(last).toContain("█".repeat(16));
    expect(last).toContain("1000 B");
  });

  it("renders an indeterminate byte counter when total is null", () => {
    const out = fakeOut(true);
    const p = makeByteProgress("Downloading", null, out);
    p.onProgress(2048);
    p.done();

    const last = out.writes.at(-2);
    expect(last).toContain("Downloading");
    expect(last).toContain("2.00 KB");
    expect(last).not.toContain("░"); // no bar in indeterminate mode
  });

  it("accumulates bytes across multiple onProgress calls", () => {
    const out = fakeOut(true);
    const p = makeByteProgress("Applying", 100, out);
    p.onProgress(10);
    p.onProgress(40);
    p.onProgress(50); // total 100 -> full
    p.done();
    const last = out.writes.at(-2);
    expect(last).toContain("█".repeat(16));
    expect(last).toContain("100 B");
  });

  it("clamps the bar at full even if bytes exceed the total", () => {
    const out = fakeOut(true);
    const p = makeByteProgress("Applying", 100, out);
    p.onProgress(5000);
    p.done();
    const last = out.writes.at(-2);
    expect(last).toContain("█".repeat(16));
    expect(last).not.toContain("░");
  });

  it("prints the header once (no bar) off a TTY", () => {
    const out = fakeOut(false);
    const p = makeByteProgress("Applying 3 patches", 1000, out);
    p.onProgress(500);
    p.onProgress(500);
    p.done();
    expect(out.writes).toEqual(["Applying 3 patches\n"]);
  });

  it("never throws even if the output stream throws", () => {
    const throwing = {
      isTTY: true,
      write(): boolean {
        throw new Error("boom");
      },
    };
    const p = makeByteProgress("Applying", 100, throwing);
    expect(() => {
      p.onProgress(50);
      p.done();
    }).not.toThrow();
  });

  it("renders percentage only when format='pct' (apply bar suppresses GB scare)", () => {
    // Multi-hop chains sum newSize across hops, so event.total can far
    // exceed the final binary size (e.g. 930 MB for a 3-hop 310 MB chain).
    // The apply bar should show only percentage in that case so users
    // don't see "applied 1.5 GB / 3.1 GB" for what ends up being a
    // 310 MB install.
    const out = fakeOut(true);
    const p = makeByteProgress(
      "Applying patches",
      930 * 1024 * 1024,
      out,
      "pct",
    );
    p.onProgress(310 * 1024 * 1024); // 33%
    p.onProgress(310 * 1024 * 1024); // 66%
    p.onProgress(310 * 1024 * 1024); // 100%
    p.done();

    const last = out.writes.at(-2);
    expect(last).toContain("Applying patches");
    expect(last).toMatch(/\[█+\]\s+100%/);
    // No byte count in pct mode
    expect(last).not.toMatch(/\d+\s*(B|KB|MB|GB|TB)/);
    expect(last).not.toContain("/");
  });

  it("apply bar call site passes 'pct' format (regression: #1519 review)", () => {
    // Regression: delta-upgrade.ts apply bar previously called
    // makeByteProgress(label, total) without passing format, so the bar
    // fell back to bytes mode and the "pct only" UX never applied.
    // Reads the source to assert the call site actually wires "pct",
    // so a future regression to bytes mode is caught even if the
    // helper itself still defaults to "bytes".
    const src = readFileSync(
      join(__dirname, "../src/cli/lib/delta-upgrade.ts"),
      "utf8",
    );
    // Find the makeByteProgress call inside the apply bar branch by scanning
    // for balanced parentheses, so nested calls like
    // makeByteProgress("label", computeTotal()) still match. Regex-based
    // extraction breaks on nested parens, which a real refactor could
    // easily introduce.
    function extractCalls(source: string, name: string): string[] {
      const out: string[] = [];
      let i = 0;
      while ((i = source.indexOf(name, i)) !== -1) {
        const open = source.indexOf("(", i);
        if (open === -1) break;
        let depth = 1;
        let j = open + 1;
        while (j < source.length && depth > 0) {
          const ch = source[j];
          if (ch === "(") depth++;
          else if (ch === ")") depth--;
          if (depth > 0) j++;
        }
        if (depth === 0) {
          out.push(source.slice(i, j + 1));
          i = j + 1;
        } else {
          break; // unbalanced, stop scanning
        }
      }
      return out;
    }
    const matches: string[] = extractCalls(src, "makeByteProgress");
    const applyCall = matches.find(
      (m) => m.includes("Applying patches") && m.includes("event.total"),
    );
    expect(applyCall).toBeDefined();
    expect(applyCall).toMatch(/["']pct["']/);
  });
});
