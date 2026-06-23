import { describe, test, expect } from "vitest";
import { ltm, recallById } from "@loreai/core";
import {
  buildKnowledgeDeltaMessage,
  buildKnowledgeCatalogText,
} from "../src/pipeline";
import type { GatewayMessage } from "../src/translate/types";

// Extract the single text part of a delta message.
function text(msg: GatewayMessage | null): string {
  if (!msg) return "";
  const part = msg.content[0] as { type: string; text: string };
  return part.text;
}

const id = (prefix: string) => `${prefix}-1111-7111-8111-111111111111`;
const changed = (p: string, title: string, category = "pattern") => ({
  id: id(p),
  category,
  title,
  content: `content for ${title}`,
});
const toc = (p: string, title: string, category = "pattern") => ({
  id: id(p),
  category,
  title,
});

const HEADING = "## Other relevant knowledge (recall by id for detail)";

describe("buildKnowledgeDeltaMessage — overflow ToC (#917)", () => {
  test("renders an overflow section listing titles, recall-ready ids, and categories", () => {
    const msg = buildKnowledgeDeltaMessage(
      [changed("019aaaaa", "Changed entry")],
      [],
      [
        toc("019bbbbb", "Overflow one"),
        toc("019ccccc", "Overflow two", "gotcha"),
      ],
    );
    const t = text(msg);
    expect(t).toContain(HEADING);
    // Full id with a `k:` recall prefix — NOT an 8-char slice (recallById is
    // exact-match, so a slice is unresolvable).
    expect(t).toContain(`[k:${id("019bbbbb")}] Overflow one (pattern)`);
    expect(t).toContain(`[k:${id("019ccccc")}] Overflow two (gotcha)`);
  });

  test("overflow alone (no changes/removals) does NOT create a delta — rides existing cadence", () => {
    // Cache-stability invariant: a delta is only created on material change.
    // Overflow must never trigger one on its own, or it would add cache churn.
    const msg = buildKnowledgeDeltaMessage([], [], [toc("019bbbbb", "Lonely")]);
    expect(msg).toBeNull();
  });

  test("overflow is id-sorted (byte-stable across per-turn relevance re-ranking)", () => {
    const msg = buildKnowledgeDeltaMessage(
      [changed("019aaaaa", "Changed")],
      [],
      // Deliberately out of id order.
      [
        toc("019ccccc", "Gamma"),
        toc("019aaaab", "Alpha"),
        toc("019bbbbb", "Beta"),
      ],
    );
    const t = text(msg);
    const a = t.indexOf("Alpha");
    const b = t.indexOf("Beta");
    const g = t.indexOf("Gamma");
    expect(a).toBeGreaterThan(-1);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(g);
  });

  test("caps the list and reports the remainder", () => {
    const overflow = Array.from({ length: 15 }, (_, i) =>
      toc(`019d${String(i).padStart(4, "0")}`, `Entry ${i}`),
    );
    const msg = buildKnowledgeDeltaMessage(
      [changed("019aaaaa", "Changed")],
      [],
      overflow,
    );
    const t = text(msg);
    // 12 shown, 3 more reported.
    expect(t).toMatch(/3 more/);
    expect(t).toContain("recall");
  });

  test("excludes ids already shown as changed or listed as superseded (no dup/contradiction)", () => {
    const msg = buildKnowledgeDeltaMessage(
      [changed("019aaaaa", "Changed entry")],
      [id("019eeeee")],
      [
        toc("019aaaaa", "Should be excluded (changed)"),
        toc("019eeeee", "Should be excluded (removed)"),
        toc("019fffff", "Should appear"),
      ],
    );
    const t = text(msg);
    expect(t).toContain("Should appear");
    expect(t).not.toContain("Should be excluded (changed)");
    expect(t).not.toContain("Should be excluded (removed)");
  });

  test("no overflow arg → no overflow section (back-compat)", () => {
    const msg = buildKnowledgeDeltaMessage(
      [changed("019aaaaa", "Changed entry")],
      [],
    );
    expect(text(msg)).not.toContain(HEADING);
  });
});

describe("buildKnowledgeCatalogText — frozen system[1] catalog (#917 A)", () => {
  test("renders a recall-by-id catalog of titles + recall-ready ids + categories", () => {
    const out = buildKnowledgeCatalogText(
      [
        toc("019aaaaa", "Auth flow", "architecture"),
        toc("019bbbbb", "DB gotcha", "gotcha"),
      ],
      15,
    );
    expect(out).toContain("## Project knowledge (recall by id for detail)");
    expect(out).toContain(`* [k:${id("019aaaaa")}] Auth flow (architecture)`);
    expect(out).toContain(`* [k:${id("019bbbbb")}] DB gotcha (gotcha)`);
  });

  test("empty input → empty string (keeps system[1] absent — no array-grow cache bust)", () => {
    expect(buildKnowledgeCatalogText([], 15)).toBe("");
  });

  test("caps the catalog and reports the remainder", () => {
    const entries = Array.from({ length: 20 }, (_, i) =>
      toc(`019c${String(i).padStart(4, "0")}`, `Entry ${i}`),
    );
    const out = buildKnowledgeCatalogText(entries, 15);
    expect(out).toMatch(/5 more/);
    expect(out).toContain("recall");
    // Only 15 lines + the "more" line.
    expect(out.split("\n").filter((l) => l.startsWith("* ")).length).toBe(16);
  });

  test("preserves caller order (forProject confidence-desc) — byte-stable freeze", () => {
    const out = buildKnowledgeCatalogText(
      [toc("019ffff0", "First"), toc("019aaaa0", "Second")],
      15,
    );
    // First listed first even though its id sorts later — order is the caller's.
    expect(out.indexOf("First")).toBeLessThan(out.indexOf("Second"));
  });
});

// The whole point of the ToC is recall-on-demand: the rendered id MUST be
// resolvable by the recall tool. recallById is exact-match, so this round-trip
// guards against regressing to a non-resolvable short id (the #930 review B1).
describe("ToC ids are recall-resolvable (#917 round-trip)", () => {
  const RTPROJ = "/test/overflow-toc-roundtrip";
  const RECALL_ID_RE = /\[(k:[0-9a-f-]+)\]/;

  test("catalog (A) id renders the exact token recallById resolves", () => {
    const realId = ltm.create({
      projectPath: RTPROJ,
      category: "gotcha",
      title: "Round-trip catalog entry",
      content: "Body content that recall should surface in full.",
      scope: "project",
      crossProject: false,
    });
    const out = buildKnowledgeCatalogText(
      [{ id: realId, category: "gotcha", title: "Round-trip catalog entry" }],
      15,
    );
    const token = out.match(RECALL_ID_RE)?.[1];
    expect(token).toBe(`k:${realId}`);
    const detail = recallById(token as string);
    expect(detail).not.toMatch(/No entry found/);
    expect(detail).toContain("Round-trip catalog entry");
  });

  test("overflow (B) id renders the exact token recallById resolves", () => {
    const realId = ltm.create({
      projectPath: RTPROJ,
      category: "pattern",
      title: "Round-trip overflow entry",
      content: "Overflow body content that recall should surface in full.",
      scope: "project",
      crossProject: false,
    });
    const msg = buildKnowledgeDeltaMessage(
      [changed("019aaaaa", "A changed entry")],
      [],
      [{ id: realId, category: "pattern", title: "Round-trip overflow entry" }],
    );
    const token = text(msg).match(RECALL_ID_RE)?.[1];
    // The changed-entry section uses an 8-char correlation handle; ensure we
    // matched the overflow ToC's full recall id, not that.
    expect(token).toBe(`k:${realId}`);
    const detail = recallById(token as string);
    expect(detail).not.toMatch(/No entry found/);
    expect(detail).toContain("Round-trip overflow entry");
  });
});
